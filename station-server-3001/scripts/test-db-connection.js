/**
 * Database Connection Diagnostic
 * Tests local PostgreSQL and Supabase connections
 */

require('dotenv').config();
const { Pool } = require('pg');

const logger = (name) => ({
  info: (msg, data) => console.log(`[${name}] ℹ️  ${msg}`, data || ''),
  error: (msg, data) => console.error(`[${name}] ❌ ${msg}`, data?.message || data || ''),
  warn: (msg, data) => console.warn(`[${name}] ⚠️  ${msg}`, data?.message || data || ''),
});

const log = logger('Diagnostic');

async function testLocalDB() {
  log.info('🔍 Testing Local PostgreSQL Connection...');
  log.info('Configuration:');
  log.info(`  Host: ${process.env.LOCAL_DB_HOST || 'localhost'}`);
  log.info(`  Port: ${process.env.LOCAL_DB_PORT || '5432'}`);
  log.info(`  Database: ${process.env.LOCAL_DB_NAME || 'MAESTRO-LITE'}`);
  log.info(`  User: ${process.env.LOCAL_DB_USER || 'postgres'}`);
  log.info(`  Password: ${process.env.LOCAL_DB_PASSWORD ? '***SET***' : '❌ NOT SET'}`);

  const localPool = new Pool({
    host: process.env.LOCAL_DB_HOST || 'localhost',
    port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
    database: process.env.LOCAL_DB_NAME || 'MAESTRO-LITE',
    user: process.env.LOCAL_DB_USER || 'postgres',
    password: process.env.LOCAL_DB_PASSWORD || 'postgres',
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await localPool.query('SELECT 1 as test');
    log.info('✅ Local PostgreSQL Connection SUCCESSFUL');
    
    // Test if pts_sales table exists
    const tableCheck = await localPool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'pts_sales'
      ) as exists;
    `);
    
    if (tableCheck.rows[0].exists) {
      log.info('✅ pts_sales table exists');
      
      const countResult = await localPool.query('SELECT COUNT(*) as count FROM pts_sales');
      log.info(`📊 pts_sales records: ${countResult.rows[0].count}`);
    } else {
      log.warn('⚠️  pts_sales table does NOT exist');
      log.info('   Run: node scripts/create-pts-sales-table.js');
    }
    
    await localPool.end();
    return true;
  } catch (error) {
    log.error('❌ Local PostgreSQL Connection FAILED:', error);
    log.info('\n💡 Solutions:');
    log.info('  1. Check if PostgreSQL is running:');
    log.info('     Get-Service postgresql-x64-18');
    log.info('  2. Check if password is correct in .env:');
    log.info('     LOCAL_DB_PASSWORD=your_password');
    log.info('  3. Check if database exists:');
    log.info('     & "C:\\Program Files\\PostgreSQL\\18\\bin\\psql" -h localhost -U postgres -l');
    log.info('  4. Verify port (default 5432):');
    log.info('     netstat -ano | findstr :5432');
    
    try {
      await localPool.end();
    } catch (e) {}
    return false;
  }
}

async function testSupabase() {
  log.info('\n🔍 Testing Supabase Connection...');
  
  if (!process.env.DATABASE_URL) {
    log.warn('⚠️  DATABASE_URL not set in .env');
    return false;
  }

  log.info(`  URL: ${process.env.DATABASE_URL.substring(0, 50)}...`);

  const remotePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  try {
    const result = await remotePool.query('SELECT 1 as test');
    log.info('✅ Supabase Connection SUCCESSFUL');
    
    // Test if pts_sales table exists
    const tableCheck = await remotePool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'pts_sales'
      ) as exists;
    `);
    
    if (tableCheck.rows[0].exists) {
      log.info('✅ pts_sales table exists in Supabase');
      
      const countResult = await remotePool.query('SELECT COUNT(*) as count FROM pts_sales');
      log.info(`📊 pts_sales records in Supabase: ${countResult.rows[0].count}`);
    } else {
      log.warn('⚠️  pts_sales table does NOT exist in Supabase');
    }
    
    await remotePool.end();
    return true;
  } catch (error) {
    log.error('❌ Supabase Connection FAILED:', error);
    await remotePool.end();
    return false;
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║    MAESTRO-LITE Database Connection Diagnostic             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const localOk = await testLocalDB();
  const supabaseOk = await testSupabase();

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                      SUMMARY                               ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Local PostgreSQL:  ${localOk ? '✅ CONNECTED' : '❌ FAILED'}`);
  console.log(`Supabase:          ${supabaseOk ? '✅ CONNECTED' : '❌ FAILED'}`);
  
  if (!localOk) {
    console.log('\n⚠️  CRITICAL: Local PostgreSQL is not available!');
    console.log('The application will not work without local PostgreSQL in LOCAL mode.');
    process.exit(1);
  }

  if (!supabaseOk) {
    console.log('\n⚠️  WARNING: Supabase is not available.');
    console.log('Data will be synced to Supabase once it\'s available.');
  }

  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
