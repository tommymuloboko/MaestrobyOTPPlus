-- ============================================
-- RFID Integration Schema for MAESTRO-LITE
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. Add tag_number column to attendants if it doesn't exist
-- (Check if your attendants table already has this)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'attendants' AND column_name = 'tag_number'
    ) THEN
        ALTER TABLE attendants ADD COLUMN tag_number TEXT;
        CREATE INDEX idx_attendants_tag_number ON attendants(tag_number);
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'attendants' AND column_name = 'blocked'
    ) THEN
        ALTER TABLE attendants ADD COLUMN blocked BOOLEAN DEFAULT false;
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'attendants' AND column_name = 'authorized_pumps'
    ) THEN
        ALTER TABLE attendants ADD COLUMN authorized_pumps INTEGER[];
    END IF;
END $$;

-- 2. RFID Readers table - stores reader device configuration
-- Each reader is on a physical pump which has multiple nozzles.
-- Each nozzle = a "pump" in PTS. pump_ids[] lists all nozzle-pumps this reader covers.
-- RFID is for tracking who pumped, NOT for authorization.
-- e.g. reader at 192.168.x.100 covers nozzles [1,2,3] of physical pump 1
CREATE TABLE IF NOT EXISTS rfid_readers (
    reader_id SERIAL PRIMARY KEY,
    company_id UUID NOT NULL,
    station_id UUID NOT NULL,
    reader_name VARCHAR(50) NOT NULL,
    ip_address VARCHAR(15) NOT NULL,
    port INTEGER NOT NULL DEFAULT 8080,
    device_address SMALLINT NOT NULL DEFAULT 0,
    pump_ids INTEGER[] NOT NULL DEFAULT '{}',
    pump_id INTEGER,
    location VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ip_address, port)
);

CREATE INDEX IF NOT EXISTS idx_rfid_readers_station ON rfid_readers(station_id);
CREATE INDEX IF NOT EXISTS idx_rfid_readers_company ON rfid_readers(company_id);
CREATE INDEX IF NOT EXISTS idx_rfid_readers_pump_ids ON rfid_readers USING GIN(pump_ids);

COMMENT ON TABLE rfid_readers IS 'RFID reader devices - each covers multiple nozzle-pumps (tracking only, no authorization)';

-- 3. RFID Reader Pumps junction table (LEGACY - kept for backward compatibility)
-- New architecture uses rfid_readers.pump_id directly (1:1 mapping)
CREATE TABLE IF NOT EXISTS rfid_reader_pumps (
    id SERIAL PRIMARY KEY,
    reader_id INTEGER NOT NULL REFERENCES rfid_readers(reader_id) ON DELETE CASCADE,
    pump_id INTEGER NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(reader_id, pump_id)
);

CREATE INDEX IF NOT EXISTS idx_reader_pumps_reader ON rfid_reader_pumps(reader_id);
CREATE INDEX IF NOT EXISTS idx_reader_pumps_pump ON rfid_reader_pumps(pump_id);

COMMENT ON TABLE rfid_reader_pumps IS 'LEGACY junction table - use rfid_readers.pump_id for 1:1 reader-pump mapping';

