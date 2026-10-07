# Supabase PostgreSQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite persistence with Supabase PostgreSQL while preserving Donnar's LINE backend behavior and enabling a free-tier trial deployment.

**Architecture:** Use `pg.Pool` with async queries, explicit PostgreSQL transactions, and versioned SQL migrations applied before the HTTP server listens. Use `pg-mem` for local persistence tests; keep LINE mocked in tests. Deploy the Node service as a single Render Free web service and store `DATABASE_URL` in the host's environment secrets.

**Tech Stack:** Node.js 20+, Express 5, `pg`, `pg-mem` for development tests, Supabase PostgreSQL session pooler, Render Blueprint.

**Spec:** `docs/superpowers/specs/2026-10-08-supabase-postgres-migration-design.md`

## Global Constraints

- Supabase is only the database; customers will not get a Supabase account or a registration flow.
- Keep the existing Node.js 20+/Express backend and replace the synchronous `better-sqlite3` access pattern with asynchronous PostgreSQL access through the `pg` driver.
- Keep the current app-level staff login, session, and CSRF model. LINE user IDs remain the customer identity.
- Use a versioned SQL migration runner that records applied migration versions and applies each migration transactionally at application startup before the HTTP listener accepts requests.
- Handle each webhook event's deduplication insert and state changes in one PostgreSQL transaction.
- Keep outbound send outcomes durable (`PENDING`, `SENDING`, `SENT`, `CANCELLED`, `UNKNOWN`) and reconcile interrupted `SENDING` records to `UNKNOWN` after restart.
- Local development/tests run without Supabase or LINE credentials. Use an in-memory PostgreSQL-compatible test database or an injected repository test double; fake LINE I/O remains enabled for tests.
- Production config requires `DATABASE_URL`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `STAFF_PASSWORD_HASH`. No real secrets enter Git or chat.
- Update the Render Blueprint for one free web service with no persistent disk and `DATABASE_URL` provided out of band. Keep the service at one instance.
- No webhook URL is enabled and no real Rich Menu is published as part of the code migration.

## Review Focus

- A database outage during startup must fail readiness and prevent the server from accepting traffic; cover in startup tests.
- Two duplicate webhook deliveries must create one event's state changes and one outbound record; cover in conversation persistence tests.
- A failed transaction must roll back the event row, conversation, lead, and queued message together; cover in transaction tests.
- PostgreSQL JSONB values and `TIMESTAMPTZ` session expiry must render and authenticate correctly; cover in lead/admin/session tests.
- A malformed or unavailable `DATABASE_URL` must fail production configuration without logging its value; cover in config/startup tests.

---

## Files and responsibilities

- `config/environment.js`: require production `DATABASE_URL`; remove SQLite file config and fake/real mode rules remain unchanged.
- `database/index.js`: create the `pg.Pool`, transaction helper, migration runner, and bootstrap function.
- `database/migrations/001_initial.sql`: PostgreSQL schema; `database/migrate.js`: local CLI entry point using the same runner.
- `database/seed.js`, `service/messageCatalog.js`: idempotent Thai copy seed using async PostgreSQL queries.
- `server.js`: await migrations and bootstrap before creating/listening to the Express server.
- `app.js`, `service/conversationService.js`: replace synchronous SQLite calls with parameterized async PostgreSQL queries; preserve route behavior and event transaction boundaries.
- `test/helpers/database.js`: create isolated `pg-mem` pools and run real migrations for tests.
- `scripts/import-sqlite-to-postgres.js`: explicit, opt-in local data import; never invoked automatically during deploy.
- `render.yaml`, `.env.example`, `README.md`, `docs/deploy-render-line-oa.md`: use a free single-instance service, PostgreSQL secret, and document free-tier operational limits.
- `package.json`, `package-lock.json`: replace production `better-sqlite3` with `pg`; add `pg-mem` as a development dependency and keep `better-sqlite3` only if required by the explicit import utility.

### Task 1: PostgreSQL bootstrap, migration runner, and test database

**Files:**
- Modify: `package.json`, `package-lock.json`, `config/environment.js`
- Create: `database/migrations/001_initial.sql`, `database/index.js`, `database/migrate.js`, `database/seed.js`, `test/helpers/database.js`, `test/database.test.js`
- Modify: `database/schema.sql` only if retaining it temporarily as a source for conversion; remove it when no callers remain.

