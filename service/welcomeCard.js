const ACTIONS = [
  { label: 'ปรึกษาโปรเจกต์', data: 'action=START_QUALIFY', displayText: 'อยากปรึกษาโปรเจกต์', color: '#0875F5' },
  { label: 'ดูบริการของเรา', data: 'action=SERVICES', displayText: 'ขอดูบริการ', color: '#12A8E8' },
  { label: 'คุยกับทีม', data: 'action=HUMAN', displayText: 'คุยกับคน', color: '#0B1E38' },
];

function buildWelcomeCard(greeting, liffId = '') {
  const text = String(greeting || '').trim() || 'ยินดีต้อนรับสู่ Donnar.Tech เราช่วยวางแผนและพัฒนาซอฟต์แวร์สำหรับธุรกิจครับ';
  return {
    type: 'flex',
    altText: text.slice(0, 400),
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0B1E38',
        paddingAll: '22px',
        contents: [
          { type: 'text', text: 'DONNAR.TECH', size: 'sm', weight: 'bold', color: '#55E2C0' },
          { type: 'text', text: 'เริ่มต้นคุยเรื่องโปรเจกต์', size: 'xl', weight: 'bold', color: '#FFFFFF', wrap: true, margin: 'md' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '22px',
        spacing: 'md',
        contents: [
          { type: 'text', text, size: 'md', color: '#26384D', wrap: true },
          { type: 'separator', margin: 'lg', color: '#DCE7F2' },
          { type: 'text', text: 'เลือกหัวข้อที่สนใจได้เลยครับ', size: 'sm', color: '#61758B', margin: 'lg', wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '18px',
        contents: ACTIONS.map(({ label, data, displayText, color }) => ({
          type: 'button',
          style: 'primary',
          color,
          height: 'md',
          action: liffId && data === 'action=START_QUALIFY' ? { type: 'uri', label, uri: `https://liff.line.me/${liffId}` } : { type: 'postback', label, data, displayText },
        })),
      },
      styles: { body: { backgroundColor: '#F7FAFE' }, footer: { backgroundColor: '#FFFFFF' } },
    },
  };
}

module.exports = { buildWelcomeCard };
