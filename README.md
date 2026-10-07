# Donnar.Tech LINE Backend API

Planning repository for the Donnar.Tech LINE Official Account customer journey, with bot-assisted qualification and human takeover.

## Current status

The repository contains planning artifacts only. No backend, webhook, database, staff inbox, or deployed automation exists yet. The LINE Official Account setup is in progress.

## Planning artifacts

- [Customer journey and architecture proposal](docs/donnar-line-oa-journey.html)
- [LINE OA profile, greeting, menu, and conversation copy](docs/donnar-line-oa-content.html)
- [Presentation video scenario and marketing/BD plan](docs/donnar-video-marketing-bd.html)

Open each HTML file directly in a browser. They have no external runtime dependencies.

## Recommended next build phase

Choose the backend framework, database, hosting, and staff authentication approach. Then implement the LINE webhook with raw-body signature verification and event handling before adding conversation persistence, lead qualification, and human takeover.
