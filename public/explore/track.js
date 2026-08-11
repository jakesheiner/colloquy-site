// A standalone reader for the Colloquy recording, for the experimental 2D views
// under /explore/. It deliberately does NOT touch the live site: it decompresses
// and parses the same clip in the browser, walks the same carry-forward the
// scroll page's `src/drives.js` does, and returns the WHOLE time series (every
// tick, every body) rather than a one-tick read — because these views plot over
// time instead of scrubbing a single moment.
//
// No three.js, no player, no scene. Just numbers: per body, per tick — its
// behavioural state, its two drive levels, and where it sits around the plinth.

export const CLIP_URL = '/clips/new_clip.ndjson.gz';

// The three behavioural states, mapped to the words the DDO explainer slide uses
// (Searching / Conversing / Resting) and to the two body colours' neutral greys.
// `order` is left→right on the state-sorter, and the sim's own state string is
// the key.
export const STATES = {
  'satisfaction-search': { key: 'searching', title: 'Searching', gloss: 'for a partner to engage in conversation' },
  'engaging-partner':    { key: 'engaging',  title: 'Conversing', gloss: 'with a partner to satisfy their goals' },
  'satisfied-and-indifferent': { key: 'resting', title: 'Resting', gloss: 'in order to recharge its “drives.”' },
};
export const STATE_ORDER = ['satisfaction-search', 'engaging-partner', 'satisfied-and-indifferent'];

export const COLOURS = {
  female: '#e0189a',
  male: '#3abff8',
  driveO: '#f5c342',
  driveP: '#57b036',
};

const UNIT_FROM_ID = /^(female|male)_\d+$/;

/**
 * Fetch + (maybe) gunzip + split into parsed NDJSON.
 *
 * Whether the bytes arrive still compressed depends on the host: a dev server
 * often serves a `.gz` with `Content-Encoding: gzip`, in which case the browser
 * has already inflated it and the body is plain NDJSON. So this sniffs the gzip
 * magic (0x1f 0x8b) and only decompresses when the bytes really are gzipped —
 * which is right on either kind of host.
 */