**Interfaces:**
- `createDatabase(databaseUrl: string): Pool`
- `migrateDatabase(pool: Pool): Promise<void>`
- `initializeDatabase(pool: Pool, config: AppConfig): Promise<void>` — runs migrations, recovers interrupted outbound/menu states, seeds copy, and bootstraps the initial staff hash.
- `withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>`
- `createTestDatabase(): Promise<{ pool: Pool, close: () => Promise<void> }>`

- [ ] **Step 1: Write failing production-config tests** for required `DATABASE_URL`, existing LINE secrets/password hash, and fake mode disabled in production.
- [ ] **Step 2: Run `node --test test/config.test.js`** and confirm the new `DATABASE_URL` case fails before implementation.
- [ ] **Step 3: Add `pg` and `pg-mem`; implement PostgreSQL connection and typed configuration.** Do not include connection URLs in error messages.
- [ ] **Step 4: Write failing migration tests** for fresh schema creation, a second idempotent run, seeding, and restart recovery.
- [ ] **Step 5: Implement the version table and transactional migration runner.** Put tables and indexes in `001_initial.sql`; use identity IDs, `JSONB` for lead requirements/audit details, `BOOLEAN` for flags, and `TIMESTAMPTZ` for session expiration.
- [ ] **Step 6: Run `node --test test/database.test.js test/config.test.js`; expect all migration/config tests to pass against `pg-mem`.**
- [ ] **Step 7: Commit** the schema/bootstrap boundary.

### Task 2: Async startup, health checks, and idempotent content/staff bootstrap

**Files:**
- Modify: `server.js`, `app.js`, `database/index.js`, `database/seed.js`, `service/messageCatalog.js`
- Modify: `test/config.test.js`, `test/backoffice.test.js`, `test/helpers/database.js`

**Interfaces:**
- Consumes Task 1 `createDatabase`, `initializeDatabase`, `withTransaction`, and `createTestDatabase`.
- `buildApp({ db: Pool, lineClient, config }): Express` stays synchronous and does not perform DB I/O during construction.
- Startup calls and awaits `initializeDatabase(pool, config)` before `app.listen()`.

- [ ] **Step 1: Convert existing config/auth/back-office setup tests to await a migrated and seeded `pg-mem` pool.**
- [ ] **Step 2: Run focused tests and verify they fail on synchronous `.prepare()` calls or missing initialization.**
- [ ] **Step 3: Convert seed and staff bootstrap to parameterized asynchronous PostgreSQL queries.** Keep existing scrypt login and session hashing behavior.
- [ ] **Step 4: Update startup to migrate and initialize before listening; close the pool during graceful shutdown.** A startup database failure must exit without opening the HTTP listener.
- [ ] **Step 5: Convert health/readiness queries to async and return 503 when PostgreSQL is unavailable.**
- [ ] **Step 6: Run `node --test test/config.test.js test/backoffice.test.js` and verify login/session behavior passes.**
- [ ] **Step 7: Commit** the async startup and readiness work.

### Task 3: Webhook and conversation persistence transactions

**Files:**
- Modify: `service/conversationService.js`, `app.js`
- Modify: `test/webhook.test.js`, `test/conversationConcurrency.test.js`, `test/helpers/database.js`

**Interfaces:**
- `createConversationService({ db: Pool, lineClient }): { processEvent(event): Promise<Result>, setMode(id, mode, staff): Promise<boolean> }`
- `processEvent` acquires a client and wraps dedupe insert plus all event-state writes in `withTransaction`.
- `deliverPending` uses the existing per-conversation lock and persists status transitions with `UPDATE ... WHERE send_status = ... RETURNING`.

- [ ] **Step 1: Port webhook and conversation tests to PostgreSQL-compatible fixtures.** Add an assertion that a forced SQL failure rolls back all event-derived writes.
- [ ] **Step 2: Run focused tests and capture expected failures from the current synchronous API and SQLite SQL.**
- [ ] **Step 3: Convert conversation queries to `client.query(sql, params)`, PostgreSQL conflict syntax, and `RETURNING` values.** Preserve validation, event IDs, lead progress, source handling, and reply behavior.
- [ ] **Step 4: Keep event deduplication and state mutation within one transaction; send queued LINE messages only after commit.**
- [ ] **Step 5: Convert delivery and BOT/HUMAN mode updates to async database calls; preserve locking and restart `UNKNOWN` behavior.**
- [ ] **Step 6: Run `node --test test/webhook.test.js test/conversationConcurrency.test.js` and verify duplicate, rollback, and handoff tests pass.**
- [ ] **Step 7: Commit** the async webhook/conversation persistence.

