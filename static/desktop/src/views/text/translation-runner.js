// Request coordination for the text translation view, DOM-less on purpose so
// the newest-wins/cleanup semantics can be tested without a browser. The view
// owns the timing policy (debounce + ceiling) and the DOM; this runner owns
// the request state: one request in flight, a re-fire with the newest text
// when the input changed mid-request, and a runToken that invalidates
// in-flight results without skipping cleanup.
//
// The invariant the cleanup guards: `finally` ALWAYS releases the runner
// (inFlight, busy), even when the token went stale — a stale token only means
// the result must not be applied, never that the request never happened.

export function createTranslationRunner({ minChars = 3, getPayload, translate, onResult, onError, onBusy, onStateChange }) {
  let runToken = 0;
  let inFlight = false;
  let dirtyWhileInFlight = false;
  let pendingFinal = false;

  // The current input no longer wants a translation (e.g. cleared below the
  // minimum): an in-flight result must not land, but its cleanup still runs.
  function invalidate() {
    ++runToken;
  }

  function isInFlight() {
    return inFlight;
  }

  async function fire({ final = false } = {}) {
    if (inFlight) {
      // One request at a time; re-fire with the newest text on completion.
      dirtyWhileInFlight = true;
      pendingFinal = pendingFinal || final;
      return;
    }
    const payload = getPayload();
    if (String(payload.text || '').trim().length < minChars) {
      onStateChange?.();
      return;
    }
    inFlight = true;
    dirtyWhileInFlight = false;
    pendingFinal = false;
    const token = ++runToken;
    onBusy?.(true);
    onStateChange?.();
    try {
      const result = await translate({ ...payload, final });
      if (token === runToken) onResult?.(result);
    } catch (error) {
      if (token === runToken) onError?.(error);
    } finally {
      inFlight = false;
      onBusy?.(false);
      onStateChange?.();
      if (dirtyWhileInFlight) {
        dirtyWhileInFlight = false;
        fire({ final: pendingFinal });
      }
    }
  }

  return { fire, invalidate, isInFlight };
}
