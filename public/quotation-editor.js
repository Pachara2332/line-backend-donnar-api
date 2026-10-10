'use strict';

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-confirm]').forEach((element) => {
    element.addEventListener(element.tagName === 'FORM' ? 'submit' : 'click', (event) => {
      if (!window.confirm(element.getAttribute('data-confirm'))) event.preventDefault();
    });
  });

  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const input = document.getElementById(button.getAttribute('data-copy'));
      if (!input) return;
      try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
      const label = button.textContent;
      button.textContent = 'คัดลอกแล้ว';
      setTimeout(() => { button.textContent = label; }, 1600);
    });
  });

  const form = document.querySelector('form.q-editor');
  if (!form) return;
  const body = document.getElementById('quotation-items');
  const template = document.getElementById('item-row-template');
  const vatBp = Number(form.getAttribute('data-vat-bp') || 0);

  function toCents(value) {
    const text = String(value || '').replace(/[,\s]/g, '');
    if (!/^\d{1,13}(\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  }
  function money(cents) {
    const sign = cents < 0 ? '-' : '';
    const absolute = Math.abs(cents);
    return `${sign}${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
  }
  function rate(amount, bp) { return Math.floor((amount * bp + 5000) / 10000); }

  function recalculate() {
    let subtotal = 0;
    body.querySelectorAll('tr.item-row').forEach((row, index) => {
      row.querySelector('.col-no').textContent = String(index + 1);
      const quantity = toCents(row.querySelector('[name=item_quantity]').value || '1');
      const price = toCents(row.querySelector('[name=item_unit_price]').value);
      const cell = row.querySelector('[data-amount]');
      if (quantity === null || price === null) { cell.textContent = '–'; return; }
      const amount = Math.floor((quantity * price + 50) / 100);
      subtotal += amount;
      cell.textContent = money(amount);
    });
    const discount = toCents(form.elements.discount.value) || 0;
    const base = subtotal - discount;
    const vat = rate(base, vatBp);
    const total = base + vat;
    const withholdingOn = form.elements.withholding.checked;
    const withholding = withholdingOn ? rate(base, 300) : 0;
    const values = { subtotal, discount: -discount, vat, total, withholding: -withholding, net: total - withholding };
    form.querySelectorAll('[data-total]').forEach((cell) => { cell.textContent = money(values[cell.getAttribute('data-total')]); });
    form.querySelectorAll('[data-withholding-row]').forEach((row) => { row.hidden = !withholdingOn; });
  }

  document.getElementById('add-item').addEventListener('click', () => {
    body.appendChild(template.content.firstElementChild.cloneNode(true));
    recalculate();
    body.lastElementChild.querySelector('textarea').focus();
  });
  body.addEventListener('click', (event) => {
    const button = event.target.closest('.remove-item');
    if (!button) return;
    const row = button.closest('tr');
    if (body.querySelectorAll('tr.item-row').length > 1) row.remove();
    else row.querySelectorAll('input, textarea').forEach((field) => { field.value = ''; });
    recalculate();
  });

  const branchType = form.elements.buyer_branch_type;
  const branchCode = form.elements.buyer_branch_code;
  function toggleBranch() { branchCode.hidden = branchType.value !== 'BRANCH'; }
  branchType.addEventListener('change', toggleBranch);
  toggleBranch();

  form.addEventListener('input', recalculate);
  form.addEventListener('change', recalculate);
  recalculate();
});
