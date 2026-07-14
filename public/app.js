/* Observatory frontend — starfield, spiral particle radar, live ticker,
   and a 24h time-travel scrubber that replays history through the same engine. */

'use strict';

// ---------------------------------------------------------------- constants

const SRC = {
  wiki: { color: '#f2cc60', ring: 0.26, name: 'WIKIPEDIA' },
  gh:   { color: '#58a6ff', ring: 0.36, name: 'GITHUB' },
  hn:   { color: '#ff6b35', ring: 0.46, name: 'HACKER NEWS' },
};
const BG = '#04060e';
const DAY = 24 * 3600 * 1000;
const MAX_PARTICLES = 900;

// ---------------------------------------------------------------- state

const state = {
  mode: 'live',            // 'live' | 'replay'
  totals: { gh: 0, wiki: 0, hn: 0 },
  rates: { gh: 0, wiki: 0, hn: 0 },
  shownCount: 0,
  // replay
  speed: 1,
  virtual: 0,              // replay clock (ms epoch)
  buffer: [],              // fetched raw events, sorted by ts
  bufPtr: 0,
  bufEnd: 0,               // end of fetched range
  fetching: false,
  // timeline
  minutes: new Map(),      // minute -> {gh, wiki, hn}
  dragging: false,
  soundOn: false,
};

// ---------------------------------------------------------------- canvases

const bg = document.getElementById('bg');
const fx = document.getElementById('fx');
const tl = document.getElementById('timeline');
const bgx = bg.getContext('2d');
const fxx = fx.getContext('2d');
const tlx = tl.getContext('2d');

let W = 0, H = 0, CX = 0, CY = 0, R = 0, DPR = 1;
let stars = [];
let nebula = null;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  for (const c of [bg, fx]) {
    c.width = W * DPR; c.height = H * DPR;
    c.getContext('2d').setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  CX = W / 2; CY = H / 2 - 30;
  R = Math.min(W, H) * 0.5;

  stars = Array.from({ length: 260 }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    z: 0.3 + Math.random() * 0.7,
    tw: Math.random() * Math.PI * 2,
  }));

  nebula = document.createElement('canvas');
  nebula.width = W; nebula.height = H;
  const nx = nebula.getContext('2d');
  const blobs = [
    [W * 0.75, H * 0.25, R * 0.9, 'rgba(60, 60, 160, 0.16)'],
    [W * 0.2, H * 0.75, R * 0.8, 'rgba(30, 90, 120, 0.13)'],
    [W * 0.55, H * 0.6, R * 1.1, 'rgba(90, 40, 120, 0.10)'],
  ];
  for (const [x, y, r, col] of blobs) {
    const g = nx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col); g.addColorStop(1, 'transparent');
    nx.fillStyle = g;
    nx.fillRect(0, 0, W, H);
  }

  const rect = tl.getBoundingClientRect();
  tl.width = rect.width * DPR; tl.height = rect.height * DPR;
  tlx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- particles

const particles = [];
const labels = [];
let coreEnergy = 0;
let lastLabelAt = 0;

function spawn(ev) {
  const s = SRC[ev.source];
  if (!s) return;
  if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);

  const a0 = Math.random() * Math.PI * 2;
  const p = {
    src: ev.source,
    a0,
    r0: R * s.ring * (0.94 + Math.random() * 0.12),
    spin: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.4),
    t: 0,
    dur: 3.2 + Math.random() * 3.0,
    size: ev.source === 'hn' ? 2.8 : ev.source === 'gh' ? 2.2 : 1.8,
  };
  particles.push(p);

  // Labels are rationed hard — one at a time-ish, only genuinely notable events,
  // and no wiki housekeeping pages (File:/Category:/Q1234…).
  const title = String(ev.title ?? '');
  const housekeeping = /^(File|Category|Template|User|Talk|Wikipedia|Draft):/i.test(title) || /^Q\d+$/.test(title);
  const notable =
    (ev.source === 'hn' && ev.type === 'story') ||
    (ev.source === 'gh' && ev.type === 'Release') ||
    (ev.source === 'wiki' && Math.abs(ev.delta ?? 0) > 8000 && !housekeeping);
  const nowMs = performance.now();
  if (notable && title && labels.length < 2 && nowMs - lastLabelAt > 2500) {
    lastLabelAt = nowMs;
    labels.push({
      text: title.slice(0, 52),
      x: CX + Math.cos(a0) * p.r0,
      y: CY + Math.sin(a0) * p.r0,
      color: s.color, t: 0,
    });
  }
}

