import './style.css';
import { CLIP_URL } from './clip.js';
import { readDriveTrack } from './drives.js';

// The runtime is the Colloquy scene studio's own clip player (three.js inlined),
// vendored into `public/vendor/` and served from our own origin. It used to be
// imported straight from the studio's site — but that file is unversioned, and
// when they reshaped what `getEvents()` returns it silently broke every stop on
// the page. A local copy is pinned instead: nothing the studio ships can change
// under us, and updating is a deliberate act (re-download it and re-test).
//
// Vendored 2026-08-11 from
//   https://colloquyscenestudio.aroughidea.com/player-sample/colloquy-clip-player.js
// Reference + API: https://colloquyscenestudio.aroughidea.com/player-sample/llms.txt
//
// Resolved to a full same-origin URL at runtime, not written as a bare path, so
// the bundler leaves the dynamic import alone and serves the file verbatim — the
// way it already treated the studio's absolute URL. (A bare `/vendor/...` gets
// pulled through Vite's module transform, which trips over the Node-only
// `import("node:zlib")` fallback the browser path never reaches.)
const PLAYER_MODULE = new URL('/vendor/colloquy-clip-player.js', location.origin).href;

// The two figures, in two colours: magenta for the three females, blue for the
// males and the beam they ride.
const FEMALE = 0xe0189a;
const MALE = 0x3abff8;

// The player draws a full instrument rig over the piece — state rings on the
// plinth, drive gauges, orientation arrows, sensor cones, node markers, the beam
// diagram. This page wants the bare bodies, so nearly all of it is switched off.
//
// `showIndicators` is the exception. The male's light-source ring and the
// female's interior LEDs are indicator nodes, and they are the encounter: the
// ring lights when he transmits, her LEDs answer. Switching indicators off hid
// the exchange along with the instrumentation. It is safe to leave on because
// visibility is really controlled by geometry — the player can only draw an
// indicator we hand it a mesh for, and `PARTS` in `src/clip.js` supplies the
// ring and the LEDs and nothing else. The drive gauges stay dark twice over:
// no geometry, and `showDriveGauges` below.
const RENDER_OPTIONS = {
  showArmature: false,
  showPlinth: false,
  showIndicators: true,
  showNodes: false,
  showHelpers: false,
  showOscillatorHelpers: false,
  showBeamDiagram: false,
  showDriveGauges: false,
  showOrientationArrows: false,
  showPlinthEdgeDiagram: false,
  showPlinthEdgeHelper: false,
  showStateOverlay: false,
  showUnitLabels: false,
  showGridAndAxes: false,
  showSimOverlay: false,
  showCommentary: false,
  showReflectionOverlay: false,
  showDarkBackground: false,
  showExhibitLook: false,
  showLoadedGeometry: true,
  showShellBody: true,
  showShellHead: true,
};

// The scene is modelled Z-up in inches, so elevation is measured off the
// XY-plane and the camera orbits its subject.
const CAMERA = {
  // Breathing room around the subject once projected onto the frame. Multiplies
  // the fitted half-angle, so 1.04 pulls back 4% from a subject that exactly
  // fills its axis.
  //
  // It was 1.16, which together with the old SAFE_EDGE left the piece filling
  // about three quarters of the frame — fine when the scene was the whole page
  // and the slack read as air, awkward inside a drawn border, where it reads as
  // the picture not filling its box. The bodies swing, so this cannot go to 1:
  // the shots are baked against one pose and a body that swings outward after
  // the bake needs somewhere to go.
  margin: 1.04,
};

// The shot list, in the order the scroll plays them: the classic three-quarter
// view of the whole piece, a move in on the pair that is engaging, then up and
// over into plan view, held to the end. `at` is overall pin progress; the point
// the close-up lands on is derived from the recording (see `buildShots`), so it
// tracks the encounter rather than a hand-typed number.
//
// The swing up is by far the largest move — elevation, distance and subject all
// change at once — so it gets the most scroll to play out in. Cramming it into a
// short span makes the camera travel several times faster there than anywhere
// else, which lurches under a mouse wheel.
//
// `azimuth` keeps turning through the whole sequence. Without it the camera runs
// in along one bearing and back out along the same one, and the path has a hard
// corner at the close-up — it reads as a zig-zag however smoothly it is timed.
// Turning around the piece as it moves in and back out makes the same three
// shots one continuous arc.
// The bearing turns one way throughout. The middle value also has a job of its
// own: the engaged pair hang roughly along the y axis, so a bearing close to
// that axis puts one body behind the other. Swinging away from it separates them
// across the frame.
// Shots carry an `id` because the list is not fixed: a `hold` keyframe gets
// spliced in below, which would shift every index. Nothing may address a shot by
// position.
const SHOTS = [
  { id: 'wide', at: 0, azimuth: -117, elevation: 21, distance: 250, subject: 'piece' },
  { id: 'closeUp', at: 0.4, azimuth: -148, elevation: 17, distance: 155, subject: 'pair' },
  { id: 'plan', at: 0.88, azimuth: -196, elevation: 90, distance: 250, subject: 'piece' },
];

const shotById = (id) => SHOTS.find((shot) => shot.id === id);

// Neither shot carries an offset of its own any more: the close-up lands on the
// script line after the one that starts it moving, and the swing lands where
// `panEndAt` puts it. Every position comes off the stop grid.

// A four-light rig, with the levels chosen against two separate constraints.
//
// The shells have to *turn* — a flat colour on a white page reads as a sticker
// unless the light falls away across the form — so most of the energy sits in
// one key and the ambient is kept low. The ceiling on that is the bodies
// themselves: a face square-on to the key must land just under full colour
// (`ambient + key + fill·(n̂·f̂) < π`), because anything over clips and the
// gradient dies in a flat plateau exactly where the form is most legible.
//
// The ground is a white surface facing straight up whose only job is to catch
// shadows, and it has to burn out to the page white so its horizon never shows.
// Those two demands used to fight: saturating the ground needed more light than
// the bodies could take. `groundGain` separates them — the ground's albedo is
// over-bright, so it clips at ~0.74 of the light a white surface would need, and
// the rig is free to stay below the bodies' ceiling. What survives is the ratio:
// a shadowed patch keeps ambient, fill and rim but loses the key, so
// `(ambient + fill·(f̂·ẑ) + rim·(r̂·ẑ)) / (that + key·(k̂·ẑ))` alone decides how
// dark the shadow reads.
//
// Measured, not guessed: the ground reads 255 lit and 163 where the key is
// blocked. (Three.js divides light by π, which is why the numbers are larger
// than they look like they should be.)
//
// The overall softness of the picture is one dial: how much of the total sits in
// the key rather than in ambient+fill. Turning it down lifts the shadow towards
// the page and shortens the falloff across the shells; turning it up hardens
// both. 163 is a deliberately gentle setting.
const LIGHTING = {
  ambient: 0.45,
  key: 2.3,
  keyFrom: [95, -70, 200],
  fill: 0.9,
  fillFrom: [-130, 90, 70],
  // A grazing kicker from the far side, deliberately level with the piece: with
  // almost no z it rakes the silhouettes and puts a highlight on the far edge of
  // every shell without lifting the ground — so it buys shine for free, costing
  // the cast shadows nothing.
  rim: 1.0,
  rimFrom: [-150, 120, 8],
  // Bounce off the white floor. Everything here hangs, so in a real room the
  // undersides are lit from below; without it they go to a dead flat minimum.
  // Pointing up from underneath, it misses the ground plane entirely.
  bounce: 0.55,
  bounceFrom: [-20, 40, -150],
  // Well clear of the lowest body (z ≈ 27) so shadows read as cast, not contact.
  groundZ: -18,
  // How far past white the ground's albedo is pushed — see above.
  groundGain: 1.35,
};

// Shine. The OBJs arrive as MeshPhongMaterial, so the highlight is the
// specular/shininess pair, and the two families want opposite answers — because
// of their *shape*, not their finish.
//
// The shells are big smooth curves, so a broad soft lobe lands on them as a
// travelling sheen: only the part of the surface at the mirror angle lights up,
// and the falloff is the form. The males are flat plates, and a flat plate meets
// the mirror angle all at once, across its whole face. Give them the shells'
// lobe and there is a stretch of the scroll where 44% of the blue washes to
// near-white and the piece loses one of its two colours (measured; the plan-view
// approach is the worst of it). A tight lobe on a dim specular puts the
// highlight back to a streak along the beam and leaves the blue blue.
const SURFACE = {
  female: { shininess: 36, specular: 0x4e4e4e },
  male: { shininess: 120, specular: 0x424242 },
};

// The female's mirror — the thing a male's beam has to find. It is deliberately
// not her magenta: it is the one surface in the piece whose whole job is to
// *return* light, so it reads as near-white with a tight, hard highlight. Bright
// enough to catch the eye in the close-up, not so bright it burns out against
// the white page.
const MIRROR = { color: 0xdfe4ea, specular: 0xf0f0f0, shininess: 220 };

