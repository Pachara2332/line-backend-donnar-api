'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const inbox = document.getElementById('inbox');
  if (!inbox) return;

  const history = document.getElementById('message-history');
  const leadList = inbox.querySelector('.lead-list');
  let selectedConversation = inbox.dataset.selectedConversation || '';
  const pendingUpdates = new Set();
  const retryingUpdates = new Set();
  let updateTimer = null;
  let notice;

  if (history) history.scrollTop = history.scrollHeight;

  const statusLabels = { NEW: 'ลูกค้าใหม่', QUALIFYING: 'กำลังเก็บข้อมูล', QUALIFIED: 'คัดกรองแล้ว', HUMAN_REQUIRED: 'รอพนักงาน' };
  const stepLabels = { serviceType: 'ประเภทงาน', projectSummary: 'รายละเอียดโปรเจกต์', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ', complete: 'เก็บข้อมูลครบแล้ว' };

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value || '');
    return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(date);
  }

  function createIdentity(conversation, size) {
    const identity = document.createElement('div');
    identity.className = 'profile-identity';
    let avatar;
    try {
      const picture = new URL(conversation.pictureUrl || '');
      if (picture.protocol === 'https:') {
        avatar = document.createElement('img');
        avatar.className = 'profile-avatar';
        avatar.width = size;
        avatar.height = size;
        avatar.src = picture.href;
        avatar.alt = '';
      }
    } catch {}
    if (!avatar) {
      avatar = document.createElement('span');
      avatar.className = 'profile-avatar-fallback';
      avatar.setAttribute('role', 'img');
      avatar.setAttribute('aria-label', 'ไม่มีรูปโปรไฟล์ LINE');
      avatar.textContent = 'LINE';
    }
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = conversation.displayName || conversation.lineUserId;
    const userId = document.createElement('small');
    userId.textContent = conversation.lineUserId;
    text.append(name, userId);
    identity.append(avatar, text);
    return identity;
  }

  function createMessage(message) {
    const bubble = document.createElement('div');
    bubble.className = `message ${message.direction === 'IN' ? 'in' : 'out'}`;
    bubble.dataset.messageId = String(message.id);
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const pending = message.direction === 'OUT' && !['SENT', 'CANCELLED'].includes(message.sendStatus);
    const delivery = pending ? ` · ${message.sendStatus}${message.lastError ? ` (${message.lastError})` : ''}` : '';
    meta.textContent = `${message.direction === 'IN' ? 'ลูกค้า' : 'Donnar.Tech'} · ${formatDate(message.createdAt)}${delivery}`;
    bubble.append(meta, document.createTextNode(message.text || ''));
    return bubble;
  }

  function currentHref(conversationId) {
    const query = new URLSearchParams(window.location.search);
    query.set('conversation', String(conversationId));
    return `/admin/inbox?${query.toString()}`;
  }

  function updateLeadRow(row, conversation, summary) {
    row.className = `lead-link${String(conversation.id) === selectedConversation ? ' selected' : ''}`;
    row.dataset.conversationId = String(conversation.id);
    row.href = currentHref(conversation.id);
    const top = document.createElement('div');
    top.className = 'lead-link-top';
    const mode = document.createElement('span');
    mode.className = `mode-tag ${conversation.mode === 'HUMAN' ? 'human' : 'bot'}`;
    mode.textContent = conversation.mode === 'HUMAN' ? 'รอทีมตอบ' : 'บอตดูแล';
    top.append(createIdentity(conversation, 34), mode);
    const meta = document.createElement('div');
    meta.className = 'lead-meta';
    const status = document.createElement('span');
    status.textContent = statusLabels[conversation.status] || conversation.status;
    const separator = document.createElement('span');
    separator.textContent = '·';
    const step = document.createElement('span');
    step.textContent = stepLabels[conversation.currentStep] || conversation.currentStep;
    meta.append(status, separator, step);
    const preview = document.createElement('div');
    preview.className = 'lead-preview';
    const requirementSummary = Object.values(conversation.requirements || {}).find((value) => typeof value === 'string');
    preview.textContent = summary || requirementSummary || 'เริ่มต้นบทสนทนา';
    row.replaceChildren(top, meta, preview);
  }

  function matchesCurrentFilters(conversation, summary) {
    const mode = inbox.querySelector('[name="mode"]')?.value || '';
    const status = inbox.querySelector('[name="status"]')?.value || '';
    const search = inbox.querySelector('[name="q"]')?.value.trim().toLocaleLowerCase() || '';
    if (mode && conversation.mode !== mode) return false;
    if (status && conversation.status !== status) return false;
    if (!search) return true;
    const values = [conversation.displayName, conversation.lineUserId, conversation.status, conversation.currentStep, summary, ...Object.values(conversation.requirements || {})];
    return values.join(' ').toLocaleLowerCase().includes(search);
  }

  function updateLeadList(conversation, summary) {
    if (!leadList) return;
    const id = String(conversation.id);
    let row = Array.from(leadList.querySelectorAll('.lead-link')).find((item) => item.dataset.conversationId === id);
    if (!row && !matchesCurrentFilters(conversation, summary)) return;
    if (!row) {
      row = document.createElement('a');
      leadList.querySelector('.empty-state')?.remove();
    }
    updateLeadRow(row, conversation, summary);
    leadList.prepend(row);
    while (leadList.querySelectorAll('.lead-link').length > 100) leadList.lastElementChild.remove();
    const leadCount = document.getElementById('lead-count');
    if (leadCount) leadCount.textContent = `(${leadList.querySelectorAll('.lead-link').length})`;
  }

  function updateSelectedDetails(conversation) {
    const detail = inbox.querySelector('.inbox-detail');
    if (!detail || String(conversation.id) !== selectedConversation) return;
    const statusTag = detail.querySelector('.detail-head .tag');
    if (statusTag) statusTag.textContent = statusLabels[conversation.status] || conversation.status;
    const modeTag = detail.querySelector('.detail-head .mode-tag');
    if (modeTag) {
      modeTag.className = `mode-tag ${conversation.mode === 'HUMAN' ? 'human' : 'bot'}`;
      modeTag.textContent = conversation.mode === 'HUMAN' ? 'พนักงานดูแล' : 'บอตดูแล';
    }
    const modeForm = detail.querySelector('.detail-head form');
    const modeInput = modeForm?.querySelector('[name="mode"]');
    const modeButton = modeForm?.querySelector('button');
    const previousMode = modeInput?.value === 'BOT' ? 'HUMAN' : 'BOT';
    const modeChanged = modeInput && previousMode !== conversation.mode;
    if (modeInput) modeInput.value = conversation.mode === 'BOT' ? 'HUMAN' : 'BOT';
    if (modeButton) {
      modeButton.className = conversation.mode === 'BOT' ? '' : 'secondary';
      modeButton.textContent = conversation.mode === 'BOT' ? 'รับช่วงตอบลูกค้า' : 'ส่งคืนให้บอต';
    }
    const requirementLabels = { serviceType: 'ประเภทงาน', projectSummary: 'รายละเอียดโปรเจกต์', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ' };
    const requirements = detail.querySelector('#conversation-requirements');
    if (requirements) {
      const entries = Object.entries(conversation.requirements || {});
      if (entries.length) {
        requirements.replaceChildren(...entries.map(([key, value]) => {
          const row = document.createElement('div');
          row.className = 'requirement';
          const label = document.createElement('b');
          label.textContent = requirementLabels[key] || key;
          row.append(label, document.createTextNode(String(value)));
          return row;
        }));
      } else {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.style.fontSize = '13px';
        empty.textContent = 'ยังไม่มีข้อมูลจากแบบสอบถาม';
        requirements.replaceChildren(empty);
      }
    }
    const currentStep = detail.querySelector('#conversation-current-step');
    if (currentStep) currentStep.lastChild.textContent = stepLabels[conversation.currentStep] || conversation.currentStep;
    const leadStatus = detail.querySelector('#conversation-lead-status');
    if (leadStatus) leadStatus.lastChild.textContent = statusLabels[conversation.status] || conversation.status;
    const composer = detail.querySelector('.composer');
    if (!composer || !modeChanged || !modeInput?.form) return;
    const csrfToken = modeForm.querySelector('[name="_csrf"]')?.value;
    if (conversation.mode === 'HUMAN') {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = `/admin/conversations/${conversation.id}/reply`;
      const csrf = document.createElement('input');
      csrf.type = 'hidden';
      csrf.name = '_csrf';
      csrf.value = csrfToken || '';
      const textarea = document.createElement('textarea');
      textarea.name = 'text';
      textarea.maxLength = 2000;
      textarea.placeholder = 'พิมพ์ข้อความตอบลูกค้า…';
      textarea.setAttribute('aria-label', 'ข้อความตอบลูกค้า');
      textarea.required = true;
      const button = document.createElement('button');
      button.type = 'submit';
      button.append(document.createTextNode('ส่งข้อความ '));
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '➤';
      button.append(icon);
      form.append(csrf, textarea, button);
      const help = document.createElement('p');
      help.className = 'composer-help';
      help.textContent = 'กด “ส่งคืนให้บอต” เมื่อพร้อมให้บอตดูแลบทสนทนาต่อ';
      composer.replaceChildren(form, help);
    } else {
      const note = document.createElement('div');
      note.className = 'danger-note';
      note.textContent = 'บอตกำลังดูแลบทสนทนานี้ หากต้องการตอบลูกค้า ให้กด “รับช่วงตอบลูกค้า” ก่อน';
      composer.replaceChildren(note);
    }
  }

  function showNotice(conversation) {
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'danger-note';
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.style.display = 'flex';
      notice.style.alignItems = 'center';
      notice.style.justifyContent = 'space-between';
      notice.style.gap = '12px';
      notice.style.marginBottom = '12px';
      inbox.parentNode.insertBefore(notice, inbox);
    }
    const text = document.createElement('span');
    text.textContent = `มีข้อความใหม่จาก ${conversation.displayName || conversation.lineUserId}`;
    const link = document.createElement('a');
    link.className = 'button secondary';
    link.href = `/admin/inbox?conversation=${encodeURIComponent(conversation.id)}`;
    link.textContent = 'เปิดบทสนทนา';
    notice.replaceChildren(text, link);
  }

  function applyUpdate(data) {
    const conversation = data.conversation;
    const id = String(conversation.id);
    const latest = data.messages[data.messages.length - 1];
    updateLeadList(conversation, latest?.text || '');
    if (id === selectedConversation && history) {
      updateSelectedDetails(conversation);
      const wasAtBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
      const distanceFromBottom = history.scrollHeight - history.scrollTop;
      history.replaceChildren(...data.messages.map(createMessage));
      if (wasAtBottom) history.scrollTop = history.scrollHeight;
      else history.scrollTop = Math.max(0, history.scrollHeight - distanceFromBottom);
    } else {
      showNotice(conversation);
    }
  }

  async function refreshConversation(conversationId) {
    const includeMessages = String(conversationId) === selectedConversation ? '1' : '0';
    const response = await fetch(`/admin/inbox/updates/${encodeURIComponent(conversationId)}?messages=${includeMessages}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      window.location.reload();
      return;
    }
    if (!response.ok) throw new Error('Inbox update failed');
    applyUpdate(await response.json());
    retryingUpdates.delete(String(conversationId));
  }

  async function flushUpdates() {
    updateTimer = null;
    const ids = Array.from(pendingUpdates);
    pendingUpdates.clear();
    await Promise.all(ids.map((id) => refreshConversation(id).catch(() => {
      if (!retryingUpdates.has(id)) {
        retryingUpdates.add(id);
        window.setTimeout(() => queueUpdate(id), 1000);
      } else retryingUpdates.delete(id);
    })));
    if (pendingUpdates.size && !updateTimer) updateTimer = window.setTimeout(flushUpdates, 80);
  }

  function queueUpdate(conversationId) {
    const id = String(Number(conversationId));
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return;
    pendingUpdates.add(id);
    if (!updateTimer) updateTimer = window.setTimeout(flushUpdates, 80);
  }

  const cursor = inbox.dataset.inboxEventId || '0';
  const events = new EventSource(`/admin/inbox/events?after=${encodeURIComponent(cursor)}`);
  events.addEventListener('inbox-update', (event) => {
    try { queueUpdate(JSON.parse(event.data).conversationId); } catch {}
  });
  events.addEventListener('inbox-reset', () => window.location.reload());
});
