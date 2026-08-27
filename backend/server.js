require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const path       = require('path');
const fetch      = require('node-fetch');
const rateLimit  = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── Database ─────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── Rate Limiting ────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 attempts per 15 min
  message: { error: 'Too many auth attempts, please try again later' },
});

const walletLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 deposits/withdrawals per hour
  message: { error: 'Too many wallet operations, please try again later' },
});

// ── Email (Nodemailer) ───────────────────────────────────────────────────
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ── NGN Exchange Rate ────────────────────────────────────────────────────
let NGN_USD_RATE = 1550; // fallback
async function updateNgnRate() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await res.json();
    if (data.rates?.NGN) NGN_USD_RATE = data.rates.NGN;
  } catch {}
}
updateNgnRate();
setInterval(updateNgnRate, 60 * 60 * 1000); // update hourly

// ── Middleware ────────────────────────────────────────────────────────────
app.use(globalLimiter);
app.use(cors({
  origin: ['https://vultvision.me', 'https://www.vultvision.me', 'http://localhost:3080'],
  credentials: true
}));
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── Auth Middleware ───────────────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(header.replace('Bearer ', ''), process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── Helper: generate referral code ───────────────────────────────────────
function genRefCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, referral_code } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password required' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const existing = await db.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }

    const hash = await bcrypt.hash(password, 12);
    const refCode = genRefCode();
    let referredBy = null;

    if (referral_code) {
      const referrer = await db.query(
        'SELECT id FROM users WHERE referral_code = $1',
        [referral_code]
      );
      if (referrer.rows.length > 0) referredBy = referrer.rows[0].id;
    }

    const result = await db.query(
      `INSERT INTO users (username, email, password_hash, referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username, email, referral_code, balance_usdt, created_at`,
      [username, email, hash, refCode, referredBy]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: false },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    if (referredBy) {
      await db.query(
        'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2)',
        [referredBy, user.id]
      );
    }

    res.json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, username: user.username, is_admin: user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    delete user.password_hash;
    res.json({ user, token });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, username, email, wallet_address, wallet_chain, balance_usdt,
              total_earned, total_spent, pools_joined, pools_won, referral_code, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/auth/wallet', auth, async (req, res) => {
  try {
    const { wallet_address, wallet_chain } = req.body;
    if (!wallet_address || !wallet_chain) {
      return res.status(400).json({ error: 'wallet_address and wallet_chain required' });
    }
    // Basic address validation
    const validChains = ['ETH', 'SOL', 'BTC', 'MATIC', 'TRON'];
    if (!validChains.includes(wallet_chain)) {
      return res.status(400).json({ error: `Invalid chain. Supported: ${validChains.join(', ')}` });
    }
    await db.query(
      'UPDATE users SET wallet_address = $1, wallet_chain = $2, updated_at = NOW() WHERE id = $3',
      [wallet_address, wallet_chain, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update wallet' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL VERIFICATION + PASSWORD RESET
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await db.query('SELECT id, email FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.json({ ok: true, message: 'If account exists, verification email sent' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await db.query(
      `UPDATE users SET email_verify_token = $1, email_verify_expires = $2 WHERE id = $3`,
      [token, expires, user.rows[0].id]
    );

    // Send verification email
    if (process.env.SMTP_USER) {
      try {
        await emailTransporter.sendMail({
          from: process.env.SMTP_FROM || 'VultFantasy <noreply@vultvision.me>',
          to: email,
          subject: 'Verify your VultFantasy account',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;">
            <h2 style="color:#10b981;">VultFantasy</h2>
            <p>Click below to verify your email:</p>
            <a href="https://vultvision.me/verify?token=${token}" style="display:inline-block;padding:12px 24px;background:#10b981;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Verify Email</a>
            <p style="font-size:12px;color:#666;margin-top:24px;">Link expires in 24 hours.</p>
          </div>`
        });
      } catch (e) { console.error('Email send failed:', e.message); }
    }

    res.json({ ok: true, message: 'If account exists, verification email sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

app.get('/api/auth/verify-email/:token', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE users SET is_verified = TRUE, email_verify_token = NULL, email_verify_expires = NULL
       WHERE email_verify_token = $1 AND email_verify_expires > NOW() RETURNING id, username`,
      [req.params.token]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });
    res.json({ ok: true, message: 'Email verified!' });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.json({ ok: true, message: 'If account exists, reset email sent' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      `UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3`,
      [token, expires, user.rows[0].id]
    );

    if (process.env.SMTP_USER) {
      try {
        await emailTransporter.sendMail({
          from: process.env.SMTP_FROM || 'VultFantasy <noreply@vultvision.me>',
          to: email,
          subject: 'Reset your VultFantasy password',
          html: `<div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px;">
            <h2 style="color:#10b981;">VultFantasy</h2>
            <p>Click below to reset your password:</p>
            <a href="https://vultvision.me/reset?token=${token}" style="display:inline-block;padding:12px 24px;background:#f59e0b;color:#000;text-decoration:none;border-radius:8px;font-weight:600;">Reset Password</a>
            <p style="font-size:12px;color:#666;margin-top:24px;">Link expires in 1 hour. If you didn't request this, ignore this email.</p>
          </div>`
        });
      } catch (e) { console.error('Email send failed:', e.message); }
    }

    res.json({ ok: true, message: 'If account exists, reset email sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process reset request' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = await db.query(
      'SELECT id FROM users WHERE reset_token = $1 AND reset_expires > NOW()',
      [token]
    );
    if (user.rows.length === 0) return res.status(400).json({ error: 'Invalid or expired token' });

    const hash = await bcrypt.hash(password, 12);
    await db.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_expires = NULL, updated_at = NOW() WHERE id = $2`,
      [hash, user.rows[0].id]
    );

    res.json({ ok: true, message: 'Password reset successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// NGN (NAIRA) DEPOSIT + WITHDRAWAL
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/wallet/ngn-rate', async (req, res) => {
  res.json({ rate: NGN_USD_RATE, currency: 'NGN', base: 'USD' });
});

app.post('/api/wallet/ngn-deposit', auth, walletLimiter, async (req, res) => {
  try {
    const { amount_ngn, bank_name, account_number, account_name, reference } = req.body;
    if (!amount_ngn || amount_ngn <= 0) return res.status(400).json({ error: 'Invalid NGN amount' });

    const amount_usd = parseFloat((amount_ngn / NGN_USD_RATE).toFixed(2));
    if (amount_usd < 1) return res.status(400).json({ error: 'Minimum deposit is 1 USD equivalent' });

    // Save as pending — admin approves after confirming bank transfer
    await db.query(
      `INSERT INTO transactions (user_id, type, amount, currency, chain, status, metadata)
       VALUES ($1, 'deposit', $2, 'NGN', 'BANK', 'pending', $3)`,
      [req.user.id, amount_ngn,
       JSON.stringify({
         amount_usd, bank_name, account_number, account_name,
         reference: reference || `VF-${Date.now()}`,
         exchange_rate: NGN_USD_RATE
       })]
    );

    res.json({
      ok: true,
      message: `Bank transfer of ₦${amount_ngn.toLocaleString()} submitted for review`,
      amount_usd,
      reference: reference || `VF-${Date.now()}`,
      bank_details: {
        bank: 'Wema Bank',
        account_name: 'VultVision Ltd',
        account_number: '0123456789',
        reference: reference || `VF-${Date.now()}`
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'NGN deposit failed' });
  }
});

app.post('/api/wallet/ngn-withdraw', auth, walletLimiter, async (req, res) => {
  try {
    const { amount_usd, bank_name, account_number, account_name, bank_code } = req.body;
    if (!amount_usd || amount_usd <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!bank_name || !account_number || !account_name) {
      return res.status(400).json({ error: 'Bank details required (bank_name, account_number, account_name)' });
    }

    const user = await db.query('SELECT balance_usdt FROM users WHERE id = $1', [req.user.id]);
    if (parseFloat(user.rows[0].balance_usdt) < amount_usd) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const amount_ngn = Math.round(amount_usd * NGN_USD_RATE);
    const hasFlutterwave = !!process.env.FLW_SECRET_KEY;

    await db.query(
      `UPDATE users SET balance_usdt = balance_usdt - $1, updated_at = NOW() WHERE id = $2`,
      [amount_usd, req.user.id]
    );

    const txResult = await db.query(
      `INSERT INTO transactions (user_id, type, amount, currency, chain, status, metadata)
       VALUES ($1, 'withdrawal', $2, 'NGN', 'BANK', $3, $4) RETURNING *`,
      [req.user.id, amount_ngn,
       hasFlutterwave ? 'processing' : 'pending',
       JSON.stringify({ amount_usd, bank_name, account_number, account_name, bank_code, exchange_rate: NGN_USD_RATE })]
    );

    // Auto-process if Flutterwave is configured
    if (hasFlutterwave) {
      processNgnPayout(txResult.rows[0]).catch(e => console.error('NGN auto-payout failed:', e.message));
    }

    res.json({
      ok: true,
      status: hasFlutterwave ? 'processing' : 'pending',
      message: hasFlutterwave
        ? `₦${amount_ngn.toLocaleString()} auto-processing via Flutterwave!`
        : `Withdrawal of ₦${amount_ngn.toLocaleString()} submitted for review`,
      amount_ngn,
      tx_id: txResult.rows[0].id
    });
  } catch (err) {
    res.status(500).json({ error: 'NGN withdrawal failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PLAYERS ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/players', async (req, res) => {
  try {
    const { team, position, search } = req.query;
    let query = 'SELECT * FROM players WHERE is_available = TRUE';
    const params = [];
    let idx = 1;

    if (team) { query += ` AND team = $${idx++}`; params.push(team); }
    if (position) { query += ` AND position = $${idx++}`; params.push(position); }
    if (search) { query += ` AND name ILIKE $${idx++}`; params.push(`%${search}%`); }

    query += ' ORDER BY total_points DESC, price DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

app.get('/api/players/teams', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT DISTINCT team FROM players WHERE is_available = TRUE ORDER BY team'
    );
    res.json(result.rows.map(r => r.team));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

app.get('/api/players/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid player ID' });
    const result = await db.query('SELECT * FROM players WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Player not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch player' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SQUAD BUILDER ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/squads/my', auth, async (req, res) => {
  try {
    const { gameweek_id } = req.query;
    let query = `
      SELECT s.*, g.gameweek_number, g.status as gw_status
      FROM squads s
      JOIN gameweeks g ON s.gameweek_id = g.id
      WHERE s.user_id = $1
    `;
    const params = [req.user.id];
    if (gameweek_id) {
      query += ' AND s.gameweek_id = $2';
      params.push(parseInt(gameweek_id));
    }
    query += ' ORDER BY g.gameweek_number DESC';

    const squads = await db.query(query, params);

    for (let squad of squads.rows) {
      const players = await db.query(
        `SELECT sp.*, p.name, p.team, p.position, p.photo_url, p.price, p.total_points
         FROM squad_players sp
         JOIN players p ON sp.player_id = p.id
         WHERE sp.squad_id = $1
         ORDER BY sp.position_slot`,
        [squad.id]
      );
      squad.players = players.rows;
      squad.total_spend = players.rows.reduce((sum, p) => sum + parseFloat(p.price), 0);
    }

    res.json(squads.rows);
  } catch (err) {
    console.error('Squads error:', err);
    res.status(500).json({ error: 'Failed to fetch squads' });
  }
});

app.post('/api/squads', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { gameweek_id, name, players, captain_id, vice_captain_id } = req.body;

    if (!gameweek_id || !players || !Array.isArray(players)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'gameweek_id and players array required' });
    }

    const gw = await client.query('SELECT * FROM gameweeks WHERE id = $1', [gameweek_id]);
    if (gw.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Gameweek not found' }); }
    if (gw.rows[0].status === 'finished') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Gameweek is finished' }); }

    // Validate formation
    const positions = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const playerPrices = {};
    for (const p of players) {
      const playerInfo = await client.query('SELECT position, price FROM players WHERE id = $1', [p.player_id]);
      if (playerInfo.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Player ${p.player_id} not found` });
      }
      positions[playerInfo.rows[0].position]++;
      playerPrices[p.player_id] = parseFloat(playerInfo.rows[0].price);
    }

    if (positions.GK !== 1 || positions.DEF < 3 || positions.DEF > 5 ||
        positions.MID < 3 || positions.MID > 5 || positions.FWD < 1 || positions.FWD > 3) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Invalid formation. Need: 1 GK, 3-5 DEF, 3-5 MID, 1-3 FWD (11 total)',
        positions
      });
    }

    if (players.length !== 11) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Squad must have exactly 11 players' });
    }

    let totalSpend = players.reduce((sum, p) => sum + (playerPrices[p.player_id] || 0), 0);
    if (totalSpend > 100.00) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Budget exceeded: ${totalSpend.toFixed(2)} / 100.00` });
    }

    const playerIds = players.map(p => p.player_id);
    if (new Set(playerIds).size !== playerIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No duplicate players allowed' });
    }

    // Upsert squad
    const existingSquad = await client.query(
      'SELECT id FROM squads WHERE user_id = $1 AND gameweek_id = $2',
      [req.user.id, gameweek_id]
    );

    let squadId;
    if (existingSquad.rows.length > 0) {
      squadId = existingSquad.rows[0].id;
      await client.query('UPDATE squads SET name = $1, updated_at = NOW() WHERE id = $2', [name || 'My Squad', squadId]);
      await client.query('DELETE FROM squad_players WHERE squad_id = $1', [squadId]);
    } else {
      const squadResult = await client.query(
        `INSERT INTO squads (user_id, gameweek_id, name) VALUES ($1, $2, $3) RETURNING id`,
        [req.user.id, gameweek_id, name || 'My Squad']
      );
      squadId = squadResult.rows[0].id;
    }

    for (const p of players) {
      await client.query(
        `INSERT INTO squad_players (squad_id, player_id, is_captain, is_vice_captain, position_slot)
         VALUES ($1, $2, $3, $4, $5)`,
        [squadId, p.player_id, p.player_id === captain_id, p.player_id === vice_captain_id, p.position_slot]
      );
    }

    await client.query('COMMIT');
    res.json({ id: squadId, total_spend: totalSpend });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Squad save error:', err);
    res.status(500).json({ error: 'Failed to save squad' });
  } finally {
    client.release();
  }
});

app.delete('/api/squads/:id', auth, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM squads WHERE id = $1 AND user_id = $2 AND locked = FALSE RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Squad not found or locked' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete squad' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POOL ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/pools', async (req, res) => {
  try {
    const { status, gameweek_id, tier } = req.query;
    let query = `SELECT p.*, g.gameweek_number FROM pools p JOIN gameweeks g ON p.gameweek_id = g.id WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (status) { query += ` AND p.status = $${idx++}`; params.push(status); }
    if (gameweek_id) { query += ` AND p.gameweek_id = $${idx++}`; params.push(parseInt(gameweek_id)); }
    if (tier) { query += ` AND p.tier = $${idx++}`; params.push(tier); }

    query += ' ORDER BY p.entry_fee ASC, p.created_at DESC';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

