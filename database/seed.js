const { DEFAULT_COPY } = require('../service/messageCatalog');

const PREVIOUS_DEFAULT_COPY = {
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

async function seedDefaultCopy(client) {
  for (const [key, body] of Object.entries(DEFAULT_COPY)) {
    const { rows } = await client.query("SELECT id, revision, body FROM message_revisions WHERE message_key = $1 AND status = 'PUBLISHED' ORDER BY revision DESC LIMIT 1 FOR UPDATE", [key]);
    const published = rows[0];
    if (!published) {
      const { rows: revisions } = await client.query('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM message_revisions WHERE message_key = $1', [key]);
      await client.query("INSERT INTO message_revisions(message_key, revision, body, status, published_at) VALUES ($1, $2, $3, 'PUBLISHED', CURRENT_TIMESTAMP) ON CONFLICT (message_key, revision) DO NOTHING", [key, Number(revisions[0].next), body]);
      continue;
    }
    if (PREVIOUS_DEFAULT_COPY[key] !== published.body) continue;
    await client.query("UPDATE message_revisions SET status = 'DRAFT', published_at = NULL WHERE id = $1 AND status = 'PUBLISHED'", [published.id]);
    await client.query("INSERT INTO message_revisions(message_key, revision, body, status, published_at) VALUES ($1, $2, $3, 'PUBLISHED', CURRENT_TIMESTAMP) ON CONFLICT (message_key, revision) DO NOTHING", [key, Number(published.revision) + 1, body]);
  }
}

module.exports = { seedDefaultCopy };

if (require.main === module) {
  require('dotenv').config();
  const { createDatabase, migrateDatabase, withTransaction } = require('./index');
  (async () => {
    const pool = createDatabase();
    try {
      await migrateDatabase(pool);
      await withTransaction(pool, seedDefaultCopy);
      console.info('Default Thai message copy is seeded.');
    } finally { await pool.end(); }
  })().catch(() => {
    console.error('Database seeding failed. Check DATABASE_URL and database availability.');
    process.exitCode = 1;
  });
}
