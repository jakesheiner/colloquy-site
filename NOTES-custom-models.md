# Note: Using custom Fusion models for the figures

Reference for later — how to swap the procedural three.js figures in `src/scene.js`
for custom models built in Autodesk Fusion. Not yet implemented; this is the plan.

## Current setup (what gets replaced)

The "figures" are procedural three.js primitives, and the animation code reaches
directly into their `.geometry` / `.material`:

- **Three females** (`spheres[]` in `scene.js`): oval `SphereGeometry`, placed at
  `vertexPositions[i]`, yawed by `baseYaws[i]` so the sensor faces the centroid.
- **Male rotor** (`bar` + `bars[]` paddles): two paddles pinned at `±ROTOR_RADIUS` on
  the rotor's local X; the whole `rotor` group spins via `rotor.rotation.y`.

## What the animation requires of each figure (must be preserved)

Any custom model has to support every hook the interaction code uses:

Females (`spheres[]`):
- placed at `vertexPositions[i]`, yawed by `baseYaws[i]`
- `sphere.rotation.y = …`  — the ±30° swivel each frame
- `sphere.material.emissive` / `emissiveIntensity`  — the chime glow
- `sphere.getWorldPosition()`  — one beam endpoint

Male rotor (`bar` + `bars[]`):
- paddles at `±ROTOR_RADIUS` on rotor local X; rotor spun via `rotor.rotation.y`
- `paddle.material.emissive`  — the flash
- `paddle.getWorldPosition()`  — the other beam endpoint

The `setDescent` / `setInteraction` / beam math / event scheduling / swivel all stay
the same — only *what geometry sits at each anchor* changes.

## Fusion is CAD — export notes

Fusion is solid CAD, not a mesh/DCC tool. Fusion does NOT export glTF/GLB natively —
don't chase that format.

- **Export format: STL** (recommended, one `.stl` per body) or OBJ (`OBJLoader`, only if
  you want multiple named bodies in one file).
- **No materials/textures/appearances needed** — colors are assigned in code as flat
  magenta/cyan `MeshStandardMaterial`. Export pure geometry only.
- **STL bonus:** an STL loads as a single `BufferGeometry` → one `Mesh` that *has* a
  `.material`. This sidesteps the main glTF gotcha (a loaded glTF is a `Group` with no
  `.material`). With per-part STLs the emissive flash/chime/glow hooks work with almost
  no refactor — a near drop-in swap.

## Three Fusion-specific fixes to handle in code

1. **Axis:** Fusion is Z-up, three.js is Y-up, and the scene lays the triangle on the XZ
   plane. Each imported model needs a −90° X rotation (baked into a pivot wrapper).
2. **Scale + origin:** CAD exports in mm/cm, often with origin far from the geometry.
   Recenter each geometry (`geometry.center()`) and scale to a target size — so modeling
   units don't matter.
3. **Tessellation:** in Fusion's STL export dialog use Medium (or Low) refinement, not
   High. It's orthographic + top-down; huge triangle counts aren't needed and just bloat
   the file.

## What to export

Separate parts so they can be placed by the existing triangle/rotor logic:

- one **female** form (amber pendulous body) — instanced at the 3 triangle vertices
- one **male** element (paddle/pentagon piece) — instanced at both rotor ends
- keep the bar between the paddles procedural (or model it too — optional)

## Two gotchas (general)

1. A loaded glTF is a `Group`, not a `Mesh` → `group.material` is `undefined`, so
   `emissive.setHex(...)` silently breaks. STL avoids this; glTF would need traversing the
   model, collecting each child mesh's material (cloned so figures glow independently).
2. **Async loading:** ScrollTrigger + the render loop start immediately today; the loader
   resolves a few frames later. Either start rendering after models load, or keep the
   current primitives as placeholders and swap on load.

## Recommended implementation approach

Wrap each figure in a **pivot** `Object3D` that owns position + yaw (the things the
animation drives); the loaded model is a child carrying its own recenter/scale/axis-fix.
The animation keeps setting `pivot.rotation.y` and never cares what's inside. Add a small
`setEmissive(figure, hex, intensity)` helper (and, if wanted, an empty child at the
"sensor" point so the beam anchors to the eye, not the model centroid).

Suggested next step when resuming: scaffold `STLLoader` + pivot/recenter/axis-fix
plumbing pointed at a `models/` folder, with the current primitives kept as automatic
fallback until the `.stl` files exist. Then dropping `female.stl` / `male.stl` in just
works.

## Open questions to answer when resuming

1. Separate STLs for female and male, or exporting some other way?
2. Keep the swivel / flash-chime / beam-and-lock choreography exactly as-is, just with the
   new geometry? (vs. also reworking the animation — bigger scope.)
