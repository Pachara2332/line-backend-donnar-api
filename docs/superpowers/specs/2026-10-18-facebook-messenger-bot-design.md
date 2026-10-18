# Facebook Messenger Bot and Shared CRM Design

## Status

Draft for user review.

## Goal

Add the DonnarTech Facebook Page as a second customer messaging channel in the existing LINE backend and staff CRM. Customers should get the same core service information, project intake, human handoff, quotation flow, and follow-up experience. Staff should choose LINE or Facebook from the CRM inbox and reply through the selected customer's channel.

The Facebook Page is the DonnarTech asset referenced by the user in Meta Business Suite with asset ID 1415730158282786. The actual Page ID and Page permissions must be verified in Meta before configuration; the Business Suite URL is not treated as an API credential or verified Page ID.

## User-confirmed requirements

- Reuse the current backend, database, leads, quotations, and staff CRM.
- Put LINE and Facebook behind separate channel selection buttons in the same inbox. Selecting a channel filters the conversation list and history; replies use that channel.
- Keep Facebook and LINE identities and conversations separate. Do not automatically link the same person across channels.
- Bring the full current LINE OA bot and CRM feature set to Messenger, including service information, project intake, human handoff, menu actions, quotation delivery and decisions, and staff notifications.
- Messenger project intake must happen in the chat. Ask one question at a time and save each answer into its own lead field. Keep LIFF for the LINE channel.
- Reuse the existing email and Discord staff notifications for Messenger messages.
- Enforce Messenger's standard messaging window and make the restriction visible in the CRM.

## Existing behavior

The current service accepts signed LINE webhooks and stores one conversation and lead per LINE user. The bot presents service, workflow, and portfolio information; gathers project type, goal, optional budget, and contact preference; supports BOT/HUMAN handoff; and lets staff reply from the CRM. LINE LIFF collects additional structured project details. Staff can manage bot copy and the LINE Rich Menu. The quotation workflow creates a PDF and a public customer link for download and accept/reject decisions. Email and Discord notifications use separate outboxes.

The current schema and most CRM queries are LINE-specific. Conversations reference line_users and store line_user_id. Outbound messages are sent only through the LINE client.

## Scope

- Add a Messenger webhook and Page messaging client to the existing Express service.
- Share the bot's business copy, lead state, CRM records, quotation records, and notification outboxes across channels.
- Add Messenger-native message rendering for text, quick replies, menu actions, and quotation links.
- Add channel selection and channel-aware reply behavior to the CRM inbox.
- Add a Messenger menu configuration and publishing flow that exposes the same service, workflow, portfolio, project-intake, and human-handoff actions through Messenger controls.
- Keep the existing lead follow-up queues and editable bot-copy workflow available from the shared CRM.
- Show every structured Messenger intake answer in the CRM lead details, including the fields currently collected by LIFF.
- Make customer-facing references channel-aware. For Messenger, the preferred contact option is chat on the Facebook Page; LINE retains chat in LINE.
- Keep LINE LIFF and current LINE behavior operating as they do now.

## Out of scope

- Automatically matching or merging Facebook and LINE identities.
- Customer broadcast campaigns or other proactive marketing messages.
- Sending ordinary Messenger replies after the standard messaging window. An approved Meta exception is outside this first version.
- Downloading or storing inbound customer media. The CRM records a message type and asks the customer to provide intake details as text.
- Changing the existing LINE LIFF form into a chat flow.
- Connecting the production Facebook Page, storing real Meta credentials, publishing menu changes, or switching live webhooks as part of the local code change. Those account changes require the user's direct involvement and a separate confirmation.

## Customer experience

### Messenger greeting and menu

A first Messenger interaction receives the DonnarTech greeting and supported menu actions. The Messenger menu is text/button based and is managed separately from the image-based LINE Rich Menu. Menu actions map to the same business actions: services, workflow, portfolio, project consultation, and human handoff. Typed commands remain available as a fallback.

### In-chat project intake

The Messenger project-intake action starts a guided conversation and stores progress after every answer:

