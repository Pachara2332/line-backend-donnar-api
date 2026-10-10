const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { randomBytes, scryptSync } = require('node:crypto');
const { buildApp } = require('../app');
const { createTestDatabase } = require('./helpers/database');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');
const { bahtText, computeTotals, formatMoney, isValidThaiTaxId, parseQuotationForm, addDays, bangkokToday } = require('../service/quotations');

const SELLER = { name: 'บริษัท ดอนนาร์ เทค จำกัด', taxId: '0105567000013', branchCode: '', address: 'กรุงเทพมหานคร', phone: '', email: '', website: '', bankAccount: '', vatRegistered: true };

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

async function setup({ seller = SELLER } = {}) {
  const { pool: db, close } = await createTestDatabase();
  await db.query('INSERT INTO staff_users(username, password_hash) VALUES ($1, $2)', ['operator', passwordHash('correct horse battery staple')]);
  await db.query("INSERT INTO line_users(line_user_id, display_name) VALUES ('U-buyer', 'Somsri')");
  await db.query("INSERT INTO conversations(line_user_id) VALUES ('U-buyer')");
  await db.query(`INSERT INTO leads(conversation_id, status, requirements_json) VALUES (1, 'QUALIFIED', '{"serviceType":"Web app"}'::jsonb)`);
  const lineClient = new FakeLineMessagingClient();
  const config = { lineChannelSecret: 'secret', lineAccessToken: '', fakeLineMode: true, publicBaseUrl: 'https://crm.example.test', seller };
  const app = buildApp({ db, lineClient, config });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  return { db, app, close, lineClient, cookie, csrf };
}

const DRAFT_FORM = {
  title: 'เว็บแอปจัดการคลังสินค้า',
  buyer_company: 'บริษัท สยามโลจิสติกส์ จำกัด',
  buyer_tax_id: '0105556000017',
  buyer_branch_type: 'HQ',
  buyer_address: '123 ถนนพระราม 9 กรุงเทพมหานคร',
  item_description: ['ออกแบบ UX/UI', 'พัฒนาระบบหลังบ้าน', ''],
  item_quantity: ['1', '1.5', ''],
  item_unit: ['งาน', 'เดือน', ''],
  item_unit_price: ['45,000', '80000.50', ''],
  discount: '5000',
  withholding: 'on',
  valid_days: '30',
  payment_terms: 'ชำระ 50% เมื่อยืนยัน',
  notes: '',
};

async function createDraft(context) {
  const created = await request(context.app).post('/admin/conversations/1/quotations').set('cookie', context.cookie).type('form').send({ _csrf: context.csrf });
  assert.equal(created.status, 303);
  return Number(created.headers.location.match(/\/admin\/quotations\/(\d+)/)[1]);
}

async function sendQuotation(context, id, form = DRAFT_FORM) {
  return request(context.app).post(`/admin/quotations/${id}/send`).set('cookie', context.cookie).type('form').send({ ...form, _csrf: context.csrf });
}

