const { escapeHtml } = require('./html');
const { formatMoney, formatQuantity, bahtText, formatTaxId, branchLabel, formatThaiDate, formatThaiDateTime, quotationLabel, effectiveStatus, STATUS_LABELS, lineAmount } = require('./quotations');

const UNITS = ['งาน', 'ระบบ', 'เดือน', 'ปี', 'วัน', 'ชั่วโมง', 'ครั้ง', 'ชิ้น', 'ชุด', 'ใบอนุญาต'];
const STATUS_TONES = { DRAFT: 'draft', SENT: 'sent', ACCEPTED: 'accepted', REJECTED: 'rejected', EXPIRED: 'muted', SUPERSEDED: 'muted', CANCELLED: 'muted' };

const ADMIN_STYLE = `<style>
.q-status{display:inline-flex;align-items:center;font-size:12px;font-weight:750;padding:4px 10px;border-radius:999px;background:#eef2f7;color:#56667d;white-space:nowrap}.q-status.draft{background:#eef2f7;color:#40516b}.q-status.sent{background:#e8f1ff;color:#1769e8}.q-status.accepted{background:#e4f6ef;color:#087c61}.q-status.rejected{background:#fdecec;color:#b42318}.q-status.muted{background:#f1f3f6;color:#8590a2}
.q-table-wrap{overflow:auto;border:1px solid var(--line);border-radius:14px;background:white}.q-table{min-width:760px}.q-table th{font-size:12px;color:var(--muted);font-weight:700;background:#f8fafd}.q-table td{font-size:14px}.q-table a{color:var(--ink);font-weight:700;text-decoration:none}.q-table a:hover{color:var(--blue)}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.q-filters{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px}.q-filters a{padding:7px 12px;border-radius:999px;background:white;border:1px solid var(--line);color:#4a5b73;text-decoration:none;font-size:13px;font-weight:650}.q-filters a.active{background:var(--navy);border-color:var(--navy);color:white}
.q-alert{padding:12px 14px;border-radius:12px;margin:0 0 16px;font-size:14px}.q-alert.error{background:#fdecec;color:#8f1d14;border:1px solid #f6c9c5}.q-alert.ok{background:#e4f6ef;color:#075e49;border:1px solid #bfe8d9}.q-alert.warn{background:#fff6e5;color:#7a4a05;border:1px solid #f6dfb2}.q-alert ul{margin:6px 0 0;padding-left:20px}
.q-editor .card h2{display:flex;align-items:center;gap:8px}.q-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 14px}.q-grid .full{grid-column:1/-1}.q-branch{display:grid;grid-template-columns:minmax(0,1fr) 120px;gap:10px}
.q-items{width:100%;border-collapse:separate;border-spacing:0}.q-items th{font-size:12px;color:var(--muted);padding:8px 6px;border-bottom:1px solid var(--line)}.q-items td{padding:8px 6px;border-bottom:1px solid #edf1f6;vertical-align:top}.q-items input,.q-items textarea{margin:0}.q-items textarea{min-height:64px}.q-items .col-no{width:34px;color:var(--muted);font-weight:700;padding-top:18px;text-align:center}.q-items .col-qty{width:90px}.q-items .col-unit{width:110px}.q-items .col-price{width:140px}.q-items .col-amount{width:130px;padding-top:18px;font-weight:700}.q-items .col-remove{width:44px}.q-items .remove-item{padding:8px 10px;background:#f3f5f8;color:#6b778a}.q-items .remove-item:hover{background:#fdecec;color:#b42318}
.q-totals{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start}.q-summary{border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:#fbfcfe}.q-summary div{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:14px}.q-summary .grand{margin:6px -8px;padding:10px 8px;border-radius:10px;background:var(--navy);color:white;font-weight:800;font-size:16px}.q-summary .net{font-weight:800}.q-check{display:flex;align-items:center;gap:8px;font-weight:600}.q-check input{width:auto;margin:0}
.q-actionbar{position:sticky;bottom:0;z-index:5;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding:14px 16px;margin:16px 0;background:#ffffffee;backdrop-filter:blur(6px);border:1px solid var(--line);border-radius:14px;box-shadow:0 -6px 24px #14233b0d}
.q-view-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}.q-view-head h1{margin:4px 0}.q-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:14px}.q-kv div{padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:#fbfcfe}.q-kv b{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.q-link{display:flex;gap:8px}.q-link button{white-space:nowrap}a.button.secondary{background:#eaf1fb;color:#21416e}a.button.secondary:hover{background:#dce8f8}.q-link input{margin:0;font-size:13px;background:#f8fafd}.q-history a{color:var(--blue)}
.q-side-list{display:grid;gap:6px;margin:6px 0 10px}.q-side-item{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;color:inherit;text-decoration:none;font-size:12px}.q-side-item:hover{border-color:#cbdcf8;background:#f6f9fd}.q-side-item strong{font-size:12px}
@media(max-width:720px){.q-grid,.q-totals{grid-template-columns:1fr}.q-items thead{display:none}.q-items tr{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:10px 0;border-bottom:1px solid var(--line)}.q-items td{border:0;padding:2px 0}.q-items .col-no{display:none}.q-items td.col-desc{grid-column:1/-1}.q-items .col-qty,.q-items .col-unit,.q-items .col-price,.q-items .col-amount,.q-items .col-remove{width:auto}.q-items .col-amount{padding-top:10px}.q-actionbar{position:static;justify-content:stretch}.q-actionbar button,.q-actionbar a.button{flex:1 1 100%}}
</style>`;

