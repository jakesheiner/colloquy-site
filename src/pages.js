/**
 * The site's three pages, and the directions between them.
 *
 * The piece is straight down from the title screen — that is the whole of
 * `main.js`, and it is the page the browser actually scrolls. About is to the
 * left of it and History to the right, and both are held off screen and slid
 * over the site when they are asked for.
 *
 * Sliding them over rather than laying all three out side by side in one wide
 * scroller is deliberate, and it is the only arrangement that leaves the piece
 * alone. Everything in `main.js` is measured against the window and driven by
 * `window.scrollY`: the camera, the recording's playhead, where each blurb sits.
 * Putting that inside a horizontally-scrolled track would mean every one of
 * those numbers had to learn about a second axis it currently knows nothing
 * about. Here the two extra pages are `position: fixed` and the site under them
 * is simply frozen where it stood.
 *
 * This is its own module, loaded before `main.js` and independent of it, so
 * that a reader whose browser will not run the scene — `main.js` opens with a
 * top-level `await` on the clip player and gives up if the recording will not
 * load — can still read the pages about it.
 */

const compass = document.getElementById('compass');
const compassDown = document.getElementById('compass-down');
const titleScreen = document.getElementById('title-screen');
const pinSection = document.getElementById('pin-section');

const panes = new Map(
  [...document.querySelectorAll('.pane')].map((pane) => [pane.id, pane])
);

const stillMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// --- the cues on the title screen --------------------------------------------

/**
 * The three directions, shown while the reader is on the title screen and gone
 * once they are into the piece.
 *
 * Faded off well before the title screen is finished — by a little under half of
 * it — so they have cleared by the time the scene arrives rather than hanging
 * over the top of it. Past that they are `visibility: hidden` as well as
 * transparent, which is what keeps them out of the tab order and off the
 * hit-testing over the scene.
 */
let compassShown = -1;

function paintCompass() {
  if (!compass || !titleScreen) return;
  const run = titleScreen.offsetHeight * 0.45;
  const t = run > 0 ? Math.min(1, Math.max(0, window.scrollY / run)) : 1;
  const shown = 1 - t;
  if (Math.abs(shown - compassShown) < 0.004) return;
  compassShown = shown;
  compass.style.opacity = shown.toFixed(3);
  compass.toggleAttribute('data-gone', shown === 0);
}

paintCompass();
window.addEventListener('scroll', paintCompass, { passive: true });
window.addEventListener('resize', paintCompass);

compassDown?.addEventListener('click', () => {
  if (!pinSection) return;
  window.scrollTo({
    top: pinSection.offsetTop,
    behavior: stillMotion.matches ? 'auto' : 'smooth',
  });
});

// --- opening and closing a page ----------------------------------------------

/** The page currently over the site, or null for the site itself. */
let openPane = null;

/** Where the site was left, so it is still there when the page closes. */
let parked = 0;

/** What to hand focus back to when the page closes. */
let opener = null;

/**
 * Where a page should be sitting when it opens, for pages that have somewhere
 * to be. Assigned by the timeline below, which wants to open on 1968 rather
 * than on 1950 — the page is about the Colloquy, and the eighteen years before
 * it are context you can go back for.
 *
 * A hook rather than a call into the timeline's own code, because that code is
 * further down the file than this is and `const` bindings are not hoisted.
 */
let restPane = () => {};

/**
 * Show a page, or the site.
 *
 * The site under an open page is frozen rather than merely covered: its scroll
 * position is the playhead of a recording, and a wheel that reached it while
 * About was open would spend the piece behind the reader's back. `overflow:
 * hidden` on the root keeps the position it had, and the restore below is there
 * for the case where a browser does not.
 */
function apply(id) {
  const next = id ? panes.get(id) ?? null : null;
  if (next === openPane) return;

  if (openPane) {
    openPane.removeAttribute('data-showing');
    openPane.inert = true;
  }

  openPane = next;

  if (openPane) {
    if (!document.documentElement.classList.contains('pane-open')) {
      parked = window.scrollY;
      document.documentElement.classList.add('pane-open');
    }
    openPane.inert = false;
    openPane.setAttribute('data-showing', '');
    // Read from the start every time it is opened, not from wherever it was left.
    openPane.scrollTop = 0;
    restPane(openPane);
    // Next frame: the element is `visibility: hidden` until the attribute above
    // has been through style, and there is nothing to focus in a hidden box.
    requestAnimationFrame(() => {
      openPane?.querySelector('.pane-back')?.focus({ preventScroll: true });
    });
  } else {
    document.documentElement.classList.remove('pane-open');
    if (Math.abs(window.scrollY - parked) > 1) window.scrollTo(0, parked);
    opener?.focus({ preventScroll: true });
    opener = null;
  }
}

