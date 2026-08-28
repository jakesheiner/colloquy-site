import './style.css';
import { CLIP_URL } from './clip.js';
import { readDriveTrack } from './drives.js';
import { publicUrl } from './base.js';

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
const PLAYER_MODULE = new URL(publicUrl('vendor/colloquy-clip-player.js'), location.origin).href;

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

/**
 * The beam itself — the light that goes out of a male and comes back off a
 * female's mirror. Widths are in the piece's own units, inches.
 *
 * **One colour, both legs, because it is one beam.** The light coming back is
 * the light that went out — only its angle has changed, and that angle is the
 * whole message. Green because the page's other two hues are already spoken
 * for: blue is him, magenta is her, and the thing travelling between them
 * belongs to neither, so a third hue keeps it from reading as either one's
 * property.
 *
 * Neon green, and the cost of that is worth writing down so nobody "fixes" it
 * later. On a white page nothing can read as bright, because the page is
 * already brighter — so a neon colour has only its hue to carry it, not its
 * luminance. Measured: `#39ff14` composites to a 1.36:1 contrast ratio against
 * the page, where the deeper green it replaced sat at 3.51:1. The line is a
 * highlighter stroke rather than an inked one, and at the wide shot, where the
 * core is about three pixels, that is close to the floor. If it ever needs to
 * hold up better, the smallest change that keeps the neon look is to leave the
 * core as it is and give the motes a deeper green of their own, so the stroke
 * gains an edge without losing its centre.
 *
 * **Drawn as a line, not a shaft.** The core is a third of an inch against an
 * 11.5in mirror plate, so it reads as a ruled line between the two bodies
 * rather than as a volume of light. The spill is only four times that: enough
 * to keep the line from aliasing when the wide shot puts it at two or three
 * pixels, not enough to turn it back into a beam of glow.
 *
 * **A leg that ends in mid-air fades out; a leg that ends on a surface does
 * not.** This is the difference between a laser and a floating stick, and it is
 * not a blanket effect — it is which end the leg has. The out leg lands on her
 * mirror, and light arriving at a surface stops there, hard; fading it short of
 * the plate would read as the beam failing to reach her. The return leg is the
 * one hanging in the room, and so is the out leg during the seconds before he
 * finds her, and those are the ends that dissipate. `fadeFrom` holds the leg at
 * full for its first half and then runs a smoothstep to nothing, which is why
 * the leg is cut into `segments` quads rather than being the single one it was:
 * the falloff is carried on vertex alpha, and a quad has nothing between its
 * two ends to carry a curve.
 *
 * **Nothing here is additive.** On a white page an additive beam is arithmetic
 * on 255 and draws nothing at all — the same reason the shells' glow had to
 * become emissive rather than a halo (see GLOW). These are ordinary translucent
 * ribbons: a faint wide one for the spill and a strong narrow one for the core.
 *
 * `spread` is how much wider a leg is where it lands than where it leaves —
 * the light source's own cone is 45°, which over 30in would be a wedge rather
 * than a beam, so this is a legibility number, not a measured one.
 */
const BEAM = {
  colour: 0x39ff14,
  coreWidth: 0.3,
  coreOpacity: 0.95,
  spread: 1.5,
  /**
   * The glow, as a field of motes hanging in the beam rather than a sleeve
   * wrapped round it.
   *
   * A scattered field is what a beam in air actually looks like — you never see
   * the beam, you see what is floating in it — and on a white page it has the
   * further advantage of covering far less area than a sleeve did, so the same
   * impression costs less fill.
   *
   * **The field is fixed in the beam's own frame, not re-scattered per frame.**
   * Each mote is a `(t, angle, radius)` triple generated once from a seeded
   * xorshift and mapped into world space every frame, so the motes ride the beam
   * as it swings instead of boiling. A fresh scatter each frame would read as
   * television static.
   *
   * `bias` crowds them towards the axis — `r = radius * u ** bias`, so above 1
   * the field is dense at the core and thin at the edge, which is both how
   * scattering falls off and what keeps the hairline core from aliasing at the
   * wide shot now that the sleeve is gone.
   */
  motes: {
    count: 90,
    radius: 2.2,
    bias: 2.2,
    size: [0.09, 0.26],
    opacity: [0.22, 0.7],
    // How much brighter and fatter a mote gets at the peak of a flare.
    flareGain: 1.1,
  },
  // How far along a leg that ends in mid-air the fade begins, and how many
  // quads the core is cut into to carry it. A leg that ends *on* something does
  // not fade at all — see `writeRibbon`. The motes obey the same curve.
  fadeFrom: 0.45,
  segments: 8,
  /**
   * The flare, each time his sensors catch the reflection.
   *
   * It swells rather than brightens, and that is forced rather than chosen: the
   * colour is already at full saturation and the page is already white, so
   * there is nowhere brighter for a beam to go. Width and bloom are the only
   * levers left, so the pulse widens the core and swells the mote field — the
   * motes brighten, fatten and push further off the axis, which reads as a puff
   * of light going through the field rather than a line getting thicker.
   *
   * Its timing is the clip's — see `flare` in `src/drives.js`, which hangs an
   * envelope off the rising edges of the simulation's own
   * `sense_reflected_light`. Both legs flare together: the exchange registering
   * is one event, and chasing a pulse along the path would be a light-speed
   * conceit at thirty inches.
   */
  pulse: { width: 2.2 },
  // Held off the surfaces it starts and ends on, or the quad's own tip
  // z-fights with the mirror plate and the lamp ring it is touching.
  clearance: 0.35,
};

const stage = document.getElementById('stage');
const errorEl = document.getElementById('stage-error');
// The platform the text sits on: held still over the scene, and the scroll
// container the track below is inside. Page scroll drives its `scrollTop`.
const beatColumn = document.getElementById('beat-column');
// The track the captions are laid down; it scrolls past the held frame.
const beatsEl = document.getElementById('beats');
// The band under the frame, in the sticky column, so the readout stays with the
// picture it belongs to rather than scrolling away with the words.
const driveSlot = document.getElementById('drive-slot');
const pinSection = document.getElementById('pin-section');
// The white page the headline starts in the middle of, and the headline itself.
const titleScreen = document.getElementById('title-screen');
const siteHead = document.querySelector('.site-head');
// Step to the previous or next headline.
const beatNav = document.getElementById('beat-nav');
const beatPrev = document.getElementById('beat-prev');
const beatNext = document.getElementById('beat-next');

function fail(message) {
  errorEl.textContent = message;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));

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
    // `bodies` has just been rebuilt, and two things are measured off it.
    //
    // The shots especially: `bakeShots` solves them against whatever geometry is
    // in the scene when it runs, and the meshes arrive over several frames. With
    // a title page in front of the stage that never showed, because nothing was
    // drawn until the reader had scrolled past it and everything had long since
    // landed. The stage is the first thing on the page now, so the first bake
    // can catch two bodies out of five and frame the wide shot around them.
    demo = null;
    baked = false;
    exchange = null;
  }
  return painted;
}

// Each loaded OBJ group, tagged with the unit it belongs to. The scene graph
// gives the geometry no unit-named ancestor, so this is worked out by position:
// a body group sits within a couple of inches of its unit's nodes, while the
// beam sits ~23in from either male and ends up tagged null.
const bodies = [];
const UNIT_RADIUS = 10;

// Two things `paintBodies` invalidates when it claims new geometry, both of them
// answers measured off `bodies`: the demonstration's parts, and the camera's
// baked shots.
//
// Declared up here rather than beside the code that owns them because
// `paintBodies` is called once during module evaluation, well before either of
// those blocks — a `let` further down the file is still in its temporal dead
// zone at that point.
let demo = null;
let baked = false;
// The two ends of the beam — which groups are lamps and which are mirrors. Also
// measured off `bodies`, so it goes when they do. See *The beam*.
let exchange = null;

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
  assetManifestUrl: publicUrl('assets.json'),
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

/**
 * How much of the pin the opening demonstration takes before the clip starts.
 *
 * The first section describes the sculpture rather than reporting anything the
 * recording does, and the recording has nothing to show under it: it opens
 * mid-encounter, with the pair already engaged and everything else hanging
 * still. So that stretch is a demonstration of the mechanism instead — see the
 * demonstration block below — and the recording begins where it ends.
 *
 * This is the second section's own position, so the demonstration is over
 * exactly as the reader arrives at the next headline.
 *
 * A seventh of the pin, which at 2400vh is about three windowfuls — one per
 * move. It was a third of that to begin with and every move went past in a flick
 * of the wheel; the pin was lengthened to match rather than the clip shortened,
 * so the recording keeps the room it had.
 *
 * The *share* has come down twice while the pin grew, each time to hold the
 * moves at about a windowful each. This is a fraction of a number that keeps
 * moving, so it is the pixels either side of it that are worth checking, not
 * this.
 */
const DEMO_UNTIL = 0.14;

/** Pin progress → where the recording's head belongs. Parked at its first tick
 *  for the whole demonstration, then the rest of the pin plays the whole clip. */
const clipProgress = (pin) => clamp01((pin - DEMO_UNTIL) / (1 - DEMO_UNTIL));

/** And back: where in the pin a tick of the recording falls. Everything hung off
 *  a moment in the clip — the script's stops, and the camera moves between them
 *  — is placed through here, so the demonstration moves them all together. */
const progressOfTick = (tick) =>
  DEMO_UNTIL +
  (1 - DEMO_UNTIL) * ((tick - playback.tickStart) / (playback.tickEnd - playback.tickStart));

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
 * Where the drives cross, in the pin. The two hand-placed sections between the
 * end of the demonstration and it divide that stretch evenly, so this is worked
 * out rather than typed — the moment moves with the clip, and they should move
 * with it.
 */
