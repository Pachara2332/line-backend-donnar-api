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

```sh
npm ci
npm test
npm audit
```

Tests use an in-memory PostgreSQL-compatible database and fake LINE client; they do not call LINE or alter OA settings.

## Rollback

If automated behavior is wrong, disable **Use webhook** in LINE Developers and restore the former OA greeting/auto-reply. Do not delete the Supabase project or Render secrets while investigating. Export the database before any reset. No real OA settings are changed automatically by this backend.

## Existing SQLite data

Deploy does not import local SQLite data. Back up the SQLite file first, initialize an empty Supabase schema, then run the explicit importer from a trusted local machine:

```sh
DATABASE_URL='postgresql://…' node scripts/import-sqlite-to-postgres.js ./data/donnar.sqlite
```

The importer refuses a non-empty target and uses a single transaction. Review counts and test the console before enabling the LINE webhook.