app.get('/api/pools/:id', async (req, res) => {
  try {
    const pool = await db.query(
      `SELECT p.*, g.gameweek_number FROM pools p JOIN gameweeks g ON p.gameweek_id = g.id WHERE p.id = $1`,
      [req.params.id]
    );
    if (pool.rows.length === 0) return res.status(404).json({ error: 'Pool not found' });

    const entries = await db.query(
      `SELECT pe.*, u.username FROM pool_entries pe JOIN users u ON pe.user_id = u.id WHERE pe.pool_id = $1 ORDER BY pe.total_points DESC`,
      [req.params.id]
    );

    res.json({ ...pool.rows[0], entries: entries.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pool' });
  }
});

app.post('/api/pools/join', auth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { pool_id, squad_id, tx_hash } = req.body;
    if (!pool_id || !squad_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'pool_id and squad_id required' });
    }

    const pool = await client.query('SELECT * FROM pools WHERE id = $1 FOR UPDATE', [pool_id]);
    if (pool.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pool not found' }); }

    const p = pool.rows[0];
    if (p.status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Pool is not open' }); }
    if (p.current_players >= p.max_players) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Pool is full' }); }

    const user = await client.query('SELECT balance_usdt FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (parseFloat(user.rows[0].balance_usdt) < parseFloat(p.entry_fee)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    const squad = await client.query('SELECT * FROM squads WHERE id = $1 AND user_id = $2', [squad_id, req.user.id]);
    if (squad.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Squad not found' }); }

    const existing = await client.query('SELECT id FROM pool_entries WHERE pool_id = $1 AND user_id = $2', [pool_id, req.user.id]);
    if (existing.rows.length > 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Already entered this pool' }); }

    await client.query(
      `UPDATE users SET balance_usdt = balance_usdt - $1, total_spent = total_spent + $1, pools_joined = pools_joined + 1, updated_at = NOW() WHERE id = $2`,
      [p.entry_fee, req.user.id]
    );

    const entry = await client.query(
      `INSERT INTO pool_entries (pool_id, user_id, squad_id, entry_amount, tx_hash, status) VALUES ($1, $2, $3, $4, $5, 'confirmed') RETURNING *`,
      [pool_id, req.user.id, squad_id, p.entry_fee, tx_hash || null]
    );

    await client.query(
      `UPDATE pools SET current_players = current_players + 1, prize_pool = prize_pool + $1 WHERE id = $2`,
      [p.entry_fee, pool_id]
    );

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, currency, tx_hash, status, metadata) VALUES ($1, 'pool_entry', $2, $3, $4, 'confirmed', $5)`,
      [req.user.id, p.entry_fee, p.currency, tx_hash || null, JSON.stringify({ pool_id, pool_name: p.name })]
    );

    await client.query('UPDATE squads SET locked = TRUE WHERE id = $1', [squad_id]);

    await client.query('COMMIT');
    res.json({ entry: entry.rows[0], message: 'Successfully joined pool!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Pool join error:', err);
    res.status(500).json({ error: 'Failed to join pool' });
  } finally {
    client.release();
  }
});

// ── FIXED: Pool creation is now admin-only ───────────────────────────────
app.post('/api/pools/create', auth, adminAuth, async (req, res) => {
  try {
    const { name, tier, entry_fee, currency, chain, max_players, gameweek_id, reward_structure } = req.body;

    const tiers = {
      street:  { entry_fee: 1,    max_players: 10 },
      bronze:  { entry_fee: 5,    max_players: 20 },
      silver:  { entry_fee: 25,   max_players: 50 },
      gold:    { entry_fee: 100,  max_players: 100 },
      diamond: { entry_fee: 500,  max_players: 200 },
    };

    const tierConfig = tiers[tier] || tiers.street;

    const result = await db.query(
      `INSERT INTO pools (name, tier, entry_fee, currency, chain, max_players, gameweek_id, reward_structure)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        name || `${tier || 'Street'} Pool`,
        tier || 'street',
        entry_fee || tierConfig.entry_fee,
        currency || 'USDT',
        chain || 'TRC20',
        max_players || tierConfig.max_players,
        gameweek_id,
        reward_structure || 'top3'
      ]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Pool create error:', err);
    res.status(500).json({ error: 'Failed to create pool' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GAMEWEEK ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/gameweeks', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM gameweeks ORDER BY gameweek_number DESC LIMIT 20');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch gameweeks' });
  }
});

app.get('/api/gameweeks/current', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM gameweeks WHERE status IN ('upcoming', 'live') ORDER BY gameweek_number ASC LIMIT 1`
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch current gameweek' });
  }
});

app.post('/api/gameweeks', auth, adminAuth, async (req, res) => {
  try {
    const { gameweek_number, deadline, start_date, end_date } = req.body;
    const result = await db.query(
      `INSERT INTO gameweeks (gameweek_number, deadline, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING *`,
      [gameweek_number, deadline, start_date, end_date]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create gameweek' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { gameweek_id } = req.query;
    let query = `
      SELECT l.*, u.username,
             (SELECT COUNT(*) FROM squads WHERE user_id = l.user_id) as total_squads
      FROM leaderboard l JOIN users u ON l.user_id = u.id
    `;
    const params = [];
    if (gameweek_id) {
      query += ' WHERE l.gameweek_id = $1';
      params.push(parseInt(gameweek_id));
    }
    query += ' ORDER BY l.total_points DESC LIMIT 100';

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WALLET / CRYPTO ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/wallet/balance', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT balance_usdt, total_earned, total_spent FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

// ── Real deposit verification using block explorers ──────────────────────
app.post('/api/wallet/deposit', auth, walletLimiter, async (req, res) => {
  try {
    const { amount, tx_hash, chain } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!tx_hash) return res.status(400).json({ error: 'Transaction hash required for verification' });

    // Check if tx_hash was already used
    const existingTx = await db.query(
      'SELECT id FROM transactions WHERE tx_hash = $1',
      [tx_hash]
    );
    if (existingTx.rows.length > 0) {
      return res.status(409).json({ error: 'Transaction already processed' });
    }

    // Verify on-chain (simplified - in production use web3/tronweb SDK)
    let verified = false;
    const chainType = chain || 'TRC20';

    try {
      if (chainType === 'TRC20') {
        // Verify via Tronscan API
        const tronRes = await fetch(`https://apilist.tronscanapi.com/api/transaction-info?hash=${tx_hash}`);
        const tronData = await tronRes.json();
        if (tronData.contractRet === 'SUCCESS') {
          // Check token transfer details
          const trc20 = tronData.trc20TransferInfo || [];
          const usdtTransfer = trc20.find(t => t.tokenName === 'Tether USD' || t.token_info?.symbol === 'USDT');
          if (usdtTransfer) {
            const txAmount = parseFloat(usdtTransfer.amount || usdtTransfer.quant || 0) / 1000000;
            if (txAmount >= parseFloat(amount)) {
              verified = true;
            }
          }
        }
      } else if (chainType === 'ERC20') {
        // Verify via Etherscan API
        const ethRes = await fetch(
          `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${tx_hash}&apikey=${process.env.ETHERSCAN_API_KEY || ''}`
        );
        const ethData = await ethRes.json();
        if (ethData.result && ethData.result.blockNumber && ethData.result.blockNumber !== '0x0') {
          verified = true; // Simplified - verify token transfer in production
        }
      } else if (chainType === 'SOL') {
        // Verify via Solana RPC
        const solRes = await fetch('https://api.mainnet-beta.solana.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'getTransaction',
            params: [tx_hash, { encoding: 'jsonParsed' }]
          })
        });
        const solData = await solRes.json();
        if (solData.result && solData.result.meta && !solData.result.meta.err) {
          verified = true;
        }
      } else {
        // For BTC/MATIC - mark as pending manual review
        verified = false;
      }
    } catch (verifyErr) {
      console.error(`Chain verification failed for ${chainType}:`, verifyErr.message);
      verified = false;
    }

    if (!verified) {
      // Save as pending for manual review
      await db.query(
        `INSERT INTO transactions (user_id, type, amount, currency, chain, tx_hash, status, metadata)
         VALUES ($1, 'deposit', $2, 'USDT', $3, $4, 'pending', $5)`,
        [req.user.id, amount, chainType, tx_hash, JSON.stringify({ needs_review: true })]
      );
      return res.json({ ok: true, message: 'Deposit submitted for review', status: 'pending' });
    }

    // Verified - credit balance
    await db.query(
      `INSERT INTO transactions (user_id, type, amount, currency, chain, tx_hash, status, metadata)
       VALUES ($1, 'deposit', $2, 'USDT', $3, $4, 'confirmed', $5)`,
      [req.user.id, amount, chainType, tx_hash, JSON.stringify({ verified: true, chain: chainType })]
    );

    await db.query(
      `UPDATE users SET balance_usdt = balance_usdt + $1, updated_at = NOW() WHERE id = $2`,
      [amount, req.user.id]
    );

    res.json({ ok: true, message: `Deposited ${amount} USDT`, status: 'confirmed' });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Deposit failed' });
  }
});