function statusBadge(quotation, today) {
  const status = effectiveStatus(quotation, today);
  return `<span class="q-status ${STATUS_TONES[status] || 'muted'}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

function csrfField(csrfToken) { return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`; }

function postButton(action, csrfToken, label, { className = '', confirm = '', extra = '' } = {}) {
  return `<form method="post" action="${escapeHtml(action)}"${confirm ? ` data-confirm="${escapeHtml(confirm)}"` : ''}>${csrfField(csrfToken)}${extra}<button type="submit"${className ? ` class="${className}"` : ''}>${escapeHtml(label)}</button></form>`;
}

function sellerWarning(seller) {
  if (seller.name && seller.taxId) return '';
  return '<div class="q-alert warn"><b>ยังตั้งค่าข้อมูลผู้ขายไม่ครบ</b> · ตั้ง <code>SELLER_NAME</code> และ <code>SELLER_TAX_ID</code> ใน environment ก่อน จึงจะส่งใบเสนอราคาให้ลูกค้าได้ ระหว่างนี้ยังสร้างและบันทึกฉบับร่างได้ตามปกติ</div>';
}

function pageTop(title, subtitle, staff, csrfToken, active) {
  return `${ADMIN_STYLE}<div class="crm-top"><div><div class="eyebrow">DONNAR TECH · SALES</div><h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(subtitle)}</p></div><div class="user-tools"><span class="muted">เข้าสู่ระบบเป็น <b>${escapeHtml(staff.username)}</b></span><form method="post" action="/admin/logout">${csrfField(csrfToken)}<button class="secondary">ออกจากระบบ</button></form></div></div><nav class="crm-nav"><a href="/admin#inbox">กล่องข้อความ</a><a class="${active === 'list' ? 'active' : ''}" href="/admin/quotations">ใบเสนอราคา</a></nav>`;
}

function quotationListPage({ rows, staff, csrfToken, seller, statusFilter, today }) {
  const decorated = rows.map((row) => ({ ...row, effective: effectiveStatus(row, today) }));
  const visible = statusFilter ? decorated.filter((row) => row.effective === statusFilter) : decorated;
  const month = today.slice(0, 7);
  const openValue = decorated.filter((row) => row.effective === 'SENT').reduce((sum, row) => sum + row.total_satang, 0);
  const acceptedThisMonth = decorated.filter((row) => row.status === 'ACCEPTED' && row.decided_at && new Date(row.decided_at).toISOString().slice(0, 7) === month);
  const decided = decorated.filter((row) => ['ACCEPTED', 'REJECTED'].includes(row.status));
  const winRate = decided.length ? Math.round((decided.filter((row) => row.status === 'ACCEPTED').length / decided.length) * 100) : null;
  const metrics = [
    { label: 'มูลค่ารอลูกค้าตอบรับ', value: `฿${formatMoney(openValue)}`, tone: 'blue' },
    { label: 'ยอมรับแล้วเดือนนี้', value: `฿${formatMoney(acceptedThisMonth.reduce((sum, row) => sum + row.total_satang, 0))}`, tone: 'green' },
    { label: 'อัตราตอบรับ', value: winRate === null ? '–' : `${winRate}%`, tone: 'orange' },
  ].map((item) => `<div class="metric ${item.tone}"><span>${item.label}</span><strong>${escapeHtml(item.value)}</strong></div>`).join('');
  const filters = [['', 'ทั้งหมด'], ['DRAFT', 'ฉบับร่าง'], ['SENT', 'รอตอบรับ'], ['ACCEPTED', 'ยอมรับแล้ว'], ['REJECTED', 'ปฏิเสธ'], ['EXPIRED', 'หมดอายุ'], ['CANCELLED', 'ยกเลิก'], ['SUPERSEDED', 'ถูกแทนที่']]
    .map(([value, label]) => `<a class="${statusFilter === value ? 'active' : ''}" href="/admin/quotations${value ? `?status=${value}` : ''}">${label} (${value ? decorated.filter((row) => row.effective === value).length : decorated.length})</a>`).join('');
  const tableRows = visible.map((row) => `<tr><td><a href="/admin/quotations/${row.id}">${escapeHtml(quotationLabel(row))}</a><br><small>${escapeHtml(row.issue_date ? formatThaiDate(row.issue_date) : 'ยังไม่ส่ง')}</small></td><td>${escapeHtml(row.buyer_json?.companyName || '-')}<br><small>LINE: ${escapeHtml(row.display_name || row.line_user_id)}</small></td><td>${escapeHtml(row.title || '-')}</td><td class="num">${formatMoney(row.total_satang)}</td><td>${statusBadge(row, today)}</td><td><small>${escapeHtml(formatThaiDateTime(row.updated_at))}</small></td></tr>`).join('');
  return `${pageTop('ใบเสนอราคา', 'สร้างจากบทสนทนาใน CRM ส่งให้ลูกค้าทาง LINE และติดตามการตอบรับ', staff, csrfToken, 'list')}${sellerWarning(seller)}<div class="metric-grid">${metrics}</div><div class="q-filters">${filters}</div>${visible.length ? `<div class="q-table-wrap"><table class="q-table"><thead><tr><th>เลขที่</th><th>ลูกค้า</th><th>โครงการ</th><th class="num">ยอดรวม (บาท)</th><th>สถานะ</th><th>อัปเดตล่าสุด</th></tr></thead><tbody>${tableRows}</tbody></table></div>` : '<div class="card empty-state"><div class="empty-icon">🧾</div><h2>ยังไม่มีใบเสนอราคา</h2><p>เปิดบทสนทนาในกล่องข้อความ แล้วกด “สร้างใบเสนอราคา” จากแผงรายละเอียดลูกค้า</p><a class="button" href="/admin#inbox">ไปที่กล่องข้อความ</a></div>'}`;
}

