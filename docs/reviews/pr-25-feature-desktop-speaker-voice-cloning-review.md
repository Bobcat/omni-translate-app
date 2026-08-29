# Review prompt: desktop voice selection and speaker cloning

Review PR #25, `feature/desktop-speaker-voice-cloning`, against `main`. Review
only; do not modify the implementation. Update
[`pr-25-feature-desktop-speaker-voice-cloning-findings.md`](pr-25-feature-desktop-speaker-voice-cloning-findings.md)
with a new re-review section. Preserve the earlier findings and their resolution.

Review the complete PR. The previous review covered the implementation through
`dcc29b3`. Give extra attention to the changes after that commit.

## Required context

Read these documents before reviewing the code:

- [`docs/voice-translation/voice-cloning-design.md`](../voice-translation/voice-cloning-design.md)
- [`docs/voice-translation/tts-delivery-design.md`](../voice-translation/tts-delivery-design.md)
- [`docs/voice-translation/session-guardrails-design.md`](../voice-translation/session-guardrails-design.md)

The voice-cloning design is authoritative for product behavior. The mobile TTS
experiment controls and changes to TTS-pool remain out of scope.

## Product behavior

Desktop voice translation now offers **Female**, **Male**, and **Clone speaker**.
Female and Male select the matching generated voice for the target language.
The browser remembers the choice. **Automatically speak translations** remains
an independent setting.

When Clone speaker has insufficient reference speech, synthesis continues with
the most recently selected Female or Male voice from the current session. It
uses Female when Clone speaker was the first session choice. The UI names that
temporary voice. Once the lane has a valid reference, new synthesis uses Prompt
+ reference cloning.

The product UI has only the microphone control and per-bubble speaker actions.
The separate Translate and Speak controls were removed. The voice selector sits
below the target pane, followed by automatic speaking and the cloning status.

On iOS and iPadOS, the app stops physical microphone capture before playback,
switches the browser audio session to playback, and waits briefly before the
first audio chunk. It reopens capture after the queue becomes idle only when
the logical microphone state still requires recording. Other platforms retain
the existing playback path without the delay.

The patch also fixes a turn-boundary bug. Accepting a preview from an older
closed part must not copy that text into the current lane scope. Without this
guard, the first translated bubble after restarting the microphone could be
prefixed with the previous bubble.

## Review priorities

Report correctness, lifecycle, concurrency, protocol, and regression risks.
Prefer a concrete triggering sequence over style comments.

### Voice selection and fallback

- Trace the voice mode from `localStorage`, session creation, live updates, and
  backend session state into the exact VoxCPM request settings.
- Verify Female and Male always select their matching generated voice.
- Verify Clone speaker uses the last explicit Female or Male choice in the
  current session while preparing. It must default to Female only when no such
  choice exists.
- Check repeated transitions such as Female → Clone → Male → Clone, including
  changes while automatic, speculative, queued, streaming, and replay audio
  exists.
- Confirm reaching cloning readiness drops only unused fallback preparations
  for that lane. Active playback and completed replay audio must remain stable.
- Check both conversation directions, direction swaps, session restart, reload,
  malformed stored values, and an unavailable product-voice capability.
- Confirm unsupported target languages fail closed without consuming the
  speculative budget or ending the session.

### Reference pairing and lifecycle

- Recheck that each prompt transcript exactly matches its materialized audio.
- Confirm rolling ASR results do not create duplicate reference files for an
  unchanged timestamp-and-text selection.
- Check reference replacement, storage accounting, cleanup, and the independent
  per-lane windows against the documented 3–10 second policy.
- Confirm mode changes clear obsolete cloning state without invalidating audio
  already in use.

### Turn and bubble boundaries

- Trace stopping and restarting the microphone with a terminal ASR result,
  accepted previews, translation still in flight, and automatic speaking on.
- Verify an older part can be finalized without becoming the current part's
  committed source or target prefix.
- Check that valid preview acceptance for the current open part still updates
  the lane scope.
- Recheck `<->` direction changes while a session is live. The language bar,
  active lane, target bubbles, voice status, and synthesis voice must agree.

### iOS playback transition

- Trace PCM streaming, completed-WAV replay, autoplay rejection, queue advance,
  stop, skip, and session end through the delayed playback start.
- Check the race where recording is stopped, restarted, or the session ends
  while playback is waiting for its delay or while `getUserMedia` is reopening.
- Verify capture is never opened twice and never resumes while more audio is
  queued or playing.
- Confirm automatic speaking can resume recording after playback, while an
  explicit user stop remains stopped.
- Check microphone failure during resume. The UI and shared microphone state
  must settle without sending stale audio.
- Verify non-iOS browsers do not stop capture or receive the iOS delay.
- Assess whether the audio-session feature detection covers current iPhone,
  iPad, and iPadOS desktop-mode user agents without affecting macOS Safari.

### Desktop UI and cache graph

- Check the selected voice is visually distinct and keyboard accessible.
- Check the control order, right alignment, narrow desktop widths, zoom, and
  increased text size.
- Confirm the removed Translate and Speak controls left no reachable dead path
  or required action inaccessible; per-bubble replay must still work.
- Verify every changed desktop module resolves under one query-string version.
  Modulepreload URLs must match the actual entry and import URLs.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- changes to ASR-pool, translation-services, or TTS-pool;
- migration of the product voice selector to mobile;
- removal of the current mobile experiment settings;
- speaker recognition, diarization, or persistent voices across sessions;
- word-level clipping inside one ASR segment;
- broad desktop layout restructuring.

## Verification

Run:

```bash
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
python -m unittest discover -s tests
node --test tests/js/
git diff --check main...HEAD
```

The author run passed 292 Python tests and 106 JavaScript tests. Python and
JavaScript syntax checks, the desktop module-graph check, and `git diff --check`
also passed. Manual desktop testing covered voice selection, cloning, fallback,
automatic speaking, replay, and stopping and restarting the microphone. The iOS
volume behavior needs independent device verification.

## Review response

List findings first, ordered by severity. For each finding include:

- file and line;
- triggering sequence or input;
- observed or expected failure;
- smallest safe correction;
- missing regression test, when applicable.

Then list unresolved risks and untested paths. Give an explicit merge-quality
verdict. If there are no findings, state that directly and name the paths that
were not exercised.
