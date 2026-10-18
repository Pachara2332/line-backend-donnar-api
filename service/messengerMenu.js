const { persistentMenu } = require('./messengerResponses');
const { escapeHtml } = require('./html');

function messengerMenuPage({ rows, csrfToken, enabled }) {
  const menu = persistentMenu()[0].call_to_actions;
  const preview = menu.map((item) => `<div class="requirement"><b>${escapeHtml(item.title)}</b>${escapeHtml(item.payload)}</div>`).join('');
  const publications = rows.map((row) => `<div class="requirement"><b>${escapeHtml(row.status)} · ${escapeHtml(row.created_by)}</b>${row.status === 'PUBLISHED' || row.status === 'REPLACED' ? 'ตั้งค่าบนเพจแล้ว' : 'ยังไม่เผยแพร่'}${row.last_error ? `<p class="muted">${escapeHtml(row.last_error)}</p>` : ''}<small>${escapeHtml(new Date(row.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }))}</small></div>
    ${['DRAFT', 'FAILED'].includes(row.status) ? `<form method="post" action="/admin/messenger-menu/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="publication_id" value="${Number(row.id)}"><label><input style="width:auto" type="checkbox" name="confirm" value="publish" required> ยืนยันเผยแพร่เมนูไปยัง Facebook Page</label><button type="submit" ${enabled ? '' : 'disabled'}>เผยแพร่เมนู</button></form><form method="post" action="/admin/messenger-menu/draft/${Number(row.id)}/cancel"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" type="submit">ยกเลิกร่าง</button></form>` : ''}`).join('') || '<p class="muted">ยังไม่มีฉบับร่างหรือประวัติการเผยแพร่</p>';
  return `<section class="card"><div class="eyebrow">FACEBOOK MESSENGER</div><h1>เมนู Messenger</h1><p class="muted">พรีวิวก่อนสร้างฉบับร่าง และต้องยืนยันอีกครั้งก่อนส่งเมนูไปยังเพจจริง</p>${enabled ? '' : '<div class="danger-note">Messenger ยังไม่เปิดใช้งาน ต้องตั้งค่า credentials ใน environment ให้ครบก่อน</div>'}<div class="grid">${preview}</div><form method="post" action="/admin/messenger-menu/draft"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit">สร้างฉบับร่างจากเมนูตัวอย่าง</button></form></section><section class="card"><h2>ฉบับร่างและประวัติ</h2>${publications}</section>`;
}

module.exports = { messengerMenuPage };
