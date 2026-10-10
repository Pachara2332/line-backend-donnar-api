const { randomBytes } = require('node:crypto');
const { withTransaction } = require('../database');

const MAX_ITEMS = 50;
const MAX_UNIT_PRICE_SATANG = 1_000_000_000;
const MAX_QUANTITY_HUNDREDTHS = 1_000_000;
const DEFAULT_VALID_DAYS = 30;
const DEFAULT_WITHHOLDING_BP = 300;
const VAT_BP = 700;
const DEFAULT_PAYMENT_TERMS = 'ชำระ 50% เมื่อยืนยันใบเสนอราคา และชำระส่วนที่เหลือ 50% เมื่อส่งมอบงาน';
const STATUS_LABELS = { DRAFT: 'ฉบับร่าง', SENT: 'รอลูกค้าตอบรับ', ACCEPTED: 'ลูกค้ายอมรับแล้ว', REJECTED: 'ลูกค้าปฏิเสธ', EXPIRED: 'หมดอายุ', SUPERSEDED: 'ถูกแทนที่ด้วยฉบับใหม่', CANCELLED: 'ยกเลิกแล้ว' };
const DIGITS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

function parseDecimal(value, scale) {
  const text = String(value ?? '').replace(/[,\s]/g, '');
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * scale + Number(fraction.padEnd(2, '0'));
}

function parseMoney(value) { return parseDecimal(value, 100); }

function lineAmount(quantityHundredths, unitPriceSatang) {
  return Math.floor((quantityHundredths * unitPriceSatang + 50) / 100);
}

function applyRate(amount, rateBp) {
  return Math.floor((amount * rateBp + 5000) / 10000);
}

function computeTotals(items, discountSatang, vatRateBp, withholdingRateBp) {
  const subtotal = items.reduce((sum, item) => sum + lineAmount(item.quantityHundredths, item.unitPriceSatang), 0);
  const base = subtotal - discountSatang;
  const vat = applyRate(base, vatRateBp);
  const withholding = applyRate(base, withholdingRateBp);
  return { subtotal, base, vat, total: base + vat, withholding, net: base + vat - withholding };
}

function formatMoney(satang) {
  const value = Number(satang);
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  const whole = Math.floor(absolute / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(absolute % 100).padStart(2, '0')}`;
}

function formatQuantity(hundredths) {
  const value = Number(hundredths);
  const whole = Math.floor(value / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = value % 100;
  return fraction ? `${whole}.${String(fraction).padStart(2, '0').replace(/0$/, '')}` : whole;
}

function readInteger(value, hasHigher = false) {
  if (value >= 1_000_000) {
    const low = value % 1_000_000;
    return `${readInteger(Math.floor(value / 1_000_000), hasHigher)}ล้าน${low ? readInteger(low, true) : ''}`;
  }
  const digits = String(value).split('').reverse().map(Number);
  let text = '';
  for (let place = digits.length - 1; place >= 0; place--) {
    const digit = digits[place];
    if (!digit) continue;
    if (place === 1 && digit === 1) text += 'สิบ';
    else if (place === 1 && digit === 2) text += 'ยี่สิบ';
    else if (place === 0 && digit === 1 && (value > 9 || hasHigher)) text += 'เอ็ด';
    else text += DIGITS[digit] + PLACES[place];
  }
  return text;
}

function bahtText(satang) {
  const value = Math.round(Number(satang));
  if (!Number.isSafeInteger(value) || value < 0) return '';
  const baht = Math.floor(value / 100);
  const fraction = value % 100;
  if (!baht && !fraction) return 'ศูนย์บาทถ้วน';
  return `${baht ? `${readInteger(baht)}บาท` : ''}${fraction ? `${readInteger(fraction)}สตางค์` : 'ถ้วน'}`;
}

function isValidThaiTaxId(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const sum = value.slice(0, 12).split('').reduce((total, digit, index) => total + Number(digit) * (13 - index), 0);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

function formatTaxId(value) {
  const digits = String(value || '');
  return /^\d{13}$/.test(digits) ? `${digits[0]}-${digits.slice(1, 5)}-${digits.slice(5, 10)}-${digits.slice(10, 12)}-${digits[12]}` : digits;
}

function branchLabel(buyer) {
  return buyer.branchType === 'BRANCH' && buyer.branchCode ? `สาขาที่ ${buyer.branchCode}` : 'สำนักงานใหญ่';
}

function bangkokToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatThaiDate(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return '';
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${isoDate}T00:00:00Z`));
}

function formatThaiDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(date);
}

function quotationLabel(quotation) {
  return Number(quotation.revision) ? `${quotation.number}-R${quotation.revision}` : quotation.number;
}

function effectiveStatus(quotation, today = bangkokToday()) {
  return quotation.status === 'SENT' && quotation.valid_until && quotation.valid_until < today ? 'EXPIRED' : quotation.status;
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max + 1);
}

function parseQuotationForm(body = {}) {
  const errors = [];
  const buyer = {
    companyName: text(body.buyer_company, 200),
    taxId: String(body.buyer_tax_id ?? '').replace(/[\s-]/g, ''),
    branchType: body.buyer_branch_type === 'BRANCH' ? 'BRANCH' : 'HQ',
    branchCode: String(body.buyer_branch_code ?? '').trim(),
    address: text(body.buyer_address, 500),
    contactName: text(body.buyer_contact, 120),
    phone: text(body.buyer_phone, 40),
    email: text(body.buyer_email, 200),
  };
  if (buyer.companyName.length > 200) errors.push('ชื่อบริษัทลูกค้ายาวเกิน 200 ตัวอักษร');
  if (buyer.taxId && !isValidThaiTaxId(buyer.taxId)) errors.push('เลขประจำตัวผู้เสียภาษีของลูกค้าไม่ถูกต้อง (ต้องเป็นตัวเลข 13 หลักที่ถูกต้อง)');
  if (buyer.branchType === 'BRANCH' && !/^\d{5}$/.test(buyer.branchCode)) errors.push('รหัสสาขาต้องเป็นตัวเลข 5 หลัก เช่น 00001');
  if (buyer.branchType === 'HQ') buyer.branchCode = '';
  if (buyer.address.length > 500) errors.push('ที่อยู่ลูกค้ายาวเกิน 500 ตัวอักษร');
  if (buyer.contactName.length > 120) errors.push('ชื่อผู้ติดต่อยาวเกิน 120 ตัวอักษร');
  if (buyer.phone.length > 40) errors.push('เบอร์โทรยาวเกิน 40 ตัวอักษร');
  if (buyer.email && (buyer.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email))) errors.push('อีเมลลูกค้าไม่ถูกต้อง');

  const title = text(body.title, 200);
  if (title.length > 200) errors.push('ชื่อโครงการยาวเกิน 200 ตัวอักษร');

  const descriptions = toArray(body.item_description);
  const quantities = toArray(body.item_quantity);
  const units = toArray(body.item_unit);
  const prices = toArray(body.item_unit_price);
  const rowCount = Math.max(descriptions.length, quantities.length, units.length, prices.length);
  const items = [];
  for (let index = 0; index < rowCount; index++) {
    const description = text(descriptions[index], 2000);
    const quantityText = String(quantities[index] ?? '').trim();
    const unit = text(units[index], 30);
    const priceText = String(prices[index] ?? '').trim();
    if (!description && !priceText && (!quantityText || quantityText === '1') && !unit) continue;
    const row = items.length + 1;
    const quantityHundredths = parseDecimal(quantityText || '1', 100);
    const unitPriceSatang = parseMoney(priceText);
    if (!description) errors.push(`รายการที่ ${row}: กรอกรายละเอียดงาน`);
    if (description.length > 2000) errors.push(`รายการที่ ${row}: รายละเอียดยาวเกิน 2,000 ตัวอักษร`);
    if (unit.length > 30) errors.push(`รายการที่ ${row}: หน่วยยาวเกิน 30 ตัวอักษร`);
    if (quantityHundredths === null || quantityHundredths <= 0 || quantityHundredths > MAX_QUANTITY_HUNDREDTHS) errors.push(`รายการที่ ${row}: จำนวนต้องมากกว่า 0 ไม่เกิน 10,000 และทศนิยมไม่เกิน 2 ตำแหน่ง`);
    if (unitPriceSatang === null || unitPriceSatang > MAX_UNIT_PRICE_SATANG) errors.push(`รายการที่ ${row}: ราคาต่อหน่วยต้องเป็นตัวเลข 0 ถึง 10,000,000 บาท ทศนิยมไม่เกิน 2 ตำแหน่ง`);
    items.push({ description, quantityHundredths: quantityHundredths ?? 0, unit, unitPriceSatang: unitPriceSatang ?? 0, quantityText, priceText });
  }
  if (items.length > MAX_ITEMS) errors.push(`ใส่รายการได้ไม่เกิน ${MAX_ITEMS} รายการ`);

  const discountText = String(body.discount ?? '').trim();
  const discountSatang = discountText ? parseMoney(discountText) : 0;
  if (discountSatang === null) errors.push('ส่วนลดต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง');
  const validDaysText = String(body.valid_days ?? '').trim();
  const validDays = validDaysText ? Number(validDaysText) : DEFAULT_VALID_DAYS;
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) errors.push('ระยะยืนราคาต้องเป็นจำนวนวัน 1 ถึง 365');
  const paymentTerms = text(body.payment_terms, 2000);
  const notes = text(body.notes, 2000);
  if (paymentTerms.length > 2000) errors.push('เงื่อนไขการชำระเงินยาวเกิน 2,000 ตัวอักษร');
  if (notes.length > 2000) errors.push('หมายเหตุยาวเกิน 2,000 ตัวอักษร');
  const withholdingRateBp = body.withholding === 'on' ? DEFAULT_WITHHOLDING_BP : 0;

  const subtotal = items.reduce((sum, item) => sum + lineAmount(item.quantityHundredths, item.unitPriceSatang), 0);
  if (discountSatang !== null && discountSatang > subtotal) errors.push('ส่วนลดต้องไม่มากกว่ายอดรวมรายการ');

  return { errors, values: { title, buyer, items, discountSatang: discountSatang ?? 0, validDays: Number.isInteger(validDays) ? validDays : DEFAULT_VALID_DAYS, paymentTerms, notes, withholdingRateBp } };
}

