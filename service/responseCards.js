const { CARD_THEME, brandBubble } = require('./lineCardTheme');
const BRAND = { green: CARD_THEME.teal, blue: CARD_THEME.blue, orange: CARD_THEME.orange, aqua: CARD_THEME.aqua };

function button(label, action, color = BRAND.blue) {
  return { type: 'button', style: 'primary', color, height: 'md', action: { ...action, label } };
}

function startAction(liffId) {
  return liffId
    ? { type: 'uri', uri: `https://liff.line.me/${liffId}` }
    : { type: 'postback', data: 'action=CHAT_INTAKE', displayText: 'เริ่มตอบในแชต' };
}

function buildProjectIntakeCard(prompt, liffId = '') {
  const actions = [];
  if (liffId) actions.push(button('กรอกแบบฟอร์ม', { type: 'uri', uri: `https://liff.line.me/${liffId}` }, BRAND.green));
  actions.push(button(liffId ? 'ตอบในแชตแทน' : 'เริ่มตอบในแชต', { type: 'postback', data: 'action=CHAT_INTAKE', displayText: 'เริ่มปรึกษาโปรเจกต์' }));
  const intakeDetails = liffId
    ? 'แบบฟอร์มช่วยเก็บประเภทงาน เป้าหมาย ฟีเจอร์ ผู้ใช้งาน ระยะเวลา และงบประมาณ'
    : 'ในแชตนี้บอกประเภทงานและปัญหาที่อยากแก้ได้ทีละข้อ งบประมาณข้ามได้';
  return brandBubble({
    eyebrow: 'เริ่มโปรเจกต์',
    title: 'เล่าโจทย์ให้ทีมฟัง',
    accent: BRAND.aqua,
    description: `${prompt}\n\n${intakeDetails}`,
    footer: actions,
    note: 'รายละเอียดที่ทราบช่วยให้ทีมเข้าใจโจทย์ได้เร็วขึ้น',
  });
}

function buildServicesCard(description, liffId = '') {
  return brandBubble({
    eyebrow: 'บริการ Donnar.Tech',
    title: 'อยากพัฒนาระบบแบบไหน?',
    accent: BRAND.blue,
    description,
    footer: [
      button('ปรึกษาโปรเจกต์', startAction(liffId), BRAND.blue),
      button('คุยกับทีม', { type: 'postback', data: 'action=HUMAN', displayText: 'คุยกับคน' }, BRAND.orange),
    ],
    note: 'เลือกบริการแล้วเริ่มเล่าโจทย์ให้ทีมได้เลย',
  });
}

function buildInfoCard({ eyebrow, title, description, accent = BRAND.blue, liffId = '' }) {
  return brandBubble({
    eyebrow,
    title,
    accent,
    description,
    footer: [
      button('ปรึกษาโปรเจกต์', startAction(liffId), BRAND.blue),
      button('คุยกับทีม', { type: 'postback', data: 'action=HUMAN', displayText: 'คุยกับคน' }, BRAND.orange),
    ],
    note: 'เริ่มต้นจากเป้าหมายของธุรกิจคุณ',
  });
}

function buildHandoffCard(description) {
  return brandBubble({
    eyebrow: 'ส่งต่อให้ทีม',
    title: 'ทีม Donnar.Tech รับช่วงต่อ',
    accent: BRAND.orange,
    description,
    note: 'ทีมงานรับช่วงต่อในแชตนี้',
  });
}

function buildIntakeReceivedCard(description) {
  return brandBubble({
    eyebrow: 'รับข้อมูลแล้ว',
    title: 'รายละเอียดโปรเจกต์ถูกส่งแล้ว',
    accent: BRAND.aqua,
    description,
    note: 'ข้อมูลถูกบันทึกไว้ให้ทีมตรวจสอบแล้ว',
  });
}

function buildQuotationCard({ label, title, total, validUntil, url }) {
  return brandBubble({
    eyebrow: 'Quotation',
    title: `ใบเสนอราคา ${label}`,
    accent: BRAND.blue,
    description: `${title ? `${title}\n` : ''}ยอดรวม ${total} บาท\nยืนราคาถึง ${validUntil}\n\nเปิดดูรายละเอียด ดาวน์โหลด PDF และยืนยันใบเสนอราคาได้จากปุ่มด้านล่าง`,
    footer: [button('ดูใบเสนอราคา', { type: 'uri', uri: url }, BRAND.blue)],
    note: 'หากต้องการปรับรายละเอียด ตอบกลับในแชตนี้ได้เลย',
  });
}

module.exports = { buildProjectIntakeCard, buildServicesCard, buildInfoCard, buildHandoffCard, buildIntakeReceivedCard, buildQuotationCard };
