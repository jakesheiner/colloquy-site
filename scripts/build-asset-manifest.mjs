// Builds public/assets.json — the map of logical mesh paths to public URLs that
// the clip player needs in order to draw the real bodies.
//
// A clip embeds its scene graph but no geometry: the graph names meshes by
// logical path (`models/female-shell-body-260316.obj`) and the player asks us
// for URLs. The registry endpoint that resolves those paths answers anonymously
// but sends no CORS headers, so it cannot be called from the browser — hence
// this build step, whose output is committed. Re-run it only when the clip
// changes:  node scripts/build-asset-manifest.mjs
//
// The storage bucket the resolved URLs point at *is* CORS-open, so the manifest
// works from any origin once it exists.

import { gunzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Both the clip and the shell list come from the page's own module, so there is
// one place to change when the recording changes.
import { CLIP_URL, PARTS } from '../src/clip.js';

const REGISTRY_URL =
  'https://colloquyscenestudio.aroughidea.com/api/asset-management/registry-check';

// Materials are assigned in `src/main.js` (magenta females, blue males), so the
// MTLs and their bitmaps are not fetched at all.
const TEXTURES = [];

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), '../public');

/**
 * The clip's bytes, from wherever CLIP_URL points. A root-relative path means a
 * file the page serves out of `public/`, which is how a clip that has not been
 * published to the studio is used.
 */
async function readClip(url) {
  if (/^https?:/.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`clip fetch failed: ${response.status} ${url}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(resolve(publicDir, url.replace(/^\//, '')));
}

/** Every `models/…` path the clip's embedded scene graph names. */
async function meshPathsFromClip(url) {
  const ndjson = gunzipSync(await readClip(url)).toString('utf8');
  // Line 2 is the first full state frame, which carries the scene graph.
  const frame = ndjson.split('\n')[1];
  const matches = frame.matchAll(/"(models\/[^"]+\.obj)"/g);
  return [...new Set([...matches].map((m) => m[1]))].sort();
}

async function resolvePaths(referencedPaths) {
  const response = await fetch(REGISTRY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'published', referencedPaths }),
  });
  if (!response.ok) throw new Error(`registry-check failed: ${response.status}`);
  const { assetRows = [] } = await response.json();
  return assetRows;
}

const named = await meshPathsFromClip(CLIP_URL);
// Guard against the shell list drifting away from the clip: a typo here would
// otherwise show up only as a body silently missing from the page.
const unknown = PARTS.filter((path) => !named.includes(path));
if (unknown.length > 0) {
  throw new Error(
    `PARTS names meshes this clip does not:\n  ${unknown.join('\n  ')}\n` +
      `This clip names:\n  ${named.join('\n  ')}\n` +
      'Update PARTS in src/clip.js to the matching names in that list.'
  );
}

const textures = TEXTURES.map((name) => `models/${name}`);
const rows = await resolvePaths([...PARTS, ...textures]);
const assets = Object.fromEntries(rows.map((row) => [row.logical_path, row.public_url]));

const sorted = Object.fromEntries(
  Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))
);

const outPath = resolve(publicDir, 'assets.json');
await writeFile(outPath, JSON.stringify(sorted, null, 2) + '\n');

console.log(`meshes named by clip: ${named.length}`);
console.log(`parts supplied: ${PARTS.filter((p) => p in assets).length}/${PARTS.length}`);
for (const path of PARTS.filter((p) => !(p in assets))) console.log(`  UNRESOLVED ${path}`);
console.log(`left out on purpose: ${named.length - PARTS.length}`);
console.log(`wrote ${outPath} (${Object.keys(assets).length} entries)`);