function editorModel(quotation, items) {
  return {
    title: quotation.title,
    buyer: quotation.buyer_json || {},
    items: items.map((item) => ({ description: item.description, quantityText: formatQuantity(item.quantity_hundredths).replace(/,/g, ''), unit: item.unit, priceText: formatMoney(item.unit_price_satang).replace(/,/g, '') })),
    discountText: quotation.discount_satang ? formatMoney(quotation.discount_satang).replace(/,/g, '') : '',
    validDays: quotation.valid_days,
    withholding: quotation.withholding_rate_bp > 0,
    paymentTerms: quotation.payment_terms,
    notes: quotation.notes,
  };
}

function formModel(values, body) {
  return {
    title: values.title,
    buyer: values.buyer,
    items: values.items.map((item) => ({ description: item.description, quantityText: item.quantityText, unit: item.unit, priceText: item.priceText })),
    discountText: String(body.discount ?? ''),
    validDays: String(body.valid_days ?? values.validDays),
    withholding: body.withholding === 'on',
    paymentTerms: values.paymentTerms,
    notes: values.notes,
  };
}

function itemRow(item, index) {
  const quantity = Number(String(item.quantityText || '1').replace(/,/g, ''));
  const price = Number(String(item.priceText || '').replace(/,/g, ''));
  const amount = Number.isFinite(quantity) && Number.isFinite(price) && item.priceText ? formatMoney(lineAmount(Math.round(quantity * 100), Math.round(price * 100))) : '–';
  return `<tr class="item-row"><td class="col-no">${index + 1}</td><td class="col-desc"><textarea name="item_description" maxlength="2000" rows="2" placeholder="รายละเอียดงาน เช่น ออกแบบและพัฒนาเว็บไซต์บริษัท 8 หน้า" aria-label="รายละเอียดรายการ">${escapeHtml(item.description || '')}</textarea></td><td class="col-qty"><input name="item_quantity" inputmode="decimal" value="${escapeHtml(item.quantityText || '')}" placeholder="1" aria-label="จำนวน"></td><td class="col-unit"><input name="item_unit" list="quotation-units" maxlength="30" value="${escapeHtml(item.unit || '')}" placeholder="งาน" aria-label="หน่วย"></td><td class="col-price"><input name="item_unit_price" inputmode="decimal" value="${escapeHtml(item.priceText || '')}" placeholder="0.00" aria-label="ราคาต่อหน่วย"></td><td class="col-amount num" data-amount>${amount}</td><td class="col-remove"><button type="button" class="remove-item" aria-label="ลบรายการ">✕</button></td></tr>`;
}

