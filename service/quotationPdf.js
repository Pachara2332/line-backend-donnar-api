const path = require('node:path');
const fs = require('node:fs');
const PDFDocument = require('pdfkit');
const { formatMoney, formatQuantity, bahtText, formatTaxId, branchLabel, formatThaiDate, formatThaiDateTime, quotationLabel, effectiveStatus, bangkokToday: bangkokDate } = require('./quotations');

const ASSETS = path.join(__dirname, '..', 'assets');
const FONT_REGULAR = fs.readFileSync(path.join(ASSETS, 'fonts', 'Sarabun-Regular.ttf'));
const FONT_BOLD = fs.readFileSync(path.join(ASSETS, 'fonts', 'Sarabun-Bold.ttf'));
const LOGO = fs.readFileSync(path.join(__dirname, '..', 'public', 'donnar-tech-logo-240.png'));
const COLOR = { ink: '#10213D', text: '#1F2D44', muted: '#5B6B82', faint: '#8A97AA', line: '#D8E1EB', canvas: '#F4F7FB', aqua: '#16C7C2', blue: '#1478F2', green: '#0B8F6A' };
const PAGE = { width: 595.28, height: 841.89, margin: 40, footer: 46 };
const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;
const WATERMARKS = { DRAFT: 'ฉบับร่าง', CANCELLED: 'ยกเลิกแล้ว', SUPERSEDED: 'ถูกแทนที่แล้ว', EXPIRED: 'หมดอายุ' };
const WORDS = new Intl.Segmenter('th', { granularity: 'word' });
const GRAPHEMES = new Intl.Segmenter('th', { granularity: 'grapheme' });

