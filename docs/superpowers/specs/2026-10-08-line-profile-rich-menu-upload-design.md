# LINE Profile Display and Rich Menu Image Upload Design

**Status:** Draft for review  
**Date:** 2026-10-08

## Goal

Make the staff CRM identify LINE customers at a glance and let staff replace the Rich Menu banner from `/admin` without editing the repository or using LINE Official Account Manager.

The change adds two related admin capabilities while preserving the existing lead, conversation, BOT/HUMAN handoff, reply, Rich Menu tap areas, and deployment flow.

## Current behavior

- `line_users` already stores `line_user_id` and `display_name`; it does not store a profile image URL or the last profile refresh time.
- The CRM currently shows the LINE UID as the primary customer label and has no avatar.
- `LineMessagingClient` supports replies, pushes, and Rich Menu creation/image upload/default assignment, but not the Get profile endpoint.
- Rich Menu publishing reads a fixed repository file from `RICH_MENU_IMAGE_PATH`. There is no upload or preview draft flow.
- Rich Menu validation currently accepts only PNG/JPEG at exactly 2500 × 1686 and no more than 1 MB. This size matches the existing three equal tap rows.
- Render uses an ephemeral filesystem. An uploaded asset cannot rely on a local file surviving another request or redeployment.

## User experience

### CRM identity

- Show the LINE display name and circular profile image in each inbox row and in the selected conversation header.
- Keep the LINE UID available as secondary text for staff who need to identify an account precisely.
- If the profile is not available, show a neutral fallback avatar and label the customer with the UID.
- Do not block message handling or CRM rendering when LINE profile lookup fails.

### Rich Menu replacement

1. Staff choose a PNG or JPEG image in the Rich Menu section.
2. The server validates the actual image bytes, dimensions, and size, then stores one pending draft in PostgreSQL.
3. The page displays a preview of that stored draft and explains that confirming will replace the default Rich Menu in the LINE OA.
4. Staff click **ยืนยันเปลี่ยน Rich Menu** to publish.
5. The backend creates a new LINE Rich Menu using the existing action areas, uploads the draft image, sets the new menu as default, then marks the previous local publication `REPLACED` and the new one `PUBLISHED`.
6. After successful publication, clear the local image bytes from replaced menu records and retain the image only on the current published record. Keep the LINE menu IDs and audit history.

The upload itself must never change the live Rich Menu. A separate explicit confirmation is required.

## LINE profile data flow

