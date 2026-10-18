# Facebook Messenger Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add Facebook Messenger as a second channel in DonnarTech's existing bot and CRM while retaining current LINE behavior.

**Architecture:** Keep Express, PostgreSQL, and the existing CRM as the system of record. Add Messenger webhook and messaging adapters, normalize channel identities and inbound events into the existing conversation workflow, and make CRM queries and replies channel-aware. Keep Messenger configuration optional so LINE remains operable when Messenger is not configured.

**Tech Stack:** Node.js 20+, Express, PostgreSQL, server-rendered HTML, browser JavaScript, Meta Messenger Platform Send API.

**Spec:** [2026-10-18-facebook-messenger-bot-design.md](../specs/2026-10-18-facebook-messenger-bot-design.md)

## Global Constraints

- Preserve existing LINE conversations, LINE LIFF intake, LINE Rich Menu, quotations, and notification delivery.
- Keep LINE and Messenger identities separate; do not auto-link customers across channels.
- Require the Page access token, App secret, webhook verify token, Page ID, and pinned Graph API version through environment configuration only.
- Reject Messenger webhook requests with invalid raw-body signatures before parsing or processing events.
- Enforce the ordinary 24-hour Messenger response window both when showing the CRM composer and immediately before sending; leave blocked quotations unsent.
- Do not send broadcasts or ordinary Messenger messages outside the response window.
- Do not publish Page settings, production secrets, menus, webhooks, or deployment changes as part of local code work.
- Do not add or run tests unless the user asks; do not start a server or create a worktree.
- Do not add source-code comments, commit, or push without the user's explicit instruction.
- Do not overwrite pre-existing working-tree changes; modify only files required by this feature.
- Before calling CRM UI complete, visually inspect iOS and Android; report it as unverified if those environments are unavailable.
- Meta's official Messenger Platform collection requires `pages_messaging`, a Page token from someone with the Page's `MESSAGE` task, and a recent user message or an allowed outside-window exception; text quick replies support up to 13 choices. Use [Send API](https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api) and [Quick Replies](https://www.postman.com/meta/messenger-platform-api/folder/hnhvmum/quick-replies) as the API references.

## Review Focus

- Invalid signatures and malformed events must be rejected without creating conversations, messages, or notification jobs.
- Redelivered or cross-channel event IDs must not duplicate a lead, message, notification, or bot action.
- Existing LINE identity rows must remain valid after migration; a Facebook conversation must have exactly one Facebook identity and no LINE identity.
- Intake must reject invalid service and budget choices, enforce each field's length limit, require service type and project goal, and permit skipping only optional answers.
- An expired Messenger response window must block both staff replies and quotation delivery even if the inbox page was left open before expiry.

## Implementation Tasks

### Task 1: Add channel identity, migration, and optional Messenger configuration

**Files:**
- Create: `database/migrations/007_messenger_channel.sql`
- Modify: `database/schema.sql`
- Modify: `config/environment.js`
- Modify: `.env.example`
- Modify: `render.yaml`

**Interfaces:**
- Add `channel` to `conversations`, defaulting existing records to `LINE`; allow only `LINE` and `FACEBOOK` values.
- Add `messenger_users` keyed by Page-scoped user ID, and nullable `messenger_user_id` on `conversations`; make `line_user_id` nullable while retaining its existing foreign key and unique behavior.
- Enforce one identity per conversation matching its channel and one conversation per identity.
- Add `messages.provider_timestamp` for the Facebook event time and `messenger_menu_publications` for Messenger menu draft/publication state.
- Add Messenger settings `MESSENGER_APP_SECRET`, `MESSENGER_WEBHOOK_VERIFY_TOKEN`, `MESSENGER_PAGE_ACCESS_TOKEN`, `MESSENGER_PAGE_ID`, and `MESSENGER_GRAPH_API_VERSION` to `loadConfig`; enable Messenger only when the required values exist.

- [ ] Write a forward-only SQL migration that preserves existing LINE rows, backfills `channel = 'LINE'`, adds Messenger identity and event-time storage, creates menu publication state, and installs channel/identity constraints.
- [ ] Update `schema.sql` to describe the same final schema as the migrations.
- [ ] Load optional Messenger configuration and keep production startup requirements for LINE unchanged.
- [ ] Add blank Messenger environment examples and unsynchronized Render environment keys; do not add credentials.
- [ ] Inspect the migration and configuration paths for preservation, disabled-by-default behavior, and secret leakage.

### Task 2: Add signed Messenger webhook and Send API adapter

**Files:**
- Create: `middleware/messengerWebhookValidation.js`
- Create: `service/messengerMessagingClient.js`
- Modify: `app.js`
- Modify: `server.js`

**Interfaces:**
- Export `createMessengerSignatureMiddleware(appSecret)` to validate `X-Hub-Signature-256` against the original request bytes using HMAC-SHA-256.
- Export `createMessengerMessagingClient({ accessToken, pageId, graphApiVersion, fetchImpl })` with `send(recipientId, message)` and `getProfile(recipientId)` methods. Profile lookup is best-effort; provider failures expose sanitized categories, never the raw body or token.
- Add `GET /webhooks/messenger` challenge verification and `POST /webhooks/messenger` event handling. Parse the raw JSON only after signature validation.
- Normalize Page events into an internal event with `channel`, Page-scoped user ID, provider event ID, event type, text or payload, message type, event timestamp, and optional reply token.

- [ ] Implement raw-body HMAC validation with timing-safe digest comparison and reject missing or invalid signatures.
- [ ] Implement the Graph API Send API client using the configured pinned version and Page access token.
- [ ] Construct the Messenger client only when configuration is complete; preserve LINE startup and shutdown behavior.
- [ ] Validate the webhook verification challenge using the configured verify token; return the challenge only on an exact match.
- [ ] Validate the POST envelope and individual event shape before calling the conversation service.
- [ ] Namespace Messenger provider event IDs by Page and preserve deterministic IDs for events without a provider message ID.
- [ ] Inspect error handling to ensure invalid signatures are rejected and Graph API details and credentials are not logged.

### Task 3: Share conversation processing and implement Messenger bot/intake

**Files:**
- Modify: `service/conversationService.js`
- Modify: `service/messageCatalog.js`
- Modify: `database/seed.js`
- Modify: `service/liffIntake.js`
- Modify: `service/responseCards.js`
- Create: `service/messengerResponses.js`

**Interfaces:**
- Add a normalized inbound processor accepting `{ channel, providerEventId, userId, type, text, payload, messageType, occurredAt, replyToken }`; retain the existing LINE event entry point as a LINE adapter.
- Add `getCopy(client, key, channel)` or equivalent channel-aware wording while keeping the existing CRM copy revision editor shared.
- Reuse the service-category and field-limit definitions from `liffIntake.js` for Messenger validation without changing LIFF rendering or submission behavior.
- Dispatch queued replies through the adapter selected by `channel`; serialize Messenger text and quick replies as Messenger payloads and LINE responses as current LINE messages.
- Add Messenger intake state for `serviceType`, `projectSummary`, `features`, `audience`, `timeline`, `budgetRange`, and `contactPreference`, saving each accepted answer immediately to `leads.requirements_json`.
- Keep the LINE question flow and LIFF submission behavior unchanged.

- [ ] Adapt LINE webhook events into the normalized event without changing their existing behavior.
- [ ] Process Messenger events into the existing conversations, messages, leads, and notification outboxes in a transaction; ignore duplicate deliveries before running business actions.
- [ ] Use Page-scoped Messenger IDs in `messenger_users`; do not create or match a `line_users` row for Messenger.
- [ ] Refresh Messenger profile name and picture as best-effort metadata; profile lookup failure must not block message processing.
- [ ] Implement Messenger menu actions for services, workflow, portfolio, project consultation, and human handoff, with typed-command fallbacks.
- [ ] Render fixed choices as Messenger quick replies and validate their payloads against the six service categories and five budget ranges.
- [ ] Ask the Messenger intake fields one at a time, enforce LIFF's text limits, require service type and project goal, and allow optional fields to be skipped.
- [ ] Store the provider event timestamp and use it as the Messenger response-window reference.
- [ ] Offer Facebook chat or an online meeting for contact preference; default Messenger leads to Facebook chat.
- [ ] Store non-text messages as bounded type placeholders; do not fetch or persist customer media.
- [ ] Keep transient rate-limit/server failures retryable and mark ambiguous send outcomes UNKNOWN rather than blindly resending.
- [ ] Keep the LINE LIFF form and LINE question flow intact; update only the shared copy needed to avoid describing Messenger as LINE.
- [ ] Inspect each channel path for duplicate processing, mode handling, saved progress, and unchanged LINE behavior.

### Task 4: Add LINE/Facebook selection and channel-aware CRM inbox operations

**Files:**
- Modify: `app.js`
- Modify: `public/admin-inbox.js`
- Modify: `service/conversationService.js`

**Interfaces:**
- Preserve `GET /admin/inbox?channel=LINE|FACEBOOK&conversation=<id>`; default missing or invalid channel to `LINE`.
- Add `conversations.getMessengerSendEligibility(conversationId, now)` or an equivalent service query based on the latest inbound provider timestamp.
- Include channel, channel user ID, identity display name, send eligibility, and structured lead requirements in the inbox page and `/admin/inbox/updates/:id` response.
- Keep reply, BOT/HUMAN, profile-refresh, history, search, and SSE routes scoped to the selected conversation and channel.

- [ ] Add LINE and Facebook channel buttons; preserve the selected channel in filters, search, deep links, redirects, follow-up links, quote return links, and SSE refreshes.
- [ ] Make inbox, updates, conversation detail, lead search, follow-up, and quotation queries join the correct identity table for each channel.
- [ ] Display channel identity and every structured intake field in the lead detail panel.
- [ ] Add channel-specific human replies through the matching adapter, preserving authentication, CSRF, audit logging, and HUMAN-mode checks.
- [ ] Hide or disable the Messenger composer when the last customer message is older than 24 hours and show the reason and last-message time.
- [ ] Recheck Messenger eligibility immediately before the provider call so a stale inbox cannot send outside the window.
- [ ] Inspect links and form destinations to confirm the active channel and conversation remain selected after staff actions.

### Task 5: Make quotations and staff notifications channel-aware

**Files:**
- Modify: `app.js`
- Modify: `service/quotationPages.js`
- Modify: `service/emailClient.js`
- Modify: `service/emailNotificationWorker.js`
- Modify: `service/discordBotClient.js`
- Modify: `service/discordNotificationWorker.js`

**Interfaces:**
- Route quotation delivery by the conversation's channel while keeping the existing public quotation URL and decision flow.
- Preserve PDF access and customer accept/reject decisions on the existing quotation record.
- Reuse the existing email and Discord outboxes for both channels; include channel label and the correct platform-specific identity in generated notifications.

- [ ] Select the correct messaging client for quotation delivery and show the channel in quotation list rows.
- [ ] Leave a Messenger quotation in draft when its response window has expired; never mark it SENT or delivered in CRM.
- [ ] Update notification worker joins to obtain LINE or Messenger identity without assuming a LINE row exists.
- [ ] Include a safe channel label and profile ID fallback in email and Discord notifications; escape text, bound previews, and disable mention behavior as today.
- [ ] Preserve per-event deduplication and the existing independent retry states for email and Discord.
- [ ] Inspect failure paths to confirm Messenger API errors do not block LINE delivery or corrupt quotation/notification state.

### Task 6: Add Messenger menu draft/publish management and setup documentation

**Files:**
- Create: `service/messengerMenu.js`
- Modify: `app.js`
- Modify: `README.md`

**Interfaces:**
- Keep Messenger menu draft/publication state separate from `rich_menu_publications`.
- Add staff-authenticated, CSRF-protected preview, draft, cancel, and publish operations; require explicit confirmation before the Page menu is changed.
- Display the active channel selector and keep the existing LINE Rich Menu workflow intact.

- [ ] Store Messenger menu configuration and publication outcome separately from LINE image-based Rich Menu records.
- [ ] Render the same service, workflow, portfolio, project-intake, and handoff actions using Messenger-supported menu controls.
- [ ] Add preview-before-publish flow, audit records, sanitized API errors, and a visible success/failure state.
- [ ] Document Meta app setup, `pages_messaging`/Page `MESSAGE` access, webhook fields, development Page setup, and production activation steps without adding real credentials.
- [ ] Inspect the deployment YAML to confirm every new credential remains unsynchronized and production LINE behavior is unchanged.

### Task 7: Cross-surface review and completion check

**Files:**
- Review only: all files changed by Tasks 1–6

- [ ] Compare each acceptance criterion in the design spec with its owning implementation task.
- [ ] Review webhook validation, channel identity constraints, event deduplication, 24-hour enforcement, CSRF protection, and sanitized errors.
- [ ] Inspect the diff to confirm unrelated pre-existing changes are untouched and no comments or credentials were added.
- [ ] Do not run tests or start a server unless the user asks; do not claim runtime or visual verification without performing it.
- [ ] If a running CRM instance and iOS/Android environments are available, inspect the channel selector and conversation flow on both platforms; otherwise report the UI as not visually verified.
- [ ] Leave all files uncommitted and unpushed.