// GET /api/wallet/transactions — FIXED: parameterized limit
app.get('/api/wallet/transactions', auth, async (req, res) => {
  try {
    const { type, limit } = req.query;
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    let query = 'SELECT * FROM transactions WHERE user_id = $1';
    const params = [req.user.id];
    let idx = 2;

    if (type) { query += ` AND type = $${idx++}`; params.push(type); }
    query += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(limitNum);

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.post('/api/wallet/withdraw', auth, walletLimiter, async (req, res) => {
  try {
    const { amount, to_address, chain } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!to_address) return res.status(400).json({ error: 'Destination address required' });

    const user = await db.query('SELECT balance_usdt FROM users WHERE id = $1', [req.user.id]);
    if (parseFloat(user.rows[0].balance_usdt) < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Auto-approve small crypto withdrawals (< $50)
    const AUTO_APPROVE_LIMIT = 50;
    const isAutoApproved = parseFloat(amount) < AUTO_APPROVE_LIMIT && chain === 'TRC20';

    await db.query(
      `UPDATE users SET balance_usdt = balance_usdt - $1, updated_at = NOW() WHERE id = $2`,
      [amount, req.user.id]
    );

    const txResult = await db.query(
      `INSERT INTO transactions (user_id, type, amount, currency, chain, to_address, status, metadata)
       VALUES ($1, 'withdrawal', $2, 'USDT', $3, $4, $5, $6) RETURNING *`,
      [req.user.id, amount, chain || 'TRC20', to_address,
       isAutoApproved ? 'processing' : 'pending',
       JSON.stringify({ auto_approved: isAutoApproved, limit: AUTO_APPROVE_LIMIT })]
    );

    // Auto-execute if under limit
    if (isAutoApproved) {
      processCryptoPayout(txResult.rows[0]).catch(e => console.error('Auto-payout failed:', e.message));
    }

    res.json({
      ok: true,
      status: isAutoApproved ? 'processing' : 'pending',
      message: isAutoApproved
        ? `Withdrawal of ${amount} USDT auto-approved and processing!`
        : `Withdrawal of ${amount} USDT submitted for review`,
      tx_id: txResult.rows[0].id
    });
  } catch (err) {
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-PAYOUT ENGINE
// ═══════════════════════════════════════════════════════════════════════════

let TronWeb;
let tronReady = false;

async function initTronWeb() {
  try {
    const TronWebModule = require('tronweb');
    TronWeb = TronWebModule.default || TronWebModule;
    if (process.env.TRON_PRIVATE_KEY && process.env.TRON_WALLET_ADDRESS) {
      tronReady = true;
      console.log('✅ TronWeb initialized for auto-payouts');
    } else {
      console.log('⚠️  TronWeb: No keys configured, auto-payouts disabled');
    }
  } catch (e) {
    console.log('⚠️  TronWeb not available:', e.message);
  }
}
initTronWeb();

// USDT TRC20 contract address
const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

async function processCryptoPayout(tx) {
  if (!tronReady) {
    console.log('Crypto payout queued (TronWeb not configured):', tx.id);
    return;
  }

  try {
    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY },
      privateKey: process.env.TRON_PRIVATE_KEY,
    });

    const amountSun = parseFloat(tx.amount) * 1000000; // USDT has 6 decimals
    const contract = await tronWeb.contract().at(USDT_TRC20);

    const result = await contract.methods
      .transfer(tx.to_address, amountSun)
      .send({ from: process.env.TRON_WALLET_ADDRESS });

    await db.query(
      `UPDATE transactions SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW(),
       metadata = jsonb_set(COALESCE(metadata, '{}'), '{auto_payout}', 'true') WHERE id = $2`,
      [result, tx.id]
    );

    console.log(`✅ Auto-payout sent: ${tx.amount} USDT → ${tx.to_address} (tx: ${result})`);
  } catch (err) {
    await db.query(
      `UPDATE transactions SET status = 'failed',
       metadata = jsonb_set(COALESCE(metadata, '{}'), '{error}', $1) WHERE id = $2`,
      [JSON.stringify(err.message), tx.id]
    );
    // Refund on failure
    await db.query('UPDATE users SET balance_usdt = balance_usdt + $1 WHERE id = $2', [tx.amount, tx.user_id]);
    console.error(`❌ Auto-payout failed for tx ${tx.id}:`, err.message);
  }
}

// Flutterwave NGN payout
async function processNgnPayout(tx) {
  if (!process.env.FLW_SECRET_KEY) {
    console.log('NGN payout queued (Flutterwave not configured):', tx.id);
    return;
  }

  try {
    const meta = tx.metadata || {};
    const res = await fetch('https://api.flutterwave.com/v3/transfers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.FLW_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        account_bank: meta.bank_code || '044',
        account_number: meta.account_number,
        amount: meta.amount_ngn || tx.amount,
        currency: 'NGN',
        reference: `VF-${tx.id.substring(0, 8)}`,
        debit_subaccount: '',
        narrative: 'VultFantasy withdrawal',
      }),
    });

    const result = await res.json();

    if (result.status === 'success') {
      await db.query(
        `UPDATE transactions SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW() WHERE id = $2`,
        [result.data?.id || 'flw-' + Date.now(), tx.id]
      );
      console.log(`✅ NGN payout sent: ₦${meta.amount_ngn} → ${meta.account_number}`);
    } else {
      throw new Error(result.message || 'Flutterwave transfer failed');
    }
  } catch (err) {
    await db.query(
      `UPDATE transactions SET status = 'failed',
       metadata = jsonb_set(COALESCE(metadata, '{}'), '{error}', $1) WHERE id = $2`,
      [JSON.stringify(err.message), tx.id]
    );
    // Refund on failure
    const meta = tx.metadata || {};
    const usdAmount = meta.amount_usd || tx.amount;
    await db.query('UPDATE users SET balance_usdt = balance_usdt + $1 WHERE id = $2', [usdAmount, tx.user_id]);
    console.error(`❌ NGN payout failed for tx ${tx.id}:`, err.message);
  }
}

