Create a docker container in the current folder named agentic-whatsapp.
It should expose a whatsapp api(openAPI) to read, reply and send whatsapp messages using whatsapp-web.js ( https://github.com/wwebjs/whatsapp-web.js ).

Use LocalAuth (local authentication) with whatsapp-web.js. Configure the session data to be stored in a directory.

Use port 3056 for the api.
It should use restart: always.
it should support:

Multi Device ✅
Send messages ✅
Receive messages ✅
Send media (images/audio/documents) ✅
Send media (video) ✅ (requires Google Chrome)
Send stickers ✅
Receive media (images/audio/video/documents) ✅
Message replies ✅

When the container starts and is not authenticated, expose a GET /qr/<api-key> endpoint that serves a clean, styled web page rendering the QR code dynamically (with auto-refresh when a new QR code is generated). This is the only GUI.

Expose a GET /status endpoint returning JSON (e.g., {"status": "QR_READY"} or {"status": "READY"}).

Event Notification (Receiving Messages, Replies, and Status updates)

Clients periodically make GET /incoming-messages requests to read messages that arrived within a specified number of minutes.

Persistent Local Database (SQLite). Store incoming messages identifiers in a lightweight database ( SQLite ) located inside the mounted volume directory. This ensures that even if the Docker container restarts, client pollers can still get messages that arrived just before the restart.

Media Handling (Sending and Receiving):
For Sending Media: Only support file uploads via multipart/form-data.
For Receiving Media: Do not save media automatically. Instead, expose an endpoint GET /messages/:id/media to retrieve/stream the media on-demand when requested.

Browser/Chrome for Video Codec Support: In the Dockerfile, write a script to download and install official Google Chrome Stable (along with its dependencies) and configure Puppeteer to use this official Chrome executable path (e.g. /usr/bin/google-chrome-stable). This will increase the Docker image size by ~300-400MB but guarantees full codec compatibility for videos.

API Endpoint Specifications & Recipient Phone Formatting
To ensure the API is easy to use and integrates seamlessly, let's align on the exact endpoints and request formats, and how recipient phone numbers should be formatted.

Phone Number Formatting:
Usually, whatsapp-web.js expects format [country_code][number]@c.us (e.g. 1234567890@c.us or 447123456789@c.us).

Let's automatically sanitize the to field. If the user passes +1 (234) 567-890 or just a raw number, we strip non-digits, check if it already ends in @c.us or @g.us (for groups), and if not, append @c.us. This makes calling the API bulletproof.

Every call to the API must require an API key. API key should be configured in .env file.
create a comprehensive documentation on the API.
