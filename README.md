# 🔭 Pulsar

**The internet has a heartbeat. This is what it looks like.**

Pulsar ingests three live public event streams at once (every Wikipedia edit worldwide,
the GitHub public events feed, and every Hacker News story and comment), stores them as
a time series, and renders them as a deep-space particle radar. Each spark is one real
event, spiraling from its ring into a core that breathes with the internet's pulse.

A 24-hour scrubber lets you drag back to any moment and replay it: "what did the
internet look like at 3am?"

Zero runtime dependencies. Node 23.4+ and a browser. That is the whole stack.

```
npm start          # then open http://localhost:4646
```

Optional: `GITHUB_TOKEN=ghp_... npm start` raises the GitHub poll rate from 60s to 15s.

## The three firehoses

| Source | Transport | Cadence |
|---|---|---|
| **Wikipedia**: every edit on every wiki, worldwide | Wikimedia EventStreams (SSE) | roughly 30 to 50 events/sec, continuous |
| **GitHub**: pushes, PRs, releases, stars across all public repos | REST, ETag-conditional polling | pages of ~30 to 100 events, dripped across the poll window |
| **Hacker News**: every story and comment as it is posted | Firebase REST (sequential item ids) | polled every 20s |

## Architecture

```
 wikimedia SSE ─┐                       ┌─ SSE /api/live ──► browser
 github poll  ──┤► hub (normalize, ─────┤   /api/history      canvas engine:
 hn poll      ──┘   rate counters)      │   /api/replay       starfield · spiral
                        │               └─ /api/stats         particles · ticker ·
                        ▼                                     time-travel scrubber
                SQLite (node:sqlite, WAL)
                ├─ events         raw rows, 48h retention
                └─ rollup_minute  per-minute counts, kept forever
```

### The downsampling story

The Wikipedia firehose alone would be about 4M rows/day if stored raw, so storage is
tiered:

- **`rollup_minute`** counts *every* event from *every* stream, forever. Rows are
  `(minute, source, count)`. A full year of all three firehoses fits in a few hundred
  MB at most, and the 24h timeline reads it with one indexed range scan.
- **`events`** keeps raw rows for replay: all GitHub and HN events, but only *human*
  (non-bot) Wikipedia edits. Anything older than 48 hours is pruned every 10 minutes.
- Live particles render the **full** firehose (broadcast is not the same as stored);
  replay renders the sampled raw retention. Counting everything while storing
  selectively is the trick.

### Other bits worth asking me about

- **Polite polling**: GitHub conditional requests (`If-None-Match`) return 304s that
  do not count against the unauthenticated 60/hr rate limit. The poller also honors
  `X-Poll-Interval` and rate-limit reset headers.
- **Clump smoothing**: polled sources deliver bursts of ~30 events at once. The
  ingesters drip them across the poll window so the visualization reflects real
  cadence instead of a heartbeat of clumps.
- **Live rates** come from a 120-slot per-second ring buffer, not the database.
- **Time travel** streams 10-minute chunks of raw events and replays them against a
  virtual clock at 1x, 10x, or 60x, prefetching the next chunk before the clock
  reaches it. Reaching "now" seamlessly returns you to the live feed.
- **Hidden-tab correctness**: browsers pause `requestAnimationFrame` in background
  tabs, so ingestion and rendering are fully decoupled. Events are never stockpiled
  into a particle burst when you tab back in.
- **Zero deps**: `node:sqlite`, `fetch`, `node:http`, hand-rolled SSE in both
  directions, vanilla canvas. No build step, nothing to install.

## API

```
GET /api/live                        SSE: snapshot, then every event + rates every 2s
GET /api/history?hours=24            per-minute rollups (the timeline)
GET /api/replay?ts=<ms>&window=<ms>  raw events around a timestamp (time travel)
GET /api/stats                       totals, rates, top wiki pages (1h), HN front page
```

## Project layout

```
src/
  server.js            HTTP + static + SSE broadcast + JSON APIs
  hub.js               event bus, session totals, per-second rate ring
  db.js                node:sqlite schema, rollups, replay queries, pruning
  ingest/
    wikipedia.js       EventStreams SSE consumer (reconnect + backoff)
    github.js          ETag-conditional poller with drip scheduling
    hackernews.js      sequential item-id poller + front page tracker
public/
  index.html           HUD, ticker, front page, time-travel bar
  app.js               canvas engine: starfield, particles, timeline, replay
  style.css            deep-space theme
```
