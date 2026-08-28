/**
 * The five bodies' drive levels, behavioural state and beam, tick by tick.
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
 * The three paths that matter per body:
 *
 *   `<id>`             class `mobile` — `state`, one of engaging-partner /
 *                      satisfaction-search / satisfied-and-indifferent
 *   `<id>/drive`       class `drive`  — `internal_level_O`, `internal_level_P`,
 *                      and the limits both are measured against
 *   `<id>/transmitter` class `transmitter` — `act_transmitting_energetic_beam`,
 *                      true on a male for exactly as long as his beam is lit.
 *                      This is what `src/main.js` draws the beam from; see *The
 *                      beam* there.
 *   `<id>/receiver`    class `receiver` — `sense_reflected_light`, true on a
 *                      male while his light sensors are catching his own beam
 *                      back off a mirror. Turned into a flare envelope below.
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
  // Whether this body's beam is lit. Only males have one; a female's byte stays
  // 0 for the whole recording.
  const beaming = new Uint8Array(count * width);
  // Raw `sense_reflected_light`, and the flare envelope built off its rising
  // edges once the whole walk is done.
  const catching = new Uint8Array(count * width);
  const flare = new Float32Array(count * width);
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
      const transmitter = vars.get(`${units[i].id}/transmitter`);
      const receiver = vars.get(`${units[i].id}/receiver`);
      const at = row * width + i;
      if (mobile?.state !== undefined) state[at] = stateOf(mobile.state);
      if (transmitter?.act_transmitting_energetic_beam) beaming[at] = 1;
      if (receiver?.sense_reflected_light) catching[at] = 1;
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

  /**
   * The flare each unit is showing, row by row.
   *
   * `sense_reflected_light` is the simulation's own answer to "is his sensor
   * catching the reflection right now", and it holds true for stretches of
   * fifteen to twenty ticks at a time rather than blinking — measured over the
   * engagement in the current clip, it turns over 25 times in 371 ticks. So what
   * reads as *a hit* is its **rising edge**, and the flare is an envelope hung
   * off that: full at the edge, squared falloff over the next `FLARE_ROWS`.
   *
   * Built here, per row, rather than animated at draw time, and that is the
   * whole point. The pulse comes out a pure function of scroll position, so the
   * same place on the page always shows the same flare and scrubbing backwards
   * retraces it exactly. A clock-driven pulse would drift against the scroll,
   * fire on frames rather than on moments in the recording, and behave
   * differently every time the reader passed the same line. Same argument as the
   * baked camera shots — see the README.
   *
   * One row is one tick, so at the clip's 20Hz nine rows is a little under half
   * a second.
   */
  const FLARE_ROWS = 9;
  for (let i = 0; i < width; i++) {
    let since = Infinity;
    for (let row = 0; row < count; row++) {
      const at = row * width + i;
      const rising = catching[at] === 1 && (row === 0 || catching[at - width] === 0);
      if (rising) since = 0;
      else if (since !== Infinity) since += 1;
      if (since < FLARE_ROWS) {
        const fall = 1 - since / FLARE_ROWS;
        flare[at] = fall * fall;
      }
    }
  }

  /**
   * The encounter window: which units have their cards up, as a bitmask per row.
   *
   * Not the same thing as "who is engaged right now", for two reasons.
   *
   * **The pair does not arrive or leave together.** In the current clip she
   * engages at tick 1595 and he joins at 1634; she lets go at 1915 and he holds
   * on until 1955. Reading engagement live, the set of raised cards would change
   * twice in the middle of one encounter, and since the raised cards are what
   * set the height they share, each change would jolt the survivor to a new
   * level. Taking the whole run at once — every unit engaged at any point in it
   * — the set is fixed for the duration and the height cannot move under them.
   *
   * **And the cards want to be up before there is anything to see.** The run is
   * padded by `ENCOUNTER_PAD` at both ends, so the bars rise while the two are
   * still hunting, hold through the whole exchange, and stay a moment after it
   * has come apart. The reader gets to watch the drives climb into the
   * encounter and fall out of it rather than meeting them mid-way.
   *
   * A run with only one unit in it never opens: two bodies being compared are a
   * pair, and one body is a row in a table.
   */
  const ENCOUNTER_PAD = 40; // ticks — two seconds at the clip's 20Hz
  const encounter = new Int32Array(count);
  // The clip's own name for the state; if a recording does not use it there are
  // no encounters to find and the whole window stays shut.
  const engagedState = stateIndex.get('engaging-partner');
  if (engagedState !== undefined) {
    const isEngaged = (row, i) => state[row * width + i] === engagedState;
    let start = -1;
    const closeRun = (end) => {
      if (start < 0) return;
      let mask = 0;
      let members = 0;
      for (let i = 0; i < width; i++) {
        for (let row = start; row < end; row++) {
          if (!isEngaged(row, i)) continue;
          mask |= 1 << i;
          members += 1;
          break;
        }
      }
      if (members >= 2) {
        const from = Math.max(0, start - ENCOUNTER_PAD);
        const to = Math.min(count, end + ENCOUNTER_PAD);
        for (let row = from; row < to; row++) encounter[row] |= mask;
      }
      start = -1;
    };
    for (let row = 0; row < count; row++) {
      let any = false;
      for (let i = 0; i < width; i++) {
        if (!isEngaged(row, i)) continue;
        any = true;
        break;
      }
      if (any && start < 0) start = row;
      if (!any) closeRun(row);
    }
    closeRun(count);
  }

  // Levels run past the upper limit — the recording tops out at 4800 against an
  // upper limit of 3600 — so the bars are scaled to what the clip actually
  // reaches, not to the limit, or the fullest ones would clip.
  const scale = ceiling > 0 ? ceiling : 1;

  /** Progress through the recording → the row holding that tick. */
  const rowAt = (progress) =>
    Math.min(count - 1, Math.max(0, Math.round(progress * (count - 1))));

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
    /**
     * Which units are inside an encounter window at `progress`, as a bitmask
     * over `units`. 0 when there is none — see `encounter` above.
     */
    encounterAt(progress) {
      return encounter[rowAt(progress)];
    },

    read(progress, out) {
      const row = rowAt(progress);
      for (let i = 0; i < width; i++) {
        const at = row * width + i;
        const slot =
          out[i] ?? (out[i] = { state: '', o: 0, p: 0, beaming: false, flare: 0 });
        slot.state = stateNames[state[at]] ?? '';
        slot.o = levelO[at] / scale;
        slot.p = levelP[at] / scale;
        slot.beaming = beaming[at] === 1;
        slot.flare = flare[at];
      }
      return out;
    },

    tickAt(row) {
      return ticks[Math.min(count - 1, Math.max(0, row))];
    },
  };
}
