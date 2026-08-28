import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { publicUrl } from './base.js';

// The real geometry, exported from the installation's CAD (inches, Z-up,
// each body hanging in −Z). These are dropped in behind the driving pivots,
// scaled to the same real proportions the primitives encoded (see below).
// The Rhino exports split a body into several `o object_N` sub-meshes, so we
// keep the whole loaded group rather than a single mesh.
const MODEL_BASE = publicUrl('models/');
const FEMALE_PARTS = [
  'female-shell-body-260316.obj',
  'female-shell-head-260316.obj',
];
const MALE_PARTS = ['male-body-260316.obj'];
const BEAM_PART = 'beam-260316.obj';

// Calibration yaws (radians) that turn each model's front to where it belongs:
// the female's sensor faces IN at the centroid; the male's broad flat face is
// perpendicular to the bar (its normal along the rotor's X / radial) so it
// faces outward at the females; the bar's long axis lies along the rotor's X.
// The two males sit on opposite bar ends and must face opposite ways along it
// (the scene graph gives male_2 rz:180), so the −X male gets an extra 180°
// (applied per side where the paddles are built) to also face outward.
const FEMALE_MODEL_YAW = THREE.MathUtils.degToRad(-90);
const MALE_MODEL_YAW = THREE.MathUtils.degToRad(90);
const BEAM_MODEL_YAW = THREE.MathUtils.degToRad(90);

const _objLoader = new OBJLoader();
const _modelCache = new Map();
function loadModelGroup(url) {
  if (!_modelCache.has(url)) {
    _modelCache.set(
      url,
      _objLoader.loadAsync(url).then((g) => {
        g.traverse((c) => {
          if (c.isMesh && !c.geometry.getAttribute('normal'))
            c.geometry.computeVertexNormals();
        });
        return g;
      })
    );
  }
  return _modelCache.get(url);
}

const BG = 0xffffff;
const FEMALE = 0xe0189a; // the three fixed bodies (ovals)
const MALE = 0x3abff8; // the rotating bar and its paddles
const LINE = 0xaaaaaa; // triangle edges + guide ring, on white
const LIGHT = 0xffc400; // the comet of light exchanged when eyes meet

// ---------------------------------------------------------------------------
// Layout is derived from the actual scene graph (see the model viewer): the
// installation is modelled in inches, Z-up, everything hung off an armature /
// beam plane at z = 96". One consistent scale keeps the *relative* proportions
// and spacing true — the females at a 68" triangle, the two males only ±23.5"
// apart on the beam, and each body its real size. INCH is picked so the female
// triangle radius maps to 2.2 units (the framing the camera was tuned for).
// ---------------------------------------------------------------------------
const INCH = 2.2 / 68; // ≈ 0.03235 units per modelled inch
const ARMATURE_Z = 96; // the rack/beam plane the whole piece hangs from (in)
// World-z (inches) that maps to y = 0 — the midpoint of the figures' vertical
// extent (female bottom ~27" to male top ~92"), centring the piece for framing.
const Z_MID = 59.8;
const yOf = (zIn) => (zIn - Z_MID) * INCH; // scene-graph height → world y

const SPHERE_RADIUS = 0.4; // placeholder sphere only

// Real body dimensions (inches → units). Females are the taller pendulous
// forms (shell + head ≈ 57"); the males are shorter but substantial (~47",
// NOT the half-size the old guess assumed) and reach higher, nearer the beam.
const FEMALE_HEIGHT = 57.06 * INCH; // ≈ 1.85
const FEMALE_WIDTH = 35.4 * INCH; // ≈ 1.15
const FEMALE_DEPTH = 30.4 * INCH;
const MALE_HEIGHT = 47.13 * INCH; // ≈ 1.53
const MALE_WIDTH = 29.3 * INCH; // ≈ 0.95
const MALE_DEPTH = 23.5 * INCH; // ≈ 0.76 (radial thickness toward the females)
const BEAM_LENGTH = 51.31 * INCH; // ≈ 1.66, the real bar between the two males

const OVAL_SCALE = new THREE.Vector3(
  FEMALE_WIDTH / 2 / SPHERE_RADIUS,
  FEMALE_HEIGHT / 2 / SPHERE_RADIUS,
  FEMALE_DEPTH / 2 / SPHERE_RADIUS
);
const EDGE_THICKNESS = 0.05;
// The rack is the triangle with its sharp corners cut off — a hexagon
// with 3 long sides and 3 short (corner) sides — built as one flat ring.
// It's enlarged past the females so each short (corner) side sits
// directly above a female: the short-side midpoints land at the females'
// radius, so the females hang straight down from them.
const CIRCUMRADIUS = 68 * INCH; // female triangle radius = 2.2
const TRIANGLE_CORNER_CUT = 0.9; // corner-cut depth ≈ the short side's length
const TRIANGLE_BAR_WIDTH = 0.1; // width of the frame's members
const RACK_CIRCUMRADIUS =
  CIRCUMRADIUS + TRIANGLE_CORNER_CUT * Math.cos(Math.PI / 6);

// The two males ride a single rigid bar (the rotor). In the real piece they
// sit only ±23.5" from the centre — far inside the 68" female triangle — so
// the beam exchange has to reach across a wide gap.
const ROTOR_RADIUS = 23.5 * INCH; // ≈ 0.76, male offset on the beam
const PADDLE_HEIGHT = MALE_HEIGHT;
const GUIDE_RING_RADIUS = ROTOR_RADIUS;

// Vertical layout, straight from the scene graph. Each figure's centre is its
// model bbox centre lifted to the z=96" plane; the females hang lower and the
// males reach up near the beam, exactly as in the assembly.
const FEMALE_CENTER_Y = yOf(ARMATURE_Z - 40.12); // female shell+head bbox centre
const MALE_CENTER_Y = yOf(ARMATURE_Z - 27.32); // male body bbox centre
const BEAM_Y = yOf(ARMATURE_Z - 1.38); // the bar itself
const RACK_Y = yOf(ARMATURE_Z); // the armature plane
const GROUND_Y = yOf(ARMATURE_Z - 68.65) - 0.1; // just below the female bottoms

// Base angle (degrees) for the first triangle vertex — 270° places a
// single apex at the top of the flattened top-down view, matching the
// reference sketch, with the remaining two vertices at the base.
const VERTEX_BASE_ANGLE = 270;

// How far each female swivels either way from facing the centroid —
// a 60° total sweep — and how fast, so the three drift out of sync.
const SWIVEL_AMPLITUDE = THREE.MathUtils.degToRad(30);
// Cycles over the whole interaction phase — kept as multiples of 0.5 so
// sin(2π·freq·t) lands back on exactly 0 at both t=0 and t=1, meaning
// every body rests facing the centroid at the very start and very end
// of the scroll, not mid-swivel.
const SWIVEL_FREQUENCIES = [2.5, 3.5, 4];

