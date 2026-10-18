const { SERVICE_TYPES, BUDGETS } = require('./liffIntake');

function quickReply(text, values, prefix) {
  return {
    text,
    quick_replies: values.slice(0, 13).map((value, index) => ({
      content_type: 'text',
      title: Array.from(value).slice(0, 20).join(''),
      payload: Array.isArray(prefix) ? prefix[index] : `${prefix}${index}`,
    })),
  };
}

function buildMessengerQuestion(step, customPrompt) {
  const prompts = {
    serviceType: 'เลือกประเภทงานที่ต้องการให้ทีมช่วยดูแลครับ',
    projectSummary: 'อยากแก้ปัญหาหรือทำให้ธุรกิจดีขึ้นอย่างไรครับ?',
    features: 'มีฟีเจอร์หรือระบบหลักที่อยากได้อะไรบ้างครับ? พิมพ์ “ข้าม” ได้',
    audience: 'ใครจะเป็นผู้ใช้งาน และอยากให้รองรับแพลตฟอร์มใดครับ? พิมพ์ “ข้าม” ได้',
    timeline: 'ต้องการเริ่มใช้งานเมื่อไรครับ? พิมพ์ “ข้าม” ได้',
    budgetRange: 'มีงบประมาณโดยประมาณไหมครับ? พิมพ์ “ข้าม” ได้',
    contactPreference: 'สะดวกให้ทีมติดต่อทางไหนครับ?',
  };
  const prompt = customPrompt || prompts[step] || prompts.serviceType;
  if (step === 'serviceType') return quickReply(prompt, SERVICE_TYPES, 'intake:serviceType:');
  if (step === 'budgetRange') return quickReply(prompt, ['ยังไม่แน่ใจ', '< 100,000', '100,000–300,000', '300,000–1,000,000', '> 1,000,000'], 'intake:budgetRange:');
  if (step === 'contactPreference') return quickReply(prompt, ['แชต Facebook', 'นัดประชุมออนไลน์'], 'intake:contactPreference:');
  return { text: prompt };
}

function buildMessengerWelcome(greeting) {
  return quickReply(greeting, ['ดูบริการ', 'ขั้นตอนทำงาน', 'ผลงาน', 'ปรึกษาโปรเจกต์', 'คุยกับทีม'], ['menu:services', 'menu:workflow', 'menu:portfolio', 'menu:intake', 'menu:human']);
}

function buildMessengerServices(description) {
  return quickReply(description, ['ขั้นตอนทำงาน', 'ผลงาน', 'ปรึกษาโปรเจกต์', 'คุยกับทีม'], ['menu:workflow', 'menu:portfolio', 'menu:intake', 'menu:human']);
}

function buildMessengerInfo(description) {
  return quickReply(description, ['ปรึกษาโปรเจกต์', 'คุยกับทีม'], ['menu:intake', 'menu:human']);
}

function buildMessengerHandoff(description) {
  return { text: `${description}\n\nทีม Donnar.Tech จะรับช่วงต่อในแชตนี้ครับ` };
}

function buildMessengerIntakeReceived(description) {
  return { text: description };
}

function buildMessengerQuotation({ label, title, total, validUntil, url }) {
  const text = `ใบเสนอราคา ${label}\n${title ? `${title}\n` : ''}ยอดรวม ${total} บาท\nยืนราคาถึง ${validUntil}`;
  return { attachment: { type: 'template', payload: { template_type: 'button', text, buttons: [{ type: 'web_url', url, title: 'ดูใบเสนอราคา' }] } } };
}

function persistentMenu() {
  return [{ locale: 'default', composer_input_disabled: false, call_to_actions: [
    { type: 'postback', title: 'บริการและผลงาน', payload: 'menu:services' },
    { type: 'postback', title: 'ปรึกษาโปรเจกต์', payload: 'menu:intake' },
    { type: 'postback', title: 'คุยกับทีม', payload: 'menu:human' },
  ] }];
}

module.exports = { buildMessengerQuestion, buildMessengerWelcome, buildMessengerServices, buildMessengerInfo, buildMessengerHandoff, buildMessengerIntakeReceived, buildMessengerQuotation, persistentMenu };
