# LINE Group Poll Bot

This service is a separate LINE Official Account bot for attendance polls. It runs separately from the Donnar.Tech LINE backend and does not use Donnar.Tech's channel credentials, webhook URL, CRM tables, or database role.

## Local configuration

Copy `.env.example` to `.env` in this directory and set:

- `GROUP_BOT_DATABASE_URL`: PostgreSQL connection string for a database dedicated to this bot.
- `GROUP_BOT_LINE_CHANNEL_SECRET`: channel secret for the new LINE Messaging API channel.
- `GROUP_BOT_LINE_CHANNEL_ACCESS_TOKEN`: channel access token for the new channel.
- `GROUP_BOT_PORT`: optional local port; defaults to `3001`.

Run the service from the repository root with `node group-poll-bot/server.js`. On startup, the service creates the `group_poll_bot` schema in its dedicated database and applies pending migrations. Set `GROUP_BOT_DATABASE_URL` to that database's connection string. Do not use the Donnar.Tech `DATABASE_URL` in the group bot service. Keep `.env` out of Git and do not paste credentials into chat.

## LINE setup

1. Create a new LINE Official Account and enable Messaging API for it.
2. In the channel's Messaging API settings, enable **Allow bot to join group chats**. LINE permits one Official Account in a group at a time.
3. After creating the Render service, set its webhook URL to `https://<group-bot-service>.onrender.com/webhooks/line`, verify it, and enable webhook delivery.
4. Add the new OA as a friend, then invite it into a non-production test group.

The bot replies to recognized slash commands in group text messages. It records exact `+1` and `-1` messages while a poll is open, and ignores other ordinary messages, direct messages, and non-text messages. Each `+1` produces a card with the member's LINE name and profile image when available, current totals, and buttons to summarize or close the poll. The buttons work only in the group where the poll is open.

## Render setup

Create a new Web Service in Render from this repository and the same code branch. Leave the service root at the repository root so Node can resolve the existing dependencies and shared helper modules. Use:

- Build command: `npm ci`
- Start command: `node group-poll-bot/server.js`
- Health check path: `/health/ready`
- Environment: `NODE_ENV=production`, `GROUP_BOT_DATABASE_URL`, `GROUP_BOT_LINE_CHANNEL_SECRET`, `GROUP_BOT_LINE_CHANNEL_ACCESS_TOKEN`

Configure the new service's build filter to include these repository-root paths:

```text
group-poll-bot/**
middleware/webhookValidation.js
service/lineMessagingClient.js
package.json
package-lock.json
```

Before pushing group bot source, configure the existing `donnar-line-backend-api` service's ignored build paths in Render Dashboard:

```text
group-poll-bot/**
docs/superpowers/specs/2026-10-17-line-group-poll-bot-design.md
docs/superpowers/plans/2026-10-17-line-group-poll-bot.md
```

The Donnar service currently has no build filter in its checked-in configuration. Keep `render.yaml` unchanged; configure the new service and these filters in Render Dashboard. Render processes Blueprint file changes even when build filters are set, so these dashboard settings keep the Donnar Blueprint and service definition untouched. The Donnar filter must be active before a commit containing group bot files is pushed. Render build filter patterns are relative to the repository root.

Render Free services may sleep while idle, so the first webhook after inactivity can be delayed.

## Commands

- `/นับคน <หัวข้อ>` — open a poll, such as `/นับคน ไปร้านเหล้าวันที่ 19 ตุลา 69`.
- `+1` — vote to go.
- `-1` — vote not to go.
- `/ยกเลิกโหวต` — remove your own vote.
- `/สรุปโหวต` — show the current totals.
- `/ปิดโหวต` — close the poll and show final totals. Any group member can close it.

Only one poll can be open in a group. A member can change their vote before the poll closes. Individual vote rows are deleted on close; only the poll heading and final aggregate counts remain.
