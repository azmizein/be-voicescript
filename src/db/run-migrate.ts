import 'dotenv/config';
import { migrate } from './migrate';
import { pool } from './index';

(async () => {
  try {
    console.log('⏳ Running database migrations...');
    await migrate();
    console.log('✅ Migration done!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
