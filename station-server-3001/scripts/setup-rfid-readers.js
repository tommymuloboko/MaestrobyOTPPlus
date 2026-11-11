/**
 * Setup RFID Readers - Reader-to-Nozzle-Pumps Mapping
 * 
 * Each reader is on a physical pump that has multiple nozzles.
 * Each nozzle = a "pump" in PTS numbering.
 * pump_ids[] lists all nozzle-pumps a reader covers.
 * 
 * Example (2 physical pumps, 3 nozzles each):
 *   Reader .200 → Pumps [1,2,3]   (physical pump 1, nozzles 1-3)
 *   Reader .201 → Pumps [4,5,6]   (physical pump 2, nozzles 4-6)
 * 
 * RFID is for tracking only — no PTS authorization is sent.
 * 
 * Usage:
 *   node scripts/setup-rfid-readers.js
 * 
 * Configuration:
 *   Edit BASE_IP, READER_PORT, READERS below to match your station.
 */

require('dotenv').config();
const db = require('../utils/db');

// ============================================
// CONFIGURATION - Edit these for your station
// ============================================

const BASE_IP = '192.168.1';       // Subnet for readers
const START_OCTET = 200;           // First reader IP = BASE_IP.200
const READER_PORT = 8080;          // Default port for all readers
const DEVICE_ADDRESS = 0x00;       // IS8540 station ID (0x00 for standalone)
const NOZZLES_PER_PUMP = 3;        // Number of nozzles per physical pump
const PHYSICAL_PUMP_COUNT = 4;     // Number of physical pumps (and readers)

// ============================================

async function setupReaders() {
  const companyId = process.env.OFFLINE_COMPANY_ID;
  const stationId = process.env.OFFLINE_STATION_ID;

  if (!companyId || !stationId) {
    console.error('❌ OFFLINE_COMPANY_ID and OFFLINE_STATION_ID must be set in .env');
    process.exit(1);
  }

  console.log('===========================================');
  console.log('  RFID Reader Setup (Nozzle-Pump Mapping)');
  console.log('===========================================');
  console.log(`  Station:       ${stationId}`);
  console.log(`  Company:       ${companyId}`);
  console.log(`  Subnet:        ${BASE_IP}.x`);
  console.log(`  Port:          ${READER_PORT}`);
  console.log(`  Physical Pumps: ${PHYSICAL_PUMP_COUNT}`);
  console.log(`  Nozzles/Pump:  ${NOZZLES_PER_PUMP}`);
  console.log('===========================================\n');

  try {
    // Ensure pump_ids column exists on rfid_readers
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'rfid_readers' AND column_name = 'pump_ids'
        ) THEN
          ALTER TABLE rfid_readers ADD COLUMN pump_ids INTEGER[] DEFAULT '{}';
          CREATE INDEX IF NOT EXISTS idx_rfid_readers_pump_ids ON rfid_readers USING GIN(pump_ids);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'rfid_readers' AND column_name = 'device_address'
        ) THEN
          ALTER TABLE rfid_readers ADD COLUMN device_address SMALLINT NOT NULL DEFAULT 0;
        END IF;
      END $$;
    `);

    for (let i = 0; i < PHYSICAL_PUMP_COUNT; i++) {
      const readerNum = i + 1;
      const ipAddress = `${BASE_IP}.${START_OCTET + i}`;
      const readerName = `Pump ${readerNum} Reader`;
      const location = `Physical Pump ${readerNum}`;

      // Calculate which PTS pump numbers (nozzles) this reader covers
      const firstNozzle = (i * NOZZLES_PER_PUMP) + 1;
      const pumpIds = [];
      for (let n = 0; n < NOZZLES_PER_PUMP; n++) {
        pumpIds.push(firstNozzle + n);
      }

      const result = await db.query(`
        INSERT INTO rfid_readers (company_id, station_id, reader_name, ip_address, port, device_address, pump_ids, location)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (ip_address, port) DO UPDATE SET
          reader_name = EXCLUDED.reader_name,
          device_address = EXCLUDED.device_address,
          pump_ids = EXCLUDED.pump_ids,
          location = EXCLUDED.location,
          is_active = true,
          updated_at = NOW()
        RETURNING reader_id, reader_name, ip_address, port, device_address, pump_ids
      `, [companyId, stationId, readerName, ipAddress, READER_PORT, DEVICE_ADDRESS, pumpIds, location]);

      const reader = result.rows[0];
      console.log(`  ✅ ${reader.reader_name}: ${reader.ip_address}:${reader.port} → Pumps [${reader.pump_ids.join(',')}]`);
    }

    // Show final state
    console.log('\n--- Current Reader Configuration ---\n');
    const all = await db.query(`
      SELECT reader_id, reader_name, ip_address, port, device_address, pump_ids, is_active, location
      FROM rfid_readers
      ORDER BY reader_id
    `);

    console.table(all.rows.map(r => ({
      ID: r.reader_id,
      Name: r.reader_name,
      IP: `${r.ip_address}:${r.port}`,
      DevAddr: `0x${(r.device_address || 0).toString(16).padStart(2, '0').toUpperCase()}`,
      Pumps: (r.pump_ids || []).join(','),
      Active: r.is_active ? '✅' : '❌',
      Location: r.location
    })));

    console.log('\n✅ Setup complete! Restart the service or call POST /api/rfid/reload');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
  } finally {
    await db.end();
  }
}

setupReaders();