function quotationEditorPage({ quotation, model, errors = [], staff, csrfToken, seller, vatRateBp, notice = '' }) {
  const buyer = model.buyer || {};
  const rows = [...model.items, ...Array.from({ length: model.items.length ? 1 : 3 }, () => ({}))];
  const errorBox = errors.length ? `<div class="q-alert error" role="alert"><b>ยังบันทึกไม่ได้ กรุณาแก้ไขข้อมูลต่อไปนี้</b><ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul></div>` : '';
  const vatRow = vatRateBp ? `<div><span>ภาษีมูลค่าเพิ่ม ${vatRateBp / 100}%</span><span class="num" data-total="vat">–</span></div>` : '';
  const action = `/admin/quotations/${quotation.id}`;
  return `${pageTop(`แก้ไข ${quotationLabel(quotation)}`, quotation.supersedes_id ? 'ฉบับแก้ไข · เมื่อส่งแล้วฉบับก่อนหน้าจะถูกแทนที่' : 'ฉบับร่าง · ลูกค้ายังไม่เห็นเอกสารนี้จนกว่าจะกดส่ง', staff, csrfToken, 'editor')}${sellerWarning(seller)}${notice}${errorBox}
<form class="q-editor" method="post" action="${action}" data-vat-bp="${vatRateBp}">${csrfField(csrfToken)}
<section class="card"><h2>ข้อมูลลูกค้า</h2><div class="q-grid">
<label class="full">ชื่อบริษัท / ชื่อลูกค้า *<input name="buyer_company" maxlength="200" value="${escapeHtml(buyer.companyName || '')}" placeholder="บริษัท ตัวอย่าง จำกัด" autocomplete="organization"></label>
<label>เลขประจำตัวผู้เสียภาษี (13 หลัก)<input name="buyer_tax_id" inputmode="numeric" maxlength="17" value="${escapeHtml(buyer.taxId || '')}" placeholder="0105556000000"></label>
<div><label for="buyer-branch-type">สำนักงาน</label><div class="q-branch"><select id="buyer-branch-type" name="buyer_branch_type"><option value="HQ"${buyer.branchType !== 'BRANCH' ? ' selected' : ''}>สำนักงานใหญ่</option><option value="BRANCH"${buyer.branchType === 'BRANCH' ? ' selected' : ''}>สาขา</option></select><input name="buyer_branch_code" inputmode="numeric" maxlength="5" value="${escapeHtml(buyer.branchCode || '')}" placeholder="00001" aria-label="รหัสสาขา"></div></div>
<label class="full">ที่อยู่สำหรับออกเอกสาร<textarea name="buyer_address" maxlength="500" rows="2" placeholder="เลขที่ ถนน แขวง/ตำบล เขต/อำเภอ จังหวัด รหัสไปรษณีย์">${escapeHtml(buyer.address || '')}</textarea></label>
<label>ผู้ติดต่อ<input name="buyer_contact" maxlength="120" value="${escapeHtml(buyer.contactName || '')}" placeholder="ชื่อ-นามสกุล / ตำแหน่ง"></label>
<label>เบอร์โทร<input name="buyer_phone" maxlength="40" value="${escapeHtml(buyer.phone || '')}" inputmode="tel"></label>
<label class="full">อีเมล<input name="buyer_email" type="email" maxlength="200" value="${escapeHtml(buyer.email || '')}"></label>
</div></section>
<section class="card"><h2>โครงการ</h2><div class="q-grid"><label>ชื่อโครงการ / หัวข้อใบเสนอราคา<input name="title" maxlength="200" value="${escapeHtml(model.title || '')}" placeholder="เช่น พัฒนาเว็บแอปจัดการคลังสินค้า"></label><label>ยืนราคา (วัน)<input name="valid_days" type="number" min="1" max="365" value="${escapeHtml(model.validDays)}"></label></div></section>
<section class="card"><h2>รายการ</h2><div style="overflow:auto"><table class="q-items"><thead><tr><th class="col-no">#</th><th>รายละเอียด</th><th class="col-qty">จำนวน</th><th class="col-unit">หน่วย</th><th class="col-price">ราคาต่อหน่วย</th><th class="col-amount num">จำนวนเงิน</th><th class="col-remove"></th></tr></thead><tbody id="quotation-items">${rows.map(itemRow).join('')}</tbody></table></div>
<template id="item-row-template">${itemRow({}, 0)}</template><datalist id="quotation-units">${UNITS.map((unit) => `<option value="${escapeHtml(unit)}">`).join('')}</datalist>
<p><button type="button" class="secondary" id="add-item">+ เพิ่มรายการ</button></p>
<div class="q-totals"><div><label>ส่วนลด (บาท)<input name="discount" inputmode="decimal" value="${escapeHtml(model.discountText || '')}" placeholder="0.00"></label><label class="q-check"><input type="checkbox" name="withholding"${model.withholding ? ' checked' : ''}> ลูกค้าเป็นนิติบุคคล หัก ณ ที่จ่าย 3% (ค่าบริการ)</label><p class="muted" style="font-size:12px">${vatRateBp ? 'คิดภาษีมูลค่าเพิ่ม 7% จากยอดหลังหักส่วนลด' : 'ผู้ขายไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม (SELLER_VAT_REGISTERED) จึงไม่คิด VAT'} · ระบบคำนวณยอดจริงอีกครั้งเมื่อบันทึก</p></div>
<div class="q-summary" aria-live="polite"><div><span>รวมเป็นเงิน</span><span class="num" data-total="subtotal">–</span></div><div><span>ส่วนลด</span><span class="num" data-total="discount">–</span></div>${vatRow}<div class="grand"><span>รวมทั้งสิ้น</span><span class="num" data-total="total">–</span></div><div data-withholding-row><span>หัก ณ ที่จ่าย 3%</span><span class="num" data-total="withholding">–</span></div><div class="net" data-withholding-row><span>ยอดชำระสุทธิ</span><span class="num" data-total="net">–</span></div></div></div></section>
<section class="card"><h2>เงื่อนไข</h2><div class="q-grid"><label class="full">เงื่อนไขการชำระเงิน<textarea name="payment_terms" maxlength="2000" rows="3">${escapeHtml(model.paymentTerms || '')}</textarea></label><label class="full">หมายเหตุ (แสดงในเอกสาร)<textarea name="notes" maxlength="2000" rows="3" placeholder="เช่น ราคานี้ไม่รวมค่าโฮสติ้งรายปี">${escapeHtml(model.notes || '')}</textarea></label></div></section>
<div class="q-actionbar"><a class="button secondary" href="/admin?conversation=${quotation.conversation_id}#inbox">กลับไปบทสนทนา</a><button type="submit" class="secondary">บันทึกฉบับร่าง</button><button type="submit" class="secondary" formaction="${action}/preview" formtarget="_blank">บันทึกและดูตัวอย่าง PDF</button><button type="submit" formaction="${action}/send" data-confirm="ส่งใบเสนอราคานี้ให้ลูกค้าทาง LINE? หลังส่งแล้วจะแก้ไขเอกสารนี้ไม่ได้">บันทึกและส่งให้ลูกค้า</button></div>
</form>
<div class="actions" style="justify-content:flex-end">${postButton(`${action}/delete`, csrfToken, 'ลบฉบับร่างนี้', { className: 'secondary', confirm: 'ลบฉบับร่างนี้ถาวร?' })}</div>`;
}

