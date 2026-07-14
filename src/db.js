// Time-series storage on node:sqlite (zero dependencies).
//
// Downsampling strategy:
//   - rollup_minute counts EVERY event from every firehose, forever (tiny rows).
//   - raw events are stored selectively (see ingesters) and pruned after RAW_RETENTION_H.
//   Time travel scrubs the rollups; replay pulls raw events near a timestamp.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const RAW_RETENTION_H = 48;

const db = new DatabaseSync(join(DATA_DIR, 'observatory.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     INTEGER NOT NULL,
    source TEXT    NOT NULL,
    type   TEXT,
    title  TEXT,
    url    TEXT,
    actor  TEXT,
    delta  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

  CREATE TABLE IF NOT EXISTS rollup_minute (
    minute INTEGER NOT NULL,
    source TEXT    NOT NULL,
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, source)
  ) WITHOUT ROWID;
`);

const insertStmt = db.prepare(
  `INSERT INTO events (ts, source, type, title, url, actor, delta) VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const rollupStmt = db.prepare(
  `INSERT INTO rollup_minute (minute, source, count) VALUES (?, ?, 1)
   ON CONFLICT (minute, source) DO UPDATE SET count = count + 1`
);
const pruneStmt = db.prepare(`DELETE FROM events WHERE ts < ?`);
const historyStmt = db.prepare(
  `SELECT minute, source, count FROM rollup_minute WHERE minute >= ? ORDER BY minute`
);
const replayStmt = db.prepare(
  `SELECT ts, source, type, title, url, actor, delta FROM events
   WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT ?`
);
const totalsStmt = db.prepare(
  `SELECT source, SUM(count) AS total FROM rollup_minute GROUP BY source`
);
const boundsStmt = db.prepare(
  `SELECT MIN(minute) AS first, MAX(minute) AS last FROM rollup_minute`
);
const topWikiStmt = db.prepare(
  `SELECT title, url, COUNT(*) AS edits FROM events
   WHERE source = 'wiki' AND ts >= ? AND title IS NOT NULL
   GROUP BY title ORDER BY edits DESC LIMIT 8`
);
const rawCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM events`);

export function storeEvent(ev) {
  insertStmt.run(ev.ts, ev.source, ev.type ?? null, ev.title ?? null, ev.url ?? null, ev.actor ?? null, ev.delta ?? null);
}

export function bumpRollup(ts, source) {
  rollupStmt.run(Math.floor(ts / 60000), source);
}

// Minute rollups since `sinceMs`, shaped as { minute, gh, wiki, hn } rows.
export function history(sinceMs) {
  const rows = historyStmt.all(Math.floor(sinceMs / 60000));
  const byMinute = new Map();
  for (const r of rows) {
    let m = byMinute.get(r.minute);
    if (!m) { m = { minute: r.minute, gh: 0, wiki: 0, hn: 0 }; byMinute.set(r.minute, m); }
    m[r.source] = r.count;
  }
  return [...byMinute.values()];
}

export function replay(centerMs, windowMs, limit = 500) {
  return replayStmt.all(centerMs - windowMs / 2, centerMs + windowMs / 2, limit);
}

export function stats() {
  const totals = { gh: 0, wiki: 0, hn: 0 };
  for (const r of totalsStmt.all()) totals[r.source] = r.total;
  const bounds = boundsStmt.get();
  return {
    totals,
    rawEvents: rawCountStmt.get().n,
    firstMinute: bounds.first,
    lastMinute: bounds.last,
    topWikiHour: topWikiStmt.all(Date.now() - 3600_000),
  };
}

// Raw events age out; rollups are the permanent, downsampled record.
export function prune() {
  pruneStmt.run(Date.now() - RAW_RETENTION_H * 3600_000);
}
setInterval(prune, 10 * 60_000).unref();