// Get withdrawal status
app.get('/api/wallet/withdrawal-status/:id', auth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, status, amount, currency, chain, tx_hash, confirmed_at, metadata FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
    const tx = result.rows[0];
    res.json({
      id: tx.id,
      status: tx.status,
      amount: tx.amount,
      currency: tx.currency,
      chain: tx.chain,
      tx_hash: tx.tx_hash,
      confirmed_at: tx.confirmed_at,
      message: tx.status === 'confirmed' ? '✅ Completed' :
               tx.status === 'processing' ? '⏳ Processing (usually 1-5 minutes)' :
               tx.status === 'pending' ? '🕐 Pending approval' :
               tx.status === 'failed' ? '❌ Failed — balance refunded' : tx.status
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EPL DATA + SCORING PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

// Fantasy points calculation
function calculatePoints(perf) {
  let pts = 0;
  pts += (perf.goals || 0) * 10;
  pts += (perf.assists || 0) * 7;
  pts += perf.clean_sheet ? 5 : 0;
  pts += (perf.yellow_cards || 0) * -2;
  pts += (perf.red_cards || 0) * -5;
  pts += (perf.own_goals || 0) * -3;
  pts += (perf.penalties_saved || 0) * 5;
  pts += (perf.penalties_missed || 0) * -2;
  pts += Math.floor((perf.minutes_played || 0) / 60); // 1 pt per 60 mins
  pts += (perf.bonus_points || 0);

  // Position-specific bonuses
  if (perf.position === 'GK') pts += (perf.saves || 0) >= 3 ? 1 : 0;

  return Math.max(pts, 0); // No negative total points
}

// Sync players from Football-Data.org
app.post('/api/admin/sync-players', auth, adminAuth, async (req, res) => {
  try {
    const API_KEY = process.env.FOOTBALL_API_KEY;
    if (!API_KEY) {
      return res.status(400).json({ error: 'FOOTBALL_API_KEY not configured' });
    }

    // Fetch Premier League standings (team IDs)
    const teamsRes = await fetch('https://api.football-data.org/v4/competitions/PL/standings', {
      headers: { 'X-Auth-Token': API_KEY }
    });

    if (!teamsRes.ok) {
      return res.status(502).json({ error: 'Football API error', status: teamsRes.status });
    }

    const teamsData = await teamsRes.json();
    let synced = 0;

    for (const standing of teamsData.standings?.[0]?.table || []) {
      const teamName = standing.team.name;

      // Fetch squad for each team
      const squadRes = await fetch(`https://api.football-data.org/v4/teams/${standing.team.id}`, {
        headers: { 'X-Auth-Token': API_KEY }
      });

      if (!squadRes.ok) continue;
      const squadData = await squadRes.json();

      for (const player of squadData.squad || []) {
        const pos = player.position || 'MID';
        const fplPos = pos.includes('Goalkeeper') ? 'GK' :
                       pos.includes('Defender') ? 'DEF' :
                       pos.includes('Forward') ? 'FWD' : 'MID';

        // Estimate price based on position
        const basePrices = { GK: 4.5, DEF: 5.0, MID: 6.5, FWD: 7.5 };
        const price = parseFloat((basePrices[fplPos] + Math.random() * 2).toFixed(1));

        await db.query(
          `INSERT INTO players (external_id, name, team, position, price)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET
             team = EXCLUDED.team, position = EXCLUDED.position,
             price = EXCLUDED.price, updated_at = NOW()`,
          [player.id, player.name || `${player.firstName} ${player.lastName}`, teamName, fplPos, price]
        );
        synced++;
      }
    }

    res.json({ ok: true, synced, message: `Synced ${synced} players` });
  } catch (err) {
    console.error('Player sync error:', err);
    res.status(500).json({ error: 'Failed to sync players' });
  }
});

// Fetch match results for a gameweek and calculate player points
app.post('/api/admin/score-gameweek', auth, adminAuth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { gameweek_id } = req.body;
    if (!gameweek_id) return res.status(400).json({ error: 'gameweek_id required' });

    // Get gameweek
    const gw = await client.query('SELECT * FROM gameweeks WHERE id = $1', [gameweek_id]);
    if (gw.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Gameweek not found' }); }

    const gameweek = gw.rows[0];

    // Fetch matches from Football API
    const API_KEY = process.env.FOOTBALL_API_KEY;
    if (!API_KEY) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'FOOTBALL_API_KEY not configured' });
    }

    // Fetch all PL matches
    const matchesRes = await fetch(
      `https://api.football-data.org/v4/competitions/PL/matches?matchday=${gameweek.gameweek_number}`,
      { headers: { 'X-Auth-Token': API_KEY } }
    );

    if (!matchesRes.ok) {
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'Football API error' });
    }

    const matchesData = await matchesRes.json();
    let scoredPlayers = 0;

    // For each match, fetch stats and calculate points
    for (const match of matchesData.matches || []) {
      if (match.status !== 'FINISHED') continue;

      // Fetch match details with stats
      const matchDetailRes = await fetch(
        `https://api.football-data.org/v4/matches/${match.id}`,
        { headers: { 'X-Auth-Token': API_KEY } }
      );

      if (!matchDetailRes.ok) continue;
      const matchDetail = await matchDetailRes.json();

      // Extract player stats from match
      for (const team of [matchDetail.homeTeam, matchDetail.awayTeam]) {
        // Note: Football API doesn't always provide detailed player stats in free tier
        // This is a framework - in production, supplement with FPL API or other sources
        for (const squad of []) {
          // Placeholder for when detailed stats are available
        }
      }
    }

    // Update gameweek status
    await client.query(
      "UPDATE gameweeks SET status = 'finished' WHERE id = $1",
      [gameweek_id]
    );

    // Calculate leaderboard for this gameweek
    const squads = await client.query(
      `SELECT sp.*, sq.user_id, sq.id as squad_id
       FROM squad_players sp
       JOIN squads sq ON sp.squad_id = sq.id
       WHERE sq.gameweek_id = $1`,
      [gameweek_id]
    );

    const userPoints = {};
    for (const sp of squads.rows) {
      const perf = await client.query(
        'SELECT calculated_points FROM player_performance WHERE player_id = $1 AND gameweek_id = $2',
        [sp.player_id, gameweek_id]
      );

      let pts = perf.rows[0]?.calculated_points || 0;
      if (sp.is_captain) pts *= 2; // Captain doubles points

      userPoints[sp.user_id] = (userPoints[sp.user_id] || 0) + pts;
    }

    // Update leaderboard
    for (const [userId, points] of Object.entries(userPoints)) {
      await client.query(
        `INSERT INTO leaderboard (user_id, gameweek_id, total_points)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, gameweek_id) DO UPDATE SET total_points = $3, updated_at = NOW()`,
        [userId, gameweek_id, points]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, scoredPlayers, message: `Gameweek ${gameweek.gameweek_number} scored` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Scoring error:', err);
    res.status(500).json({ error: 'Failed to score gameweek' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POOL RESOLUTION + PRIZE DISTRIBUTION
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/admin/resolve-pools', auth, adminAuth, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { gameweek_id } = req.body;
    if (!gameweek_id) return res.status(400).json({ error: 'gameweek_id required' });

    // Get all open pools for this gameweek
    const pools = await client.query(
      "SELECT * FROM pools WHERE gameweek_id = $1 AND status = 'open'",
      [gameweek_id]
    );

    let resolvedPools = 0;

    for (const pool of pools.rows) {
      if (pool.current_players < 2) {
        // Not enough players - refund everyone
        const entries = await client.query(
          'SELECT * FROM pool_entries WHERE pool_id = $1',
          [pool.id]
        );

        for (const entry of entries.rows) {
          await client.query(
            'UPDATE users SET balance_usdt = balance_usdt + $1 WHERE id = $2',
            [entry.entry_amount, entry.user_id]
          );
          await client.query(
            `INSERT INTO transactions (user_id, type, amount, currency, status, metadata)
             VALUES ($1, 'prize', $2, 'USDT', 'confirmed', $3)`,
            [entry.user_id, entry.entry_amount, JSON.stringify({ type: 'refund', pool_id: pool.id })]
          );
          await client.query(
            'UPDATE pool_entries SET status = $1 WHERE id = $2',
            ['refunded', entry.id]
          );
        }

        await client.query("UPDATE pools SET status = 'cancelled' WHERE id = $1", [pool.id]);
        continue;
      }

      // Get all entries with their squad points
      const entries = await client.query(
        `SELECT pe.*, sq.id as squad_id
         FROM pool_entries pe
         JOIN squads sq ON pe.squad_id = sq.id
         WHERE pe.pool_id = $1`,
        [pool.id]
      );

      // Calculate total points for each entry
      for (const entry of entries.rows) {
        const squadPlayers = await client.query(
          'SELECT * FROM squad_players WHERE squad_id = $1',
          [entry.squad_id]
        );

        let totalPts = 0;
        for (const sp of squadPlayers.rows) {
          const perf = await client.query(
            'SELECT calculated_points FROM player_performance WHERE player_id = $1 AND gameweek_id = $2',
            [sp.player_id, gameweek_id]
          );
          let pts = perf.rows[0]?.calculated_points || 0;
          if (sp.is_captain) pts *= 2;
          totalPts += pts;
        }

        await client.query(
          'UPDATE pool_entries SET total_points = $1 WHERE id = $2',
          [totalPts, entry.id]
        );
      }

      // Rank entries and distribute prizes (top 3 split: 60% / 25% / 15%)
      const ranked = await client.query(
        'SELECT * FROM pool_entries WHERE pool_id = $1 ORDER BY total_points DESC',
        [pool.id]
      );

      const prizePool = parseFloat(pool.prize_pool);
      const prizes = [
        prizePool * 0.60, // 1st: 60%
        prizePool * 0.25, // 2nd: 25%
        prizePool * 0.15, // 3rd: 15%
      ];

      for (let i = 0; i < Math.min(3, ranked.rows.length); i++) {
        const entry = ranked.rows[i];
        const prize = prizes[i];

        await client.query(
          'UPDATE pool_entries SET rank = $1, prize_won = $2 WHERE id = $3',
          [i + 1, prize, entry.id]
        );

        await client.query(
          'UPDATE users SET balance_usdt = balance_usdt + $1, total_earned = total_earned + $1, pools_won = pools_won + 1 WHERE id = $2',
          [prize, entry.user_id]
        );

        await client.query(
          `INSERT INTO transactions (user_id, type, amount, currency, status, metadata)
           VALUES ($1, 'prize', $2, 'USDT', 'confirmed', $3)`,
          [entry.user_id, prize, JSON.stringify({ pool_id: pool.id, rank: i + 1, pool_name: pool.name })]
        );
      }

      // Update pool winners
      await client.query(
        `UPDATE pools SET
          status = 'completed',
          winner_1 = $1, prize_1 = $2,
          winner_2 = $3, prize_2 = $4,
          winner_3 = $5, prize_3 = $6
         WHERE id = $7`,
        [
          ranked.rows[0]?.user_id, prizes[0],
          ranked.rows[1]?.user_id, prizes[1],
          ranked.rows[2]?.user_id, prizes[2],
          pool.id
        ]
      );

      resolvedPools++;
    }

    await client.query('COMMIT');
    res.json({ ok: true, resolved: resolvedPools, message: `Resolved ${resolvedPools} pools` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Pool resolution error:', err);
    res.status(500).json({ error: 'Failed to resolve pools' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/admin/seed-players', auth, adminAuth, async (req, res) => {
  try {
    const { players } = req.body;
    if (!players || !Array.isArray(players)) return res.status(400).json({ error: 'players array required' });

    let inserted = 0;
    for (const p of players) {
      try {
        await db.query(
          `INSERT INTO players (name, team, position, price, photo_url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (name) DO UPDATE SET team = EXCLUDED.team, position = EXCLUDED.position,
             price = EXCLUDED.price, photo_url = EXCLUDED.photo_url`,
          [p.name, p.team, p.position, p.price, p.photo_url || null]
        );
        inserted++;
      } catch (e) { /* skip */ }
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to seed players' });
  }
});

app.post('/api/admin/seed-gameweeks', auth, adminAuth, async (req, res) => {
  try {
    const { count, start_date } = req.body;
    const startDate = new Date(start_date || Date.now());
    let inserted = 0;

    for (let i = 1; i <= (count || 38); i++) {
      const gwStart = new Date(startDate);
      gwStart.setDate(gwStart.getDate() + (i - 1) * 7);
      const deadline = new Date(gwStart);
      deadline.setDate(deadline.getDate() - 2);

      try {
        await db.query(
          `INSERT INTO gameweeks (gameweek_number, deadline, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, 'upcoming') ON CONFLICT (gameweek_number) DO NOTHING`,
          [i, deadline, gwStart, new Date(gwStart.getTime() + 3 * 86400000)]
        );
        inserted++;
      } catch (e) { /* skip */ }
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to seed gameweeks' });
  }
});

app.post('/api/admin/seed-pools', auth, adminAuth, async (req, res) => {
  try {
    const { gameweek_id } = req.body;
    const tiers = [
      { tier: 'street',  entry_fee: 1,    max_players: 10,  name: 'Street Pool' },
      { tier: 'bronze',  entry_fee: 5,    max_players: 20,  name: 'Bronze Pool' },
      { tier: 'silver',  entry_fee: 25,   max_players: 50,  name: 'Silver Pool' },
      { tier: 'gold',    entry_fee: 100,  max_players: 100, name: 'Gold Pool' },
      { tier: 'diamond', entry_fee: 500,  max_players: 200, name: 'Diamond Pool' },
    ];

    let inserted = 0;
    for (const t of tiers) {
      try {
        await db.query(
          `INSERT INTO pools (name, tier, entry_fee, max_players, gameweek_id) VALUES ($1, $2, $3, $4, $5)`,
          [t.name, t.tier, t.entry_fee, t.max_players, gameweek_id]
        );
        inserted++;
      } catch (e) { /* skip */ }
    }
    res.json({ ok: true, inserted });
  } catch (err) {
    res.status(500).json({ error: 'Failed to seed pools' });
  }
});

// Admin: list pending withdrawals for manual review
app.get('/api/admin/withdrawals', auth, adminAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT t.*, u.username, u.wallet_address, u.wallet_chain
       FROM transactions t JOIN users u ON t.user_id = u.id
       WHERE t.type = 'withdrawal' AND t.status = 'pending'
       ORDER BY t.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

// Admin: approve/reject withdrawal
app.post('/api/admin/withdrawals/:id/approve', auth, adminAuth, async (req, res) => {
  try {
    const { tx_hash } = req.body;
    const result = await db.query(
      "UPDATE transactions SET status = 'confirmed', tx_hash = $1, confirmed_at = NOW() WHERE id = $2 AND type = 'withdrawal' AND status = 'pending' RETURNING *",
      [tx_hash || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Withdrawal not found' });
    res.json({ ok: true, withdrawal: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve withdrawal' });
  }
});

app.post('/api/admin/withdrawals/:id/reject', auth, adminAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const tx = await db.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (tx.rows.length === 0) return res.status(404).json({ error: 'Withdrawal not found' });

    // Refund balance
    await db.query(
      'UPDATE users SET balance_usdt = balance_usdt + $1 WHERE id = $2',
      [tx.rows[0].amount, tx.rows[0].user_id]
    );

    await db.query(
      "UPDATE transactions SET status = 'failed', metadata = jsonb_set(COALESCE(metadata, '{}'), '{reason}', $1) WHERE id = $2",
      [JSON.stringify(reason || 'Rejected by admin'), req.params.id]
    );

    res.json({ ok: true, message: 'Withdrawal rejected, balance refunded' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject withdrawal' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/stats', async (req, res) => {
  try {
    const [users, pools, totalPrizes, activePools] = await Promise.all([
      db.query('SELECT COUNT(*) as count FROM users'),
      db.query('SELECT COUNT(*) as count FROM pools'),
      db.query('SELECT COALESCE(SUM(prize_pool), 0) as total FROM pools'),
      db.query("SELECT COUNT(*) as count FROM pools WHERE status = 'open'"),
    ]);
    res.json({
      total_users: parseInt(users.rows[0].count),
      total_pools: parseInt(pools.rows[0].count),
      total_prizes: parseFloat(totalPrizes.rows[0].total),
      active_pools: parseInt(activePools.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── Health ───────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now(), service: 'vultfantasy' }));

// ── Catch-all: serve frontend ────────────────────────────────────────────
app.use((req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  }
});

// ── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () =>
  console.log(`⚡ VultFantasy API running on 127.0.0.1:${PORT}`)
);