const searchingAt = (() => {
  const tick = firstInto(SEARCHING);
  return tick === null ? null : clamp01(progressOfTick(tick));
})();

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
    // The demonstration, which is not a moment in the recording — the clip is
    // parked at its first tick underneath this whole section while the piece
    // shows what it can do. It runs from the top of the pin to `DEMO_UNTIL`,
    // which is where the next section sits.
    at: 0,
    headline: 'The sculpture',
    // This section is the demonstration's caption, so it does not arrive all at
    // once: a block with an `at` waits until that point in the demonstration and
    // then slides into place, and the reader is told what to watch for as the
    // piece does it. The figure is the same clock the moves are on — a fraction
    // of the demonstration, not of the pin — and each is set a little ahead of
    // its move so the words are there to be read before anything happens.
    //
    // No party voice here. The demonstration is the mechanism, and the metaphor
    // starts in the section under it.
    blocks: [
      { voice: 'model', text: 'Colloquy is a kinetic sculpture, a large mobile hanging from the ceiling, consisting of five figures.' },
      { voice: 'model', text: 'Pask labeled three figures “female” and two “male”. His language and allusions are dated and sexist.' },
      { voice: 'model', at: 0.02, text: 'The three females rotate on their own axes.' },
      { voice: 'model', at: 0.34, text: 'The two males spin the bar they hang from.' },
      { voice: 'model', at: 0.66, text: 'And each male turns on his own axis.' },
    ],
  },
  {
    // No moment in the recording — this one introduces the metaphor rather than
    // describing anything the clip does, so it is placed by hand. It and
    // `Starting up` divide the long stretch before the drives cross their
    // threshold into even thirds with the opening section.
    //
    // It is also where the recording starts: the demonstration under the
    // opening section runs up to this line and hands over on it.
    at: DEMO_UNTIL,
    soft: true,
    headline: 'The sculpture represents a party',
    blocks: [
      { voice: 'party', text: 'A party has people. Guests show up, to mingle, eat, drink, and socialize.' },
      { voice: 'party', text: 'The sculpture can represent people interacting at a party. Their conversations have a beginning, a middle, and an end.' },
      { voice: 'model', text: 'Five agents hang from the mobile. Each can move independently, communicate, and affect the others.' },
      { voice: 'party', text: 'Guests arrive with interests, and a growing desire to share them.' },
      // The readout across the foot of the scene comes up with this line — it is
      // the line that says what those bars are, and before it they are five
      // unexplained meters under the picture.
      { voice: 'model', shows: 'drives', text: 'Every agent has two drive states — Orange and Puce — which grow over time.' },
    ],
  },
  {
    // Also placed by hand: the clip opens with everything already at rest, so
    // there is no event marking the start — the moment this describes is the
    // stretch before the drives cross, not a transition into it.
    //
    // Placed at two thirds of the way from the end of the demonstration to that
    // crossing rather than halfway, so the section above it gets the larger
    // share. It was an even split while both arrived whole; now they bring their
    // blurbs in one at a time, and that one is five deep against this one's
    // three.
    at: searchingAt === null ? DEMO_UNTIL + 0.11 : DEMO_UNTIL + (searchingAt - DEMO_UNTIL) * 0.65,
    soft: true,
    headline: 'Starting up',
    blocks: [
      // Moved down out of the opening section, which is the demonstration's
      // caption now and has room only for what is moving on screen. It reads
      // better here anyway: it is what the line under it is the first case of.
      { voice: 'model', text: 'At any moment, each mobile is in one of three possible states: resting, searching, or conversing.' },
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

// Clearance between the piece and the things laid over it — the text column and
// the readout — as a fraction of the window.
const SAFE_GUTTER = 0.02;

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
  const full = {
    x0: -1 + SAFE_EDGE,
    x1: 1 - SAFE_EDGE,
    y0: -1 + SAFE_EDGE,
    y1: 1 - SAFE_EDGE,
  };

  const canvas = viewer.renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return full;

  // A pixel down the window, as NDC — y is up, so the top of the window is 1.
  const ndcY = (px) => 1 - (px / height) * 2;

  const area = { ...full };

  // The text floats over the right of the scene, so the piece gets what is left
  // of it. Read out of the live layout rather than hard-coded, so moving the
  // column in the stylesheet moves the piece with it.
  //
  // `offsetLeft` rather than a rect: the panel is offset from the pinned
  // section, which is as wide as the window, so that is its position on screen —
  // and unlike a rect, it does not depend on where the page happens to be
  // scrolled when the shots are baked, or on how far the panel has stuck.
  const track = document.querySelector('.beat-column');
  if (track && track.offsetWidth > 0) {
    const edge = (track.offsetLeft / width - SAFE_GUTTER) * 2 - 1;
    area.x1 = Math.max(Math.min(area.x1, edge), -0.2);
  }

  // The headline is held across the top of it. Its *resting* foot, measured by
  // `measureHead`, and emphatically not its rect: the headline moves, from the
  // middle of the title screen to the top of the window, so its rect is a
  // function of the scroll. The shots are baked once, and a bake that caught the
  // headline mid-move reserved half the window and fitted the whole piece into
  // what was left — the establishing shot came up a quarter of the size it should
  // be. Same trap the readout's `--readout-top` avoids, for the same reason.
  //
  // The band runs the full width even though the words only cross the middle of
  // it. `safeArea` is a rectangle, and the alternative — a region with a notch in
  // it — is not something the fit could use.
  if (headHeight > 0) {
    const foot = headRestTop + headHeight;
    area.y1 = Math.max(Math.min(area.y1, ndcY(foot) - SAFE_GUTTER * 2), -0.2);
  }

  // The readout lies across the foot of it, so keep the piece above that too.
  // Its top edge is written into the layout by `placeBeats()`, which is the one
  // place that measures it.
  const readout = document.querySelector('.readout');
  if (readout && readout.offsetHeight > 0) {
    const top = parseFloat(getComputedStyle(readout).getPropertyValue('--readout-top'));
    if (Number.isFinite(top)) {
      area.y0 = Math.min(Math.max(area.y0, ndcY(top) + SAFE_GUTTER * 2), 0.2);
    }
  }

  return area;
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

// `baked` lives up beside `bodies` — `paintBodies` clears it, and runs before
// this block exists.
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

// --- the opening demonstration -----------------------------------------------

/**
 * What the piece can do, shown once through before the recording starts.
 *
 * The clip opens mid-encounter — the pair already engaged, nothing else moving —
 * so under the opening section, which describes the sculpture rather than
 * reporting anything the clip does, there was nothing to watch. This is what
 * runs there instead: each way the piece moves, one at a time. The females
 * rotate on their axes, then the males spin the bar, then the males turn on
 * their own axes.
 *
 * It is a *pose*, not a second playback. The clip stays parked at its first tick
 * for the whole demonstration and this turns the bodies on top of it, so every
 * move is a rotation away from that first tick's pose and back to it. What the
 * reader is looking at when the demonstration ends is therefore exactly the
 * frame the recording starts from — there is nothing to line up by hand, and no
 * way for the two to drift apart if the clip is swapped.
 *
 * Applied in the render hook and undone immediately after the draw. The player
 * poses the bodies on its own schedule rather than this page's, so the moment
 * before the draw is the only one where the answer is certainly ours — the same
 * reason the camera is applied there. Undoing it afterwards leaves the scene
 * exactly as the player expects to find it, so nothing here can compound frame
 * over frame or leak into the recording.
 */

const DEG = Math.PI / 180;

/** Eased at both ends, so a move starts and stops rather than snapping. */
const settle = (s) => s * s * s * (s * (s * 6 - 15) + 10);

/**
 * The moves, in the order they are shown, positioned as fractions of the
 * demonstration.
 *
 * `swing` is a whole cycle out and back, which shows the full range and returns
 * the body to where it started; `turn` is one complete revolution, which also
 * ends where it started. That is the property the whole thing rests on: the pose
 * at the end of a move is the pose at the start of it, which is what lets them
 * be shown one at a time and lets the clip take over cleanly at the end.
 *
 * The gaps between them are deliberate. Each move is over before the next
 * begins, so what is being demonstrated is never ambiguous.
 *
 * Angles in degrees, and roughly what the piece actually does: the females run
 * to ±30 and the males to ±60 (their `motionProfile` in the clip's scene graph).
 */
const DEMO_MOVES = {
  // Staggered a little: three shells turning in lockstep read as one mechanism
  // rather than as three bodies each doing this for itself.
  females: { from: 0.04, span: 0.24, stagger: 0.03, swing: 30 },
  // Everything mounted on the bar goes round together — both males with it.
  bar: { from: 0.38, span: 0.26, stagger: 0, turn: 360 },
  males: { from: 0.68, span: 0.21, stagger: 0.03, swing: 55 },
};

// Every joint this shows turns about world Z — the clip's scene graph says
// `axis: "z"` for all of them, and nothing above them tilts. The drawn bodies
// hang under two identity groups, so their own coordinates are world ones and a
// turn is arithmetic on `position` with the same turn premultiplied onto
// `quaternion`.
const DEMO_AXIS = new Vec(0, 0, 1);
const _demoSpin = new (viewer.camera.quaternion.constructor)();

/**
 * What each move turns, and the axis it turns about.
 *
 * These come from two different places, and they have to. The scene the player
 * builds is in two halves: a **hidden** tree of the graph's nodes, which is where
 * the joints are and therefore where each axis is, and the **drawn** bodies,
 * which are the loaded meshes — with no node-named ancestor at all, which is why
 * `assignBodiesToUnits` has to match them to units by proximity in the first
 * place. So a move takes its axis from the node tree and its members from
 * `bodies`, and turns a *set* of objects about a world axis rather than a pivot
 * with the rest hanging off it. There is no hierarchy here to hang anything off.
 *
 * Built lazily into `demo` (declared up beside `bodies`, and thrown away
 * whenever `paintBodies` claims new geometry, because `bodies` is rebuilt then).
 */
function buildDemo() {
  if (bodies.length === 0) return null;

  // The hidden node tree. Every id in it appears twice — the second a childless
  // marker parked at the origin, which would report the axis as the middle of
  // the room.
  const axisOf = (id) => {
    let found = null;
    viewer.scene.traverse((object) => {
      if (found) return;
      if (object.userData?.entry?.node?.id === id && object.children.length > 0) found = object;
    });
    return found;
  };

  const partsFor = (side) =>
    [...new Set(bodies.map((body) => body.unit).filter((unit) => unit?.startsWith(side)))]
      .sort()
      .map((unit) => ({
        axis: axisOf(`${unit}__horizontal_control`),
        members: bodies.filter((body) => body.unit === unit).map((body) => body.group),
      }))
      .filter((part) => part.axis && part.members.length > 0);

  const females = partsFor('female');
  const males = partsFor('male');
  const barAxis = axisOf('beam_horizontal_control');
  // Everything the bar carries: itself, and both males with it. The beam is the
  // one drawn body `assignBodiesToUnits` tags with no unit — it hangs ~23in from
  // either male — so it is picked out by what it is rather than by where it is.
  const bar = {
    axis: barAxis,
    members: [
      ...bodies.filter((body) => body.part?.name === 'beam').map((body) => body.group),
      ...males.flatMap((male) => male.members),
    ],
  };
  if (females.length === 0 && (!barAxis || bar.members.length === 0)) return null;

  // One slot per object, allocated once, to hold where the clip had it while the
  // demonstration is standing on top of it. A male is in two moves — he turns
  // with the bar and on his own axis — so this is the unique set.
  const touched = [...new Set([...females, ...males, bar].flatMap((part) => part.members))].map(
    (object) => ({
      object,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
    })
  );
  return { females, males, bar, touched };
}

/** How far through its own move a body is, as an angle away from the clip's pose. */
function demoAngle(move, index, u) {
  const s = (u - (move.from + move.stagger * index)) / move.span;
  if (s <= 0 || s >= 1) return 0;
  const eased = settle(s);
  return move.turn !== undefined
    ? eased * move.turn * DEG
    : Math.sin(2 * Math.PI * eased) * move.swing * DEG;
}

/** Turn a set of bodies about a vertical axis through `(x, y)`. */
function turnAbout(members, x, y, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  _demoSpin.setFromAxisAngle(DEMO_AXIS, angle);
  for (const object of members) {
    const dx = object.position.x - x;
    const dy = object.position.y - y;
    object.position.x = x + dx * cos - dy * sin;
    object.position.y = y + dx * sin + dy * cos;
    object.quaternion.premultiply(_demoSpin);
  }
}

/** Pose the piece for the demonstration. False if there is nothing to do. */
function setDemoPose(pin) {
  if (pin >= DEMO_UNTIL) return false;
  if (!demo) demo = buildDemo();
  if (!demo) return false;

  // Where the clip left everything, so the draw can be undone afterwards.
  for (const held of demo.touched) {
    held.position.copy(held.object.position);
    held.quaternion.copy(held.object.quaternion);
  }

  const u = clamp01(pin / DEMO_UNTIL);
  const [barMove, maleMove] = [DEMO_MOVES.bar, DEMO_MOVES.males];

  const bar = demo.bar.axis ? demoAngle(barMove, 0, u) : 0;
  const barX = demo.bar.axis ? demo.bar.axis.position.x : 0;
  const barY = demo.bar.axis ? demo.bar.axis.position.y : 0;
  if (bar !== 0) turnAbout(demo.bar.members, barX, barY, bar);

  demo.males.forEach((male, index) => {
    const angle = demoAngle(maleMove, index, u);
    if (angle === 0) return;
    // His axis is on the bar. The node tree it is read from is the clip's, and
    // the bar's turn above is this page's, so it has to be carried over by hand.
    let { x, y } = male.axis.position;
    if (bar !== 0) {
      const cos = Math.cos(bar);
      const sin = Math.sin(bar);
      const dx = x - barX;
      const dy = y - barY;
      x = barX + dx * cos - dy * sin;
      y = barY + dx * sin + dy * cos;
    }
    turnAbout(male.members, x, y, angle);
  });

  demo.females.forEach((female, index) => {
    const angle = demoAngle(DEMO_MOVES.females, index, u);
    if (angle !== 0) turnAbout(female.members, female.axis.position.x, female.axis.position.y, angle);
  });
  return true;
}

/** Put the clip's own pose back, the instant the draw is over. */
function clearDemoPose() {
  for (const held of demo.touched) {
    held.object.position.copy(held.position);
    held.object.quaternion.copy(held.quaternion);
  }
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
  // After the framing, not before: `applyFraming` may bake the shots, and those
  // are solved against the piece as the recording has it. A bake caught during
  // the demonstration must not frame the demonstration's pose.
  const posed = camera === viewer.camera && setDemoPose(pinProgress());
  // After the pose, not before: the beam is solved off where the bodies are
  // about to be drawn, and the demonstration moves them. (It is dark through the
  // whole demonstration anyway — the clip is parked at its first tick and nobody
  // is transmitting there — but that is the clip's doing, not a rule here.)
  if (camera === viewer.camera) updateBeam();
  drawScene(scene, camera);
  if (posed) clearDemoPose();
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

/**
 * The lines that wait their turn, with the section they wait inside.
 *
 * A section arrives one blurb at a time rather than as a wall: the first is there
 * when the headline lands, and the rest come up as the reader scrolls through the
 * stretch the section owns — which is the stretch of the recording it describes,
 * so the words keep step with what is on screen.
 *
 * `at` is a fraction of the section's own box. The opening section sets its own,
 * because they have to land on the demonstration's three moves, and its box *is*
 * the demonstration — so that is the same clock, not a second one. Everywhere
 * else they are worked out in `placeBeats`, which is the only place that knows
 * how much room a section actually has: see `scheduleLines`.
 *
 * They keep their place in the layout from the start. The section is measured
 * once and has to stay the height it was measured at, and a line that arrived by
 * *growing* the box would shift everything under it and pull the section off the
 * scroll position it is anchored to. So the space is held and the line comes up
 * into it: it is the ink that arrives, not the room for it.
 */
const timedLines = [];
/** How far the reader scrolls while a line comes up. */
const LINE_RISE = 130;

/**
 * The line the drive readout comes up with, if the script names one.
 *
 * The bars are the one part of the page that is not the piece and not the prose:
 * five meters with no key, sitting under the picture from the first frame with
 * nothing yet said about them. So they wait for the sentence that says what they
 * are, and arrive on it — which makes them the answer to a line the reader has
 * just read rather than a thing that had been there all along unexplained.
 *
 * Marked in the script rather than found by matching the text, so rewording that
 * line cannot quietly detach the bars from it.
 */
let driveLine = null;

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

  // A section either times its own blurbs or has them spread across it. Mixing
  // the two would mean guessing where a hand-placed line leaves off, so a section
  // that sets even one `at` is taken to have set all the ones it wants.
  const authored = beat.blocks.some((body) => body.at !== undefined);
  // The ones the reader waits for. The first blurb is never one of them: it is
  // the section's opening line and belongs with the headline.
  const waiting = authored
    ? beat.blocks.filter((body) => body.at !== undefined).length
    : beat.blocks.length - 1;
  let rank = 0;

  beat.blocks.forEach((body, index) => {
    const line = document.createElement('p');
    line.className = 'beat-body';
    // Two voices: what the sculpture is, and what the party it stands for is.
    // The stylesheet is the only place that says which is which colour.
    line.dataset.voice = body.voice;
    writeBody(line, body.text);

    const timed = authored ? body.at !== undefined : index > 0;
    if (timed) {
      rank += 1;
      // Hidden from the start rather than from the first frame, or every one of
      // them shows for a moment on load before the first reading hides it.
      line.style.opacity = '0';
      const entry = { el: line, beat, at: body.at ?? null, rank, of: waiting, atPx: 0, shown: -1 };
      timedLines.push(entry);
      if (body.shows === 'drives') driveLine = entry;
    }
    inner.append(line);
  });

  block.append(inner);
  beatsEl.append(block);
  beat.el = block;
  beat.inner = inner;
}

/**
 * Work out where in each section its blurbs arrive.
 *
 * Called from `placeBeats`, because the answer depends on two things only that
 * knows: how much scroll a section owns, and how tall its text is.
 *
 * The room is not the whole section. A section holds still only until the next
 * one reaches it — `position: sticky` releases a block when its parent's bottom
 * edge catches its own, so the stretch it sits still for is its box less its
 * text. Spreading blurbs over the whole box would have the last ones arriving
 * into a section already on its way up and out. So they are spread over the part
 * it is actually sitting still for, and stop short of the end of that, which
 * leaves the last blurb a moment to be read before the section moves.
 *
 * A section whose text more than fills its stretch has no room to stage anything;
 * everything in it lands at once, which is what it did before any of this.
 */
function scheduleLines() {
  for (const line of timedLines) {
    const beat = line.beat;
    const box = parseFloat(beat.el.style.height) || 0;
    if (line.at !== null) {
      line.atPx = line.at * box;
      continue;
    }
    // The stretch the section sits still for, less the distance the last blurb
    // needs to come up in — that has to be inside it too, or the line finishes
    // arriving into a section already leaving. What is left over after that is
    // the moment the last blurb gets to be read in.
    const rest = Math.max(0, box - beat.inner.offsetHeight);
    const room = Math.max(0, rest - LINE_RISE) * 0.85;
    // Capped, rather than simply spread to fill. `Searching` owns a quarter of
    // the pin because that is how long the recording spends looking, and three
    // blurbs spread evenly across it leave the reader most of two windowfuls
    // apart with nothing new to read. Front-loaded and then quiet is the truer
    // shape: the words are done and the looking carries on.
    const step = Math.min(room / line.of, window.innerHeight * 0.8);
    line.atPx = step * line.rank;
  }
}

/**
 * Bring up the lines that are waiting their turn.
 *
 * Written from the scroll rather than run as a CSS transition: the reader is
 * scrubbing this, so a line has to be able to go back down as readily as it came
 * up, and a transition would be chasing the scroll rather than following it.
 * Only on a real change, because this runs on every frame the pin is on screen.
 */
function revealLines(pin) {
  const scrolled = pin * travelPx;
  for (const line of timedLines) {
    const t = clamp01((scrolled - line.beat.restFrom - line.atPx) / LINE_RISE);
    const shown = t * t * (3 - 2 * t);
    if (Math.abs(shown - line.shown) < 0.004) continue;
    line.shown = shown;
    line.el.style.opacity = shown.toFixed(3);
    line.el.style.transform = shown === 1 ? '' : `translateY(${((1 - shown) * 22).toFixed(1)}px)`;

    // The drive readout comes up on its own line, and on the same reading of the
    // scroll — written here rather than in a pass of its own so the two can never
    // land a frame apart.
    //
    // Only what is drawn moves. The band the bars sit in is reserved from the
    // start, in the layout and in `safeArea` both: the shots are baked once, so a
    // camera that discovered this space part-way down the page would have to be
    // re-solved, and the panel above would have to move with it.
    if (line === driveLine && driveSlot) {
      driveSlot.style.opacity = shown.toFixed(3);
      driveSlot.style.transform = shown === 1 ? '' : `translateY(${((1 - shown) * 16).toFixed(1)}px)`;
    }
  }
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
// Where a section comes to rest, as a share of the window height. The scene is
// full bleed here, so there is nothing in the layout to align to — this is the
// one place the height of the column's reading position is set.
const HEADLINE_TOP = 0.2;

/** Air above and below the arrows, inside the panel. */
const NAV_AIR = 12;

// Where the platform's top edge sits in the window, written by `placeBeats()`
// and read by `scrollTrackToPage()` — the second runs every frame, so it is kept
// here rather than measured again.
let columnTopPx = 0;
// The pin's scrollable length, measured by `placeBeats()`. `revealLines` works in
// pixels down the pin rather than in progress, because the schedule it reads is
// in pixels: how far a section can be scrolled before it starts to leave is a
// distance, not a fraction of anything.
let travelPx = 0;
// The scroll offset last written, so a frame that changes nothing writes nothing.
// Declared up here rather than beside `scrollTrackToPage()` below: `placeBeats`
// runs during module evaluation and sets the offset, and a `let` further down the
// file is still in its temporal dead zone at that point.
let lastTrackScroll = -1;

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
  travelPx = travel;

  // The panel's inset from its own edges, taken from the stylesheet rather than
  // repeated here. It sets three things at once, and they have to agree: the
  // padding down the two sides, the gap above the heading — the panel's top edge
  // sits exactly that far above where a heading comes to rest, so the air around
  // the words is the same on three sides — and the depth of the fades.
  const pad = beats.length
    ? parseFloat(getComputedStyle(beats[0].inner).paddingLeft) || 0
    : 0;

  // Where a section comes to rest in the window. The scene is full bleed, so
  // there is nothing in the layout to align to and this is the one place the
  // height of the reading position is set.
  //
  // Stacked — the narrow layout, where the panel is as wide as the window — it
  // takes the lower part of the screen instead and leaves the top to the piece,
  // which would otherwise be hidden behind it completely.
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const restTop = narrow
    ? window.innerHeight * 0.44 + pad
    : window.innerHeight * HEADLINE_TOP;

  // The panel's top edge: just above the heading, by its own padding.
  const columnTop = restTop - pad;

  // The bars lie across the foot of the scene, and text running into them would
  // be unreadable over the top of them — so the platform stops above them, with
  // enough clearance to read as a separate thing rather than as their lid.
  const READOUT_GAP = Math.round(Math.min(40, Math.max(18, window.innerHeight * 0.035)));
  const readoutTop = driveSlot && driveSlot.offsetHeight > 0
    ? window.innerHeight - driveSlot.offsetHeight - READOUT_GAP
    : window.innerHeight;
  const columnFoot = readoutTop - Math.round(Math.min(28, Math.max(14, window.innerHeight * 0.02)));

  const offset = restTop;
  columnTopPx = columnTop;

  // The panel: where it sits in the window, and how deep it is. Everything
  // inside it is measured from its own top edge, not the window's, because the
  // panel is the scrollport now.
  beatColumn.style.setProperty('--column-top', `${columnTop.toFixed(1)}px`);
  beatColumn.style.setProperty('--column-band', `${(columnFoot - columnTop).toFixed(1)}px`);
  beatColumn.style.setProperty('--headline-top', `${pad.toFixed(1)}px`);
  // The strip at the foot of the panel that the arrows sit in, and that the text
  // fades out above rather than passing behind. Its height is the buttons' own,
  // measured, plus air either side — so restyling them moves the text with them.
  const navHeight = beatNav && beatNav.offsetHeight > 0 ? beatNav.offsetHeight : 0;
  const navBand = navHeight > 0 ? navHeight + NAV_AIR * 2 : 0;
  beatColumn.style.setProperty('--nav-band', `${navBand.toFixed(1)}px`);
  if (beatNav) {
    beatNav.style.setProperty('--nav-top', `${(columnFoot - NAV_AIR - navHeight).toFixed(1)}px`);
    // What it has to take back out of the flow to displace nothing.
    beatNav.style.setProperty('--nav-height', `${navHeight.toFixed(1)}px`);
  }
  // The track is as tall as the section it maps, so the panel has that much to
  // scroll through. Measured, not a `vh` calc, for the same reason the sections
  // below are: it cannot be allowed to disagree with the arithmetic.
  beatsEl.style.height = `${pinSection.offsetHeight.toFixed(1)}px`;
  // The readout is a sibling of the panel, so it needs telling where the foot of
  // the window is: it is stuck by an offset from the top, because it sits at the
  // top of the section in the flow and a bottom-stuck element there has nothing
  // below it to hold against — it just scrolls away.
  if (driveSlot) {
    driveSlot.style.setProperty('--readout-top', `${readoutTop.toFixed(1)}px`);
  }

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
  const leastScroll = columnFoot - offset;

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
    // How far into the pin this section comes to rest. Read by the blurb
    // schedule and by the arrows, which step between exactly these.
    beat.restFrom = tops[i] - offset;

    // Run to the next section, or to the end of the pin for the last one. Never
    // shorter than the text itself, or a long section inside a short gap would
    // have its own body spill out of the box it sticks in — it would stop
    // sticking while its words were still on screen.
    const until = i + 1 < beats.length ? tops[i + 1] : travel + window.innerHeight;
    beat.el.style.height = `${Math.max(until - tops[i], content).toFixed(1)}px`;
  }

  // Now that every section knows how much scroll it owns and how tall it is,
  // work out where its blurbs arrive.
  scheduleLines();

  // The panel moved, so the track has to be re-offset now rather than waiting
  // for the next frame — otherwise a resize leaves the text at the old position
  // until something else happens to redraw.
  lastTrackScroll = -1;
  scrollTrackToPage();
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
// and the placement above goes stale. Same guard as the pin.
//
// The panel, not the track inside it: the track's height is now something
// `placeBeats` writes, and watching a box you resize from the callback is a loop
// that never settles — it froze the renderer outright. The panel is what sets
// the measure the lines wrap to anyway.
new ResizeObserver(placeBeats).observe(beatColumn);

// And the readout, because the foot of the readable column is its top edge.
new ResizeObserver(placeBeats).observe(driveSlot);

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
// Where the recording's head is, as a fraction of the clip.
let clipHead = 0;
// The panel the rows live in when they are not out over the piece. Held so a
// row that has been lifted can be put back — see *The stat bars*.
let drivePanel = null;

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
    // Its own cell, stated rather than auto-placed — and the *row* as much as
    // the column, which is the half that is easy to miss. A row that lifts out
    // to hang over its body leaves the panel entirely and comes back at the end
    // of the DOM order, and auto-placement never goes backwards: with only the
    // column pinned, a returning card finds the cursor already past its column
    // and drops onto a second grid row, sitting half a panel below the three
    // that never left. Pinning both puts it back exactly where it was.
    row.style.gridColumn = String(driveRows.length + 1);
    row.style.gridRow = '1';
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
      // Whether this row is currently out over the piece, and where it was last
      // put, so a frame that does not move it writes no transform.
      // The flight. `holds` is where it wants to be, `lift` where it has got to
      // — 0 in the panel, 1 over the body — and `flying` whether it is currently
      // out of the grid and positioned by hand.
      holds: false,
      lift: 0,
      flying: false,
      aimed: false,
      placedAt: '',
      // Its cell, relative to the panel, and the two ends of the flight.
      home: { x: 0, y: 0, w: 132, h: 39 },
      anchor: { x: 0, y: 0 },
      over: { x: 0, y: 0 },
    });
  }

  // The "spent" line, at the drive lower limit, on every bar at once.
  panel.style.setProperty('--spent-at', `${(driveTrack.lowerMark * 100).toFixed(2)}%`);
  driveSlot.append(panel);
  drivePanel = panel;

  // Held back until the line that explains it, if the script marks one. Hidden
  // here rather than on the first frame, or the bars show for a moment on load
  // before the first reading of the scroll hides them — and only if there is
  // something that will bring them back, so a script that stops naming them
  // leaves them visible rather than losing them.
  if (driveLine) driveSlot.style.opacity = '0';
}