test('formats baht amounts and Thai baht text', () => {
  assert.equal(formatMoney(123456789), '1,234,567.89');
  assert.equal(formatMoney(-1000000), '-10,000.00');
  assert.equal(bahtText(10700000), 'หนึ่งแสนเจ็ดพันบาทถ้วน');
  assert.equal(bahtText(2100), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(bahtText(10100), 'หนึ่งร้อยเอ็ดบาทถ้วน');
  assert.equal(bahtText(100000100), 'หนึ่งล้านเอ็ดบาทถ้วน');
  assert.equal(bahtText(150), 'หนึ่งบาทห้าสิบสตางค์');
  assert.equal(bahtText(0), 'ศูนย์บาทถ้วน');
});

test('calculates VAT on the discounted base and withholding before VAT, rounding half up once', () => {
  const totals = computeTotals([{ quantityHundredths: 150, unitPriceSatang: 3333 }, { quantityHundredths: 100, unitPriceSatang: 100000 }], 1001, 700, 300);
  assert.deepEqual(totals, { subtotal: 105000, base: 103999, vat: 7280, total: 111279, withholding: 3120, net: 108159 });
  assert.equal(computeTotals([{ quantityHundredths: 100, unitPriceSatang: 1000000 }], 0, 0, 0).total, 1000000);
});

test('validates Thai tax IDs with the checksum digit', () => {
  assert.equal(isValidThaiTaxId('0105556000017'), true);
  assert.equal(isValidThaiTaxId('0105556000018'), false);
  assert.equal(isValidThaiTaxId('010555600001'), false);
});

test('parses the editor form, skipping blank rows and rejecting invalid values', () => {
  const ok = parseQuotationForm(DRAFT_FORM);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.items.length, 2);
  assert.equal(ok.values.items[1].quantityHundredths, 150);
  assert.equal(ok.values.items[1].unitPriceSatang, 8000050);
  assert.equal(ok.values.withholdingRateBp, 300);

  const bad = parseQuotationForm({ ...DRAFT_FORM, buyer_tax_id: '1234567890123', buyer_branch_type: 'BRANCH', buyer_branch_code: '12', item_quantity: ['0', '-1', ''], item_unit_price: ['abc', '1.234', ''], discount: '999999999', valid_days: '0', buyer_email: 'nope' });
  assert.ok(bad.errors.some((error) => error.includes('เลขประจำตัวผู้เสียภาษี')));
  assert.ok(bad.errors.some((error) => error.includes('รหัสสาขา')));
  assert.ok(bad.errors.some((error) => error.includes('รายการที่ 1: จำนวน')));
  assert.ok(bad.errors.some((error) => error.includes('รายการที่ 2: ราคาต่อหน่วย')));
  assert.ok(bad.errors.some((error) => error.includes('ระยะยืนราคา')));
  assert.ok(bad.errors.some((error) => error.includes('อีเมล')));
  assert.ok(parseQuotationForm({ ...DRAFT_FORM, discount: '1000000' }).errors.some((error) => error.includes('ส่วนลด')));
  assert.deepEqual(parseQuotationForm({}).values.items, []);
});

test('staff routes require a session and CSRF token', async (t) => {
  const context = await setup();
  t.after(context.close);
  assert.equal((await request(context.app).get('/admin/quotations')).status, 303);
  assert.equal((await request(context.app).post('/admin/conversations/1/quotations').set('cookie', context.cookie).type('form').send({ _csrf: 'wrong' })).status, 403);
  assert.equal((await request(context.app).post('/admin/conversations/99/quotations').set('cookie', context.cookie).type('form').send({ _csrf: context.csrf })).status, 404);
});

test('creates numbered drafts, saves server-calculated totals, and rejects invalid input', async (t) => {
  const context = await setup();
  t.after(context.close);
  const id = await createDraft(context);
  const second = await createDraft(context);
  const { rows: numbers } = await context.db.query('SELECT number, title, vat_rate_bp FROM quotations ORDER BY id');
  const year = bangkokToday().slice(0, 4);
  assert.deepEqual(numbers.map((row) => row.number), [`QT-${year}-0001`, `QT-${year}-0002`]);
  assert.equal(numbers[0].title, 'Web app');
  assert.equal(numbers[0].vat_rate_bp, 700);
  assert.ok(second > id);

  const editor = await request(context.app).get(`/admin/quotations/${id}`).set('cookie', context.cookie);
  assert.equal(editor.status, 200);
  assert.match(editor.text, /quotation-editor\.js/);

  const invalid = await request(context.app).post(`/admin/quotations/${id}`).set('cookie', context.cookie).type('form').send({ ...DRAFT_FORM, buyer_tax_id: '1111111111111', _csrf: context.csrf });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /เลขประจำตัวผู้เสียภาษีของลูกค้าไม่ถูกต้อง/);
  assert.match(invalid.text, /value="1111111111111"/);

  const saved = await request(context.app).post(`/admin/quotations/${id}`).set('cookie', context.cookie).type('form').send({ ...DRAFT_FORM, subtotal_satang: '1', total_satang: '1', _csrf: context.csrf });
  assert.equal(saved.status, 303);
  const { rows } = await context.db.query('SELECT subtotal_satang, vat_satang, total_satang, withholding_satang FROM quotations WHERE id = $1', [id]);
  assert.deepEqual(rows[0], { subtotal_satang: 16500075, vat_satang: 1120005, total_satang: 17120080, withholding_satang: 480002 });
  const { rows: items } = await context.db.query('SELECT position, quantity_hundredths, amount_satang FROM quotation_items WHERE quotation_id = $1 ORDER BY position', [id]);
  assert.deepEqual(items.map((item) => [item.position, Number(item.quantity_hundredths), Number(item.amount_satang)]), [[1, 100, 4500000], [2, 150, 12000075]]);

  const pdf = await request(context.app).get(`/admin/quotations/${id}/pdf`).set('cookie', context.cookie).buffer(true).parse((res, callback) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks))); });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');

  const deleted = await request(context.app).post(`/admin/quotations/${second}/delete`).set('cookie', context.cookie).type('form').send({ _csrf: context.csrf });
  assert.equal(deleted.status, 303);
  assert.equal((await context.db.query('SELECT id FROM quotations WHERE id = $1', [second])).rowCount, 0);
});

