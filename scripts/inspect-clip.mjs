// Preflight for a clip swap: does this recording carry what the page needs?
//
// The page derives everything from the clip — the scroll stops, the captions,
// the camera timing, the drive readout — so a clip that is missing a piece does
// not error, it just quietly produces a duller page. This reports the three
// things worth knowing before swapping, and why each matters. See the README,
// "Swapping in a new clip".
//
//   node scripts/inspect-clip.mjs public/clips/<clip>.ndjson.gz

import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { PARTS } from '../src/clip.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-clip.mjs <clip.ndjson.gz>');
  process.exit(1);
}

const lines = gunzipSync(await readFile(file)).toString('utf8').split('\n').filter(Boolean);
const header = JSON.parse(lines[0]);
const snapshot = JSON.parse(lines[1]);

// Line 2 is the first full state frame, which carries the scene graph.
const meshes = [...new Set([...lines[1].matchAll(/"(models\/[^"]+\.obj)"/g)].map((m) => m[1]))];

// Events, in either of the two schemas the player has shipped (see `stateChanges`).
const kinds = new Map();
const first = new Map();
const last = new Map();
for (const line of lines) {
  for (const event of JSON.parse(line).commentary?.events ?? []) {
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    if (!first.has(event.kind)) first.set(event.kind, event.tick);
    last.set(event.kind, event.tick);
  }
}

const { tickStart, tickEnd } = header;
const at = (tick) => (tick === undefined ? null : (tick - tickStart) / (tickEnd - tickStart));
const show = (value) => (value === null ? 'MISSING' : value.toFixed(3));

const legacy = kinds.has('engagement');
const moments = legacy
  ? [['(legacy `engagement` schema — moments parsed from labels)', null]]
  : [
      ['searching  → the wide establishing beat', at(first.get('search-start'))],
      ['engage     → the push-in lands here', at(last.get('engage-start'))],
      ['spent      → the pair at rest', at(last.get('drive-satisfied'))],
      ['resumes    → the swing overhead starts', at(last.get('scene-all-searching'))],
    ];

const missingParts = PARTS.filter((shell) => !meshes.includes(shell));

console.log(`\n${file}`);
console.log(`ticks ${tickStart}–${tickEnd}  ·  ${(header.durationMs / 1000).toFixed(1)}s\n`);

console.log(`meshes named by the scene graph: ${meshes.length}`);
if (missingParts.length === 0) {
  console.log(`  every path in PARTS (${PARTS.length}) is named by this clip ✓`);
} else {
  console.log('  !! PARTS names paths this clip does not:');
  for (const part of missingParts) console.log(`     ${part}`);
  console.log('  The page suppresses MODEL_NOT_FOUND, so this fails SILENTLY:');
  console.log('  the part never loads and nothing says so. A missing shell means');
  console.log('  no bodies and a camera stuck on its opening shot; a missing lamp');
  console.log('  or mirror means the encounter plays with nothing to see.');
  console.log('  Fix PARTS + public/models/ + public/assets.json from this list:');
  for (const mesh of meshes) console.log(`     ${mesh}`);
}

// The lamps are matched by vertex count in `main.js` (PART_BY_VERTEX_COUNT),
// because the player exposes no id for a loaded group. A new revision of one of
// these meshes changes its count and silently falls back to flat paint.
console.log('\nvertex signatures (must match PART_BY_VERTEX_COUNT in src/main.js):');
for (const part of PARTS) {
  const path = new URL('../public/' + part, import.meta.url);
  let verts = 0;
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (line.startsWith('f ')) verts += (line.trim().split(/\s+/).length - 3) * 3;
    }
  } catch {
    console.log(`  ${'(not in public/models)'.padStart(9)}  ${part.split('/').pop()}`);
    continue;
  }
  console.log(`  ${String(verts).padStart(9)}  ${part.split('/').pop()}`);
}

console.log('\nthe moments the script hangs its stops on:');
for (const [label, value] of moments) console.log(`  ${label}: ${value === null ? '' : show(value)}`);
if (!legacy && moments.some(([, value]) => value === null)) {
  console.log('  A missing moment drops its caption and its stop. With no engagement,');
  console.log('  the close-up retargets to the whole piece and the camera moves lose');
  console.log('  their hold keyframes — it still runs, but reads flat.');
}

const females = snapshot.behavioral?.females;
const males = snapshot.behavioral?.males;
console.log('\ndrive readout (needs the unit tables on the snapshot):');
if (females && males) {
  console.log(`  ${females.length} females, ${males.length} males ✓`);
} else {
  console.log('  !! behavioral.females/males MISSING — the drive panel is dropped');
  console.log('     entirely. These carry forward, so a clip written without them');
  console.log('     plays perfectly and still loses the readout.');
}

console.log('\nevent kinds:', Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])));
console.log();
