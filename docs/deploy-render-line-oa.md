# Deploy Donnar LINE backend with Render Free and Supabase Free

This repository is prepared for one Render Free Node service backed by Supabase PostgreSQL. No persistent Render disk or paid database add-on is required by the Blueprint. Free services sleep when idle and are not suitable where uninterrupted webhook response or managed backups are required.

## 1. Create the Supabase database

1. Create a Supabase project in a region close to the Render Singapore service.
2. In **Project Settings → Database → Connection string**, choose the **Session pooler** connection string. This is suitable for a long-lived Node `pg` pool and Render's IPv4-only outbound networking.
3. Copy the connection string privately. Keep the password safe; do not commit it, put it in this repository, or paste it into chat.
4. The app uses TLS with certificate validation. If the provided URL does not request SSL, append `?sslmode=require` (or `&sslmode=require` when it already has query parameters).
5. Supabase Free currently provides up to 500 MB of database storage. Free projects with low activity may pause after seven days and do not include downloadable database backups. Keep an independent, encrypted export and verify your restore procedure before storing business-critical conversations.

## 2. Push the repository and create the Render service

1. Push this branch to your GitHub repository's `main` branch after reviewing the changes.
2. In Render choose **New → Blueprint**, select the repository and deploy the Blueprint from `main`.
3. The Blueprint creates one Free web service, uses `/health/ready` for readiness, and asks for the out-of-band values `DATABASE_URL`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `STAFF_PASSWORD_HASH`.
4. Put each value directly in Render's environment/secret UI. The app will not start in production until all four are present and valid. Never put them into `render.yaml`, Git, or chat.
5. Leave the service at one instance. Render Free has an ephemeral filesystem; the app stores business data in Supabase only.
6. Wait for deployment and confirm `https://<service-host>/health/ready` returns `{"status":"ready"}`. The first request after idle may be slow while the Free service wakes.

## 3. Generate the staff password hash

Run this locally and enter a password of at least 12 characters:

```sh
node scripts/hash-password.js
```

Put the printed scrypt hash directly into Render as `STAFF_PASSWORD_HASH`. Do not share the hash or password. Staff login is at `https://<service-host>/admin/login`; default username is `admin` unless `STAFF_USERNAME` was overridden.

## 4. Configure LINE Developers

1. In the Messaging API channel associated with the Donnar.Tech Official Account, set the webhook URL to `https://<service-host>/webhooks/line`.
2. Verify the webhook. Check the Render health endpoint if the verification fails; do not weaken signature checks.
3. Enable **Use webhook** only after verification. Keep the previous greeting and OA auto-replies in mind while testing, since they may overlap.
4. Use a test account to verify follow greeting, duplicate delivery, text qualification, all three Rich Menu message actions, BOT → HUMAN → BOT, staff replies, and invalid signature rejection.
5. After validation, disable the overlapping greeting/auto-reply in LINE OA Manager so customers receive only one greeting.

## 5. Preview and publish Rich Menu

1. Sign in to `/admin/login` and inspect the leads/conversation console.
2. Use **ดูตัวอย่าง** to review the menu image and actions.
3. Use **สร้างและเผยแพร่ Rich Menu** to create the menu through LINE Messaging API and make it the default. Replacing an active menu requires a separate confirmation.
4. Open a LINE chat with the OA, close/reopen the chat if needed, and confirm the menu displays. Verify all three actions.

## Local verification

Use a separate local/development database. Keep `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`, `RESEND_API_KEY` and `RESEND_FROM_EMAIL` blank to disable notification delivery during local work. `LINE_FAKE_MODE=true` only disables real LINE API calls; it does not disable Discord or Resend when their notification settings are present. Do not copy production connection strings or provider credentials into local verification.

```sh
npm ci
npm test
npm audit
```

Tests use an in-memory PostgreSQL-compatible database and fake LINE client; they do not call LINE or alter OA settings.

## LINE chat Discord notifications

1. Create an application in the Discord Developer Portal and add/configure its **Bot**. Copy its bot token privately. An ordinary server invite link does not create a bot application or supply its token.
2. Generate the application's installation link with the `bot` scope and the **View Channel** and **Send Messages** permissions, then install it in your server with an account allowed to add bots. In the target text channel, confirm channel overrides allow the bot to view and send messages. This integration sends notifications through REST only; it does not need a Gateway connection, commands, or privileged intents.
3. Enable Discord Developer Mode, use **Copy Channel ID** on the target text channel, and enter it as `DISCORD_CHANNEL_ID` in Render's **Environment** UI. Enter the bot token privately as `DISCORD_BOT_TOKEN`. Both are declared with `sync: false`; never put the token in YAML, Git, logs, documentation or chat.
4. Set `PUBLIC_BASE_URL` to the deployed HTTPS origin, then save and redeploy when ready. Startup applies the separate Discord outbox migration. If either Discord setting is absent, new Discord jobs and its worker are disabled while LINE and the separately configured email channel continue normally. Previously queued jobs wait until configuration is restored; messages received while disabled are not backfilled.
5. After deployment, send a new message from a LINE test account and inspect the selected Discord channel yourself. Confirm the preview and CRM link; opening the conversation requires the usual staff login. No bot credentials or live Discord delivery have been configured or verified by this implementation.