1. Service type: required, selected from the current six service categories using quick replies.
2. Project goal or problem: required text, up to 1,000 characters.
3. Main features: optional text, up to 1,000 characters.
4. Users and target platform: optional text, up to 500 characters.
5. Desired timeline: optional text, up to 200 characters.
6. Budget: optional, selected from the current five budget ranges using quick replies.
7. Contact preference: optional quick reply for Messenger chat or an online meeting; defaults to Messenger chat.

Optional text fields can be skipped with the existing skip command. A required answer cannot be skipped. The bot confirms completion and leaves the structured values on the same lead record for staff. Quick reply payloads are validated against the allowed choices; free-text length limits match the current LIFF form. The Meta Send API documents quick replies and webhook responses, making them suitable for the fixed-choice fields. The documented API surface reviewed does not describe a multi-field form inside Messenger, so the design uses conversational prompts rather than an external form.

### Handoff and later replies

A customer can request a person at any point through a menu action or the existing handoff phrase. The conversation changes to HUMAN, the bot stops automatic replies, and staff can take over in the CRM. Returning the conversation to BOT resumes the stored step. All staff replies are sent through the conversation's channel.

### Quotations

Staff continue creating and editing quotations from the existing CRM flow. A Messenger delivery uses a Messenger button/link to the existing public quotation page, which already supports PDF download and customer accept/reject decisions. Decisions continue to update the same quotation record and CRM notifications.

The CRM checks Messenger send eligibility immediately before sending a quotation or staff reply. If the standard messaging window has expired, the quotation remains a draft and the CRM explains that the customer must message the Page again before ordinary delivery. It must not mark a blocked quotation as sent. The standard Send API requires a recent customer message or an allowed outside-window exception. This version implements the ordinary response path only.

### Staff notifications

Each newly stored inbound Messenger message creates one email job and one Discord job when those channels are configured, independent of BOT/HUMAN mode. The notification includes the Messenger channel label, available display name or Page-scoped ID, bounded message preview/type, and authenticated CRM link. Duplicate webhook delivery creates no duplicate notification. Existing LINE notification behavior remains unchanged.

## CRM inbox

- Add LINE and Facebook channel buttons to the existing inbox. The selected channel filters the list, search results, history, selected conversation, and reply control.
- Default the inbox to LINE to preserve current navigation behavior. The active channel is preserved in links and after staff actions.
- Display a clear channel label and the platform-specific user identifier. Use the Messenger display name when available and fall back to the Page-scoped ID.
- Staff replies and BOT/HUMAN controls operate on only the selected conversation and send through its channel client.
- Lead details and quotation panels remain shared. Quotation list rows identify which channel owns the conversation.
- Show service type, goal, features, audience/platform, timeline, budget, and contact preference in the selected lead details.
- Lead follow-up queues and bot-copy management remain available from the same staff console; shared copy uses channel-neutral wording where necessary.
- Keep staff authentication, CSRF checks, audit records, and existing SSE inbox updates.

## Architecture and data

The existing Node.js/Express process and PostgreSQL database remain the system of record. The Messenger webhook is an additional route. Its GET verification handles Meta's challenge; its POST handler validates the raw request signature before parsing or processing events. The Page access token, app secret, verify token, Page ID, and selected Graph API version are private configuration, never source code or logs. Messenger remains disabled when the required configuration is absent, so LINE can continue operating.

The business conversation logic is shared through a normalized inbound event containing channel, provider user ID, message type, text or button payload, provider event ID, and event time. Channel adapters translate LINE and Messenger events into that shape and render outbound responses in the platform's supported format. Messenger event IDs are namespaced by provider/Page to avoid collisions with LINE IDs. Message IDs and deterministic payload keys are used for webhook deduplication.

Use a narrow schema migration that preserves existing LINE records:

- Add a channel value to conversations, defaulting existing rows to LINE.
- Keep the existing line_users table and line_user_id column for LINE. Permit a Messenger conversation to have no line_user_id.
- Add messenger_users keyed by the Page-scoped user ID, with optional cached display name/profile data, and add messenger_user_id to conversations.
- Store Messenger menu draft and publication state separately from the image-based LINE Rich Menu publication data.
- Enforce that each conversation has exactly one identity matching its channel, and that one channel identity maps to one conversation.
- Keep messages and leads attached to the same conversation ID. Their channel is obtained through the conversation, avoiding duplicated channel fields on every message.
- Preserve the old LINE columns and rows during rollout; do not delete or rewrite LINE identity data.

