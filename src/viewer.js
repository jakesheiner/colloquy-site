import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// ---------------------------------------------------------------------------
// Catalog. Two scene-graph assemblies (parsed from the JSON schema) plus every
// individual OBJ part, grouped by which body it belongs to.
// ---------------------------------------------------------------------------
const SCENES = [
  {
    id: 'sim',
    label: 'Full simulation',
    tag: '3F · 2M · bar',
    json: '/scenes/colloquy-of-mobiles-virtual-simulation-260705.json',
  },
  {
    id: 'env',
    label: 'Environment rung',
    tag: '1F · 2M',
    json: '/scenes/environment-female-facing-0-and-bar-with-male-facing-0-and-male-facing-180.json',
  },
];

const PARTS = [
  {
    group: 'Female',
    items: [
      'female-shell-body-260316.obj',
      'female-shell-head-260316.obj',
      'female-armature-260316.obj',
      'female-mirror-260316.obj',
      'female-interiorled-upper-260316.obj',
      'female-interiorled-middle-260316.obj',
      'female-interiorled-lower-260316.obj',
    ],
  },
  {
    group: 'Male',
    items: [
      'male-body-260316.obj',
      'male-splodges-static-upper-260713.obj',
      'male-splodges-static-lower-260714.obj',
      'male-indicator-drivelevel-260316.obj',
      'male-indicator-drivelevel-support-260316.obj',
      'male-indicator-intermittent-260316.obj',
      'male-indicator-drive-O-260316.obj',
      'male-indicator-drive-P-260316.obj',
    ],
  },
  {
    group: 'Bar / structure',
    items: [
      'beam-260316.obj',
      'beam-indicator-male1-260316.obj',
      'beam-indicator-male2-260316.obj',
      'plinth_edge_260710.obj',
    ],
  },
];

