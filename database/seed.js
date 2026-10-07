require('dotenv').config();
const { createDatabase } = require('./index');
const { ensureSeeded } = require('../service/messageCatalog');
const db = createDatabase();
ensureSeeded(db);
db.close();
console.info('Default Thai message copy is seeded.');
