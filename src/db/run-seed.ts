import 'dotenv/config';
import { seed } from './seed';
import { pool } from './index';

(async () => {
  try {
    console.log('⏳ Seeding database with mock data...');
    await seed();
    console.log('✅ Seeding done!');
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
