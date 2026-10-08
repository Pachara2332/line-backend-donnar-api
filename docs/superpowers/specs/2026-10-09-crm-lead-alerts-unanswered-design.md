# CRM lead alerts and unanswered conversation queue

Date: 2026-10-09

## Goal

Help Donnar.Tech staff notice new LINE leads and reply to conversations that are still waiting for a response, without adding a third-party notification service or sending unsolicited messages to customers.

## Selected approach

Use the existing authenticated CRM and PostgreSQL database. Persist an in-app notification when a lead is first created, and show unread lead notifications in the CRM. Separately, derive an unanswered queue from message history: a conversation is waiting when its latest inbound customer message is newer than its latest successfully delivered outbound message, or when no successful outbound message exists. Sort by oldest customer message first so the longest wait is easiest to spot. No cron job is needed; the queue is calculated when the CRM loads.

Opening a conversation from the queue takes staff to the existing inbox and composer. A successful staff reply already appears as an outbound `SENT` message and therefore removes the conversation from the waiting queue on the next page load. Failed or uncertain sends do not clear the waiting state. Bot replies count as a response when successfully delivered, so normal automated intake does not appear as staff work.

Lead notifications are durable and idempotent per conversation. Staff can open a notification to its conversation and mark it read. Webhook retries must not create duplicate notifications. Notifications are not sent to the customer and do not contain message text or secrets.

## UI behavior

- Add a compact “Lead ใหม่” notification panel with unread count and newest entries on `/admin`.
- Each entry identifies the LINE contact, arrival time, and links to the corresponding conversation.
- Mark a notification read only through an authenticated, CSRF-protected staff action.
- Add a “รอตอบ” queue with contact, last customer message preview, elapsed wait, and a direct link to that conversation.
- Show the waiting count and a clear empty state. Keep existing inbox filters and BOT/HUMAN controls intact.
- Use the existing Donnar.Tech CRM visual language and support mobile widths.

## Data and behavior

- Add a PostgreSQL migration for a `staff_notifications` table with notification ID, type, conversation foreign key, created timestamp, and nullable read timestamp.
- Create one `new_lead` notification in the same transaction that creates the lead; a unique constraint prevents duplicate notification rows for a conversation and type.
- Define the waiting queue using customer inbound messages and outbound rows with `send_status = 'SENT'`. Compare `(created_at, id)` so same-timestamp messages have deterministic order.
- Exclude internal messages from the comparison. A failed, pending, cancelled, or unknown outbound send does not count as a delivered response.
- Expose unread notification actions only to authenticated staff and verify CSRF on state-changing requests.
- Keep the feature independent of external email, group LINE, push notification, and scheduled-job credentials.

## Acceptance criteria

1. First creation of a lead produces exactly one unread staff notification, even if its webhook event is redelivered.
2. Opening the notification links to the right conversation; marking it read removes it from the unread count and list.
3. A conversation with a customer message and no successful outbound response appears in the waiting queue.
4. A later successful bot or staff reply removes it from the waiting queue; failed or unknown delivery leaves it there.
5. The queue is ordered by the longest outstanding wait, with stable tie handling.
6. Staff-only routes reject unauthenticated requests and state changes reject missing or invalid CSRF tokens.
7. Existing webhook, intake, inbox reply, BOT/HUMAN handoff, and Rich Menu behavior remain unchanged.

## Operational notes

The free Render instance may sleep, so the CRM refreshes these views on page load; this release does not promise real-time browser push. The longest-wait ordering and elapsed timer make the backlog visible after staff opens or refreshes `/admin`. External delivery (email or team LINE group) can be considered separately if in-app visibility proves insufficient.
