# Donnar.Tech LINE Backend API

Planning repository for the Donnar.Tech LINE Official Account customer journey, with bot-assisted qualification and human takeover.

## Current status

The repository contains planning artifacts only. No backend, webhook, database, staff inbox, or deployed automation exists yet.

The Donnar.Tech LINE Official Account has been created with Basic ID `@015ksasx`. A LINE Developers provider named `Donnar.Tech` and its Messaging API channel are active. Staff chat is enabled in manual mode and a greeting message is set. No webhook URL is configured because the backend does not exist yet. Keep the channel secret and access token outside Git.

Rich Menu will be created and published by the backend through the LINE Messaging API. The draft image at [assets/line-rich-menu-1200x405.png](assets/line-rich-menu-1200x405.png) is not published on the OA.

## Planning artifacts

- [Customer journey and architecture proposal](docs/donnar-line-oa-journey.html)
- [LINE OA profile, greeting, menu, and conversation copy](docs/donnar-line-oa-content.html)
- [Presentation video scenario and marketing/BD plan](docs/donnar-video-marketing-bd.html)

Open each HTML file directly in a browser. They have no external runtime dependencies.

## Recommended next build phase

Choose the backend framework, database, hosting, and staff authentication approach. Then implement the LINE webhook with raw-body signature verification and event handling before adding conversation persistence, lead qualification, and human takeover.
