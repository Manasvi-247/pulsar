// Wikipedia firehose — Wikimedia EventStreams (SSE over HTTP).
// https://stream.wikimedia.org/v2/stream/recentchange
//
// This is the loudest stream (~30–50 events/sec across every wiki), so it is
// where the downsampling happens: every event is COUNTED in the rollups and
// broadcast live, but only human (non-bot) edits to *.wikipedia.org are
// STORED as raw rows for replay.

import { hub } from '../hub.js';

const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';

function normalize(d) {
  const delta = d.length ? (d.length.new ?? 0) - (d.length.old ?? 0) : null;
  return {
    ts: d.meta?.dt ? Date.parse(d.meta.dt) : Date.now(),
    source: 'wiki',
    type: d.type,                                   // edit | new | log | categorize
    title: d.title,
    url: d.meta?.uri ?? (d.server_url && d.title ? `${d.server_url}/wiki/${encodeURIComponent(d.title)}` : null),
    actor: d.user,
    delta,
    wiki: d.server_name,
  };
}

async function consume() {
  const res = await fetch(STREAM_URL, { headers: { Accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
  hub.status('wiki', 'live');

  const decoder = new TextDecoder();
  let buf = '';
  let dataLines = [];

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);

      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line === '' && dataLines.length) {
        try {
          const d = JSON.parse(dataLines.join('\n'));
          if (d.type === 'edit' || d.type === 'new') {
            const ev = normalize(d);
            const keepRaw = !d.bot && d.server_name?.endsWith('wikipedia.org');
            hub.publish(ev, { store: keepRaw });
          }
        } catch { /* malformed frame — skip */ }
        dataLines = [];
      } else if (line === '') {
        dataLines = [];
      }
      // `event:`/`id:` lines are irrelevant here
    }
  }
  throw new Error('stream ended');
}

export function startWikipedia() {
  let backoff = 1000;
  (async function loop() {
    for (;;) {
      const connectedAt = Date.now();
      try {
        await consume(); // only returns by throwing
      } catch (err) {
        hub.status('wiki', 'reconnecting');
        console.error(`[wiki] ${err.message}; reconnecting in ${backoff}ms`);
      }
      // A connection that survived a while earns a fresh backoff.
      if (Date.now() - connectedAt > 60_000) backoff = 1000;
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  })();
}
