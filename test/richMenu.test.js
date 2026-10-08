const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { buildRichMenu, validateRichMenuImage, buildApp } = require('../app');
const { createTestDatabase } = require('./helpers/database');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');

const assetPath = path.join(__dirname, '..', 'assets/line-rich-menu-2500x1686.jpg');
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
  const publish = (publicationId, csrfToken = csrf, session = cookie) => request(app).post('/admin/rich-menu/publish').set('cookie', session).type('form').send({ _csrf: csrfToken, publication_id: publicationId });
  const upload = (image = fs.readFileSync(assetPath), contentType = 'image/jpeg') => request(app).post('/admin/rich-menu/draft').set('cookie', cookie).field('_csrf', csrf).attach('image', image, { filename: `menu.${contentType === 'image/png' ? 'png' : 'jpg'}`, contentType });
  const getDraftId = async () => (await db.query("SELECT id FROM rich_menu_publications WHERE status = 'DRAFT'")).rows[0]?.id;
  return { db, lineClient, app, cookie, csrf, publish, upload, getDraftId };
}

test('accepts the taller 2500 by 1686 JPEG image within LINE limits', () => {
  const image = fs.readFileSync(assetPath);
  assert.equal(validateRichMenuImage(image), true);
  assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(image.length <= 1024 * 1024);
  assert.equal(validateRichMenuImage(Buffer.from('not an image')), false);
});

test('uploads a valid image as a durable draft without calling LINE publication APIs', async (t) => {
  const { db, lineClient, app, cookie, csrf } = await setup(t);
  const image = fs.readFileSync(assetPath);
  const response = await request(app).post('/admin/rich-menu/draft').set('cookie', cookie).field('_csrf', csrf).attach('image', image, { filename: 'menu.jpg', contentType: 'image/jpeg' });
  assert.equal(response.status, 303, response.text);
  const draft = (await db.query("SELECT status, image_data, image_content_type FROM rich_menu_publications WHERE status = 'DRAFT'")).rows[0];
  assert.equal(draft.status, 'DRAFT');
  assert.deepEqual(draft.image_data, image);
  assert.equal(draft.image_content_type, 'image/jpeg');
  const png = fs.readFileSync(path.join(__dirname, '..', 'assets/line-rich-menu-2500x1686.png'));
  const pngResponse = await request(app).post('/admin/rich-menu/draft').set('cookie', cookie).field('_csrf', csrf).attach('image', png, { filename: 'menu.png', contentType: 'image/png' });
  assert.equal(pngResponse.status, 303, pngResponse.text);
  const replacedDraft = (await db.query("SELECT status, image_data, image_content_type FROM rich_menu_publications WHERE status = 'DRAFT'")).rows;
  assert.equal(replacedDraft.length, 1);
  assert.deepEqual(replacedDraft[0].image_data, png);
  assert.equal(replacedDraft[0].image_content_type, 'image/png');
  assert.equal(lineClient.menus.length, 0);
  assert.equal(lineClient.defaultMenuId, undefined);
});

test('rejects unsupported, malformed, mismatched, oversized, and wrong-size uploads without replacing the draft', async (t) => {
  const { db, app, cookie, csrf } = await setup(t);
  const valid = fs.readFileSync(assetPath);
  const upload = (buffer, contentType = 'image/jpeg') => request(app).post('/admin/rich-menu/draft').set('cookie', cookie).field('_csrf', csrf).attach('image', buffer, { filename: 'menu-upload', contentType });
  assert.equal((await upload(valid)).status, 303);
  const before = (await db.query("SELECT id, image_data FROM rich_menu_publications WHERE status = 'DRAFT'")).rows[0];
  const wrongDimensions = Buffer.from(valid);
  const startOfFrame = wrongDimensions.indexOf(Buffer.from([0xff, 0xc2]));
  assert.notEqual(startOfFrame, -1);
  wrongDimensions.writeUInt16BE(2499, startOfFrame + 7);
  for (const [buffer, type] of [
    [Buffer.from('not an image'), 'image/jpeg'],
    [valid, 'image/png'],
    [Buffer.alloc(1024 * 1024 + 1), 'image/jpeg'],
    [Buffer.from(valid.subarray(0, 40)), 'image/jpeg'],
    [wrongDimensions, 'image/jpeg'],
  ]) assert.equal((await upload(buffer, type)).status, 400);
  const after = (await db.query("SELECT id, image_data FROM rich_menu_publications WHERE status = 'DRAFT'")).rows[0];
  assert.equal(after.id, before.id);
  assert.deepEqual(after.image_data, before.image_data);
});

