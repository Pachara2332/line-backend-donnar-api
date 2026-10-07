# Supabase PostgreSQL migration — Donnar LINE backend

Date: 2026-10-08

## Goal

Move the Donnar LINE backend's persistent application data from local SQLite to PostgreSQL hosted by Supabase, so the service can run without a persistent local disk and can be tried on a free hosting setup. Preserve the existing LINE webhook, bot flow, staff console, and Rich Menu functionality. Supabase is only the database; customers will not get a Supabase account or a registration flow.

## Agreed direction

Keep the existing Node.js 20+/Express backend and replace the synchronous `better-sqlite3` access pattern with asynchronous PostgreSQL access through the `pg` driver. Connect to Supabase using its IPv4-compatible session pooler for a long-running Node service when the chosen host does not guarantee IPv6. Keep the connection string in the hosting provider's secret manager as `DATABASE_URL`.

Keep the current app-level staff login, session, and CSRF model. LINE user IDs remain the customer identity. Store messages, webhook deduplication, leads, BOT/HUMAN mode, content revisions, staff sessions, audit history, and Rich Menu publication state in PostgreSQL.

## Data and transaction design

- Use PostgreSQL identity columns and `RETURNING id` where generated IDs are needed.
- Use `JSONB` for lead requirements and audit details while retaining JSON-compatible API shapes.
- Use a versioned SQL migration runner that records applied migration versions and applies each migration transactionally at application startup before the HTTP listener accepts requests.
- Seed Thai default copy idempotently after migrations.
- Handle each webhook event's deduplication insert and state changes in one PostgreSQL transaction. Retain the per-conversation in-process lock for serializing send/handoff behavior within the single app process.
- Keep outbound send outcomes durable (`PENDING`, `SENDING`, `SENT`, `CANCELLED`, `UNKNOWN`) and reconcile interrupted `SENDING` records to `UNKNOWN` after restart.
- Run all database reads and writes asynchronously. Route handlers and server-rendered admin page generation must await query results; no synchronous compatibility shim will block the Node event loop.

## Local and hosted operation

- Local development/tests run without Supabase or LINE credentials. Use an in-memory PostgreSQL-compatible test database or an injected repository test double; fake LINE I/O remains enabled for tests.
- Production config requires `DATABASE_URL`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `STAFF_PASSWORD_HASH`. No real secrets enter Git or chat.
- Update the Render Blueprint for one free web service with no persistent disk and `DATABASE_URL` provided out of band. Keep the service at one instance. The database is external, so ephemeral app filesystem no longer affects leads or conversation history.
- Treat the free configuration as a trial/non-guaranteed service: Render Free can sleep and cold-start; Supabase Free can pause after a period of low activity, has a 500 MB database quota, and does not include downloadable database backups. Production messaging that needs consistent webhook availability should use paid always-on hosting/database plans or an equivalent provider with an uptime commitment.

## Existing data and compatibility

No live OA integration has occurred, so there should be no production customer data to migrate. Provide a one-time SQLite-to-PostgreSQL import utility or documented import path for local data if the owner wants to retain any staff-created local content or conversations. Do not automatically upload a local SQLite file during deploy.

The public route and behavior remain stable: `POST /webhooks/line`, `/health`, `/health/ready`, and `/admin/*`. Existing OA settings remain untouched. No webhook URL is enabled and no real Rich Menu is published as part of the code migration.

## Security and privacy

- Use TLS for the Supabase connection and least-privilege operational habits; do not expose the database password in logs or errors.
- Keep customer data in private Postgres tables and access only through the server-side database role. Do not expose the Supabase service role or database credential to browsers.
- Keep staff password hash and LINE credentials in the Render secret fields, not in `render.yaml`, `.env.example`, or Git.
- Preserve parameterized queries, HTML escaping, staff authentication, CSRF checks, webhook signature verification, and redacted logs.

## Verification and acceptance

- All current behavior tests continue passing against a PostgreSQL-compatible test database.
- Tests cover migration idempotency, transactional event dedupe, duplicate redelivery, lead/message persistence, staff auth/session/content operations, Rich Menu lifecycle, and concurrent handoff/outbound behavior.
- A local fake-mode smoke verifies startup/readiness and signed webhook behavior without LINE or Supabase credentials.
- Production readiness requires manually adding Supabase's connection string and LINE secrets to the host, deploying, checking `/health/ready`, verifying the LINE webhook, and testing with a LINE test account. Those external actions are separate from the code migration.

## Not in scope

- Customer sign-up, Supabase Auth, new roles, or a new frontend.
- Real LINE OA webhook configuration, disabling OA Manager greeting, or real Rich Menu publication.
- A guarantee of free-tier uptime, automated cross-provider backups, or multi-instance scaling.
- Horizontal scaling. The per-conversation send lock is process-local; the service remains a single instance for this release.

## Main trade-offs

The async `pg` migration touches database calls across services, routes, tests, startup, and admin rendering, but avoids blocking the Node event loop and fits Supabase's native PostgreSQL interface. A free host/database can keep direct charges at zero within current quotas, but sleeping/pausing behavior can delay or interrupt LINE webhook processing. If that reliability is unacceptable, keep the architecture and move the app/database to paid always-on tiers without changing application data semantics.
