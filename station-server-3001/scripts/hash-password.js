require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../utils/db');

async function hashPassword() {
  try {
    const password = '1234';
    const hash = await bcrypt.hash(password, 10);
    console.log('Generated bcrypt hash:', hash);

    const result = await db.query(
      'UPDATE users SET password_hash = $1 WHERE username = $2 RETURNING username',
      [hash, 'admin']
    );

    if (result.rows.length > 0) {
      console.log('✅ Password updated for user:', result.rows[0].username);
    } else {
      console.log('❌ No user found with username: admin');
    }

    // Verify it works
    const user = await db.query('SELECT password_hash FROM users WHERE username = $1', ['admin']);
    const verified = await bcrypt.compare(password, user.rows[0].password_hash);
    console.log('✅ Password verification:', verified ? 'SUCCESS' : 'FAILED');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    process.exit(0);
  }
}

hashPassword();
