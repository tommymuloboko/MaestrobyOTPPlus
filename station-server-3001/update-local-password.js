const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const BCRYPT_ROUNDS = 10;

// Try to connect to local DB with explicit parameters
const localPool = new Pool({
  host: process.env.LOCAL_DB_HOST,
  port: parseInt(process.env.LOCAL_DB_PORT),
  database: process.env.LOCAL_DB_NAME,
  user: process.env.LOCAL_DB_USER,
  password: process.env.LOCAL_DB_PASSWORD,
});

async function updateLocalPassword() {
  try {
    const username = 'admin@ordod';
    const plainPassword = 'admin@ordod';
    
    console.log(`\n🔐 Updating password in LOCAL PostgreSQL...`);
    console.log(`   Host: ${process.env.LOCAL_DB_HOST}:${process.env.LOCAL_DB_PORT}`);
    console.log(`   Database: ${process.env.LOCAL_DB_NAME}`);
    console.log(`   User: ${username}`);
    
    // Hash the password
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    
    // Update in local DB
    const result = await localPool.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING username, email',
      [passwordHash, username]
    );
    
    if (result.rows.length === 0) {
      console.log('❌ User not found in local database');
      console.log('   This might be OK if the user hasn\'t synced yet');
      process.exit(1);
    }
    
    console.log('✅ Password updated successfully in local DB');
    console.log(`   Username: ${result.rows[0].username}`);
    console.log(`   Email: ${result.rows[0].email}`);
    
    await localPool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('\nTip: Make sure PostgreSQL is running and the password is correct');
    process.exit(1);
  }
}

updateLocalPassword();
