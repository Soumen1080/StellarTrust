// Test database connection and schema
import('pg').then(async ({ default: pg }) => {
  const dotenv = await import('dotenv');
  dotenv.config();

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('Testing database connection...');
    
    // Test basic connection
    const result = await pool.query('SELECT NOW()');
    console.log('✓ Database connected successfully at:', result.rows[0].now);
    
    // Check tables
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    console.log('\n✓ Tables found:', tables.rows.map(r => r.table_name).join(', '));
    
    // Check system accounts
    const accounts = await pool.query(`
      SELECT DISTINCT name, currency
      FROM ledger_accounts 
      WHERE owner_ref = 'system'
      ORDER BY name, currency
    `);
    console.log('\n✓ System accounts:', accounts.rowCount);
    
    // Check orders table structure
    const orderColumns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'orders'
      ORDER BY ordinal_position
    `);
    console.log('\n✓ Orders table columns:');
    orderColumns.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
    });
    
    // Check escrows table structure
    const escrowColumns = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'escrows'
      ORDER BY ordinal_position
    `);
    console.log('\n✓ Escrows table columns:');
    escrowColumns.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type} (nullable: ${col.is_nullable})`);
    });
    
    console.log('\n✓ Database check completed successfully!');
  } catch (error) {
    console.error('\n✗ Database error:', error.message);
    if (error.code) console.error('  Error code:', error.code);
    process.exit(1);
  } finally {
    await pool.end();
  }
}).catch(err => {
  console.error('Failed to load modules:', err);
  process.exit(1);
});
