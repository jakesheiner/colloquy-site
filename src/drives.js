/**
 * The five bodies' drive levels and behavioural state, tick by tick.
 *
 * The player plays the recording but does not report what any body *wants* —
 * `getStatus()` is playback only and `getEvents()` is state *changes*, not
 * levels. Both of those are in the clip though, so this reads them out of the
 * recording directly and builds a table the page can index at any tick.
 *
 * The clip's shape (see HANDOFF §5): `behavioral.frame.values` is a flat list of
 * `{ path, class, vars }`, present in full on the snapshot and on every
 * keyframe (one in forty ticks), and in between only as `frameDelta.changed` —
 * the same shape carrying only the vars that moved. Values therefore **carry
 * forward**, which is what the walk below does.
 *
 * The two paths that matter per body:
 *
 *   `<id>`         class `mobile` — `state`, one of engaging-partner /
 *                  satisfaction-search / satisfied-and-indifferent
 *   `<id>/drive`   class `drive`  — `internal_level_O`, `internal_level_P`, and
 *                  the limits both are measured against
 *
 * A level is a hunger, not a reserve: it climbs while the drive goes unanswered
 * and falls when it is met, and a body reads as spent once both sit below
 * `internal_drive_lower_limit` — which is the sense in which the page's prose
 * already says "both drives below their limit".
 */

const UNIT_PATH = /^(female|male)_\d+$/;

/** Levels are stored per tick per unit, so the read at draw time is an index. */
export function readDriveTrack(recording) {
  const snapshot = recording?.snapshot?.behavioral;
  const entries = recording?.entries ?? [];
  if (!snapshot?.frame?.values) return null;

  // `males`/`females` carry the id → label table. They also carry forward, so
  // the snapshot's copy is the whole cast.
  const units = [
    ...(snapshot.females ?? []).map((u) => ({ ...u, side: 'female' })),
    ...(snapshot.males ?? []).map((u) => ({ ...u, side: 'male' })),
  ]
    .filter((u) => u?.id)
    .map((u) => ({
      id: u.id,
      label: u.label ?? u.id,
      // "Female A" → "A", "Male II" → "II". The dot already says which side.
      short: (u.label ?? u.id).split(/\s+/).pop(),
      side: u.side,
    }));

  if (units.length === 0) return null;

  const count = entries.length + 1; // the snapshot's own tick, then one per entry
  const stateNames = [];
  const stateIndex = new Map();
  const stateOf = (name) => {
    if (!name) return 255;
    let i = stateIndex.get(name);
    if (i === undefined) {
      i = stateNames.push(name) - 1;
      stateIndex.set(name, i);
    }
    return i;
  };

  const width = units.length;
  const state = new Uint8Array(count * width).fill(255);
  const levelO = new Float32Array(count * width);
  const levelP = new Float32Array(count * width);
  const ticks = new Int32Array(count);

  // path → accumulated vars. Every frame is this object, carried forward.
  const vars = new Map();
  const apply = (values) => {
    for (const value of values ?? []) {
      if (!value?.path) continue;
      Object.assign(
        vars.get(value.path) ?? vars.set(value.path, {}).get(value.path),
        value.vars
      );
    }
  };
  const forget = (paths) => {
    for (const path of paths ?? []) vars.delete(path);
  };

  let lowerLimit = 0;
  let upperLimit = 0;
  let ceiling = 0;

  const sample = (row, tick) => {
    ticks[row] = tick;
    for (let i = 0; i < width; i++) {
      const mobile = vars.get(units[i].id);
      const drive = vars.get(`${units[i].id}/drive`);
      const at = row * width + i;
      if (mobile?.state !== undefined) state[at] = stateOf(mobile.state);
      if (!drive) continue;
      const o = drive.internal_level_O ?? 0;
      const p = drive.internal_level_P ?? 0;
      levelO[at] = o;
      levelP[at] = p;
      if (o > ceiling) ceiling = o;
      if (p > ceiling) ceiling = p;
      if (drive.internal_drive_lower_limit) lowerLimit = drive.internal_drive_lower_limit;
      if (drive.internal_drive_upper_limit) upperLimit = drive.internal_drive_upper_limit;
    }
  };

  apply(snapshot.frame.values);
  sample(0, snapshot.tick ?? recording.snapshot?.tick ?? 0);

  for (let e = 0; e < entries.length; e++) {
    const message = entries[e].message ?? {};
    const full = message.behavioral?.frame?.values;
    if (full) apply(full);
    else {
      forget(message.frameDelta?.removed);
      apply(message.frameDelta?.changed);
    }
    sample(e + 1, entries[e].tick);
  }

  // Levels run past the upper limit — the recording tops out at 4800 against an
  // upper limit of 3600 — so the bars are scaled to what the clip actually
  // reaches, not to the limit, or the fullest ones would clip.
  const scale = ceiling > 0 ? ceiling : 1;

  return {
    units,
    count,
    lowerLimit,
    upperLimit,
    ceiling,
    /** Where the lower limit sits on a bar, 0…1 — the "spent" line. */
    lowerMark: lowerLimit / scale,

    /**
     * Fill `out` with each unit's state and its two drives as fractions of the
     * bar. `out` is reused across frames rather than allocated: this runs on
     * every frame the scroll position changes.
     */
    read(progress, out) {
      const row = Math.min(
        count - 1,
        Math.max(0, Math.round(progress * (count - 1)))
      );
      for (let i = 0; i < width; i++) {
        const at = row * width + i;
        const slot = out[i] ?? (out[i] = { state: '', o: 0, p: 0 });
        slot.state = stateNames[state[at]] ?? '';
        slot.o = levelO[at] / scale;
        slot.p = levelP[at] / scale;
      }
      return out;
    },

    tickAt(row) {
      return ticks[Math.min(count - 1, Math.max(0, row))];
    },
  };
}
