-- VultFantasy Database Schema
-- Fantasy Premier League with Crypto Pool Rewards

-- ═══════════════════════════════════════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(30) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    wallet_address VARCHAR(100),
    wallet_chain VARCHAR(20),          -- ETH, SOL, BTC, MATIC, TRON
    balance_usdt DECIMAL(12,2) DEFAULT 0.00,
    total_earned DECIMAL(12,2) DEFAULT 0.00,
    total_spent DECIMAL(12,2) DEFAULT 0.00,
    pools_joined INT DEFAULT 0,
    pools_won INT DEFAULT 0,
    referral_code VARCHAR(10) UNIQUE,
    referred_by UUID REFERENCES users(id),
    is_verified BOOLEAN DEFAULT FALSE,
    is_admin BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- EPL PLAYERS (synced from Football API or seeded)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    external_id INT UNIQUE,           -- ID from football API
    name VARCHAR(100) NOT NULL,
    team VARCHAR(50) NOT NULL,
    position VARCHAR(3) NOT NULL,     -- GK, DEF, MID, FWD
    photo_url VARCHAR(255),
    price DECIMAL(6,2) NOT NULL,      -- virtual price for squad building
    total_points INT DEFAULT 0,
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- GAME WEEKS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gameweeks (
    id SERIAL PRIMARY KEY,
    gameweek_number INT UNIQUE NOT NULL,
    deadline TIMESTAMP NOT NULL,       -- when squads lock
    status VARCHAR(20) DEFAULT 'upcoming', -- upcoming, live, finished
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PLAYER PERFORMANCE PER GAMEWEEK
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS player_performance (
    id SERIAL PRIMARY KEY,
    player_id INT REFERENCES players(id),
    gameweek_id INT REFERENCES gameweeks(id),
    goals INT DEFAULT 0,
    assists INT DEFAULT 0,
    clean_sheet BOOLEAN DEFAULT FALSE,
    yellow_cards INT DEFAULT 0,
    red_cards INT DEFAULT 0,
    own_goals INT DEFAULT 0,
    penalties_saved INT DEFAULT 0,
    penalties_missed INT DEFAULT 0,
    saves INT DEFAULT 0,
    minutes_played INT DEFAULT 0,
    bonus_points INT DEFAULT 0,
    calculated_points INT DEFAULT 0,
    match_date TIMESTAMP,
    opponent VARCHAR(50),
    result VARCHAR(5),                 -- W, D, L
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(player_id, gameweek_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- USER SQUADS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS squads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    gameweek_id INT REFERENCES gameweeks(id),
    name VARCHAR(50) DEFAULT 'My Squad',
    total_points INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    locked BOOLEAN DEFAULT FALSE,      -- locked after deadline
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, gameweek_id)      -- one squad per gameweek
);

-- ═══════════════════════════════════════════════════════════════════════════
-- SQUAD PLAYERS (junction table)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS squad_players (
    id SERIAL PRIMARY KEY,
    squad_id UUID REFERENCES squads(id) ON DELETE CASCADE,
    player_id INT REFERENCES players(id),
    is_captain BOOLEAN DEFAULT FALSE,
    is_vice_captain BOOLEAN DEFAULT FALSE,
    position_slot INT NOT NULL,        -- 1-15 squad position
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(squad_id, player_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- POOL ROOMS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    tier VARCHAR(20) NOT NULL,         -- street, bronze, silver, gold, diamond
    entry_fee DECIMAL(10,2) NOT NULL,  -- in USDT
    currency VARCHAR(10) DEFAULT 'USDT',
    chain VARCHAR(10),                 -- TRC20, ERC20, SOL, BTC, MATIC
    max_players INT NOT NULL,
    current_players INT DEFAULT 0,
    prize_pool DECIMAL(12,2) DEFAULT 0.00,
    house_fee DECIMAL(12,2) DEFAULT 0.00,
    reward_structure VARCHAR(20) DEFAULT 'top3', -- top3, winner_takes_all, progressive
    gameweek_id INT REFERENCES gameweeks(id),
    status VARCHAR(20) DEFAULT 'open', -- open, locked, scoring, completed, cancelled
    winner_1 UUID REFERENCES users(id),
    winner_2 UUID REFERENCES users(id),
    winner_3 UUID REFERENCES users(id),
    prize_1 DECIMAL(10,2),
    prize_2 DECIMAL(10,2),
    prize_3 DECIMAL(10,2),
    created_at TIMESTAMP DEFAULT NOW(),
    starts_at TIMESTAMP,
    ends_at TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- POOL ENTRIES (users who joined a pool)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS pool_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID REFERENCES pools(id),
    user_id UUID REFERENCES users(id),
    squad_id UUID REFERENCES squads(id),
    entry_amount DECIMAL(10,2) NOT NULL,
    total_points INT DEFAULT 0,
    rank INT,
    prize_won DECIMAL(10,2) DEFAULT 0.00,
    tx_hash VARCHAR(100),              -- blockchain transaction hash
    status VARCHAR(20) DEFAULT 'pending', -- pending, confirmed, refunded, paid
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(pool_id, user_id)           -- one entry per user per pool
);

-- ═══════════════════════════════════════════════════════════════════════════
-- TRANSACTIONS (deposits, withdrawals, pool fees, prizes)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    type VARCHAR(20) NOT NULL,         -- deposit, withdrawal, pool_entry, prize, referral_bonus
    amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USDT',
    chain VARCHAR(10),
    tx_hash VARCHAR(100),
    from_address VARCHAR(100),
    to_address VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending', -- pending, confirmed, failed
    metadata JSONB,                    -- extra data (pool_id, etc.)
    created_at TIMESTAMP DEFAULT NOW(),
    confirmed_at TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- REFERRALS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS referrals (
    id SERIAL PRIMARY KEY,
    referrer_id UUID REFERENCES users(id),
    referred_id UUID REFERENCES users(id),
    bonus_earned DECIMAL(10,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(referred_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- LEADERBOARD (materialized view for fast queries)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS leaderboard (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    gameweek_id INT REFERENCES gameweeks(id),
    total_points INT DEFAULT 0,
    rank INT,
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, gameweek_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES for performance
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);
CREATE INDEX IF NOT EXISTS idx_players_position ON players(position);
CREATE INDEX IF NOT EXISTS idx_squads_user ON squads(user_id);
CREATE INDEX IF NOT EXISTS idx_squads_gameweek ON squads(gameweek_id);
CREATE INDEX IF NOT EXISTS idx_pool_entries_pool ON pool_entries(pool_id);
CREATE INDEX IF NOT EXISTS idx_pool_entries_user ON pool_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_gameweek ON leaderboard(gameweek_id, total_points DESC);
CREATE INDEX IF NOT EXISTS idx_pools_status ON pools(status);
CREATE INDEX IF NOT EXISTS idx_pools_gameweek ON pools(gameweek_id);
