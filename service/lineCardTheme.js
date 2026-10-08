const CARD_THEME = {
  ink: '#10213D',
  aqua: '#16C7C2',
  aquaLight: '#74DDD6',
  blue: '#1478F2',
  teal: '#087D83',
  orange: '#F47721',
  text: '#10213D',
  muted: '#4C5B70',
  canvas: '#F4F7FB',
  line: '#D8E1EB',
};

function brandHeader(eyebrow, title, accent = CARD_THEME.aqua) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: CARD_THEME.ink,
    paddingAll: '22px',
    spacing: 'md',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        justifyContent: 'space-between',
        contents: [
          { type: 'text', text: 'DONNAR.TECH', size: 'xs', weight: 'bold', color: CARD_THEME.aquaLight },
          { type: 'text', text: String(eyebrow || '').toUpperCase(), size: 'xs', weight: 'bold', color: '#D3DEEB', align: 'end', wrap: true },
        ],
      },
      { type: 'text', text: title, size: 'xl', weight: 'bold', color: '#FFFFFF', wrap: true, margin: 'sm' },
      { type: 'separator', color: accent, margin: 'sm' },
    ],
  };
}

function brandBody(description, note = 'วางแผนและพัฒนาซอฟต์แวร์สำหรับธุรกิจ') {
  return {
    type: 'box',
    layout: 'vertical',
    paddingAll: '22px',
    spacing: 'lg',
    backgroundColor: '#FFFFFF',
    contents: [
      { type: 'text', text: description, size: 'md', color: CARD_THEME.text, wrap: true, lineSpacing: '5px' },
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        margin: 'sm',
        contents: [
          { type: 'text', text: '●', size: 'xxs', color: CARD_THEME.aqua, flex: 0 },
          { type: 'text', text: `Donnar.Tech · ${note}`, size: 'xs', color: CARD_THEME.muted, wrap: true, flex: 1 },
        ],
      },
    ],
  };
}

function brandFooter(actions) {
  if (!actions?.length) return undefined;
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    paddingAll: '16px',
    backgroundColor: CARD_THEME.canvas,
    contents: actions,
  };
}

function brandBubble({ eyebrow, title, accent, description, footer = [], note }) {
  const contents = {
    type: 'bubble',
    size: 'mega',
    header: brandHeader(eyebrow, title, accent),
    body: brandBody(description, note),
    styles: { body: { backgroundColor: '#FFFFFF' }, footer: { backgroundColor: CARD_THEME.canvas } },
  };
  const footerBlock = brandFooter(footer);
  if (footerBlock) contents.footer = footerBlock;
  return { type: 'flex', altText: `${title} — Donnar.Tech`, contents };
}

module.exports = { CARD_THEME, brandBubble };
