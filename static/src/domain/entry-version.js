// Entry-version guard for the mobile shell.
//
// An installed app can keep running a cached shell whose script URLs point at
// assets that have since moved on. The backend reports the version the shell
// should be running; when the running bundle disagrees, the app reloads itself
// once to pick up the current files.
//
// The reload is deliberately self-limiting: if a reload does not fix the
// mismatch within a short window, the guard gives up rather than reloading in a
// loop, so a misconfigured server cannot make the app unusable.

/** How long after a reload the guard refuses to try again. */
export const VERSION_RELOAD_WINDOW_MS = 15000;

/**
 * Whether to reload, given the versions and the timestamp of the last attempt.
 *
 * @param {string} runningVersion version of the bundle that is executing
 * @param {string} serverVersion version the backend says should be running
 * @param {number} lastReloadAtMs timestamp of the previous reload, 0 if none
 * @param {number} nowMs current time
 */
export function shouldReloadForVersion(
  runningVersion,
  serverVersion,
  lastReloadAtMs,
  nowMs,
) {
  const running = String(runningVersion || '').trim();
  const server = String(serverVersion || '').trim();
  if (!server || server === running) return false;
  const last = Number(lastReloadAtMs) || 0;
  return !last || nowMs - last >= VERSION_RELOAD_WINDOW_MS;
}