- Use the existing LINE user ID from the webhook source and the configured Messaging API channel access token to call `GET /v2/bot/profile/{userId}`.
- On successful lookup, save `displayName`, `pictureUrl`, and `profile_synced_at` on the matching `line_users` row.
- On a subsequent follow/message/postback event, refresh when `profile_synced_at` is null or at least 24 hours old, regardless of whether a profile was previously returned. Record the completion time for successful lookups and definitive LINE 404 responses; transient network/5xx failures do not advance it. A new follow event may trigger a refresh even inside the 24-hour window, so an unblock can repopulate the profile sooner.
- Coalesce concurrent profile-refresh requests for the same UID within the server process so simultaneous webhook events do not create duplicate LINE API calls. Duplicate webhook events already accepted by the event-id deduplication layer must not trigger a refresh.
- Complete webhook event processing and any required customer reply without waiting on the profile request; then perform the best-effort profile lookup outside the database transaction. It must not roll back event processing, suppress a reply, or log the name, image URL, user ID, or access token.
- Treat an unavailable profile (including LINE's 404 for a blocked user) as normal. Keep the stored profile if one exists and render the UID/avatar fallback if none exists. A transient API failure must remain eligible for a later retry.
- `FakeLineMessagingClient` returns deterministic profile data for automated tests; production never substitutes fake profile data.

## Rich Menu upload and persistence

- Add an authenticated, CSRF-protected multipart upload endpoint under `/admin/rich-menu` with an upload rate limit and an in-memory maximum of 1 MB.
- Accept only JPEG and PNG based on both detected file signature and supported content type. Require exact 2500 × 1686 dimensions and at most 1 MB, matching LINE's limit and the current tappable-area geometry. Do not crop, stretch, or transform the artwork.
- Return a field-level error that tells staff the required format, dimensions, and maximum size. Preserve the currently published menu on invalid uploads.
- Store the validated image as `BYTEA` and its detected content type on a Rich Menu `DRAFT` publication row. PostgreSQL is already the durable store used by this deployment; no new storage service or credential is introduced.
- Provide an authenticated image-preview endpoint that streams only the stored draft/current image with its detected content type, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store`.
- Permit HTTPS image sources in the staff-page Content Security Policy for LINE profile photos; validate stored profile image URLs as HTTPS before rendering them.
- Maintain at most one `DRAFT` row. Validate a new upload fully before opening the replacement transaction; then transactionally delete the previous draft and insert the new draft, handling concurrent uploads so the single-draft constraint remains satisfied. An invalid or failed upload leaves the current draft and published menu unchanged. Cancelling removes only the draft.

## Publication state and failure behavior

- Reuse the existing `DRAFT`, `CREATING`, `PUBLISHED`, `FAILED`, and `REPLACED` publication lifecycle and single-creation database guard.
- Before calling LINE, atomically claim the selected draft as `CREATING`; concurrent publish requests must be rejected.
- Create the new LINE Rich Menu with `buildRichMenu(config.liffId)`, upload the stored draft image, and set it as default. Do not change local publication state to `PUBLISHED` until LINE accepts the default-menu request.
- If creation/upload/default assignment fails, mark the attempted publication `FAILED`, retain the bytes and LINE menu ID/upload state when known for the existing safe retry behavior, and leave the prior default menu in place unless LINE already accepted the switch.
- After a successful default switch, transactionally mark the old published row `REPLACED`, mark the new row `PUBLISHED`, clear image bytes from replaced rows, and add an audit log entry containing the menu ID and publication ID (never image contents or tokens).
- If the external default switch succeeds but the database update fails, leave a recoverable `FAILED`/`CREATING` record with its LINE menu ID and image-upload state. A retry must be idempotent and complete by setting the same new menu as default again before reconciling database state.
- LINE changes a default Rich Menu when users reopen the chat; it may take up to about one minute. Per-user Rich Menus have higher priority and are outside this feature.

## Database changes

Add a forward-only migration that:

- adds nullable `picture_url TEXT` and `profile_synced_at TIMESTAMPTZ` to `line_users`;
- adds nullable `image_data BYTEA` and `image_content_type TEXT` to `rich_menu_publications`;
- adds a partial unique index allowing at most one `DRAFT` publication.

No existing rows are rewritten. Existing profile rows continue to use UID/avatar fallbacks until their next eligible LINE interaction refreshes their profile. Existing published Rich Menu rows remain valid without stored image bytes.

## Security and privacy

- Keep all LINE credentials in the hosting secret manager; add no credentials or user profile data to Git, logs, HTML source, or audit details.
- Require staff authentication and CSRF validation on upload, preview, cancel/replacement, and publish operations.
- Enforce file size limits before buffering and validate image signatures/dimensions server-side; never trust the browser MIME type or filename.
- Keep profile fields limited to the public display name and image URL needed by the CRM. Escape display names and use `https:` profile image URLs only.
- Serve uploaded preview bytes only to authenticated staff and disable caching.

## Alternatives considered

1. **Fetch profiles on every page render:** rejected because it couples CRM availability to LINE and creates repeated API calls.
2. **Use the Render filesystem for uploaded banners:** rejected because it is ephemeral and cannot be treated as a durable asset store.
3. **Add Supabase Storage:** viable, but unnecessary for a single image capped at 1 MB when PostgreSQL is already configured and used by the application. `BYTEA` keeps this flow within the existing deployment and secret model.
4. **Automatically crop/resize arbitrary images:** rejected because cropping or stretching can remove text and misalign the three existing tap rows. Staff receive a clear validation error instead.

## Acceptance criteria

- CRM rows and selected conversation show the cached LINE display name and profile photo when the API returns them; fallback remains clear and readable when it does not.
- Profiles are refreshed at most once per 24 hours per user after a completed lookup, including a 404; a new follow event may refresh sooner. Transient errors remain retryable, and duplicate webhook events do not trigger duplicate refreshes.
- An image upload that is invalid, oversized, unsupported, or the wrong dimensions cannot alter the live Rich Menu.
- A valid upload displays the exact uploaded artwork in a staff-only preview. Cancelling or uploading a replacement draft does not alter the live Rich Menu.
- Confirming a valid draft creates a new Rich Menu with the current tap actions, uploads its image, sets it as default, and updates publication/audit state only after success.
- A failure before LINE accepts the new default leaves the previous menu active and keeps sufficient draft state for a safe retry.
- Existing Rich Menu actions, welcome-card actions, BOT/HUMAN handoff, CRM replies, and existing published menus continue to work.
- No new production secrets, services, or manual Supabase bucket setup are required.

## Verification plan

- Unit/integration tests for profile success, 404, transient failure, stale refresh, escaping/fallback rendering, and duplicate event behavior using the fake LINE client and PostgreSQL test adapter.
- Upload tests for PNG/JPEG signature and exact dimensions, MIME mismatch, malformed data, size limit, CSRF/authentication, draft replacement, and preview access control.
- Publication tests for new-draft success, upload failure, set-default failure, retry after partial LINE success, single-publisher concurrency, and preserving the old default before confirmation.
- Run the complete project test suite and inspect the responsive CRM and upload/confirmation flow before deployment.
- Verify production health and render the published Rich Menu preview after deployment; do not publish a live menu during deployment unless staff explicitly confirms inside `/admin`.
