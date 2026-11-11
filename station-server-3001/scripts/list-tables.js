/**
 * List all tables in the local PostgreSQL database.
 * Usage: node scripts/list-tables.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
  database: process.env.LOCAL_DB_NAME || 'MAESTRO-LITE',
  user: process.env.LOCAL_DB_USER || 'postgres',
  password: process.env.LOCAL_DB_PASSWORD,
});

async function listTables() {
  try {
    const result = await pool.query(`
      SELECT table_name,
             pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) AS size,
             (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.table_schema = 'public') AS columns,
             (xpath('/row/cnt/text()', xml_count))[1]::text::int AS row_count
      FROM information_schema.tables t
      CROSS JOIN LATERAL (
        SELECT query_to_xml(format('SELECT count(*) AS cnt FROM %I', t.table_name), false, true, '') AS xml_count
      ) x
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    console.log('\n=== LOCAL DATABASE TABLES ===\n');
    console.log(
      'No.'.padEnd(5) +
      'Table Name'.padEnd(35) +
      'Rows'.padStart(8) +
      'Columns'.padStart(10) +
      'Size'.padStart(12)
    );
    console.log('-'.repeat(70));

    result.rows.forEach((row, i) => {
      console.log(
        String(i + 1).padEnd(5) +
        row.table_name.padEnd(35) +
        String(row.row_count).padStart(8) +
        String(row.columns).padStart(10) +
        row.size.padStart(12)
      );
    });

    console.log('-'.repeat(70));
    console.log(`Total: ${result.rows.length} tables\n`);
  } catch (error) {
    console.error('Error listing tables:', error.message);
  } finally {
    await pool.end();
  }
}

listTables();
