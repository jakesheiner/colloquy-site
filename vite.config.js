import { defineConfig } from 'vite';
import { resolve } from 'path';

// Two entry points: the scroll-driven story (index.html) and the standalone
// model / scene-graph viewer (viewer.html).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
      },
    },
  },
});