test('requires seller details before sending a quotation', async (t) => {
  const context = await setup({ seller: { ...SELLER, name: '', taxId: '' } });
  t.after(context.close);
  const id = await createDraft(context);
  const response = await sendQuotation(context, id);
  assert.equal(response.status, 409);
  assert.match(response.text, /SELLER_NAME/);
  assert.equal((await context.db.query('SELECT status FROM quotations WHERE id = $1', [id])).rows[0].status, 'DRAFT');
  assert.equal(context.lineClient.sent.length, 0);
});

test('refuses to send an empty quotation', async (t) => {
  const context = await setup();
  t.after(context.close);
  const id = await createDraft(context);
  const response = await sendQuotation(context, id, { ...DRAFT_FORM, item_description: '', item_quantity: '', item_unit: '', item_unit_price: '', discount: '' });
  assert.equal(response.status, 400);
  assert.match(response.text, /เพิ่มรายการอย่างน้อย 1 รายการ/);
  assert.equal(context.lineClient.sent.length, 0);
});

test('sends a frozen quotation to LINE and lets the customer accept it once', async (t) => {
  const context = await setup();
  t.after(context.close);
  const id = await createDraft(context);
  const sent = await sendQuotation(context, id);
  assert.equal(sent.status, 303);
  assert.match(sent.headers.location, /flash=sent/);

  const { rows } = await context.db.query('SELECT status, public_token, issue_date, valid_until, seller_json FROM quotations WHERE id = $1', [id]);
  const quotation = rows[0];
  assert.equal(quotation.status, 'SENT');
  assert.match(quotation.public_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(quotation.issue_date, bangkokToday());
  assert.equal(quotation.valid_until, addDays(bangkokToday(), 30));
  assert.equal(quotation.seller_json.name, SELLER.name);

  const push = context.lineClient.sent.find((item) => item.kind === 'push');
  assert.equal(push.userId, 'U-buyer');
  assert.equal(push.messages[0].type, 'flex');
  assert.ok(JSON.stringify(push.messages[0]).includes(`https://crm.example.test/q/${quotation.public_token}`));
  const { rows: outbound } = await context.db.query("SELECT message_type, send_status FROM messages WHERE conversation_id = 1 AND direction = 'OUT'");
  assert.deepEqual(outbound, [{ message_type: 'flex', send_status: 'SENT' }]);

  const locked = await request(context.app).post(`/admin/quotations/${id}`).set('cookie', context.cookie).type('form').send({ ...DRAFT_FORM, title: 'changed', _csrf: context.csrf });
  assert.equal(locked.status, 303);
  assert.equal((await context.db.query('SELECT title FROM quotations WHERE id = $1', [id])).rows[0].title, DRAFT_FORM.title);

  const publicPage = await request(context.app).get(`/q/${quotation.public_token}`);
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.headers['cache-control'], 'no-store');
  assert.match(publicPage.headers['x-robots-tag'], /noindex/);
  assert.match(publicPage.text, /171,200\.80/);
  assert.match(publicPage.text, /ยอมรับใบเสนอราคา/);
  assert.doesNotMatch(publicPage.text, /U-buyer/);
  const publicPdf = await request(context.app).get(`/q/${quotation.public_token}/pdf`);
  assert.equal(publicPdf.status, 200);
  assert.equal(publicPdf.headers['content-type'], 'application/pdf');

  const missingAgreement = await request(context.app).post(`/q/${quotation.public_token}/accept`).type('form').send({ name: 'สมศรี ใจดี' });
  assert.equal(missingAgreement.status, 400);
  assert.equal((await context.db.query('SELECT status FROM quotations WHERE id = $1', [id])).rows[0].status, 'SENT');

  const accepted = await request(context.app).post(`/q/${quotation.public_token}/accept`).type('form').send({ name: 'สมศรี ใจดี', agree: 'on' });
  assert.equal(accepted.status, 303);
  const rejectedLater = await request(context.app).post(`/q/${quotation.public_token}/reject`).type('form').send({ reason: 'changed mind' });
  assert.equal(rejectedLater.status, 303);
  const { rows: decided } = await context.db.query('SELECT status, decision_name, decision_reason, decided_at FROM quotations WHERE id = $1', [id]);
  assert.equal(decided[0].status, 'ACCEPTED');
  assert.equal(decided[0].decision_name, 'สมศรี ใจดี');
  assert.equal(decided[0].decision_reason, null);
  assert.ok(decided[0].decided_at);
  assert.match((await request(context.app).get(`/q/${quotation.public_token}`)).text, /ยืนยันใบเสนอราคาแล้ว/);

  const crm = await request(context.app).get('/admin').set('cookie', context.cookie);
  assert.match(crm.text, /ลูกค้าตอบกลับใบเสนอราคา/);
  const read = await request(context.app).post(`/admin/quotations/${id}/decision/read`).set('cookie', context.cookie).type('form').send({ _csrf: context.csrf });
  assert.equal(read.status, 303);
  assert.doesNotMatch((await request(context.app).get('/admin').set('cookie', context.cookie)).text, /ลูกค้าตอบกลับใบเสนอราคา/);
  assert.equal((await request(context.app).post(`/admin/quotations/${id}/revise`).set('cookie', context.cookie).type('form').send({ _csrf: context.csrf })).status, 409);
});

