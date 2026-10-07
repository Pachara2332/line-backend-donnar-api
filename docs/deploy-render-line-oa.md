# Deploy Donnar LINE backend on Render

This repo is prepared for a single Render web service with a persistent disk. The backend currently uses SQLite and must stay at one instance; do not enable autoscaling or add replicas. Render's free web services do not support persistent disks, so this blueprint uses a paid Starter service. Confirm current charges in Render before creating resources.

## 1. Push the repo to GitHub

Render deploys from a Git repository. Push this repository to the GitHub remote connected to your Render account, including `render.yaml`. Do not commit `.env`, channel credentials, password hashes, database files, or real customer data. `.gitignore` excludes these local files.

## 2. Create the Render service

1. Sign in to Render and choose **New → Blueprint**.
2. Connect `Pachara2332/line-backend-donnar-api` (or the private fork you intend to deploy).
3. Select the `main` branch and apply the Blueprint.
4. Render prompts for `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, and `STAFF_PASSWORD_HASH`. It is also safe to defer entering them until the service exists, but the app will not start in production until all three are set.
5. After deployment, copy the service's HTTPS URL, for example `https://donnar-line-backend-api.onrender.com`.

The Blueprint attaches a 1 GB persistent disk at `/var/data` and stores SQLite at `/var/data/donnar.sqlite`. Keep one instance. The disk incurs a separate charge and redeploys have brief downtime. Review current plan and storage charges in Render before provisioning.

## 3. Prepare the staff password

On a trusted local machine, run:

```sh
npm ci
node scripts/hash-password.js
```

The script prompts for a password and prints a scrypt hash. Put that hash into the Render `STAFF_PASSWORD_HASH` secret field. Do not put the plain password or hash in Git, this chat, or a ticket. Login at `https://<service-host>/admin/login` with username `admin` and the password you entered.

## 4. Find LINE channel credentials

The OA already has Messaging API enabled according to the design spec. Sign in to [LINE Developers Console](https://developers.line.biz/console/) using an account with Admin access to the provider and Messaging API channel linked to the OA.

- **Channel secret:** open the Messaging API channel → **Basic settings** → copy **Channel secret**.
- **Channel access token:** open the same channel → **Messaging API** tab → issue a channel access token. Use an access token supported by the channel and manage its renewal/rotation in LINE. LINE currently recommends a user-specified-expiration token (v2.1); long-lived tokens can be revoked and reissuing one invalidates the previous long-lived token.
- Enter both values directly into Render's service **Environment** page as `LINE_CHANNEL_SECRET` and `LINE_CHANNEL_ACCESS_TOKEN`. Do not paste them into chat or commit them.

The channel must be the one linked to the existing OA. LINE allows only one Messaging API channel per OA; do not create or link a second one during deployment.

## 5. Set webhook and test

Only after the Render service is **Live** and `/health/ready` returns `{"status":"ready"}`:

1. In LINE Developers Console, open the linked Messaging API channel → **Messaging API** tab.
2. Set **Webhook URL** to `https://<service-host>/webhooks/line`.
3. Click **Verify** and expect success. Enable **Use webhook**.
4. Keep the existing OA greeting and manual handling during initial tests. Do not disable the existing greeting until the backend greeting is confirmed and ready for the chosen cutover.
5. Add the OA as a friend from a test account. Test follow greeting, qualification, each Rich Menu action, BOT → HUMAN → BOT, staff reply, and webhook redelivery.
6. Log in to `/admin`, preview the Rich Menu, then use **สร้างและเผยแพร่ Rich Menu**. This makes real Messaging API calls and sets the new menu as the OA's default menu. The current Rich Menu is not uploaded until this deliberate action.
7. Re-enter the chat to refresh the menu. If it still does not show, check LINE's Rich Menu display priority and remove/disable any per-user or OA Manager menu that takes precedence. LINE clients may not immediately reflect a changed default menu.

When ready for customers, disable overlapping OA Manager greeting/auto-reply settings so customers do not receive duplicate greetings. Keep a rollback path: disable **Use webhook** and restore the prior OA greeting.

## 6. Verify operations

- Render health check: `https://<service-host>/health/ready`
- Staff console: `https://<service-host>/admin/login`
- LINE webhook: `https://<service-host>/webhooks/line`
- Set up an encrypted backup/export process for `/var/data/donnar.sqlite` and define customer-data retention before production use.
- Never scale this SQLite service horizontally. Migrate to managed PostgreSQL before running multiple instances or requiring zero-downtime deploys.

## Current boundaries

This repo can create a menu in LINE and make it default from the back office. It does not log in to Render or LINE on your behalf, cannot issue your channel credentials, and does not change OA settings automatically. Those operations require your account sessions and explicit access. The local fake adapter is disabled in the Render production Blueprint.