Each newly inserted inbound LINE `message` event creates one Discord outbox job in the same transaction as message persistence, in BOT and HUMAN modes. Duplicate webhook events do not add another job. Follow, unfollow, postback and LIFF intake do not create alerts. Notifications include cached LINE display name or user ID fallback, user ID, received time, a preview of up to 300 characters or non-text label, and `/admin?conversation=<id>#inbox`. Customer Markdown is escaped, mentions are disabled, and media is not downloaded. Payload content is snapshotted before sending and reused on retries. The bot token is never stored in the outbox.

The worker runs independently of the LINE webhook, claims one job at a time with PostgreSQL locking, and confirms the returned Discord message ID before saving success. Network failures, HTTP 429 and 5xx retry with exponential delay from 10 seconds to one hour. HTTP 429 also respects the provider retry delay up to one hour. Other provider rejections, invalid bot/channel configuration and invalid content become `FAILED`. A `SENDING` job older than two minutes is recovered for retry. This sender does not use provider deduplication, so an ambiguous timeout or a crash between posting and recording success may produce a duplicate Discord message. Render Free sleep delays queued delivery until wake-up. Shutdown stops polling and waits for active work before closing the database.

### Inspect Discord failures in local/development only

Use a separate local/development database with synthetic data and current migrations. Confirm the host and database name in your own database client, then run this metadata-only query yourself if needed. Do not use production credentials or export customer message bodies or `discord_payload`.

```sql
SELECT id, status, attempts, next_attempt_at, sent_at, last_error, updated_at
FROM line_chat_discord_notifications
WHERE status IN ('FAILED', 'PENDING', 'SENDING')
ORDER BY updated_at DESC
LIMIT 50;
```

Logs contain a job ID, status and sanitized error category. For `discord_configuration`, check the private bot token and decimal channel ID settings; for `discord_provider_rejected`, check the bot token and channel permissions. Transient network, rate-limit and provider failures retry automatically. `FAILED` jobs stay failed after settings are corrected; metadata inspection does not reset or replay sends. No database connection is required to read this guidance.

## LINE chat email notifications

1. In Resend, add and verify the sending domain and complete its required DNS records. Choose `RESEND_FROM_EMAIL` as an address on that verified domain; an unverified sender cannot deliver these notifications.
2. In the Render service's **Environment** UI, enter `RESEND_API_KEY` and `RESEND_FROM_EMAIL` privately. The Blueprint declares both with `sync: false`; do not put an API key in `render.yaml`, Git, or chat.
3. Keep `CHAT_NOTIFICATION_EMAIL=mrtgamer76@gmail.com`, or replace it with the intended recipient in Render. Set `PUBLIC_BASE_URL` to `https://<service-host>` so emails point to the deployed CRM.
4. Save the settings and redeploy through Render when ready. Startup applies the outbox migration. If either the key or sender is absent, enqueueing and delivery are disabled while current LINE chat handling continues. Messages received while disabled are not backfilled; existing queued jobs wait until email configuration is restored.

Each newly processed inbound LINE `message` event creates one job, including messages in BOT and HUMAN modes. Redelivery of the same webhook event does not create another job. Follow, unfollow, postback, and LIFF intake events do not generate chat emails.

The email contains the cached LINE display name or LINE user ID fallback, LINE user ID, received time, up to 300 characters of text or a label for the message type, and a direct `/admin?conversation=<id>#inbox` link. Customer text is escaped for HTML, and media is not downloaded. Staff must authenticate in the CRM to open the conversation; the email link does not bypass login.

The worker polls while the web service is running and sends separately from webhook processing. Network failures, HTTP 429/5xx, and concurrent idempotency conflicts are retried with an exponential delay from 10 seconds up to one hour. Other provider rejections are marked `FAILED` for investigation. A job left `SENDING` for over two minutes becomes eligible for retry. Retries use the same Resend idempotency key and stored email payload. Resend retains idempotency keys for 24 hours, so an ambiguous retry after a longer outage may send a duplicate email.

Render Free sleep stops polling and delays queued email until the service wakes. The first webhook after idle can also be delayed. Do not rely on immediate notifications while the service sleeps.

### Inspect failed jobs in local/development only

Use an independently created local/development database with synthetic data and the current migrations applied. Confirm the database host and database name in your own database client before running the following read-only query yourself. Do not run it against production or reuse the deployed `DATABASE_URL`. No database connection or query is needed to review these instructions.

```sql
SELECT id, status, attempts, next_attempt_at, sent_at, last_error, updated_at
FROM line_chat_email_notifications
WHERE status IN ('FAILED', 'PENDING', 'SENDING')
ORDER BY updated_at DESC
LIMIT 50;
```

`last_error` contains a sanitized category; logs identify the job and status without message contents or provider response bodies. Check configuration for `email_configuration`, sender/provider settings for `email_provider_rejected`, and connectivity or provider availability for transient errors. `FAILED` jobs are not automatically retried after configuration is fixed. This query only inspects metadata; leave message bodies and `email_payload` out of diagnostic exports, and do not reset job state or replay sends during inspection.

## Rollback

If automated behavior is wrong, disable **Use webhook** in LINE Developers and restore the former OA greeting/auto-reply. Do not delete the Supabase project or Render secrets while investigating. Export the database before any reset. No real OA settings are changed automatically by this backend.

## Existing SQLite data

Deploy does not import local SQLite data. Back up the SQLite file first, initialize an empty Supabase schema, then run the explicit importer from a trusted local machine:

```sh
DATABASE_URL='postgresql://…' node scripts/import-sqlite-to-postgres.js ./data/donnar.sqlite
```

The importer refuses a non-empty target and uses a single transaction. Review counts and test the console before enabling the LINE webhook.
