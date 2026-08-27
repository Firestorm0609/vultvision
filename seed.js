require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Premier League 2024/25 Players with prices
const players = [
  // ═══ GOALKEEPERS ═══════════════════════════════════════════════════════
  { name: 'Alisson Becker', team: 'Liverpool', position: 'GK', price: 5.5 },
  { name: 'Ederson', team: 'Manchester City', position: 'GK', price: 5.5 },
  { name: 'David Raya', team: 'Arsenal', position: 'GK', price: 5.5 },
  { name: 'Andre Onana', team: 'Manchester United', position: 'GK', price: 5.0 },
  { name: 'Robert Sanchez', team: 'Chelsea', position: 'GK', price: 4.5 },
  { name: 'Jordan Pickford', team: 'Everton', position: 'GK', price: 4.5 },
  { name: 'Aaron Ramsdale', team: 'Southampton', position: 'GK', price: 4.0 },
  { name: 'Mark Flekken', team: 'Brentford', position: 'GK', price: 4.5 },
  { name: 'Bernd Leno', team: 'Fulham', position: 'GK', price: 4.5 },
  { name: 'Emiliano Martinez', team: 'Aston Villa', position: 'GK', price: 5.0 },

  // ═══ DEFENDERS ════════════════════════════════════════════════════════
  { name: 'Virgil van Dijk', team: 'Liverpool', position: 'DEF', price: 6.5 },
  { name: 'William Saliba', team: 'Arsenal', position: 'DEF', price: 6.0 },
  { name: 'Gabriel Magalhaes', team: 'Arsenal', position: 'DEF', price: 5.5 },
  { name: 'Ruben Dias', team: 'Manchester City', position: 'DEF', price: 5.5 },
  { name: 'Trent Alexander-Arnold', team: 'Liverpool', position: 'DEF', price: 7.0 },
  { name: 'Andrew Robertson', team: 'Liverpool', position: 'DEF', price: 5.5 },
  { name: 'Kyle Walker', team: 'Manchester City', position: 'DEF', price: 5.0 },
  { name: 'Josko Gvardiol', team: 'Manchester City', position: 'DEF', price: 5.5 },
  { name: 'Ben White', team: 'Arsenal', position: 'DEF', price: 5.5 },
  { name: 'Jurrien Timber', team: 'Arsenal', position: 'DEF', price: 5.0 },
  { name: 'Levi Colwill', team: 'Chelsea', position: 'DEF', price: 4.5 },
  { name: 'Wesley Fofana', team: 'Chelsea', position: 'DEF', price: 4.5 },
  { name: 'Marc Cucurella', team: 'Chelsea', position: 'DEF', price: 5.0 },
  { name: 'Lewis Hall', team: 'Newcastle United', position: 'DEF', price: 4.5 },
  { name: 'Dan Burn', team: 'Newcastle United', position: 'DEF', price: 4.5 },
  { name: 'Lucas Digne', team: 'Aston Villa', position: 'DEF', price: 4.5 },
  { name: 'Pervis Estupinan', team: 'Brighton', position: 'DEF', price: 5.0 },
  { name: 'Pedro Porro', team: 'Tottenham', position: 'DEF', price: 5.5 },
  { name: 'Micky van de Ven', team: 'Tottenham', position: 'DEF', price: 5.0 },
  { name: 'Nathan Ake', team: 'Manchester City', position: 'DEF', price: 5.0 },

  // ═══ MIDFIELDERS ══════════════════════════════════════════════════════
  { name: 'Mohamed Salah', team: 'Liverpool', position: 'MID', price: 13.0 },
  { name: 'Kevin De Bruyne', team: 'Manchester City', position: 'MID', price: 10.5 },
  { name: 'Bukayo Saka', team: 'Arsenal', position: 'MID', price: 10.0 },
  { name: 'Martin Odegaard', team: 'Arsenal', position: 'MID', price: 8.5 },
  { name: 'Phil Foden', team: 'Manchester City', position: 'MID', price: 9.5 },
  { name: 'Cole Palmer', team: 'Chelsea', position: 'MID', price: 10.5 },
  { name: 'Bernardo Silva', team: 'Manchester City', position: 'MID', price: 7.5 },
  { name: 'Bruno Fernandes', team: 'Manchester United', position: 'MID', price: 8.5 },
  { name: 'James Maddison', team: 'Tottenham', position: 'MID', price: 7.5 },
  { name: 'Son Heung-min', team: 'Tottenham', position: 'MID', price: 9.5 },
  { name: 'Anthony Gordon', team: 'Newcastle United', position: 'MID', price: 7.5 },
  { name: 'Jarrod Bowen', team: 'West Ham', position: 'MID', price: 7.0 },
  { name: 'Eberechi Eze', team: 'Crystal Palace', position: 'MID', price: 7.0 },
  { name: 'Ollie Watkins', team: 'Aston Villa', position: 'MID', price: 8.0 },
  { name: 'Simon Adingra', team: 'Brighton', position: 'MID', price: 6.0 },
  { name: 'Amadou Onana', team: 'Aston Villa', position: 'MID', price: 5.5 },
  { name: 'James Ward-Prowse', team: 'West Ham', position: 'MID', price: 6.0 },
  { name: 'Morgan Rogers', team: 'Aston Villa', position: 'MID', price: 6.0 },
  { name: 'Nicolo Barella', team: 'Newcastle United', position: 'MID', price: 6.5 },
  { name: 'Joao Pedro', team: 'Brighton', position: 'MID', price: 6.5 },

  // ═══ FORWARDS ═════════════════════════════════════════════════════════
  { name: 'Erling Haaland', team: 'Manchester City', position: 'FWD', price: 15.0 },
  { name: 'Alexander Isak', team: 'Newcastle United', position: 'FWD', price: 9.0 },
  { name: 'Darwin Nunez', team: 'Liverpool', position: 'FWD', price: 8.0 },
  { name: 'Nicolas Jackson', team: 'Chelsea', position: 'FWD', price: 7.5 },
  { name: 'Dominic Solanke', team: 'Tottenham', position: 'FWD', price: 7.5 },
  { name: 'Viktor Gyokeres', team: 'Arsenal', position: 'FWD', price: 10.0 },
  { name: 'Cody Gakpo', team: 'Liverpool', position: 'FWD', price: 7.5 },
  { name: 'Jhon Duran', team: 'Aston Villa', position: 'FWD', price: 7.0 },
  { name: 'Jean Philippe Mateta', team: 'Crystal Palace', position: 'FWD', price: 7.0 },
  { name: 'Jhon Arias', team: 'Wolverhampton', position: 'FWD', price: 6.5 },
  { name: 'Niclas Fullkrug', team: 'West Ham', position: 'FWD', price: 6.0 },
  { name: 'Marcus Rashford', team: 'Manchester United', position: 'FWD', price: 7.0 },
  { name: 'Rasmus Hojlund', team: 'Manchester United', position: 'FWD', price: 7.0 },
  { name: 'Matheus Cunha', team: 'Wolverhampton', position: 'FWD', price: 7.5 },
  { name: 'Danny Welbeck', team: 'Brighton', position: 'FWD', price: 6.0 },
  { name: 'Chris Wood', team: 'Nottingham Forest', position: 'FWD', price: 6.5 },
  { name: 'Ollie Watkins', team: 'Aston Villa', position: 'FWD', price: 8.5 },
];

