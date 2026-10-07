const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildRichMenu, validateRichMenuImage } = require('../app');
const request = require('supertest');
const { randomBytes, scryptSync } = require('node:crypto');
const { createDatabase } = require('../database');
const { buildApp } = require('../app');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

test('accepts only a valid 1200 by 405 PNG image no larger than LINE allows', () => {
  const image = fs.readFileSync(require('node:path').join(__dirname, '..', 'assets/line-rich-menu-1200x405.png'));
  assert.equal(validateRichMenuImage(image), true);
  assert.equal(validateRichMenuImage(Buffer.from('not a png')), false);
});

test('creates exactly three real actions and does not send local-only fields to LINE', () => {
  const menu = buildRichMenu();
  assert.equal(menu.areas.length, 3);
  assert.deepEqual(menu.areas.map((area) => new URLSearchParams(area.action.data).get('action')), ['START_QUALIFY', 'SERVICES', 'HUMAN']);
  assert.equal(Object.hasOwn(menu, 'baseUrl'), false);
});

test('publishes through the fake adapter and requires explicit confirmation to replace a published menu', async () => {
  const db = createDatabase(':memory:');
  db.prepare('INSERT INTO staff_users(username, password_hash) VALUES (?, ?)').run('operator', passwordHash('correct horse battery staple'));
  const lineClient = new FakeLineMessagingClient();
  const app = buildApp({ db, lineClient, config: { lineChannelSecret: 'secret', lineAccessToken: '', fakeLineMode: true, staffUsername: 'operator', publicBaseUrl: 'http://localhost', richMenuImagePath: require('node:path').join(__dirname, '..', 'assets/line-rich-menu-1200x405.png') } });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const publish = () => request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf });

  assert.equal((await publish()).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.equal(lineClient.defaultMenuId, 'richmenu-test-1');
  assert.equal(db.prepare("SELECT status FROM rich_menu_publications WHERE id = 1").get().status, 'PUBLISHED');
  assert.equal((await publish()).status, 409);
  assert.equal(lineClient.menus.length, 1);
  const confirmation = await publish();
  const currentId = confirmation.text.match(/name="replace_current_id" value="(\d+)"/)[1];
  const replace = await request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf, replace: '1', replace_current_id: currentId });
  assert.equal(replace.status, 303);
  assert.equal(lineClient.menus.length, 2);
  assert.equal((await request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf, replace: '1', replace_current_id: currentId })).status, 409);
  assert.equal(lineClient.menus.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rich_menu_publications WHERE status = 'PUBLISHED'").get().count, 1);
  db.close();
});

test('resumes a failed publication with its saved LINE menu ID instead of creating a duplicate', async () => {
  const db = createDatabase(':memory:');
  db.prepare('INSERT INTO staff_users(username, password_hash) VALUES (?, ?)').run('operator', passwordHash('correct horse battery staple'));
  const lineClient = new FakeLineMessagingClient();
  let failOnce = true;
  const setDefault = lineClient.setDefaultRichMenu.bind(lineClient);
  lineClient.setDefaultRichMenu = async (menuId) => {
    if (failOnce) { failOnce = false; throw new Error('temporary fake outage'); }
    return setDefault(menuId);
  };
  const app = buildApp({ db, lineClient, config: { lineChannelSecret: 'secret', lineAccessToken: '', fakeLineMode: true, staffUsername: 'operator', publicBaseUrl: 'http://localhost', richMenuImagePath: require('node:path').join(__dirname, '..', 'assets/line-rich-menu-1200x405.png') } });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const publish = () => request(app).post('/admin/rich-menu/publish').set('cookie', cookie).type('form').send({ _csrf: csrf });

  assert.equal((await publish()).status, 500);
  const saved = db.prepare('SELECT line_menu_id, status, image_uploaded FROM rich_menu_publications').get();
  assert.equal(saved.status, 'FAILED');
  assert.equal(saved.image_uploaded, 1);
  assert.equal((await publish()).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.equal(lineClient.defaultMenuId, saved.line_menu_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rich_menu_publications WHERE status = 'PUBLISHED'").get().count, 1);
  db.close();
});

test('recovers interrupted publication state on database restart', () => {
  const filename = require('node:path').join(require('node:os').tmpdir(), `donnar-recovery-${require('node:crypto').randomUUID()}.sqlite`);
  let db = createDatabase(filename);
  db.prepare("INSERT INTO rich_menu_publications(status) VALUES ('CREATING')").run();
  db.close();
  db = createDatabase(filename);
  assert.equal(db.prepare('SELECT status FROM rich_menu_publications').get().status, 'FAILED');
  db.close();
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(filename + suffix); } catch {} }
});
