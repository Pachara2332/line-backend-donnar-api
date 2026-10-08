# LINE Profile Display and Rich Menu Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show cached LINE names and profile photos in the CRM and let staff upload, preview, and explicitly publish a replacement Rich Menu image.

**Architecture:** Add cached LINE profile lookup to the existing messaging client and webhook conversation service, with PostgreSQL refresh metadata and CRM fallbacks. Add a durable Rich Menu draft image flow using PostgreSQL BYTEA, authenticated admin routes, and an explicit publish confirmation that reuses existing LINE menu creation and recovery behavior.

**Tech Stack:** Node.js 20+, Express 5, PostgreSQL via `pg`, `pg-mem` test adapter, Supertest, existing HTML/CSS admin rendering.

**Spec:** `docs/superpowers/specs/2026-10-08-line-profile-rich-menu-upload-design.md`

## Global Constraints

- LINE profile lookup is best effort and happens after webhook business processing and replies, outside the database transaction.
- Refresh profiles at most once per 24 hours after successful or definitive 404 lookups; a new follow event may refresh sooner.
- Do not log profile name, picture URL, LINE user ID, or access token.
- Uploaded Rich Menu images must be JPEG or PNG, exact 2500 × 1686, and at most 1 MB; do not transform the artwork.
- Uploading or previewing a draft must never change the live Rich Menu; only the separate explicit confirmation may publish.
- Keep uploaded bytes in PostgreSQL and expose previews only to authenticated staff with no-store and nosniff headers.
- Preserve existing Rich Menu action areas, CRM replies, BOT/HUMAN handoff, and existing publication retry behavior.
- Add no production secret, storage service, or manual Supabase bucket requirement.

## Review Focus

- A blocked LINE user returns 404 repeatedly: persist the completed lookup time and retain any previously cached identity; test 24-hour suppression and follow-triggered refresh.
- A slow or failed LINE profile call must not delay/suppress a queued customer reply: test response/reply completes independently of profile refresh.
- A client-provided MIME type or filename disagrees with image bytes: reject before draft replacement; test that existing draft and publication remain unchanged.
- Parallel draft uploads race against the single-DRAFT constraint: ensure one draft remains and report conflict safely; test concurrent upload requests.
- LINE accepts set-default but local DB reconciliation fails: retry the same menu ID and reconcile state without creating a duplicate; extend partial-success publication tests.

---

### Task 1: LINE profile storage and client API

**Files:**
- Create: `database/migrations/002_line_profile_rich_menu_upload.sql`
- Modify: `database/schema.sql`
- Modify: `service/lineMessagingClient.js`
- Modify: `test/helpers/database.js`
- Test: `test/database.test.js`
- Test: `test/lineProfile.test.js`

**Interfaces:**
- Produces `LineMessagingClient.getProfile(userId) -> Promise<{ displayName: string, pictureUrl?: string }>`; definitive HTTP 404 returns `null`, other HTTP failures throw an error carrying `status`.
- Produces `FakeLineMessagingClient.getProfile(userId)` with deterministic profile fixture data and a recorded call list.
- Migration adds `line_users.picture_url TEXT`, `line_users.profile_synced_at TIMESTAMPTZ`, `rich_menu_publications.image_data BYTEA`, `rich_menu_publications.image_content_type TEXT`, and a partial unique index on `status='DRAFT'`.

- [ ] **Step 1: Write failing migration/profile-client tests.** In `test/database.test.js`, assert migration `002` is applied once, is repeatable, and adds the four columns plus the one-DRAFT partial index. In `test/lineProfile.test.js`, assert profile URL path encoding, bearer auth, parsed response, 404-to-null behavior, non-404 error status, and deterministic fake-client behavior.
- [ ] **Step 2: Run focused tests to confirm failure.** Run: `node --test test/database.test.js test/lineProfile.test.js`. Expected: missing migration/profile client API fails.
- [ ] **Step 3: Implement migration and profile methods.** Update both initial schema sources consistently; add `getProfile` to production and fake LINE clients. Map only 404 to null; preserve other errors/statuses.
- [ ] **Step 4: Run focused tests.** Run: `node --test test/database.test.js test/lineProfile.test.js`. Expected: all focused tests pass.
- [ ] **Step 5: Commit.** Commit migration, schemas, client, and tests as `feat: add LINE profile and rich menu draft storage`.

