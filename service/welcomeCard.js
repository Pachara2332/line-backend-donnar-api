const { CARD_THEME, brandBubble } = require('./lineCardTheme');

const ACTIONS = [
  { label: 'ปรึกษาโปรเจกต์', data: 'action=START_QUALIFY', displayText: 'อยากปรึกษาโปรเจกต์', color: CARD_THEME.teal },
  { label: 'ดูบริการของเรา', data: 'action=SERVICES', displayText: 'ขอดูบริการ', color: CARD_THEME.blue },
  { label: 'คุยกับทีม', data: 'action=HUMAN', displayText: 'คุยกับคน', color: CARD_THEME.ink },
];

function buildWelcomeCard(greeting, liffId = '') {
  const text = String(greeting || '').trim() || 'ยินดีต้อนรับสู่ Donnar.Tech เราช่วยวางแผนและพัฒนาซอฟต์แวร์สำหรับธุรกิจครับ';
  const message = brandBubble({
    eyebrow: 'LINE OA · เริ่มต้นที่นี่',
    title: 'ยินดีต้อนรับ',
    accent: CARD_THEME.aqua,
    description: `${text}\n\nเลือกหัวข้อที่สนใจจากปุ่มด้านล่างได้เลยครับ`,
    footer: ACTIONS.map(({ label, data, displayText, color }) => ({
      type: 'button',
      style: 'primary',
      color,
      height: 'md',
      action: liffId && data === 'action=START_QUALIFY'
        ? { type: 'uri', label, uri: `https://liff.line.me/${liffId}` }
        : { type: 'postback', label, data, displayText },
    })),
    note: 'เลือกบริการหรือเริ่มเล่าโจทย์ได้เลย',
  });
  message.altText = text.slice(0, 400);
  return message;
}

module.exports = { buildWelcomeCard };