/**
 * The lamps: the male's light-source ring and the female's interior LEDs.
 *
 * The scene graph calls these `emissive-color` indicators and gives the ring an
 * `emissiveMin` of 0.25 — idling dim, full when it fires. The player does not
 * animate them for us (measured: their emissive sits at black right through an
 * engagement), so the page drives them, off the same per-unit state the readout
 * under the prose is already reading. One source, so the lamp and the word
 * "engaging" can never disagree.
 *
 * `idle` is what a body shows while it is hunting; `lit` is contact. The colours
 * are each side's own, so it stays legible whose signal is whose.
 */
// Her lamps burn white, not magenta, and burn harder than his. Both are for the
// same reason: they sit *inside* a shell that is already magenta and already
// emissive, and a magenta core inside a magenta body is invisible — tried, it
// read as a slightly paler patch. White gives the one hue the shell cannot
// cancel, and the extra intensity is what carries it out through the opacity.
// His ring is bare on a blue plate with nothing in front of it, so it needs
// neither.
const SIGNAL = {
  female: { color: 0xffffff, emissive: 0xffffff, idle: 0.15, lit: 2.4 },
  male: { color: 0xffffff, emissive: 0xffffff, idle: 0.25, lit: 1.4 },
};

// The females are lit from within and slightly see-through. Males are neither.
//
// **The glow has to live on the shells themselves — a halo cannot work on this
// page.** A halo reads by adding light to what is behind it, and what is behind
// everything here is already pure white, so any aura in the air around a shell
// is arithmetically invisible. (An additive pass would be a no-op; a normal-
// blended one would darken the page into a pink fog, which is haze, not glow.)
// So the glow is emissive on the material: the shell goes luminous, brightest
// where the light rig leaves off, which is exactly how a lit-from-inside object
// behaves.
//
// The cost is honest and worth knowing: emissive is added flat, so it lifts the
// shadow side more than the lit side and takes some of the modelling back out —
// the shell's lit:unlit ratio goes 2.02 → 1.71 at this level. That is the trade
// glow always makes; it is kept low so the forms still turn.
//
// `side` stays DoubleSide (as loaded). Switching to FrontSide would kill the
// self-blending inside the form, but it also punches the shells' cavities
// through to white — the mirror recess becomes a hole — because the surface you
// see in there *is* a back face. What shows through the shell instead is its own
// internal structure, which is real geometry, not a sorting artifact.
const GLOW = {
  // 0.80 is the point where the plate behind a shell reads through it. Above
  // ~0.84 the translucency is imperceptible; below ~0.6 the forms start to
  // dissolve and the internal geometry turns to noise.
  opacity: 0.8,
  // Kept on so the shell does not blend against its own far side, which is
  // order-dependent per triangle and would shimmer as the bodies turn.
  depthWrite: true,
  emissive: 0xff4fb0,
  emissiveIntensity: 0.11,
};

const stage = document.getElementById('stage');
const errorEl = document.getElementById('stage-error');
// The track the captions are laid down; it scrolls past the held frame.
const beatsEl = document.getElementById('beats');
// The band under the frame, in the sticky column, so the readout stays with the
// picture it belongs to rather than scrolling away with the words.
const driveSlot = document.getElementById('drive-slot');
const pinSection = document.getElementById('pin-section');

function fail(message) {
  errorEl.textContent = message;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through the keyframes.
 *
 * Interpolating each segment on its own and easing within it gives a path that
 * is a polyline through the keyframes: speed reaches zero at each one, but the
 * *direction* turns a corner there, which is what makes a camera move read as a
 * zig-zag. Fitting one curve through all of them makes velocity continuous, and
 * the monotone limiter keeps it from overshooting — an ordinary spline would
 * swing the camera past the final overhead shot and back.
 *
 * Slope is forced to zero at a local extreme, which is exactly right here: the
 * distance dips to its closest at the middle shot and rises again, so the camera
 * eases through the nearest point instead of hitting it and rebounding.
 */
function monotoneAt(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];

  const secant = [];
  for (let i = 0; i < n - 1; i++) secant.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));

  const slope = new Array(n);
  slope[0] = secant[0];
  slope[n - 1] = secant[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (secant[i - 1] * secant[i] <= 0) {
      slope[i] = 0;
    } else {
      const a = 2 * (xs[i + 1] - xs[i]) + (xs[i] - xs[i - 1]);
      const b = (xs[i + 1] - xs[i]) + 2 * (xs[i] - xs[i - 1]);
      slope[i] = (a + b) / (a / secant[i - 1] + b / secant[i]);
    }
  }

  let k = 0;
  while (k < n - 2 && x > xs[k + 1]) k += 1;
  const h = xs[k + 1] - xs[k];
  const t = (x - xs[k]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * ys[k] +
    (t3 - 2 * t2 + t) * h * slope[k] +
    (-2 * t3 + 3 * t2) * ys[k + 1] +
    (t3 - t2) * h * slope[k + 1]
  );
}

// Assigned once the player resolves. Callbacks can fire *while* the constructor
// is still awaiting, so anything they touch has to be reachable before then —
// a `const` declared after the await is still in its temporal dead zone.
let viewer = null;
// The module inlines three.js and exports no constructors, so they are borrowed
// off objects the player has already built.
let Vec = null;

/**
 * Which part a loaded OBJ group is, by total vertex count.
 *
 * This is a signature, and it is ugly, and it is the only handle there is. The
 * player tells us nothing about what it just loaded: every group carries the
 * same `assetLoadSource` string, the objects are unnamed, and the scene-graph
 * nodes that *do* have ids (`female_1__mirror`) own a completely separate set of
 * meshes — measured, the two populations overlap by zero. Only the female shells
 * carry a hint, `shellKind`.
 *
 * So the geometry identifies itself. Counts are the non-indexed vertex totals
 * three.js builds from each OBJ (`(n-2)*3` per face), all eleven distinct, and
 * verified against the running scene. If a clip swaps a mesh for a new revision
 * this map goes stale — the part then falls through to the flat paint, which is
 * the old behaviour and not a crash.
 *
 * `side` is which body it belongs to. `treat` is how to finish it:
 *   flat   — the body colour, as everything used to be
 *   signal — do not touch. These are the `emissive-color` indicators the clip
 *            drives; the male's ring lights when he transmits and the female's
 *            LEDs answer. Painting them clones the material out from under the
 *            player and the exchange goes dark, which is exactly what used to
 *            happen when they were switched off entirely.
 *   mirror — near-white and hard-specular, so it reads as the reflector the
 *            beam has to find rather than as another magenta shell.
 */
const PART_BY_VERTEX_COUNT = new Map([
  [7038, { name: 'female shell body', side: 'female', treat: 'flat' }],
  [4119, { name: 'female shell head', side: 'female', treat: 'flat' }],
  [6147, { name: 'male body', side: 'male', treat: 'flat' }],
  [1887, { name: 'beam', side: 'male', treat: 'flat' }],
  [948, { name: 'male lightsource support', side: 'male', treat: 'flat' }],
  [204, { name: 'female mirror armature', side: 'female', treat: 'flat' }],
  [108, { name: 'female mirror', side: 'female', treat: 'mirror' }],
  [147, { name: 'male lightsource ring', side: 'male', treat: 'signal' }],
  // `whileEngaged` — drawn only for a body that is actually engaged, and hidden
  // outright otherwise. Not a look decision, a cost one: her three LED meshes are
  // ~3,100 triangles *each female*, which measured as 90% of everything the
  // exchange added (63 → 100 draw calls, 15.9k → 26.3k triangles at the
  // close-up). Idling them for five bodies across the whole scroll bought a dim
  // glow inside an opaque-from-outside shell and cost that every frame. Lit only
  // on contact, the geometry exists for the seconds it is the thing being looked
  // at. His ring is 49 triangles, so it idles for free and is not gated.
  [1344, { name: 'female interior LED upper', side: 'female', treat: 'signal', whileEngaged: true }],
  [4992, { name: 'female interior LED middle', side: 'female', treat: 'signal', whileEngaged: true }],
  [3024, { name: 'female interior LED lower', side: 'female', treat: 'signal', whileEngaged: true }],
]);

/** The signature of one loaded group: every mesh under it, added up. */
function vertexSignature(group) {
  let total = 0;
  group.traverse((mesh) => {
    if (mesh.isMesh) total += mesh.geometry.attributes.position.count;
  });
  return total;
}

/**
 * Paint the loaded geometry. A group holding meshes from an OBJ carries
 * `assetLoadSource`; what that group *is* comes from `PART_BY_VERTEX_COUNT`,
 * falling back to `shellKind` ('body' / 'head') for the shells.
 */