test('requires staff authentication and CSRF, and serves only authenticated uncached draft previews', async (t) => {
  const { db, app, cookie, csrf } = await setup(t);
  const image = fs.readFileSync(assetPath);
  const unauthenticated = await request(app).post('/admin/rich-menu/draft').type('form').send({ _csrf: csrf });
  assert.equal(unauthenticated.status, 303);
  const noCsrf = await request(app).post('/admin/rich-menu/draft').set('cookie', cookie).attach('image', image, { filename: 'menu.jpg', contentType: 'image/jpeg' });
  assert.equal(noCsrf.status, 403);
  const uploaded = await request(app).post('/admin/rich-menu/draft').set('cookie', cookie).field('_csrf', csrf).attach('image', image, { filename: 'menu.jpg', contentType: 'image/jpeg' });
  assert.equal(uploaded.status, 303);
  const draft = (await db.query("SELECT id FROM rich_menu_publications WHERE status = 'DRAFT'")).rows[0];
  const preview = await request(app).get(`/admin/rich-menu/image/${draft.id}`).set('cookie', cookie);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers['content-type'], 'image/jpeg');
  assert.equal(preview.headers['cache-control'], 'no-store');
  assert.equal(preview.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(preview.body, image);
  assert.equal((await request(app).get(`/admin/rich-menu/image/${draft.id}`)).status, 303);
});

test('cancels only the pending draft and leaves the published menu unchanged', async (t) => {
  const { db, app, cookie, csrf } = await setup(t);
  await db.query("INSERT INTO rich_menu_publications(line_menu_id, status) VALUES ('richmenu-live', 'PUBLISHED')");
  const image = fs.readFileSync(assetPath);
  const uploaded = await request(app).post('/admin/rich-menu/draft').set('cookie', cookie).field('_csrf', csrf).attach('image', image, { filename: 'menu.jpg', contentType: 'image/jpeg' });
  assert.equal(uploaded.status, 303);
  const draft = (await db.query("SELECT id FROM rich_menu_publications WHERE status = 'DRAFT'")).rows[0];
  const cancelled = await request(app).post(`/admin/rich-menu/draft/${draft.id}/cancel`).set('cookie', cookie).type('form').send({ _csrf: csrf });
  assert.equal(cancelled.status, 303);
  assert.equal((await db.query("SELECT status FROM rich_menu_publications ORDER BY id")).rows.map((row) => row.status).join(','), 'PUBLISHED');
});

test('creates three full-width stacked message actions at the same coordinates as the image', () => {
  const menu = buildRichMenu();
  assert.deepEqual(menu.size, { width: 2500, height: 1686 });
  assert.equal(menu.areas.length, 3);
  assert.deepEqual(menu.areas.map(({ bounds }) => [bounds.x, bounds.y, bounds.width, bounds.height]), [
    [0, 0, 2500, 562],
    [0, 562, 2500, 562],
    [0, 1124, 2500, 562],
  ]);
  assert.deepEqual(menu.areas.map((area) => area.action.type), ['message', 'message', 'message']);
  assert.deepEqual(menu.areas.map((area) => area.action.text), ['เริ่มปรึกษาโปรเจกต์', 'ขอดูบริการ', 'คุยกับคน']);
  assert.equal(Object.hasOwn(menu, 'baseUrl'), false);
});

