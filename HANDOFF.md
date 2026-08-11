# Handoff — Colloquy of Mobiles explainer

Orientation for a fresh session. [`README.md`](README.md) has the full detail;
this is what to know before touching anything, and the things that cost real time
to discover.

---

## 1. What it is

A scroll-driven explainer for Pask's *Colloquy of Mobiles*. The page does not
animate anything itself: it embeds the Colloquy scene studio's **clip player**,
imported at runtime, and plays a published recording of the real simulation. Page
scroll is the playback clock and drives a three-shot camera move.

**No git repository.** There is no history and no undo — check before overwriting
anything you cannot regenerate.

---

## 2. Read these first, in this order

| File | Why |
|---|---|
| `src/clip.js` | 48 lines. Which recording plays, and which meshes are drawn. Start here. |
| `src/main.js` | 1014 lines. The whole page. Section markers: `--- look`, `--- camera`, `--- the text track`, `--- scroll`. |
| `src/style.css` | 312 lines. Full-bleed stage + the text track laid over it. |
| `README.md` | Architecture, the clip's contents, the format, the gotchas written out. |
| `index.html` | 67 lines. Intro panel + pinned stage. That is the whole page. |

Ignore `src/scene.js`, `src/viewer.js`, `viewer.html`, `NOTES-custom-models.md`
on a first pass — see §7.

---

## 3. What the page currently does

Intro panel, then one pinned section (`780vh`) that is the whole rest of the
page — **the scene ends the document, there is nothing after it.**

The stage is **full bleed**: it fills the viewport, edge to edge, no border, no
box. A single column of text beats lies *over* the scene on the right.

Camera runs three shots across the scroll:

```
0.00   three-quarter view of the whole piece   az -117  el 21  dist 250
0.40*  close on the engaged pair                az -148  el 17  dist 155
0.88   plan view, held to the end               az -196  el 90  dist 250
```

\* the middle `at` is overwritten at runtime from the recording — see §4.

Bodies are near-bare: magenta females, blue males and beam, on white, with cast
shadows. The exception is the exchange — the male's light-source ring, the
female's mirror and her interior LEDs are drawn too, and the lamps are lit from
the recording's own per-unit state so an engagement is visible as a signal rather
than as two shapes hanging near each other (README, *The exchange*). Every other
instrument layer the player normally draws (state rings, drive gauges,
orientation arrows, sensor cones, beam diagram) is off.

**The clip currently playing is the real published capture, unedited.** Its shape
matters, because the prose is built around it: it opens *mid-encounter*. Male II
and Female A are already engaged at tick 0 and the minute is that engagement
coming apart — she lets go at 53%, he does at 76%, all five then search. **Nowhere
in it do two bodies find each other.**

---

## 4. The page reads the clip, it does not assume it

Deliberate, and worth preserving. Nearly everything narrative is derived:

- **Which pair the close-up frames** — from the events, looking for units
  arriving at `engaging-partner`, falling back to those leaving it.
- **When the close-up happens** — `SHOTS[1].at` is overwritten from that moment.
- **Direction of the encounter** — `encounterBuilds` records whether it builds or
  comes apart, and the captions switch wording accordingly.
- **The beats** — one per detected state change, with simultaneous transitions
  merged into a single line.

So a different clip needs **no code changes**. `scripts/build-spliced-clip.mjs`
builds an alternative where the encounter *builds* towards the end (searching
0–60%, engaged 60–100%) by cutting two stretches of the real recording together;
point `CLIP_URL` at its output and re-run the manifest script. It was built, we
looked at it, and we reverted to the real recording.

---

## 5. Traps — the expensive ones

Each of these cost a real debugging cycle. They are all live in the code.

### The player does not track its container
It rewrites `camera.aspect` to a fixed `1.6` **every frame**, and leaves the GL
viewport at whatever the container measured on first start. Symptoms: image
squashed horizontally to `0.445` of correct in a portrait window, and drawing
confined to a band of the canvas. Both are fixed inside a wrapper around
`renderer.render`, which is the one point the player cannot clobber. Do not
remove that wrapper.

**Do not misread the distortion as geometry** — the female shells are broad conch
forms, not tall teardrops. I nearly "fixed" the wrong thing.

### The player does not render once per frame
For a paused clip it draws only when it decides to. A scroll-driven camera then
holds still and jumps. The page therefore has **no scroll listener at all**:
`frame()` polls scroll in `requestAnimationFrame`, seeks, and draws, with a
`lastDrawAt` guard so it skips its own draw if the player already drew. Keeps it
at exactly 1 render/frame.

### The camera must be baked, not measured per frame
`bakeShots` solves all three shots **once** (on load, and on resize) and after
that the camera never reads the scene again. An adaptive fit is right for
*choosing* a shot and poisonous as a per-frame function — the bodies never stop
moving, so aim and zoom drift and twitch continuously however smooth the path is.
Verified: zero camera drift over 200 ticks with the scroll held still.

### Multi-shot moves need one curve, and orbital parameters
Easing each segment separately makes the path a polyline: speed hits zero at each
keyframe but *direction* corners there, which reads as a zig-zag (measured 44°
and 110° turns). Fixed by fitting one **monotone cubic** through all keyframes
(a plain spline overshoots and swings past the final shot), rebuilding position
from interpolated azimuth/elevation/distance so the camera arcs, and duplicating
the last keyframe at progress 1 so it flattens into the hold. Now: sharpest turn
5.2°, none over 10°.