// A meeting has these beats: the male flashes first, the female chimes
// back, and only then does an exchange *maybe* follow — it isn't
// guaranteed. Each flash and chime throws off an expanding ripple (like
// a drop on a puddle). The exchange itself is a comet of light bounced
// back and forth between the two, and then (connection confirmed) both
// settle into a steady mutual glow. Two one-off encounters are scripted
// below rather than left emergent from the rotor's geometry, one of each
// outcome, so both a failed and a successful attempt are each shown once.
const FLASH_MAX = 0.85; // the male's opening flash (paddle only)
const CHIME_MAX = 0.65; // the female's answering chime (body only)
const BEAM_GLOW = 0.6; // whichever side the comet is arriving at, mid-exchange
const GLOW_MAX = 0.4; // subtle ambient self-glow once the connection locks in
const HOLD_TAPER = 0.06; // how the swivel eases into/out of a held stop

// Fractions of an event's hold-window duration where each beat sits.
// The exchange + lock only ever play out on a 'success' event.
const FLASH_RANGE = [0.02, 0.18];
const CHIME_RANGE = [0.3, 0.46];
// The comet doesn't launch until the flash/chime ripples have fully
// finished spreading (the chime ripple's last ring is gone by ~u=0.67).
const EXCHANGE_RANGE = [0.72, 0.94]; // the comet bounces between the two here
const LOCK_RANGE = [0.96, 1]; // no comet, just the sustained mutual glow

// Ripple — concentric rings a body throws off as it flashes/chimes.
const RIPPLE_RINGS = 4;
const RIPPLE_MIN_R = 0.3; // radius at emission
const RIPPLE_MAX_R = 1.5; // radius as it dies out
const RIPPLE_STAGGER = 0.11; // phase lag per successive ring, in life units
const RIPPLE_PEAK = 1.0; // ring opacity right after emission
const RIPPLE_TAIL = 0.12; // how far past the flash beat rings keep spreading (u units)
const RIPPLE_Y = 0.02; // lifted just clear of the ground plane

// Comet — a bright head trailing a thin line of light, sent from the
// male, bounced off the female, and back across EXCHANGE_RANGE.
// BOUNCE_LEGS is the number of paddle↔female crossings; 2 = out and
// back, one bounce.
const BOUNCE_LEGS = 2;
const COMET_Y = 0.16; // beam height — within both bodies' vertical overlap
const COMET_HEAD_R = 0.024; // radius of the rounded head; the tail tapers from this to 0
const TRAIL_COUNT = 26;
const TRAIL_DT = 0.011; // spacing between trail samples, in exchange-progress units

// The head carries a real point light, so the beam actually casts amber
// light onto the male, female and ground as it travels and bounces.
const BEAM_LIGHT_INTENSITY = 2.6;
const BEAM_LIGHT_DISTANCE = 4.5;
const BEAM_LIGHT_DECAY = 2;

// Persistent trail — the beam paints a thin line between the two as it
// first crosses (its tip tracking the comet head, so it reads as part of
// the beam), then that line stays as the standing connection between
// them and breathes gently through the finale.
const PERSIST_R = 0.012; // thin, delicate residual line
const PERSIST_OPACITY = 0.4;

// The beam (and its shock ring) leaves from just outside the paddle's
// female-facing face — not the body's centre — so the viewer can see
// where it starts; symmetrically it lands just outside the female's
// sensor face rather than vanishing into her centre.
const MALE_FACE_OFFSET = MALE_DEPTH / 2 + 0.06;
const FEMALE_FACE_OFFSET = FEMALE_WIDTH / 2 + 0.06;

// Orthogonal shock rings — vertical (their plane ⟂ to the beam), bursting
// from the male as the beam launches and the female as it bounces, to
// contrast with the flat flash/chime ripples lying on the ground.
const ORTHO_RIPPLE_MIN_R = 0.02; // shock rings start from ~a point, not the bodies' girth
const ORTHO_RIPPLE_MAX_R = 0.9;
const BEAM_RIPPLE_DUR = 0.28; // exchange-progress span of each ring's spread

// female/end pick which body and which paddle end meet; t0 is the
// overall interaction-phase progress the encounter is centered on;
// holdHalf is half the hold window's width (wider for a success, so
// there's room for a noticeable sustained lock after the chime).
const EVENTS_CONFIG = [
  { female: 0, end: 1, t0: 0.28, holdHalf: 0.045, outcome: 'fail' },
  { female: 2, end: 1, t0: 0.68, holdHalf: 0.13, outcome: 'success' },
];

// Camera orbit — start oblique/isometric, end directly overhead.
const ORBIT_RADIUS = 7.2;
const ORBIT_RADIUS_TOP = 5.4;
const PHI_START = THREE.MathUtils.degToRad(58); // polar angle from +Y axis
const PHI_END = THREE.MathUtils.degToRad(0.5);
const THETA_START = THREE.MathUtils.degToRad(35); // azimuth
const THETA_END = THREE.MathUtils.degToRad(0);

// Engagement finale — once the successful exchange lands, the camera
// rotates back out of plan view into an oblique 3D close-up on the two
// engaged figures and holds there to the end. The azimuth is derived at
// runtime from the pair's axis (see setEngagementCamera).
const ENGAGE_PHI = THREE.MathUtils.degToRad(56); // polar angle of the 3D view
const ENGAGE_RADIUS = 6.0;
const ENGAGE_ZOOM = 2.3; // orthographic zoom-in on the pair
const ENGAGE_GLOW = 0.6; // sustained mutual glow held through the finale
// How far off the beam axis the finale view sits. A full 90° frames the
// pair widest but shows the vertical shock rings edge-on (as lines);
// easing in toward the axis lets them read as rings/ellipses.
const ENGAGE_AXIS_OFFSET = THREE.MathUtils.degToRad(52);

// Smoothstep envelope: 0 inside [center-hard, center+hard], 1 once past
// [center-hard-taper, center+hard+taper], eased in between.
function holdEnvelope(t, center, hard, taper) {
  const d = Math.abs(t - center);
  if (d <= hard) return 0;
  if (d >= hard + taper) return 1;
  const f = (d - hard) / taper;
  return f * f * (3 - 2 * f);
}

