// Writes public/clips/*.colloquy-rec.ndjson.gz — a CONSTRUCTED clip in which the
// encounter builds towards the end instead of dissolving in the middle.
//
// WHY
//
// The published recording opens *mid-encounter*: Male II and Female A are
// already engaged at tick 0, and its minute is that engagement coming apart
// (Female A lets go at 53%, Male II at 76%). Nowhere in it do two bodies find
// each other, so no trim can put a build-up at the end of the scroll.
//
// HOW
//
// Two stretches of the real recording, cut together, both playing forwards:
//
//   A  the tail, where every body is searching        → the opening
//   B  the head, where the pair are engaged           → the payoff, held to the end
//
// Time runs forwards throughout, and every frame is a recorded frame — this is
// an edit, not a fabrication. What it does introduce is one cut. To make that
// cut as invisible as possible the script does not simply join A to B: it
// compares every candidate frame in A against every candidate frame at the head
// of B and picks the pair whose bodies are physically closest to each other,
// then joins there. The residual is reported below against the size of an
// ordinary one-tick change, so the cost is measured rather than assumed.
//
// The cut is also where the beam switches on — `env.beamActive` is empty
// throughout A and holds `male_2` throughout B — so it reads as the moment the
// beam finds the mirror. That reading is the edit's, not the simulation's: the
// engagement begins at a cut, not through a process.
//
//   node scripts/build-spliced-clip.mjs

import { gunzipSync, gzipSync } from 'node:zlib';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ORIGINAL_CLIP_URL } from '../src/clip.js';

const OUT_NAME = 'colloquy-encounter-built.colloquy-rec.ndjson.gz';
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const clone = (value) => JSON.parse(JSON.stringify(value));

