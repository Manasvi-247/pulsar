// GitHub firehose — the public events feed, polled politely.
// https://api.github.com/events
//
// Unauthenticated callers get 60 req/hr, BUT conditional requests answered
// with 304 Not Modified are free — so we poll with an ETag at the cadence
// GitHub asks for via X-Poll-Interval. Set GITHUB_TOKEN for a faster poll.
//
// Each 200 delivers a page of ~30 events at once; to keep the visualization
// honest-feeling we drip them out across the poll window instead of dumping
// one clump of particles per minute.

import { hub } from '../hub.js';

const API_URL = 'https://api.github.com/events?per_page=100';
const TOKEN = process.env.GITHUB_TOKEN;

const seen = new Set(); // event ids from the previous page (feed overlaps between polls)

function normalize(e) {
  const repo = e.repo?.name ?? 'unknown/repo';
  let type = e.type?.replace(/Event$/, '') ?? 'Unknown';
  let title = repo;
  let delta = null;
  if (e.type === 'PushEvent') {
    delta = e.payload?.size ?? null;
    title = `${repo}${delta ? ` (+${delta} commit${delta === 1 ? '' : 's'})` : ''}`;
  } else if (e.type === 'CreateEvent') {
    title = `${repo} · new ${e.payload?.ref_type ?? 'ref'}`;
  } else if (e.type === 'ReleaseEvent') {
    title = `${repo} · release ${e.payload?.release?.tag_name ?? ''}`;
  } else if (e.type === 'WatchEvent') {
    title = `${repo} · starred`;
  } else if (e.type === 'PullRequestEvent') {
    title = `${repo} · PR ${e.payload?.action ?? ''}`;
  } else if (e.type === 'IssuesEvent') {
    title = `${repo} · issue ${e.payload?.action ?? ''}`;
  } else if (e.type === 'ForkEvent') {
    title = `${repo} · forked`;
  }
  return {
    ts: e.created_at ? Date.parse(e.created_at) : Date.now(),
    source: 'gh',
    type,
    title,
    url: `https://github.com/${repo}`,
    actor: e.actor?.login,
    delta,
  };
}

export function startGithub() {
  let etag = null;
  let backoff = 5000;

  (async function loop() {
    for (;;) {
      let waitMs = TOKEN ? 15_000 : 60_000;
      try {
        const headers = {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'observatory-demo',
        };
        if (etag) headers['If-None-Match'] = etag;
        if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

        const res = await fetch(API_URL, { headers });
        const pollHint = Number(res.headers.get('x-poll-interval'));
        if (pollHint) waitMs = Math.max(waitMs, pollHint * 1000);

        if (res.status === 200) {
          etag = res.headers.get('etag');
          hub.status('gh', 'live');
          const page = await res.json();

          const fresh = page.filter(e => !seen.has(e.id)).reverse(); // oldest first
          seen.clear();
          for (const e of page) seen.add(e.id);

          // Drip fresh events across most of the poll window.
          const span = Math.min(waitMs * 0.9, 55_000);
          const step = fresh.length > 1 ? span / fresh.length : 0;
          fresh.forEach((e, i) => {
            setTimeout(() => hub.publish(normalize(e)), i * step);
          });
          backoff = 5000;
        } else if (res.status === 304) {
          backoff = 5000; // nothing new; costs no rate limit
        } else if (res.status === 403 || res.status === 429) {
          hub.status('gh', 'rate-limited');
          const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
          waitMs = Math.max(waitMs, (reset || Date.now() + 120_000) - Date.now() + 5000);
          console.error(`[gh] rate limited; sleeping ${Math.round(waitMs / 1000)}s`);
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        hub.status('gh', 'reconnecting');
        console.error(`[gh] ${err.message}; retrying in ${backoff}ms`);
        waitMs = backoff;
        backoff = Math.min(backoff * 2, 120_000);
      }
      await new Promise(r => setTimeout(r, waitMs));
    }
  })();
}
