/**
 * Migration: Create price_change_log table
 * Audit trail for all fuel price changes (immediate + scheduled)
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    host: process.env.LOCAL_DB_HOST || 'localhost',
    port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
    database: process.env.LOCAL_DB_NAME || 'MAESTRO-LITE',
    user: process.env.LOCAL_DB_USER || 'postgres',
    password: process.env.LOCAL_DB_PASSWORD,
});

async function run() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS price_change_log (
                id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                fuel_grade_id   INTEGER NOT NULL,
                fuel_grade_name VARCHAR(100),
                new_price       NUMERIC(10,4) NOT NULL,
                changed_by      VARCHAR(200) DEFAULT 'system',
                change_type     VARCHAR(20) NOT NULL DEFAULT 'immediate',
                scheduled_at    VARCHAR(30),
                created_at      TIMESTAMP DEFAULT now()
            );
        `);
        console.log('✅ price_change_log table created');

        await client.query(`CREATE INDEX IF NOT EXISTS idx_price_log_fuel ON price_change_log(fuel_grade_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_price_log_created ON price_change_log(created_at);`);
        console.log('✅ Indexes created');

        console.log('\n✅ Migration complete');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
    } finally {
        client.release();
        await pool.end();
    }
}

run();