function issueErrors(quotation, items) {
  const errors = [];
  if (!quotation.buyer_json?.companyName) errors.push('กรอกชื่อบริษัทหรือชื่อลูกค้าก่อนส่ง');
  if (!items.length) errors.push('เพิ่มรายการอย่างน้อย 1 รายการก่อนส่ง');
  if (Number(quotation.total_satang) <= 0) errors.push('ยอดรวมต้องมากกว่า 0 บาทก่อนส่ง');
  return errors;
}

function normalizeQuotation(row) {
  if (!row) return null;
  const numeric = ['id', 'conversation_id', 'revision', 'supersedes_id', 'valid_days', 'discount_satang', 'vat_rate_bp', 'withholding_rate_bp', 'subtotal_satang', 'vat_satang', 'total_satang', 'withholding_satang'];
  const quotation = { ...row };
  for (const key of numeric) if (quotation[key] !== null && quotation[key] !== undefined) quotation[key] = Number(quotation[key]);
  quotation.buyer_json = quotation.buyer_json || {};
  return quotation;
}

function normalizeItem(row) {
  return { ...row, position: Number(row.position), quantity_hundredths: Number(row.quantity_hundredths), unit_price_satang: Number(row.unit_price_satang), amount_satang: Number(row.amount_satang) };
}

async function loadQuotation(db, where, params) {
  const { rows } = await db.query(`SELECT * FROM quotations WHERE ${where}`, params);
  const quotation = normalizeQuotation(rows[0]);
  if (!quotation) return null;
  const { rows: items } = await db.query('SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position', [quotation.id]);
  return { quotation, items: items.map(normalizeItem) };
}

async function writeItems(client, quotationId, items) {
  await client.query('DELETE FROM quotation_items WHERE quotation_id = $1', [quotationId]);
  for (const [index, item] of items.entries()) {
    await client.query('INSERT INTO quotation_items(quotation_id, position, description, quantity_hundredths, unit, unit_price_satang, amount_satang) VALUES ($1, $2, $3, $4, $5, $6, $7)', [quotationId, index + 1, item.description, item.quantityHundredths, item.unit, item.unitPriceSatang, lineAmount(item.quantityHundredths, item.unitPriceSatang)]);
  }
}