function itemsTable(items) {
  return `<div class="q-table-wrap"><table class="q-table"><thead><tr><th>#</th><th>รายละเอียด</th><th class="num">จำนวน</th><th>หน่วย</th><th class="num">ราคาต่อหน่วย</th><th class="num">จำนวนเงิน</th></tr></thead><tbody>${items.map((item, index) => `<tr><td>${index + 1}</td><td style="white-space:pre-wrap">${escapeHtml(item.description)}</td><td class="num">${formatQuantity(item.quantity_hundredths)}</td><td>${escapeHtml(item.unit || '-')}</td><td class="num">${formatMoney(item.unit_price_satang)}</td><td class="num"><b>${formatMoney(item.amount_satang)}</b></td></tr>`).join('')}</tbody></table></div>`;
}

function summaryRows(quotation) {
  const rows = [['รวมเป็นเงิน', quotation.subtotal_satang]];
  if (quotation.discount_satang) rows.push(['หักส่วนลด', -quotation.discount_satang]);
  if (quotation.vat_rate_bp) rows.push([`ภาษีมูลค่าเพิ่ม ${quotation.vat_rate_bp / 100}%`, quotation.vat_satang]);
  return rows;
}

function quotationViewPage({ quotation, items, history, staff, csrfToken, link, today, flash }) {
  const status = effectiveStatus(quotation, today);
  const action = `/admin/quotations/${quotation.id}`;
  const buyer = quotation.buyer_json || {};
  const flashes = { sent: ['ok', 'ส่งใบเสนอราคาให้ลูกค้าทาง LINE แล้ว'], resent: ['ok', 'ส่งการ์ดใบเสนอราคาใน LINE อีกครั้งแล้ว'], 'push-failed': ['warn', 'บันทึกใบเสนอราคาแล้ว แต่ส่งการ์ดใน LINE ไม่สำเร็จ คัดลอกลิงก์ไปส่งเองหรือกดส่งอีกครั้งได้'], cancelled: ['ok', 'ยกเลิกใบเสนอราคาแล้ว ลิงก์ของลูกค้าจะแสดงว่ายกเลิก'] };
  const flashBox = flashes[flash] ? `<div class="q-alert ${flashes[flash][0]}">${escapeHtml(flashes[flash][1])}</div>` : '';
  const decision = quotation.decided_at ? `<div class="q-alert ${quotation.status === 'ACCEPTED' ? 'ok' : 'error'}"><b>${quotation.status === 'ACCEPTED' ? 'ลูกค้ายอมรับใบเสนอราคา' : 'ลูกค้าปฏิเสธใบเสนอราคา'}</b> · ${escapeHtml(formatThaiDateTime(quotation.decided_at))}${quotation.decision_name ? `<br>ยืนยันโดย: ${escapeHtml(quotation.decision_name)}` : ''}${quotation.decision_reason ? `<br>เหตุผล: ${escapeHtml(quotation.decision_reason)}` : ''}${!quotation.decision_read_at ? `<div style="margin-top:8px">${postButton(`${action}/decision/read`, csrfToken, 'รับทราบแล้ว', { className: 'secondary' })}</div>` : ''}</div>` : '';
  const actions = [
    `<a class="button" href="${action}/pdf" target="_blank" rel="noopener">ดาวน์โหลด PDF</a>`,
    status === 'SENT' ? postButton(`${action}/resend`, csrfToken, 'ส่งการ์ดใน LINE อีกครั้ง', { className: 'secondary' }) : '',
    ['SENT', 'EXPIRED', 'REJECTED'].includes(status) ? postButton(`${action}/revise`, csrfToken, 'แก้ไขเป็นฉบับใหม่', { className: 'secondary' }) : '',
    ['SENT', 'EXPIRED'].includes(status) ? postButton(`${action}/cancel`, csrfToken, 'ยกเลิกใบเสนอราคา', { className: 'secondary', confirm: 'ยกเลิกใบเสนอราคานี้? ลูกค้าจะไม่สามารถยืนยันได้อีก' }) : '',
    `<a class="button secondary" href="/admin?conversation=${quotation.conversation_id}#inbox">เปิดบทสนทนา</a>`,
  ].join('');
  const historyRows = history.length > 1 ? `<section class="card q-history"><h2>ประวัติฉบับ</h2>${history.map((row) => `<div class="requirement"><a href="/admin/quotations/${row.id}">${escapeHtml(quotationLabel(row))}</a> · ${statusBadge(row, today)} · ${formatMoney(row.total_satang)} บาท</div>`).join('')}</section>` : '';
  const totals = [...summaryRows(quotation).map(([label, value]) => `<div><span>${escapeHtml(label)}</span><span class="num">${formatMoney(value)}</span></div>`), `<div class="grand"><span>รวมทั้งสิ้น</span><span class="num">${formatMoney(quotation.total_satang)}</span></div>`, quotation.withholding_rate_bp ? `<div><span>หัก ณ ที่จ่าย ${quotation.withholding_rate_bp / 100}%</span><span class="num">${formatMoney(-quotation.withholding_satang)}</span></div><div class="net"><span>ยอดชำระสุทธิ</span><span class="num">${formatMoney(quotation.total_satang - quotation.withholding_satang)}</span></div>` : ''].join('');
  return `${pageTop(quotationLabel(quotation), quotation.title || 'ใบเสนอราคา', staff, csrfToken, 'view')}${flashBox}${decision}
<section class="card"><div class="q-view-head"><div>${statusBadge(quotation, today)}<h1>${escapeHtml(buyer.companyName || '-')}</h1><div class="muted">${escapeHtml(quotation.title || '')}</div></div><div class="actions">${actions}</div></div>
<div class="q-kv"><div><b>วันที่ออก</b>${escapeHtml(formatThaiDate(quotation.issue_date) || '-')}</div><div><b>ยืนราคาถึง</b>${escapeHtml(formatThaiDate(quotation.valid_until) || '-')}</div><div><b>ยอดรวมทั้งสิ้น</b>฿${formatMoney(quotation.total_satang)}</div><div><b>ผู้สร้าง</b>${escapeHtml(quotation.created_by)}</div></div>
${link ? `<label style="margin-top:16px">ลิงก์สำหรับลูกค้า</label><div class="q-link"><input readonly value="${escapeHtml(link)}" id="quotation-link"><button type="button" class="secondary" data-copy="quotation-link">คัดลอก</button></div>` : ''}</section>
<section class="card"><h2>รายการ</h2>${itemsTable(items)}<div class="q-totals" style="margin-top:16px"><div><p class="muted">${escapeHtml(bahtText(quotation.total_satang))}</p>${quotation.payment_terms ? `<div class="detail-label">เงื่อนไขการชำระเงิน</div><p style="white-space:pre-wrap">${escapeHtml(quotation.payment_terms)}</p>` : ''}${quotation.notes ? `<div class="detail-label">หมายเหตุ</div><p style="white-space:pre-wrap">${escapeHtml(quotation.notes)}</p>` : ''}</div><div class="q-summary">${totals}</div></div></section>
<section class="card"><h2>ลูกค้า</h2><div class="requirement"><b>บริษัท</b>${escapeHtml(buyer.companyName || '-')}</div><div class="requirement"><b>เลขประจำตัวผู้เสียภาษี</b>${escapeHtml(buyer.taxId ? `${formatTaxId(buyer.taxId)} (${branchLabel(buyer)})` : '-')}</div><div class="requirement"><b>ที่อยู่</b>${escapeHtml(buyer.address || '-')}</div><div class="requirement"><b>ผู้ติดต่อ</b>${escapeHtml([buyer.contactName, buyer.phone, buyer.email].filter(Boolean).join(' · ') || '-')}</div></section>${historyRows}`;
}