function updateDrives(progress) {
  if (!driveTrack) return;
  // Kept for the stat bars, which run every frame rather than only when the
  // scroll has moved, and need to ask the recording where its window is.
  clipHead = progress;
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

// --- the beam ----------------------------------------------------------------

/**
 * The light that goes out of a male and comes back off a female's mirror.
 *
 * This is the encounter itself, and until now the page only implied it: his ring
 * lit, her LEDs answered, and the thirty inches between them stayed empty. The
 * clip carries the beam — `act_transmitting_energetic_beam` on his transmitter
 * is true for exactly as long as it is lit (see `drives.js`) — but no geometry
 * for it. The player's own `showBeamDiagram` is an instrument, drawn against
 * black with the rest of the rig, so this is a new model.
 *
 * **The path is solved from the recording, not drawn towards her.** Every frame:
 * take where his lamp is and which way it points, intersect that ray with each
 * mirror in the room, and reflect off the one it actually strikes. Both ends
 * come out of the clip's own joint angles, by way of the meshes the player has
 * already posed, so nothing here decides where the light goes.
 *
 * That is worth insisting on, because the reflection is the whole mechanism and
 * aiming it by hand would throw it away. She has no other voice: the only thing
 * she does is nod the mirror, and a mirror tilted by θ turns the return by 2θ.
 * So the beam leaves him, lands dead centre on her plate, and comes back
 * *sweeping* — up past his upper sensors, down past his lower ones — and that
 * sweep is her half of the conversation. Measured over the engagement in this
 * clip: his aim settles to within 0.65° of her mirror's centre and the strike
 * lands 0.13–0.37in off the middle of an 11.5in plate, while her tilt runs ±22°
 * and swings the return through 60in of travel at his end.
 *
 * Two things follow from solving it rather than posing it, and both are the
 * recording being honest. He does not start on target: the beam lights at tick
 * 1634 and does not touch her plate until 1679 — two and a half seconds in which
 * it swings across the room and slides onto the mirror. And where the ray misses
 * the plate there is no return leg at all, because there is nothing to bounce
 * off.
 */

// Scratch, so a per-frame solve does not allocate a dozen vectors every frame.
const _lamp = new Vec();
const _shine = new Vec();
const _plate = new Vec();
const _face = new Vec();
const _inPlane = new Vec();
const _strike = new Vec();
const _bestStrike = new Vec();
const _bestFace = new Vec();
const _bounce = new Vec();
const _offset = new Vec();
const _legFrom = new Vec();
const _legTo = new Vec();
const _along = new Vec();
const _across = new Vec();
const _midpoint = new Vec();
const _stationA = new Vec();
const _stationB = new Vec();
const _quadA = new Vec();
const _quadB = new Vec();
const _spin = new Vec();
const _moteAt = new Vec();
const _moteRight = new Vec();
const _moteUp = new Vec();

/**
 * A loaded group's own bounds, in the group's local space, measured once.
 *
 * The parts are modelled in place — the lamp ring's OBJ sits at (−0.125, −2.5,
 * −40.5) in its unit's coordinates, not at the origin — so a group's *position*
 * is the body's pivot and says nothing about where the ring is. Its geometry
 * does. Rigid inside the group, so this is measured on the first frame that
 * wants it and kept; `paintBodies` throws the whole group away if the clip ever
 * hands us different meshes.
 */
function localBounds(group) {
  if (group.userData.localBounds !== undefined) return group.userData.localBounds;
  group.updateWorldMatrix(true, true);
  const toLocal = new (group.matrixWorld.constructor)().copy(group.matrixWorld).invert();
  const at = new Vec();
  let min = null;
  let max = null;
  group.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          at.set(x, y, z).applyMatrix4(mesh.matrixWorld).applyMatrix4(toLocal);
          if (min === null) {
            min = at.clone();
            max = at.clone();
          } else {
            min.min(at);
            max.max(at);
          }
        }
      }
    }
  });
  const bounds =
    min === null
      ? null
      : {
          centre: min.clone().add(max).multiplyScalar(0.5),
          half: max.sub(min).multiplyScalar(0.5),
        };
  group.userData.localBounds = bounds;
  return bounds;
}