-- 4. RFID Authorizations table - logs all scan attempts
CREATE TABLE IF NOT EXISTS rfid_authorizations (
    authorization_id SERIAL PRIMARY KEY,
    reader_id INTEGER REFERENCES rfid_readers(reader_id) ON DELETE SET NULL,
    attendant_id UUID REFERENCES attendants(id) ON DELETE SET NULL,
    tag_number VARCHAR(32) NOT NULL,
    pump_id INTEGER,
    authorized BOOLEAN NOT NULL,
    pts_transaction_id INTEGER,
    authorization_datetime TIMESTAMPTZ DEFAULT NOW(),
    denial_reason VARCHAR(255)
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_rfid_auth_tag ON rfid_authorizations(tag_number);
CREATE INDEX IF NOT EXISTS idx_rfid_auth_datetime ON rfid_authorizations(authorization_datetime DESC);
CREATE INDEX IF NOT EXISTS idx_rfid_auth_pump ON rfid_authorizations(pump_id);
CREATE INDEX IF NOT EXISTS idx_rfid_auth_attendant ON rfid_authorizations(attendant_id);

COMMENT ON TABLE rfid_authorizations IS 'Logs all RFID authorization attempts (granted or denied)';

-- 5. RFID Transactions table - completed fuel sales via RFID
CREATE TABLE IF NOT EXISTS rfid_transactions (
    transaction_id SERIAL PRIMARY KEY,
    authorization_id INTEGER REFERENCES rfid_authorizations(authorization_id) ON DELETE SET NULL,
    pump_id INTEGER NOT NULL,
    attendant_id UUID REFERENCES attendants(id) ON DELETE SET NULL,
    tag_number VARCHAR(32) NOT NULL,
    pts_transaction_number INTEGER,
    nozzle_number INTEGER,
    fuel_grade_id INTEGER,
    fuel_grade_name VARCHAR(50),
    volume DECIMAL(10, 3),
    price DECIMAL(10, 3),
    amount DECIMAL(10, 2),
    start_datetime TIMESTAMPTZ,
    end_datetime TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_rfid_tx_tag ON rfid_transactions(tag_number);
CREATE INDEX IF NOT EXISTS idx_rfid_tx_pump ON rfid_transactions(pump_id);
CREATE INDEX IF NOT EXISTS idx_rfid_tx_status ON rfid_transactions(status);
CREATE INDEX IF NOT EXISTS idx_rfid_tx_datetime ON rfid_transactions(created_at DESC);

COMMENT ON TABLE rfid_transactions IS 'Complete fuel dispensing transactions authorized via RFID';

-- 6. RFID Tags table — tag inventory, independent of attendants
-- Tags are registered first, then assigned to attendants.
-- Can be deactivated (lost/stolen) and reassigned (attendant fired).
CREATE TABLE IF NOT EXISTS rfid_tags (
    id SERIAL PRIMARY KEY,
    tag_number VARCHAR(32) NOT NULL,
    label VARCHAR(100),
    company_id UUID NOT NULL,
    station_id UUID NOT NULL,
    attendant_id UUID REFERENCES attendants(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    registered_at TIMESTAMPTZ DEFAULT NOW(),
    assigned_at TIMESTAMPTZ,
    deactivated_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rfid_tags_tag_station
  ON rfid_tags(UPPER(tag_number), station_id);
CREATE INDEX IF NOT EXISTS idx_rfid_tags_attendant ON rfid_tags(attendant_id);
CREATE INDEX IF NOT EXISTS idx_rfid_tags_station ON rfid_tags(station_id);
CREATE INDEX IF NOT EXISTS idx_rfid_tags_active ON rfid_tags(is_active);

COMMENT ON TABLE rfid_tags IS 'RFID tag inventory — register, assign/unassign to attendants, activate/deactivate';

-- 7. Station settings table — per-station mode (manual or rfid)
CREATE TABLE IF NOT EXISTS station_settings (
    id SERIAL PRIMARY KEY,
    station_id UUID NOT NULL UNIQUE,
    attendant_mode VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (attendant_mode IN ('manual', 'rfid')),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID
);

COMMENT ON TABLE station_settings IS 'Per-station settings including attendant mode (manual or rfid)';

-- ============================================
-- Insert test reader configuration
-- ============================================

-- Insert the reader (one reader can control multiple pumps)
INSERT INTO rfid_readers (reader_name, ip_address, port, location, is_active)
VALUES ('Main Reader', '192.168.1.12', 9761, 'Pump Island 1', true)
ON CONFLICT (ip_address, port) DO UPDATE SET
    reader_name = EXCLUDED.reader_name,
    location = EXCLUDED.location,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- Assign pumps to the reader (this reader controls pumps 1, 2, 3, 4)
INSERT INTO rfid_reader_pumps (reader_id, pump_id, is_active)
SELECT r.reader_id, p.pump_id, true
FROM rfid_readers r
CROSS JOIN (VALUES (1), (2), (3), (4)) AS p(pump_id)
WHERE r.ip_address = '192.168.1.12' AND r.port = 9761
ON CONFLICT (reader_id, pump_id) DO NOTHING;

-- ============================================
-- Enable Row Level Security (RLS) if needed
-- ============================================
-- ALTER TABLE rfid_readers ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE rfid_authorizations ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE rfid_transactions ENABLE ROW LEVEL SECURITY;

-- ============================================
-- Verification queries
-- ============================================
SELECT 'rfid_readers' as table_name, COUNT(*) as row_count FROM rfid_readers
UNION ALL
SELECT 'rfid_reader_pumps', COUNT(*) FROM rfid_reader_pumps
UNION ALL
SELECT 'rfid_authorizations', COUNT(*) FROM rfid_authorizations
UNION ALL
SELECT 'rfid_transactions', COUNT(*) FROM rfid_transactions;

-- Show reader configuration with assigned pumps
SELECT 
    r.reader_id,
    r.reader_name,
    r.ip_address,
    r.port,
    r.location,
    r.is_active,
    ARRAY_AGG(rp.pump_id ORDER BY rp.pump_id) AS pumps
FROM rfid_readers r
LEFT JOIN rfid_reader_pumps rp ON r.reader_id = rp.reader_id AND rp.is_active = true
GROUP BY r.reader_id, r.reader_name, r.ip_address, r.port, r.location, r.is_active;
