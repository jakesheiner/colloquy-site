import { publicUrl } from './base.js';

// The recording the page plays. This is the ONE place it is named: the page
// imports it to play, and the scripts in `scripts/` import it to work out which
// meshes it needs and to build from it.
//
// A clip is gzipped NDJSON, one line per simulation tick, with its own scene
// graph embedded. Published URLs are content-addressed, so a given URL is always
// the same recording. A local file works too — anything under `public/` can be
// named with a root-relative path.

/**
 * The studio's published 60-second capture — the page's previous recording.
 *
 * Worth knowing what shape it is: it opens *mid-encounter*. Male II and Female A
 * are already engaged at tick 0, and the minute is that engagement coming apart
 * — Female A lets go at 53%, Male II at 76%, and all five spend the rest
 * searching. No two bodies find each other anywhere in it.
 */
export const ORIGINAL_CLIP_URL =
  'https://patedfhqigpdipzbuqbd.supabase.co/storage/v1/object/public/colloquy-assets/' +
  'virtual-simulation-scenegraph/recordings/' +
  'sha256-CD2E3871B43C325D0070D1B781C8AEC5908309F127AF6382A392FDEAD6DF02D3/' +
  'display-capture-2026-07-28-23-36-59-t4842881-4844094.colloquy-rec.ndjson.gz';

/**
 * What the page plays: a 2m06s headless mint of the 260705 V1 baseline package
 * (2532 ticks at 20Hz, ticks 42–2573), served from `public/`.
 *
 * Note its own header says "240-minute sample" in `title` and `note`. That is
 * wrong, or at least is not the playable length — `tickCount` and `durationMs`
 * both say 126.55s and the player goes by those. Do not size anything off the
 * title.
 */
export const CLIP_URL = publicUrl('clips/new_clip.ndjson.gz');

/**
 * To play a constructed clip instead — one where the encounter builds towards
 * the end rather than dissolving in the middle — run
 * `node scripts/build-spliced-clip.mjs` and point CLIP_URL at its output:
 *
 *   export const CLIP_URL = '/clips/colloquy-encounter-built.colloquy-rec.ndjson.gz';
 *
 * Then re-run `node scripts/build-asset-manifest.mjs`. The page reads the
 * encounter's direction out of whichever clip it is given, so the close-up
 * timing and all the prose re-point themselves either way; the only thing to
 * add by hand is a note in `index.html` saying the clip is an edit.
 */

// Which meshes the page draws. Everything else the clip names — armature,
// plinth, splodges, drive gauges, world base — is left unresolved on purpose so
// it never draws. Leaving a mesh out of this list IS how it is hidden: the
// player asks for a URL, gets none, reports MODEL_NOT_FOUND and skips it. That
// matters for the indicators below, which are only visible because they are
// here; `showIndicators` is on, so anything indicator-shaped that we supply
// geometry for will draw.
//
// The manifest script fails loudly if a clip does not name one of these.
export const PARTS = [
  // The bodies themselves.
  'models/female-shell-body-260316.obj',
  'models/female-shell-head-260316.obj',
  'models/male-body-260316.obj',
  'models/beam-260316.obj',

  // The exchange. Everything below exists to make the encounter legible: the
  // male's lamp lights, its beam meets the female's mirror, and her interior
  // LEDs answer. The clip drives all of it — the ring and the LEDs are
  // `emissive-color` indicators, so they light themselves as the recording
  // plays and need no animation here. `paintBodies` in `main.js` deliberately
  // leaves these unpainted, or the flat colour would erase the signal.
  'models/male-lightsource-ring-260712b.obj',
  'models/male-lightsource-support.obj',
  'models/female-mirror-260703.obj',
  'models/female-mirror-armature-260703.obj',
  'models/female-interiorled-upper-260316.obj',
  'models/female-interiorled-middle-260316.obj',
  'models/female-interiorled-lower-260316.obj',
];
