# Review prompt: voice session duration and storage guardrails

Review PR #23, `feature/voice-session-guardrails` against `main`. Review only;
do not modify the branch.

## Required context

Read these documents before reviewing the code:

- [`docs/voice-translation/session-guardrails-design.md`](../voice-translation/session-guardrails-design.md)
- [`docs/voice-translation/tts-delivery-design.md`](../voice-translation/tts-delivery-design.md), especially **Storage and cleanup**

## Change under review

Live voice sessions now have two server-owned guardrails:

| Guardrail | Default | Result |
|---|---:|---|
| Active WebSocket duration | 15 minutes | End the voice session. |
| Combined ASR and TTS WAV storage | 256 MiB per session | Reject the next artifact write and end the voice session. |

The backend sends a specific `ended` reason and message when either limit is
reached. Mobile and desktop stop their local voice state, return to setup, and
show that message. Normal user-initiated completion shows no limit notice.

## Review priorities

Report correctness, concurrency, lifecycle, and regression risks. Prefer a
concrete triggering sequence over style comments.

### Duration lifecycle

- Confirm the monotonic deadline starts when the WebSocket is accepted.
- Check whether continuous WebSocket audio or ASR-completion events can starve
  the deadline.
- Trace the deadline while ASR submission, translation, or TTS work is active.
  Identify any work that can continue or publish after the session is closed.
- Verify timeout, disconnect, VAD failure, user completion, and storage-limit
  completion settle resources once and preserve the correct close reason.
- Check task cancellation in `wait_for_input`, including a timeout that races
  with WebSocket input or an ASR-ready event.

### Storage accounting and writes

- Confirm ASR and TTS artifacts for one session are counted together.
- Check the lock boundary around usage calculation and writing. Concurrent ASR
  and TTS writes must not both consume the same remaining capacity.
- Check exact-limit writes, rejected writes, replacement writes, invalid session
  IDs, missing directories, filesystem errors, and cleanup racing with a write.
- Confirm a rejected artifact leaves no partial file and never reaches the ASR
  pool.
- Verify the cap applies only to live-session ASR and TTS artifacts. It must not
  include stable voice-library audio or another session's files.
- Check whether scanning the session directories on every WAV write creates a
  material cost near the 256 MiB limit.

### ASR and TTS failure paths

- Confirm `SessionArtifactLimitExceeded` is handled separately from ordinary
  ASR submission and TTS synthesis failures.
- Trace a limit reached by speculative TTS, automatic TTS, explicit Speak, and
  ASR submission.
- Check an over-limit TTS response after PCM streaming has started. The browser
  queue, preparation record, pending artifact state, synthesis callback, and
  session lifecycle must settle without hanging or reporting a generic error.
- Confirm no new artifact is published after the storage exception.

### Browser behavior

- Confirm mobile and desktop interpret the same two `ended` reasons.
- Check the race between receiving `ended` and the WebSocket close callback.
  The limit message must remain visible after cleanup.
- Confirm microphone capture, queued/playing audio, session identity, transcript
  state, and desktop busy state are cleared.
- Verify a new voice start clears the notice. A normal Finish action, unexpected
  disconnect, image workflow, or page navigation must not display a stale limit
  notice.
- Check the mobile setup layout with the longest configured limit message and
  with narrow screens or larger text.

### Retention and configuration

- Confirm the 15-minute post-session retention still applies after either
  guardrail ends a session.
- Verify both settings use safe integer validation and defaults.
- Confirm the browser cannot raise these deployment-owned limits.
- Check that the design document distinguishes the per-session cap from a
  global disk quota.

## Intentional exclusions

Do not report these as missing scope unless this patch makes them unsafe:

- a global disk quota across concurrent or retained sessions;
- SaaS quota or billing integration;
- deleting old bubble audio while a session remains active;
- ASR-pool or TTS-pool protocol changes;
- estimating or reserving TTS output bytes before synthesis;
- transitive ES-module cache invalidation.

The HTML entry URLs receive new cache keys. Imported modules can still require
a hard refresh under the existing cache strategy.

## Verification

Run:

```bash
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
python -m unittest discover -s tests
node --test tests/js/
git diff --check main...HEAD
```

The post-fix author run passed 269 Python tests and 91 JavaScript tests. Inspect
the full diff from `main`; do not review only the last commit.

## Review response

List findings first, ordered by severity. For each finding include:

- file and line;
- triggering sequence or input;
- observed or expected failure;
- smallest safe correction;
- missing regression test, when applicable.

After the findings, list unresolved risks and test gaps. If there are no
findings, state that directly and name any paths that were not exercised.
