# Colloquy of Mobiles — explainer site

A scroll-driven explainer that plays back a real recording of the Colloquy of
Mobiles virtual simulation.

## How it works

The page does not animate anything itself. It embeds the Colloquy scene studio's
**clip player**, and hands it a recording. Every tick of that recording is a
complete state of every body. Page scroll is the playback clock, so scrolling
back runs the simulation backwards.

**Everything is served from this origin — nothing is fetched at runtime.** The
player lives at `public/vendor/colloquy-clip-player.js`, the recording at
`public/clips/`, and the meshes at `public/models/` (with `public/assets.json`
pointing at those local paths).

This used to import the player straight from the studio's site. That file is
unversioned, and when they reshaped what `getEvents()` returns, every scroll stop
on the page silently vanished — one scroll ran to the bottom and the captions
skipped to the end. The copy is pinned so nothing can change under the page.

To take a newer player: re-download it over `public/vendor/colloquy-clip-player.js`,
then check the stops still build (see *Reading the recording* below) before
committing.

```
# vendored 2026-08-11, sha256 891fdc166c009f9975791dbfecb652c03654dff6289ee81ad76726fda1e552f5
curl -o public/vendor/colloquy-clip-player.js \
  https://colloquyscenestudio.aroughidea.com/player-sample/colloquy-clip-player.js
```