function drawScene(dt, now) {
  // ---- background: stars, nebula, rings
  bgx.fillStyle = BG;
  bgx.fillRect(0, 0, W, H);
  if (nebula?.width) bgx.drawImage(nebula, 0, 0);
  for (const st of stars) {
    st.x -= 0.012 * st.z * dt * 60;
    if (st.x < 0) st.x += W;
    const a = 0.25 + 0.45 * st.z * (0.6 + 0.4 * Math.sin(st.tw + now / 900));
    bgx.fillStyle = `rgba(200, 215, 255, ${a.toFixed(3)})`;
    bgx.fillRect(st.x, st.y, st.z * 1.6, st.z * 1.6);
  }
  for (const key of Object.keys(SRC)) {
    const s = SRC[key];
    const rr = R * s.ring;
    bgx.strokeStyle = s.color + '17';
    bgx.lineWidth = 1;
    bgx.beginPath(); bgx.arc(CX, CY, rr, 0, Math.PI * 2); bgx.stroke();
    // a slow-orbiting brighter arc for life
    const t0 = now / 14000 * (key === 'gh' ? 1 : key === 'wiki' ? -0.7 : 0.5);
    bgx.strokeStyle = s.color + '40';
    bgx.beginPath(); bgx.arc(CX, CY, rr, t0, t0 + 0.5); bgx.stroke();
    bgx.fillStyle = s.color + '55';
    bgx.font = '9px ui-monospace, Menlo, monospace';
    bgx.textAlign = 'center';
    bgx.fillText(s.name, CX, CY - rr - 6);
  }

  // ---- floating labels (on bg: fully redrawn each frame, so no smearing)
  bgx.font = '10px ui-monospace, Menlo, monospace';
  bgx.textAlign = 'center';
  for (let i = labels.length - 1; i >= 0; i--) {
    const L = labels[i];
    L.t += dt / 4.5;
    if (L.t >= 1) { labels.splice(i, 1); continue; }
    const alpha = (L.t < 0.15 ? L.t / 0.15 : 1 - (L.t - 0.15) / 0.85) * 0.75;
    bgx.globalAlpha = alpha;
    bgx.fillStyle = L.color;
    bgx.fillText(L.text, Math.min(Math.max(L.x, 170), W - 170), L.y - L.t * 26);
  }
  bgx.globalAlpha = 1;

  // ---- fx: fade previous frame (keeps short trails), then additive particles
  fxx.globalCompositeOperation = 'destination-out';
  fxx.fillStyle = 'rgba(0, 0, 0, 0.13)';
  fxx.fillRect(0, 0, W, H);
  fxx.globalCompositeOperation = 'lighter';

  const pos = (p, t) => {
    const ease = Math.pow(t, 1.35);
    const r = p.r0 + (R * 0.10 - p.r0) * ease; // dissolve before reaching the core
    const a = p.a0 + p.spin * t * 2.2;
    return [CX + Math.cos(a) * r, CY + Math.sin(a) * r];
  };

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.t += dt / p.dur;
    if (p.t >= 1) {
      particles.splice(i, 1);
      coreEnergy = Math.min(coreEnergy + 0.15, 12);
      continue;
    }
    const ease = Math.pow(p.t, 1.35);
    const [x, y] = pos(p, p.t);
    const [tx, ty] = pos(p, Math.max(p.t - 0.045, 0));
    // fade out at the end of life instead of stacking into a white blob
    const fadeOut = p.t > 0.82 ? (1 - p.t) / 0.18 : 1;
    const bright = (0.7 + 0.3 * ease) * fadeOut;
    const col = SRC[p.src].color;
    // comet tail + soft halo + hot core (additive blend makes convergence glow)
    fxx.strokeStyle = col;
    fxx.globalAlpha = bright * 0.4;
    fxx.lineWidth = p.size * 0.9;
    fxx.lineCap = 'round';
    fxx.beginPath(); fxx.moveTo(tx, ty); fxx.lineTo(x, y); fxx.stroke();
    fxx.fillStyle = col;
    fxx.globalAlpha = bright * 0.2;
    fxx.beginPath();
    fxx.arc(x, y, p.size * 2.2 * (0.7 + ease * 0.5), 0, Math.PI * 2);
    fxx.fill();
    fxx.globalAlpha = bright;
    fxx.beginPath();
    fxx.arc(x, y, p.size * (0.7 + ease * 0.5), 0, Math.PI * 2);
    fxx.fill();
  }
  fxx.globalAlpha = 1;

  // ---- the core: breathes with real throughput
  coreEnergy *= Math.pow(0.35, dt);
  const totalRate = state.rates.gh + state.rates.wiki + state.rates.hn;
  const breath = 1 + 0.08 * Math.sin(now / 700);
  // kept well inside the innermost ring so the firehose can't blind the telescope
  const coreR = (8 + Math.min(totalRate / 140, 12) + coreEnergy * 0.6) * breath;
  const g = fxx.createRadialGradient(CX, CY, 0, CX, CY, coreR * 2.2);
  g.addColorStop(0, 'rgba(235, 240, 255, 0.85)');
  g.addColorStop(0.3, 'rgba(140, 170, 255, 0.28)');
  g.addColorStop(1, 'transparent');
  fxx.fillStyle = g;
  fxx.beginPath(); fxx.arc(CX, CY, coreR * 2.2, 0, Math.PI * 2); fxx.fill();

  fxx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- HUD + ticker