/** Column `column` of a world matrix — one of its three axes — as a unit vector. */
function worldAxis(matrix, column, out) {
  const e = matrix.elements;
  return out.set(e[column * 4], e[column * 4 + 1], e[column * 4 + 2]).normalize();
}

// One set of ribbons per male, built the first time his beam lights.
const beams = new Map();

/**
 * One leg of the beam, as a quad kept broadside to the camera.
 *
 * A ribbon rather than a tube: a tube is a dozen times the geometry to look the
 * same from every angle except the one that matters, and the page ends on a plan
 * view where a tube's silhouette is exactly the ribbon's anyway. Two of them
 * nested — a wide faint one for the spill, a narrow strong one for the core —
 * because the alternative, a soft edge, wants per-vertex alpha, and the three.js
 * inside the player is whatever version it was built against.
 */
function makeBeamMesh(source, colour, opacity, order, quads) {
  const Geometry = source.geometry.constructor;
  const Attribute = source.geometry.attributes.position.constructor;
  const Mesh = source.constructor;

  const vertices = quads * 6;
  const geometry = new Geometry();
  geometry.setAttribute('position', new Attribute(new Float32Array(vertices * 3), 3));
  // Never read — the material takes no light — but three.js expects the
  // attribute to exist on a mesh drawn with a lit shader.
  const normals = new Float32Array(vertices * 3);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new Attribute(normals, 3));
  // Four components, and that is the whole point: three.js only compiles the
  // per-vertex *alpha* path (`USE_COLOR_ALPHA`) when the colour attribute has
  // an itemSize of 4. RGB is left at white so the black albedo stays black —
  // vertex colour multiplies the diffuse, not the emissive — while the alpha
  // multiplies the finished fragment, emissive included, which is what fades
  // the beam out. `writeRibbon` writes the alpha; the colours never change.
  const colours = new Float32Array(vertices * 4).fill(1);
  geometry.setAttribute('color', new Attribute(colours, 4));

  const material = source.material.clone();
  // Unlit, by way of a black albedo: nothing the rig does reaches it, so what
  // is drawn is the emissive colour flat. A beam is a light, and shading it
  // would turn it dark on the side away from the key.
  material.color.setHex(0x000000);
  material.emissive?.setHex(colour);
  material.emissiveIntensity = 1;
  material.specular?.setHex(0x000000);
  material.shininess = 0;
  material.map = null;
  material.transparent = true;
  material.opacity = opacity;
  // Depth *test* on, so a body in front still hides the beam behind it; depth
  // *write* off, or the four ribbons punch holes in each other where they cross
  // and the core disappears inside its own halo.
  material.depthWrite = false;
  // DoubleSide. The module inlines three.js and exports no constants, so this is
  // the raw enum (0 front, 1 back, 2 double) — the same reason `shadowMap.type`
  // is written as 3 above.
  material.side = 2;
  material.vertexColors = true;
  material.needsUpdate = true;

  const mesh = new Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // After the shells, which are themselves transparent: left to the sort, a
  // female's flank can land in front of the beam that is crossing her mirror.
  mesh.renderOrder = order;
  // Rewritten every frame. Re-deriving the bounds so the frustum can maybe skip
  // four draw calls costs more than the draws.
  mesh.frustumCulled = false;
  mesh.visible = false;
  // Deliberately not marked `painted`: `firstPaintableMesh` clones the ground's
  // material off whatever it finds first, and a beam is a terrible floor.
  viewer.scene.add(mesh);
  return mesh;
}