async function readClip(url) {
  if (/^https?:/.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`clip fetch failed: ${response.status} ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(resolve(publicDir, url.replace(/^\//, '')));
}

const source = gunzipSync(await readClip(ORIGINAL_CLIP_URL)).toString('utf8');
const lines = source.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const header = lines[0];
const snapshot = lines[1];

// --- 1. replay forwards, keeping the complete state at every tick ------------

const rows = new Map();
for (const row of snapshot.behavioral.frame.values) rows.set(row.path, clone(row));

// `behavioral` carries more than `frame`: `males`/`females` are the id-to-label
// table, and `env` holds `engaging` and `beamActive`. They are written only when
// they change, so they carry forward — and the player reads engagement from
// them. Dropping them yields a clip that plays but reports no events at all.
const carried = {
  males: clone(snapshot.behavioral.males),
  females: clone(snapshot.behavioral.females),
  beam: clone(snapshot.behavioral.beam),
  env: clone(snapshot.behavioral.env),
};

const capture = () => ({
  values: clone([...rows.values()]),
  males: clone(carried.males),
  females: clone(carried.females),
  beam: clone(carried.beam),
  env: clone(carried.env),
});

const frames = [capture()];
for (let i = 2; i < lines.length; i++) {
  const patch = lines[i];
  const behavioral = patch.behavioral ?? {};
  if (behavioral.frame) {
    rows.clear();
    for (const row of behavioral.frame.values) rows.set(row.path, clone(row));
  } else if (patch.frameDelta) {
    for (const path of patch.frameDelta.removed ?? []) rows.delete(path);
    for (const change of patch.frameDelta.changed ?? []) {
      const row = rows.get(change.path);
      if (row) Object.assign(row.vars, change.vars);
      else rows.set(change.path, clone(change));
    }
  }
  for (const key of ['males', 'females', 'beam', 'env']) {
    if (behavioral[key] !== undefined) carried[key] = clone(behavioral[key]);
  }
  frames.push(capture());
}

// --- 2. find the two stretches -----------------------------------------------

const stateOf = (frame, unit) =>
  frame.values.find((row) => row.path === unit)?.vars?.state ?? null;
const PAIR = ['female_1', 'male_2'];
const noneEngaged = (frame) =>
  PAIR.every((unit) => stateOf(frame, unit) !== 'engaging-partner');
const bothEngaged = (frame) =>
  PAIR.every((unit) => stateOf(frame, unit) === 'engaging-partner');

// Fraction of the finished clip the engagement should occupy. It runs from the
// cut to the end, so this is what decides how late the encounter lands.
const ENGAGED_SHARE = 0.4;

// A: from the moment neither body is engaged any more, to the end of the
// recording. "Neither engaged" rather than "both searching" — the strict
// reading leaves only 8s of usable opening, which is not enough to arrive
// anywhere from.
const freeFrom = frames.findIndex(noneEngaged);
// B: the pair engaged, from the very start until the first of them lets go.
const engagedEnd = frames.findIndex((frame, i) => i > 0 && !bothEngaged(frame));
if (freeFrom < 0 || engagedEnd < 1) {
  throw new Error('this clip does not contain both an unengaged stretch and an engaged one');
}

const A = { from: freeFrom, to: frames.length - 1 };
const B = { from: 0, to: engagedEnd - 1 };

// --- 3. choose the cut ---------------------------------------------------------

// Compare only where the joints actually ARE — `sense_position`. Matching on
// `act_goal_position` as well pulls the cut towards frames that merely intend
// the same thing, which is invisible, and its ±60 swings drown out the
// positions that do show.
//
// Each joint is normalised by its own travel: they range from ±25 to ±60, so
// unnormalised the widest ones decide the cut on their own. The residual then
// reads as a fraction of full travel, which is a number worth reporting.
const posPaths = [...new Set(frames[0].values.map((row) => row.path))].filter((path) =>
  /horizontal-motion|splodge|reflector|beam/i.test(path)
);

const travel = new Map();
for (const path of posPaths) {
  let low = Infinity;
  let high = -Infinity;
  for (const frame of frames) {
    const value = frame.values.find((row) => row.path === path)?.vars?.sense_position;
    if (typeof value !== 'number') continue;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  if (high > low) travel.set(path, high - low);
}

function distance(a, b) {
  const left = new Map(a.values.map((row) => [row.path, row.vars]));
  const right = new Map(b.values.map((row) => [row.path, row.vars]));
  let sum = 0;
  let n = 0;
  for (const [path, span] of travel) {
    const x = left.get(path)?.sense_position;
    const y = right.get(path)?.sense_position;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    const d = (x - y) / span;
    sum += d * d;
    n += 1;
  }
  return n ? Math.sqrt(sum / n) : Infinity;
}

// The cut may fall in the last stretch of A and the first stretch of B — enough
// freedom to find a genuinely close pair of frames, not so much that it eats the
// opening (an unconstrained search just picks A's first frame and throws the
// approach away).
const aWindow = A.to - Math.round((A.to - A.from) * 0.4);
const bWindow = B.from + Math.max(1, Math.round((B.to - B.from) * 0.35));
let cut = null;
for (let i = aWindow; i <= A.to; i++) {
  for (let j = B.from; j <= bWindow; j++) {
    const d = distance(frames[i], frames[j]);
    if (!cut || d < cut.d) cut = { d, i, j };
  }
}

// For scale: how much the bodies move in one ordinary tick.
let step = 0;
for (let i = A.from + 1; i <= A.to; i++) step += distance(frames[i - 1], frames[i]);
const typicalStep = step / (A.to - A.from);

const order = [];
for (let i = A.from; i <= cut.i; i++) order.push(i);
// Hold the engagement for the share of the clip asked for, no longer: the whole
// point is that it arrives late.
const engagedWanted = Math.round((order.length * ENGAGED_SHARE) / (1 - ENGAGED_SHARE));
const engagedTo = Math.min(B.to, cut.j + engagedWanted - 1);
for (let j = cut.j; j <= engagedTo; j++) order.push(j);

// --- 4. re-emit ----------------------------------------------------------------

const tickRate = header.tickRate;
const tickStart = header.tickStart;
const keyframeEvery = header.keyframeEveryTicks ?? 40;
const recordedAt = new Date().toISOString();
const startedAt = Date.parse(recordedAt);

const out = [
  {
    ...header,
    recordedAt,
    title: 'encounter (built)',
    note:
      'Constructed from the published capture: a stretch where every body is searching, ' +
      'cut to a stretch where a pair are engaged. Both play forwards; the join is one cut.',
    tickStart,
    tickEnd: tickStart + order.length - 1,
    tickCount: order.length,
    durationMs: Math.round(((order.length - 1) / tickRate) * 1000),
    // Published markers point at ticks in the original ordering.
    markers: [],
  },
];

function diff(previous, current) {
  const before = new Map(previous.values.map((row) => [row.path, row]));
  const changed = [];
  for (const row of current.values) {
    const old = before.get(row.path);
    if (!old) {
      changed.push(clone(row));
      continue;
    }
    const vars = {};
    let any = false;
    for (const key of Object.keys(row.vars ?? {})) {
      if (JSON.stringify(old.vars?.[key]) !== JSON.stringify(row.vars[key])) {
        vars[key] = row.vars[key];
        any = true;
      }
    }
    if (any) changed.push({ path: row.path, vars });
  }
  const now = new Set(current.values.map((row) => row.path));
  const removed = previous.values.map((row) => row.path).filter((path) => !now.has(path));
  return { changed, removed };
}

order.forEach((sourceIndex, index) => {
  const frame = frames[sourceIndex];
  const tick = tickStart + index;
  const simTime = Number((index / tickRate).toFixed(2));
  const common = {
    type: index === 0 ? 'snapshot' : 'patch',
    tick,
    timestamp: startedAt + Math.round((index / tickRate) * 1000),
    sceneEpoch: header.sceneEpoch,
    nodes: [],
    controllers: [],
    runtimeState: 'running',
    telemetry: {
      schemaVersion: 1,
      drive: { internal_sim_sample_tick: tick, internal_sim_time: simTime },
    },
  };
  // Written on every line rather than only on change: a few hundred bytes that
  // gzip away, and no chance of a carry-forward being read differently on a
  // seek than on a linear play.
  const context = {
    males: clone(frame.males),
    females: clone(frame.females),
    beam: clone(frame.beam),
    env: clone(frame.env),
  };

  if (index === 0) {
    out.push({
      ...common,
      sceneGraph: snapshot.sceneGraph,
      keyframe: true,
      behavioral: { tick, simTime, frame: { values: clone(frame.values) }, ...context },
    });
    return;
  }
  if (index % keyframeEvery === 0) {
    out.push({
      ...common,
      baseTick: tick - 1,
      keyframe: true,
      behavioral: { tick, simTime, frame: { values: clone(frame.values) }, ...context },
    });
    return;
  }
  out.push({
    ...common,
    baseTick: tick - 1,
    frameDelta: diff(frames[order[index - 1]], frame),
    behavioral: { tick, simTime, ...context },
  });
});

const ndjson = out.map((line) => JSON.stringify(line)).join('\n') + '\n';
const bytes = gzipSync(Buffer.from(ndjson, 'utf8'), { level: 9 });
await mkdir(resolve(publicDir, 'clips'), { recursive: true });
const outPath = resolve(publicDir, 'clips', OUT_NAME);
await writeFile(outPath, bytes);

// --- 5. report ------------------------------------------------------------------

const pct = (i) => `${((i / (order.length - 1)) * 100).toFixed(0)}%`;
const cutAt = order.indexOf(cut.j);
const source_ = (i) => `${((i / (frames.length - 1)) * 100).toFixed(0)}%`;

console.log(`source: ${frames.length} ticks, ${(header.durationMs / 1000).toFixed(1)}s`);
console.log(
  `  A (all searching): source ${source_(A.from)}–${source_(cut.i)}\n` +
    `  B (pair engaged):  source ${source_(cut.j)}–${source_(B.to)}`
);
console.log(
  `\ncut quality: joints land ${(cut.d * 100).toFixed(1)}% of their travel apart ` +
    `(an ordinary tick moves them ${(typicalStep * 100).toFixed(1)}%, so ` +
    `${(cut.d / typicalStep).toFixed(0)}× one frame)`
);
console.log(`cut lands at ${pct(cutAt)} of the new clip`);

const runs = new Map(PAIR.map((unit) => [unit, []]));
order.forEach((sourceIndex, index) => {
  for (const unit of PAIR) {
    const state = stateOf(frames[sourceIndex], unit);
    const run = runs.get(unit);
    if (!run.length || run[run.length - 1].state !== state) run.push({ at: index, state });
  }
});
console.log(`\nwrote ${outPath} (${(bytes.length / 1024).toFixed(0)} KB, ${order.length} ticks, ${(order.length / tickRate).toFixed(1)}s)`);
console.log('engagement arc in the new clip:');
for (const [unit, run] of runs) {
  console.log(
    `  ${unit}: ` +
      run
        .map((r, i) => `${r.state} ${pct(r.at)}–${pct(run[i + 1] ? run[i + 1].at : order.length - 1)}`)
        .join('  →  ')
  );
}