test('a revision supersedes the previous link and refuses decisions on it', async (t) => {
  const context = await setup();
  t.after(context.close);
  const id = await createDraft(context);
  await sendQuotation(context, id);
  const original = (await context.db.query('SELECT public_token FROM quotations WHERE id = $1', [id])).rows[0].public_token;

  const revised = await request(context.app).post(`/admin/quotations/${id}/revise`).set('cookie', context.cookie).type('form').send({ _csrf: context.csrf });
  assert.equal(revised.status, 303);
  const revisionId = Number(revised.headers.location.match(/(\d+)$/)[1]);
  const again = await request(context.app).post(`/admin/quotations/${id}/revise`).set('cookie', context.cookie).type('form').send({ _csrf: context.csrf });
  assert.equal(again.headers.location, `/admin/quotations/${revisionId}`);
  assert.equal((await context.db.query('SELECT COUNT(*)::integer AS count FROM quotation_items WHERE quotation_id = $1', [revisionId])).rows[0].count, 2);

  assert.equal((await sendQuotation(context, revisionId, { ...DRAFT_FORM, discount: '0' })).status, 303);
  const { rows } = await context.db.query('SELECT id, number, revision, status FROM quotations ORDER BY id');
  assert.deepEqual(rows.map((row) => [Number(row.id), row.revision, row.status]), [[id, 0, 'SUPERSEDED'], [revisionId, 1, 'SENT']]);
  assert.equal(rows[0].number, rows[1].number);

  const oldPage = await request(context.app).get(`/q/${original}`);
  assert.match(oldPage.text, /ถูกแทนที่ด้วยฉบับใหม่แล้ว/);
  assert.doesNotMatch(oldPage.text, /action="\/q\/[^"]+\/accept"/);
  await request(context.app).post(`/q/${original}/accept`).type('form').send({ name: 'x', agree: 'on' });
  assert.equal((await context.db.query('SELECT status FROM quotations WHERE id = $1', [id])).rows[0].status, 'SUPERSEDED');
});

