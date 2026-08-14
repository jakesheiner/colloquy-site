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
    // Read from the top every time it is opened, not from wherever it was left.
    openPane.scrollTop = 0;
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
const timelineTrack = timeline?.querySelector('.timeline-track') ?? null;
const timelinePrev = document.getElementById('timeline-prev');
const timelineNext = document.getElementById('timeline-next');

/** Where each moment comes to rest, as a scroll position along the track. */
function timelineStops() {
  if (!timeline || !timelineTrack) return [];
  const pad = parseFloat(getComputedStyle(timelineTrack).paddingLeft) || 0;
  return [...timelineTrack.querySelectorAll('.moment')].map((m) => m.offsetLeft - pad);
}

const timelineEnd = () => (timeline ? timeline.scrollWidth - timeline.clientWidth : 0);

function stepTimeline(direction) {
  if (!timeline) return;
  const now = timeline.scrollLeft;
  const stops = timelineStops();
  // A tolerance, because a snapped scroll lands within a pixel of a stop rather
  // than on it, and without one the next press would aim at the stop it is
  // already sitting on.
  const to =
    direction > 0
      ? stops.find((stop) => stop > now + 4)
      : [...stops].reverse().find((stop) => stop < now - 4);
  if (to === undefined) return;
  timeline.scrollTo({
    left: Math.max(0, Math.min(timelineEnd(), to)),
    behavior: stillMotion.matches ? 'auto' : 'smooth',
  });
}

/** Off at the ends. Read from the scroll itself rather than from which moment is
 *  showing: the last one is wider than what is left of the track, so there is a
 *  stretch past its stop that is still somewhere to go. */
function updateTimelineNav() {
  if (!timeline || !timelinePrev || !timelineNext) return;
  const end = timelineEnd();
  timelinePrev.disabled = timeline.scrollLeft <= 2;
  timelineNext.disabled = timeline.scrollLeft >= end - 2;
}

timelinePrev?.addEventListener('click', () => stepTimeline(-1));
timelineNext?.addEventListener('click', () => stepTimeline(1));
timeline?.addEventListener('scroll', updateTimelineNav, { passive: true });
window.addEventListener('resize', updateTimelineNav);
updateTimelineNav();

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
