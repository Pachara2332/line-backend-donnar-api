# LINE LIFF Project Intake Design

**Status:** Draft for user review  
**Date:** 2026-10-08

## Goal

Make the “ปรึกษาโปรเจกต์” action visibly start a short project brief instead of leaving customers to guess what to type. Customers open a small LIFF form from the LINE chat, submit rough requirements, see a clear completion state, and have the submission attached to the existing LINE conversation and lead for staff follow-up.

## Current behavior

The welcome card uses a LINE postback action for “ปรึกษาโปรเจกต์”. The webhook handles `START_QUALIFY` and sends the service type question in the chat. A postback does not open a form or popup. The current bot can collect service type, project summary, optional budget, and contact preference as a conversational flow. The database already stores one lead per conversation with a `requirements_json` field.

## Options considered

1. **Chat-only quick replies:** Keep the intake in the conversation, add quick reply choices, and ask one question at a time. This is the smallest change and needs no LIFF setup, but it is less effective for collecting several structured details at once.
2. **LIFF brief form:** Open a compact form inside LINE. It is clearer for structured requirements, but needs a LIFF app registered to the Messaging API channel and a new hosted form/API flow.
3. **Hybrid LIFF form with chat confirmation (recommended):** Open a short LIFF form from the existing card. Save the structured brief to the existing lead, show a success state in LIFF, and send a confirmation message back to the LINE chat. Keep free-text chat intake and “คุยกับคน” available as alternatives.

## User flow

1. Customer taps “ปรึกษาโปรเจกต์” on the welcome card.
2. LINE opens the LIFF form in its in-app browser.
3. Form requests only a rough brief:
   - Service type (required; website, web app, mobile app, internal system, automation/AI, or other).
   - What problem or goal the project should address (required).
   - Key features or functions (optional).
   - Intended users and platform (optional).
   - Desired timeline (optional).
   - Approximate budget range (optional, with “ยังไม่แน่ใจ”).
   - Preferred next step/contact preference (optional; LINE chat is the default).
4. On submit, backend verifies the LIFF ID token with LINE, derives the LINE user ID from the verified response, and associates the brief with that user’s existing conversation and lead.
5. The form shows a success state. The backend sends a short confirmation to the same LINE chat and tells the customer that a staff member can review the brief.
6. Staff see the new details in the existing back office lead row and conversation history. They can take over through the existing HUMAN handoff.

## Architecture and interfaces

- Serve a responsive, single-page form from this backend at `/liff/intake`; do not add a separate hosting service or customer account system.
- Add `LIFF_ID` as a Render environment variable. The LIFF app is registered under the existing LINE Developers channel with the HTTPS endpoint URL and the minimum `openid` scope required to obtain an ID token.
- Change only the welcome-card “ปรึกษาโปรเจกต์” action to a URI action that opens the LIFF URL. Keep “ดูบริการ” and “คุยกับทีม” behavior unchanged. Keep the three Rich Menu message actions unchanged.
- Add `POST /api/intake/project` accepting the raw ID token plus validated form fields. Verify the token against LINE’s ID-token verification endpoint using the expected channel ID; never accept a client-supplied LINE user ID as identity.
- Upsert into the existing conversation and lead records. Store normalized fields in `leads.requirements_json`, mark the lead `QUALIFIED` when the required brief is saved (or preserve `HUMAN_REQUIRED` if already in HUMAN mode), and set the conversation’s current step to `complete` so the next chat message does not restart the wizard unexpectedly.
- Record the submission in the existing message history as a concise inbound intake summary, without logging the ID token or adding a separate customer account table.
- Generate a submission UUID in the LIFF client and record an event key such as `liff:<uuid>` in the existing `webhook_events` table in the same transaction. This makes retries idempotent without adding a new table or database.
- Send the LINE confirmation through the existing Messaging API client after persistence. If the LINE push fails, keep the saved lead, show success in LIFF, and report that chat confirmation could not be sent so the customer can continue in the chat.

## Validation, security, and failure handling

- Validate required fields, allowed service categories, string lengths, and request size on the server.
- Verify the ID token server-side and check its audience against the configured channel. Derive the LINE user ID only from the verified token response.
- Rate-limit the public submission endpoint. Do not log submitted contact data, tokens, or full payloads.
- Persist the lead before attempting outbound confirmation. A retry must update the same lead rather than create a second lead for the same conversation.
- If LIFF initialization or token verification fails, explain that the form could not verify the LINE session and provide a link back to chat; do not accept an unverified user ID.
- Preserve BOT/HUMAN behavior. If the conversation is already HUMAN, save the requirements but do not resume automated qualification; notify the customer that the team has the brief.

## Acceptance criteria

- Tapping “ปรึกษาโปรเจกต์” opens the LIFF page, and the page works inside LINE on mobile.
- The form clearly indicates which fields are required and submits only after basic validation.
- A valid submission is attached to the existing LINE user’s conversation and lead with the selected and typed details visible in `/admin`.
- The customer sees an in-form success state and receives one concise chat confirmation when LINE push succeeds.
- Repeated submission updates the existing lead and does not create duplicate lead records.
- Invalid, expired, or wrong-channel ID tokens cannot write to a lead; tokens are not logged.
- “ขอดูบริการ”, “คุยกับคน”, Rich Menu actions, free-text chat intake, and existing staff handoff continue to work.

## Deployment dependencies

- Register a LIFF app under the existing LINE Developers channel, set endpoint URL to `https://donnar-line-backend-api.onrender.com/liff/intake`, and enable the `openid` scope.
- Add `LIFF_ID` to Render. The form can be deployed before LIFF is registered, but the card action should not switch to the LIFF URI until the LIFF ID and endpoint are configured.
- Verify the webhook and send a test brief from a LINE test account before treating the intake as live.

## References

- [LIFF overview](https://developers.line.biz/en/docs/liff/overview)
- [Using user data in LIFF apps and servers](https://developers.line.biz/en/docs/liff/using-user-profile/)
- [LINE actions](https://developers.line.biz/en/docs/messaging-api/actions/)
- [Quick replies](https://developers.line.biz/en/docs/messaging-api/using-quick-reply/)
