'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const history = document.getElementById('message-history');
  if (!history) return;
  history.scrollTop = history.scrollHeight;
});
