// Sidebar activity signal, same idiom as the Workbench workflow-activity.
// A view announces that it has work running so the shell can mark its sidebar
// entry. The state is kept in the shell (app.js), not in the view: the point
// of the indicator is to be readable while you are looking at a DIFFERENT view.
//
// "Busy" means work that continues on its own — a request in flight — not a
// button that happens to be disabled for a moment.

export const VIEW_BUSY_EVENT = 'omni-translate:view-busy';
export const VIEW_RECORDING_EVENT = 'omni-translate:view-recording';

export function publishViewBusy(viewId, busy) {
  window.dispatchEvent(new CustomEvent(VIEW_BUSY_EVENT, {
    detail: { view: String(viewId || ''), busy: Boolean(busy) },
  }));
}

export function publishViewRecording(viewId, recording) {
  window.dispatchEvent(new CustomEvent(VIEW_RECORDING_EVENT, {
    detail: { view: String(viewId || ''), recording: Boolean(recording) },
  }));
}
