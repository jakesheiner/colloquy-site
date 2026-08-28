import { defineConfig } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'path';

// Two entry points: the scroll-driven story (index.html) and the standalone
// model / scene-graph viewer (viewer.html).
//
// `base` is normally `/`, because that is where dev and preview serve from.
// It is overridable so the same source can be built for a sub-path — the copy
// that lives inside the portfolio site is served from `/colloquy/`. Everything
// the page fetches at runtime (clip, meshes, scenes, the vendored player, the
// asset manifest) is written against `import.meta.env.BASE_URL`, so setting
// this is the only thing a re-host needs. See `npm run build:portfolio`.
const base = process.env.COLLOQUY_BASE || '/';

/**
 * `public/assets.json` is the mesh map the clip player fetches, and it names
 * meshes with root-relative URLs (`/models/…`). It is a static file, so nothing
 * in the source rewrites it — but under a sub-path host those URLs point at the
 * wrong origin root. Rewrite the built copy to match `base`. A no-op at `/`.
 */
function rebaseAssetManifest() {
  return {
    name: 'rebase-asset-manifest',
    apply: 'build',
    async closeBundle() {
      if (base === '/') return;
      const file = resolve(__dirname, 'dist/assets.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      for (const [key, url] of Object.entries(manifest)) {
        if (url.startsWith('/')) manifest[key] = base + url.slice(1);
      }
      await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}

export default defineConfig({
  base,
  plugins: [rebaseAssetManifest()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
});