/**
 * Where the motes sit, in the beam's own coordinates: `t` along it, `r` and an
 * angle across it, plus each one's own size and strength.
 *
 * Generated once from a seeded xorshift rather than `Math.random`, so a reload
 * draws the identical field — the same commitment the baked shots and the
 * per-tick flare envelope make, that a given place on the page always looks the
 * same.
 */
const MOTES = (() => {
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const [minSize, maxSize] = BEAM.motes.size;
  const [minAlpha, maxAlpha] = BEAM.motes.opacity;
  const field = [];
  for (let i = 0; i < BEAM.motes.count; i++) {
    const angle = rand() * Math.PI * 2;
    const r = Math.pow(rand(), BEAM.motes.bias);
    field.push({
      // Stratified along the beam, jittered inside its own slice, so the field
      // is even end to end instead of clumping the way pure noise does.
      t: (i + rand()) / BEAM.motes.count,
      r,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      size: minSize + rand() * (maxSize - minSize),
      // Fainter further out, on top of the density bias — the two together are
      // what make it read as falloff rather than as confetti.
      alpha: (minAlpha + rand() * (maxAlpha - minAlpha)) * (1 - 0.55 * r),
    });
  }
  return field;
})();

/**
 * Scatter one leg's motes: a billboard each, in a tube of `radius` about the
 * axis, obeying the same end-fade as the core and swelling with `flare`.
 */
function writeMotes(mesh, from, to, radius, fades, flare) {
  _along.copy(to).sub(from);
  const length = _along.length();
  if (length < 1e-3) {
    mesh.visible = false;
    return;
  }
  _along.multiplyScalar(1 / length);
  // Two axes across the beam — the ribbon only needs one, because it is flat,
  // but the motes hang in a tube and need a whole plane to be placed in.
  _across.copy(viewer.camera.position).sub(from).cross(_along);
  if (_across.lengthSq() < 1e-10) {
    mesh.visible = false;
    return;
  }
  _across.normalize();
  _spin.copy(_along).cross(_across);

  // The camera's own right and up, so every mote faces the reader square on.
  // One pair for the whole field: at this dot size the parallax across a leg is
  // far under a pixel, and solving it per mote would be ninety cross products a
  // frame for nothing.
  const e = viewer.camera.matrixWorld.elements;
  _moteRight.set(e[0], e[1], e[2]).normalize();
  _moteUp.set(e[4], e[5], e[6]).normalize();

  const swell = 1 + 0.6 * flare;
  const gain = 1 + BEAM.motes.flareGain * flare;
  const p = mesh.geometry.attributes.position;
  const c = mesh.geometry.attributes.color;
  const a = p.array;
  const alpha = c.array;
  let v = 0;

  for (let i = 0; i < MOTES.length; i++) {
    const mote = MOTES[i];
    const strength = Math.min(
      1,
      mote.alpha * gain * (fades ? beamFalloff(mote.t) : 1)
    );
    const off = mote.r * radius;
    _moteAt.copy(_along).multiplyScalar(length * mote.t).add(from);
    _moteAt.addScaledVector(_across, off * mote.cos);
    _moteAt.addScaledVector(_spin, off * mote.sin);

    const half = mote.size * swell * 0.5;
    const rx = _moteRight.x * half;
    const ry = _moteRight.y * half;
    const rz = _moteRight.z * half;
    const ux = _moteUp.x * half;
    const uy = _moteUp.y * half;
    const uz = _moteUp.z * half;
    const corner = (sx, sy) => {
      a[v * 3] = _moteAt.x + rx * sx + ux * sy;
      a[v * 3 + 1] = _moteAt.y + ry * sx + uy * sy;
      a[v * 3 + 2] = _moteAt.z + rz * sx + uz * sy;
      alpha[v * 4 + 3] = strength;
      v += 1;
    };
    corner(-1, -1);
    corner(1, -1);
    corner(1, 1);
    corner(-1, -1);
    corner(1, 1);
    corner(-1, 1);
  }

  p.needsUpdate = true;
  c.needsUpdate = true;
  mesh.visible = true;
}

function beamFor(unit) {
  const built = beams.get(unit);
  if (built) return built;
  const source = firstPaintableMesh();
  if (!source) return null;
  // The motes carry their strength per vertex, so their material sits at full
  // opacity and `writeMotes` does all the dimming; the cores keep theirs on the
  // material, which never changes.
  const parts = {
    outMotes: makeBeamMesh(source, BEAM.colour, 1, 1, BEAM.motes.count),
    outCore: makeBeamMesh(source, BEAM.colour, BEAM.coreOpacity, 2, BEAM.segments),
    backMotes: makeBeamMesh(source, BEAM.colour, 1, 1, BEAM.motes.count),
    backCore: makeBeamMesh(source, BEAM.colour, BEAM.coreOpacity, 2, BEAM.segments),
  };
  beams.set(unit, parts);
  return parts;
}

function hideBeam(unit) {
  const parts = beams.get(unit);
  if (!parts) return;
  parts.outMotes.visible = false;
  parts.outCore.visible = false;
  parts.backMotes.visible = false;
  parts.backCore.visible = false;
}

/** How much of the beam is left `t` of the way along a leg that ends in mid-air. */
function beamFalloff(t) {
  if (t <= BEAM.fadeFrom) return 1;
  const s = (t - BEAM.fadeFrom) / (1 - BEAM.fadeFrom);
  return 1 - s * s * (3 - 2 * s); // smoothstep, so it leaves full width smoothly
}

/**
 * Lay one leg down the ribbon: `width` where it leaves, `width * BEAM.spread`
 * where it arrives, and — if `fades` — dissipating over its last stretch
 * instead of stopping dead.
 *
 * One `_across` for the whole leg rather than one per station. The leg is
 * straight, so it lies in a single plane; solving the facing per station would
 * twist the ribbon along its own length for nothing.
 */