function conversationQuotationPanel({ quotations, conversationId, csrfToken, today }) {
  const list = quotations.map((row) => `<a class="q-side-item" href="/admin/quotations/${row.id}"><span><strong>${escapeHtml(quotationLabel(row))}</strong><br>${formatMoney(row.total_satang)} บาท</span>${statusBadge(row, today)}</a>`).join('');
  return `<div class="detail-label" style="margin-top:18px">ใบเสนอราคา</div>${list ? `<div class="q-side-list">${list}</div>` : '<p class="muted" style="font-size:13px">ยังไม่มีใบเสนอราคา</p>'}<form method="post" action="/admin/conversations/${conversationId}/quotations">${csrfField(csrfToken)}<button type="submit" style="width:100%">สร้างใบเสนอราคา</button></form>`;
}

function decisionPanel({ decisions, today }) {
  if (!decisions.length) return '';
  const rows = decisions.map((row) => `<a class="triage-item waiting-item" href="/admin/quotations/${row.id}"><div class="triage-item-top"><strong>${escapeHtml(quotationLabel(row))} · ${escapeHtml(row.buyer_json?.companyName || '-')}</strong>${statusBadge(row, today)}</div><div class="lead-meta">${escapeHtml(formatThaiDateTime(row.decided_at))} · ${formatMoney(row.total_satang)} บาท</div></a>`).join('');
  return `<section class="card triage-panel" id="quotation-decisions" style="margin:0 0 18px"><div class="section-heading"><div><div class="eyebrow">SALES</div><h2>ลูกค้าตอบกลับใบเสนอราคา <span class="count-pill">${decisions.length}</span></h2><p>เปิดดูแล้วกด “รับทราบแล้ว” เพื่อนำออกจากรายการ</p></div></div><div class="triage-list">${rows}</div></section>`;
}

