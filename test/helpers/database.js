const { newDb } = require('pg-mem');
const { initializeDatabase } = require('../../database');

async function createTestDatabase({ migrate = true, config = {} } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  if (migrate) await initializeDatabase(pool, config);
  return { pool, close: () => pool.end() };
}

module.exports = { createTestDatabase };