function writeRibbon(mesh, from, to, width, fades) {
  _along.copy(to).sub(from);
  const length = _along.length();
  if (length < 1e-3) {
    mesh.visible = false;
    return;
  }
  _along.multiplyScalar(1 / length);
  // Across the beam and across the line of sight. Degenerate only when the
  // camera is looking straight down the beam, and there is nothing to draw then.
  _midpoint.copy(from).add(to).multiplyScalar(0.5);
  _across.copy(viewer.camera.position).sub(_midpoint).cross(_along);
  if (_across.lengthSq() < 1e-10) {
    mesh.visible = false;
    return;
  }
  _across.normalize();

  const near = width * 0.5;
  const far = near * BEAM.spread;
  const p = mesh.geometry.attributes.position;
  const c = mesh.geometry.attributes.color;
  const a = p.array;
  const alpha = c.array;

  // One station per segment boundary, reused as the far end of one quad and the
  // near end of the next.
  let v = 0;
  const station = (t) => {
    const half = near + (far - near) * t;
    const at = length * t;
    _stationA.copy(_along).multiplyScalar(at).add(from);
    _stationB.copy(_across).multiplyScalar(half).add(_stationA);
    _stationA.addScaledVector(_across, -half);
    return fades ? beamFalloff(t) : 1;
  };
  const put = (point, opacity) => {
    a[v * 3] = point.x;
    a[v * 3 + 1] = point.y;
    a[v * 3 + 2] = point.z;
    alpha[v * 4 + 3] = opacity;
    v += 1;
  };

  for (let i = 0; i < BEAM.segments; i++) {
    const t0 = i / BEAM.segments;
    const t1 = (i + 1) / BEAM.segments;
    const o0 = station(t0);
    _quadA.copy(_stationA);
    _quadB.copy(_stationB);
    const o1 = station(t1);
    put(_quadA, o0);
    put(_quadB, o0);
    put(_stationB, o1);
    put(_quadA, o0);
    put(_stationB, o1);
    put(_stationA, o1);
  }

  p.needsUpdate = true;
  c.needsUpdate = true;
  mesh.visible = true;
}

/** Which loaded groups are lamps and which are mirrors, off the current `bodies`. */
function buildExchange() {
  const lamps = bodies.filter((body) => body.part?.name === 'male lightsource ring' && body.unit);
  const mirrors = bodies.filter((body) => body.part?.name === 'female mirror');
  if (lamps.length === 0 || mirrors.length === 0) return null;
  return { lamps, mirrors };
}

/**
 * Solve and lay the beam for whichever males are transmitting, this frame.
 *
 * Run from inside the render wrapper rather than from `updateDrives`, and after
 * the demonstration has posed the bodies, for the same reason `applyFraming`
 * lives there: what it measures has to be the piece as it is about to be drawn.
 * The ribbons face the camera, and the camera is not settled until `applyFraming`
 * has run.
 */
function updateBeam() {
  if (!driveTrack || bodies.length === 0) return;
  if (!exchange) exchange = buildExchange();
  if (!exchange) return;

  for (const lamp of exchange.lamps) {
    const index = driveTrack.units.findIndex((unit) => unit.id === lamp.unit);
    const reading = index === -1 ? null : driveReading[index];
    if (!reading?.beaming) {
      hideBeam(lamp.unit);
      continue;
    }
    const parts = beamFor(lamp.unit);
    const ring = localBounds(lamp.group);
    if (!parts || !ring) continue;

    lamp.group.updateWorldMatrix(true, false);
    _lamp.copy(ring.centre).applyMatrix4(lamp.group.matrixWorld);
    // He shines out of the face of his plate, along the ring's own −Y. The
    // clip's `light_source` actuator is the same axis said differently: it sits
    // beside the ring rotated 90° about X, which lands its +Z there.
    worldAxis(lamp.group.matrixWorld, 1, _shine).negate();

    // The nearest mirror the ray actually strikes, and — for the stretch where
    // it strikes none — how far away the nearest mirror is, so the ray is drawn
    // at about the length it will have when it lands.
    let strikeAt = Infinity;
    let nearest = Infinity;
    let struck = false;
    for (const mirror of exchange.mirrors) {
      const plate = localBounds(mirror.group);
      if (!plate) continue;
      mirror.group.updateWorldMatrix(true, false);
      _plate.copy(plate.centre).applyMatrix4(mirror.group.matrixWorld);
      nearest = Math.min(nearest, _plate.distanceTo(_lamp));

      // The plate is a thin slab modelled flat in its own Y, so its face is the
      // group's Y axis — taken towards the light, because a mirror reflects on
      // the side the light arrives from.
      worldAxis(mirror.group.matrixWorld, 1, _face);
      if (_face.dot(_shine) > 0) _face.negate();
      const facing = _shine.dot(_face);
      if (facing > -0.05) continue; // edge-on: nothing to bounce off
      const distance = _offset.copy(_plate).sub(_lamp).dot(_face) / facing;
      if (distance <= 0 || distance >= strikeAt) continue;

      _strike.copy(_shine).multiplyScalar(distance).add(_lamp);
      _offset.copy(_strike).sub(_plate);
      // On the plate, or past its edge? Its two in-plane axes are the group's
      // own X and Z, and the half-sizes come off the geometry rather than from
      // the 11.5in in the scene graph, so a re-cut mirror still bounds itself.
      if (Math.abs(_offset.dot(worldAxis(mirror.group.matrixWorld, 0, _inPlane))) > plate.half.x) continue;
      if (Math.abs(_offset.dot(worldAxis(mirror.group.matrixWorld, 2, _inPlane))) > plate.half.z) continue;

      strikeAt = distance;
      struck = true;
      _bestStrike.copy(_strike);
      _bestFace.copy(_face);
    }

    // Only flare while there is actually a return leg on screen. The clip's
    // sensor flag can read true across the stretch where he is still swinging
    // onto her and the ray is landing on nothing — pulsing a beam that visibly
    // has no reflection would be the one place this could contradict itself.
    const flare = struck ? reading.flare : 0;
    const swell = 1 + (BEAM.pulse.width - 1) * flare;

    const reach = struck ? strikeAt : nearest;
    if (!(reach > BEAM.clearance * 3) || !Number.isFinite(reach)) {
      hideBeam(lamp.unit);
      continue;
    }

    // Out. Held off both ends, or the quad's tip z-fights with the ring it
    // leaves and the plate it lands on.
    _legFrom.copy(_shine).multiplyScalar(BEAM.clearance).add(_lamp);
    _legTo.copy(_shine).multiplyScalar(reach - BEAM.clearance).add(_lamp);
    // It fades only while it is landing on nothing. Once it is on her plate the
    // light stops there, and a beam that faded out short of the mirror would
    // read as one that never reached her.
    writeRibbon(parts.outCore, _legFrom, _legTo, BEAM.coreWidth * swell, !struck);
    writeMotes(parts.outMotes, _legFrom, _legTo, BEAM.motes.radius * swell, !struck, flare);

    if (!struck) {
      parts.backMotes.visible = false;
      parts.backCore.visible = false;
      continue;
    }

    // Back, at the mirror angle. Drawn the same length as the leg that arrived,
    // so its tip rides a circle of that radius: it reaches his lamp exactly when
    // the mirror is square to him, and the gap between tip and lamp is then the
    // real miss rather than a length chosen to look right.
    _bounce.copy(_bestFace).multiplyScalar(-2 * _shine.dot(_bestFace)).add(_shine).normalize();
    _legFrom.copy(_bounce).multiplyScalar(BEAM.clearance).add(_bestStrike);
    _legTo.copy(_bounce).multiplyScalar(reach).add(_bestStrike);
    // Always fades: the return ends in open air by definition — it is drawn the
    // length of the leg that arrived, so its tip reaches his lamp only when her
    // mirror is square to him, and lands in the room otherwise.
    writeRibbon(parts.backCore, _legFrom, _legTo, BEAM.coreWidth * swell, true);
    writeMotes(parts.backMotes, _legFrom, _legTo, BEAM.motes.radius * swell, true, flare);
  }
}

// --- the stat bars -----------------------------------------------------------

/**
 * Around an encounter, the two bodies' rows leave the readout and go and hang
 * over the bodies themselves.
 *
 * The readout under the frame is a table: five units, side by side, in a fixed
 * order. That is the right shape for comparing them and the wrong shape for the
 * one moment when two of them stop being entries in a list and become a pair —
 * you end up reading a row, finding the name, and then hunting the piece for
 * which shape it belongs to. Over the bodies, that lookup disappears.
 *
 * It is the *same row*, moved, not a copy: the element is appended to the body
 * and put back afterwards. A second set of bars fed from the same reading would
 * have been easier and would have been two things to keep honest instead of
 * one — the same argument as `updateSignals` reading the state the readout is
 * already showing rather than deciding for itself.
 *
 * Moved to `document.body` rather than left in place with `position: fixed`,
 * because fixed positioning is only viewport-relative until some ancestor grows
 * a transform or a filter, and the sticky column it lives in is exactly the kind
 * of thing that acquires one. Re-appending is safe in any order: each row states
 * its own `grid-column`, so it lands back in its own cell whatever the DOM order
 * is by then.
 */
const STAT = {
  // Clear of the body's highest point, in CSS pixels.
  lift: 16,
  // And clear of the frame's own edges, so a body that swings to the top of the
  // shot does not push its card out of the picture.
  margin: 8,
  // The card's own horizontal padding, which the stylesheet adds outside the
  // cell width — `--stat-pad-x` there is this number. Only needed so the clamp
  // above knows how far the card actually overhangs its content.
  padX: 9,
  /**
   * How long a card takes to fly between the readout and the piece, in ms.
   *
   * **Timed, not scrolled**, which is the one place on this page that is true.
   * The camera, the flare and the beam are all pure functions of scroll
   * position, and the argument for that is strong: the same place on the page
   * always looks the same. But those are *states* — there is a right answer for
   * every scroll position. This is a **transition between two resting places**,
   * and a transition has to finish. Hung off scroll, a reader who stops mid-way
   * leaves a card parked half-way between the panel and the body, which does not
   * read as a slow animation, it reads as a bug.
   */
  fly: 340,
};

/**
 * Where each row sits when it is at home, measured off the panel while every row
 * is in it.
 *
 * A flying card is positioned in viewport coordinates by a transform, so both
 * ends of its flight have to be expressed that way — including the end that is a
 * grid cell. Recorded relative to the panel rather than the viewport because the
 * panel is sticky and moves as the pin enters and leaves; the offsets do not.
 *
 * Only ever measured with all five rows home. There is nothing to measure
 * otherwise, and it does not matter: the numbers only change on a resize, and a
 * resize in the middle of a two-second engagement is not worth carrying code
 * for. The last good measurement stands until they all land.
 */