const bigCount = document.getElementById('bigCount');
const modeEl = document.getElementById('mode');
const modeText = document.getElementById('modeText');
const tickerList = document.getElementById('tickerList');
const frontList = document.getElementById('frontList');
const cursorTime = document.getElementById('cursorTime');

function setMode(m, label) {
  state.mode = m;
  modeEl.className = m;
  modeText.textContent = label;
  document.getElementById('liveBtn').classList.toggle('on', m === 'live');
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function updateSourceRow(src, rate, status) {
  const li = document.querySelector(`#sources li[data-src="${src}"]`);
  if (!li) return;
  if (rate != null) li.querySelector('.rate').innerHTML = `${rate.toLocaleString()} <b>ev/min</b>`;
  if (status != null) {
    li.querySelector('.st').textContent = status;
    li.className = status === 'live' ? 'live' : (status === 'connecting' ? '' : 'bad');
  }
}

let tickerBudget = 0; // wiki firehose is throttled into the ticker
function ticker(ev, historical = false) {
  if (ev.source === 'wiki') {
    tickerBudget += 0.14;
    if (tickerBudget < 1) return;
    tickerBudget = 0;
  }
  const li = document.createElement('li');
  li.dataset.src = ev.source;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (historical) t.style.color = 'var(--amber)';
  const body = document.createElement('span');
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = (ev.type ?? ev.source).toUpperCase().slice(0, 10);
  const a = document.createElement('a');
  a.href = ev.url ?? '#'; a.target = '_blank'; a.rel = 'noopener';
  a.textContent = ev.title ?? '(untitled)';
  body.append(tag, a);
  if (ev.actor) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = ` — ${ev.actor}`;
    body.append(who);
  }
  li.append(t, body);
  tickerList.prepend(li);
  while (tickerList.children.length > 32) tickerList.lastChild.remove();
}

function renderFrontPage(stories) {
  frontList.innerHTML = '';
  for (const s of stories ?? []) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = s.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `▲ ${s.score} · ${s.comments} comments · ${s.by}`;
    a.append(meta);
    li.append(a);
    frontList.append(li);
  }
}

// ---------------------------------------------------------------- sound

