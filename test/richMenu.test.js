const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { buildRichMenu, validateRichMenuImage, buildApp } = require('../app');
const { createTestDatabase } = require('./helpers/database');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');

const assetPath = path.join(__dirname, '..', 'assets/line-rich-menu-2500x1686.png');
const config = { lineChannelSecret: 'secret', lineAccessToken: '', fakeLineMode: true, staffUsername: 'operator', publicBaseUrl: 'http://localhost', richMenuImagePath: assetPath };

async function setup(t) {
  const { pool: db, close } = await createTestDatabase();
  const { randomBytes, scryptSync } = require('node:crypto');
  const salt = randomBytes(16).toString('hex');
  const hash = `scrypt$${salt}$${scryptSync('correct horse battery staple', salt, 64).toString('hex')}`;
  await db.query('INSERT INTO staff_users(username, password_hash) VALUES ($1, $2)', ['operator', hash]);
  t.after(close);
  const lineClient = new FakeLineMessagingClient();
  const app = buildApp({ db, lineClient, config });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const publish = () => request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf });
  return { db, lineClient, app, cookie, csrf, publish };
}

test('accepts only the taller 2500 by 1686 PNG image within LINE limits', () => {
  const image = fs.readFileSync(assetPath);
  assert.equal(validateRichMenuImage(image), true);
  assert.equal(image.readUInt32BE(16), 2500);
  assert.equal(image.readUInt32BE(20), 1686);
  assert.ok(image.length <= 1024 * 1024);
  assert.equal(validateRichMenuImage(Buffer.from('not a png')), false);
});

test('creates three full-width stacked actions at the same coordinates as the image', () => {
  const menu = buildRichMenu();
  assert.deepEqual(menu.size, { width: 2500, height: 1686 });
  assert.equal(menu.areas.length, 3);
  assert.deepEqual(menu.areas.map(({ bounds }) => [bounds.x, bounds.y, bounds.width, bounds.height]), [
    [0, 0, 2500, 562],
    [0, 562, 2500, 562],
    [0, 1124, 2500, 562],
  ]);
  assert.deepEqual(menu.areas.map((area) => new URLSearchParams(area.action.data).get('action')), ['START_QUALIFY', 'SERVICES', 'HUMAN']);
  assert.equal(Object.hasOwn(menu, 'baseUrl'), false);
});

test('publishes through the fake adapter and requires explicit confirmation to replace a published menu', async (t) => {
  const { db, lineClient, app, publish, cookie, csrf } = await setup(t);
  assert.equal((await publish()).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.equal(lineClient.defaultMenuId, 'richmenu-test-1');
  assert.equal((await db.query("SELECT status FROM rich_menu_publications WHERE id = 1")).rows[0].status, 'PUBLISHED');
  const duplicatePublish = await publish();
  assert.equal(duplicatePublish.status, 409, duplicatePublish.text);
  assert.equal(lineClient.menus.length, 1);
  const confirmation = await publish();
  const currentId = confirmation.text.match(/name="replace_current_id" value="(\d+)"/)[1];
  const post = await request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf, replace: '1', replace_current_id: currentId });
  assert.equal(post.status, 303);
  assert.equal(lineClient.menus.length, 2);
  assert.equal((await request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf, replace: '1', replace_current_id: currentId })).status, 409);
  assert.equal(lineClient.menus.length, 2);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows.filter((row) => row.status === 'PUBLISHED').length, 1);
});

test('resumes a failed publication with its saved LINE menu ID instead of creating a duplicate', async (t) => {
  const { db, lineClient, publish } = await setup(t);
  let failOnce = true;
  const setDefault = lineClient.setDefaultRichMenu.bind(lineClient);
  lineClient.setDefaultRichMenu = async (menuId) => {
    if (failOnce) { failOnce = false; throw new Error('temporary fake outage'); }
    return setDefault(menuId);
  };
  assert.equal((await publish()).status, 500);
  const saved = (await db.query('SELECT line_menu_id, status, image_uploaded FROM rich_menu_publications')).rows[0];
  assert.equal(saved.status, 'FAILED');
  assert.equal(saved.image_uploaded, true);
  assert.equal((await publish()).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.equal(lineClient.defaultMenuId, saved.line_menu_id);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows.filter((row) => row.status === 'PUBLISHED').length, 1);
});

test('allows only one Rich Menu create when two staff publish requests race', async (t) => {
  const { db, lineClient, app, cookie, csrf } = await setup(t);
  const query = db.query.bind(db);
  let creatingReads = 0;
  let releaseReads;
  const bothReadsComplete = new Promise((resolve) => { releaseReads = resolve; });
  db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (String(sql).includes("SELECT id FROM rich_menu_publications WHERE status = 'CREATING'")) {
      creatingReads += 1;
      if (creatingReads === 2) releaseReads();
      await bothReadsComplete;
    }
    return result;
  };
  const publish = () => request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf });

  const responses = await Promise.all([publish(), publish()]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [303, 409]);
  assert.equal(lineClient.menus.length, 1);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows.filter((row) => ['PUBLISHED', 'CREATING'].includes(row.status)).length, 1);
});

test('recovers interrupted publication state on database restart', async (t) => {
  const { pool: db, close } = await createTestDatabase();
  t.after(close);
  await db.query("INSERT INTO rich_menu_publications(status) VALUES ('CREATING')");
  const { initializeDatabase } = require('../database');
  await initializeDatabase(db);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows[0].status, 'FAILED');
});
