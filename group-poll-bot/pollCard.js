function buildVoteCard({ pollId, pollTitle, counts, profile }) {
  const displayName = typeof profile?.displayName === 'string' && profile.displayName.trim()
    ? profile.displayName.trim()
    : 'สมาชิกในกลุ่ม';
  const pictureUrl = typeof profile?.pictureUrl === 'string' && /^https:\/\//i.test(profile.pictureUrl)
    ? profile.pictureUrl
    : '';
  const avatar = pictureUrl
    ? { type: 'image', url: pictureUrl, size: '60px', aspectMode: 'cover', aspectRatio: '1:1' }
    : {
      type: 'box',
      layout: 'vertical',
      width: '60px',
      height: '60px',
      cornerRadius: 'xxl',
      backgroundColor: '#E8F1EC',
      justifyContent: 'center',
      alignItems: 'center',
      contents: [{ type: 'text', text: Array.from(displayName)[0] || '?', color: '#245B43', size: 'lg', weight: 'bold' }],
    };
  const altText = `${displayName} โหวต +1: ${pollTitle}`.slice(0, 1500);

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#F3F7F4',
        paddingAll: '18px',
        contents: [
          { type: 'text', text: 'อัปเดตโหวต', color: '#507461', size: 'xs', weight: 'bold' },
          { type: 'text', text: pollTitle, color: '#19372A', size: 'md', weight: 'bold', wrap: true, margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        paddingAll: '18px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            spacing: 'md',
            contents: [
              avatar,
              {
                type: 'box',
                layout: 'vertical',
                flex: 1,
                spacing: 'xs',
                contents: [
                  { type: 'text', text: displayName, color: '#263A30', size: 'sm', weight: 'bold', wrap: true },
                  { type: 'text', text: 'ลงคะแนนเข้าร่วม', color: '#75857C', size: 'xs', wrap: true },
                ],
              },
              { type: 'text', text: '+1', color: '#16834A', size: 'xxl', weight: 'bold', flex: 0 },
            ],
          },
          { type: 'separator', color: '#E5ECE7' },
          {
            type: 'box',
            layout: 'horizontal',
            justifyContent: 'space-between',
            contents: [
              { type: 'text', text: `ไป ${counts.going} คน`, color: '#16834A', size: 'sm', weight: 'bold', flex: 1 },
              { type: 'text', text: `ไม่ไป ${counts.notGoing} คน`, color: '#68756E', size: 'sm', align: 'end', flex: 1 },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#245B43',
            action: { type: 'postback', label: 'สรุปโหวต', data: `action=group_poll_summary&pollId=${pollId}` },
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'postback', label: 'ปิดโหวต', data: `action=group_poll_close&pollId=${pollId}` },
          },
        ],
      },
    },
  };
}

module.exports = { buildVoteCard };