API reference:
[`llms.txt`](https://colloquyscenestudio.aroughidea.com/player-sample/llms.txt).

### Reading the recording

The stops, the captions and the camera timing are all derived from the clip's
events, via `stateChanges` in `src/main.js`. The studio has shipped **two event
schemas** and that reader handles both, so a player swap in either direction does
not break the page:

| | `kind` | `label` |
|---|---|---|
| Original | `engagement` | `male_1: satisfaction-search → engaging-partner` |
| Current | `engage-start`, `search-start`, `drive-satisfied`, `scene-all-searching` | `male_1 → female_1 · drive O` |

If a future player changes it again, the symptom is the same: too few stops.
Check `stateChanges` is non-empty and that the anchors come out as
`[0, 0.22, 0.629, 0.756, 0.912, 1]` for the current clip.

Scrolling the pinned section seeks the recording, runs the camera through its
shot list, and advances the captions. The narrative toasts are **built from the
clip**, not authored — `src/main.js` asks the player which state changes it
detected in the recorded frames and writes one line per change.

## The camera

Three shots, in `SHOTS`: the classic three-quarter view of the whole piece, a
move in on the pair that is engaging, then up and over into plan view, held to
the end. Where the close-up lands and *who* it is of both come out of the
recording — the events name the units that left `engaging-partner`, and the
first of those transitions dates the end of the encounter — so the shot tracks
the drama rather than a hand-typed timecode. A clip in which nobody engages
falls back to holding the wide shot.

Each shot is *solved*, not typed: `solveShot` aims at the subject's projected
centre and fits the FOV to its projected extent, so the framing survives any
window shape.

**Solved once, then baked.** `bakeShots` runs when the bodies first arrive and
on resize, and after that the camera never reads the scene again. This matters
more than it sounds: measuring the framing *per frame* makes every shot a
function of whatever the bodies are doing, and they never stop moving, so the
aim and zoom drift and twitch under the camera the whole way through the pan.
Baking makes the move a pure function of scroll — the same scroll position
always gives exactly the same shot, and scrubbing back retraces it exactly.
Measured: zero camera drift across 200 ticks of simulation with the scroll held
still.

**The move between them is one curve, not a chain of segments.** Two things make
it read as a move rather than a zig-zag:

- Every shot is solved each frame and a single **monotone cubic** is fitted
  through all of them (`monotoneAt`). Easing each segment separately makes the
  path a polyline: speed drops to zero at each keyframe but the *direction*
  turns a corner there, which is what the eye reads as a jolt. Monotone rather
  than an ordinary spline because a plain one overshoots — it would swing the
  camera past the final overhead shot and back.
- Bearing, elevation and distance are interpolated and the **position rebuilt**
  from them, rather than interpolating the positions themselves. That, plus an
  `azimuth` that keeps turning one way through all three shots, makes the camera
  arc around the piece instead of running in along one line and back out along
  the same one.

Measured over the whole pin: sharpest direction change 5.4°, none above 20°,
median 1.0°. Before this it was a 44° corner at the close-up and a 110° reversal
at the plan view.

**The page drives its own frames, and there is no scroll listener.** `frame()`
polls the scroll position in `requestAnimationFrame`, seeks, and draws. This is
the fix for the camera stutter, and the reason is worth keeping: the player owns
its render loop and only draws when *it* decides to, which for a paused clip is
not once per frame. Scroll moves the camera every frame, so leaving the drawing
to the player left the camera holding still and then jumping. Two supporting
details — the camera reads the scroll position inside `applyFraming`, at draw
time, so whatever frame gets drawn matches where the page actually is; and
`lastDrawAt` suppresses a second draw if the player already drew this frame, so
the cost stays at one render per frame either way.

Measured across the whole pin at 17px steps: exactly 1.0 draws per frame, median
camera step 1.2 units, max 2.7, and the fastest values form a smooth plateau
through the swing rather than isolated spikes.

The `at` values are also a pacing decision, not just an order. The swing up
changes elevation, distance and subject at once, so it gets the widest span;
squeezed into a short one it travelled several times faster than the rest of the
pan and lurched under a mouse wheel.

## The look

The player normally draws the piece against near-black under a full instrument
rig: state rings on the plinth, drive gauges, orientation arrows, sensor cones,
node markers, a beam diagram. This page wants almost none of that — white ground,
bare bodies, magenta females, blue males. That is done in two halves:

- **Render options** (`RENDER_OPTIONS` in `src/main.js`) switch off every drawn
  overlay bar one. The full set of keys is larger than the module's exported
  defaults. `showIndicators` is deliberately **on**; see *The exchange* below.
- **The manifest** supplies URLs for the meshes in `PARTS` only. Everything else
  the clip names — armature, plinth, splodges, drive gauges, world base — is left
  unresolved on purpose, so it never draws. The player reports each as
  `MODEL_NOT_FOUND`, which is expected here. **Leaving a mesh out of `PARTS` is
  how it is hidden**, which is why `showIndicators` can be on without the gauges
  coming back: no geometry, nothing drawn.

Colours are assigned in `paintBodies()`.

### The exchange

The encounter is a light signal, so the parts that carry it are drawn: the male's
light-source ring and support, the female's mirror and armature, and her three
interior LEDs. Without them an engagement is two shapes hanging near each other.

- **The mirror** gets its own near-white, hard-specular finish (`MIRROR`) rather
  than the body colour — it is the one surface whose job is to *return* light.
- **The lamps** (his ring, her LEDs) are driven by `updateSignals()`, off the
  same per-unit state as the readout under the prose, so the lamp and the word
  "engaging" cannot disagree. Idle while hunting, full on contact. Her LEDs burn
  white and harder than his ring because they sit inside a shell that is already
  magenta and already emissive — a magenta core in a magenta body is invisible.
- The clip does **not** animate these itself. Measured: their emissive sits at
  black right through an engagement, which is why the page drives them.

**Identifying a loaded part is done by vertex count** (`PART_BY_VERTEX_COUNT` in
`src/main.js`). This is ugly and it is the only handle there is: every group the
player loads carries the same `assetLoadSource` string, the objects are unnamed,
and the scene-graph nodes that *do* have ids (`female_1__mirror`) own a
completely separate set of meshes — the two populations overlap by zero. Only the
female shells carry a hint, `shellKind`. So the geometry identifies itself; all
eleven counts are distinct. `node scripts/inspect-clip.mjs <clip>` prints them,
and a mesh revised in a new clip changes its count and falls back to flat paint.

The player's own rig — ambient 0.8 against a single 0.75 lamp — is right for
glowing instruments on black but flattens flat-coloured shells into
silhouettes, so `lightScene()` replaces it with a low ambient, a high key that
casts, and a softer fill. `addGround()` then puts a large white plane far below
the piece purely to catch the shadows.

The light levels in `LIGHTING` are **measured, not chosen**. The ground has to
clip to exactly the same white as the page or its horizon would cut across the
opening shot, which means `ambient + key·(k̂·ẑ) + fill·(f̂·ẑ) ≥ 1`. At the
committed values the lit ground reads 255 and a shadowed patch reads 167. Fill
alone sets how dark the shadow is, since a shadowed patch keeps ambient and fill
but loses the key. Change one and re-check the other two. (Three.js divides
light by π, which is why the numbers look larger than they should.)

## The asset manifest

A clip embeds its scene graph but no geometry — it names meshes by logical path
and expects the host to supply URLs. `public/assets.json` is that map. Without it
nothing draws at all.

It currently maps the eleven paths in `PARTS` to **local** files under
`public/models/`, so the page fetches nothing third-party.

⚠️ **`node scripts/build-asset-manifest.mjs` rewrites it with remote Supabase
URLs**, undoing that. It is still the way to *discover* URLs for a mesh the repo
does not have — it resolves paths against the studio's registry, which sends no
CORS headers and so cannot be called from the browser — but download what it
finds into `public/models/` and put local paths back in `assets.json`. That is
how the mirror and lamp meshes were added; each was verified against the sha256
in its content-addressed URL.

The script fails loudly if `PARTS` names a mesh the clip does not.

## What is in the recording

The page plays the studio's published capture, unedited. Worth knowing its
shape, because the page's prose is built around it: it opens *mid-encounter*.
Male II and Female A are already engaged at tick 0, and the minute is that
engagement coming apart — she lets go at 53%, he does at 76%, and all five spend
the rest searching. **Nowhere in it do two bodies find each other.**

The page reads that direction out of the clip rather than assuming it. It looks
for units *arriving* at `engaging-partner` and falls back to those *leaving* it,
and the close-up timing, the captions and the toasts all follow. So a clip that
runs the other way needs no code changes.

### Making the encounter build instead

`scripts/build-spliced-clip.mjs` writes a constructed clip in which it does, by
cutting two stretches of the real recording together — both playing forwards:

```
0–60%     nobody engaged: the pair searching, sweeping the space
60–100%   the pair engaged, held to the end
```

Every frame is a recorded frame and time runs forwards throughout: an edit, not
a fabrication. What it introduces is the cut. The script does not join the two
stretches end to end — it compares every candidate frame in one against every
candidate in the other and joins where the bodies sit closest, then prints the
cost (**16% of joint travel, 20× an ordinary tick** — about a second's worth of
movement) so it is measured rather than assumed. `ENGAGED_SHARE` decides how
late the encounter lands.

Two things it cannot avoid, and which the page has to say out loud if you use
it: the engagement *begins at a cut*, not through anything the simulation did;
and the cut is also where `env.beamActive` switches on, so it reads as the beam
finding the mirror — a reading that belongs to the edit.

To switch: run the script, point `CLIP_URL` at its output in
[`src/clip.js`](src/clip.js), re-run the manifest script, and add a note to
`index.html` saying the clip is an edit.

### Matching frames for the cut

Two things about the match metric, both learned by getting them wrong. Compare
`sense_position` only — where a joint *is*. Including `act_goal_position` pulls
the cut towards frames that merely intend the same thing, which is invisible,
and its ±60 swings drown out the positions that do show. And normalise each
joint by its own travel: they range from ±25 to ±60, so unnormalised the widest
ones decide the cut by themselves. Getting both wrong reported a "best" cut 53×
an ordinary tick; fixing them found one at 20×.

The search windows also have to be bounded. Let the cut fall anywhere and it
picks the first frame of the opening stretch — a perfect match to nothing,
because it discards the opening entirely.

### Writing the format

Worth recording, since it is not documented anywhere. A clip is a header line, a
`snapshot` line, then one `patch` per tick, with a full keyframe every 40. The
trap is `behavioral`: alongside the per-oscillator `frame.values` it carries
`males` / `females` (the id-to-label table), `beam`, and `env` — and `env` holds
`engaging` and `beamActive`. Those are only written when they change, so they
carry forward. Omit them and the clip still loads and plays perfectly while
`getEvents()` returns nothing and every body loses its name.

## Swapping in a new clip

The clip is named in exactly one place, [`src/clip.js`](src/clip.js), which both
the page and the manifest script import.

1. **Point `CLIP_URL` at the new recording.** Drop the
   `.colloquy-rec.ndjson.gz` file into `public/clips/` and use a root-relative
   path. A published studio URL also works, but costs the offline guarantee.
2. **Check the meshes resolve** — see the warning below. This is the step that
   actually goes wrong.
3. **Reload**, and confirm the stops came out.

### What adapts on its own

Everything downstream of the clip is derived rather than typed:

- **Timing.** Every moment goes through `progressOfTick`, which reads
  `tickStart`/`tickEnd` from the clip's own header. A longer, shorter or
  differently-paced recording needs no edit.
- **The captions and the scroll stops.** `SCRIPT` names *moments*, not
  positions; `scriptAt` drops any line whose moment the clip does not contain,
  and `buildAnchors` builds the snap points from the beats that survive. The
  text track and the stops re-point themselves together.
- **Which two bodies get the close-up.** `engagedPair` is read off the
  engagement event, not hardcoded.
- **The drive readout.** Unit names and levels come from the clip's own tables.
- **The framing**, measured from whatever geometry loads.

### What does not, and how it fails

**The meshes — this is the one that bites.** A clip embeds a scene graph naming
~25 meshes; `SHELLS` deliberately supplies only four (the shells and the beam),
and everything else is *meant* to 404 into `MODEL_NOT_FOUND`. So if a new clip
names differently-versioned shells (`female-shell-body-2604xx.obj`), the four
that matter fail exactly like the twenty-one that are supposed to — and
`onDiagnostic` in `src/main.js` **suppresses `MODEL_NOT_FOUND` wholesale**. No
bodies load, `bakeShots` returns false, and the camera never leaves its rough
starting shot. A blank-looking page with nothing in the console.

Do not fix this by re-running `scripts/build-asset-manifest.mjs`: it emits
*remote* Supabase URLs and would undo the localisation described under **How it
works**. Update `SHELLS`, put the new `.obj` files in `public/models/`, and hand-
write the four entries in `public/assets.json`.

**The intro copy** in `index.html` is written about this exact recording ("The
five begin spent… two thirds of the way down Female A and Male I catch each
other and hold"). Nothing updates it, and it quietly becomes untrue.

**A clip missing the four beats still runs, but flat.** If a recording has no
engagement *start* — the studio's original 60-second capture opens mid-encounter,
so it does not — then `engagedPair` is null, the close-up retargets to the whole
piece, and `panStartAt`/`panEndAt` stay null. The shots fall back to their
untuned defaults (0 / 0.4 / 0.88) *without* the `holdWide`/`holdCloseUp`
keyframes that keep each move inside one scroll step, so the camera drifts across
several stops instead of reading as a gesture. Likewise, a snapshot with no
`behavioral.females`/`males` tables silently drops the whole drive panel (see
**Gotchas**).

### Preflight

Before swapping, check the clip has what the page needs — the meshes it names,
the four moments, and the unit tables:

```bash
node scripts/inspect-clip.mjs public/clips/<new-clip>.ndjson.gz
```

For the current clip that reports meshes, the event kinds, moments at
0.22 / 0.629 / 0.756 / 0.804, and 3 females + 2 males.

## Entry points

| Path | What it is |
|---|---|
| `index.html` | the explainer (this page) |
| `viewer.html` | standalone scene-graph / OBJ part viewer, unrelated to playback |
| `scripts/inspect-clip.mjs` | preflight a clip before swapping it in (see above) |
| `scripts/build-asset-manifest.mjs` | regenerates `assets.json` with **remote** URLs — undoes the local-only setup |
| `scripts/build-spliced-clip.mjs` | builds a constructed clip (see *Making the encounter build instead*) |

## Gotchas

**Sizing.** The player creates its canvas inside the container you give it and
sizes it to fit. The container needs an **explicit height and `overflow:
hidden`** — with `aspect-ratio` alone the canvas grows the box, which grows the
canvas, until the drawing buffer hits the WebGL limit and the view goes blank.
See `.stage` in `src/style.css`.

**The player does not track its container.** Two separate symptoms, one cause.
It rewrites `camera.aspect` to a fixed value every frame, which squashes the
image horizontally by more than half in a portrait window; and it leaves the GL
viewport at whatever the container measured when it first started, so it draws
into a band of the canvas and letterboxes everything. Because this page drives
the view anyway, `applyFraming` sets both — from inside a wrapper around
`renderer.render`, the one place the player cannot clobber them.

**Looking straight down.** With `camera.up` left at world +Z, aiming the camera
down the Z axis is degenerate: the frame rolls and the aim-refine loop reads its
right/up vectors off a collapsing matrix. Each shot therefore carries an
explicit `up` derived from its own orbit, which stays well-conditioned at every
elevation including exactly overhead.

**Callback ordering.** `onState` / `onAssets` can fire *while*
`createClipPlayer` is still awaiting. Anything they touch must be reachable
before then: a `const` declared after the `await` is still in its temporal dead
zone, and meshes can arrive after the constructor resolves.

## Develop

```sh
npm install
npm run dev
npm run build
```