let audio = null;
function blip(freq) {
  if (!state.soundOn) return;
  audio ??= new (window.AudioContext || window.webkitAudioContext)();
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.frequency.value = freq;
  o.type = 'sine';
  g.gain.setValueAtTime(0.06, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
  o.connect(g).connect(audio.destination);
  o.start(); o.stop(audio.currentTime + 0.4);
}
document.getElementById('soundBtn').addEventListener('click', e => {
  state.soundOn = !state.soundOn;
  e.target.textContent = state.soundOn ? '🔊' : '🔇';
  if (state.soundOn) blip(660);
});

// ---------------------------------------------------------------- live feed (SSE)

function bumpMinute(ev) {
  const m = Math.floor(ev.ts / 60000);
  let row = state.minutes.get(m);
  if (!row) { row = { gh: 0, wiki: 0, hn: 0 }; state.minutes.set(m, row); }
  row[ev.source]++;
}

const es = new EventSource('/api/live');

es.addEventListener('snapshot', e => {
  const s = JSON.parse(e.data);
  state.totals = s.totals;
  state.rates = s.rates;
  state.shownCount = s.totals.gh + s.totals.wiki + s.totals.hn;
  for (const [src, st] of Object.entries(s.status)) updateSourceRow(src, s.rates[src], st);
  renderFrontPage(s.frontPage);
  // the server may still be fetching the front page on a cold start
  if (!s.frontPage?.length) {
    const retry = async () => {
      try {
        const st = await (await fetch('/api/stats')).json();
        if (st.frontPage?.length) renderFrontPage(st.frontPage);
        else setTimeout(retry, 8000);
      } catch { setTimeout(retry, 8000); }
    };
    setTimeout(retry, 6000);
  }
  for (const ev of s.recent ?? []) ticker(ev);
  if (state.mode === 'live') setMode('live', 'LIVE — NOW');
});

es.addEventListener('ev', e => {
  const ev = JSON.parse(e.data);
  state.totals[ev.source]++;
  bumpMinute(ev);
  if (state.mode !== 'live') return;
  // rAF is paused in hidden tabs — don't stockpile particles for a burst on return
  if (document.hidden) return;
  spawn(ev);
  ticker(ev);
  if (ev.source === 'hn' && ev.type === 'story') blip(720);
  if (ev.source === 'gh' && ev.type === 'Release') blip(520);
});

es.addEventListener('rates', e => {
  const d = JSON.parse(e.data);
  state.rates = d.rates;
  for (const src of ['gh', 'wiki', 'hn']) updateSourceRow(src, d.rates[src], null);
});

es.addEventListener('status', e => {
  const { source, state: st } = JSON.parse(e.data);
  updateSourceRow(source, null, st);
});

es.onerror = () => { if (state.mode === 'live') setMode('live', 'RECONNECTING…'); };

// refresh HN front page occasionally
setInterval(async () => {
  try {
    const s = await (await fetch('/api/stats')).json();
    renderFrontPage(s.frontPage);
  } catch { /* offline */ }
}, 5 * 60_000);

// ---------------------------------------------------------------- history + timeline

async function loadHistory() {
  try {
    const d = await (await fetch('/api/history?hours=24')).json();
    for (const m of d.minutes) {
      state.minutes.set(m.minute, { gh: m.gh, wiki: m.wiki, hn: m.hn });
    }
  } catch { /* retry next cycle */ }
}
loadHistory();
setInterval(loadHistory, 60_000);

function drawTimeline(now) {
  const w = tl.getBoundingClientRect().width;
  const h = tl.getBoundingClientRect().height;
  tlx.clearRect(0, 0, w, h);
  tlx.fillStyle = 'rgba(255,255,255,0.02)';
  tlx.fillRect(0, 0, w, h);

  const t1 = now, t0 = now - DAY;
  const m0 = Math.floor(t0 / 60000), m1 = Math.floor(t1 / 60000);
  const nMin = m1 - m0;

  // max stacked total for scale (sqrt-compressed so wiki doesn't flatten the rest)
  let maxV = 1;
  for (let m = m0; m <= m1; m++) {
    const row = state.minutes.get(m);
    if (row) maxV = Math.max(maxV, row.gh + row.wiki + row.hn);
  }
  const scale = v => Math.sqrt(v / maxV) * (h - 14);

  // stacked areas, wiki at the bottom
  const order = ['wiki', 'gh', 'hn'];
  const acc = new Float32Array(nMin + 1);
  for (const src of order) {
    tlx.beginPath();
    tlx.moveTo(0, h);
    for (let i = 0; i <= nMin; i++) {
      const row = state.minutes.get(m0 + i);
      const v = row ? row[src] : 0;
      const prev = acc[i];
      acc[i] = prev + v;
      const x = (i / nMin) * w;
      tlx.lineTo(x, h - scale(acc[i]));
    }
    tlx.lineTo(w, h);
    tlx.closePath();
    tlx.fillStyle = SRC[src].color + '5c';
    tlx.fill();
  }

  // hour ticks
  tlx.fillStyle = 'rgba(160,180,230,0.45)';
  tlx.font = '9px ui-monospace, Menlo, monospace';
  tlx.textAlign = 'center';
  const firstTick = Math.ceil(t0 / (4 * 3600_000)) * 4 * 3600_000;
  for (let t = firstTick; t < t1; t += 4 * 3600_000) {
    const x = ((t - t0) / DAY) * w;
    tlx.fillRect(x, h - 8, 1, 8);
    tlx.fillText(new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), x, h - 12);
  }

  // playhead
  const ph = state.mode === 'replay' ? state.virtual : now;
  const px = ((ph - t0) / DAY) * w;
  tlx.strokeStyle = state.mode === 'replay' ? '#ffb454' : '#ff4757';
  tlx.lineWidth = 1.5;
  tlx.beginPath(); tlx.moveTo(px, 0); tlx.lineTo(px, h); tlx.stroke();
  tlx.fillStyle = tlx.strokeStyle;
  tlx.beginPath(); tlx.arc(px, 4, 3, 0, Math.PI * 2); tlx.fill();
}

