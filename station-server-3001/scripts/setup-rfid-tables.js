/**
 * Setup RFID Tables
 * Creates all required RFID tables in the local database
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_DB_PORT) || 5432,
  database: process.env.LOCAL_DB_NAME || 'MAESTRO-LITE',
  user: process.env.LOCAL_DB_USER || 'postgres',
  password: process.env.LOCAL_DB_PASSWORD
});

async function setup() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Setting up RFID tables...\n');
    
    // 1. Add tag_number column to attendants if missing
    console.log('1️⃣ Checking attendants table...');
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'attendants' AND column_name = 'tag_number'
        ) THEN
          ALTER TABLE attendants ADD COLUMN tag_number TEXT;
          CREATE INDEX IF NOT EXISTS idx_attendants_tag_number ON attendants(tag_number);
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
    `);
    console.log('   ✅ attendants columns checked\n');

    // 2. Create rfid_readers table
    console.log('2️⃣ Creating rfid_readers table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS rfid_readers (
        reader_id SERIAL PRIMARY KEY,
        company_id UUID NOT NULL,
        station_id UUID NOT NULL,
        reader_name VARCHAR(50) NOT NULL,
        ip_address VARCHAR(15) NOT NULL,
        port INTEGER NOT NULL DEFAULT 9761,
        location VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ip_address, port)
      );
      CREATE INDEX IF NOT EXISTS idx_rfid_readers_station ON rfid_readers(station_id);
      CREATE INDEX IF NOT EXISTS idx_rfid_readers_company ON rfid_readers(company_id);
    `);
    console.log('   ✅ rfid_readers created\n');

    // 3. Create rfid_reader_pumps junction table
    console.log('3️⃣ Creating rfid_reader_pumps table...');
    await client.query(`
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
    `);
    console.log('   ✅ rfid_reader_pumps created\n');

    // 4. Create rfid_authorizations table
    console.log('4️⃣ Creating rfid_authorizations table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS rfid_authorizations (
        authorization_id SERIAL PRIMARY KEY,
        reader_id INTEGER REFERENCES rfid_readers(reader_id) ON DELETE SET NULL,
        attendant_id UUID,
        tag_number VARCHAR(32) NOT NULL,
        pump_id INTEGER,
        authorized BOOLEAN NOT NULL,
        pts_transaction_id INTEGER,
        authorization_datetime TIMESTAMPTZ DEFAULT NOW(),
        denial_reason VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_rfid_auth_tag ON rfid_authorizations(tag_number);
      CREATE INDEX IF NOT EXISTS idx_rfid_auth_datetime ON rfid_authorizations(authorization_datetime DESC);
      CREATE INDEX IF NOT EXISTS idx_rfid_auth_pump ON rfid_authorizations(pump_id);
    `);
    console.log('   ✅ rfid_authorizations created\n');

    // 5. Create rfid_transactions table
    console.log('5️⃣ Creating rfid_transactions table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS rfid_transactions (
        transaction_id SERIAL PRIMARY KEY,
        authorization_id INTEGER REFERENCES rfid_authorizations(authorization_id) ON DELETE SET NULL,
        pump_id INTEGER NOT NULL,
        attendant_id UUID,
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
      CREATE INDEX IF NOT EXISTS idx_rfid_tx_tag ON rfid_transactions(tag_number);
      CREATE INDEX IF NOT EXISTS idx_rfid_tx_pump ON rfid_transactions(pump_id);
      CREATE INDEX IF NOT EXISTS idx_rfid_tx_status ON rfid_transactions(status);
      CREATE INDEX IF NOT EXISTS idx_rfid_tx_datetime ON rfid_transactions(created_at DESC);
    `);
    console.log('   ✅ rfid_transactions created\n');

    console.log('═'.repeat(50));
    console.log('✅ All RFID tables created successfully!');
    console.log('═'.repeat(50));
    console.log('\nNext steps:');
    console.log('1. Add an RFID reader: POST /api/rfid/readers');
    console.log('2. Assign pumps to reader: POST /api/rfid/readers/:id/pumps');
    console.log('3. Add tag_number to attendants');
    console.log('4. Set PUMP_SIMULATOR_MODE=false to enable real PTS authorization');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

setup().catch(err => {
  console.error(err);
  process.exit(1);
});