export function createScene(canvas) {
  // Rendering mode, switchable via ?render=… for experimenting:
  //   solid   (default) — the shaded real models
  //   outline           — each figure drawn as line-art (feature edges), no fill
  const RENDER_MODE =
    new URLSearchParams(window.location.search).get('render') || 'solid';
  const OUTLINE = RENDER_MODE === 'outline';
  // Edges whose adjacent faces differ by more than this angle are drawn.
  // Lower = more lines (picks up gentle creases on the smooth female shells);
  // higher = only the hard structural edges (enough for the boxy males).
  const OUTLINE_ANGLE = 18;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 8, 16);

  const frustumHalfHeight = 3.2;
  let aspect = canvas.clientWidth / canvas.clientHeight || 1;
  const camera = new THREE.OrthographicCamera(
    -frustumHalfHeight * aspect,
    frustumHalfHeight * aspect,
    frustumHalfHeight,
    -frustumHalfHeight,
    0.1,
    50
  );

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  // Variance shadow maps take a large blur cleanly, for a broad, soft
  // penumbra befitting a piece hanging well above the floor.
  renderer.shadowMap.type = THREE.VSMShadowMap;

  // Image-based lighting: a soft studio environment gives the standard
  // materials believable gradient shading and gentle highlights instead
  // of the flat wash of a big ambient light. Only lights the materials —
  // the white background is untouched.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.7;

  // A sky/ground hemisphere adds a natural top-lit-to-shaded gradient (so
  // the bodies read as round), a strong key throws soft shadows to seat
  // them in space, and a low fill keeps the shaded side from going dark.
  const hemi = new THREE.HemisphereLight(0xffffff, 0xb6bcc6, 0.45);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(3.5, 10, 3); // steep-ish so the shadow lands under the piece
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 18; // broad, dispersed penumbra
  key.shadow.blurSamples = 25; // smooth the wide blur
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.3);
  fill.position.set(-5, 3, -4);
  scene.add(fill);

  const model = new THREE.Group();
  scene.add(model);

  // ----- real-model plumbing ------------------------------------------------
  // Each figure is a driving PIVOT (the animation sets its .rotation.y /
  // .position and reads .getWorldPosition, exactly as it did the primitive).
  // Inside sits: a fixed calibration yaw → an axis-fix that converts the CAD's
  // Z-up inches to the scene's Y-up units, scaled by the single global INCH so
  // every body keeps its real size relative to the others. A cheap placeholder
  // shows until the OBJ resolves.
  //
  // `material` is one MeshStandardMaterial per figure, shared across all its
  // sub-meshes, so setEmissive() lights the whole body as one — and the three
  // females / two males stay independent because each gets its own clone.
  function buildFigure(parts, material, calYaw, placeholder) {
    const pivot = new THREE.Group();
    const yawCal = new THREE.Group();
    yawCal.rotation.y = calYaw;
    pivot.add(yawCal);
    const fix = new THREE.Group();
    fix.rotation.x = -Math.PI / 2; // Z-up (CAD) → Y-up (scene)
    yawCal.add(fix);
    const inner = new THREE.Group();
    fix.add(inner);

    // No filled placeholder in outline mode — a solid pop-in would read wrong.
    if (placeholder && !OUTLINE) {
      placeholder.material = material;
      placeholder.castShadow = true;
      placeholder.receiveShadow = true;
      pivot.add(placeholder);
      pivot.userData.placeholder = placeholder;
    }

    Promise.all(parts.map((p) => loadModelGroup(MODEL_BASE + p))).then(
      (groups) => {
        const mbox = new THREE.Box3();
        const tmp = new THREE.Box3();
        for (const g of groups) {
          const clone = g.clone(true);
          clone.traverse((c) => {
            if (c.isMesh) {
              c.geometry.computeBoundingBox();
              mbox.union(tmp.copy(c.geometry.boundingBox));
              if (OUTLINE) {
                // Draw the feature edges only; drop the fill.
                inner.add(
                  new THREE.LineSegments(
                    new THREE.EdgesGeometry(c.geometry, OUTLINE_ANGLE),
                    new THREE.LineBasicMaterial({
                      color: material.color.getHex(),
                      transparent: true,
                      opacity: 0.9,
                    })
                  )
                );
                c.visible = false;
              } else {
                c.material = material;
                c.castShadow = true;
                c.receiveShadow = true;
              }
            }
          });
          if (!OUTLINE) inner.add(clone);
        }
        const center = mbox.getCenter(new THREE.Vector3());
        inner.position.set(-center.x, -center.y, -center.z); // recenter at origin
        fix.scale.setScalar(INCH); // one scale for the whole piece → true proportions
        if (pivot.userData.placeholder) {
          pivot.remove(pivot.userData.placeholder);
          pivot.userData.placeholder = null;
        }
      }
    );
    return pivot;
  }

  // Light the whole composite figure as one (traverses its sub-meshes).
  function setEmissive(obj, hex, intensity) {
    obj.traverse((c) => {
      if (c.isMesh && c.material && c.material.emissive) {
        c.material.emissive.setHex(hex);
        c.material.emissiveIntensity = intensity;
      }
    });
  }

  // Invisible ground far below — it only catches shadows, so the cast
  // shadow lands well beneath the piece and reads it as hanging from
  // above (like the real installation) rather than resting on a floor.
  const shadowCatcher = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.ShadowMaterial({ opacity: 0.16 })
  );
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = GROUND_Y;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  // The three females — fixed bodies at the points of a triangle, flat
  // on the XZ plane. Each is an oval (long axis = local Z); the sensor
  // is on its long side, facing perpendicular to that axis.
  const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 48, 48);
  const sphereMat = () =>
    new THREE.MeshStandardMaterial({
      color: FEMALE,
      roughness: 0.42,
      metalness: 0,
    });

  const vertexAngles = [0, 1, 2].map((i) =>
    THREE.MathUtils.degToRad(VERTEX_BASE_ANGLE + i * 120)
  );
  const vertexPositions = vertexAngles.map(
    (angle) => new THREE.Vector3(Math.cos(angle) * CIRCUMRADIUS, 0, Math.sin(angle) * CIRCUMRADIUS)
  );
  // The sensor sits on the oval's long side (perpendicular to its long
  // axis, local +Z), so the long axis itself runs tangent to the
  // centroid — this is the yaw that puts it there, leaving the sensor
  // (local -X) pointing straight in at the centroid.
  const baseYaws = vertexAngles.map((angle) => -angle);

  const spheres = vertexPositions.map((pos, i) => {
    const placeholder = new THREE.Mesh(sphereGeo, sphereMat());
    placeholder.scale.copy(OVAL_SCALE);
    const pivot = buildFigure(
      FEMALE_PARTS,
      sphereMat(),
      FEMALE_MODEL_YAW,
      placeholder
    );
    pivot.position.set(pos.x, FEMALE_CENTER_Y, pos.z); // hang below the rack
    pivot.rotation.y = baseYaws[i];
    model.add(pivot);
    return pivot;
  });

  // The triangle rack the females hang from — a frame above them, drawn
  // transparent so it doesn't obstruct the bodies below. Built as ONE flat
  // hexagonal ring (the triangle with its sharp corners cut off: 3 long
  // sides + 3 short corner sides) rather than 3 overlapping beams that
  // would clip and jitter where they meet.
  const edgeMat = new THREE.MeshBasicMaterial({
    color: LINE,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
  });
  {
    const cut = TRIANGLE_CORNER_CUT;
    // Rack corners sit further out than the females (RACK_CIRCUMRADIUS),
    // so the cut short sides land right above them.
    const rackV = vertexAngles.map(
      (a) =>
        new THREE.Vector3(
          Math.cos(a) * RACK_CIRCUMRADIUS,
          0,
          Math.sin(a) * RACK_CIRCUMRADIUS
        )
    );
    const A = [];
    const B = [];
    for (let i = 0; i < 3; i++) {
      const V = rackV[i];
      const next = rackV[(i + 1) % 3];
      const prev = rackV[(i + 2) % 3];
      const nLen = Math.hypot(next.x - V.x, next.z - V.z);
      const pLen = Math.hypot(prev.x - V.x, prev.z - V.z);
      A[i] = new THREE.Vector2(
        V.x + ((next.x - V.x) / nLen) * cut,
        V.z + ((next.z - V.z) / nLen) * cut
      );
      B[i] = new THREE.Vector2(
        V.x + ((prev.x - V.x) / pLen) * cut,
        V.z + ((prev.z - V.z) / pLen) * cut
      );
    }
    // Perimeter around the hexagon: long side, cut corner, long side, …
    const outer = [];
    for (let i = 0; i < 3; i++) outer.push(A[i], B[(i + 1) % 3]);
    const shape = new THREE.Shape(outer);
    const inner = outer
      .map((v) => {
        const f = (v.length() - TRIANGLE_BAR_WIDTH) / v.length();
        return new THREE.Vector2(v.x * f, v.y * f);
      })
      .reverse();
    shape.holes.push(new THREE.Path(inner));
    const rack = new THREE.Mesh(new THREE.ShapeGeometry(shape), edgeMat);
    rack.rotation.x = Math.PI / 2; // lay flat: shape (x, y) → world (x, z)
    rack.position.y = RACK_Y;
    model.add(rack);
  }

  // A thin guide ring tracing the path the paddles sweep through, at the
  // paddles' own height.
  const guideRing = new THREE.Mesh(
    new THREE.RingGeometry(GUIDE_RING_RADIUS - 0.012, GUIDE_RING_RADIUS + 0.012, 64),
    edgeMat
  );
  guideRing.rotation.x = -Math.PI / 2;
  guideRing.position.y = MALE_CENTER_Y;
  model.add(guideRing);

  // The rotor: the male — a single rigid bar that hangs above, with a
  // paddle riding at each end and hanging below it. The whole rotor sits
  // at the rack height and spins as one piece.
  const rotor = new THREE.Group();
  rotor.position.y = RACK_Y;
  model.add(rotor);

  // The bar — the real beam model, its long axis laid along the rotor's X so
  // it spans the two paddle ends. Semi-transparent so it doesn't obstruct the
  // bodies below. Scaled by its long axis (CAD Y) rather than its height.
  const beamMat = new THREE.MeshStandardMaterial({
    color: MALE,
    roughness: 0.45,
    metalness: 0,
    transparent: true,
    opacity: 0.6,
  });
  const bar = new THREE.Group();
  {
    const yawCal = new THREE.Group();
    yawCal.rotation.y = BEAM_MODEL_YAW;
    bar.add(yawCal);
    const fix = new THREE.Group();
    fix.rotation.x = -Math.PI / 2;
    yawCal.add(fix);
    const inner = new THREE.Group();
    fix.add(inner);
    loadModelGroup(MODEL_BASE + BEAM_PART).then((g) => {
      const mbox = new THREE.Box3();
      const tmp = new THREE.Box3();
      const clone = g.clone(true);
      clone.traverse((c) => {
        if (c.isMesh) {
          c.geometry.computeBoundingBox();
          mbox.union(tmp.copy(c.geometry.boundingBox));
          if (OUTLINE) {
            inner.add(
              new THREE.LineSegments(
                new THREE.EdgesGeometry(c.geometry, OUTLINE_ANGLE),
                new THREE.LineBasicMaterial({
                  color: MALE,
                  transparent: true,
                  opacity: 0.9,
                })
              )
            );
            c.visible = false;
          } else {
            c.material = beamMat;
            c.castShadow = true;
            c.receiveShadow = true;
          }
        }
      });
      if (!OUTLINE) inner.add(clone);
      const size = mbox.getSize(new THREE.Vector3());
      const center = mbox.getCenter(new THREE.Vector3());
      inner.position.set(-center.x, -center.y, -center.z);
      fix.scale.setScalar(INCH); // same scale as the figures → true bar length
    });
  }
  bar.position.y = BEAM_Y - RACK_Y; // the bar sits just below the armature plane
  rotor.add(bar);

  const paddleMat = new THREE.MeshStandardMaterial({
    color: MALE,
    roughness: 0.42,
    metalness: 0,
  });
  const paddleGeo = new THREE.BoxGeometry(MALE_DEPTH, MALE_HEIGHT, MALE_WIDTH);
  // bars[0] sits at local -X, bars[1] at local +X; both hang below the bar.
  const bars = [-1, 1].map((side) => {
    const placeholder = new THREE.Mesh(paddleGeo, paddleMat.clone());
    // The −X male is flipped 180° so its broad face also points outward
    // (mirroring the scene graph's rz:180 on male_2).
    const yaw = MALE_MODEL_YAW + (side === -1 ? Math.PI : 0);
    const pivot = buildFigure(MALE_PARTS, paddleMat.clone(), yaw, placeholder);
    pivot.position.set(side * ROTOR_RADIUS, MALE_CENTER_Y - RACK_Y, 0);
    rotor.add(pivot);
    return pivot;
  });

  // Ripples — expanding rings a body throws off when it flashes or
  // chimes, like a drop on a puddle. Each is a unit circle lying flat on
  // the XZ plane; the update scales it outward and fades it over its
  // life. One set (of RIPPLE_RINGS concentric rings) per figure color.
  function makeRippleSet(color) {
    const rings = [];
    for (let r = 0; r < RIPPLE_RINGS; r++) {
      const pts = [];
      for (let s = 0; s <= 64; s++) {
        const a = (s / 64) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      model.add(line);
      rings.push(line);
    }
    return rings;
  }
  const maleRipple = makeRippleSet(MALE);
  const femaleRipple = makeRippleSet(FEMALE);

  // prog is the ripple's life, 0 → 1+; each concentric ring trails the
  // one before it by RIPPLE_STAGGER, so a single flash reads as a few
  // rings chasing outward. Rings quick-fade in, then fade out as they
  // spread — brightest right at emission.
  function updateRipple(rings, center, prog) {
    rings.forEach((line, i) => {
      const p = prog - i * RIPPLE_STAGGER;
      if (p <= 0 || p >= 1) {
        line.visible = false;
        return;
      }
      line.visible = true;
      const radius = THREE.MathUtils.lerp(RIPPLE_MIN_R, RIPPLE_MAX_R, p);
      line.position.set(center.x, RIPPLE_Y, center.z);
      line.scale.set(radius, 1, radius);
      // Snap in fast, then hold most of the brightness until late in the
      // ring's life (1 - p^3) so the rings stay clearly visible as they
      // spread, rather than fading the moment they leave the body.
      line.material.opacity = Math.min(p * 8, 1) * (1 - p * p * p) * RIPPLE_PEAK;
    });
  }
  function hideRipples() {
    for (const line of [...maleRipple, ...femaleRipple]) line.visible = false;
  }

  // Comet — a small bright head trailing a thin line of light (a tube
  // rebuilt each frame from the head's recent path, so it bends through
  // the bounce and fades into the white ground at the tail).
  const bgColor = new THREE.Color(BG);
  const lightColor = new THREE.Color(LIGHT);

  const cometHead = new THREE.Mesh(
    new THREE.SphereGeometry(COMET_HEAD_R, 16, 16),
    new THREE.MeshBasicMaterial({ color: LIGHT })
  );
  cometHead.visible = false;
  model.add(cometHead);

  // A real light riding the head — kept in the scene at zero intensity
  // when idle (so no shader recompile) and lit only while travelling.
  const beamLight = new THREE.PointLight(
    LIGHT,
    0,
    BEAM_LIGHT_DISTANCE,
    BEAM_LIGHT_DECAY
  );
  model.add(beamLight);

  // The standing connection the beam leaves behind — a thin amber tube
  // between the two faces, painted as the comet first crosses and then
  // held (gently breathing) to the end.
  const persistentLine = new THREE.Mesh(
    new THREE.CylinderGeometry(PERSIST_R, PERSIST_R, 1, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: LIGHT,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    })
  );
  persistentLine.frustumCulled = false;
  persistentLine.visible = false;
  model.add(persistentLine);
  let persistPulse = false;
  let persistBase = 0;
  const _persistClock = new THREE.Clock();
  const _pPaddle = new THREE.Vector3();
  const _pFemale = new THREE.Vector3();
  const _pFrom = new THREE.Vector3();
  const _pTip = new THREE.Vector3();
  const _pDir = new THREE.Vector3();

  const cometTail = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
    })
  );
  cometTail.frustumCulled = false;
  cometTail.visible = false;
  model.add(cometTail);

  // Orthogonal shock rings that burst from the launch (male) and bounce
  // (female) points, oriented vertically (plane ⟂ to the beam axis).
  const launchRipple = makeRippleSet(LIGHT);
  const bounceRipple = makeRippleSet(LIGHT);
  const _UP = new THREE.Vector3(0, 1, 0);
  const _axis = new THREE.Vector3();
  const _maleFace = new THREE.Vector3();
  const _femaleFace = new THREE.Vector3();

  function updateOrthoRipple(rings, center, axisDir, prog) {
    rings.forEach((line, i) => {
      const p = prog - i * RIPPLE_STAGGER;
      if (p <= 0 || p >= 1) {
        line.visible = false;
        return;
      }
      line.visible = true;
      const radius = THREE.MathUtils.lerp(ORTHO_RIPPLE_MIN_R, ORTHO_RIPPLE_MAX_R, p);
      line.position.set(center.x, COMET_Y, center.z);
      line.quaternion.setFromUnitVectors(_UP, axisDir); // stand the ring up ⟂ to the beam
      line.scale.set(radius, 1, radius);
      line.material.opacity = Math.min(p * 8, 1) * (1 - p * p * p) * RIPPLE_PEAK;
    });
  }
  function hideOrthoRipples() {
    for (const line of [...launchRipple, ...bounceRipple]) line.visible = false;
  }

  // Position along a piecewise-linear bounce path of alternating
  // endpoints, s in [0,1] over the whole exchange, eased into and out of
  // each contact so the light seems caught and thrown back.
  function cometPos(s, endpoints, out) {
    const legs = endpoints.length - 1;
    const x = THREE.MathUtils.clamp(s, 0, 1) * legs;
    const leg = Math.min(Math.floor(x), legs - 1);
    const l = x - leg;
    const e = l * l * (3 - 2 * l);
    return out.lerpVectors(endpoints[leg], endpoints[leg + 1], e);
  }

  const _cometTmp = new THREE.Vector3();
  const _tailColor = new THREE.Color();
  const _tan = new THREE.Vector3();
  const _nrm = new THREE.Vector3();
  const _bin = new THREE.Vector3();
  const RADIAL = 8;
  // Build a tapered tube by hand — TubeGeometry can't vary its radius.
  // The cross-section shrinks from COMET_HEAD_R at the head to nothing at
  // the tail, so the rounded head ball flows into the tail as one
  // continuous teardrop rather than a ball with a line stuck to it.
  function buildTailGeometry(pts) {
    const N = pts.length;
    const stride = RADIAL + 1;
    const positions = new Float32Array(N * stride * 3);
    const colors = new Float32Array(N * stride * 3);
    const indices = [];
    for (let i = 0; i < N; i++) {
      // Tangent along the path; the path is planar (constant y), so a
      // fixed up vector gives a stable ring frame with no twisting.
      if (i < N - 1) _tan.subVectors(pts[i + 1], pts[i]);
      else _tan.subVectors(pts[i], pts[i - 1]);
      _tan.normalize();
      _nrm.crossVectors(_UP, _tan);
      if (_nrm.lengthSq() < 1e-8) _nrm.set(1, 0, 0);
      else _nrm.normalize();
      _bin.crossVectors(_tan, _nrm).normalize();

      const f = i / (N - 1); // 0 tail → 1 head
      const r = COMET_HEAD_R * Math.pow(f, 1.2); // taper thin → head
      _tailColor.copy(bgColor).lerp(lightColor, Math.min(1, 0.12 + f * 1.1));
      for (let j = 0; j <= RADIAL; j++) {
        const a = (j / RADIAL) * Math.PI * 2;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const k = (i * stride + j) * 3;
        positions[k] = pts[i].x + r * (cos * _nrm.x + sin * _bin.x);
        positions[k + 1] = pts[i].y + r * (cos * _nrm.y + sin * _bin.y);
        positions[k + 2] = pts[i].z + r * (cos * _nrm.z + sin * _bin.z);
        colors[k] = _tailColor.r;
        colors[k + 1] = _tailColor.g;
        colors[k + 2] = _tailColor.b;
      }
    }
    for (let i = 0; i < N - 1; i++) {
      for (let j = 0; j < RADIAL; j++) {
        const a = i * stride + j;
        const b = a + stride;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
  }

  function showComet(s, endpoints) {
    cometHead.visible = true;
    cometPos(s, endpoints, _cometTmp);
    cometHead.position.set(_cometTmp.x, COMET_Y, _cometTmp.z);

    // The head's light rides just above it, fading in/out at the launch
    // and return so it doesn't pop on and off.
    const sFade = THREE.MathUtils.clamp(Math.min(s, 1 - s) / 0.12, 0, 1);
    beamLight.position.set(_cometTmp.x, COMET_Y + 0.12, _cometTmp.z);
    beamLight.intensity = BEAM_LIGHT_INTENSITY * sFade;

    // Sample the head's recent path, tail → head, dropping duplicates so
    // the curve stays valid when samples pile up at the start or a bounce.
    const pts = [];
    for (let i = TRAIL_COUNT; i >= 0; i--) {
      const v = new THREE.Vector3();
      cometPos(s - i * TRAIL_DT, endpoints, v);
      v.y = COMET_Y;
      if (pts.length === 0 || v.distanceToSquared(pts[pts.length - 1]) > 1e-6) {
        pts.push(v);
      }
    }
    cometTail.geometry.dispose();
    if (pts.length >= 2) {
      cometTail.geometry = buildTailGeometry(pts);
      cometTail.visible = true;
    } else {
      cometTail.geometry = new THREE.BufferGeometry();
      cometTail.visible = false;
    }
  }
  function hideComet() {
    cometHead.visible = false;
    cometTail.visible = false;
    beamLight.intensity = 0;
    hideOrthoRipples();
  }

  // The persistent line the beam paints, driven purely by interaction
  // progress t so it's fully scrubbable: hidden until the exchange begins
  // (CAM_END_T), painted male→female as the comet makes its first crossing
  // (reaching full at the bounce, tip tracking the comet head so the two
  // read as one), then held full through the finale where it breathes.
  function updatePersistentTrail(t) {
    if (!successEvent || t < CAM_END_T) {
      persistentLine.visible = false;
      persistPulse = false;
      return;
    }
    model.updateMatrixWorld(true);
    spheres[successEvent.female].getWorldPosition(_pFemale);
    bars[successEvent.end].getWorldPosition(_pPaddle);
    _axis.set(_pFemale.x - _pPaddle.x, 0, _pFemale.z - _pPaddle.z).normalize();
    _maleFace.set(_pPaddle.x, COMET_Y, _pPaddle.z).addScaledVector(_axis, MALE_FACE_OFFSET);
    _femaleFace
      .set(_pFemale.x, COMET_Y, _pFemale.z)
      .addScaledVector(_axis, -FEMALE_FACE_OFFSET);

    // Fraction of the male→female line painted so far. Uses the comet's
    // own leg-0 easing (full by the bounce at s=0.5) so the paint tip
    // sits exactly under the comet head as it lays the line down.
    const s = THREE.MathUtils.clamp(
      (t - CAM_END_T) / (GLOW_START_T - CAM_END_T),
      0,
      1
    );
    const local = THREE.MathUtils.clamp(2 * s, 0, 1);
    const paint = local * local * (3 - 2 * local);

    _pFrom.set(_maleFace.x, COMET_Y, _maleFace.z);
    _pTip.set(
      THREE.MathUtils.lerp(_maleFace.x, _femaleFace.x, paint),
      COMET_Y,
      THREE.MathUtils.lerp(_maleFace.z, _femaleFace.z, paint)
    );
    _pDir.subVectors(_pTip, _pFrom);
    const length = _pDir.length();
    if (length < 1e-3) {
      persistentLine.visible = false;
      persistPulse = false;
      return;
    }
    _pDir.normalize();
    persistentLine.visible = true;
    persistentLine.position.set(
      (_pFrom.x + _pTip.x) / 2,
      COMET_Y,
      (_pFrom.z + _pTip.z) / 2
    );
    persistentLine.quaternion.setFromUnitVectors(_UP, _pDir);
    persistentLine.scale.set(1, length, 1);

    persistBase = PERSIST_OPACITY;
    persistPulse = paint >= 1; // breathe only once the full line stands
    persistentLine.material.opacity = persistBase;
  }

  // Where, in the rotor's own rotation (θ, radians), does a given paddle
  // end line up with a given body? bars[1] (local +X) reaches world
  // angle -θ; bars[0] (local -X) reaches world angle π-θ.
  function eventTheta(female, end) {
    const phi = vertexAngles[female];
    return end === 1
      ? THREE.MathUtils.euclideanModulo(-phi, Math.PI * 2)
      : THREE.MathUtils.euclideanModulo(Math.PI - phi, Math.PI * 2);
  }

  // Unwrap each successive target angle past the previous one (adding
  // full turns as needed) so the rotor only ever spins forward across
  // the whole sequence, never backward, even though each raw angle on
  // its own is only known mod 2π.
  let prevTheta = 0;
  const events = EVENTS_CONFIG.map((cfg) => {
    let theta = eventTheta(cfg.female, cfg.end);
    while (theta <= prevTheta) theta += Math.PI * 2;
    prevTheta = theta;
    return { ...cfg, theta, holdStart: cfg.t0 - cfg.holdHalf, holdEnd: cfg.t0 + cfg.holdHalf };
  });
  const eventByFemale = new Map(events.map((ev) => [ev.female, ev]));

  // The scripted success is the finale. The camera pushes in from plan
  // view into the 3D close-up over [CAM_START_T, CAM_END_T] — finishing
  // BEFORE the comet's exchange, so the back-and-forth is watched up close
  // — then the pair hold a steady mutual glow from GLOW_START_T (the
  // comet's return) to the very end. The two windows are timed off the
  // success event's hold so they stay aligned if its timing changes.
  const successEvent = events.find((ev) => ev.outcome === 'success');
  const successDur = successEvent ? successEvent.holdEnd - successEvent.holdStart : 0;
  const CAM_START_T = successEvent ? successEvent.holdStart : Infinity;
  const CAM_END_T = successEvent
    ? successEvent.holdStart + EXCHANGE_RANGE[0] * successDur
    : Infinity;
  const GLOW_START_T = successEvent
    ? successEvent.holdStart + EXCHANGE_RANGE[1] * successDur
    : Infinity;

  // A schedule of spin/hold segments: a constant rate carries the rotor
  // from one hold to the next, each rate solved so the rotor arrives at
  // that event's exact target angle just as its hold begins.
  const rotorSegments = [];
  {
    let segStart = 0;
    let segTheta = 0;
    events.forEach((ev) => {
      const rate = (ev.theta - segTheta) / (ev.holdStart - segStart);
      rotorSegments.push({ tStart: segStart, tEnd: ev.holdStart, thetaStart: segTheta, rate });
      rotorSegments.push({ tStart: ev.holdStart, tEnd: ev.holdEnd, theta: ev.theta });
      segStart = ev.holdEnd;
      segTheta = ev.theta;
    });
    // If the last encounter is the successful one, the rotor stays put at
    // that engagement angle to the end — they've locked on, not moved on —
    // so the finale close-up holds on a paired, aligned couple. Otherwise
    // it keeps drifting at the previous rate.
    const lastEvent = events[events.length - 1];
    const finalRate =
      lastEvent && lastEvent.outcome === 'success'
        ? 0
        : rotorSegments[rotorSegments.length - 2].rate;
    rotorSegments.push({ tStart: segStart, tEnd: 1, thetaStart: segTheta, rate: finalRate });
  }

  function rotorAngleAt(t) {
    for (const seg of rotorSegments) {
      if (t <= seg.tEnd) {
        return 'theta' in seg ? seg.theta : seg.thetaStart + seg.rate * (t - seg.tStart);
      }
    }
    const last = rotorSegments[rotorSegments.length - 1];
    return last.thetaStart + last.rate * (t - last.tStart);
  }

  // Smooth 0 → 1 → 0 bump for u inside [start, end] (as a fraction of a
  // local 0–1 range), 0 outside it — used for the brief flash/chime cues.
  function pulse(u, start, end) {
    if (u < start || u > end) return 0;
    const local = (u - start) / (end - start);
    return Math.sin(Math.PI * local);
  }

  function resize(width, height) {
    aspect = width / height;
    // Scale by the narrower dimension so the model never clips on tall
    // (portrait/mobile) viewports — only the wider axis grows past it.
    const halfHeight = frustumHalfHeight / Math.min(1, aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function setCameraOrbit(phi, theta, radius) {
    camera.position.set(
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(0, 0, 0);
  }

  // progressA: 0 → 1 tilts the camera from oblique to directly overhead.
  function setDescent(progressA) {
    const t = THREE.MathUtils.clamp(progressA, 0, 1);
    const eased = t * t * (3 - 2 * t); // smoothstep
    const phi = THREE.MathUtils.lerp(PHI_START, PHI_END, eased);
    const theta = THREE.MathUtils.lerp(THETA_START, THETA_END, eased);
    const radius = THREE.MathUtils.lerp(ORBIT_RADIUS, ORBIT_RADIUS_TOP, eased);
    setCameraOrbit(phi, theta, radius);
  }

  const _engFemalePos = new THREE.Vector3();
  const _engPaddlePos = new THREE.Vector3();
  const _engMid = new THREE.Vector3();
  const _engTarget = new THREE.Vector3();
  const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // fin: 0 → 1 lifts the camera out of the overhead plan view (matching
  // setDescent's held end state at fin=0) into an oblique, zoomed-in 3D
  // shot re-centered on the two engaged figures. Orthographic, so the
  // "zoom" is camera.zoom and the 3D read comes from the polar tilt.
  function setEngagementCamera(fin) {
    const e = THREE.MathUtils.smoothstep(fin, 0, 1);

    model.updateMatrixWorld(true);
    spheres[successEvent.female].getWorldPosition(_engFemalePos);
    bars[successEvent.end].getWorldPosition(_engPaddlePos);
    _engMid.addVectors(_engFemalePos, _engPaddlePos).multiplyScalar(0.5);
    _engMid.y += 0.3; // aim a touch above the ground plane

    // View the pair from ENGAGE_AXIS_OFFSET off their axis — not straight
    // across (which would show the vertical shock rings edge-on), but not
    // straight along it either — picking the side with the smallest swing
    // off overhead. This keeps both figures separated while letting the
    // rings read as ellipses.
    const axisAz = Math.atan2(_engMid.x, _engMid.z);
    const candA = wrapAngle(axisAz + ENGAGE_AXIS_OFFSET);
    const candB = wrapAngle(axisAz - ENGAGE_AXIS_OFFSET);
    const engageTheta = Math.abs(candB) < Math.abs(candA) ? candB : candA;

    const phi = THREE.MathUtils.lerp(PHI_END, ENGAGE_PHI, e);
    const theta = THREE.MathUtils.lerp(THETA_END, engageTheta, e);
    const radius = THREE.MathUtils.lerp(ORBIT_RADIUS_TOP, ENGAGE_RADIUS, e);
    _engTarget.set(0, 0, 0).lerp(_engMid, e);

    camera.position.set(
      _engTarget.x + radius * Math.sin(phi) * Math.sin(theta),
      _engTarget.y + radius * Math.cos(phi),
      _engTarget.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(_engTarget);
    camera.zoom = THREE.MathUtils.lerp(1, ENGAGE_ZOOM, e);
    camera.updateProjectionMatrix();
  }

  // progressB: 0 → 1. Spins the rotor at a constant rate around the
  // centroid, except for a dead stop at each scripted event where a
  // paddle end lines up with a body. Every body otherwise swivels ±30°
  // continuously; only the body involved in a given encounter eases to
  // a stop facing the centroid square-on, and only for that encounter's
  // duration — the other two keep swiveling throughout. During a stop,
  // the male flashes first (throwing off a ripple), the female answers
  // with a chime (and her own ripple), and only on the scripted
  // "success" encounter does that lead into an exchange — a comet of
  // light bounces back and forth between the two, then both settle into
  // a sustained mutual glow with the comet gone — the scripted "fail"
  // encounter stops at the chime and simply resumes. On the success, the
  // camera rotates out of plan view into an oblique 3D close-up on the
  // pair *before* the comet, so the exchange plays out up close, and holds
  // that framing to the end.
  function setInteraction(progressB) {
    const t = THREE.MathUtils.clamp(progressB, 0, 1);

    rotor.rotation.y = rotorAngleAt(t);

    // Each body scans back and forth; only a body with a scripted
    // encounter eases to a dead stop (facing the centroid) for its
    // encounter's duration.
    spheres.forEach((sphere, i) => {
      const raw = Math.sin(t * Math.PI * 2 * SWIVEL_FREQUENCIES[i]);
      const ev = eventByFemale.get(i);
      let envelope = ev ? holdEnvelope(t, ev.t0, ev.holdHalf, HOLD_TAPER) : 1;
      // The engaged female never resumes swivelling once she has locked
      // on — she stays facing the centroid (and the male) through the end.
      if (ev && ev.outcome === 'success' && t >= ev.holdStart) envelope = 0;
      sphere.rotation.y = baseYaws[i] + raw * SWIVEL_AMPLITUDE * envelope;
      setEmissive(sphere, 0x000000, 0);
    });

    bars.forEach((paddle) => {
      setEmissive(paddle, 0x000000, 0);
    });

    const active = events.find((ev) => t >= ev.holdStart && t <= ev.holdEnd);
    if (!active) {
      hideRipples();
      hideComet();
    } else {
      const female = spheres[active.female];
      const paddle = bars[active.end];
      const dur = active.holdEnd - active.holdStart;
      const u = (t - active.holdStart) / dur;

      // World positions of the two meeting points — needed both for the
      // ripple centers and, on a success, for the comet's bounce endpoints.
      model.updateMatrixWorld(true);
      const femalePos = new THREE.Vector3();
      const paddlePos = new THREE.Vector3();
      female.getWorldPosition(femalePos);
      paddle.getWorldPosition(paddlePos);

      // Beat 1: the male flashes first — a paddle flare and a cyan ripple.
      const flash = pulse(u, FLASH_RANGE[0], FLASH_RANGE[1]) * FLASH_MAX;
      if (flash > 0) setEmissive(paddle, MALE, flash);
      updateRipple(
        maleRipple,
        paddlePos,
        (u - FLASH_RANGE[0]) / (FLASH_RANGE[1] + RIPPLE_TAIL - FLASH_RANGE[0])
      );

      // Beat 2: the female answers — a body flare and a magenta ripple.
      const chime = pulse(u, CHIME_RANGE[0], CHIME_RANGE[1]) * CHIME_MAX;
      if (chime > 0) setEmissive(female, FEMALE, chime);
      updateRipple(
        femaleRipple,
        femalePos,
        (u - CHIME_RANGE[0]) / (CHIME_RANGE[1] + RIPPLE_TAIL - CHIME_RANGE[0])
      );

      // The exchange + lock only ever play out on a 'success' encounter.
      if (active.outcome !== 'success') {
        hideComet();
      } else if (u >= EXCHANGE_RANGE[0] && u <= EXCHANGE_RANGE[1]) {
        // The comet leaves the male, bounces off the female, and returns
        // (BOUNCE_LEGS crossings along the two alternating endpoints). Its
        // endpoints sit just outside each body's face, not at its centre,
        // so the launch and bounce are clearly visible.
        const s = (u - EXCHANGE_RANGE[0]) / (EXCHANGE_RANGE[1] - EXCHANGE_RANGE[0]);
        // Horizontal beam axis (the bodies sit at different heights, so
        // ignore y); both faces pinned to the beam height COMET_Y.
        _axis.set(femalePos.x - paddlePos.x, 0, femalePos.z - paddlePos.z).normalize();
        _maleFace.set(paddlePos.x, COMET_Y, paddlePos.z).addScaledVector(_axis, MALE_FACE_OFFSET);
        _femaleFace
          .set(femalePos.x, COMET_Y, femalePos.z)
          .addScaledVector(_axis, -FEMALE_FACE_OFFSET);
        const endpoints = [];
        for (let i = 0; i <= BOUNCE_LEGS; i++) {
          endpoints.push(i % 2 === 0 ? _maleFace : _femaleFace);
        }
        showComet(s, endpoints);

        // Orthogonal shock rings from those same face points: one bursts
        // from the male as the beam launches (s≈0), one from the female as
        // it bounces off (s≈1/BOUNCE_LEGS).
        updateOrthoRipple(launchRipple, _maleFace, _axis, s / BEAM_RIPPLE_DUR);
        updateOrthoRipple(
          bounceRipple,
          _femaleFace,
          _axis,
          (s - 1 / BOUNCE_LEGS) / BEAM_RIPPLE_DUR
        );

        // The mobile the comet is arriving at brightens as it nears; the
        // one it just left dims — the light visibly passes on each bounce.
        const x = THREE.MathUtils.clamp(s, 0, 1) * BOUNCE_LEGS;
        const leg = Math.min(Math.floor(x), BOUNCE_LEGS - 1);
        const l = x - leg;
        const e = l * l * (3 - 2 * l);
        const fromIsFemale = leg % 2 === 1; // legs start paddle→female
        setEmissive(female, FEMALE, (fromIsFemale ? 1 - e : e) * BEAM_GLOW);
        setEmissive(paddle, MALE, (fromIsFemale ? e : 1 - e) * BEAM_GLOW);
      } else {
        // Comet has landed; the sustained glow + camera move are handled
        // by the engagement finale below, which outlives this event.
        hideComet();
      }
    }

    // Engagement finale — both parts outlive the success event's window,
    // so they run whether or not an event is currently "active".

    // Camera pushes into the 3D close-up first, finishing before the comet
    // so the exchange plays out up close, then holds the framing to the end.
    if (t >= CAM_START_T) {
      const fin = THREE.MathUtils.clamp(
        (t - CAM_START_T) / (CAM_END_T - CAM_START_T),
        0,
        1
      );
      setEngagementCamera(fin);
    } else if (camera.zoom !== 1) {
      // Scrolled back out of the finale — restore the plan-view zoom (the
      // overhead position/target are reset each frame by setDescent(1)).
      camera.zoom = 1;
      camera.updateProjectionMatrix();
    }

    // Once the comet has returned, the pair settle into a sustained mutual
    // glow held to the end — overriding the event's own fading lock glow so
    // it stays steady, and outlasting the event window entirely.
    if (t >= GLOW_START_T) {
      const female = spheres[successEvent.female];
      const paddle = bars[successEvent.end];
      setEmissive(female, FEMALE, ENGAGE_GLOW);
      setEmissive(paddle, MALE, ENGAGE_GLOW);
    }

    // The beam's painted, lingering connection between the two.
    updatePersistentTrail(t);
  }

  setDescent(0);
  setInteraction(0);

  function render() {
    // Gentle, time-based breathing of the standing connection — the one
    // non-scroll-driven motion, so it keeps living even at a dead stop.
    if (persistentLine.visible && persistPulse) {
      const pulse = 0.78 + 0.22 * Math.sin(_persistClock.getElapsedTime() * 1.8);
      persistentLine.material.opacity = persistBase * pulse;
    }
    renderer.render(scene, camera);
  }

  return { scene, camera, renderer, model, spheres, bars, resize, setDescent, setInteraction, render };
}