The event processor persists an inbound message and any notification jobs in the same transaction, then sends queued replies through the channel adapter. A duplicate event is acknowledged without repeating business actions. API failures use the current message delivery states and sanitized error categories; an ambiguous outcome is recorded as UNKNOWN rather than blindly resent. Profile lookup failure does not block message handling.

## Messenger delivery rules and failures

Meta's standard Send API window is 24 hours from the latest customer message, unless a specifically allowed exception applies. This implementation does not send general-purpose messages outside that window. Check eligibility both when the CRM renders the reply control and immediately before sending, so a stale open inbox cannot bypass the rule. If expired, show the latest customer-message time and explain that the customer must message the Page again. Keep blocked replies and quotation drafts available for later; do not mark them SENT or issue a quotation as delivered.

Transient rate limits and server errors use bounded retries. Permanent rejections and invalid credentials are surfaced as failed delivery without exposing provider response bodies or tokens. Messenger worker failures do not alter the stored inbound conversation or prevent LINE processing. Customer text is escaped in email/Discord output and mention behavior remains disabled.

## Configuration and deployment

- Add optional environment settings for Messenger app secret, webhook verify token, Page access token, Page ID, and pinned Graph API version. Provide blank examples only.
- Keep credentials in Render's private environment settings with synchronization disabled in deployment YAML.
- Configure a Meta app, add the Messenger product, grant the Page messaging permission, subscribe the Page to required message events, and provide the HTTPS webhook callback only after the code is deployed and verified.
- Test first with app-role accounts and a development Page or approved test setup. Confirm Meta's current permission and review requirements before allowing non-role users to message the app.
- The Business Suite asset link supplied in chat is a target reference only. Verify the actual Page ID and ownership during setup.
- No production webhook, Page menu, app permission, secret, deployment, commit, or push is changed by this design document.

## Acceptance criteria

- Staff can switch between LINE and Facebook in the same inbox and see only conversations for the selected channel.
- A Facebook message creates one separate Messenger conversation and lead in the existing CRM without changing LINE records.
- The Messenger bot presents service information, workflow, portfolio, menu actions, and handoff consistent with the LINE OA.
- Project intake runs entirely in Messenger chat, asks one field at a time, saves structured values as answered, enforces required fields and length limits, and allows optional fields to be skipped.
- Staff can take over, reply, return to BOT, and see the same conversation history from the CRM. The reply is sent through the correct platform.
- Staff can create, send, resend, and track quotations from Messenger conversations when eligible. Customer PDF access and accept/reject decisions update the existing quotation workflow.
- Staff can use existing lead follow-up queues and edit/publish the shared bot copy without losing the selected channel context in the inbox.
- The CRM displays all structured Messenger intake fields and supports preview/confirmation before publishing Messenger menu changes.
- Inbound Messenger messages create one email and one Discord notification when configured; redelivery does not duplicate jobs.
- Ordinary Messenger sends are blocked after the standard window expires; the CRM shows why and preserves unsent work.
- LINE LIFF, LINE Rich Menu, LINE replies, LINE quotes, and current notification behavior continue to work.
- Meta secrets remain out of the repository and logs. Invalid webhook signatures are rejected.

## Verification and rollout

The repository's global instructions prohibit adding or running tests unless the user asks. Implementation verification will therefore follow the requested scope and will not run tests unless requested. Before describing the web UI as complete, visually inspect the inbox on iOS and Android as required by the repository instructions; do not start another development server. Validate Messenger behavior on a development/test Page before enabling the production Page webhook.

No real Meta API request, Page configuration, production secret update, deployment, commit, or push is included in the implementation until the user separately authorizes that action.

## External references

- Meta's [Messenger Platform API collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api?entity=request-22794852-87cd5a4f-57a9-4345-adfc-8794954779da) documents Page access tokens, pages_messaging permission, Send API, quick replies, and the standard 24-hour messaging window.
- Existing flow and schema references: README.md, service/conversationService.js, service/liffIntake.js, service/lineMessagingClient.js, database/schema.sql, and current quotation and notification services.
