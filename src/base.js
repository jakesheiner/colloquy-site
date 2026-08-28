// Where this copy of the site is served from — `/` in dev, `/colloquy/` in the
// build that lives inside the portfolio site (see `COLLOQUY_BASE` in
// vite.config.js). Vite replaces `import.meta.env` at build time.
//
// Everything the page fetches by hand — the clip, the meshes, the scene JSON,
// the vendored player, the asset manifest — is written as `BASE + '…'` rather
// than as a root-relative path, so a sub-path host needs no other change.
//
// The `?.` matters: `src/clip.js` is also imported by
// `scripts/build-asset-manifest.mjs` under plain Node, where there is no
// `import.meta.env` at all. There the base falls back to `/`, which is what the
// script's own `public/`-relative reads expect.
export const BASE = import.meta.env?.BASE_URL ?? '/';

/** A runtime URL for a file served out of `public/`, e.g. `models/beam.obj`. */
export const publicUrl = (path) => BASE + path.replace(/^\//, '');