// Admin user for testing
const adminUser = {
  username: 'admin',
  email: 'admin@vultfantasy.me',
  password_hash: '$2a$12$LJ3m4ys3Lg.T0KO7rN7qOe2Tq1Pz5nXjPv1fK5dR8sH6gY9wZ3xKm', // password: admin123
};

async function seed() {
  const client = await db.connect();
  try {
    // Insert players
    let inserted = 0;
    for (const p of players) {
      try {
        await client.query(
          `INSERT INTO players (name, team, position, price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (name) DO UPDATE SET
             team = EXCLUDED.team, position = EXCLUDED.position, price = EXCLUDED.price`,
          [p.name, p.team, p.position, p.price]
        );
        inserted++;
      } catch (e) { /* skip duplicates */ }
    }
    console.log(`✅ Inserted ${inserted} players`);

    // Create gameweeks (next 38 weeks)
    const startDate = new Date();
    let gwInserted = 0;
    for (let i = 1; i <= 38; i++) {
      const gwStart = new Date(startDate);
      gwStart.setDate(gwStart.getDate() + (i - 1) * 7);
      const deadline = new Date(gwStart);
      deadline.setDate(deadline.getDate() - 2);

      try {
        await client.query(
          `INSERT INTO gameweeks (gameweek_number, deadline, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (gameweek_number) DO NOTHING`,
          [i, deadline, gwStart, new Date(gwStart.getTime() + 3 * 86400000), i === 1 ? 'upcoming' : 'upcoming']
        );
        gwInserted++;
      } catch (e) { /* skip */ }
    }
    console.log(`✅ Inserted ${gwInserted} gameweeks`);

    // Create pools for gameweek 1
    const tiers = [
      { tier: 'street',  entry_fee: 1,    max_players: 10,  name: 'Street Pool' },
      { tier: 'bronze',  entry_fee: 5,    max_players: 20,  name: 'Bronze Pool' },
      { tier: 'silver',  entry_fee: 25,   max_players: 50,  name: 'Silver Pool' },
      { tier: 'gold',    entry_fee: 100,  max_players: 100, name: 'Gold Pool' },
      { tier: 'diamond', entry_fee: 500,  max_players: 200, name: 'Diamond Pool' },
    ];

    let poolsInserted = 0;
    for (const t of tiers) {
      try {
        await client.query(
          `INSERT INTO pools (name, tier, entry_fee, max_players, gameweek_id, reward_structure)
           VALUES ($1, $2, $3, $4, 1, 'top3')`,
          [t.name, t.tier, t.entry_fee, t.max_players]
        );
        poolsInserted++;
      } catch (e) { /* skip */ }
    }
    console.log(`✅ Inserted ${poolsInserted} pools for GW1`);

    // Create admin user (with plain bcrypt hash)
    const bcrypt = require('bcryptjs');
    const adminHash = await bcrypt.hash('admin123', 12);
    try {
      await client.query(
        `INSERT INTO users (username, email, password_hash, referral_code, is_admin)
         VALUES ($1, $2, $3, 'ADMIN0', TRUE)
         ON CONFLICT (email) DO NOTHING`,
        ['admin', 'admin@vultfantasy.me', adminHash]
      );
      console.log('✅ Created admin user (admin@vultfantasy.me / admin123)');
    } catch (e) { console.log('⚠️  Admin user may already exist'); }

    console.log('\n🎉 Seed complete!');
  } catch (err) {
    console.error('Seed failed:', err);
  } finally {
    client.release();
    await db.end();
  }
}

seed();