// ---------------------------------------------------------------------------
// three.js boilerplate
// ---------------------------------------------------------------------------
const canvas = document.querySelector('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0f12);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(120, 90, 150);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.autoRotateSpeed = 1.2;

// lighting — key + fill + hemisphere, on top of the IBL environment
const hemi = new THREE.HemisphereLight(0xffffff, 0x2a2c33, 0.55);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(80, 140, 60);
scene.add(key);
const fill = new THREE.DirectionalLight(0xbcd0ff, 0.6);
fill.position.set(-90, 40, -70);
scene.add(fill);

// helpers (grid + axes), rebuilt to fit each model
let helpers = new THREE.Group();
scene.add(helpers);

// the currently-shown content lives under `current`; swapped on each load
let current = null;

const hud = {
  title: document.querySelector('#hud-title'),
  meta: document.querySelector('#hud-meta'),
};
const loadingEl = document.querySelector('#loading');

// ---------------------------------------------------------------------------
// Materials — a light tint by body (female warm, male cool), indicators glow,
// mirrors read as polished metal. Keeps the geometry legible without pretending
// to be a final render.
// ---------------------------------------------------------------------------
// Female = magenta, male = cyan (matching the scroll site's mapping). Bodies
// take the saturated hue; indicators glow a brighter tint of the same family;
// structure (armature, beam, plinth) stays neutral so it reads as scaffold.
const FEMALE = 0xe0189a;
const MALE = 0x2bc4d6;

// Classify off the geometry FILENAME (much cleaner than node names, where e.g.
// the head's node is confusingly called "LEDsupport"). `key` is the basename.
function materialFor(block, key) {
  const name = (key || '').toLowerCase();
  const female = block === 'female_unit';
  const male = block === 'male_unit';
  const hue = female ? FEMALE : male ? MALE : 0x9aa0a8;

  if (/mirror(?!.*armature)/.test(name)) {
    return new THREE.MeshStandardMaterial({
      color: 0xd7dde3,
      metalness: 0.95,
      roughness: 0.12,
      envMapIntensity: 1.5,
    });
  }
  // glowing indicators / interior LEDs / drive lamps — a bright tint of the hue
  if (/interiorled|indicator|drive/.test(name)) {
    return new THREE.MeshStandardMaterial({
      color: female ? 0xff5ac8 : male ? 0x66e6f2 : 0xdfe4ea,
      emissive: female ? FEMALE : male ? MALE : 0x9aa0a8,
      emissiveIntensity: 1.15,
      roughness: 0.4,
      metalness: 0.0,
    });
  }
  // structure / scaffold — neutral so it reads as rig, not body
  if (/armature|support|plinth|beam|world/.test(name)) {
    return new THREE.MeshStandardMaterial({
      color: /beam|plinth|world/.test(name) ? 0x9aa0a8 : 0x3a3d44,
      metalness: 0.6,
      roughness: 0.45,
    });
  }
  // shells / bodies / heads / splodges — the saturated body color
  return new THREE.MeshStandardMaterial({
    color: hue,
    metalness: 0.2,
    roughness: 0.5,
    side: THREE.DoubleSide,
  });
}

function neutralMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xb9bcc4,
    metalness: 0.2,
    roughness: 0.55,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// OBJ loading with a small cache (parts get reused across the 3 females etc.)
// ---------------------------------------------------------------------------
const objLoader = new OBJLoader();
const objCache = new Map();

// Returns the loaded OBJ as a THREE.Group. The Rhino exports are often split
// into several `o object_N` sub-meshes, so we must keep the whole group (an
// earlier "first mesh only" shortcut silently dropped multi-object bodies like
// the male). Clone per instance; geometry is shared, materials are reassigned.
function loadObjModel(url) {
  if (!objCache.has(url)) {
    objCache.set(
      url,
      objLoader.loadAsync(url).then((group) => {
        group.traverse((c) => {
          if (c.isMesh && !c.geometry.getAttribute('normal'))
            c.geometry.computeVertexNormals();
        });
        return group;
      })
    );
  }
  return objCache.get(url);
}

function instanceOf(group, material) {
  const clone = group.clone(true); // recursive; shares geometry, not transforms
  clone.traverse((c) => {
    if (c.isMesh) c.material = material;
  });
  return clone;
}

// resolve a schema geometry reference ("models/foo.obj" or {mesh}) to a URL,
// or null if the file isn't in our public/models set.
const AVAILABLE = new Set(PARTS.flatMap((g) => g.items).concat([
  'male-splodges-static-upper-inverted-260713.obj',
  'male-splodges-static-lower-inverted-260714.obj',
]));
function geometryUrl(ref) {
  if (!ref) return null;
  const path = typeof ref === 'object' ? ref.mesh : ref;
  if (!path) return null;
  const base = path.split('/').pop();
  return AVAILABLE.has(base) ? `/models/${base}` : null;
}

// ---------------------------------------------------------------------------
// Scene-graph assembly. Units are inches, Z-up; joints carry an axis + an
// initialState.position (degrees) we bake in as a static pose. Instances place
// reusable blocks under a world node, with optional per-node overrides.
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;

function applyTransform(obj, t, axis, jointPos) {
  if (!t) return;
  obj.position.set(t.tx || 0, t.ty || 0, t.tz || 0);
  let rx = (t.rx || 0) * DEG,
    ry = (t.ry || 0) * DEG,
    rz = (t.rz || 0) * DEG;
  // a joint's initialState.position rotates about its own axis — fold it in
  if (jointPos) {
    if (axis === 'x') rx += jointPos * DEG;
    else if (axis === 'y') ry += jointPos * DEG;
    else rz += jointPos * DEG;
  }
  obj.rotation.set(rx, ry, rz, 'XYZ');
}

// build one node (world- or block-scoped) into an Object3D + its geometry
function buildNode(node, block, nodeName, override, pending) {
  const o = new THREE.Group();
  o.name = nodeName;
  const initState = (override && override.initialState) || node.initialState;
  applyTransform(
    o,
    (override && override.transform) || node.transform,
    node.axis,
    node.type === 'joint' && initState ? initState.position : 0
  );

  const ref = (override && override.geometry) || node.geometry;
  const url = geometryUrl(ref);
  if (url) {
    const key = url.split('/').pop(); // classify material off the filename
    const p = loadObjModel(url).then((group) => {
      o.add(instanceOf(group, materialFor(block, key)));
    });
    pending.push(p);
  }
  return o;
}

// build a tree of nodes keyed by name, wiring parents; returns the roots’
// container. `attachRoot(obj)` receives any node whose parent is outside scope.
function buildTree(nodes, block, overrides, pending, isRoot, attachRoot) {
  const built = {};
  function make(name) {
    if (built[name]) return built[name];
    const node = nodes[name];
    const o = buildNode(node, block, name, overrides && overrides[name], pending);
    built[name] = o;
    const parent = node.parent;
    if (parent && parent !== 'null' && parent !== 'None' && nodes[parent]) {
      make(parent).add(o);
    } else {
      attachRoot(o); // parent lives in an enclosing scope (or is the world root)
    }
    return o;
  }
  Object.keys(nodes).forEach(make);
  return built;
}

async function loadScene(def) {
  showLoading(true);
  const data = await fetch(def.json).then((r) => r.json());

  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2; // Z-up (modeling) -> Y-up (three)

  const pending = [];

  // 1) world scaffold (top-level `nodes`: environment, armature, beam, …)
  const topObjs = buildTree(
    data.nodes,
    'world',
    null,
    pending,
    true,
    (o) => root.add(o)
  );

  // 2) instances — place each block under its world parent node
  for (const inst of data.instances || []) {
    const block = data.blocks[inst.block];
    if (!block) continue;
    const parentObj = topObjs[inst.parent] || root;
    const instGroup = new THREE.Group();
    instGroup.name = inst.id;
    applyTransform(instGroup, inst.transform);
    parentObj.add(instGroup);
    buildTree(
      block.nodes,
      inst.block,
      inst.overrides,
      pending,
      false,
      (o) => instGroup.add(o) // block root(s) hang off the instance group
    );
  }

  await Promise.all(pending);

  swapCurrent(root);
  frame(root);
  const parts = pending.length;
  const fCount = (data.instances || []).filter((i) => i.block === 'female_unit').length;
  const mCount = (data.instances || []).filter((i) => i.block === 'male_unit').length;
  setHud(data.name || def.label, [
    `${fCount} female · ${mCount} male · ${parts} meshes`,
    data.metadata?.description || '',
  ]);
  showLoading(false);
}

async function loadPart(file) {
  showLoading(true);
  const group = await loadObjModel(`/models/${file}`);
  const root = new THREE.Group();
  const inst = instanceOf(group, neutralMaterial());
  // frame the part on its own — recenter about its combined bounding box
  const box = new THREE.Box3().setFromObject(inst);
  inst.position.sub(box.getCenter(new THREE.Vector3()));
  root.add(inst);

  swapCurrent(root);
  frame(root);
  setHud(file.replace(/-\d+\.obj$/, '').replace(/-/g, ' '), [
    file,
    `${countTris(group).toLocaleString()} triangles`,
  ]);
  showLoading(false);
}

function countTris(group) {
  let n = 0;
  group.traverse((c) => {
    if (c.isMesh) {
      const g = c.geometry;
      n += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return Math.round(n);
}

// ---------------------------------------------------------------------------
// view helpers
// ---------------------------------------------------------------------------
function swapCurrent(obj) {
  if (current) {
    scene.remove(current);
    current.traverse((c) => {
      if (c.isMesh && c.material?.dispose) c.material.dispose();
    });
  }
  current = obj;
  applyWireframe();
  scene.add(obj);
}

function frame(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fov = camera.fov * DEG;
  let dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.7;
  const dir = new THREE.Vector3(1, 0.55, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(0.1, dist / 200);
  camera.far = dist * 200;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = maxDim * 0.05;
  controls.maxDistance = dist * 8;
  controls.update();

  rebuildHelpers(box, maxDim);
}

function rebuildHelpers(box, maxDim) {
  scene.remove(helpers);
  helpers = new THREE.Group();
  const g = Math.ceil(maxDim * 2);
  const grid = new THREE.GridHelper(g, 20, 0x3a3f48, 0x23262c);
  grid.position.y = box.min.y;
  const axes = new THREE.AxesHelper(maxDim * 0.6);
  axes.position.copy(box.min);
  helpers.add(grid, axes);
  helpers.visible = gridToggle.checked;
  scene.add(helpers);
}

function setHud(title, lines) {
  hud.title.textContent = title;
  hud.meta.innerHTML = lines.filter(Boolean).join('<br>');
}
function showLoading(on) {
  loadingEl.classList.toggle('hidden', !on);
}

// ---------------------------------------------------------------------------
// UI — build catalog, wire toggles
// ---------------------------------------------------------------------------
const catalog = document.querySelector('#catalog');
const wireToggle = document.querySelector('#wireframe-toggle');
const gridToggle = document.querySelector('#grid-toggle');
const spinToggle = document.querySelector('#spin-toggle');
let activeBtn = null;

function addLabel(text) {
  const el = document.createElement('div');
  el.className = 'group-label';
  el.textContent = text;
  catalog.appendChild(el);
}
function addItem({ label, tag, sceneDot, onClick }) {
  const btn = document.createElement('button');
  btn.className = 'item' + (sceneDot ? ' scene' : '');
  if (sceneDot) {
    const d = document.createElement('span');
    d.className = 'dot';
    btn.appendChild(d);
  }
  const name = document.createElement('span');
  name.textContent = label;
  btn.appendChild(name);
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tag;
    btn.appendChild(t);
  }
  btn.addEventListener('click', () => {
    if (activeBtn) activeBtn.classList.remove('active');
    activeBtn = btn;
    btn.classList.add('active');
    onClick();
  });
  catalog.appendChild(btn);
  return btn;
}

addLabel('Scene graphs');
SCENES.forEach((s) =>
  addItem({ label: s.label, tag: s.tag, sceneDot: true, onClick: () => loadScene(s) })
);
PARTS.forEach((grp) => {
  addLabel(grp.group);
  grp.items.forEach((file) =>
    addItem({ label: prettyPart(file), onClick: () => loadPart(file) })
  );
});

function prettyPart(file) {
  return file
    .replace(/^female-|^male-|^beam-?/, '')
    .replace(/-\d+\.obj$/, '')
    .replace(/\.obj$/, '')
    .replace(/-/g, ' ')
    .trim();
}

function applyWireframe() {
  if (!current) return;
  current.traverse((c) => {
    if (c.isMesh) c.material.wireframe = wireToggle.checked;
  });
}
wireToggle.addEventListener('change', applyWireframe);
gridToggle.addEventListener('change', () => (helpers.visible = gridToggle.checked));
spinToggle.addEventListener('change', () => (controls.autoRotate = spinToggle.checked));

// ---------------------------------------------------------------------------
// resize + render loop
// ---------------------------------------------------------------------------
function resize() {
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// open on the full simulation
activeBtn = catalog.querySelector('.item.scene');
activeBtn.classList.add('active');
loadScene(SCENES[0]);