const PUBLIC_STYLE = `*{box-sizing:border-box}:root{color-scheme:light;--ink:#10213D;--text:#1F2D44;--muted:#5B6B82;--line:#D8E1EB;--wash:#F4F7FB;--aqua:#16C7C2;--blue:#1478F2;--green:#0B8F6A;--red:#B42318}
body{margin:0;background:var(--wash);color:var(--text);font:16px/1.6 "Sarabun","Noto Sans Thai",system-ui,-apple-system,sans-serif}header{background:var(--ink);color:white;border-top:4px solid var(--aqua)}header div{max-width:760px;margin:0 auto;padding:14px 16px;display:flex;align-items:center;gap:10px}header img{width:36px;height:36px;border-radius:9px;background:white;padding:2px}header strong{font-size:15px}main{max-width:760px;margin:0 auto;padding:16px 16px 40px}
.card{background:white;border:1px solid var(--line);border-radius:18px;padding:20px;margin:0 0 14px;box-shadow:0 8px 28px #10213D0a}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;color:var(--blue);text-transform:uppercase}h1{font-size:24px;line-height:1.25;margin:4px 0 6px;color:var(--ink)}h2{font-size:17px;margin:0 0 12px;color:var(--ink)}.muted{color:var(--muted);font-size:14px}.status{display:inline-block;padding:4px 11px;border-radius:999px;font-size:13px;font-weight:700;background:#e8f1ff;color:var(--blue)}.status.accepted{background:#e4f6ef;color:var(--green)}.status.rejected{background:#fdecec;color:var(--red)}.status.muted{background:#eef1f5;color:var(--muted)}
.total{margin:16px 0 4px;padding:16px;border-radius:14px;background:var(--ink);color:white;display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.total span{font-size:14px;opacity:.85}.total strong{font-size:28px;font-variant-numeric:tabular-nums}.baht{font-size:13px;color:var(--muted);margin:6px 0 0}
.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}.meta div{background:var(--wash);border-radius:12px;padding:10px 12px;font-size:14px}.meta b{display:block;font-size:11px;color:var(--muted);font-weight:700;letter-spacing:.05em}
.item{padding:12px 0;border-bottom:1px solid #edf1f6}.item:last-child{border-bottom:0}.item p{margin:0;white-space:pre-wrap}.item .calc{display:flex;justify-content:space-between;gap:10px;font-size:14px;color:var(--muted);margin-top:4px}.item .calc b{color:var(--ink);font-variant-numeric:tabular-nums}
.rows div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:15px}.rows .strong{font-weight:800;color:var(--ink);border-top:1px solid var(--line);margin-top:4px;padding-top:10px}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.button{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;border:0;border-radius:12px;padding:14px 16px;font:inherit;font-weight:700;font-size:16px;text-decoration:none;cursor:pointer;background:var(--blue);color:white}.button.secondary{background:#eaf1fb;color:#21416e}.button.accept{background:var(--green)}.button.reject{background:white;color:var(--red);border:1px solid #f1c3bf}
label{display:block;font-size:14px;font-weight:600;margin:10px 0 4px}input[type=text],textarea{width:100%;font:inherit;padding:12px;border:1px solid #cdd7e3;border-radius:12px;background:white}textarea{min-height:90px}.check{display:flex;gap:10px;align-items:flex-start;font-weight:500;margin:14px 0}.check input{margin-top:5px;width:18px;height:18px}details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:14px;padding:8px 0}
.banner{border-radius:16px;padding:16px 18px;margin:0 0 14px;font-size:15px}.banner.ok{background:#e4f6ef;color:#075e49;border:1px solid #bfe8d9}.banner.bad{background:#fdecec;color:#8f1d14;border:1px solid #f6c9c5}.banner.info{background:#eef2f7;color:#40516b;border:1px solid var(--line)}.banner b{display:block;font-size:17px;margin-bottom:2px}
footer{text-align:center;font-size:12px;color:var(--muted);padding:8px 16px 30px}@media(max-width:480px){.meta{grid-template-columns:1fr}h1{font-size:21px}.total strong{font-size:24px}}`;

function publicShell(title, content) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${PUBLIC_STYLE}</style></head><body><header><div><img src="/assets/donnar-tech-logo-240.png" alt=""><strong>Donnar.Tech</strong></div></header><main>${content}</main><footer>เอกสารนี้ส่งถึงคุณผ่าน LINE Official Account ของ Donnar.Tech · มีคำถามตอบกลับในแชต LINE ได้เลย</footer></body></html>`;
}

function publicQuotationPage({ quotation, items, token, today, notice = '', error = '' }) {
  const status = effectiveStatus(quotation, today);
  const seller = quotation.seller_json || {};
  const buyer = quotation.buyer_json || {};
  const base = `/q/${encodeURIComponent(token)}`;
  const tone = { ACCEPTED: 'accepted', REJECTED: 'rejected', SENT: '' }[status] ?? 'muted';
  const banners = {
    ACCEPTED: ['ok', 'ยืนยันใบเสนอราคาแล้ว', `ขอบคุณที่ไว้วางใจ Donnar.Tech${quotation.decision_name ? ` · ยืนยันโดย ${quotation.decision_name}` : ''} ทีมงานจะติดต่อกลับในแชต LINE เพื่อเริ่มขั้นตอนถัดไป`],
    REJECTED: ['bad', 'ปฏิเสธใบเสนอราคาแล้ว', 'ขอบคุณสำหรับการแจ้งกลับ หากต้องการปรับขอบเขตงานหรืองบประมาณ บอกทีมในแชต LINE ได้เลย'],
    EXPIRED: ['info', 'ใบเสนอราคานี้หมดอายุแล้ว', 'ติดต่อทีมในแชต LINE เพื่อขอใบเสนอราคาฉบับใหม่'],
    SUPERSEDED: ['info', 'ใบเสนอราคานี้ถูกแทนที่ด้วยฉบับใหม่แล้ว', 'กรุณาเปิดลิงก์ฉบับล่าสุดที่ทีมส่งให้ในแชต LINE'],
    CANCELLED: ['info', 'ใบเสนอราคานี้ถูกยกเลิกแล้ว', 'หากมีคำถาม ติดต่อทีมในแชต LINE ได้เลย'],
  }[status];
  const banner = banners ? `<div class="banner ${banners[0]}"><b>${escapeHtml(banners[1])}</b>${escapeHtml(banners[2])}${status === 'ACCEPTED' || status === 'REJECTED' ? `<div class="muted" style="margin-top:4px">${escapeHtml(formatThaiDateTime(quotation.decided_at))}</div>` : ''}</div>` : '';
  const summary = [...summaryRows(quotation).map(([label, value]) => `<div><span>${escapeHtml(label)}</span><span class="num">${formatMoney(value)}</span></div>`), `<div class="strong"><span>รวมทั้งสิ้น</span><span class="num">${formatMoney(quotation.total_satang)}</span></div>`, quotation.withholding_rate_bp ? `<div><span>หัก ณ ที่จ่าย ${quotation.withholding_rate_bp / 100}% (จากยอดก่อน VAT)</span><span class="num">${formatMoney(-quotation.withholding_satang)}</span></div><div class="strong"><span>ยอดชำระสุทธิ</span><span class="num">${formatMoney(quotation.total_satang - quotation.withholding_satang)}</span></div>` : ''].join('');
  const decisionForms = status === 'SENT' ? `<section class="card" id="respond"><h2>ยืนยันใบเสนอราคา</h2>${error ? `<div class="banner bad">${escapeHtml(error)}</div>` : ''}<form method="post" action="${base}/accept"><label for="accept-name">ชื่อผู้มีอำนาจอนุมัติ</label><input type="text" id="accept-name" name="name" maxlength="120" required autocomplete="name" placeholder="ชื่อ-นามสกุล"><label class="check"><input type="checkbox" name="agree" required> <span>ข้าพเจ้ายอมรับรายการ ราคา และเงื่อนไขตามใบเสนอราคา ${escapeHtml(quotationLabel(quotation))}</span></label><button class="button accept" type="submit">ยอมรับใบเสนอราคา</button></form><details><summary>ไม่ต้องการดำเนินการต่อ</summary><form method="post" action="${base}/reject"><label for="reject-reason">เหตุผล (ไม่บังคับ)</label><textarea id="reject-reason" name="reason" maxlength="1000" placeholder="เช่น งบประมาณไม่พอ ต้องการปรับขอบเขตงาน"></textarea><button class="button reject" type="submit" style="margin-top:10px">ปฏิเสธใบเสนอราคา</button></form></details></section>` : '';
  return publicShell(`ใบเสนอราคา ${quotationLabel(quotation)} · ${seller.name || 'Donnar.Tech'}`, `${notice}${banner}
