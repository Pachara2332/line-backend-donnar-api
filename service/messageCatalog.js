const DEFAULT_COPY = {
  greeting: 'สวัสดีครับ 👋 ยินดีต้อนรับสู่ Donnar.Tech เราช่วยวางแผนและพัฒนาซอฟต์แวร์สำหรับธุรกิจ อยากเริ่มจากบริการด้านไหนครับ?',
  serviceType: 'อยากสร้างอะไรหรือสนใจบริการด้านไหนครับ เช่น เว็บไซต์ เว็บแอป โมบายแอป ระบบภายใน หรือ Automation?',
  projectSummary: 'ระบบนี้อยากช่วยแก้ปัญหาอะไรเป็นหลักครับ?',
  budgetRange: 'มีช่วงงบประมาณคร่าว ๆ ไหมครับ? ข้ามได้โดยพิมพ์ “ข้าม”',
  contactPreference: 'สะดวกให้ทีมติดต่อกลับทางแชตนี้ หรือมีช่องทางอื่นที่ต้องการไหมครับ?',
  handoff: 'ได้เลยครับ ผมส่งเรื่องให้ทีม Donnar.Tech แล้ว ทีมจะเห็นรายละเอียดที่คุยกันก่อนหน้านี้และเข้ามาตอบในแชตนี้ครับ',
  services: 'บริการของ Donnar.Tech: Website, Web Application, Mobile Application, Internal System, Dashboard, CRM, Automation และ AI Integration ครับ',
  workflow: 'ขั้นตอนทำงาน: คุยโจทย์และ discovery → กำหนดขอบเขต → เสนอแนวทางและใบเสนอราคา → พัฒนา → ทดสอบและเปิดใช้งานครับ',
  portfolio: 'ดูผลงานและตัวอย่างได้ที่เว็บไซต์ Donnar.Tech หรือส่งโจทย์ให้ทีมช่วยแนะนำผลงานที่ใกล้เคียงได้ครับ',
  fallback: 'ขอบคุณที่ส่งข้อความมาครับ ผมช่วยเก็บโจทย์เบื้องต้นได้ หรือพิมพ์ “คุยกับคน” เพื่อให้ทีมเข้ามาดูแลครับ',
};

function ensureSeeded(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO message_revisions(message_key, revision, body, status, published_at) VALUES (?, 1, ?, 'PUBLISHED', CURRENT_TIMESTAMP)`);
  const transaction = db.transaction(() => {
    for (const [key, body] of Object.entries(DEFAULT_COPY)) insert.run(key, body);
  });
  transaction();
}

function getCopy(db, key) {
  const row = db.prepare("SELECT body FROM message_revisions WHERE message_key = ? AND status = 'PUBLISHED' ORDER BY revision DESC LIMIT 1").get(key);
  return row?.body || DEFAULT_COPY[key] || DEFAULT_COPY.fallback;
}

module.exports = { DEFAULT_COPY, ensureSeeded, getCopy };
