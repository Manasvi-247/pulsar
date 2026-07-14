// Observatory server — static frontend + JSON APIs + SSE live feed.
//
//   GET /               the observatory UI
//   GET /api/live       SSE: snapshot, then every event + rates every 2s
//   GET /api/history    minute rollups        ?hours=24
//   GET /api/replay     raw events near a ts  ?ts=<ms>&window=<ms>
//   GET /api/stats      totals, top pages, front page, uptime

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize as normPath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hub } from './hub.js';
import { history, replay, stats, RAW_RETENTION_H } from './db.js';
import { startWikipedia } from './ingest/wikipedia.js';
import { startGithub } from './ingest/github.js';
import { startHackerNews, frontPage } from './ingest/hackernews.js';

const PORT = Number(process.env.PORT) || 4646;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sseClients = new Set();

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

hub.on('event', ev => {
  for (const res of sseClients) sseSend(res, 'ev', ev);
});
hub.on('status', s => {
  for (const res of sseClients) sseSend(res, 'status', s);
});
setInterval(() => {
  if (!sseClients.size) return;
  const payload = { rates: hub.rates(60), totals: hub.sessionTotals, now: Date.now() };
  for (const res of sseClients) sseSend(res, 'rates', payload);
}, 2000).unref();

function json(res, body, status = 200) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = normPath(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, { error: 'nope' }, 403);
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    json(res, { error: 'not found' }, 404);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === '/api/live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    sseSend(res, 'snapshot', {
      now: Date.now(),
      startedAt: hub.startedAt,
      rates: hub.rates(60),
      totals: hub.sessionTotals,
      status: hub.sourceStatus,
      recent: hub.recent.slice(-40),
      frontPage: frontPage.stories,
      retentionHours: RAW_RETENTION_H,
    });
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (path === '/api/history') {
    const hours = Math.min(Number(url.searchParams.get('hours')) || 24, 24 * 30);
    return json(res, { since: Date.now() - hours * 3600_000, minutes: history(Date.now() - hours * 3600_000) });
  }

  if (path === '/api/replay') {
    const ts = Number(url.searchParams.get('ts'));
    if (!ts) return json(res, { error: 'ts required (ms epoch)' }, 400);
    const windowMs = Math.min(Number(url.searchParams.get('window')) || 120_000, 3600_000);
    return json(res, { ts, windowMs, events: replay(ts, windowMs) });
  }

  if (path === '/api/stats') {
    return json(res, {
      ...stats(),
      session: hub.sessionTotals,
      rates: hub.rates(60),
      status: hub.sourceStatus,
      frontPage: frontPage.stories,
      uptimeSec: Math.floor((Date.now() - hub.startedAt) / 1000),
      retentionHours: RAW_RETENTION_H,
    });
  }

  return serveStatic(res, path);
});

server.listen(PORT, () => {
  console.log(`observatory listening on http://localhost:${PORT}`);
  startWikipedia();
  startGithub();
  startHackerNews();
});

process.on('SIGINT', () => { console.log('\nshutting down'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