// ---------------------------------------------------------------- time travel

const REPLAY_WINDOW = 10 * 60_000; // fetch chunk size

async function fetchReplayChunk(fromMs) {
  state.fetching = true;
  try {
    const center = fromMs + REPLAY_WINDOW / 2;
    const d = await (await fetch(`/api/replay?ts=${Math.round(center)}&window=${REPLAY_WINDOW}`)).json();
    state.buffer = d.events;
    state.bufPtr = 0;
    state.bufEnd = fromMs + REPLAY_WINDOW;
    // skip events before the current virtual clock
    while (state.bufPtr < state.buffer.length && state.buffer[state.bufPtr].ts < state.virtual) state.bufPtr++;
  } catch { /* keep going; next tick retries */ }
  state.fetching = false;
}

function enterReplay(ts) {
  const now = Date.now();
  ts = Math.min(Math.max(ts, now - DAY), now - 1000);
  state.virtual = ts;
  state.buffer = []; state.bufPtr = 0; state.bufEnd = 0;
  setMode('replay', 'REPLAY');
  fetchReplayChunk(ts);
}

function exitReplay() {
  setMode('live', 'LIVE — NOW');
  cursorTime.textContent = '';
  particles.length = 0;
  labels.length = 0;
}

function replayTick(dt) {
  state.virtual += dt * 1000 * state.speed;
  const now = Date.now();
  if (state.virtual >= now - 2000) return exitReplay();

  modeText.textContent = `REPLAY ×${state.speed}`;
  cursorTime.textContent = fmtTime(state.virtual);

  // spawn buffered events the virtual clock has passed
  let spawned = 0;
  while (state.bufPtr < state.buffer.length && state.buffer[state.bufPtr].ts <= state.virtual) {
    const ev = state.buffer[state.bufPtr++];
    spawn(ev);
    if (spawned++ < 3) ticker(ev, true);
  }
  // refill ahead of the clock
  if (!state.fetching && state.bufEnd && state.virtual > state.bufEnd - 60_000) {
    fetchReplayChunk(state.bufEnd);
  }
}

// timeline interaction
function timelineTs(clientX) {
  const rect = tl.getBoundingClientRect();
  const frac = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  return Date.now() - DAY + frac * DAY;
}
tl.addEventListener('pointerdown', e => {
  state.dragging = true;
  tl.setPointerCapture(e.pointerId);
  enterReplay(timelineTs(e.clientX));
});
tl.addEventListener('pointermove', e => {
  if (!state.dragging) return;
  state.virtual = Math.min(timelineTs(e.clientX), Date.now() - 1000);
  cursorTime.textContent = fmtTime(state.virtual);
});
tl.addEventListener('pointerup', e => {
  state.dragging = false;
  if (state.mode === 'replay') fetchReplayChunk(state.virtual);
});

document.getElementById('liveBtn').addEventListener('click', exitReplay);
document.querySelectorAll('#speeds button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#speeds button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    state.speed = Number(btn.dataset.speed);
  });
});

// ---------------------------------------------------------------- main loop

let lastFrame = performance.now();
let lastTlDraw = 0;

function frame(now) {
  // catches loads in hidden tabs (innerWidth 0) as well as window resizes
  if (W !== window.innerWidth || H !== window.innerHeight) resize();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (state.mode === 'replay' && !state.dragging) replayTick(dt);

  // odometer easing toward the true total
  const trueTotal = state.totals.gh + state.totals.wiki + state.totals.hn;
  state.shownCount += (trueTotal - state.shownCount) * Math.min(dt * 6, 1);
  if (trueTotal - state.shownCount < 1) state.shownCount = trueTotal;
  bigCount.textContent = Math.floor(state.shownCount).toLocaleString();

  drawScene(dt, now);
  if (now - lastTlDraw > 250) { drawTimeline(Date.now()); lastTlDraw = now; }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
