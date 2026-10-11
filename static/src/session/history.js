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

let _generation = 0;
let _desired = VOICE_HISTORY_SETUP;
let _stepInFlight = false;
/** A teardown that still has voice entries to leave behind. */
let _leavingSession = false;
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
  _generation += 1;
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
export function endVoiceHistorySession() {
  _desired = VOICE_HISTORY_SETUP;
  _leavingSession = true;
  leaveVoiceEntries();
}

/** Pop one voice entry, or finish when there are none left. */
function leaveVoiceEntries() {
  const onVoiceEntry = history.state?.source === ENTRY_SOURCE;
  if (!onVoiceEntry) {
    _leavingSession = false;
    _generation += 1;
    _onStateChange?.(VOICE_HISTORY_SETUP);
    return;
  }
  if (_stepInFlight) return;
  _stepInFlight = true;
  history.back();
}

/**
 * A popstate. Returns true when it was one of ours, so the app's router can stop
 * there instead of treating it as the end of the session.
 */
export function handleVoiceHistoryPopstate() {
  _stepInFlight = false;
  const actual = currentVoiceHistoryState();
  const ours = history.state?.source === ENTRY_SOURCE;
  // A teardown keeps its goal and takes the next step out.
  if (_leavingSession) {
    leaveVoiceEntries();
    return true;
  }
  if (actual === VOICE_HISTORY_SETUP && !ours) return false;
  // Every other pop is the truth about where the browser now is, whether the
  // app asked for it or the user did. Treating our own step as somehow
  // different is what made Forward behave differently after the close button
  // than after Back.
  _desired = actual;
  _onStateChange?.(actual);
  return true;
}

function pushEntry(kind) {
  history.pushState(
    { source: ENTRY_SOURCE, generation: _generation, kind },
    '',
  );
  _stepInFlight = false;
  // A push produces no popstate, so the app has to be told here; a pop does it
  // through the router's handler.
  _onStateChange?.(kind);
}

function reconcile() {
  if (_stepInFlight) return;
  const actual = currentVoiceHistoryState();
  if (actual === _desired) {
    // Reached on our own, or already there: the app still has to hear about it,
    // otherwise the panel would only follow navigations the user drove.
    _onStateChange?.(actual);
    return;
  }
  // Towards setup: only ever pop one entry, then let the resulting popstate
  // decide the next step.
  if (_desired === VOICE_HISTORY_SETUP) {
    if (actual === VOICE_HISTORY_SETUP) return;
    _stepInFlight = true;
    history.back();
    return;
  }
  // Towards live or panel. The panel needs the live entry underneath it first.
  if (_desired === VOICE_HISTORY_PANEL && actual === VOICE_HISTORY_SETUP) {
    pushEntry(VOICE_HISTORY_LIVE);
    return;
  }
  pushEntry(_desired);
}

/** Whether a reconcile step is waiting for its popstate. */
export function voiceHistoryStepInFlight() {
  return _stepInFlight;
}
