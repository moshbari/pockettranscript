# PocketTranscript

Grab a YouTube transcript **from your phone**. Your desktop Chrome extension does the actual work.

## Why it's built this way

Phones can't run Chrome extensions, and nothing outside your Mac can reach into its Chrome.
So the phone and the extension never talk to each other. They both talk to a queue:

```
📱 phone  ──POST /api/jobs──▶  [ this server ]  ◀──long-poll──  🖥️ YT Transcript Scraper
      ▲                                │
      └────── GET /api/jobs/:id ◀──────┴──── POST /api/desktop/result
```

The extension holds a request open for 25 seconds at a time, so a link sent from the
phone reaches the desktop in well under a second — not on the next alarm tick.

If the Mac is asleep the app says so, plainly, and the job waits in the queue.

## No database — on purpose

Everything is in memory. A transcript is read once and thrown away, and each device
rebuilds its own entry on its next request, so a restart costs at most one in-flight
job and never the pairing. The phone keeps its `deviceId` in `localStorage`; that id
is the password.

## API

**Desktop (the extension)**
- `POST /api/desktop/poll` `{deviceId, name}` → heartbeat **and** job pickup in one call (long-polls up to 25s)
- `POST /api/desktop/result` `{deviceId, jobId, ok, text, segments, title, error}`
- `POST /api/desktop/paircode` `{deviceId}` → `{code}` — 6 digits, 10 minutes, one use

**Phone**
- `POST /api/pair` `{code}` → `{deviceId}`
- `GET  /api/status?deviceId=` → `{online, lastSeenMsAgo, jobs[]}`
- `POST /api/jobs` `{deviceId, url}` → `{job, online}`
- `GET  /api/jobs/:id?deviceId=` → full transcript
- `POST /api/jobs/:id/retry`, `DELETE /api/jobs/:id`

## Run it

```bash
npm install && npm start        # http://localhost:3000
```

Deployed on Railway. The extension half lives in `moshbari/youtube-transcript-extension` (v4.2+, the 📱 Phone tab).