test('expired and cancelled quotations refuse decisions', async (t) => {
  const context = await setup();
  t.after(context.close);
  const id = await createDraft(context);
  await sendQuotation(context, id);
  const token = (await context.db.query('SELECT public_token FROM quotations WHERE id = $1', [id])).rows[0].public_token;
  await context.db.query("UPDATE quotations SET valid_until = '2000-01-01' WHERE id = $1", [id]);
  assert.match((await request(context.app).get(`/q/${token}`)).text, /หมดอายุแล้ว/);
  await request(context.app).post(`/q/${token}/accept`).type('form').send({ name: 'x', agree: 'on' });
  assert.equal((await context.db.query('SELECT status FROM quotations WHERE id = $1', [id])).rows[0].status, 'SENT');

  const cancelled = await request(context.app).post(`/admin/quotations/${id}/cancel`).set('cookie', context.cookie).type('form').send({ _csrf: context.csrf });
  assert.equal(cancelled.status, 303);
  assert.match((await request(context.app).get(`/q/${token}`)).text, /ถูกยกเลิกแล้ว/);
});

test('unknown or malformed public tokens return 404 without detail', async (t) => {
  const context = await setup();
  t.after(context.close);
  assert.equal((await request(context.app).get('/q/not-a-token')).status, 404);
  assert.equal((await request(context.app).get(`/q/${randomBytes(32).toString('base64url')}`)).status, 404);
  assert.equal((await request(context.app).post(`/q/${randomBytes(32).toString('base64url')}/accept`).type('form').send({ name: 'x', agree: 'on' })).status, 404);
});

test('keeps the quotation sent and reports failure when the LINE card cannot be delivered', async (t) => {
  const context = await setup();
  t.after(context.close);
  context.lineClient.push = async () => { const error = new Error('blocked'); error.status = 403; throw error; };
  const id = await createDraft(context);
  const response = await sendQuotation(context, id);
  assert.match(response.headers.location, /flash=push-failed/);
  assert.equal((await context.db.query('SELECT status FROM quotations WHERE id = $1', [id])).rows[0].status, 'SENT');
  assert.deepEqual((await context.db.query("SELECT send_status, last_error FROM messages WHERE direction = 'OUT'")).rows, [{ send_status: 'UNKNOWN', last_error: 'line_http_403' }]);
  const view = await request(context.app).get(`/admin/quotations/${id}?flash=push-failed`).set('cookie', context.cookie);
  assert.match(view.text, /ส่งการ์ดใน LINE ไม่สำเร็จ/);
  assert.match(view.text, /https:\/\/crm\.example\.test\/q\//);
});

test('accepts large Thai quotation forms beyond the default admin body limit', async (t) => {
  const context = await setup();
  t.after(context.close);
  const id = await createDraft(context);
  const description = 'พัฒนาระบบจัดการคลังสินค้า'.repeat(70);
  const response = await request(context.app).post(`/admin/quotations/${id}`).set('cookie', context.cookie).type('form').send({ ...DRAFT_FORM, item_description: Array(6).fill(description), item_quantity: Array(6).fill('1'), item_unit: Array(6).fill('งาน'), item_unit_price: Array(6).fill('1000'), discount: '', _csrf: context.csrf });
  assert.equal(response.status, 303);
  assert.equal((await context.db.query('SELECT COUNT(*)::integer AS count FROM quotation_items WHERE quotation_id = $1', [id])).rows[0].count, 6);
});
