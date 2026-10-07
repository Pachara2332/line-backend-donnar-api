require('dotenv').config();
const { createDatabase, migrateDatabase } = require('./index');

async function main() {
  const db = createDatabase();
  try {
    await migrateDatabase(db);
    console.info('PostgreSQL schema is up to date.');
  } finally { await db.end(); }
}

main().catch(() => {
  console.error('Database migration failed. Check DATABASE_URL and database availability.');
  process.exitCode = 1;
});
