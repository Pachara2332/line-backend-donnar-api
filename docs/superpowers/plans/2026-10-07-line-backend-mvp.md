# Donnar.Tech LINE Backend MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally testable, production-oriented backend and staff console for LINE webhook messaging, lead qualification, BOT/HUMAN handoff, content revisions, and Rich Menu lifecycle without connecting to the live OA.

**Architecture:** Use a modular CommonJS API with Express and SQLite on a persistent volume. Keep LINE I/O behind an injectable adapter, verify signatures over raw bytes, persist inbound event IDs before processing, and make webhook processing safe for redelivery. Serve an authenticated server-rendered staff console from the same app; keep runtime configuration in environment variables and provide local LINE test doubles so no live credentials are needed for development or tests.

**Tech Stack:** Node.js 20+, Express 5, SQLite via `better-sqlite3`, Node built-in test runner, server-rendered HTML with minimal client JavaScript. Pin dependency versions in the lockfile when scaffolding. SQLite deployment is single-instance and requires a persistent writable volume; move to PostgreSQL before horizontal scaling or if the hosting platform cannot persist the database file.

**Spec:** `docs/backend-owned-line-messaging-design.md`; supporting customer journey and copy: `docs/donnar-line-oa-journey.html`, `docs/donnar-line-oa-content.html`.

## Global Constraints

- Verify `x-line-signature` against the unmodified request body before parsing or acting on events.
- Invalid signatures must not change data or trigger outbound messages.
- Deduplicate webhook events and prevent duplicate greetings, lead creation, and outbound effects on redelivery.
- Support `follow`, text `message`, and `postback` events; persist conversation state, messages, and a lead.
- “คุยกับคน” and the Rich Menu handoff action must set `HUMAN`, confirm once, and stop automated customer replies until an authenticated staff action returns the conversation to `BOT`.
- Store editable message revisions and audit their publication; seed Thai copy from version-controlled templates.
- Staff controls require authentication; log no raw channel secret, access token, or sensitive customer message.
- Rich Menu operations use the backend and Messaging API adapter; seed from `assets/line-rich-menu-1200x405.png`, persist the LINE menu ID/status, and avoid accidental duplicate creation.
- No LINE channel secret or access token in Git. Preserve current OA Manager greeting and manual chat; do not configure webhook delivery, disable greeting, publish a menu, or otherwise modify the live OA in this implementation.
- Local verification and test fixtures must run without live LINE credentials; use an explicit fake LINE adapter and test secrets.

## Review Focus

- Malformed JSON or unsupported event shapes after a valid signature return safely and do not partially process the batch; cover in webhook adapter tests.
- Concurrent duplicate event deliveries create one event effect and one lead update; cover with database-backed idempotency tests.
- An inbound message racing with a staff handoff cannot cause a bot reply after HUMAN mode is committed; cover in conversation service tests.
- LINE API timeout or rejection is visible as a retryable/failed operation without leaking credentials or duplicating replies; cover in adapter/outbox tests.
- Unauthorized, expired, and CSRF-invalid staff requests cannot edit content, change mode, send replies, or publish menus; cover in auth and route tests.

---

## Files and responsibilities

- `server.js`, `app.js`, `config/environment.js`: Express composition, lifecycle, health endpoint, and validated environment configuration.
- `endpoint/`: webhook and authenticated back-office routers/controllers.
- `middleware/`: raw-body signature validation, authentication, CSRF, and error handling.
- `service/`: focused LINE, webhook, conversation, lead, content, and Rich Menu services with injected dependencies.
- `database/`: SQLite connection, SQL migrations, and Thai copy seed data.
- `views/`, `public/`: staff console templates/static assets; include the provided logo.
- `test/`: Node built-in unit, route, and persistence tests using fake LINE I/O.
- `.env.example`, `.gitignore`: safe configuration and local development setup.
- `README.md`: setup, migrations, test commands, secrets, deployment expectations, and explicit live cutover checklist.

## Task 1: Scaffold API, configuration, and local database

**Interfaces:** `loadConfig(env): AppConfig`; `buildApp(deps): ExpressApp`; dependencies expose the database and `LineMessagingClient`.

- [ ] Create the Node/CommonJS project and lockfile, Express app/server entrypoints, config parser, health endpoint, SQLite schema/migration bootstrap, and `.env.example` with placeholders only.
- [ ] Add a boot/config test proving startup rejects missing production secrets and accepts a local fake adapter without LINE credentials.
- [ ] Run `node --check` over server modules and the focused configuration/health tests; verify no secret-like values entered tracked files.

## Task 2: Persistence schema and migrations

**Interfaces:** SQLite tables `webhook_events`, `line_users`, `conversations`, `messages`, `leads`, `message_revisions`, `audit_logs`, `rich_menu_publications`, and `staff_users`; migration commands defined in package scripts.