function paintBodies() {
  if (!viewer) return 0;
  let painted = 0;
  viewer.scene.traverse((object) => {
    if (object.userData?.assetLoadSource === undefined) return;

    const part = PART_BY_VERTEX_COUNT.get(vertexSignature(object));
    const female = part ? part.side === 'female' : object.userData.shellKind !== undefined;

    // The lamps. Given their own material and then left to `updateSignals`,
    // which sets how hard they burn from the recording's own state.
    if (part?.treat === 'signal') {
      const tone = female ? SIGNAL.female : SIGNAL.male;
      // Starts hidden if it is only drawn while engaged: nobody is at the moment
      // the geometry arrives, and `updateSignals` only writes on a change.
      //
      // Once only. This function is polled every frame, so setting `visible`
      // here unconditionally re-hid the lamps on every frame and stamped on
      // `updateSignals` — they never lit at all.
      if (part.whileEngaged && !object.userData.signalReady) object.visible = false;
      object.userData.signalReady = true;
      object.traverse((child) => {
        if (!child.isMesh || child.userData.painted) return;
        child.userData.painted = true;
        child.material = child.material.clone();
        child.material.color.setHex(tone.color);
        child.material.emissive?.setHex(tone.emissive);
        child.material.emissiveIntensity = tone.idle;
        child.material.transparent = false;
        child.material.opacity = 1;
        child.material.depthWrite = true;
        child.material.needsUpdate = true;
        // A lamp is a light, not an occluder: casting from inside a translucent
        // shell just prints a hard blob on her own flank.
        child.castShadow = false;
        child.receiveShadow = false;
        painted++;
      });
      return;
    }

    const colour = female ? FEMALE : MALE;
    const surface = female ? SURFACE.female : SURFACE.male;
    object.traverse((child) => {
      if (!child.isMesh || child.userData.painted) return;
      child.userData.painted = true;

      if (part?.treat === 'mirror') {
        child.material = child.material.clone();
        child.material.color.setHex(MIRROR.color);
        child.material.specular?.setHex(MIRROR.specular);
        child.material.shininess = MIRROR.shininess;
        child.material.emissive?.setHex(0x000000);
        child.material.emissiveIntensity = 0;
        child.material.transparent = false;
        child.material.opacity = 1;
        child.material.depthWrite = true;
        child.material.needsUpdate = true;
        child.castShadow = true;
        child.receiveShadow = false;
        painted++;
        return;
      }

      // Each mesh gets its own material so a shared one cannot leak a colour
      // across bodies.
      child.material = child.material.clone();
      child.material.color.setHex(colour);
      child.material.shininess = surface.shininess;
      child.material.specular?.setHex(surface.specular);
      // Females glow and let a little light through; males stay solid and dark
      // — the form there comes from the rig alone. See GLOW.
      child.material.emissive?.setHex(female ? GLOW.emissive : 0x000000);
      child.material.emissiveIntensity = female ? GLOW.emissiveIntensity : 0;
      child.material.transparent = female;
      child.material.opacity = female ? GLOW.opacity : 1;
      child.material.depthWrite = female ? GLOW.depthWrite : true;
      child.material.needsUpdate = true;

      // Everything casts. Only the shells *receive*, and that asymmetry is not a
      // taste call — it is the shadow map's resolution. One map covers the whole
      // piece, so a texel is a quarter of an inch. A shell is forty inches of
      // smooth curve, and its head landing on its shoulder resolves beautifully;
      // the males are thin plates studded with inch-scale fins and fittings, and
      // those cast onto their own plate as hard-edged blocks that look nothing
      // like the thing casting them. On the plan-view shot, where the bar turns
      // broadside, it reads as blotches crawling over the bar as it spins.
      // Nothing is lost by switching it off: the males ride above everything
      // else, so almost nothing was ever going to fall on them.
      child.castShadow = true;
      child.receiveShadow = female;
      painted++;
    });
  });
  if (painted > 0) {
    assignBodiesToUnits();
    addGround();
  }
  return painted;
}

// Each loaded OBJ group, tagged with the unit it belongs to. The scene graph
// gives the geometry no unit-named ancestor, so this is worked out by position:
// a body group sits within a couple of inches of its unit's nodes, while the
// beam sits ~23in from either male and ends up tagged null.
const bodies = [];
const UNIT_RADIUS = 10;

/** World position of each unit, averaged over its own scene-graph nodes. */
function unitAnchors() {
  const totals = new Map();
  const at = new Vec();
  viewer.scene.traverse((object) => {
    const id = object.userData?.entry?.node?.id;
    const unit = id && /^(female_\d+|male_\d+)__/.exec(id);
    if (!unit) return;
    object.getWorldPosition(at);
    const acc = totals.get(unit[1]) ?? { n: 0, x: 0, y: 0, z: 0 };
    acc.n += 1;
    acc.x += at.x;
    acc.y += at.y;
    acc.z += at.z;
    totals.set(unit[1], acc);
  });
  return [...totals].map(([unit, a]) => ({ unit, x: a.x / a.n, y: a.y / a.n }));
}

function assignBodiesToUnits() {
  const anchors = unitAnchors();
  if (anchors.length === 0) return;
  bodies.length = 0;
  const at = new Vec();
  viewer.scene.traverse((group) => {
    if (group.userData?.assetLoadSource === undefined) return;
    group.getWorldPosition(at);
    let best = null;
    let bestDistance = Infinity;
    for (const anchor of anchors) {
      const distance = Math.hypot(at.x - anchor.x, at.y - anchor.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = anchor.unit;
      }
    }
    bodies.push({
      group,
      unit: bestDistance <= UNIT_RADIUS ? best : null,
      part: PART_BY_VERTEX_COUNT.get(vertexSignature(group)) ?? null,
    });
  });
}

// Reused so a per-frame fit does not allocate 500 vectors every time.
const cornerPool = [];
let cornerCount = 0;

function pushCorner(x, y, z, matrix) {
  const vector = cornerPool[cornerCount] ?? (cornerPool[cornerCount] = new Vec());
  vector.set(x, y, z).applyMatrix4(matrix);
  cornerCount += 1;
}

/**
 * Live world-space corners of the bodies a shot frames, as a view onto the pool.
 *
 * Corners of each body's own box rather than one box around everything: a single
 * box around five bodies hung across a wide triangle is mostly empty air, and
 * framing to it leaves the piece small in the middle. Recomputed per frame so
 * the close-up tracks the pair as they move.
 */
function subjectCorners(units) {
  cornerCount = 0;
  for (const body of bodies) {
    if (units && !units.includes(body.unit)) continue;
    body.group.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.userData.painted) return;
      mesh.updateWorldMatrix(true, false);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            pushCorner(x, y, z, mesh.matrixWorld);
          }
        }
      }
    });
  }
  return cornerCount;
}

let mod;
try {
  mod = await import(/* @vite-ignore */ PLAYER_MODULE);
} catch (error) {
  fail(`Could not load the player: ${error.message}`);
  throw error;
}