<section class="card"><div class="eyebrow">ใบเสนอราคา · Quotation</div><h1>${escapeHtml(quotation.title || quotationLabel(quotation))}</h1><div><span class="status ${tone}">${escapeHtml(STATUS_LABELS[status] || status)}</span> <span class="muted">${escapeHtml(quotationLabel(quotation))}</span></div>
<div class="meta"><div><b>ผู้เสนอราคา</b>${escapeHtml(seller.name || 'Donnar.Tech')}</div><div><b>เสนอถึง</b>${escapeHtml(buyer.companyName || '-')}</div><div><b>วันที่</b>${escapeHtml(formatThaiDate(quotation.issue_date))}</div><div><b>ยืนราคาถึง</b>${escapeHtml(formatThaiDate(quotation.valid_until))}</div></div>
<div class="total"><span>ยอดรวมทั้งสิ้น (บาท)</span><strong>${formatMoney(quotation.total_satang)}</strong></div><p class="baht">(${escapeHtml(bahtText(quotation.total_satang))})</p>
<p style="margin:14px 0 0"><a class="button secondary" href="${base}/pdf">ดาวน์โหลดใบเสนอราคา (PDF)</a></p></section>
${decisionForms}
<section class="card"><h2>รายการ</h2>${items.map((item, index) => `<div class="item"><p><b>${index + 1}.</b> ${escapeHtml(item.description)}</p><div class="calc"><span>${formatQuantity(item.quantity_hundredths)} ${escapeHtml(item.unit || '')} × ${formatMoney(item.unit_price_satang)}</span><b>${formatMoney(item.amount_satang)}</b></div></div>`).join('')}<div class="rows" style="margin-top:10px">${summary}</div></section>
${quotation.payment_terms || quotation.notes || seller.bankAccount ? `<section class="card">${quotation.payment_terms ? `<h2>เงื่อนไขการชำระเงิน</h2><p style="white-space:pre-wrap;margin-top:0">${escapeHtml(quotation.payment_terms)}</p>` : ''}${seller.bankAccount ? `<h2>ช่องทางการชำระเงิน</h2><p style="white-space:pre-wrap;margin-top:0">${escapeHtml(seller.bankAccount)}</p>` : ''}${quotation.notes ? `<h2>หมายเหตุ</h2><p style="white-space:pre-wrap;margin:0">${escapeHtml(quotation.notes)}</p>` : ''}</section>` : ''}`);
}

function publicNotFoundPage() {
  return publicShell('ไม่พบใบเสนอราคา · Donnar.Tech', '<section class="card"><h1>ไม่พบใบเสนอราคา</h1><p class="muted">ลิงก์อาจไม่ถูกต้องหรือหมดอายุแล้ว กรุณาเปิดลิงก์ล่าสุดที่ทีมส่งให้ในแชต LINE</p></section>');
}

module.exports = { ADMIN_STYLE, quotationListPage, quotationEditorPage, quotationViewPage, conversationQuotationPanel, decisionPanel, publicQuotationPage, publicNotFoundPage, editorModel, formModel };
