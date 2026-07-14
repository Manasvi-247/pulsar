// Central event bus: ingesters publish normalized events here; the server
// subscribes to broadcast them to browsers over SSE.
//
// publish(ev, { store }) — every event bumps the minute rollup and the live
// rate counters; `store: false` skips the raw-row insert (used to downsample
// the noisier corners of the Wikipedia firehose while still counting them).

import { EventEmitter } from 'node:events';
import { storeEvent, bumpRollup } from './db.js';

class Hub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.startedAt = Date.now();
    this.sessionTotals = { gh: 0, wiki: 0, hn: 0 };
    this.recent = [];                 // last N events, for client snapshots
    // Ring buffer of per-second counts over the last 120s, per source.
    this.ring = { gh: new Array(120).fill(0), wiki: new Array(120).fill(0), hn: new Array(120).fill(0) };
    this.ringSec = Math.floor(Date.now() / 1000);
    this.sourceStatus = { gh: 'connecting', wiki: 'connecting', hn: 'connecting' };
  }

  #tickRing(nowSec) {
    while (this.ringSec < nowSec) {
      this.ringSec++;
      const slot = this.ringSec % 120;
      for (const src of ['gh', 'wiki', 'hn']) this.ring[src][slot] = 0;
    }
  }

  publish(ev, { store = true } = {}) {
    ev.ts = ev.ts ?? Date.now();
    bumpRollup(ev.ts, ev.source);
    if (store) storeEvent(ev);

    this.sessionTotals[ev.source]++;
    const nowSec = Math.floor(Date.now() / 1000);
    this.#tickRing(nowSec);
    this.ring[ev.source][nowSec % 120]++;

    this.recent.push(ev);
    if (this.recent.length > 60) this.recent.shift();
    this.emit('event', ev);
  }

  status(source, state) {
    this.sourceStatus[source] = state;
    this.emit('status', { source, state });
  }

  // Events/min per source, measured over the trailing `windowSec` seconds.
  rates(windowSec = 60) {
    this.#tickRing(Math.floor(Date.now() / 1000));
    const out = {};
    for (const src of ['gh', 'wiki', 'hn']) {
      let sum = 0;
      for (let i = 1; i <= windowSec; i++) sum += this.ring[src][(this.ringSec - i + 240) % 120];
      out[src] = Math.round((sum / windowSec) * 60);
    }
    return out;
  }
}

export const hub = new Hub();