### Task 2: Profile refresh and CRM presentation

**Files:**
- Modify: `service/conversationService.js`
- Modify: `app.js`
- Test: `test/lineProfile.test.js`
- Test: `test/webhook.test.js` or a focused `test/lineProfile.test.js`

**Interfaces:**
- Consumes `lineClient.getProfile(userId)` from Task 1.
- Produces an internal `refreshLineProfile(userId, { force })` operation in the conversation service. It queries cache eligibility, coalesces same-process requests per UID, performs LINE I/O outside transactions, and persists successful identity or definitive-404 sync time.
- Admin query results expose `display_name` and `picture_url` to the HTML renderer, which uses escaped display names, HTTPS-only photo URLs, and UID fallback.

- [ ] **Step 1: Write failing profile-refresh and rendering tests.** Cover successful cache update; refresh suppression before 24h; refresh after 24h; forced follow refresh; completed 404 timestamp with old profile preserved; transient failure remains retryable; concurrent same-UID refresh coalesces; duplicate webhook event does not trigger lookup; inbox row/header render escaped name, secure photo or fallback.
- [ ] **Step 2: Run focused tests to confirm failure.** Run: `node --test test/lineProfile.test.js test/webhook.test.js`. Expected: profile lookup and CRM identity assertions fail.
- [ ] **Step 3: Implement best-effort refresh after event processing.** Preserve event dedupe and ensure outgoing webhook reply delivery completes before profile lookup starts. Perform profile update outside transaction. Follow event forces refresh; message/postback events use 24h cache eligibility. Keep 404 cache timestamp and existing identity, and do not advance timestamp for transient errors. Do not log profile/user/token values.
- [ ] **Step 4: Render CRM identity safely.** Extend admin data query for profile fields and render name/avatar in inbox row and selected header. Validate `https:` before placing a URL into escaped HTML. Add the LINE CDN HTTPS source to staff-page CSP `img-src`.
- [ ] **Step 5: Run focused tests.** Run: `node --test test/lineProfile.test.js test/webhook.test.js`. Expected: all profile and webhook tests pass.
- [ ] **Step 6: Commit.** Commit as `feat: show LINE profile identity in CRM`.

### Task 3: Rich Menu upload validation and draft persistence

**Files:**
- Modify: `app.js`
- Modify: `test/richMenu.test.js`
- Modify: `test/helpers/database.js`

