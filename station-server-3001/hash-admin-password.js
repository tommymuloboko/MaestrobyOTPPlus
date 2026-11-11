const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const BCRYPT_ROUNDS = 10;
const remotePool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function updatePassword() {
  try {
    const username = 'admin@ordod';
    const plainPassword = 'admin@ordod';
    
    console.log(`\n🔐 Hashing password for user: ${username}`);
    console.log(`   Password: ${plainPassword}`);
    
    // Hash the password
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    console.log(`   Hash created: ${passwordHash.substring(0, 30)}...`);
    
    // Update in Supabase
    console.log(`\n📝 Updating password in Supabase...`);
    const result = await remotePool.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING username, email',
      [passwordHash, username]
    );
    
    if (result.rows.length === 0) {
      console.log('❌ User not found');
      process.exit(1);
    }
    
    console.log('✅ Password updated successfully');
    console.log(`   Username: ${result.rows[0].username}`);
    console.log(`   Email: ${result.rows[0].email}`);
    console.log(`\n✅ You can now login with:`);
    console.log(`   Username: ${username}`);
    console.log(`   Password: ${plainPassword}`);
    
    await remotePool.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

updatePassword();