- [ ] Add relational schema, unique event ID constraint, unique LINE user/conversation linkage, lead-to-conversation relation, timestamps, BOT/HUMAN mode, current qualification step, and JSON-safe requirement values.
- [ ] Write migration and seed Thai copy from the content planning artifact; seed must be idempotent and contain no credentials.
- [ ] Add persistence tests for event uniqueness, one lead per conversation, revision history, and repeatable seed; run migrations against a temporary local SQLite file.

## Task 3: LINE adapter and secure webhook

**Interfaces:** `verifyLineSignature(rawBody, signature, channelSecret): boolean`; `LineMessagingClient.reply(replyToken, messages)`, `.push(userId, messages)`, `.createRichMenu(payload)`, `.uploadRichMenuImage(menuId, bytes, contentType)`, `.setDefaultRichMenu(menuId)`; `POST /webhooks/line`.

- [ ] Write tests for valid/invalid signatures over exact raw bytes, malformed payload, batched events, unsupported event, and fake adapter call recording.
- [ ] Implement raw-body capture and signature check before JSON parsing; reject invalid signatures without database or LINE calls.
- [ ] Persist inbound event IDs transactionally before business processing and return prompt 200 for valid event batches; make duplicates no-op.
- [ ] Implement production Messaging API adapter with request timeouts, bounded safe retries for retryable operations, masked errors, and no body/token logging.
- [ ] Run focused tests and a local HTTP test that uses a test-only signing secret and fake LINE adapter.

## Task 4: Conversation flow, lead qualification, and handoff

**Interfaces:** `processWebhookEvent(event): Promise<void>`; conversation mode enum `BOT | HUMAN`; qualification answer keys `serviceType`, `projectSummary`, `budgetRange`, `contactPreference`; `setConversationMode(id, mode, staffId)`.

- [ ] Write tests for follow greeting exactly once, first text creates one conversation and lead, deterministic prompt progression, answer persistence, and Rich Menu postbacks.
- [ ] Write tests proving “คุยกับคน” and handoff postback win from every BOT step, send one confirmation, and no later incoming message gets an automated reply while mode is HUMAN.
- [ ] Implement transaction-safe state changes and outbound send records so retries do not duplicate customer-visible effects; capture source when supplied in LINE event metadata.
- [ ] Add staff BOT restoration path with collected lead summary available before action; audit each mode transition.
- [ ] Verify with SQLite-backed service tests and fake LINE call assertions.

## Task 5: Staff authentication and back-office console

**Interfaces:** authenticated session principal `StaffPrincipal`; routes for login/logout, conversation/lead listing and detail, message history, staff reply, mode change, content preview/edit/publish.

- [ ] Write tests for unauthenticated access, invalid/expired sessions, CSRF rejection, authorization, and safe rendering of customer text.
- [ ] Implement password-hash login, secure cookie session settings, CSRF tokens, input validation, rate-limited login, and initial staff bootstrap via environment-provided password hash (never committed plaintext credentials).
- [ ] Build responsive Thai staff console using provided Donnar.Tech logo; show conversation mode, recent message history, lead summary, qualification, and explicit BOT/HUMAN controls.
- [ ] Add content editor for greeting, qualification prompts, service descriptions, handoff confirmation, and fallback copy with preview, publish revisions, and audit log.
- [ ] Run route/security tests and inspect console locally in browser at desktop and narrow viewport sizes.

## Task 6: Rich Menu management

**Interfaces:** `previewRichMenu()`, `createRichMenuDraft()`, `publishRichMenu()`, `replaceDefaultRichMenu()`; actions map to qualification, services, portfolio/workflow links, and human handoff supported by the three-panel seed image.

- [ ] Write tests for image dimensions/type/size checks, preview, single active default publication, duplicate-click idempotency, LINE API failure recording, and menu ID persistence.
- [ ] Implement authenticated preview/create/upload/set-default flow through `LineMessagingClient`; require explicit publish action, save status/history, and prevent duplicate menu creation on retry.
- [ ] Bind menu actions to real backend flows and show current LINE publication state in the console.
- [ ] Verify all paths with fake LINE adapter; do not run a live publish.

## Task 7: Operations, documentation, and release-readiness verification

- [ ] Add structured request logs with event correlation IDs and redaction; add graceful shutdown and readiness/health checks.
- [ ] Document local setup, migrations, fake LINE mode, production environment variables, HTTPS/proxy requirements, backups, and recovery steps.
- [ ] Run the full local test suite, syntax checks, dependency audit, secret scan, and a manual fake-webhook smoke scenario covering follow → qualification → HUMAN → staff BOT restore → Rich Menu preview/publish against fake adapter.
- [ ] Review the acceptance criteria in `docs/backend-owned-line-messaging-design.md` one by one and record any environment-dependent live cutover steps as not yet performed.
