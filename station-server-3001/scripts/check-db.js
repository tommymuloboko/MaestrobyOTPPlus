require('dotenv').config();
const db = require('../utils/db');

async function checkDatabase() {
  try {
    console.log('Connecting to Supabase...\n');

    // Get all tables
    const tables = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    console.log('Tables in database:');
    tables.rows.forEach(r => console.log('  -', r.table_name));

    // Get users table columns
    const usersCols = await db.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      ORDER BY ordinal_position
    `);
    console.log('\n=== USERS table columns ===');
    usersCols.rows.forEach(r => {
      const nullable = r.is_nullable === 'NO' ? 'NOT NULL' : 'nullable';
      console.log(`  ${r.column_name}: ${r.data_type} (${nullable})`);
    });

    // Count users
    const userCount = await db.query('SELECT COUNT(*) as count FROM users');
    console.log('\nTotal users:', userCount.rows[0].count);

    // Sample users (without password)
    const sampleUsers = await db.query(`
      SELECT id, company_id, station_id, username, full_name, email, is_active, created_at 
      FROM users 
      LIMIT 10
    `);
    console.log('\nExisting users:');
    if (sampleUsers.rows.length === 0) {
      console.log('  (no users found)');
    } else {
      sampleUsers.rows.forEach(u => {
        console.log(`  - ${u.username} | ${u.full_name || 'N/A'} | active: ${u.is_active}`);
      });
    }

    // Get companies
    const companies = await db.query('SELECT id, name FROM companies LIMIT 5');
    console.log('\nCompanies:');
    if (companies.rows.length === 0) {
      console.log('  (no companies found)');
    } else {
      companies.rows.forEach(c => {
        console.log(`  - ${c.id}: ${c.name}`);
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    process.exit(0);
  }
}

checkDatabase();
