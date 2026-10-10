# B2B quotations from CRM leads

Date: 2026-10-10
**Status:** Implemented

## Goal

Let Donnar.Tech staff turn a qualified LINE lead into a formal B2B quotation, send it to the customer in LINE as a real PDF, and let the customer accept or reject it online. Staff see the decision in the CRM. Invoices and receipts are out of scope for this release.

## Selected approach

Quotations live in the existing PostgreSQL database and the authenticated `/admin` console. One conversation can have many quotations. Staff create a draft from a conversation, fill in buyer company details and line items, then issue it. Issuing freezes the content, generates a public link with a random token, and pushes a branded LINE card with that link to the customer.

The public page at `/q/:token` shows a summary, a "ดาวน์โหลด PDF" button, and "ยอมรับ" / "ปฏิเสธ" actions. The PDF is rendered on request from the frozen database snapshot with `pdfkit` and an embedded Thai font (Sarabun, SIL Open Font License, committed under `assets/fonts/`). No headless browser, no file storage, and it runs on Render Free.

Options rejected: headless Chrome PDF (too heavy for the Render Free memory limit) and HTML-only print view (user chose a real PDF file).

## Document content

- Header: Donnar.Tech seller name, tax ID, head-office/branch, address, phone, email, website, logo. Seller details come from env config (`SELLER_NAME`, `SELLER_TAX_ID`, `SELLER_BRANCH_CODE`, `SELLER_ADDRESS`, `SELLER_PHONE`, `SELLER_EMAIL`, `SELLER_WEBSITE`, `SELLER_BANK_ACCOUNT`, `SELLER_VAT_REGISTERED`). Startup validates their format; sending is blocked until `SELLER_NAME` and `SELLER_TAX_ID` are set, so existing deployments keep starting without them.
- Number: `QT-YYYY-NNNN`, running per calendar year (Bangkok time), assigned when the draft is created. Gaps from deleted drafts are allowed.
- Issue date, valid-until date (default issue date + 30 days), and revision label if any.
- Buyer: company name, 13-digit tax ID (checksum validated), branch ("สำนักงานใหญ่" or "สาขาที่ NNNNN"), address, contact person, phone, email.
- Line items: description (multi-line), quantity (up to 2 decimals), unit (e.g. งาน, เดือน), unit price.
- Totals: subtotal, discount (amount), amount before VAT, VAT 7% (only when `SELLER_VAT_REGISTERED=true`; many early-stage startups are not VAT-registered), grand total, withholding tax 3% of the pre-VAT amount, and net payable after withholding. Grand total also shown in Thai baht text, e.g. "(หนึ่งหมื่นเจ็ดร้อยบาทถ้วน)".
- Payment terms and notes (free text), plus a signature block for the seller.

## Money rules

- Store money as integer satang (`BIGINT`); quantity as `NUMERIC(12,2)`.
- Line total = quantity × unit price, rounded half-up to satang. VAT and withholding are each rounded half-up once, on the totals, not per line.
- All totals are calculated on the server. The client never sends totals; the server ignores any it receives.
- Withholding is a per-quotation toggle (default on) because some buyers are individuals or are not required to withhold.

## Lifecycle

`DRAFT` → `SENT` → `ACCEPTED` | `REJECTED` | `EXPIRED`, plus `SUPERSEDED` and `CANCELLED`.

- `DRAFT`: editable and deletable by staff; not visible to the customer.
- `SENT`: content is frozen. The public token is created and the LINE card is pushed. Staff cannot edit it.
- To change a sent quotation, staff click "แก้ไขเป็นฉบับใหม่". This copies it to a new draft with the same number plus revision suffix (`QT-2026-0007-R1`). Issuing the revision marks the old one `SUPERSEDED`, and its link then shows "ใบเสนอราคานี้ถูกแทนที่แล้ว" with no actions.
- `ACCEPTED` / `REJECTED`: set once by the customer from the public page. The customer must type their name to accept, and may add a reason when rejecting. A second decision is refused. The decision, timestamp, and typed name are stored.
- `EXPIRED`: derived when `valid_until` is past (Bangkok date) and status is still `SENT`. Expired links show the document but no actions.
- `CANCELLED`: staff can cancel a sent quotation; the link shows it as cancelled.