**Interfaces:**
- Produces an authenticated multipart `POST /admin/rich-menu/draft` endpoint protected by CSRF and upload rate limit.
- Produces authenticated `GET /admin/rich-menu/image/:id` streaming stored draft or published bytes, with `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.
- Uses existing `validateRichMenuImage` and `richMenuImageContentType`, extended to validate both signature and declared `image/png` or `image/jpeg`.

- [ ] **Step 1: Write failing upload and preview tests.** Cover valid PNG/JPEG upload stores bytes/content type as DRAFT; invalid signature, MIME mismatch, malformed image, >1 MB, or wrong dimensions return field-level validation; unauthenticated/invalid-CSRF requests reject; invalid upload preserves prior draft and live publication; preview is staff-authenticated, no-store, nosniff, and serves exact bytes.
- [ ] **Step 2: Run focused tests to confirm failure.** Run: `node --test test/richMenu.test.js`. Expected: upload and preview endpoints are absent.
- [ ] **Step 3: Add bounded multipart processing.** Add a minimal multipart parser dependency only if required by current stack; cap request and file bytes at 1 MB before full buffering, enforce file count/field shape, and rate limit authenticated uploads.
- [ ] **Step 4: Validate and replace draft transactionally.** Validate actual JPEG/PNG signature, MIME match, exact 2500 × 1686 dimensions, and <=1 MB before DB mutation. In a transaction, remove prior DRAFT and insert new row; handle a unique-index conflict with a safe admin response. Add cancel endpoint that removes only DRAFT state.
- [ ] **Step 5: Add authenticated preview route and CSP support.** Stream stored draft/current image with content type from server detection, `nosniff`, `no-store`, and staff session check. Ensure profile CDN CSP change is applied in Task 2.
- [ ] **Step 6: Run focused tests.** Run: `node --test test/richMenu.test.js`. Expected: all upload/draft/preview tests pass.
- [ ] **Step 7: Commit.** Commit as `feat: upload and preview rich menu drafts`.

### Task 4: Admin upload and confirmation UX; publish/recovery

**Files:**
- Modify: `app.js`
- Modify: `test/richMenu.test.js`
- Modify: `test/helpers/database.js`

**Interfaces:**
- Admin Rich Menu section displays current publication state/image and a multipart upload form with CSRF.
- A stored draft displays its exact-image preview and an explicit `ยืนยันเปลี่ยน Rich Menu` form; optional cancel discards only the draft.
- Consumes Task 3 draft and preview routes and existing `lineClient.createRichMenu`, `uploadRichMenuImage`, `setDefaultRichMenu`.

- [ ] **Step 1: Write failing confirmation/publication tests.** Assert draft upload/preview does not call any LINE menu API; confirmation publishes exactly the stored bytes and existing menu tap actions; successful confirmation marks prior row REPLACED, new row PUBLISHED, clears replaced bytes, and adds audit entry; unauthenticated/CSRF-invalid confirmation rejects.
- [ ] **Step 2: Run focused tests to confirm failure.** Run: `node --test test/richMenu.test.js`. Expected: draft confirmation flow tests fail.
- [ ] **Step 3: Publish only a claimed DRAFT.** Atomically transition DRAFT→CREATING; reject concurrent publishers. Reuse known `line_menu_id` and `image_uploaded` state for retry. Call create/upload/set-default with stored image bytes; do not publish static repository artwork as part of this route.
- [ ] **Step 4: Reconcile local state and failure paths.** After set-default success, transactionally mark previous PUBLISHED→REPLACED, new row→PUBLISHED, clear old image bytes, and write audit. Preserve recoverable ID/upload state on failure. Retry same menu ID after a DB reconcile error and reissue set-default before committing state. Keep old local publication state until LINE confirms switch.
- [ ] **Step 5: Implement admin upload/preview/confirm UI.** Use multipart form for file selection; show field-level errors and preview after upload; require a separate confirmation form with clear note that it changes the LINE OA default menu. Keep old live menu visibly identified and do not change any OA setting during GET/upload/preview.
- [ ] **Step 6: Run focused tests.** Run: `node --test test/richMenu.test.js`. Expected: all Rich Menu tests pass, including legacy safe-retry behaviors.
- [ ] **Step 7: Commit.** Commit as `feat: publish uploaded rich menu drafts from admin`.

### Task 5: Cross-feature verification and documentation

**Files:**
- Modify: `README.md`
- Test: `test/lineProfile.test.js`
- Test: `test/richMenu.test.js`
- Test: full existing test suite

- [ ] **Step 1: Document behavior and operations.** Update README with profile-cache behavior, image requirements (JPEG/PNG, exact dimensions, <=1 MB), draft preview, explicit confirmation and LINE propagation caveat. No new env vars or secrets.
- [ ] **Step 2: Verify feature test suites.** Run: `node --test test/lineProfile.test.js test/richMenu.test.js test/webhook.test.js test/database.test.js`. Expected: all feature tests pass.
- [ ] **Step 3: Verify complete project suite.** Run: `npm test`. Expected: complete suite passes.
- [ ] **Step 4: Review scope and deployment safety.** Inspect diffs and `git diff --check`; confirm no secret values, no image/profile data in logs, no operation automatically calls LINE set-default on GET/upload, and no deployment or OA publication was triggered.
- [ ] **Step 5: Commit.** Commit documentation/final integration as `docs: document CRM identity and rich menu upload workflow`.

