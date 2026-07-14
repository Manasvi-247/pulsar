// Hacker News firehose — the Firebase-backed official API.
// Items are assigned sequential ids, so polling /v0/maxitem.json and fetching
// everything between the last seen id and the new max yields the full stream
// of stories + comments. A separate slow poll keeps the current front page.

import { hub } from '../hub.js';

const BASE = 'https://hacker-news.firebaseio.com/v0';
const MAX_BATCH = 40; // cap per cycle so a burst can't stampede the API

export const frontPage = { stories: [], fetchedAt: 0 };

function stripHtml(s) {
  return s ? s.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
              .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
              .replace(/\s+/g, ' ').trim() : '';
}

function normalize(item) {
  const hnUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  if (item.type === 'story') {
    return {
      ts: (item.time ?? Math.floor(Date.now() / 1000)) * 1000,
      source: 'hn', type: 'story',
      title: item.title ?? '(untitled)',
      url: hnUrl,
      actor: item.by,
      delta: item.score ?? null,
    };
  }
  const text = stripHtml(item.text);
  return {
    ts: (item.time ?? Math.floor(Date.now() / 1000)) * 1000,
    source: 'hn', type: item.type ?? 'comment',
    title: text ? `“${text.slice(0, 80)}${text.length > 80 ? '…' : ''}”` : '(comment)',
    url: hnUrl,
    actor: item.by,
    delta: null,
  };
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HN HTTP ${res.status} on ${path}`);
  return res.json();
}

async function refreshFrontPage() {
  try {
    const ids = (await getJson('/topstories.json')).slice(0, 10);
    const items = await Promise.all(ids.map(id => getJson(`/item/${id}.json`).catch(() => null)));
    frontPage.stories = items.filter(Boolean).map(it => ({
      title: it.title, score: it.score, by: it.by, comments: it.descendants ?? 0,
      url: `https://news.ycombinator.com/item?id=${it.id}`,
    }));
    frontPage.fetchedAt = Date.now();
  } catch (err) {
    console.error(`[hn] front page: ${err.message}`);
  }
}

export function startHackerNews() {
  let lastId = null;
  let backoff = 5000;

  refreshFrontPage();
  setInterval(refreshFrontPage, 5 * 60_000).unref();

  (async function loop() {
    for (;;) {
      let waitMs = 20_000;
      try {
        const maxId = await getJson('/maxitem.json');
        if (lastId === null) lastId = maxId - 5; // warm start: just the newest few

        if (maxId > lastId) {
          const from = Math.max(lastId + 1, maxId - MAX_BATCH + 1);
          const ids = [];
          for (let id = from; id <= maxId; id++) ids.push(id);
          lastId = maxId;

          const items = await Promise.all(ids.map(id => getJson(`/item/${id}.json`).catch(() => null)));
          const span = 15_000; // drip across most of the poll window
          const fresh = items.filter(it => it && !it.deleted && !it.dead);
          const step = fresh.length > 1 ? span / fresh.length : 0;
          fresh.forEach((it, i) => setTimeout(() => hub.publish(normalize(it)), i * step));
        }
        hub.status('hn', 'live');
        backoff = 5000;
      } catch (err) {
        hub.status('hn', 'reconnecting');
        console.error(`[hn] ${err.message}; retrying in ${backoff}ms`);
        waitMs = backoff;
        backoff = Math.min(backoff * 2, 120_000);
      }
      await new Promise(r => setTimeout(r, waitMs));
    }
  })();
}
