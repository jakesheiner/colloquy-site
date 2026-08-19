import { defineConfig } from 'vite';
import { resolve } from 'path';
import { popmelt } from '@popmelt.com/core/vite';

// Two entry points: the scroll-driven story (index.html) and the standalone
// model / scene-graph viewer (viewer.html).
export default defineConfig({
  // Popmelt's annotation toolbar, for development only. The plugin starts the
  // bridge alongside `vite`, proxies `/popmelt` to it, and puts the bridge's
  // address on the page — so the dev script stays exactly as it was and the
  // port flags in `.claude/launch.json` keep working. The toolbar itself is
  // mounted by `src/popmelt.js`.
  plugins: [popmelt()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
});
