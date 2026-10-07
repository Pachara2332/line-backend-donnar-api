const { DEFAULT_COPY } = require('../service/messageCatalog');

async function seedDefaultCopy(client) {
  for (const [key, body] of Object.entries(DEFAULT_COPY)) {
    await client.query(`INSERT INTO message_revisions(message_key, revision, body, status, published_at)
      VALUES ($1, 1, $2, 'PUBLISHED', CURRENT_TIMESTAMP)
      ON CONFLICT (message_key, revision) DO NOTHING`, [key, body]);
  }
}

module.exports = { seedDefaultCopy };

if (require.main === module) {
  require('dotenv').config();
  const { createDatabase, migrateDatabase, withTransaction } = require('./index');
  (async () => {
    const pool = createDatabase();
    try {
      await migrateDatabase(pool);
      await withTransaction(pool, seedDefaultCopy);
      console.info('Default Thai message copy is seeded.');
    } finally { await pool.end(); }
  })().catch(() => {
    console.error('Database seeding failed. Check DATABASE_URL and database availability.');
    process.exitCode = 1;
  });
}