/** The page named in the address bar, if it is one of ours. */
const paneInHash = () => {
  const id = location.hash.replace('#', '');
  return panes.has(id) ? id : null;
};

/**
 * Open a page, and put it in the address bar.
 *
 * A history entry rather than a mode: the two pages are pages, so a link to one
 * should work and the browser's own back button should be the way out of it —
 * which on a phone is the gesture people will reach for first.
 */
function show(id, from = null) {
  if (!panes.has(id) || openPane === panes.get(id)) return;
  opener = from;
  history.pushState({ pane: id }, '', `#${id}`);
  apply(id);
}

function hide() {
  if (!openPane) return;
  // Back, so the entry this page added is spent rather than piling up: a reader
  // who opens and closes About four times should not have to press back four
  // times to leave the site.
  if (history.state?.pane) history.back();
  else {
    history.replaceState(null, '', location.pathname + location.search);
    apply(null);
  }
}

// The address bar is what says which page is open — `apply` only does as it is
// told. That way the browser's back and forward buttons, a pasted link and the
// controls on the page all arrive at the same place by the same route.
window.addEventListener('popstate', () => {
  apply(history.state?.pane ?? paneInHash());
});

for (const cue of document.querySelectorAll('[data-open]')) {
  cue.addEventListener('click', () => show(cue.getAttribute('data-open'), cue));
}

for (const back of document.querySelectorAll('[data-close]')) {
  back.addEventListener('click', hide);
}

// --- the timeline -------------------------------------------------------------

const timeline = document.getElementById('timeline');
const timelineTrack = document.getElementById('timeline-track');
const timelinePrev = document.getElementById('timeline-prev');
const timelineNext = document.getElementById('timeline-next');

/**
 * How far apart two years are drawn.
 *
 * Not to scale. Linear time puts two thirds of the page in the stretch between
 * 1968 and 2018 and stacks 2016, 2017 and 2018 on top of each other, so this is
 * a floor plus a slope: every step gets `GAP` whatever it is, and then `SPREAD`
 * for each year in it. Order and proportion survive — fifty years is visibly
 * longer than one — without the empty decades taking the whole page and the busy
 * ones becoming unreadable.
 */
const GAP = 152;
const SPREAD = 9;

/**
 * The inset at either end, taken from the track's own padding so it matches the
 * rest of the page's edges. Absolutely positioned children ignore that padding,
 * so it has to be added back here — which is the whole reason it is stated in
 * the stylesheet rather than typed as a number in this file.
 *
 * The two ends differ: the lead-in also has to clear the back button, which
 * stands halfway down the left edge.
 */
function timelineInset() {
  if (!timelineTrack) return { lead: 0, tail: 0 };
  const style = getComputedStyle(timelineTrack);
  return { lead: parseFloat(style.paddingLeft) || 0, tail: parseFloat(style.paddingRight) || 0 };
}

/**
 * Lay the track out from the years in the markup.
 *
 * Everything with a `data-year` is placed, whatever kind of thing it is: the
 * three cards below the line and the eleven ticks above it go through the same
 * arithmetic, so a tick can never drift out of order against a card. Run again
 * on resize because both the inset and the card width are set in viewport units.
 */
function placeTimeline() {
  if (!timeline || !timelineTrack) return;
  const items = [...timelineTrack.querySelectorAll('[data-year]')]
    .map((el) => ({ el, year: Number(el.dataset.year) }))
    .filter((item) => Number.isFinite(item.year))
    .sort((a, b) => a.year - b.year);
  if (items.length === 0) return;

  const { lead, tail } = timelineInset();
  let x = 0;
  let last = items[0].year;
  for (const [i, item] of items.entries()) {
    if (i > 0) x += GAP + (item.year - last) * SPREAD;
    last = item.year;
    item.el.style.left = `${Math.round(lead + x)}px`;
  }

  // As wide as the last thing on it, plus the inset at the far end — so the line
  // runs past the final card rather than stopping under it.
  const width = items[items.length - 1].el.offsetWidth;
  timelineTrack.style.width = `${Math.round(lead + x + width + tail)}px`;
}

/** Where each moment comes to rest, as a scroll position along the track. */
function timelineStops() {
  if (!timeline || !timelineTrack) return [];
  const { lead } = timelineInset();
  return [...timelineTrack.querySelectorAll('.moment')].map((m) => m.offsetLeft - lead);
}

const timelineEnd = () => (timeline ? timeline.scrollWidth - timeline.clientWidth : 0);

