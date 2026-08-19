/**
 * Popmelt's annotation toolbar, mounted for development only.
 *
 * The Vite plugin in `vite.config.js` is half of the installation: it starts
 * the bridge and writes its address onto the page. The other half is this — the
 * toolbar is a React component, and this site has no React in it, so there is a
 * React root here whose entire job is to hold that one component.
 *
 * It is kept to itself deliberately. Nothing the site does is React, and the
 * toolbar should be able to come and go without any of the site's own modules
 * knowing about it: `pages.js` imports this behind a `import.meta.env.DEV`
 * check, which Vite resolves to `false` for a build, so neither the provider
 * nor React reaches the production bundle.
 *
 * The mount point takes no space. This page's whole scroll is arithmetic —
 * `placeBeats()` measures the pinned section against the document — so a
 * devtool that added even a few pixels of page height would quietly move every
 * caption off its moment. Zero-sized and fixed, it cannot: whatever the toolbar
 * draws, it draws in its own fixed layer over the top.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PopmeltProvider } from '@popmelt.com/core';

const mount = document.createElement('div');
mount.id = 'popmelt-root';
mount.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;';
document.body.append(mount);

createRoot(mount).render(createElement(PopmeltProvider));
