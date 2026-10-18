# CRM Admin Page Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Split the staff CRM into focused pages with shared navigation, page-specific data loading, and live inbox updates.

**Architecture:** Keep the existing server-rendered Express pages and introduce a shared authenticated staff shell with a dedicated route per work area. Reuse the current SSE events and update endpoint only on the inbox page; retain existing POST actions, staff sessions, and CSRF protection.

**Tech Stack:** Node.js, Express, PostgreSQL, server-rendered HTML/CSS, browser JavaScript, Server-Sent Events.

**Spec:** [2026-10-18-crm-admin-page-separation-design.md](../specs/2026-10-18-crm-admin-page-separation-design.md)

## Global Constraints

- Keep SSE for inbox updates; do not replace it with WebSockets.
- Do not add a SPA framework or database schema changes.
- Keep existing staff-session and CSRF protection on authenticated and state-changing routes.
- Do not add or run automated tests unless the user asks; do not start a server or create a worktree.
- Do not add comments to code.
- Do not commit or push without asking the user.
- Before claiming the UI is complete, visually inspect iOS and Android layouts; if unavailable, report that they remain unverified.

## Review Focus

- Legacy `/admin?conversation=` links, including invalid IDs, must route safely and keep valid conversation deep links intact.
- Inbox searches containing Thai text, punctuation, or empty values must preserve safe filtering and correct empty states.
- A message arriving for the selected conversation must update the thread; an update for another conversation must show a useful notification/link without switching the open chat.
- Follow-up actions must preserve the intended notification/read state and navigate to the correct conversation.
- Unauthenticated requests and invalid CSRF submissions must remain rejected by existing middleware.

---

### Task 1: Shared staff shell and overview

**Files:**
- Modify: `app.js`

**Interfaces:**
- Add `staffShell(title, activePage, content, staff, csrfToken, scripts = [])` to render the existing base shell with shared staff navigation, account name, logout form, and active-page state.
- Add `overviewPage(db)` to render only summary counts and a small set of actionable links; route handlers wrap its result with `staffShell`.

- [x] Add the shared navigation destinations and active state to the staff shell; keep login and public preview pages on the existing base shell.
- [x] Change `GET /admin` to render the lightweight overview, redirect valid positive `?conversation=` IDs to `/admin/inbox?conversation=...`, and render the overview for invalid IDs.
- [x] Check `app.js` syntax with `node --check app.js` and inspect the generated navigation markup for all six destinations.

### Task 2: Dedicated inbox with selective message loading

**Files:**
- Modify: `app.js`
- Modify: `public/admin-inbox.js`

**Interfaces:**
- Add `GET /admin/inbox` and an `inboxPage(db, csrfToken, query, options)` renderer; the route wraps its result with `staffShell`.
- Consume `staffShell(title, activePage, content, staff, csrfToken, scripts = [])` from Task 1.
- Preserve the existing `GET /admin/inbox/events` and `GET /admin/inbox/updates/:id` interfaces.

- [x] Move inbox rendering and data loading out of the current combined `adminPage` into the dedicated inbox route; preserve lead search, mode/status filters, customer details, quote shortcut, and 30-message selected-thread history.
- [x] Render one latest-message preview per conversation row; fetch a full recent message history only for the selected conversation. When search text is supplied, preserve message-text search through a selective query.
- [x] Load `/assets/admin-inbox.js` only on the inbox page and update its conversation URLs and notification links to `/admin/inbox`.
- [x] Make the mobile inbox provide a clear list-to-conversation and conversation-to-list path without a cramped two-column layout.
- [ ] Check syntax for `app.js` and `public/admin-inbox.js`; inspect route output and verify the SSE payload still refreshes the selected thread without document reload. Syntax and source-flow inspection passed; runtime SSE and visual behavior remain unverified because no app server was running.

### Task 3: Follow-ups, bot messages, and Rich Menu pages

**Files:**
- Modify: `app.js`

**Interfaces:**
- Add `GET /admin/follow-ups`, `GET /admin/content`, and `GET /admin/rich-menu`.
- Consume `staffShell(title, activePage, content, staff, csrfToken, scripts = [])` from Task 1.
- Retain existing POST routes for notification read state, message draft/publish, and Rich Menu upload/publish.

- [x] Move unread new-lead and waiting-reply lists to `/admin/follow-ups`; link each row to the corresponding inbox conversation and keep the existing read action behavior.
- [x] Move published copy and message revisions to `/admin/content`; load revision data only for that page, keep draft/publish form actions intact, and return those actions to `/admin/content`.
- [x] Move publication metadata, upload preview, active image, and confirm actions to `/admin/rich-menu`; load image data only when the page displays it and return those actions to `/admin/rich-menu`.
- [x] Set the shared shell's active item for each page and return successful actions to the relevant page.
- [x] Check `app.js` syntax and inspect each route's page-specific query and form destinations.

### Task 4: Integrate quotations and update cross-page links

**Files:**
- Modify: `app.js`
- Modify: `service/quotationPages.js`

**Interfaces:**
- Render quotation list, editor, and detail pages through `staffShell(title, 'quotations', content, staff, csrfToken, scripts = [])` while preserving their current routes and actions.

- [x] Remove duplicate quotation navigation/account controls from `pageTop` and use the shared staff shell on the quotation list, editor, and detail routes.
- [x] Update quotation return links, conversation actions, login redirects, notification redirects, and any remaining generated `#inbox` links to the dedicated inbox route.
- [x] Search `app.js`, `service/quotationPages.js`, and `public/admin-inbox.js` for stale `/admin?conversation=` and `/admin#inbox` destinations; retain the intentional legacy redirect only.
- [x] Check syntax for all changed JavaScript files and run `git diff --check`.

### Task 5: Cross-page review and visual verification

**Files:**
- Review only: `app.js`, `service/quotationPages.js`, `public/admin-inbox.js`

- [x] Review each acceptance criterion in the design spec against the changed routes and links.
- [x] Check unauthenticated and CSRF-protected flows remain behind the existing middleware; do not weaken the current forms or actions.
- [x] Check whether a running app and iOS/Android environments are available without starting a server. None were available; report the UI as not visually verified.
- [x] Review the final diff to confirm unrelated pre-existing files and changes remain untouched. Do not commit or push.