/**
 * Everywhere the arrows will stop: the three moments, and both ends of the line.
 *
 * The ends are in there because the moments alone are not the whole page any
 * more. The timeline opens on 1968, and there are eighteen years of the field
 * before it — with only the moments as stops, the back arrow would be dead
 * standing on the first one, which says that stretch is not there. The far end
 * is in for the same reason: the last card sits well inside the track, and the
 * years after it are worth arriving at.
 *
 * Clamped and deduplicated, because a card's own position is often past the
 * furthest the track can scroll — on a wide window the last two both resolve to
 * the end, and two stops in the same place means one dead press of the arrow.
 */
function timelineHalts() {
  const end = timelineEnd();
  const all = [0, ...timelineStops(), end].map((stop) => Math.max(0, Math.min(end, stop)));
  return [...new Set(all.map(Math.round))].sort((a, b) => a - b);
}

/** The stop either side of where the track is sitting. A tolerance, because a
 *  scroll lands within a pixel of a stop rather than on it, and without one the
 *  next press would aim at the stop it is already standing on. */
function nextHalt(direction) {
  const now = timeline ? timeline.scrollLeft : 0;
  const stops = timelineHalts();
  return direction > 0
    ? stops.find((stop) => stop > now + 4)
    : [...stops].reverse().find((stop) => stop < now - 4);
}

function stepTimeline(direction) {
  if (!timeline) return;
  const to = nextHalt(direction);
  if (to === undefined) return;
  timeline.scrollTo({ left: to, behavior: stillMotion.matches ? 'auto' : 'smooth' });
}

/** Off when there is nowhere that way to go, so a live arrow always means there
 *  is more of the line in that direction. */
function updateTimelineNav() {
  if (!timeline || !timelinePrev || !timelineNext) return;
  timelinePrev.disabled = nextHalt(-1) === undefined;
  timelineNext.disabled = nextHalt(1) === undefined;
}

timelinePrev?.addEventListener('click', () => stepTimeline(-1));
timelineNext?.addEventListener('click', () => stepTimeline(1));
timeline?.addEventListener('scroll', updateTimelineNav, { passive: true });
window.addEventListener('resize', () => {
  placeTimeline();
  updateTimelineNav();
});
placeTimeline();
updateTimelineNav();

/**
 * Open the timeline on 1968 rather than at the far left of it.
 *
 * The page argues that the Colloquy was the first of these things, and the
 * first thing it should show is the Colloquy. Everything before it is still
 * there, one arrow to the left — and the arrow being live is what says so.
 */
restPane = (pane) => {
  if (!timeline || !pane.contains(timeline)) return;
  placeTimeline();
  const [first] = timelineStops();
  if (first === undefined) return;
  timeline.scrollLeft = Math.max(0, Math.min(timelineEnd(), first));
  updateTimelineNav();
};

// The track's width is the last card's width plus where it sits, and a card is
// not its real width until the condensed face has arrived.
if (document.fonts) document.fonts.ready.then(placeTimeline);

/**
 * A wheel down the page is travel along the track.
 *
 * Without this the timeline is unreadable with an ordinary mouse: the gesture
 * everyone has is vertical, and the only thing on this page that moves is
 * horizontal. A trackpad's sideways swipe still goes straight through — the
 * check is for which way the gesture actually leans, so a diagonal is not
 * counted twice.
 */
timeline?.addEventListener(
  'wheel',
  (event) => {
    if (event.ctrlKey) return; // a zoom, not a scroll
    // Firefox reports lines rather than pixels when the system is set that way.
    const scale = event.deltaMode === 1 ? 16 : 1;
    const down = event.deltaY * scale;
    const across = event.deltaX * scale;
    if (Math.abs(down) <= Math.abs(across)) return;
    if (timelineEnd() <= 0) return;
    timeline.scrollLeft += down;
    event.preventDefault();
  },
  { passive: false }
);

// --- the keyboard -------------------------------------------------------------

/**
 * The same three directions, for anyone not using a pointer.
 *
 * Left and right move between the pages, except on the timeline, where they are
 * the timeline's own — sideways is what that page does, and a key that walked
 * off it instead would be the surprising one.
 */
window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const on = event.target;
  // Never out from under someone typing, or off a control they are working.
  if (on instanceof Element && on.closest('input, textarea, select, [contenteditable]')) return;

  if (event.key === 'Escape' && openPane) {
    hide();
    return;
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    const forward = event.key === 'ArrowRight';
    if (openPane?.id === 'history') {
      stepTimeline(forward ? 1 : -1);
      event.preventDefault();
      return;
    }
    if (openPane) {
      // Back out of a page the way you came into it.
      const side = openPane.dataset.side;
      if ((side === 'left' && forward) || (side === 'right' && !forward)) hide();
      return;
    }
    show(forward ? 'history' : 'about');
    event.preventDefault();
  }
});

// A page named in the address the site was opened at, so a link to one lands on
// it. Left until everything above is wired, so it goes through the same door as
// a click does.
if (paneInHash()) apply(paneInHash());
