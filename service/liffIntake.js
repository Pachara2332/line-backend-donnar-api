const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

const SERVICE_TYPES = ['เว็บไซต์', 'เว็บแอป', 'แอปมือถือ', 'ระบบภายในองค์กร', 'Automation / AI', 'อื่น ๆ'];
const BUDGETS = ['ยังไม่แน่ใจ', 'ต่ำกว่า 100,000 บาท', '100,000–300,000 บาท', '300,000–1,000,000 บาท', 'มากกว่า 1,000,000 บาท'];
const CONTACTS = ['แชต LINE', 'นัดประชุมออนไลน์'];
const TEXT_FIELDS = { projectSummary: 1000, features: 1000, audience: 500, timeline: 200 };
const LABELS = { serviceType: 'ประเภทงาน', projectSummary: 'เป้าหมาย/ปัญหา', features: 'ฟีเจอร์หลัก', audience: 'ผู้ใช้และแพลตฟอร์ม', timeline: 'ระยะเวลา', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function channelIdFromLiffId(liffId) {
  return String(liffId || '').split('-')[0];
}

async function verifyIdToken(idToken, channelId, fetchImpl = globalThis.fetch) {
  if (typeof idToken !== 'string' || !idToken || idToken.length > 4096 || !channelId) return null;
  let response;
  try {
    response = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }).toString(),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const claims = await response.json().catch(() => null);
  if (!claims || claims.aud !== channelId || typeof claims.sub !== 'string' || !/^U[0-9a-f]{32}$/.test(claims.sub)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
  return { userId: claims.sub };
}

function parseIntake(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const submissionId = String(body.submissionId || '');
  if (!UUID.test(submissionId)) return null;
  const brief = {};
  if (!SERVICE_TYPES.includes(body.serviceType)) return null;
  brief.serviceType = body.serviceType;
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (body[key] === undefined || body[key] === null) continue;
    if (typeof body[key] !== 'string') return null;
    const value = body[key].trim();
    if (value.length > max) return null;
    if (value) brief[key] = value;
  }
  if (!brief.projectSummary) return null;
  for (const [key, allowed] of [['budgetRange', BUDGETS], ['contactPreference', CONTACTS]]) {
    if (body[key] === undefined || body[key] === '') continue;
    if (!allowed.includes(body[key])) return null;
    brief[key] = body[key];
  }
  brief.contactPreference ||= CONTACTS[0];
  const summary = ['[ฟอร์มปรึกษาโปรเจกต์]', ...Object.entries(brief).map(([key, value]) => `${LABELS[key]}: ${value}`)].join('\n');
  return { submissionId, brief, summary };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function options(list, placeholder) {
  return (placeholder ? `<option value="">${placeholder}</option>` : '') + list.map((item) => `<option>${escapeHtml(item)}</option>`).join('');
}

function intakePage(liffId, nonce) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ปรึกษาโปรเจกต์ · Donnar.Tech</title><style>*{box-sizing:border-box}body{margin:0;background:#f7fafe;color:#16212b;font:16px/1.55 system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:8px 0}label{display:block;margin:14px 0 4px;font-weight:600}.req{color:#c0392b}input,textarea,select{font:inherit;width:100%;padding:10px;border:1px solid #b8c7cb;border-radius:8px;background:white}textarea{min-height:90px}button{margin-top:20px;width:100%;border:0;border-radius:10px;background:#0875f5;color:white;padding:13px;font:inherit;font-weight:600}button:disabled{opacity:.6}.note{color:#61758b;font-size:14px}.box{background:white;border:1px solid #dce7f2;border-radius:12px;padding:18px;margin-top:16px}[hidden]{display:none}</style></head><body><main>
<h1>ปรึกษาโปรเจกต์</h1><p class="note">เล่าโจทย์คร่าว ๆ ได้เลยครับ ช่องที่มี <span class="req">*</span> จำเป็นต้องกรอก</p>
<div id="status" class="box" hidden></div>
<form id="intake" hidden novalidate>
<label for="serviceType">ประเภทงาน <span class="req">*</span></label><select id="serviceType" name="serviceType" required>${options(SERVICE_TYPES, 'เลือกประเภทงาน')}</select>
<label for="projectSummary">อยากแก้ปัญหาหรือบรรลุเป้าหมายอะไร <span class="req">*</span></label><textarea id="projectSummary" name="projectSummary" maxlength="1000" required></textarea>
<label for="features">ฟีเจอร์หรือฟังก์ชันหลัก</label><textarea id="features" name="features" maxlength="1000"></textarea>
<label for="audience">ผู้ใช้งานและแพลตฟอร์ม</label><input id="audience" name="audience" maxlength="500" placeholder="เช่น พนักงานขาย ใช้บนมือถือ">
<label for="timeline">ระยะเวลาที่ต้องการ</label><input id="timeline" name="timeline" maxlength="200" placeholder="เช่น ภายใน 3 เดือน">
<label for="budgetRange">งบประมาณโดยประมาณ</label><select id="budgetRange" name="budgetRange">${options(BUDGETS)}</select>
<label for="contactPreference">ช่องทางติดต่อกลับ</label><select id="contactPreference" name="contactPreference">${options(CONTACTS)}</select>
<p id="error" class="req" role="alert"></p>
<button id="submit" type="submit">ส่งรายละเอียด</button>
</form></main>
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script nonce="${nonce}">
const liffId = ${JSON.stringify(liffId)};
const form = document.getElementById('intake');
const statusBox = document.getElementById('status');
const submissionId = crypto.randomUUID();
function show(html) {
  form.hidden = true; statusBox.hidden = false; statusBox.innerHTML = html;
  const back = document.getElementById('back');
  if (back) back.addEventListener('click', () => { try { liff.closeWindow(); } catch { history.back(); } });
}
const backToChat = '<p><button id="back" type="button">กลับไปที่แชต</button></p>';
function failVerify() { show('<p><b>ยืนยันตัวตน LINE ไม่สำเร็จ</b></p><p>กรุณาเปิดฟอร์มนี้จากปุ่ม “ปรึกษาโปรเจกต์” ในแชต LINE อีกครั้ง หรือพิมพ์รายละเอียดในแชตได้เลยครับ</p>' + backToChat); }
liff.init({ liffId }).then(() => {
  if (!liff.isLoggedIn()) return liff.login({ redirectUri: location.href });
  form.hidden = false;
}).catch(failVerify);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('error');
  if (!form.checkValidity()) { error.textContent = 'กรุณาเลือกประเภทงานและเล่าเป้าหมายของโปรเจกต์'; form.reportValidity(); return; }
  error.textContent = '';
  const idToken = liff.getIDToken();
  if (!idToken) return failVerify();
  const button = document.getElementById('submit');
  button.disabled = true;
  try {
    const response = await fetch('/api/intake/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken, submissionId, ...Object.fromEntries(new FormData(form)) }) });
    if (response.status === 401) return failVerify();
    if (!response.ok) throw new Error('submit failed');
    const result = await response.json();
    show('<p><b>ส่งรายละเอียดเรียบร้อยแล้ว ✓</b></p><p>ทีม Donnar.Tech จะตรวจสอบโจทย์และตอบกลับในแชต LINE</p>' + (result.confirmationSent ? '' : '<p class="note">ระบบส่งข้อความยืนยันในแชตไม่สำเร็จ แต่ข้อมูลถูกบันทึกแล้ว พิมพ์คุยต่อในแชตได้เลยครับ</p>') + backToChat);
  } catch {
    error.textContent = 'ส่งไม่สำเร็จ กรุณาลองอีกครั้ง';
    button.disabled = false;
  }
});
</script></body></html>`;
}

module.exports = { verifyIdToken, parseIntake, intakePage, channelIdFromLiffId, SERVICE_TYPES };