function wrap(doc, text, width) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    let pending = '';
    for (const { segment: part } of WORDS.segment(paragraph)) {
      if (/^[(\[{"'“‘]+$/.test(part)) { pending += part; continue; }
      const segment = pending + part;
      pending = '';
      if (doc.widthOfString(line + segment) <= width) { line += segment; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = segment.trimStart();
      if (doc.widthOfString(line) > width) {
        let piece = '';
        for (const { segment: grapheme } of GRAPHEMES.segment(line)) {
          if (piece && doc.widthOfString(piece + grapheme) > width) { lines.push(piece); piece = ''; }
          piece += grapheme;
        }
        line = piece;
      }
    }
    lines.push((line + pending).trimEnd());
  }
  return lines;
}

function font(doc, weight, size, color = COLOR.text) {
  doc.font(weight === 'bold' ? 'TH-B' : 'TH').fontSize(size).fillColor(color);
  return doc;
}

function lineHeight(doc) { return doc._fontSize * 1.42; }

function drawText(doc, text, x, y, width, options = {}) {
  const lines = wrap(doc, text, width);
  const height = lineHeight(doc);
  lines.forEach((line, index) => doc.text(line, x, y + index * height, { width, align: options.align || 'left', lineBreak: false }));
  return lines.length * height;
}

function measure(doc, text, width) { return wrap(doc, text, width).length * lineHeight(doc); }

function sellerTaxLine(seller) {
  if (!seller.taxId) return '';
  return `เลขประจำตัวผู้เสียภาษี ${formatTaxId(seller.taxId)} (${seller.branchCode ? `สาขาที่ ${seller.branchCode}` : 'สำนักงานใหญ่'})`;
}

function drawHeader(doc, quotation, seller) {
  doc.rect(0, 0, PAGE.width, 5).fill(COLOR.aqua);
  doc.image(LOGO, PAGE.margin, 30, { width: 54, height: 54 });
  const sellerX = PAGE.margin + 66;
  const sellerWidth = 250;
  let y = 30;
  font(doc, 'bold', 13, COLOR.ink);
  y += drawText(doc, seller.name || 'Donnar.Tech', sellerX, y, sellerWidth);
  font(doc, 'regular', 8.5, COLOR.muted);
  for (const value of [seller.address, sellerTaxLine(seller), [seller.phone && `โทร ${seller.phone}`, seller.email, seller.website].filter(Boolean).join(' · ')]) {
    if (value) y += drawText(doc, value, sellerX, y, sellerWidth);
  }

  const boxX = 355;
  const boxWidth = PAGE.width - PAGE.margin - boxX;
  font(doc, 'bold', 24, COLOR.ink).text('ใบเสนอราคา', boxX, 24, { width: boxWidth, align: 'right', lineBreak: false });
  font(doc, 'bold', 8.5, COLOR.aqua).text('Q U O T A T I O N', boxX, 58, { width: boxWidth, align: 'right', lineBreak: false });
  const meta = [
    ['เลขที่ / No.', quotationLabel(quotation)],
    ['วันที่ / Date', quotation.issue_date ? formatThaiDate(quotation.issue_date) : 'ยังไม่ได้ออกเอกสาร'],
    ['ยืนราคาถึง / Valid until', quotation.valid_until ? formatThaiDate(quotation.valid_until) : `${quotation.valid_days} วันนับจากวันที่ออก`],
  ];
  const metaY = 78;
  const rowHeight = 17;
  doc.roundedRect(boxX, metaY, boxWidth, meta.length * rowHeight + 10, 6).fill(COLOR.canvas);
  meta.forEach(([label, value], index) => {
    const rowY = metaY + 6 + index * rowHeight;
    font(doc, 'regular', 8.5, COLOR.muted).text(label, boxX + 10, rowY + 1, { width: 95, lineBreak: false });
    font(doc, 'bold', 9.5, COLOR.ink).text(value, boxX + 100, rowY, { width: boxWidth - 110, align: 'right', lineBreak: false });
  });
  return Math.max(y, metaY + meta.length * rowHeight + 10) + 16;
}

function drawParties(doc, quotation, y) {
  const buyer = quotation.buyer_json || {};
  const leftWidth = 320;
  const rightX = PAGE.margin + leftWidth + 12;
  const rightWidth = PAGE.width - PAGE.margin - rightX;
  const lines = [
    buyer.address,
    buyer.taxId ? `เลขประจำตัวผู้เสียภาษี ${formatTaxId(buyer.taxId)} (${branchLabel(buyer)})` : '',
    buyer.contactName ? `ผู้ติดต่อ: ${buyer.contactName}` : '',
    [buyer.phone && `โทร ${buyer.phone}`, buyer.email].filter(Boolean).join(' · '),
  ].filter(Boolean);
  font(doc, 'bold', 11);
  let leftHeight = 30 + measure(doc, buyer.companyName || '-', leftWidth - 24);
  font(doc, 'regular', 9);
  for (const line of lines) leftHeight += measure(doc, line, leftWidth - 24);
  font(doc, 'bold', 11);
  const rightHeight = 30 + measure(doc, quotation.title || '-', rightWidth - 24) + 20;
  const height = Math.max(leftHeight, rightHeight) + 10;

  doc.roundedRect(PAGE.margin, y, leftWidth, height, 6).lineWidth(0.8).strokeColor(COLOR.line).stroke();
  doc.roundedRect(rightX, y, rightWidth, height, 6).lineWidth(0.8).strokeColor(COLOR.line).stroke();
  font(doc, 'bold', 8, COLOR.blue).text('ลูกค้า / CUSTOMER', PAGE.margin + 12, y + 10, { lineBreak: false });
  let cursor = y + 24;
  font(doc, 'bold', 11, COLOR.ink);
  cursor += drawText(doc, buyer.companyName || '-', PAGE.margin + 12, cursor, leftWidth - 24);
  font(doc, 'regular', 9, COLOR.text);
  for (const line of lines) cursor += drawText(doc, line, PAGE.margin + 12, cursor, leftWidth - 24);

  font(doc, 'bold', 8, COLOR.blue).text('โครงการ / PROJECT', rightX + 12, y + 10, { lineBreak: false });
  font(doc, 'bold', 11, COLOR.ink);
  const titleHeight = drawText(doc, quotation.title || '-', rightX + 12, y + 24, rightWidth - 24);
  font(doc, 'regular', 8.5, COLOR.muted).text(`ยืนราคา ${quotation.valid_days} วัน`, rightX + 12, y + 28 + titleHeight, { lineBreak: false });
  return y + height + 18;
}

const COLUMNS = [
  { key: 'index', label: 'ลำดับ', width: 40, align: 'center' },
  { key: 'description', label: 'รายละเอียด', width: 0, align: 'left' },
  { key: 'quantity', label: 'จำนวน', width: 46, align: 'right' },
  { key: 'unit', label: 'หน่วย', width: 46, align: 'center' },
  { key: 'price', label: 'ราคาต่อหน่วย', width: 80, align: 'right' },
  { key: 'amount', label: 'จำนวนเงิน (บาท)', width: 88, align: 'right' },
];
COLUMNS[1].width = CONTENT_WIDTH - COLUMNS.reduce((sum, column) => sum + column.width, 0);
const CELL_PADDING = 6;

function drawTableHeader(doc, y) {
  doc.roundedRect(PAGE.margin, y, CONTENT_WIDTH, 24, 4).fill(COLOR.ink);
  let x = PAGE.margin;
  font(doc, 'bold', 9, '#FFFFFF');
  for (const column of COLUMNS) {
    doc.text(column.label, x + CELL_PADDING, y + 6, { width: column.width - CELL_PADDING * 2, align: column.align, lineBreak: false });
    x += column.width;
  }
  return y + 24;
}

function continuationHeader(doc, quotation) {
  doc.rect(0, 0, PAGE.width, 5).fill(COLOR.aqua);
  font(doc, 'bold', 11, COLOR.ink).text(`ใบเสนอราคา ${quotationLabel(quotation)} (ต่อ)`, PAGE.margin, 26, { lineBreak: false });
  return 56;
}

function bottomLimit() { return PAGE.height - PAGE.footer - 10; }

function ensureSpace(doc, quotation, y, needed) {
  if (y + needed <= bottomLimit()) return y;
  doc.addPage();
  return continuationHeader(doc, quotation);
}

function drawItems(doc, quotation, items, y) {
  y = drawTableHeader(doc, y);
  items.forEach((item, index) => {
    const values = {
      index: String(index + 1),
      description: item.description,
      quantity: formatQuantity(item.quantity_hundredths),
      unit: item.unit || '-',
      price: formatMoney(item.unit_price_satang),
      amount: formatMoney(item.amount_satang),
    };
    font(doc, 'regular', 9.5);
    const height = measure(doc, values.description, COLUMNS[1].width - CELL_PADDING * 2) + CELL_PADDING * 2;
    if (y + height > bottomLimit()) {
      doc.addPage();
      y = drawTableHeader(doc, continuationHeader(doc, quotation));
    }
    if (index % 2 === 1) doc.rect(PAGE.margin, y, CONTENT_WIDTH, height).fill(COLOR.canvas);
    let x = PAGE.margin;
    for (const column of COLUMNS) {
      font(doc, column.key === 'amount' ? 'bold' : 'regular', 9.5, column.key === 'amount' ? COLOR.ink : COLOR.text);
      drawText(doc, values[column.key], x + CELL_PADDING, y + CELL_PADDING, column.width - CELL_PADDING * 2, { align: column.align });
      x += column.width;
    }
    y += height;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + CONTENT_WIDTH, y).lineWidth(0.5).strokeColor(COLOR.line).stroke();
  });
  return y + 14;
}

function drawSummary(doc, quotation, seller, y) {
  const base = quotation.subtotal_satang - quotation.discount_satang;
  const totals = { subtotal: quotation.subtotal_satang, base, vat: quotation.vat_satang, total: quotation.total_satang, withholding: quotation.withholding_satang, net: quotation.total_satang - quotation.withholding_satang };
  const rows = [['รวมเป็นเงิน', totals.subtotal]];
  if (quotation.discount_satang) rows.push(['หักส่วนลด', -quotation.discount_satang], ['ยอดหลังหักส่วนลด', totals.base]);
  if (quotation.vat_rate_bp) rows.push([`ภาษีมูลค่าเพิ่ม ${quotation.vat_rate_bp / 100}%`, totals.vat]);
  const rightX = 335;
  const rightWidth = PAGE.width - PAGE.margin - rightX;
  const rightHeight = rows.length * 20 + 40 + (quotation.withholding_rate_bp ? 46 : 0);
  y = ensureSpace(doc, quotation, y, Math.max(rightHeight, 90));
  const startPage = doc.page;

  let rightY = y;
  for (const [label, value] of rows) {
    font(doc, 'regular', 9.5, COLOR.muted).text(label, rightX, rightY + 3, { width: 120, lineBreak: false });
    font(doc, 'regular', 10, COLOR.text).text(formatMoney(value), rightX + 110, rightY + 2, { width: rightWidth - 118, align: 'right', lineBreak: false });
    rightY += 20;
  }
  doc.roundedRect(rightX - 8, rightY + 2, rightWidth + 8, 30, 5).fill(COLOR.ink);
  font(doc, 'bold', 10, '#FFFFFF').text('จำนวนเงินรวมทั้งสิ้น', rightX, rightY + 10, { width: 120, lineBreak: false });
  font(doc, 'bold', 13, '#FFFFFF').text(formatMoney(totals.total), rightX + 100, rightY + 7, { width: rightWidth - 108, align: 'right', lineBreak: false });
  rightY += 40;
  if (quotation.withholding_rate_bp) {
    font(doc, 'regular', 9, COLOR.muted).text(`หัก ณ ที่จ่าย ${quotation.withholding_rate_bp / 100}% (จากยอดก่อน VAT)`, rightX, rightY, { width: 170, lineBreak: false });
    font(doc, 'regular', 10, COLOR.text).text(formatMoney(-totals.withholding), rightX + 150, rightY - 1, { width: rightWidth - 158, align: 'right', lineBreak: false });
    rightY += 20;
    font(doc, 'bold', 10, COLOR.ink).text('ยอดชำระสุทธิ', rightX, rightY, { width: 120, lineBreak: false });
    font(doc, 'bold', 11, COLOR.ink).text(formatMoney(totals.net), rightX + 100, rightY - 1, { width: rightWidth - 108, align: 'right', lineBreak: false });
    rightY += 26;
  }

  const leftWidth = rightX - PAGE.margin - 28;
  let leftY = y;
  font(doc, 'bold', 10.5, COLOR.ink);
  const amountText = `(${bahtText(totals.total)})`;
  const amountHeight = measure(doc, amountText, leftWidth - 20);
  doc.roundedRect(PAGE.margin, leftY, leftWidth, amountHeight + 30, 6).fill(COLOR.canvas);
  font(doc, 'regular', 8, COLOR.muted).text('จำนวนเงินตัวอักษร', PAGE.margin + 10, leftY + 8, { lineBreak: false });
  font(doc, 'bold', 10.5, COLOR.ink);
  drawText(doc, amountText, PAGE.margin + 10, leftY + 21, leftWidth - 20);
  leftY += amountHeight + 42;

  for (const [label, value] of [['เงื่อนไขการชำระเงิน', quotation.payment_terms], ['ช่องทางการชำระเงิน', seller.bankAccount], ['หมายเหตุ', quotation.notes]]) {
    if (!value) continue;
    font(doc, 'regular', 9.5);
    const lines = wrap(doc, value, leftWidth);
    leftY = ensureSpace(doc, quotation, leftY, 16 + lineHeight(doc) * Math.min(lines.length, 3));
    font(doc, 'bold', 9, COLOR.blue).text(label, PAGE.margin, leftY, { lineBreak: false });
    leftY += 15;
    font(doc, 'regular', 9.5, COLOR.text);
    for (const line of lines) {
      const next = ensureSpace(doc, quotation, leftY, lineHeight(doc));
      if (next !== leftY) { leftY = next; font(doc, 'regular', 9.5, COLOR.text); }
      doc.text(line, PAGE.margin, leftY, { width: leftWidth, lineBreak: false });
      leftY += lineHeight(doc);
    }
    leftY += 8;
  }
  return (doc.page === startPage ? Math.max(leftY, rightY) : leftY) + 18;
}

function drawSignatures(doc, quotation, seller, y) {
  y = ensureSpace(doc, quotation, y, 116);
  const width = (CONTENT_WIDTH - 24) / 2;
  const blocks = [
    { x: PAGE.margin, title: 'ผู้เสนอราคา / Quoted by', name: seller.name || 'Donnar.Tech', date: quotation.issue_date ? formatThaiDate(quotation.issue_date) : '' },
    { x: PAGE.margin + width + 24, title: 'ผู้อนุมัติสั่งซื้อ / Accepted by', name: (quotation.buyer_json || {}).companyName || '', date: quotation.status === 'ACCEPTED' && quotation.decided_at ? formatThaiDate(bangkokDate(quotation.decided_at)) : '' },
  ];
  for (const block of blocks) {
    doc.roundedRect(block.x, y, width, 106, 6).lineWidth(0.8).strokeColor(COLOR.line).stroke();
    font(doc, 'bold', 8.5, COLOR.blue).text(block.title, block.x + 12, y + 10, { lineBreak: false });
    doc.moveTo(block.x + 30, y + 66).lineTo(block.x + width - 30, y + 66).lineWidth(0.6).strokeColor(COLOR.faint).dash(2, { space: 2 }).stroke().undash();
    font(doc, 'regular', 9, COLOR.text).text(block.name, block.x + 12, y + 71, { width: width - 24, align: 'center', lineBreak: false });
    font(doc, 'regular', 8.5, COLOR.muted).text(`วันที่ ${block.date || '......../......../........'}`, block.x + 12, y + 86, { width: width - 24, align: 'center', lineBreak: false });
  }
  if (quotation.status === 'ACCEPTED' && quotation.decided_at) {
    const stampX = blocks[1].x + 24;
    doc.roundedRect(stampX, y + 26, width - 48, 34, 5).lineWidth(1.2).strokeColor(COLOR.green).stroke();
    font(doc, 'bold', 9, COLOR.green).text(`ยืนยันทางออนไลน์โดย ${quotation.decision_name || '-'}`, stampX + 8, y + 31, { width: width - 64, align: 'center', lineBreak: false });
    font(doc, 'regular', 8, COLOR.green).text(formatThaiDateTime(quotation.decided_at), stampX + 8, y + 45, { width: width - 64, align: 'center', lineBreak: false });
  }
  return y + 116;
}

function drawPageDecorations(doc, quotation, seller, status) {
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    doc.switchToPage(range.start + index);
    const footerY = PAGE.height - PAGE.footer + 8;
    doc.moveTo(PAGE.margin, footerY).lineTo(PAGE.width - PAGE.margin, footerY).lineWidth(0.5).strokeColor(COLOR.line).stroke();
    font(doc, 'regular', 7.5, COLOR.faint).text(`${seller.name || 'Donnar.Tech'} · ${quotationLabel(quotation)} · เอกสารนี้จัดทำด้วยระบบอิเล็กทรอนิกส์`, PAGE.margin, footerY + 8, { width: CONTENT_WIDTH - 80, lineBreak: false });
    font(doc, 'regular', 7.5, COLOR.faint).text(`หน้า ${index + 1}/${range.count}`, PAGE.width - PAGE.margin - 80, footerY + 8, { width: 80, align: 'right', lineBreak: false });
    const watermark = WATERMARKS[status];
    if (watermark) {
      doc.save();
      doc.rotate(-32, { origin: [PAGE.width / 2, PAGE.height / 2] });
      font(doc, 'bold', 92, '#C2CBD8').fillOpacity(0.28).text(watermark, 0, PAGE.height / 2 - 70, { width: PAGE.width, align: 'center', lineBreak: false });
      doc.restore();
    }
  }
}

function renderQuotationPdf({ quotation, items, seller, today }) {
  return new Promise((resolve, reject) => {
    const issuedSeller = quotation.seller_json || seller;
    const status = effectiveStatus(quotation, today);
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, info: { Title: `ใบเสนอราคา ${quotationLabel(quotation)}`, Author: issuedSeller.name || 'Donnar.Tech', Subject: quotation.title || 'Quotation', Creator: 'Donnar.Tech LINE Back Office' } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('TH', FONT_REGULAR);
    doc.registerFont('TH-B', FONT_BOLD);
    let y = drawHeader(doc, quotation, issuedSeller);
    y = drawParties(doc, quotation, y);
    y = drawItems(doc, quotation, items, y);
    y = drawSummary(doc, quotation, issuedSeller, y);
    drawSignatures(doc, quotation, issuedSeller, y);
    drawPageDecorations(doc, quotation, issuedSeller, status);
    doc.end();
  });
}

module.exports = { renderQuotationPdf, wrap };
