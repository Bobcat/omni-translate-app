// History ownership for the voice session and its options panel.
//
// Both entries belong to the session, and Back has to close the panel before it
// can end the session, so one module owns the whole history shape. The earlier
// split — the sheet owning its overlay while the session workflow owned its own
// entry — let each module make a locally valid decision that invalidated the
// other's pending transition, which is what produced a string of navigation
// defects.
//
// The controller holds a *desired* state and reconciles the browser history
// towards it, one step at a time. Every step is either a single `pushState` or a
// single `back()`; the next step is decided after the resulting popstate, so no
// code ever jumps several entries at once. A teardown that requests `setup`
// therefore cancels a pending panel reopen by definition.
//
// Entries carry a session generation, so a Forward entry left over from an
// earlier session is recognisable as stale without consulting DOM or app state.

export const VOICE_HISTORY_SETUP = 'setup';
export const VOICE_HISTORY_LIVE = 'live';
export const VOICE_HISTORY_PANEL = 'panel';

/** Marks a history entry as one of ours, for this session. */
const ENTRY_SOURCE = 'voiceSession';

/**
 * A per-page-load identifier plus a counter. History entries survive a reload
 * while this module's state does not, so an integer alone would let a new
 * session adopt entries from the previous page load.
 */
const PAGE_LOAD_ID = (() => {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    // Fall through to the counter-only form below.
  }
  return Math.random().toString(36).slice(2, 10);
})();
let _generation = `${PAGE_LOAD_ID}:0`;
let _desired = VOICE_HISTORY_SETUP;
let _stepInFlight = false;
/** A teardown that still has voice entries to leave behind. */
let _leavingSession = false;
/** The pop that is on its way was asked for by reconcile(). */
let _ourPop = false;
/** Runs when a teardown has left the last voice entry. */
let _onTeardownComplete = null;
let _onStateChange = null;

/**
 * Wire the controller to the app. `onStateChange(stateName)` is how the app
 * reacts to a navigation it did not drive, such as the user going Back.
 */
export function configureVoiceSessionHistory({ onStateChange = null } = {}) {
  _onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
}

/** The entry the browser is currently on, as this controller sees it. */
export function currentVoiceHistoryState() {
  const entry = history.state;
  if (entry?.source !== ENTRY_SOURCE || entry.generation !== _generation) {
    return VOICE_HISTORY_SETUP;
  }
  return entry.kind === VOICE_HISTORY_PANEL ? VOICE_HISTORY_PANEL : VOICE_HISTORY_LIVE;
}

export function desiredVoiceHistoryState() {
  return _desired;
}

/** A new session: its own generation, starting from the setup entry. */
export function beginVoiceHistorySession() {
  const step = Number(String(_generation).split(':')[1] || 0) + 1;
  _generation = `${PAGE_LOAD_ID}:${step}`;
  _desired = VOICE_HISTORY_SETUP;
  _stepInFlight = false;
  _leavingSession = false;
}

/** Ask for a state; the reconciler moves the history towards it. */
export function requestVoiceHistoryState(next) {
  _desired = next;
  reconcile();
}

/**
 * The session and its panel are done: both entries leave the stack, one pop at a
 * time. A generation bump alone would only hide them — the entries would still
 * be there for Forward to walk back onto.
 */
/**
 * The session and its panel are done: both entries leave the stack, one pop at a
 * time. A generation bump alone would only hide them — the entries would still
 * be there for Forward to walk back onto. `onComplete` runs once the browser is
 * on an entry that is not ours, so the app's own move to setup cannot run ahead
 * of its history.
 */
export function endVoiceHistorySession({ onComplete = null } = {}) {
  _leavingSession = true;
  _onTeardownComplete = typeof onComplete === 'function' ? onComplete : null;
  leaveVoiceEntries();
}

/** Pop one voice entry, or finish when there are none left. */
function leaveVoiceEntries() {
  if (history.state?.source !== ENTRY_SOURCE) {
    _leavingSession = false;
    _stepInFlight = false;
    _generation = nextGeneration();
    _desired = VOICE_HISTORY_SETUP;
    const done = _onTeardownComplete;
    _onTeardownComplete = null;
    _onStateChange?.(VOICE_HISTORY_SETUP);
    done?.();
    return;
  }
  if (_stepInFlight) return;
  _stepInFlight = true;
  _ourPop = true;
  history.back();
}

function nextGeneration() {
  const step = Number(String(_generation).split(':')[1] || 0) + 1;
  return `${PAGE_LOAD_ID}:${step}`;
}

/**
 * A popstate. Returns true when it was one of ours, so the app's router can stop
 * there instead of treating it as the end of the session.
 */
export function handleVoiceHistoryPopstate() {
  const ours = _ourPop;
  _ourPop = false;
  _stepInFlight = false;
  if (_leavingSession) {
    // A teardown keeps its goal and takes the next step out.
    leaveVoiceEntries();
    return true;
  }
  const actual = currentVoiceHistoryState();
  const onOurEntry = history.state?.source === ENTRY_SOURCE;
  if (actual === VOICE_HISTORY_SETUP && !onOurEntry) return false;
  if (!ours) {
    // A navigation the user drove defines the new goal.
    _desired = actual;
    _onStateChange?.(actual);
    return true;
  }
  // A step the controller asked for: keep the goal and take the next one, so an
  // older step cannot overwrite a newer goal.
  _onStateChange?.(actual);
  reconcile();
  return true;
}

function pushEntry(kind) {
  history.pushState(
    { source: ENTRY_SOURCE, generation: _generation, kind },
    '',
  );
  _stepInFlight = false;
  // A push produces no popstate, so the app has to be told here; a pop does it
  // through the router's handler. Then the next step of the table runs, which is
  // how setup -> panel reaches the panel entry after pushing the live one.
  _onStateChange?.(kind);
  reconcile();
}

/**
 * Bring the history in line with the desired state, taking at most one step.
 * The table, with the current entry on the left and the desired state on the
 * right:
 *
 *   setup -> live    push live
 *   setup -> panel   push live, then push panel on the next pass
 *   live  -> panel   push panel
 *   panel -> live    back to the live entry underneath (a push would truncate
 *                    the panel's Forward branch)
 *   any   -> setup   back one entry at a time, reconciled as each pop lands
 */
function reconcile() {
  if (_stepInFlight) return;
  const actual = currentVoiceHistoryState();
  if (actual === _desired) {
    // Reached on our own, or already there: the app still has to hear about it,
    // otherwise the panel would only follow navigations the user drove.
    _onStateChange?.(actual);
    return;
  }
  if (_desired === VOICE_HISTORY_SETUP) {
    _stepInFlight = true;
    _ourPop = true;
    history.back();
    return;
  }
  if (_desired === VOICE_HISTORY_PANEL && actual === VOICE_HISTORY_LIVE) {
    pushEntry(VOICE_HISTORY_PANEL);
    return;
  }
  if (_desired === VOICE_HISTORY_LIVE && actual === VOICE_HISTORY_PANEL) {
    _stepInFlight = true;
    _ourPop = true;
    history.back();
    return;
  }
  // From setup towards the panel: the live entry has to exist below it first,
  // and reconcile() runs again when that push lands.
  pushEntry(VOICE_HISTORY_LIVE);
}

/** Whether a reconcile step is waiting for its popstate. */
export function voiceHistoryStepInFlight() {
  return _stepInFlight;
}