## Customer link and LINE delivery

- Token: 32 random bytes, base64url, stored as-is so staff can copy and re-send the same link. The link is `PUBLIC_BASE_URL/q/<token>`; in production sending requires an https `PUBLIC_BASE_URL`.
- The public page and PDF endpoint are rate-limited, send `noindex` and `Cache-Control: no-store`, and never expose the LINE user ID or internal IDs.
- Accept/reject is a rate-limited `POST` to the token URL; the token itself is the credential. The state change is a single conditional update (`status = 'SENT'` and not expired), so repeats and races cannot change a decision.
- Issuing pushes a Flex card ("ใบเสนอราคา QT-…", grand total, valid-until, "ดูใบเสนอราคา" button) through the existing LINE client, recorded as an outbound message so the "รอตอบ" queue behaves as today. The quotation is marked `SENT` before the push. If the push fails, it stays `SENT`, staff see the failure and can copy the link or re-send the card.

## Staff UI

- Conversation panel: a "ใบเสนอราคา" section listing that conversation's quotations with status, and a "สร้างใบเสนอราคา" button.
- Create/edit form: buyer fields (prefilled from the latest quotation for the same conversation, if any), dynamic line items, discount, withholding toggle, terms, notes, and a live total preview. The server recalculates totals.
- Actions: save draft, preview PDF, issue and send in LINE, copy link, re-send card, revise, cancel, delete draft.
- `/admin/quotations`: list of all quotations, filterable by status, newest first.
- Accept and reject decisions show in a "ลูกค้าตอบกลับใบเสนอราคา" panel on `/admin` (tracked by `quotations.decision_read_at`) until staff click "รับทราบแล้ว".
- All state changes require staff session and CSRF and write `audit_logs` entries.

## Data

New migration `004_quotations.sql`:

- `quotations`: id, conversation FK, number, revision, status, issue/valid-until dates, `buyer_json`, discount, withholding flag, terms, notes, computed totals (snapshot), token hash, decision fields, timestamps. Unique on (number, revision).
- `quotation_items`: quotation FK, position, description, quantity, unit, unit price, line total.
- `quotation_counters`: year → last number, incremented with `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the create transaction.
- `quotations.seller_json`: seller snapshot taken when the quotation is sent, so later env changes do not alter issued PDFs.
- `staff_notifications` is unchanged.

## Thai rendering risk

`pdfkit` shapes Thai through fontkit, but its line wrapping only breaks at spaces. Long Thai descriptions with no spaces would overflow. Spike result: Sarabun tone marks and vowels position correctly through fontkit, but zero-width spaces render as missing-glyph boxes. The renderer therefore wraps lines itself from `Intl.Segmenter('th', { granularity: 'word' })` segments, falling back to grapheme breaks for over-long words, and draws each line without pdfkit wrapping.

## Acceptance criteria

1. Staff can create, edit, and delete a draft quotation from a conversation; the totals match the money rules for sample cases including discount, decimals, and withholding off.
2. Issuing assigns a frozen snapshot, creates a working `/q/<token>` link, and pushes a LINE card recorded in the conversation.
3. The PDF downloads with correct Thai text (no clipped or floating tone marks, long descriptions wrap), seller and buyer details, totals, and baht text.
4. The customer can accept with a typed name or reject once. Repeat, expired, superseded, or cancelled quotations refuse decisions.
5. A decision shows in the CRM as a notification and on the quotation status.
6. Invalid tax IDs, empty item lists, negative amounts, and discounts larger than the subtotal are rejected by the server.
7. Unknown or tampered tokens return 404 without revealing whether a quotation exists.
8. Staff routes reject unauthenticated requests and missing CSRF; existing webhook, intake, inbox, alerts, and Rich Menu behavior is unchanged.

## Out of scope

Invoices, receipts, tax invoices, e-signature, e-Tax, payment collection, multi-currency, a reusable company directory, and quotation templates.