Also: looking straight down needs an **explicit `up`** derived from the orbit —
with `up` at world +Z a near-overhead `lookAt` is degenerate and the frame rolls.

### Lighting is calibrated, not chosen
The white shadow-catching ground has to clip to exactly the page white or its
horizon cuts across the opening shot: `ambient + key·(k̂·ẑ) + fill·(f̂·ẑ) ≥ 1`.
Three.js divides light by π, so the numbers look larger than they should. Lit
ground reads 255, shadowed 167. Fill alone sets shadow darkness. **Change one and
re-check the other two.**

### Full bleed means the camera must dodge the text
With the stage filling the window, centring the piece in the *window* runs the
bodies under the words (measured: right edge at 1669px on a 1280px window, column
starting at 768). `safeArea()` reads the region the text is *not* using from the
live layout and the fit frames into that. Wide shots now clear by ~110px. During
the close-up a body the camera isn't framing can still drift behind the text, so
`.beat p` carries a white `text-shadow` halo — invisible on white, a glow only
where something passes under.

### Writing a clip: `behavioral` is not just `frame`
It also carries `males`/`females` (the id→label table), `beam`, and `env` — and
`env` holds `engaging` and `beamActive`. They are written only when they change,
so they **carry forward**. A clip written without them **loads and plays
perfectly** while `getEvents()` returns `[]` and every body loses its name. Emit
them on every line; they gzip to nothing.

---

## 6. Commands

```sh
npm install
npm run dev        # vite; picks a free port
npm run build
npm run preview
```

```sh
node scripts/build-asset-manifest.mjs   # after ANY clip change
node scripts/build-spliced-clip.mjs     # optional constructed clip
```

`public/assets.json` maps the clip's logical mesh paths to the meshes. It now
points at **local** paths under `public/models/` (verified byte-identical to the
content-addressed remote copies they replaced — the sha256 in each old URL
matches the local file).

`scripts/build-asset-manifest.mjs` still resolves remote URLs from the studio's
registry, which sends **no CORS headers** — so it stays a build step run by hand,
never from the browser. Re-pointing the manifest at remote URLs would undo the
localisation below; if you re-run it, rewrite the output to local paths.

**The page makes no third-party requests.** The runtime (~940 KB) is vendored at
`public/vendor/colloquy-clip-player.js`, and the clip and meshes are in
`public/`. It still must be served over http — the module is fetched, so
`file://` will not work — but it will run with the network off.

Why it is vendored: the studio's copy is unversioned, and a change to what
`getEvents()` returns silently collapsed every scroll stop on the page. See the
README for the update procedure and the two event schemas `stateChanges` reads.

---

## 7. Loose ends

- **`src/scene.js` (1222 lines) is dead.** The hand-built approximation the site
  used before the player. Nothing imports it. Safe to delete.
- **`gsap` in `package.json` is unused** — the scroll scrubbing is the page's own.
  `three` is still needed by `src/viewer.js`.
- **`NOTES-custom-models.md` is obsolete** — it describes swapping primitives
  inside `scene.js`, an architecture that no longer exists.
- **`viewer.html` / `src/viewer.js` are still live** — a second Vite entry, a
  standalone scene-graph/OBJ part viewer. Unrelated to playback; leave alone.
- **Stale dev servers**: ports 5173–5178 have vite instances left from old
  sessions. Harmless, but why the port keeps drifting. `pkill -f vite` clears them.

---

## 8. Verifying anything visual

This environment **cannot screenshot a WebGL canvas** — the stage comes back pure
white while the DOM around it captures fine. Do not conclude the scene is broken
from a blank screenshot.

What works:

1. **Numbers first.** Project mesh corners with `camera.project()` and check NDC
   extents, camera position/fov, draws-per-frame. Most conclusions in this
   project were reached this way.
2. **For a real picture**, read the backbuffer and blit it into a plain 2D
   canvas, then screenshot that:
   ```js
   v.renderer.render(v.scene, v.camera);
   const gl = v.renderer.getContext();
   const px = new Uint8Array(w * h * 4);
   gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
   // putImageData into a 2D canvas, flip vertically (ctx.setTransform(1,0,0,-1,0,h))
   ```
3. **The preview pane runs hidden**, so `requestAnimationFrame` never fires and
   the page's whole loop is parked — nothing paints, nothing bakes. Forcing one
   screenshot pumps a single frame. To step it, patch `window.requestAnimationFrame`
   into a manual queue *after* pumping one real frame, or just call
   `renderer.render()` directly (the framing hook reads scroll at draw time, so
   an explicit render picks up the current position).
4. Screenshots can return a **stale canvas composite** even after an explicit
   render. This cost real time chasing a cropped-framing bug that did not exist.

---

## 9. If the user asks for the camera to change

The likely requests and where they live, all in `src/main.js`:

- **Shot order / timing** — `SHOTS`; `at` values are pacing decisions. The swing up
  has the widest span deliberately: squeezed, it travels several times faster
  than the rest and lurches under a mouse wheel.
- **How tight the framing is** — `CAMERA.margin`.
- **How much room the text gets** — `SAFE_GUTTER` and `safeArea()`.
- **Where the close-up lands** — `CLOSE_UP_LEAD` (it is offset from a moment read
  out of the clip, not typed).

Before concluding a camera problem is in the *path*, check what the camera
*reads* each frame and how often it is *drawn*. Two rounds were lost to fixing a
smooth curve that was never the problem.