### Task 4: Convert back-office, content, replies, and Rich Menu lifecycle

**Files:**
- Modify: `app.js`, `service/messageCatalog.js`
- Modify: `test/backoffice.test.js`, `test/richMenu.test.js`

**Interfaces:**
- Consumes Task 2 initialized `Pool` and Task 3 transaction helper.
- Admin routes remain the same; every DB-dependent handler and `adminPage` awaits query results.
- `getCopy(db: Pool, key: string): Promise<string>`.

- [ ] **Step 1: Convert back-office tests to await `buildApp` requests against initialized PostgreSQL-compatible pools and add an expired-session case.**
- [ ] **Step 2: Run focused tests to verify failures on async query expectations.**
- [ ] **Step 3: Convert auth/session, lead/message listings, staff replies, mode changes, content revisions, audit writes, and Rich Menu operations to async queries.** Use explicit `withTransaction` around multi-row publishes and mode/audit updates.
- [ ] **Step 4: Use JSONB objects returned by `pg` without `JSON.parse`; retain safe HTML escaping.**
- [ ] **Step 5: Run `node --test test/backoffice.test.js test/richMenu.test.js` and verify routes and Rich Menu retry/idempotency behavior pass.**
- [ ] **Step 6: Commit** the async back-office migration.

### Task 5: Explicit opt-in local data import

**Files:**
- Create: `scripts/import-sqlite-to-postgres.js`
- Modify: `package.json`, `package-lock.json`, `README.md`, `docs/deploy-render-line-oa.md`
- Create: `test/sqliteImport.test.js` or an equivalent fixture-based script test.

**Interfaces:**
- CLI accepts source SQLite path and target `DATABASE_URL` from environment; prints only counts and success/failure categories, never row content or secrets.
- Import is explicit, transactional, idempotent for an empty target, preserves IDs/relations, and refuses to run if target business tables are non-empty.

- [ ] **Step 1: Add a fixture SQLite database and a failing import test covering users, conversations, leads, messages, content, audit, and Rich Menu records.**
- [ ] **Step 2: Run the focused test and verify the import command is missing.**
- [ ] **Step 3: Add `better-sqlite3` as a development-only dependency and implement the opt-in importer with a single PostgreSQL transaction and sequence reset.**
- [ ] **Step 4: Run `node --test test/sqliteImport.test.js` and verify imported relations and IDs.**
- [ ] **Step 5: Document backup/restore and that deployment never invokes import automatically.**
- [ ] **Step 6: Commit** the import utility and migration documentation.

### Task 6: Free-tier deployment config and full local verification

**Files:**
- Modify: `render.yaml`, `.env.example`, `README.md`, `docs/deploy-render-line-oa.md`, `package.json`
- Modify: all tests as needed to remove direct SQLite setup.

**Interfaces:**
- Render Blueprint uses one Free Node web service, no disk, health check `/health/ready`, and `DATABASE_URL` as an out-of-band secret.
- Keep `NODE_ENV=production` validation meaningful: hosted production requires `DATABASE_URL`, LINE Channel Secret, LINE Channel Access Token, and staff password hash; fake LINE mode remains disabled in production.

- [ ] **Step 1: Test config split:** production requires PostgreSQL and LINE/staff secrets; fake LINE mode remains local-only and cannot be enabled when `NODE_ENV=production`.
- [ ] **Step 2: Update the Render Blueprint to remove persistent disk and paid compute; keep `DATABASE_URL` as `sync: false` and no credentials in the YAML.**
- [ ] **Step 3: Update README/deploy guide for Supabase session-pooler connection string, SSL, migrations at startup, Render Free sleep, Supabase Free pause/500 MB/backups constraints, and the no-live-OA cutoff.**
- [ ] **Step 4: Run `npm test`; expected all behavior, migration, import, and auth tests pass.**
- [ ] **Step 5: Run `npm audit`, JavaScript syntax checks, `git diff --check`, and a credential scan.**
- [ ] **Step 6: Run a local fake-mode startup/readiness and signed webhook smoke with `pg-mem`; no real Supabase/LINE credentials or OA changes.**
- [ ] **Step 7: Commit** the deployment and documentation update.

## Final verification

- [ ] Review every acceptance criterion in `docs/superpowers/specs/2026-10-08-supabase-postgres-migration-design.md` against the implementation and tests.
- [ ] Verify Render/Supabase external setup is still listed as pending; do not claim live deployment, webhook verification, or Rich Menu publication.
- [ ] Obtain a fresh whole-branch review before calling the migration complete.