let statMeasuredAt = -1;
// When the flights were last stepped on, so the step is a real elapsed time
// rather than a per-frame constant that would run at whatever the refresh is.
let statFlewAt = 0;

function measureStatHome(atWidth) {
  if (!drivePanel || driveRows.some((row) => row.flying)) return;
  const panel = drivePanel.getBoundingClientRect();
  if (panel.width <= 0) return;
  for (const row of driveRows) {
    const box = row.el.getBoundingClientRect();
    // The card is anchored by its bottom centre, so home is stated that way too.
    row.home.x = box.left - panel.left + box.width / 2;
    row.home.y = box.top - panel.top + box.height;
    row.home.w = box.width;
    row.home.h = box.height;
  }
  statMeasuredAt = atWidth;
  // The stylesheet builds the card's width off this, adding its own padding on
  // top so the bars come out the length they were downstairs.
  document.documentElement.style.setProperty('--stat-cell', `${driveRows[0].home.w}px`);
}


const _statCorner = new Vec();

// The one group per unit worth measuring: its shell or its plate. Anchoring to
// everything the unit owns would drag the box up to whatever the mirror or the
// lamp armature is doing, which is not where the reader thinks the body is.
const STAT_PART = { female: 'female shell body', male: 'male body' };

/**
 * Where a unit's card belongs, as a fraction of the canvas: centred on the body
 * and level with its highest point.
 *
 * Every corner is projected and the topmost taken, rather than the top of the
 * world box, because "up" on the screen is not "up" in the piece — the camera
 * ends the pin looking straight down, and by then the highest corner in Z is
 * somewhere in the middle of the shape.
 */
function unitAnchor(unit, side, out) {
  const body = bodies.find(
    (candidate) => candidate.unit === unit && candidate.part?.name === STAT_PART[side]
  );
  if (!body) return false;
  const bounds = localBounds(body.group);
  if (!bounds) return false;
  body.group.updateWorldMatrix(true, false);

  let top = Infinity;
  let sumX = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        _statCorner
          .set(
            bounds.centre.x + sx * bounds.half.x,
            bounds.centre.y + sy * bounds.half.y,
            bounds.centre.z + sz * bounds.half.z
          )
          .applyMatrix4(body.group.matrixWorld)
          .project(viewer.camera);
        // Behind the camera: the projection folds through the origin and the
        // numbers stop meaning anything.
        if (_statCorner.z > 1) return false;
        const y = -_statCorner.y * 0.5 + 0.5;
        if (y < top) top = y;
        sumX += _statCorner.x * 0.5 + 0.5;
      }
    }
  }
  out.x = sumX / 8;
  out.y = top;
  return true;
}

/** Put a row back in the readout — only ever called once its flight has run out. */
function landRow(row) {
  if (!row.flying) return;
  row.flying = false;
  row.lift = 0;
  row.placedAt = '';
  row.el.classList.remove('is-flying');
  row.el.style.transform = '';
  row.el.style.removeProperty('--lift');
  if (drivePanel) drivePanel.append(row.el);
}

/** Put every card away at once, with no flight — the stage has gone. */
function hideStatBars() {
  for (const row of driveRows) {
    row.holds = false;
    landRow(row);
  }
}