async function fetchLines(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`clip fetch failed: ${res.status} ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  let text;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buf);
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (line) out.push(JSON.parse(line));
  }
  return out;
}

/**
 * Read the recording into a dense time series.
 *
 * The clip is one JSON object per line: line 0 the header, line 1 a full
 * snapshot (scene graph + the first behavioural frame), and every line after it
 * a tick that carries either a full frame or just the vars that changed
 * (`frameDelta`). Behavioural values therefore CARRY FORWARD — the walk below
 * accumulates them into `vars` exactly the way the live page does — and so do
 * the per-body angle tables (`behavioral.males/females`), which is why a body's
 * position is remembered across the ticks that omit it.
 */
export async function loadTrack(url = CLIP_URL) {
  const lines = await fetchLines(url);
  const header = lines[0] ?? {};
  const snapshot = lines[1];
  const entries = lines.slice(2);
  if (!snapshot?.behavioral?.frame?.values) throw new Error('clip has no behavioural snapshot');

  const b0 = snapshot.behavioral;
  const units = [
    ...(b0.females ?? []).map((u) => ({ ...u, side: 'female' })),
    ...(b0.males ?? []).map((u) => ({ ...u, side: 'male' })),
  ]
    .filter((u) => u?.id && UNIT_FROM_ID.test(u.id))
    .map((u, i) => ({
      index: i,
      id: u.id,
      label: u.label ?? u.id,
      // "Female A" → "A", "Male II" → "II". The side is carried separately.
      short: (u.label ?? u.id).split(/\s+/).pop(),
      side: u.side,
    }));
  if (units.length === 0) throw new Error('clip names no bodies');

  const width = units.length;
  const count = entries.length + 1;

  // Per body, per row. Flat typed arrays, indexed `row * width + unit`.
  const stateNames = [];
  const stateIndex = new Map();
  const stateOf = (name) => {
    if (!name) return 255;
    let i = stateIndex.get(name);
    if (i === undefined) { i = stateNames.push(name) - 1; stateIndex.set(name, i); }
    return i;
  };

  const state = new Uint8Array(count * width).fill(255);
  const levelO = new Float32Array(count * width);
  const levelP = new Float32Array(count * width);
  const angle = new Float32Array(count * width);
  const ticks = new Int32Array(count);

  const vars = new Map();
  const apply = (values) => {
    for (const v of values ?? []) {
      if (!v?.path) continue;
      Object.assign(vars.get(v.path) ?? vars.set(v.path, {}).get(v.path), v.vars);
    }
  };
  const forget = (paths) => { for (const p of paths ?? []) vars.delete(p); };

  // Angles live outside `frame.values`, on `behavioral.males/females`. They also
  // carry forward, so they get their own tiny accumulator.
  const angleOf = new Map();
  const applyAngles = (bh) => {
    if (!bh) return;
    for (const u of bh.females ?? []) if (u?.id && u.fixedAngle != null) angleOf.set(u.id, u.fixedAngle);
    for (const u of bh.males ?? []) if (u?.id && u.worldAngle != null) angleOf.set(u.id, u.worldAngle);
  };

  let lowerLimit = 0;
  let upperLimit = 0;
  let ceiling = 0;

  const sample = (row, tick) => {
    ticks[row] = tick;
    for (let i = 0; i < width; i++) {
      const mobile = vars.get(units[i].id);
      const drive = vars.get(`${units[i].id}/drive`);
      const at = row * width + i;
      if (mobile?.state !== undefined) state[at] = stateOf(mobile.state);
      const a = angleOf.get(units[i].id);
      if (a != null) angle[at] = a;
      if (!drive) continue;
      const o = drive.internal_level_O ?? 0;
      const p = drive.internal_level_P ?? 0;
      levelO[at] = o;
      levelP[at] = p;
      if (o > ceiling) ceiling = o;
      if (p > ceiling) ceiling = p;
      if (drive.internal_drive_lower_limit) lowerLimit = drive.internal_drive_lower_limit;
      if (drive.internal_drive_upper_limit) upperLimit = drive.internal_drive_upper_limit;
    }
  };

  apply(b0.frame.values);
  applyAngles(b0);
  sample(0, snapshot.tick ?? 0);

  for (let e = 0; e < entries.length; e++) {
    const msg = entries[e];
    const full = msg.behavioral?.frame?.values;
    if (full) apply(full);
    else { forget(msg.frameDelta?.removed); apply(msg.frameDelta?.changed); }
    applyAngles(msg.behavioral);
    sample(e + 1, msg.tick);
  }

  const scale = ceiling > 0 ? ceiling : 1;

  return {
    units,
    width,
    count,
    tickRate: header.tickRate ?? 20,
    durationMs: header.durationMs ?? (count / (header.tickRate ?? 20)) * 1000,
    lowerLimit,
    upperLimit,
    ceiling,
    /** Where the "spent" line sits on a 0…1 drive axis. */
    lowerMark: lowerLimit / scale,
    stateNames,

    // --- point reads ---------------------------------------------------------
    rowOfFraction(f) {
      return Math.min(count - 1, Math.max(0, Math.round(f * (count - 1))));
    },
    tickAt(row) { return ticks[Math.min(count - 1, Math.max(0, row))]; },
    /** Seconds into the piece at a row. */
    timeAt(row) { return (this.tickAt(row) - ticks[0]) / this.tickRate; },

    /** One body at one row: normalised drives, state string, angle in degrees. */
    at(row, unit) {
      const r = Math.min(count - 1, Math.max(0, row));
      const idx = r * width + unit;
      return {
        o: levelO[idx] / scale,
        p: levelP[idx] / scale,
        oRaw: levelO[idx],
        pRaw: levelP[idx],
        state: stateNames[state[idx]] ?? '',
        angle: angle[idx],
      };
    },

    /** The whole normalised curve for one body's drive, for a line plot. */
    series(unit, drive) {
      const src = drive === 'p' ? levelP : levelO;
      const out = new Float32Array(count);
      for (let r = 0; r < count; r++) out[r] = src[r * width + unit] / scale;
      return out;
    },

    /** Raw state id at a row for one body (fast path for the sorter). */
    stateKeyAt(row, unit) {
      const r = Math.min(count - 1, Math.max(0, row));
      return stateNames[state[r * width + unit]] ?? '';
    },
  };
}

/**
 * A shared real-time playhead for all three views: a row index that advances at
 * the recording's own wall-clock rate, loops, and can be scrubbed. Views pass an
 * `onFrame(row, fraction)` and get called on every animation frame while playing
 * and once on every seek.
 */
export class Playhead {
  constructor(track, onFrame) {
    this.track = track;
    this.onFrame = onFrame;
    this.row = 0;
    this.playing = false;
    this._raf = 0;
    this._last = 0;
    this._acc = 0;
    this._tick = this._tick.bind(this);
  }
  get fraction() { return this.track.count > 1 ? this.row / (this.track.count - 1) : 0; }
  emit() { this.onFrame(this.row, this.fraction); }
  seek(row) {
    this.row = Math.min(this.track.count - 1, Math.max(0, Math.round(row)));
    this.emit();
  }
  seekFraction(f) { this.seek(f * (this.track.count - 1)); }
  play() {
    if (this.playing) return;
    this.playing = true;
    if (this.row >= this.track.count - 1) this.row = 0;
    this._last = performance.now();
    this._acc = 0;
    this._raf = requestAnimationFrame(this._tick);
    this._onState?.(true);
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this._onState?.(false);
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  onStateChange(fn) { this._onState = fn; }
  _tick(now) {
    if (!this.playing) return;
    const dt = now - this._last;
    this._last = now;
    // Advance rows at the clip's true tick rate so playback matches real time.
    this._acc += (dt / 1000) * this.track.tickRate;
    if (this._acc >= 1) {
      const steps = Math.floor(this._acc);
      this._acc -= steps;
      this.row += steps;
      if (this.row >= this.track.count - 1) { this.row = this.track.count - 1; this.emit(); this.pause(); return; }
      this.emit();
    }
    this._raf = requestAnimationFrame(this._tick);
  }
}

/** Build the play/scrub/time transport shared by every view. */
export function mountTransport(host, track, playhead) {
  host.classList.add('transport');
  host.innerHTML =
    '<button class="transport-play" type="button" aria-label="Play">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path class="i-play" d="M8 5v14l11-7z"/><g class="i-pause" style="display:none"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></g></svg>' +
    '</button>' +
    '<input class="transport-range" type="range" min="0" max="' + (track.count - 1) + '" value="0" step="1" aria-label="Timeline">' +
    '<span class="transport-time"><b>0:00</b> / ' + fmtTime(track.durationMs / 1000) + '</span>';

  const btn = host.querySelector('.transport-play');
  const range = host.querySelector('.transport-range');
  const time = host.querySelector('.transport-time b');
  const iPlay = host.querySelector('.i-play');
  const iPause = host.querySelector('.i-pause');

  btn.addEventListener('click', () => playhead.toggle());
  playhead.onStateChange((playing) => {
    // SVG elements ignore the HTML `hidden` attribute, so toggle `display`.
    iPlay.style.display = playing ? 'none' : '';
    iPause.style.display = playing ? '' : 'none';
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
  range.addEventListener('input', () => {
    if (playhead.playing) playhead.pause();
    playhead.seek(Number(range.value));
  });

  // Reflect every playhead move (scrub or playback) back into the transport.
  return (row) => {
    range.value = String(row);
    time.textContent = fmtTime(track.timeAt(row));
  };
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
