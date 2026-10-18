# CRM Admin Page Separation and UI Design

## Status

Approved for implementation. The code changes are in place; runtime SSE and visual verification remain pending because no app server or mobile simulator was running.

## Context

The staff area currently presents the inbox, lead follow-ups, bot message revisions, and Rich Menu management together on `/admin`. The page loads data for those sections and quotation decision notifications together. It also loads recent messages for many lead rows to build search and previews. Quotations already have separate routes under `/admin/quotations`, but use their own page navigation.

The user wants the staff interface to be easier to operate by separating work into clear pages, especially keeping conversations in a dedicated messaging area. New LINE messages should appear without a full page refresh, and normal navigation should avoid loading unrelated page data. The existing Server-Sent Events (SSE) inbox update behavior remains the live-update mechanism.

The visual direction takes inspiration from Fastwork's clear section navigation, generous spacing, and card-based content. Its seller page currently organizes profile content into tabs such as Portfolio, Services, Reviews, and About, with service cards ([Fastwork selling page](https://fastwork.com/selling)). The admin should fit Donnar.Tech's identity and must not copy Fastwork branding or assets.

## Goals

- Give each main staff task a dedicated page under one consistent authenticated admin shell.
- Keep the inbox focused on conversation search, the conversation list, the selected chat, and customer details.
- Show new inbound messages in an open inbox without refreshing the document or periodically reloading the whole page.
- Load only data needed by the current page. The inbox list should use message previews; load the selected conversation's recent history only for its detail pane.
- Keep existing lead follow-up, quotation, bot copy, and Rich Menu workflows available.
- Make page navigation and content usable on desktop and narrow mobile screens.

## Out of scope

- Replacing SSE with WebSockets or changing LINE webhook processing.
- Changing lead qualification, bot responses, quotation rules, or Rich Menu publishing behavior.
- Introducing a client-side SPA framework, new database schema, or unrelated admin features.
- Reworking public-facing LINE, LIFF, or quotation pages.

## Page structure

Use a shared staff navigation with these destinations:

1. **ภาพรวม** at `/admin`: a small dashboard with key counts and links to work that needs attention.
2. **กล่องข้อความ** at `/admin/inbox`: conversation search and filters, conversation list, selected chat, customer details, and reply controls.
3. **งานติดตาม** at `/admin/follow-ups`: unread new leads and conversations waiting for a staff reply. Each item opens the relevant conversation in the inbox.
4. **ใบเสนอราคา** at `/admin/quotations`: keep the existing quotation list and editor flows, integrated into the shared navigation.
5. **ข้อความบอต** at `/admin/content`: edit published copy, create drafts, and publish a selected revision.
6. **Rich Menu** at `/admin/rich-menu`: upload and preview a draft, inspect the active menu, and confirm publication.

The shared shell should show the active destination, the signed-in staff name, and logout. Keep the primary navigation visible on desktop; on narrow screens, use a compact navigation treatment that does not consume the conversation pane's width. Preserve the current light palette and blue accent, with clear page titles, whitespace, readable cards, and consistent active states.

## Route and navigation behavior

- `/admin` renders the overview. If a legacy URL includes `?conversation=...`, redirect it to `/admin/inbox?conversation=...` so existing conversation deep links continue to open the right chat.
- Inbox links, notification actions, reply/mode/profile form redirects, quotation actions that return to a conversation, and login redirects must use `/admin/inbox` when targeting a conversation.
- Follow-up actions retain their existing CSRF protection and mark-as-read behavior, then open the relevant conversation.
- Existing quotation and Rich Menu mutation endpoints remain in place unless route ownership requires a narrowly scoped adjustment. GET pages are separated from POST actions; a successful action returns to its relevant page.
- All staff pages remain behind the existing staff-session middleware. Existing CSRF checks remain on state-changing forms.

## Page data and live updates

- **Overview:** request summary counts and a small set of actionable items only. Do not load message histories, bot revision bodies, or Rich Menu images for the dashboard.
- **Inbox:** retain the current search and lead-status/mode filters, recent conversation list limit, customer details, quotation shortcut, and most-recent 30-message history for the selected conversation. Render a latest-message preview per list row. Do not fetch a 30-message history separately for every listed conversation. Preserve search by customer/lead fields and message text through a selective query when a search term is supplied.
- **SSE:** subscribe to `/admin/inbox/events` only while the inbox page is open. On an event, update the open conversation from the existing lightweight update endpoint; reconnect/reset handling remains in place. Do not introduce periodic full-page polling.
- **Follow-ups:** fetch unread new-lead notifications and waiting-reply rows for this view only. Selecting an item opens the conversation in the inbox and preserves the conversation ID.
- **Bot messages:** load published message copy and draft revisions only on this page.
- **Rich Menu:** load publication metadata for this page and retrieve image bytes only for images actually shown.
- **Quotations:** retain the existing list/editor data needs and behavior; share the admin shell and active navigation.

## Interaction and responsive requirements

- Moving between pages uses normal links and preserves authenticated staff access.
- Inbox selection, sending, takeover/return-to-bot, and quotation creation keep their current semantics.
- On mobile, the conversation list and selected conversation must remain reachable without displaying a cramped two-column layout. Provide a clear way to return from a selected chat to the list.
- Navigation and form controls retain visible labels, focus states, and semantic active-page indication.
- Before describing the UI as complete, visually inspect it in both iOS and Android mobile environments as required by the repository instructions. If either environment is unavailable, report that limitation explicitly.

## Acceptance criteria

- A staff member can reach each of the six destinations from the shared navigation and can identify the active page.
- Inbox, follow-ups, bot messages, and Rich Menu render their own work areas rather than appearing as additional sections below the inbox.
- Each page loads the data needed for its work area only; opening the inbox does not load bot copy or Rich Menu data, and opening another page does not load conversation histories.
- Search/filter behavior, lead follow-ups, quotations, bot copy draft/publish, and Rich Menu preview/confirm flows remain available.
- With the inbox open, an inbound message appears without a manual refresh or periodic full-page reload.
- Existing deep links that specify a conversation continue to open that conversation in the inbox.
- Staff authentication and CSRF behavior remain enforced for all applicable routes and actions.
- Desktop and mobile layouts are visually checked on iOS and Android before claiming UI completion.
