# CRM lead alerts and unanswered conversation queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent in-app alerts for newly created leads and a CRM queue for conversations awaiting a successful response.

**Architecture:** Add a PostgreSQL notification table and create a deduplicated `new_lead` notification in the same transaction as the first lead insert. Compute unanswered conversations from the latest inbound customer message and latest successfully delivered outbound message, then render both views in the existing authenticated `/admin` inbox.

**Tech Stack:** Node.js 20+, Express 5, PostgreSQL/Supabase, server-rendered HTML/CSS, existing CSRF/session middleware.

**Spec:** `docs/superpowers/specs/2026-10-09-crm-lead-alerts-unanswered-design.md`

## Global Constraints

- Keep secrets out of Git and do not introduce third-party notification services.
- Keep customer identity keyed by LINE user ID; do not send additional automated messages to customers.
- Keep current BOT/HUMAN handoff, lead intake, Rich Menu, and staff reply behavior intact.
- Do not modify or stage the untracked `video/` directory.
- Preserve authenticated staff access and CSRF protection for notification state changes.

## Review Focus

- Duplicate webhook delivery must not create duplicate new-lead alerts; enforce uniqueness and use an idempotent insert.
- Same-timestamp inbound/outbound rows must use message ID as a deterministic tie-breaker.
- Failed, pending, cancelled, and unknown outbound sends must not clear the unanswered state.
- HTML output must escape contact names and message preview text.
- Empty notification and waiting queues must render stable empty states.

---

### Task 1: Persist one notification per new lead

**Files:**
- Create: `database/migrations/003_staff_notifications.sql`
- Modify: `service/conversationService.js`
- Modify: `database/migrate.js` only if migrations are explicitly registered there

**Interfaces:**
- `staff_notifications` columns: `id`, `type`, `conversation_id`, `created_at`, `read_at`.
- Unique key: `(type, conversation_id)`; `conversation_id` references `conversations(id)`.
- A newly inserted lead with type `new_lead` creates its notification in the same webhook transaction.

- [ ] Apply the migration to the local test database and verify it is idempotent.
- [ ] Make lead creation return whether a row was newly inserted; insert the notification only for the first lead row, using `ON CONFLICT DO NOTHING`.
- [ ] Run database and webhook-focused tests; confirm repeated events create one lead and one notification.

### Task 2: Add authenticated notification read action and CRM queries

**Files:**
- Modify: `app.js`
- Modify: `test/backoffice.test.js` and/or `test/webhook.test.js`

**Interfaces:**
- `POST /admin/notifications/:id/read` requires staff session and valid CSRF; updates `read_at` idempotently and redirects to the associated conversation.
- `adminPage` receives up to 10 unread lead notifications and a count of all unread lead notifications.
- Waiting rows include `conversation_id`, LINE identity/profile fields, inbound preview, and the timestamp of the latest unanswered inbound message.

- [ ] Write route tests for unauthenticated, invalid CSRF, valid read, and repeated read requests.
- [ ] Query unread notifications by `created_at DESC, id DESC` and unanswered conversations using latest inbound vs latest `SENT` outbound ordered by `(created_at, id)`.
- [ ] Test that pending/unknown outbound rows do not close a waiting conversation and that a later successful outbound does.

### Task 3: Render lead alerts and “รอตอบ” in the inbox

**Files:**
- Modify: `app.js`

**Interfaces:**
- Add two compact dashboard panels ahead of the inbox: “Lead ใหม่” with unread count and “รอตอบ” with waiting count.
- Each entry links to `/admin?conversation=<id>#inbox`; each alert includes a CSRF-protected mark-read form.
- Show escaped message preview, profile/name fallback, elapsed wait, and empty states; keep responsive styling consistent with the current CRM.

- [ ] Render newest unread lead alerts with a direct conversation link and mark-read action.
- [ ] Render unanswered conversations oldest-first and link each to the conversation.
- [ ] Verify names/previews are escaped and empty states render without layout errors.

### Task 4: Verify, commit, push, and deploy

**Files:**
- Modify: `README.md` if it needs an operational note for the two CRM panels.

- [ ] Run the project's existing verification suite and relevant static checks.
- [ ] Review `git diff --check`, inspect the final diff, and confirm `video/` remains untracked and unstaged.
- [ ] Commit the implementation on the current feature branch, push it, and merge to `main` using the repository's established PR workflow.
- [ ] Wait for Render to deploy the merged `main` commit; verify the Render dashboard shows it Live and `/health/ready` returns `200 {"status":"ready"}`.
- [ ] Open `/admin` and confirm both panels load for the existing staff session.
