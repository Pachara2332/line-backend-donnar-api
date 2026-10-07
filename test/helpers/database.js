const { newDb } = require('pg-mem');
const { migrateDatabase } = require('../../database');

async function createTestDatabase({ migrate = true } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  if (migrate) await migrateDatabase(pool);
  return { pool, close: () => pool.end() };
}

module.exports = { createTestDatabase };