const player = await mod.createClipPlayer({
  container: stage,
  clipUrl: CLIP_URL,
  // Local paths for the meshes in `PARTS` — the bodies, and the lamps and mirror
  // that carry the encounter. Everything else the clip names (armature, plinth,
  // splodges, drive gauges, world base) is deliberately absent from the map and
  // reports MODEL_NOT_FOUND, which is how it stays undrawn.
  assetManifestUrl: '/assets.json',
  viewConfig: {
    kind: 'view',
    name: 'Colloquy explainer',
    // A rough starting shot only, in the piece's own units. `applyFraming`
    // takes the camera over before the first draw, once the bodies have loaded
    // and the shots can be solved against them.
    camera: { origin: { x: -105, y: -190, z: 155 }, target: { x: 0, y: 15, z: 64 }, fov: 45 },
    clipping: { near: 0.1, far: 5000 },
  },
  renderOptions: RENDER_OPTIONS,
  // Scroll owns the playhead, so don't start a clock we are about to fight.
  autoplay: false,
  loop: false,
  // Meshes can arrive after the constructor settles, and an unpainted one would
  // render in its loader default grey.
  onAssets: () => paintBodies(),
  onDiagnostic: (diagnostic) => {
    // Everything outside the shell set is left out on purpose; anything else is
    // worth hearing about.
    if (diagnostic.code !== 'MODEL_NOT_FOUND') {
      console.warn(`[clip] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
    }
  },
}).catch((error) => {
  fail(`Could not start the player: ${error.message}`);
  throw error;
});

const { playback } = player.getStatus();
viewer = player.viewer;
Vec = viewer.camera.position.constructor;

const progressOfTick = (tick) =>
  (tick - playback.tickStart) / (playback.tickEnd - playback.tickStart);

// The three behavioural states the script and the camera timing are hung off.
// Declared above `stateChanges` because that reader now folds events onto them.
const SEARCHING = 'satisfaction-search';
const ENGAGED = 'engaging-partner';
const SPENT = 'satisfied-and-indifferent';

/**
 * Every state change in the recording, as `{ tick, id, to }`, in order.
 *
 * Read once and shared, because two separate things are built off it and they
 * have to agree: the script, and the camera timing. The script's moments *are*
 * the stops, and every camera move has to start on one stop and end on the next,
 * so a second, slightly different reading of the same events would put the moves
 * a hair off the stops they are supposed to sit between.
 *
 * The studio's player has shipped two event schemas, and this reads both so the
 * page survives it switching between them:
 *   - Original: one `engagement` event per transition, labelled
 *     `male_1: <from> → <to>`.
 *   - Current: semantic events whose *kind* is the state — `search-start`,
 *     `engage-start`, `drive-satisfied`, `scene-all-searching` — labelled
 *     `body · drive`, or `male → female · drive` for an engagement.
 */
const stateChanges = (() => {
  const out = [];
  const add = (tick, id, to) => { if (/^\w+_\d+$/.test(id)) out.push({ tick, id, to }); };
  for (const event of player.getEvents()) {
    const label = event.label ?? '';

    // Original schema: an explicit `from → to` carried on one `engagement` event.
    const legacy = /^(\w+_\d+): (.+) → (.+)$/.exec(label);
    if (event.kind === 'engagement' && legacy) {
      out.push({ tick: event.tick, id: legacy[1], to: legacy[3] });
      continue;
    }

    // Current schema: the state is the event kind; the body is the head of the
    // label, before the ` · drive` suffix.
    const head = label.split(' · ')[0].trim();
    switch (event.kind) {
      case 'search-start':
        add(event.tick, head, SEARCHING);
        break;
      case 'scene-all-searching':
        // The whole piece back to searching — the last searching moment, which
        // the swing overhead is hung off. It names no single body, so it is
        // tagged `scene`; only `lastInto` ever reads it.
        out.push({ tick: event.tick, id: 'scene', to: SEARCHING });
        break;
      case 'drive-satisfied':
        add(event.tick, head, SPENT);
        break;
      case 'engage-start': {
        const pair = /^(\w+_\d+)\s*→\s*(\w+_\d+)$/.exec(head);
        if (pair) { add(event.tick, pair[1], ENGAGED); add(event.tick, pair[2], ENGAGED); }
        break;
      }
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
})();

/** The first / last tick at which anything enters `state`, or null. */
const firstInto = (state) => stateChanges.find((c) => c.to === state)?.tick ?? null;
const lastInto = (state) => {
  for (let i = stateChanges.length - 1; i >= 0; i--) if (stateChanges[i].to === state) return stateChanges[i].tick;
  return null;
};

/**
 * The script, in order: what the reader stops on and what it says there.
 *
 * Each line names the moment it describes rather than a position, so the whole
 * track re-points itself at a different recording instead of quietly going out of
 * step with it. A line whose moment a clip does not contain drops out rather than
 * appearing somewhere approximate.
 *
 * `The end.` is the exception — it has no moment in the recording, and is pinned
 * to where the swing overhead lands (see `panEndAt`).
 */
const SCRIPT = [
  {
    tick: () => playback.tickStart,
    headline: 'The sculpture',
    blocks: [
      { voice: 'model', text: 'Colloquy is a kinetic sculpture, a large mobile hanging from the ceiling, consisting of five figures.' },
      { voice: 'model', text: 'Pask labeled three figures “female” and two “male”. His language and allusions are dated and sexist.' },
      { voice: 'party', text: 'The sculpture can represent people interacting at a party. Their conversations have a beginning, a middle, and an end.' },
      { voice: 'model', text: 'At any moment, each mobile is in one of three possible states: resting, searching, or conversing.' },
    ],
  },
  {
    // No moment in the recording — this one introduces the metaphor rather than
    // describing anything the clip does, so it is placed by hand. It and
    // `Starting up` divide the long stretch before the drives cross their
    // threshold into even thirds with the opening section.
    at: 0.073,
    soft: true,
    headline: 'The sculpture represents a party',
    blocks: [
      { voice: 'party', text: 'A party has people. Guests show up, to mingle, eat, drink, and socialize.' },
      { voice: 'model', text: 'Five agents hang from the mobile. Each can move independently, communicate, and affect the others.' },
      { voice: 'party', text: 'Guests arrive with interests, and a growing desire to share them.' },
      { voice: 'model', text: 'Every agent has two drive states — Orange and Puce — which grow over time.' },
    ],
  },
  {
    // Also placed by hand: the clip opens with everything already at rest, so
    // there is no event marking the start — the moment this describes is the
    // stretch before the drives cross, not a transition into it.
    at: 0.146,
    soft: true,
    headline: 'Starting up',
    blocks: [
      { voice: 'model', text: 'When the model starts up, all figures are resting, and their drives begin to climb.' },
      { voice: 'party', text: 'Guests arrive, and the room starts to fill.' },
    ],
  },
  {
    tick: () => firstInto(SEARCHING),
    headline: 'Searching',
    blocks: [
      { voice: 'model', text: 'Once their drives cross the threshold, all five begin searching.' },
      { voice: 'model', text: 'The females rotate on their axis; the males spin the bar.' },
      { voice: 'party', text: 'At first, everyone mingles — working the room, putting yourself out there.' },
    ],
  },
  {
    tick: () => lastInto(ENGAGED),
    headline: 'As people get comfortable, individual conversations emerge',
    blocks: [
      { voice: 'model', text: 'A signal is received, and reciprocated.' },
      { voice: 'party', text: 'Two guests catch each other’s eye.' },
      { voice: 'model', text: 'The male emits a beam, the female reflects it back, and both drives drop, entering the resting phase.' },
      { voice: 'party', text: 'A connection is made, and the conversation flows.' },
    ],
  },
  {
    tick: () => lastInto(SPENT),
    headline: 'Returning to the party',
    blocks: [
      { voice: 'model', text: 'After briefly resting, the agents return to searching.' },
      { voice: 'party', text: 'Guests drift back to the main room.' },
    ],
  },
  // The closing headline has no moment of its own either — it is pinned to where
  // the swing overhead lands, and it is added once `panEndAt` is known (see the
  // sections block below).
];

/** The last headline, held to the end of the pin. No body under it. */
const CLOSING_HEADLINE =
  'The mobiles continue this dance — rotating, sending signals, and shifting ' +
  'between paired-off conversations and the main party';

/**
 * The script's moments as pin progress, ascending and strictly increasing.
 *
 * Strictly increasing matters: this doubles as the grid the camera moves between,
 * and two stops in the same place is one the reader cannot leave in a single
 * gesture. A line that would not advance is dropped.
 */
const scriptAt = (() => {
  const out = [];
  for (const line of SCRIPT) {
    // A section either names a moment in the recording or, where it is talking
    // about the piece rather than reporting something the clip does, gives its
    // own position.
    let at;
    if (line.at !== undefined) {
      at = clamp01(line.at);
    } else {
      const tick = line.tick();
      if (tick === null) continue;
      at = clamp01(progressOfTick(tick));
    }
    if (out.length > 0 && at <= out[out.length - 1].at + 1e-6) continue;
    out.push({ at, line });
  }
  return out;
})();

// Where the push-in starts, and where the swing overhead starts and lands. All
// three are script moments, because a camera move has to begin on one stop and
// be over by the next — see the note in the block below.
let moveStart = null;
let panStartAt = null;
let panEndAt = null;

const engagedPair = (() => {
  const engagedIds = [...new Set(stateChanges.filter((c) => c.to === ENGAGED).map((c) => c.id))];
  const female = engagedIds.find((id) => id.startsWith('female'));
  const male = engagedIds.find((id) => id.startsWith('male'));
  if (!female || !male) return null;

  const wide = shotById('wide');
  const closeUp = shotById('closeUp');
  const plan = shotById('plan');

  /**
   * Run each camera move between two script moments, and hold it still between.
   *
   * The page used to step from moment to moment, and this existed so a move
   * could not be taken in three goes with a pause inside each. The scroll is
   * free now, but the shape is still right: a move that runs the whole length of
   * the pin never reads as a move, it reads as drift. Tying each one to the
   * stretch between two moments keeps it a gesture with a beginning and an end,
   * and ties it to the line the reader is passing while it happens.
   *
   * The stretches between are made to *hold* by repeating the previous shot at
   * the moment the move starts, which forces the interpolator's slope to zero on
   * both sides of the repeat.
   *
   * The grid is the script's own moments, not the raw events: those are what the
   * lines on the track are placed against, and a keyframe on anything else drifts
   * away from the words describing it.
   */
  const grid = scriptAt.map((entry) => entry.at);
  const atTick = (tick) => (tick === null ? null : clamp01(progressOfTick(tick)));
  // The nearest moment below `at`, or null if there is none.
  const prevStopBefore = (at) => {
    let out = null;
    for (const stop of grid) {
      if (stop < at - 1e-6) out = stop;
      else break;
    }
    return out;
  };

  // The push-in is one scroll step long — the long "searching" step that ends
  // where they engage. Catching each other's eye and engaging used to be two
  // stops a sliver apart, which crammed the move into that tiny gap; they are one
  // stop now, so the move begins on the stop before it (the drives-cross-threshold
  // line) and is fully in by the engage line, riding that long searching step for
  // a slow, comfortable zoom.
  //
  // `HOLD_WIDE_FRACTION` can hold the wide shot across the front of the step
  // before the move begins — raise it toward 1 to keep a wide establishing view
  // on the searching beat and shorten the zoom. At 0 the move takes the whole
  // step.
  const HOLD_WIDE_FRACTION = 0;
  const engagesAt = atTick(lastInto(ENGAGED));
  const stepStart = engagesAt === null ? null : prevStopBefore(engagesAt);
  if (engagesAt !== null && stepStart !== null && engagesAt > stepStart + 0.04) {
    const zoomStart = stepStart + (engagesAt - stepStart) * HOLD_WIDE_FRACTION;
    moveStart = zoomStart;
    closeUp.at = engagesAt;
    SHOTS.splice(SHOTS.indexOf(closeUp), 0, { ...wide, id: 'holdWide', at: zoomStart });
  } else {
    closeUp.at = Math.max(engagesAt ?? wide.at + 0.12, wide.at + 0.12);
  }

  // Swing overhead the instant the pair disengage and go back to searching — the
  // last thing the recording has to say, and the point at which they stop being
  // what there is to look at. That moment has no stop of its own: its line is
  // pinned to where the swing lands (see the beats block), so the whole zoom-out
  // is one step, out of the close-up on the resting pair and up into the plan.
  //
  // It lands a step short of the end, and that matters. Run it to the last pixel
  // and the gesture that swings the camera overhead is also the gesture that ends
  // the page: the reader arrives at the shot the whole move was heading for with
  // nowhere left to stand and look at it, which reads as the piece stopping early
  // even though every tick has played.
  const resumesAt = atTick(lastInto(SEARCHING));
  panStartAt = Math.min(Math.max(resumesAt ?? closeUp.at + 0.1, closeUp.at + 0.02), 0.95);
  panEndAt = panStartAt + (1 - panStartAt) * 0.55;
  const planAt = panEndAt;

  SHOTS.splice(SHOTS.indexOf(plan), 0, { ...closeUp, id: 'holdCloseUp', at: panStartAt });
  plan.at = planAt;

  return [female, male];
})();

// Nobody to move in on: hold the wide shot until the turn overhead.
if (!engagedPair) shotById('closeUp').subject = 'piece';

// --- look ------------------------------------------------------------------

// The studio renders the piece against near-black. This page is white, and the
// bodies carry their own flat colour rather than the installation's materials,
// so the MTLs are never fetched (see the manifest script).
viewer.renderer.setClearColor(0xffffff, 1);
viewer.scene.background = null;
viewer.renderer.shadowMap.enabled = true;
// VSM. The module inlines three.js and exports no constants, so this is the raw
// enum value (0 basic, 1 PCF, 2 PCF-soft, 3 VSM). It is the only one of the four
// with a blur wide enough to matter here: the shadows land 45in below the piece,
// and at that throw a one-texel edge reads as a cut-out sticker rather than as
// something a hanging body drops onto a floor.
viewer.renderer.shadowMap.type = 3;

lightScene();
// The ground clones its material from a body, so it can only be built once the
// meshes have arrived; `paintBodies` calls back here when they do.
paintBodies();

/**
 * Re-light for white.
 *
 * The player ships a near-even rig — ambient 0.8 against a single 0.75 lamp —
 * which is right for glowing instruments on black but flattens flat-coloured
 * shells into silhouettes. This drops the ambient and puts most of the energy
 * into a high key so the forms turn, then adds back the three lights that a
 * single key cannot supply: a fill to keep the shadow side off the floor, a
 * grazing rim for the edge highlight, and a bounce from below standing in for
 * the white floor. Only the key casts; the other three exist to shape.
 *
 * The module exports no constructors, so the extra lights are cloned off the
 * one directional light the player already built.
 */
function lightScene() {
  let ambient = null;
  let key = null;
  viewer.scene.traverse((light) => {
    if (light.isAmbientLight) ambient = light;
    else if (light.isDirectionalLight && !key) key = light;
  });
  if (ambient) ambient.intensity = LIGHTING.ambient;
  if (!key) return;

  key.intensity = LIGHTING.key;
  key.position.set(...LIGHTING.keyFrom);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  // The blur, in shadow-map texels — this is the whole reason for VSM.
  key.shadow.radius = 7;
  key.shadow.blurSamples = 16;
  // The shadow camera is orthographic for a directional light, and it has to
  // cover not the piece but everywhere the piece's shadows *land* — which is a
  // good deal further out, because the key comes in at a slant and the ground is
  // 45in below, throwing each shadow ~57in clear of the body that casts it.
  // Sizing it to the piece leaves an outer shell's shadow sitting on the
  // boundary, and beyond the boundary the map samples its own clamped edge, so
  // that one shadow smears off across the floor as a hard-edged slab.
  Object.assign(key.shadow.camera, { left: -260, right: 260, top: 260, bottom: -260, near: 1, far: 900 });
  // VSM stores depth moments rather than depth, so the usual depth bias is not
  // what it wants; the normal bias alone keeps a shell from shadowing itself,
  // in scene inches.
  key.shadow.bias = 0;
  key.shadow.normalBias = 0.35;
  key.shadow.camera.updateProjectionMatrix();

  for (const [intensity, from] of [
    [LIGHTING.fill, LIGHTING.fillFrom],
    [LIGHTING.rim, LIGHTING.rimFrom],
    [LIGHTING.bounce, LIGHTING.bounceFrom],
  ]) {
    const light = key.clone();
    light.intensity = intensity;
    light.position.set(...from);
    light.castShadow = false;
    viewer.scene.add(light);
  }
}

/**
 * A ground far below the piece, purely to catch shadows.
 *
 * It is white and lit past 1.0, so it clips to the same pure white as the page
 * behind the canvas and is invisible — including its horizon, which would
 * otherwise cut across the opening three-quarter shot. Only the shadows falling
 * on it show. That is why the key and fill intensities are not free parameters:
 * together they have to saturate a surface facing straight up.
 */
let ground = null;

function addGround() {
  if (ground) return;
  const source = firstPaintableMesh();
  if (!source) return;

  const Geometry = source.geometry.constructor;
  const Attribute = source.geometry.attributes.position.constructor;
  const Mesh = source.constructor;

  const s = 4000;
  const geometry = new Geometry();
  geometry.setAttribute(
    'position',
    new Attribute(
      new Float32Array([-s, -s, 0, s, -s, 0, s, s, 0, -s, -s, 0, s, s, 0, -s, s, 0]),
      3
    )
  );
  geometry.setAttribute(
    'normal',
    new Attribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3)
  );

  const material = source.material.clone();
  // Brighter than white on purpose. `setRGB` past 1 is a legal albedo — it just
  // multiplies the light — and it is what lets the ground burn out at a light
  // level the bodies can still survive. `setHex` would clamp it back to 1, so it
  // has to be `setRGB`, in the working colour space (its default) so no sRGB
  // transfer curve is applied on the way in.
  material.color.setRGB(LIGHTING.groundGain, LIGHTING.groundGain, LIGHTING.groundGain);
  material.emissive?.setHex(0x000000);
  material.emissiveIntensity = 0;
  // No highlight: the ground is meant to be invisible except for what falls on
  // it, and a sheen would draw its plane.
  material.specular?.setHex(0x000000);
  material.shininess = 0;
  material.map = null;
  // The clone source is whichever painted mesh the traversal reached first, and
  // that can be a female shell — which is now translucent and glowing. Inherit
  // either and the ground stops being an opaque white surface: it would render
  // in the transparent pass at 0.8 and hand back washed-out shadows.
  material.transparent = false;
  material.opacity = 1;
  material.depthWrite = true;
  material.needsUpdate = true;

  ground = new Mesh(geometry, material);
  ground.position.set(0, 0, LIGHTING.groundZ);
  ground.receiveShadow = true;
  // Never a framing subject: `subjectCorners` only walks tagged body groups.
  viewer.scene.add(ground);
}

function firstPaintableMesh() {
  let found = null;
  viewer.scene.traverse((mesh) => {
    if (!found && mesh.isMesh && mesh.userData.painted) found = mesh;
  });
  return found;
}

// --- camera ----------------------------------------------------------------

// Scroll drives the camera, so the viewer's own orbit control must not also be
// writing to it — otherwise the two fight and the shot jitters.
if (viewer.controls) viewer.controls.enabled = false;

const _point = new Vec();
const _right = new Vec();
const _up = new Vec();
const _aim = new Vec();
const _origin = new Vec();
// Shots are solved on a stand-in so a half-solved pose is never what gets drawn.
const scratch = viewer.camera.clone();

// Clearance between the piece and the edges of the frame, in NDC — so 0.02 is a
// hundredth of the frame held back on each side.
//
// It was 0.1, from when the scene was full bleed and ran under the caption: the
// outermost female was arriving 9px past the left of a 1280px window, and a tenth
// of the frame was the cheapest way to stop it being clipped. There is a drawn
// border now, and a subject held a tenth of the frame clear of it just reads as
// the picture not filling its own box. This is the smallest inset that keeps the
// geometry off the border line itself.
const SAFE_EDGE = 0.02;

/**
 * The part of the frame the piece may be fitted into, in NDC (−1…1, y up).
 *
 * The whole frame, less a margin at the edges. It used to be less than that:
 * the stage was full bleed and the caption lay *over* the scene, so this read
 * the caption box out of the live layout and handed back whatever rectangle was
 * left beside or above it — otherwise the bodies ran straight under the words.
 *
 * The caption is now display type in its own band above the frame and the
 * readout has a band below, so nothing overlaps the picture and the piece gets
 * all of it. If anything is ever floated back over the scene, this is the place
 * that has to know.
 */
function safeArea() {
  return {
    x0: -1 + SAFE_EDGE,
    x1: 1 - SAFE_EDGE,
    y0: -1 + SAFE_EDGE,
    y1: 1 - SAFE_EDGE,
  };
}

/**
 * Solve one shot: where the camera stands, what it points at, and how wide.
 *
 * Aim and zoom are measured from the subject rather than typed, so the shot
 * holds up at any window shape and wherever the bodies have swung to. Two
 * things make that necessary. The piece is wide and shallow, so a
 * bounding-sphere fit reserves far more room than its silhouette needs and the
 * shot comes out tiny. And a subject's bounding box is not centred on what you
 * see — the female triangle sits off to one side — so simply pointing at the
 * box centre wastes most of one half of the frame. The loop re-aims at the
 * *projected* centre before fitting, converging in two or three passes.
 *
 * Returns false if the subject has nothing in it yet.
 */
function solveShot(shot, aspect, out) {
  const count = subjectCorners(shot.subject === 'pair' ? engagedPair : null);
  if (count === 0) return false;

  // Orbit the subject's own centre at the shot's bearing and elevation.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += cornerPool[i].x;
    cy += cornerPool[i].y;
    cz += cornerPool[i].z;
  }
  cx /= count;
  cy /= count;
  cz /= count;

  out.centre.set(cx, cy, cz);

  const elevation = shot.elevation * (Math.PI / 180);
  const azimuth = shot.azimuth * (Math.PI / 180);
  const flat = Math.cos(elevation) * shot.distance;
  scratch.position.set(
    cx + Math.cos(azimuth) * flat,
    cy + Math.sin(azimuth) * flat,
    cz + Math.sin(elevation) * shot.distance
  );
  _aim.set(cx, cy, cz);

  // Up is derived from the orbit rather than left at world +Z. Looking straight
  // down, +Z is parallel to the view and `lookAt` becomes degenerate — the frame
  // rolls, and the aim-refine below reads its own right/up vectors off a matrix
  // that is falling apart. This stays well-conditioned at every elevation,
  // including exactly overhead, where it points the frame along the bearing.
  scratch.up
    .set(
      -Math.cos(azimuth) * Math.sin(elevation),
      -Math.sin(azimuth) * Math.sin(elevation),
      Math.cos(elevation)
    )
    .normalize();
  out.up.copy(scratch.up);

  let halfX = 0;
  let halfY = 0;
  for (let pass = 0; pass < 3; pass++) {
    scratch.lookAt(_aim);
    scratch.updateMatrixWorld();

    // Extents as tangents (offset per unit of depth), which is the space the
    // FOV is actually expressed in.
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < count; i++) {
      _point.copy(cornerPool[i]).applyMatrix4(scratch.matrixWorldInverse);
      const depth = -_point.z; // the camera looks down its own −z
      if (depth <= 0.001) continue;
      const tx = _point.x / depth;
      const ty = _point.y / depth;
      if (tx < x0) x0 = tx;
      if (tx > x1) x1 = tx;
      if (ty < y0) y0 = ty;
      if (ty > y1) y1 = ty;
    }
    if (x0 > x1) return false; // nothing in front of the camera yet

    halfX = (x1 - x0) / 2;
    halfY = (y1 - y0) / 2;
    const offX = (x0 + x1) / 2;
    const offY = (y0 + y1) / 2;
    if (Math.abs(offX) < 1e-4 && Math.abs(offY) < 1e-4) break;

    // Slide the aim point across the view plane by the measured offset.
    _right.setFromMatrixColumn(scratch.matrixWorld, 0);
    _up.setFromMatrixColumn(scratch.matrixWorld, 1);
    const depth = scratch.position.distanceTo(_aim);
    _aim.addScaledVector(_right, offX * depth).addScaledVector(_up, offY * depth);
  }

  // Now that the stage is full bleed the text lies over the scene, so the piece
  // is framed into the part of the screen the text is not using rather than into
  // the middle of the window. `safeArea` gives that region in NDC.
  const safe = safeArea();
  const halfSafeX = (safe.x1 - safe.x0) / 2;
  const halfSafeY = (safe.y1 - safe.y0) / 2;

  // `fov` is vertical, so the width term is divided by the aspect — a portrait
  // window would otherwise crop the subject's long axis.
  const tanHalf =
    Math.max(halfY / halfSafeY, halfX / Math.max(aspect, 0.01) / halfSafeX) * CAMERA.margin;

  // The loop above centres the subject in the whole frame; slide it across to
  // the middle of the safe region.
  const centreX = (safe.x0 + safe.x1) / 2;
  const centreY = (safe.y0 + safe.y1) / 2;
  if (centreX !== 0 || centreY !== 0) {
    _right.setFromMatrixColumn(scratch.matrixWorld, 0);
    _up.setFromMatrixColumn(scratch.matrixWorld, 1);
    const depth = scratch.position.distanceTo(_aim);
    _aim
      .addScaledVector(_right, -centreX * tanHalf * aspect * depth)
      .addScaledVector(_up, -centreY * tanHalf * depth);
  }

  out.position.copy(scratch.position);
  out.aim.copy(_aim);
  out.fov = Math.min(100, 2 * Math.atan(tanHalf) * (180 / Math.PI));
  return true;
}

const solved = SHOTS.map(() => ({
  centre: new Vec(),
  aim: new Vec(),
  up: new Vec(),
  position: new Vec(),
  fov: 45,
}));

// Keyframe positions along the pin, with the last one repeated at the very end
// so the curve flattens into the held plan view rather than arriving at speed
// and stopping dead.
const KEY_AT = [...SHOTS.map((shot) => shot.at), 1];
const keyOf = (index) => SHOTS[Math.min(index, SHOTS.length - 1)];
const solvedOf = (index) => solved[Math.min(index, solved.length - 1)];

const _axis = [0, 0, 0];

let baked = false;
let baking = false;
let bakedWidth = 0;
let bakedHeight = 0;

/**
 * Solve every shot once and keep the numbers.
 *
 * The framing has to be measured from the geometry — but measuring it *per
 * frame* makes every shot a function of whatever the bodies are doing, and they
 * never stop moving. The aim and the zoom then drift and twitch under the
 * camera the whole way through the pan, which is what made it feel jumpy however
 * smooth the path itself was. Baking makes the move a pure function of scroll:
 * nothing in the scene can perturb it, the same scroll position always gives
 * exactly the same shot, and scrubbing back retraces it exactly.
 *
 * All shots are solved against one pose. Framing each against the tick it will
 * be seen at would be nicer, but a seek only reaches the scene graph through the
 * player's own update, which cannot be driven from in here — so this measures
 * what is actually on screen rather than pretending otherwise. The bodies swing
 * about fixed points, so the difference is small. Re-runs only when the bodies
 * first arrive or the window resizes.
 */
function bakeShots(aspect, width, height) {
  if (bodies.length === 0) return false;

  baking = true;
  try {
    for (let i = 0; i < SHOTS.length; i++) {
      if (!solveShot(SHOTS[i], aspect, solved[i])) return false;
    }
  } finally {
    baking = false;
  }

  baked = true;
  bakedWidth = width;
  bakedHeight = height;
  return true;
}

/**
 * Place the camera for the current scroll position.
 *
 * Pure interpolation between the baked shots — no scene reads, no fitting. One
 * curve is fitted through all of them rather than blending only the two either
 * side of the playhead, and a shot's *position* is not interpolated directly:
 * bearing, elevation and distance are, and the position is rebuilt from them,
 * so the camera travels an arc around the piece rather than a straight line
 * between two viewpoints.
 *
 * Progress is read here, at draw time, rather than cached from the scroll
 * handler, so whichever frame gets drawn matches where the page actually is.
 */
function applyFraming() {
  const progressNow = pinProgress();
  const camera = viewer.camera;
  const canvas = viewer.renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const aspect = height > 0 ? width / height : 1;

  // The player sizes its drawing buffer to the container but leaves the GL
  // viewport at whatever the container measured when it first started, so it
  // draws into a band of the canvas and letterboxes everything. Same story as
  // `camera.aspect` below: this page drives the view, so it owns these.
  viewer.renderer.setViewport(0, 0, width, height);

  // And the scissor, which is a *second*, independent letterbox — the one that
  // actually clips. The player pins the drawn region to its own configured
  // aspect: measured on a 1620×1506 buffer it was scissoring to
  // [0, 246, 1620, 1012], a band of exactly 1.6, with ~247px dead at the top and
  // bottom. Fixing the viewport alone did nothing about it, so the scene was
  // drawn into that band and bodies were cut off along its edge while the border
  // sat out at the frame. Off, so the render reaches all four edges and the
  // border is the edge of the camera's view.
  viewer.renderer.setScissorTest(false);
  viewer.renderer.setScissor(0, 0, width, height);

  if (baking) return;
  if (!baked || width !== bakedWidth || height !== bakedHeight) {
    if (!bakeShots(aspect, width, height)) return;
  }

  const sample = (pick) => monotoneAt(KEY_AT, KEY_AT.map((_, i) => pick(i)), progressNow);

  const azimuth = sample((i) => keyOf(i).azimuth) * (Math.PI / 180);
  const elevation = sample((i) => keyOf(i).elevation) * (Math.PI / 180);
  const distance = sample((i) => keyOf(i).distance);

  _axis[0] = sample((i) => solvedOf(i).centre.x);
  _axis[1] = sample((i) => solvedOf(i).centre.y);
  _axis[2] = sample((i) => solvedOf(i).centre.z);

  const flat = Math.cos(elevation) * distance;
  camera.position.set(
    _axis[0] + Math.cos(azimuth) * flat,
    _axis[1] + Math.sin(azimuth) * flat,
    _axis[2] + Math.sin(elevation) * distance
  );

  _aim.set(
    sample((i) => solvedOf(i).aim.x),
    sample((i) => solvedOf(i).aim.y),
    sample((i) => solvedOf(i).aim.z)
  );

  camera.up
    .set(
      -Math.cos(azimuth) * Math.sin(elevation),
      -Math.sin(azimuth) * Math.sin(elevation),
      Math.cos(elevation)
    )
    .normalize();
  camera.lookAt(_aim);
  camera.aspect = aspect;
  camera.fov = sample((i) => solvedOf(i).fov);
  camera.updateProjectionMatrix();
  if (viewer.controls) viewer.controls.target.copy(_aim);
}

// The player rewrites `camera.aspect` to a fixed value on every frame and never
// tracks its container, which both stretches the shot and undoes any fit
// measured against the real one. Re-applying the framing immediately before the
// draw is the one place it cannot be clobbered.
let lastDrawAt = 0;
const drawScene = viewer.renderer.render.bind(viewer.renderer);
viewer.renderer.render = (scene, camera) => {
  lastDrawAt = performance.now();
  if (camera === viewer.camera) applyFraming();
  drawScene(scene, camera);
};

// --- the text track ----------------------------------------------------------

// The script's lines, plus the last one, which is pinned rather than placed at
// its own moment.
//
// `And they go back to searching.` happens in the recording the instant the pair
// disengage — where the swing overhead *starts*. Placing the line there would
// split this stretch into a rest stop and a separate zoom-out stop. Pinned to
// where the swing *lands* instead, it becomes the one stop past resting, so the
// whole zoom-out is the single step from `Spent, they rest` up to it — and the
// reader arrives at the plan view reading it while the last of the recording
// plays out.
const beats = [
  ...scriptAt.map(({ at, line }) => ({
    at, soft: line.soft === true, headline: line.headline, blocks: line.blocks,
  })),
  { at: panEndAt ?? 0.92, headline: CLOSING_HEADLINE, blocks: [] },
].sort((a, b) => a.at - b.at);

/**
 * The words that name something on screen, so they can be coloured to match it:
 * the two sides of the piece, and the two drives.
 *
 * `females?` has to come before `males?` in the alternation or the shorter one
 * wins the race on "females". The word boundaries do not save it on their own —
 * there is no boundary in the middle of "female".
 */
const TERMS = /\b(females?|males?|orange|puce)\b/gi;

/**
 * Write a line, wrapping any of those words in a span the stylesheet can colour.
 *
 * Built out of text nodes and elements rather than by assigning `innerHTML`: the
 * script stays plain prose, and nothing anyone writes in it can be read as
 * markup.
 */
function writeBody(el, text) {
  let last = 0;
  for (const match of text.matchAll(TERMS)) {
    if (match.index > last) el.append(text.slice(last, match.index));
    const term = document.createElement('span');
    term.className = 'term';
    // Singular, so `males` and `male` colour the same.
    term.dataset.term = match[0].toLowerCase().replace(/s$/, '');
    term.textContent = match[0];
    el.append(term);
    last = match.index + match[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}

for (const beat of beats) {
  const block = document.createElement('section');
  block.className = 'beat';

  // The whole section holds still together and is pushed out by the next one, so
  // the sticking happens on this wrapper rather than on the headline alone —
  // otherwise the body slides up behind its own title while the title stays.
  const inner = document.createElement('div');
  inner.className = 'beat-inner';

  const headline = document.createElement('h2');
  headline.className = 'beat-headline';
  headline.textContent = beat.headline;
  inner.append(headline);

  for (const body of beat.blocks) {
    const line = document.createElement('p');
    line.className = 'beat-body';
    // Two voices: what the sculpture is, and what the party it stands for is.
    // The stylesheet is the only place that says which is which colour.
    line.dataset.voice = body.voice;
    writeBody(line, body.text);
    inner.append(line);
  }

  block.append(inner);
  beatsEl.append(block);
  beat.el = block;
  beat.inner = inner;
}

// The fades a section arrives out of and leaves into, held at the two ends of the
// column for the whole pin. Last, so they paint over the sections moving behind
// them.
for (const end of ['top', 'bottom']) {
  const veil = document.createElement('div');
  veil.className = `beat-veil beat-veil-${end}`;
  veil.setAttribute('aria-hidden', 'true');
  beatsEl.append(veil);
}

// There is no `switchAt` any more. It existed because one box held one line at a
// time and something had to decide when to swap it — the swap was pulled a
// little ahead of each stop so it happened during the camera move rather than on
// the settle. A line's position on the track is that timing now, and the reader
// sets it by scrolling.

// --- the caption track --------------------------------------------------------

/**
 * Where a headline sits once it sticks, as a share of the viewport height.
 *
 * One number, used twice: the CSS sticks the headline here, and the sections are
 * placed so that a section's top *arrives* here exactly when the scroll reaches
 * its moment. The two have to agree or a headline would either be stuck before
 * its moment or jump on arriving at it, so the CSS reads it from the custom
 * property this sets rather than repeating the figure.
 */
// Only the narrow layout uses this now: beside the frame the sections align to
// the frame's own top edge instead, measured off the layout.
const HEADLINE_TOP = 0.2;

/**
 * Lay the sections down the pin, each starting at the scroll position of its
 * moment and running until the next one starts.
 *
 * The lines used to be stacked in a fixed box and swapped by crossfade; then one
 * line per moment on a track. This is the same track, but each entry is now a
 * headline with body under it, and the headline sticks for as long as its section
 * is passing — so what the reader is looking at stays labelled while they read
 * about it.
 *
 * A section's *height* is what makes that work: `position: sticky` pins a child
 * only within its parent's box, so the box has to span the whole stretch of
 * scroll the headline should hold for. That stretch is the gap to the next
 * moment, which is why this sets height as well as top.
 *
 * Positioned in pixels off the same measurement `pinProgress` reads —
 * `offsetHeight` minus `innerHeight` — rather than a `vh` calc, so the two cannot
 * disagree about what a viewport is. They would on any mobile browser whose
 * toolbars slide away, where `100vh` is the large viewport and `innerHeight` is
 * whatever is on screen this second, and every section would sit a little off its
 * moment.
 */
function placeBeats() {
  const travel = pinSection.offsetHeight - window.innerHeight;
  if (travel <= 0) return;

  // Where the top of a section should land when the scroll is on its moment.
  //
  // Beside the frame, that is the frame's own top edge: a headline and the
  // picture it describes start on the same line. Measured rather than set,
  // because the frame holds a fixed aspect and is centred in whatever height the
  // column has left, so where its top falls depends on the window — a share of
  // the viewport happened to be close on one size and drifted on every other.
  //
  // `offsetTop` is against `.pin-sticky`, which is the frame's offset parent and
  // is itself pinned to the top of the window for the whole pinned scroll. So its
  // coordinates and the viewport's are the same thing here.
  //
  // Stacked under the picture — the narrow layout — there is no aligning to do:
  // the words have to clear the picture entirely or they land behind it.
  const sticky = document.querySelector('.pin-sticky');
  const frame = document.querySelector('.frame');
  const stacked = sticky ? sticky.offsetWidth > pinSection.clientWidth * 0.9 : false;
  const from = stacked && sticky ? sticky.offsetHeight : 0;
  const offset = !stacked && frame
    ? frame.offsetTop
    : from + (window.innerHeight - from) * HEADLINE_TOP;

  beatsEl.style.setProperty('--headline-top', `${offset.toFixed(1)}px`);
  // Where the column starts being readable, and so where the fade has to reach
  // full strength: the top of the window beside the picture, the bottom of the
  // picture when stacked under it. The fade runs from here down to where the
  // sections sit, so a section is solid while it is being read and gone by the
  // time it has been pushed clear.
  beatsEl.style.setProperty('--veil-top', `${from.toFixed(1)}px`);
  // Where the fade at the foot of the column starts. Given as a distance from the
  // top of the window rather than as `bottom: 0`, because both veils sit at the
  // top of the track in the flow and a bottom-stuck element there has nothing
  // below it to hold against — it simply scrolls away with the track. Pinned by
  // offset it stays at the foot for the whole pin.
  beatsEl.style.setProperty('--veil-foot', `${(window.innerHeight - (offset - from)).toFixed(1)}px`);

  // Heights are cleared before anything is measured. `scrollHeight` on a box with
  // an explicit height reports *that* height, not the content's, so measuring
  // without this compares each section against the height it was given last time
  // and the answer can only ever grow — one resize narrower and the sections keep
  // the taller boxes they had.
  for (const beat of beats) beat.el.style.height = 'auto';

  // Tops first, then heights, because a section's height is the distance to the
  // next section's top and some of those tops move.
  //
  // A section anchored to a moment in the recording sits exactly at it — that is
  // the whole point of it. A `soft` one, placed by hand because it describes the
  // piece rather than reporting an event, only has a *preferred* position: if the
  // section before it is too tall for the gap, it gives way and follows on
  // instead. Without that the exposition at the top, which is three sections
  // inside the stretch before the drives cross, overlapped itself — each one
  // arriving on top of the last rather than after it.
  // How much scroll a section owns at the very least: enough that the next one
  // has not reached the foot of the window while this one is sitting in place.
  // Sections are placed from the top of the window down to `offset`, so that
  // distance is what is left below them — anything less and the section after
  // this one is already on screen underneath it, which is what made them read as
  // crowded no matter how much padding they were given.
  const leastScroll = window.innerHeight - offset;

  const tops = [];
  let cursor = -Infinity;
  for (const beat of beats) {
    const wanted = beat.at * travel + offset;
    const top = beat.soft ? Math.max(wanted, cursor) : wanted;
    tops.push(top);
    cursor = top + Math.max(beat.el.scrollHeight, leastScroll);
  }

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const content = beat.el.scrollHeight;
    beat.el.style.top = `${tops[i].toFixed(1)}px`;

    // Run to the next section, or to the end of the pin for the last one. Never
    // shorter than the text itself, or a long section inside a short gap would
    // have its own body spill out of the box it sticks in — it would stop
    // sticking while its words were still on screen.
    const until = i + 1 < beats.length ? tops[i + 1] : travel + window.innerHeight;
    beat.el.style.height = `${Math.max(until - tops[i], content).toFixed(1)}px`;
  }
}

placeBeats();

// Watching the pin rather than the window: its height is the thing that decides
// the answer, and it is measured *after* layout. A `resize` listener reads
// `offsetHeight` while the new height may not be in yet — caught in testing,
// where every line kept its old pixel offset and the last few ended up past the
// end of the pin. The pin is sized in `vh`, so this catches viewport height
// changes too, including the mobile toolbar slide that never reliably fires
// `resize` at all.
new ResizeObserver(placeBeats).observe(pinSection);

// The lines wrap at a width the window decides, so their heights change with it
// and the centring above goes stale. Same guard as the pin.
new ResizeObserver(placeBeats).observe(beatsEl);

// And the frame, because the lines are centred on *it*. Without this they keep
// the positions they were given against a frame that has since been laid out at
// a different height — measured, 338px adrift on first load.
new ResizeObserver(placeBeats).observe(document.querySelector('.frame'));

// A line's height is only meaningful once the condensed face has arrived —
// measured against the fallback, every line is centred against the wrong height
// and sits a few pixels off its moment.
if (document.fonts) document.fonts.ready.then(placeBeats);


// --- the drive readout -------------------------------------------------------

/**
 * What each of the five bodies wants, under the prose, live.
 *
 * The captions above are one line at a time and only fire on a change; this is
 * the continuous half of the same story — five rows, one per body, each showing
 * its two drive levels and what it is doing. It reads from the recording (see
 * `drives.js`), so it is the simulation's own numbers rather than anything
 * restated here, and it moves with the scroll on every frame, not on beats.
 */
const STATE_WORD = {
  'engaging-partner': 'engaging',
  'satisfaction-search': 'searching',
  'satisfied-and-indifferent': 'resting',
};

const driveTrack = readDriveTrack(player.getRecording());
const driveRows = [];
// One scratch array, refilled each frame rather than reallocated.
const driveReading = [];

if (driveTrack) {
  const panel = document.createElement('div');
  panel.className = 'drives';

  // No legend. The bars used to carry one — two swatches and a note — but the
  // prose now names Orange and Puce in their own colours, which says the same
  // thing where the reader is already looking.

  for (const unit of driveTrack.units) {
    const row = document.createElement('div');
    row.className = 'drive-row';
    row.dataset.side = unit.side;
    row.innerHTML =
      '<span class="drive-dot"></span>' +
      `<span class="drive-name">${unit.short}</span>` +
      '<span class="drive-bars">' +
      '<span class="drive-bar" data-drive="o"><i></i></span>' +
      '<span class="drive-bar" data-drive="p"><i></i></span>' +
      '</span>' +
      '<span class="drive-state"></span>';
    panel.append(row);
    driveRows.push({
      o: row.querySelector('[data-drive="o"] i'),
      p: row.querySelector('[data-drive="p"] i'),
      state: row.querySelector('.drive-state'),
      el: row,
      // Last painted values, so a frame that changes nothing writes nothing.
      last: { o: -1, p: -1, state: '' },
    });
  }

  // The "spent" line, at the drive lower limit, on every bar at once.
  panel.style.setProperty('--spent-at', `${(driveTrack.lowerMark * 100).toFixed(2)}%`);
  driveSlot.append(panel);
}

function updateDrives(progress) {
  if (!driveTrack) return;
  const reading = driveTrack.read(progress, driveReading);
  for (let i = 0; i < driveRows.length; i++) {
    const row = driveRows[i];
    const now = reading[i];
    // scaleX rather than width: a bar moving every frame should not be asking
    // the page for a layout every frame.
    if (Math.abs(now.o - row.last.o) > 0.002) {
      row.o.style.transform = `scaleX(${now.o.toFixed(4)})`;
      row.last.o = now.o;
    }
    if (Math.abs(now.p - row.last.p) > 0.002) {
      row.p.style.transform = `scaleX(${now.p.toFixed(4)})`;
      row.last.p = now.p;
    }
    if (now.state !== row.last.state) {
      row.last.state = now.state;
      row.state.textContent = STATE_WORD[now.state] ?? now.state.replace(/-/g, ' ');
      row.el.dataset.state = STATE_WORD[now.state] ?? '';
    }
  }
  updateSignals(reading);
}

/**
 * Burn each body's lamp according to what that body is doing.
 *
 * This is the encounter made visible: while two bodies are engaged, his ring and
 * her interior LEDs go to full, and everyone still hunting stays at the idle
 * glow. Off `reading`, the same per-unit state the rows above are showing, so
 * the lamp and the word can never contradict each other.
 *
 * Written only on a change — the scroll runs this every frame, and three.js
 * uploads a uniform for every material touched.
 */
function updateSignals(reading) {
  if (bodies.length === 0) return;
  for (const body of bodies) {
    if (body.part?.treat !== 'signal' || !body.unit) continue;
    const index = driveTrack.units.findIndex((unit) => unit.id === body.unit);
    if (index === -1) continue;
    const engaged = reading[index].state === ENGAGED;
    const tone = body.part.side === 'female' ? SIGNAL.female : SIGNAL.male;
    const wanted = engaged ? tone.lit : tone.idle;
    if (body.litAt === wanted) continue;
    body.litAt = wanted;
    // The heavy ones are not drawn at all unless they are firing.
    if (body.part.whileEngaged) body.group.visible = engaged;
    if (!engaged && body.part.whileEngaged) continue; // nothing to light
    body.group.traverse((mesh) => {
      if (mesh.isMesh) mesh.material.emissiveIntensity = wanted;
    });
  }
}

updateDrives(0);

// --- scroll -----------------------------------------------------------------

function pinProgress() {
  const rect = pinSection.getBoundingClientRect();
  const travel = rect.height - window.innerHeight;
  if (travel <= 0) return 0;
  return clamp01(-rect.top / travel);
}

/**
 * One update per displayed frame, polled — no scroll listener.
 *
 * The player owns its own render loop and only draws when it decides to, which
 * for a paused clip is not once per frame. Scroll, though, moves the camera
 * every frame: leaving the drawing to the player means the camera holds still
 * and then jumps, which is the stutter you see during the faster parts of the
 * move. Polling the scroll position in requestAnimationFrame and drawing here
 * pins the camera to the display's refresh instead of to the player's schedule.
 *
 * `lastDrawAt` keeps this from doubling the work: if the player has already
 * drawn this frame, that draw has already run `applyFraming` against the
 * current scroll position, so there is nothing to redo.
 */
let lastProgress = -1;

function frame() {
  requestAnimationFrame(frame);

  const rect = pinSection.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) return; // stage off screen

  // Meshes finish loading after the constructor resolves, and `onAssets` can
  // land before the viewer is reachable, so claim any newly arrived body here.
  // Not inside the progress check below: the bodies can arrive while the reader
  // is sitting still, and an unpainted one renders in loader grey. The per-mesh
  // `painted` flag makes this a no-op once settled.
  paintBodies();

  const progress = pinProgress();
  if (progress !== lastProgress) {
    lastProgress = progress;
    player.seekFraction(progress);
    // The captions need nothing here: they are laid down the page and the scroll
    // moves them, like everything else on it.
    updateDrives(progress);
  }

  if (performance.now() - lastDrawAt > 8) {
    viewer.renderer.render(viewer.scene, viewer.camera);
  }
}

requestAnimationFrame(frame);

// Handy when reading the page with a console open.
window.colloquyClipPlayer = player;