function updateStatBars() {
  if (!driveTrack || driveRows.length === 0) return;
  // One layout read a frame, shared by both cards. The stage is sticky, so this
  // moves while the pin is entering and leaving and cannot be cached across
  // frames.
  const canvas = viewer.renderer.domElement.getBoundingClientRect();
  const width = Math.round(canvas.width);
  if (width !== statMeasuredAt) measureStatHome(width);

  const now = performance.now();
  // Clamped, because a tab that has been in the background hands back a gap of
  // seconds, and a card should not teleport on the frame the reader comes back.
  // A reader who has asked for less motion gets the card put where it belongs,
  // with no flight. `stillMotion` is declared further down the file; it is a
  // `const`, so it is live by the time any frame runs.
  const step = stillMotion.matches
    ? 1
    : (statFlewAt === 0 ? 16 : Math.min(64, now - statFlewAt)) / STAT.fly;
  statFlewAt = now;

  /**
   * Who belongs up there comes from the recording, not from this frame.
   *
   * `encounterAt` hands back every unit taking part in the encounter the
   * playhead is inside — the whole run, padded at both ends, rather than
   * whoever happens to be engaged on this tick. Two things follow, and both are
   * the reason it is done in the reader rather than here (see `encounter` in
   * `src/drives.js`).
   *
   * The set is **fixed for the duration**. The pair does not arrive or leave
   * together — in the current clip she engages at tick 1595 and he joins at
   * 1634, she lets go at 1915 and he holds on until 1955 — and the raised cards
   * are what set the height they share, so a set that changed mid-encounter
   * would jolt the survivor to a new level. It was doing exactly that.
   *
   * And it **opens before there is anything to see** and closes after. The bars
   * rise while the two are still hunting, hold through the exchange, and stay a
   * moment past the end of it, so the reader watches the drives climb into the
   * encounter rather than meeting them mid-way.
   */
  const window = driveTrack.encounterAt(clipHead);

  // First pass: where each body tops out.
  for (let i = 0; i < driveRows.length; i++) {
    const row = driveRows[i];
    const unit = driveTrack.units[i];
    // Anchors cost eight projections each, so they are only taken for a body
    // that is either wanted up there or still on its way down.
    row.aimed =
      (((window >> i) & 1) === 1 || row.lift > 0) && bodies.length > 0
        ? unitAnchor(unit.id, unit.side, row.anchor)
        : false;
  }

  // Second pass: run each card's flight on, and find the height they share.
  let level = -Infinity;
  let flying = false;
  for (let i = 0; i < driveRows.length; i++) {
    const row = driveRows[i];
    row.holds = ((window >> i) & 1) === 1 && row.aimed;
    const target = row.holds ? 1 : 0;
    row.lift = clamp(target, row.lift - step, row.lift + step);
    if (row.lift <= 0) {
      landRow(row);
      continue;
    }
    flying = true;
    // Screen y grows downward, so the largest is the lowest on screen. Taken
    // over everything still in the air, not just what is engaged, so a pair on
    // its way home keeps flying in formation.
    if (row.aimed && row.anchor.y > level) level = row.anchor.y;
  }
  if (!flying) return;

  const panel = drivePanel.getBoundingClientRect();

  /**
   * Third pass: place them.
   *
   * Each card keeps its own body's x and gives up its own body's y. Left to sit
   * on its own crown, the male's card rides forty inches higher than hers — his
   * plate reaches most of the way to the bar and her shell hangs well below it —
   * and two readouts of the same thing at two different heights read as two
   * unrelated labels rather than as a pair being compared. Levelled, they are a
   * scoreboard. The cost is that his sometimes crops the top of his own plate,
   * which is the cheaper of the two.
   *
   * Then the whole thing is interpolated back towards the cell it came out of by
   * `lift`. The card is *fixed* for the whole flight, both ends of it — home is
   * expressed as a viewport point rather than as a grid cell, so there is one
   * kind of position throughout and nothing to hand over between.
   */
  for (const row of driveRows) {
    if (row.lift <= 0) continue;

    if (!row.flying) {
      row.flying = true;
      row.el.classList.add('is-flying');
      document.body.append(row.el);
    }

    // Where it is going, if it is going anywhere: over its body, at the shared
    // height, held inside the frame. A body that has swung behind the camera
    // keeps whatever the card was last told, so a lost anchor cannot fling it.
    if (row.aimed && level > -Infinity) {
      const half = row.home.w / 2 + STAT.padX + STAT.margin;
      row.over.x = clamp(
        canvas.left + row.anchor.x * canvas.width,
        canvas.left + half,
        canvas.right - half
      );
      row.over.y = clamp(
        canvas.top + level * canvas.height - STAT.lift,
        canvas.top + row.home.h + STAT.margin,
        canvas.bottom - STAT.margin
      );
    }

    const homeX = panel.left + row.home.x;
    const homeY = panel.top + row.home.y;
    // Smoothstep, so it leaves the panel and arrives over the body without a
    // corner at either end. `lift` itself runs dead straight; the curve is here.
    const t = row.lift * row.lift * (3 - 2 * row.lift);
    const x = homeX + (row.over.x - homeX) * t;
    const y = homeY + (row.over.y - homeY) * t;

    // Whole pixels: the card is small type on a white ground, and half a pixel
    // of subpixel drift on a body that never stops moving is a shimmer.
    const placed = `${Math.round(x)},${Math.round(y)},${t.toFixed(3)}`;
    if (placed === row.placedAt) continue;
    row.placedAt = placed;
    // `--lift` grows the card out of the bare row: the stylesheet hangs the
    // padding, the white ground and the shadow off it, so at 0 what is drawn is
    // exactly the panel row it left and there is nothing to pop on landing.
    row.el.style.setProperty('--lift', t.toFixed(3));
    row.el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -100%)`;
  }
}

updateDrives(0);

// --- the headline's move off the title screen ---------------------------------

/**
 * The headline starts large in the middle of the title screen and settles into
 * the top of the window as the reader leaves it.
 *
 * One headline doing this, rather than a title that scrolls away and a second
 * one that appears: it is the same words throughout, so it should be the same
 * words on screen throughout, and the reader should be able to watch where they
 * went. A crossfade between two copies would read as a substitution.
 *
 * Driven by a transform, not by font size. The size is the stylesheet's, stated
 * once, at the value it holds for the whole of the rest of the page; this only
 * scales it. Setting `font-size` from the scroll would relayout the element every
 * frame and, worse, would make the resting size a thing computed in two places.
 */
const TITLE_SCALE = 2.3;
// The move is done a little before the title screen is, so the headline has
// arrived by the time the scene does rather than still settling over it.
const TITLE_RUN = 0.82;

let headHeight = 0;
let headRestTop = 0;
let headScale = 1;
let headShown = -1;

/**
 * Measure the headline at rest, and work out how much bigger it can be drawn.
 *
 * The transform is cleared first: everything here is the *resting* geometry, and
 * with a transform still applied the rect would report wherever the last frame
 * had put it.
 *
 * The scale is capped by the room across. At `TITLE_SCALE` the words are drawn
 * more than twice the size they are laid out at — the layout does not know that,
 * so on a narrow window they would run off both edges rather than wrap. The cap
 * is what the words fit in, so the title is as large as it can be and no larger.
 */
function measureHead() {
  if (!siteHead) return;
  const words = siteHead.querySelector('h1');
  if (!words) return;
  siteHead.style.transform = '';
  const rect = siteHead.getBoundingClientRect();
  headHeight = rect.height;
  headRestTop = rect.top;
  const style = getComputedStyle(siteHead);
  const room = siteHead.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const across = words.getBoundingClientRect().width;
  headScale = across > 0 ? Math.min(TITLE_SCALE, Math.max(1, room / across)) : TITLE_SCALE;
  // Put it back where the scroll says it should be, this frame rather than next:
  // the line above has just moved it, and a frame at the resting position is a
  // flicker at the top of the window.
  headShown = -1;
  positionHead();
}

/** Place the headline for the current scroll. Called every frame, written on a
 *  change — and outside the stage's own on-screen check in `frame`, because the
 *  whole of this happens while the stage is still below the window. */
function positionHead() {
  if (!siteHead || headHeight === 0) return;
  const run = titleScreen ? titleScreen.offsetHeight * TITLE_RUN : 0;
  const t = run > 0 ? clamp01(window.scrollY / run) : 1;
  // Eased against the scroll rather than tracking it flat, so the headline holds
  // its title size for a moment before it goes and lands rather than stops.
  const shown = t * t * (3 - 2 * t);
  if (Math.abs(shown - headShown) < 0.002) return;
  headShown = shown;
  if (shown === 1) {
    siteHead.style.transform = '';
    return;
  }
  const scale = headScale + (1 - headScale) * shown;
  // Where it has to sit to be centred in the window at title size, as an offset
  // from where the stylesheet rests it.
  const middle = (window.innerHeight - headHeight * headScale) / 2 - headRestTop;
  siteHead.style.transform = `translateY(${(middle * (1 - shown)).toFixed(1)}px) scale(${scale.toFixed(4)})`;
}

measureHead();

// The resting position is set in `vh` and the room across in `vw`, so both ends
// of the move change with the window. The observer as well as the listener: the
// title screen is sized in `svh`, and a mobile toolbar sliding away changes that
// without reliably firing `resize` at all.
window.addEventListener('resize', measureHead);
if (titleScreen) new ResizeObserver(measureHead).observe(titleScreen);

// The width of the words is what caps the title size, and it is not their real
// width until the condensed face has arrived — measured against the fallback the
// headline comes out at the wrong size on the first paint and corrects itself.
if (document.fonts) document.fonts.ready.then(measureHead);

// --- stepping between headlines ----------------------------------------------

/**
 * The arrows at the foot of the panel: one headline back, one forward.
 *
 * They are a way *through* the page, not a way past it. Everything here is
 * scrubbed by the scroll position — the recording, the camera, the blurbs coming
 * up — so a jump would skip all of it at once and land the reader somewhere with
 * no idea how they got there. The step is therefore scrolled rather than set,
 * slowly enough that the piece can be watched moving between the two stops.
 *
 * Not `scrollTo({ behavior: 'smooth' })`. Its duration is the browser's to
 * choose, and for the distances here — a section is two to eight windowfuls — it
 * covers the ground in a few hundred milliseconds, which is the jump this is
 * trying not to be. So the pace is set here.
 *
 * Two paces, though, not one. Everywhere else the scroll is scrubbing a
 * recording, and passing over it quickly is only playing it fast. The
 * demonstration is different: it is three moves with a shape of their own, and
 * the first step on the page crosses all three of them. At the speed the rest
 * runs at they went by in under two seconds, which is the whole demonstration
 * gone in the time it takes to notice a button has been pressed.
 *
 * So a step is timed by *where* it travels, not only how far: the part of it
 * inside the demonstration is paced to be watched, the rest to get there.
 */
const STEP_SPEED = 1.8; // px per millisecond
const DEMO_STEP_SPEED = 0.6; // and slower across the demonstration
const STEP_SHORTEST = 700;
// Loose enough that the demonstration is never the thing being capped — capping
// it would quietly put the speed back up, which is the fault this is fixing.
const STEP_LONGEST = 6500;

const stillMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** The step in progress, or null. Advanced in `frame`. */
let step = null;

/** Where a section comes to rest, as a scroll position on the page. */
const stopAt = (beat) => pinSection.offsetTop + beat.restFrom;

/**
 * The stop before and after where the reader is, or null at either end.
 *
 * `back` is the last stop *behind* the reader, which is the current section's own
 * top whenever they are somewhere inside it rather than sitting exactly on it.
 * That is what makes the pair read as a way of walking the script: forward goes
 * to the next thing, back returns to the top of what you are reading.
 */
function stepTargets() {
  // Where a step already under way is headed, rather than where it has got to.
  // Otherwise a second press part-way through aims at the stop it is already on
  // its way to, and starts the same journey again from closer up.
  const y = step ? step.from + step.distance : window.scrollY;
  let back = null;
  let on = null;
  for (const beat of beats) {
    if (beat.restFrom === undefined) continue;
    const at = stopAt(beat);
    if (at < y - 4) back = beat;
    else if (on === null && at > y + 4) on = beat;
  }
  return { back, on };
}

function updateNav() {
  if (!beatPrev || !beatNext) return;
  const { back, on } = stepTargets();
  beatPrev.disabled = back === null;
  beatNext.disabled = on === null;
}

function stepTo(beat) {
  if (!beat) return;
  const to = stopAt(beat);
  const from = window.scrollY;
  const distance = to - from;
  if (Math.abs(distance) < 2) return;
  if (stillMotion.matches) {
    window.scrollTo(0, to);
    return;
  }
  // How much of the journey is spent inside the demonstration. Worked out as an
  // overlap rather than as a special case for the first step, so a step that
  // only clips the end of it is paced for the part that needs it and no more.
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const demoTop = pinSection.offsetTop;
  const demoFoot = demoTop + DEMO_UNTIL * travelPx;
  const shown = Math.max(0, Math.min(hi, demoFoot) - Math.max(lo, demoTop));

  const ms = Math.min(
    STEP_LONGEST,
    Math.max(STEP_SHORTEST, shown / DEMO_STEP_SPEED + (Math.abs(distance) - shown) / STEP_SPEED)
  );
  step = { from, distance, at: performance.now(), ms };
}

/** Carry a step along. Eased at both ends, so it sets off and arrives rather
 *  than starting and stopping at full tilt. */
function advanceStep() {
  if (!step) return;
  const t = clamp01((performance.now() - step.at) / step.ms);
  window.scrollTo(0, Math.round(step.from + step.distance * settle(t)));
  if (t >= 1) step = null;
}

beatPrev?.addEventListener('click', () => stepTo(stepTargets().back));
beatNext?.addEventListener('click', () => stepTo(stepTargets().on));

// The reader always outranks the step. Scrolling under way is theirs to
// interrupt, and these are the events that mean they have — `scroll` itself is
// not one of them, because the step is generating those.
//
// Except from the arrows themselves. Pressing one is not an interruption, it is
// the next step, and these all reach the window before the `click` does: cancel
// on the way past and the handler below finds nothing under way and steps from
// where the last one had got to rather than from where it was going.
for (const kind of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
  window.addEventListener(
    kind,
    (event) => {
      if (event.target instanceof Element && event.target.closest('.beat-nav')) return;
      step = null;
    },
    { passive: true }
  );
}

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

/**
 * Move the text under the platform, by scrolling the platform.
 *
 * The two live in different coordinate spaces — the sections are laid down the
 * pinned section, the platform is held still in the window — and this is the one
 * conversion between them. A moment at `t` down the track has to appear at `t`
 * below the top of the section, so the platform's scroll offset is however far
 * the page has come into the section, plus the platform's own inset. Until the
 * panel has stuck, it is still riding up with the section and the offset is zero
 * — which is what the clamp says.
 *
 * A real scroll rather than moving the track, because it costs no layout and,
 * more to the point, `position: sticky` inside works against the panel's box.
 * The panel itself never depends on this: it is a plain sticky element the
 * compositor holds still, so a frame this misses moves the words and not the
 * box. The version this replaced cut the track to a painted strip with a
 * `clip-path` written here, and every missed frame slid the panel's edges.
 */
function scrollTrackToPage() {
  const y = window.scrollY - pinSection.offsetTop;
  const offset = Math.max(0, y + columnTopPx);
  if (offset === lastTrackScroll) return;
  lastTrackScroll = offset;
  beatColumn.scrollTop = offset;
}

function frame() {
  requestAnimationFrame(frame);

  // Both before the check below, not after. A step is a scroll and has to keep
  // moving even on the frames where it has carried the stage off screen; and the
  // headline's whole move happens while the stage is still below the window.
  advanceStep();
  positionHead();

  // One of the sideways pages is over the site. It covers the window entirely
  // and the scroll this is scrubbed by is locked while it is open, so there is
  // nothing below to draw and nothing that could have changed — and the page on
  // top has its own scrolling to do, which should not be sharing a frame with a
  // WebGL draw. `src/pages.js` owns the class.
  if (document.documentElement.classList.contains('pane-open')) {
    hideStatBars();
    return;
  }

  const rect = pinSection.getBoundingClientRect();
  if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
    // The cards are fixed to the viewport, so unlike everything else on the
    // stage they do not leave with it. Put them away by hand.
    hideStatBars();
    return; // stage off screen
  }

  // Meshes finish loading after the constructor resolves, and `onAssets` can
  // land before the viewer is reachable, so claim any newly arrived body here.
  // Not inside the progress check below: the bodies can arrive while the reader
  // is sitting still, and an unpainted one renders in loader grey. The per-mesh
  // `painted` flag makes this a no-op once settled.
  paintBodies();

  scrollTrackToPage();

  const progress = pinProgress();
  if (progress !== lastProgress) {
    lastProgress = progress;
    // Not the pin's progress: the recording is parked at its first tick through
    // the opening demonstration and plays out over what is left of the pin.
    const head = clipProgress(progress);
    player.seekFraction(head);
    // The captions are laid down the page and the scroll moves them, like
    // everything else on it — except the opening section's, which come up one at
    // a time as the demonstration reaches them.
    updateDrives(head);
    revealLines(progress);
    updateNav();
  }

  if (performance.now() - lastDrawAt > 8) {
    viewer.renderer.render(viewer.scene, viewer.camera);
  }

  // After the draw, so the cards are placed against the camera the frame was
  // actually rendered with — `applyFraming` moves it at draw time.
  updateStatBars();
}

requestAnimationFrame(frame);

// Handy when reading the page with a console open.
window.colloquyClipPlayer = player;