async function audit(client, username, action, quotationId, details = {}) {
  await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [username, action, 'quotation', String(quotationId), JSON.stringify(details)]);
}

function createQuotationService({ db, seller }) {
  const vatRateBp = () => (seller.vatRegistered ? VAT_BP : 0);

  async function createDraft(conversationId, username, today = bangkokToday()) {
    return withTransaction(db, async (client) => {
      const { rows: conversations } = await client.query('SELECT c.id, l.requirements_json FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id WHERE c.id = $1', [conversationId]);
      if (!conversations[0]) return null;
      const { rows: previous } = await client.query('SELECT buyer_json, payment_terms FROM quotations WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [conversationId]);
      const year = Number(today.slice(0, 4));
      const { rows: counter } = await client.query('INSERT INTO quotation_counters(year, last_number) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last_number = quotation_counters.last_number + 1 RETURNING last_number', [year]);
      const number = `QT-${year}-${String(counter[0].last_number).padStart(4, '0')}`;
      const title = String(conversations[0].requirements_json?.serviceType || '').slice(0, 200);
      const { rows } = await client.query('INSERT INTO quotations(conversation_id, number, title, buyer_json, payment_terms, vat_rate_bp, withholding_rate_bp, created_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING id', [conversationId, number, title, JSON.stringify(previous[0]?.buyer_json || {}), previous[0]?.payment_terms || DEFAULT_PAYMENT_TERMS, vatRateBp(), DEFAULT_WITHHOLDING_BP, username]);
      await audit(client, username, 'quotation.created', rows[0].id, { conversationId, number });
      return Number(rows[0].id);
    });
  }

  async function saveDraft(id, values, username) {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query('SELECT id, status FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return 'missing';
      if (rows[0].status !== 'DRAFT') return 'locked';
      const totals = computeTotals(values.items, values.discountSatang, vatRateBp(), values.withholdingRateBp);
      await client.query('UPDATE quotations SET title = $2, buyer_json = $3::jsonb, valid_days = $4, discount_satang = $5, vat_rate_bp = $6, withholding_rate_bp = $7, subtotal_satang = $8, vat_satang = $9, total_satang = $10, withholding_satang = $11, payment_terms = $12, notes = $13, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [id, values.title, JSON.stringify(values.buyer), values.validDays, values.discountSatang, vatRateBp(), values.withholdingRateBp, totals.subtotal, totals.vat, totals.total, totals.withholding, values.paymentTerms, values.notes]);
      await writeItems(client, id, values.items);
      await audit(client, username, 'quotation.draft_saved', id, { items: values.items.length, totalSatang: totals.total });
      return 'saved';
    });
  }

  async function issue(id, username, today = bangkokToday()) {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query('SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      const quotation = normalizeQuotation(rows[0]);
      if (!quotation) return { outcome: 'missing' };
      if (quotation.status !== 'DRAFT') return { outcome: 'locked' };
      const { rows: itemRows } = await client.query('SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position', [id]);
      const items = itemRows.map(normalizeItem);
      const totals = computeTotals(items.map((item) => ({ quantityHundredths: item.quantity_hundredths, unitPriceSatang: item.unit_price_satang })), quotation.discount_satang, vatRateBp(), quotation.withholding_rate_bp);
      const errors = issueErrors({ ...quotation, total_satang: totals.total }, items);
      if (errors.length) return { outcome: 'invalid', errors };
      const token = randomBytes(32).toString('base64url');
      await client.query("UPDATE quotations SET status = 'SENT', public_token = $2, issue_date = $3, valid_until = $4, seller_json = $5::jsonb, vat_rate_bp = $6, subtotal_satang = $7, vat_satang = $8, total_satang = $9, withholding_satang = $10, sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id, token, today, addDays(today, quotation.valid_days), JSON.stringify(seller), vatRateBp(), totals.subtotal, totals.vat, totals.total, totals.withholding]);
      if (quotation.supersedes_id) {
        await client.query("UPDATE quotations SET status = 'SUPERSEDED', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('SENT', 'REJECTED')", [quotation.supersedes_id]);
      }
      await audit(client, username, 'quotation.issued', id, { number: quotationLabel(quotation), totalSatang: totals.total });
      return { outcome: 'issued', token };
    });
  }

  async function revise(id, username) {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query('SELECT * FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      const quotation = normalizeQuotation(rows[0]);
      if (!quotation) return { outcome: 'missing' };
      if (!['SENT', 'REJECTED'].includes(quotation.status)) return { outcome: 'locked' };
      const { rows: openDrafts } = await client.query("SELECT id FROM quotations WHERE supersedes_id = $1 AND status = 'DRAFT'", [id]);
      if (openDrafts[0]) return { outcome: 'exists', id: Number(openDrafts[0].id) };
      const { rows: revisionRows } = await client.query('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM quotations WHERE number = $1', [quotation.number]);
      const { rows: created } = await client.query('INSERT INTO quotations(conversation_id, number, revision, supersedes_id, title, buyer_json, valid_days, discount_satang, vat_rate_bp, withholding_rate_bp, subtotal_satang, vat_satang, total_satang, withholding_satang, payment_terms, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id', [quotation.conversation_id, quotation.number, Number(revisionRows[0].next), id, quotation.title, JSON.stringify(quotation.buyer_json), quotation.valid_days, quotation.discount_satang, vatRateBp(), quotation.withholding_rate_bp, quotation.subtotal_satang, quotation.vat_satang, quotation.total_satang, quotation.withholding_satang, quotation.payment_terms, quotation.notes, username]);
      const newId = Number(created[0].id);
      const { rows: items } = await client.query('SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position', [id]);
      await writeItems(client, newId, items.map(normalizeItem).map((item) => ({ description: item.description, quantityHundredths: item.quantity_hundredths, unit: item.unit, unitPriceSatang: item.unit_price_satang })));
      await audit(client, username, 'quotation.revision_created', newId, { supersedesId: id });
      return { outcome: 'created', id: newId };
    });
  }

  async function cancel(id, username) {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query("UPDATE quotations SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'SENT' RETURNING id", [id]);
      if (!rows[0]) return false;
      await audit(client, username, 'quotation.cancelled', id);
      return true;
    });
  }

  async function deleteDraft(id, username) {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query('SELECT id, conversation_id, status FROM quotations WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0] || rows[0].status !== 'DRAFT') return null;
      await client.query('DELETE FROM quotation_items WHERE quotation_id = $1', [id]);
      await client.query('DELETE FROM quotations WHERE id = $1', [id]);
      await audit(client, username, 'quotation.draft_deleted', id);
      return Number(rows[0].conversation_id);
    });
  }

  async function decide(token, decision, name, reason, today = bangkokToday()) {
    return withTransaction(db, async (client) => {
      const status = decision === 'accept' ? 'ACCEPTED' : 'REJECTED';
      const { rows } = await client.query("UPDATE quotations SET status = $2, decision_name = $3, decision_reason = $4, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE public_token = $1 AND status = 'SENT' AND valid_until >= $5 RETURNING id", [token, status, name || null, reason || null, today]);
      if (!rows[0]) return false;
      await audit(client, 'customer', decision === 'accept' ? 'quotation.accepted' : 'quotation.rejected', rows[0].id);
      return true;
    });
  }

  async function markDecisionRead(id) {
    const { rows } = await db.query('UPDATE quotations SET decision_read_at = COALESCE(decision_read_at, CURRENT_TIMESTAMP) WHERE id = $1 AND decided_at IS NOT NULL RETURNING id', [id]);
    return Boolean(rows[0]);
  }

  return {
    createDraft, saveDraft, issue, revise, cancel, deleteDraft, decide, markDecisionRead,
    load: (id) => loadQuotation(db, 'id = $1', [id]),
    loadByToken: (token) => loadQuotation(db, 'public_token = $1', [token]),
    vatRateBp,
  };
}

module.exports = {
  createQuotationService, parseQuotationForm, computeTotals, lineAmount, parseMoney, formatMoney, formatQuantity, bahtText, isValidThaiTaxId, formatTaxId, branchLabel,
  bangkokToday, addDays, formatThaiDate, formatThaiDateTime, quotationLabel, effectiveStatus, issueErrors, normalizeQuotation, STATUS_LABELS, DEFAULT_PAYMENT_TERMS, VAT_BP,
};
