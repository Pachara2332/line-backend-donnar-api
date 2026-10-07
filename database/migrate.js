require('dotenv').config();
const { createDatabase } = require('./index');
const db = createDatabase();
db.close();
console.info('SQLite schema is up to date.');