test('shows the tall branded image in the staff preview', async (t) => {
  const { app, cookie, csrf } = await setup(t);
  const response = await request(app).post('/admin/rich-menu/preview').set('cookie', cookie).type('form').send({ _csrf: csrf });
  assert.equal(response.status, 200);
  assert.match(response.text, /\/assets\/line-rich-menu-2500x1686\.jpg/);
  const image = await request(app).get('/assets/line-rich-menu-2500x1686.jpg');
  assert.equal(image.status, 200);
  assert.deepEqual([...image.body.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test('publishes through the fake adapter and requires explicit confirmation to replace a published menu', async (t) => {
  const { db, lineClient, app, publish, upload, getDraftId, cookie, csrf } = await setup(t);
  const image = fs.readFileSync(assetPath);
  await db.query("INSERT INTO rich_menu_publications(line_menu_id, status, image_data, image_content_type) VALUES ('richmenu-previous', 'PUBLISHED', $1, 'image/jpeg')", [image]);
  assert.equal((await upload()).status, 303);
  const draftId = await getDraftId();
  assert.ok(draftId);
  const admin = await request(app).get('/admin').set('cookie', cookie);
  assert.match(admin.text, /ยืนยันเปลี่ยน Rich Menu/);
  assert.match(admin.text, new RegExp(`/admin/rich-menu/image/${draftId}`));
  assert.equal(lineClient.menus.length, 0);
  assert.equal((await publish(draftId, 'invalid-csrf')).status, 403);
  assert.equal((await request(app).post('/admin/rich-menu/publish').type('form').send({ _csrf: csrf, publication_id: draftId })).status, 303);
  assert.equal(lineClient.menus.length, 0);
  assert.equal((await publish(draftId)).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.equal(lineClient.defaultMenuId, 'richmenu-test-1');
  assert.deepEqual(lineClient.uploaded.image, image);
  assert.equal(lineClient.uploaded.contentType, 'image/jpeg');
  assert.deepEqual(lineClient.menus[0].menu.areas.map((area) => area.action.text), ['เริ่มปรึกษาโปรเจกต์', 'ขอดูบริการ', 'คุยกับคน']);
  const publications = (await db.query('SELECT id, status, image_data FROM rich_menu_publications ORDER BY id')).rows;
  assert.deepEqual(publications.map((row) => row.status), ['REPLACED', 'PUBLISHED']);
  assert.equal(publications[0].image_data, null);
  assert.deepEqual(publications[1].image_data, image);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'rich_menu.published'")).rows[0].count), 1);
  const duplicatePublish = await publish(draftId);
  assert.equal(duplicatePublish.status, 409, duplicatePublish.text);
  assert.equal(lineClient.menus.length, 1);
});

test('resumes a failed publication with its saved LINE menu ID instead of creating a duplicate', async (t) => {
  const { db, lineClient, publish, upload, getDraftId } = await setup(t);
  await db.query("INSERT INTO rich_menu_publications(line_menu_id, status) VALUES ('richmenu-previous', 'PUBLISHED')");
  await upload();
  const draftId = await getDraftId();
  let failOnce = true;
  const setDefault = lineClient.setDefaultRichMenu.bind(lineClient);
  lineClient.setDefaultRichMenu = async (menuId) => {
    if (failOnce) { failOnce = false; throw new Error('temporary fake outage'); }
    return setDefault(menuId);
  };
  assert.equal((await publish(draftId)).status, 500);
  const saved = (await db.query('SELECT line_menu_id, status, image_uploaded FROM rich_menu_publications WHERE id = $1', [draftId])).rows[0];
  assert.equal(saved.status, 'FAILED');
  assert.equal(saved.image_uploaded, true);
  assert.equal((await db.query("SELECT status FROM rich_menu_publications WHERE line_menu_id = 'richmenu-previous'")).rows[0].status, 'PUBLISHED');
  assert.equal((await publish(draftId)).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.equal(lineClient.defaultMenuId, saved.line_menu_id);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows.filter((row) => row.status === 'PUBLISHED').length, 1);
});

test('allows only one Rich Menu create when two staff publish requests race', async (t) => {
  const { db, lineClient, app, cookie, csrf, upload, getDraftId, publish } = await setup(t);
  await upload();
  const draftId = await getDraftId();
  const query = db.query.bind(db);
  let creatingReads = 0;
  let releaseReads;
  const bothReadsComplete = new Promise((resolve) => { releaseReads = resolve; });
  db.query = async (sql, params) => {
    const result = await query(sql, params);
    if (String(sql).includes("UPDATE rich_menu_publications SET status = 'CREATING'")) {
      creatingReads += 1;
      if (creatingReads === 2) releaseReads();
      await bothReadsComplete;
    }
    return result;
  };
  const responses = await Promise.all([publish(draftId), publish(draftId)]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [303, 409]);
  assert.equal(lineClient.menus.length, 1);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows.filter((row) => ['PUBLISHED', 'CREATING'].includes(row.status)).length, 1);
});

test('reconciles a LINE-accepted default switch on retry using the same Rich Menu ID', async (t) => {
  const { db, lineClient, publish, upload, getDraftId } = await setup(t);
  await upload();
  const draftId = await getDraftId();
  const connect = db.connect.bind(db);
  let failReconcileOnce = true;
  db.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      if (failReconcileOnce && String(sql).includes("UPDATE rich_menu_publications SET status = 'PUBLISHED'")) {
        failReconcileOnce = false;
        throw new Error('temporary local database failure');
      }
      return query(sql, params);
    };
    return client;
  };
  assert.equal((await publish(draftId)).status, 500);
  const failedId = (await db.query('SELECT line_menu_id FROM rich_menu_publications WHERE id = $1', [draftId])).rows[0].line_menu_id;
  assert.equal(lineClient.defaultMenuId, failedId);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications WHERE id = $1', [draftId])).rows[0].status, 'FAILED');
  assert.equal((await publish(draftId)).status, 303);
  assert.equal(lineClient.menus.length, 1);
  assert.deepEqual(lineClient.menus[0].id, failedId);
  assert.equal(lineClient.defaultMenuId, failedId);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications WHERE id = $1', [draftId])).rows[0].status, 'PUBLISHED');
});

test('recovers interrupted publication state on database restart', async (t) => {
  const { pool: db, close } = await createTestDatabase();
  t.after(close);
  await db.query("INSERT INTO rich_menu_publications(status) VALUES ('CREATING')");
  const { initializeDatabase } = require('../database');
  await initializeDatabase(db);
  assert.equal((await db.query('SELECT status FROM rich_menu_publications')).rows[0].status, 'FAILED');
});
