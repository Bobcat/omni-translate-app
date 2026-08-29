# Review findings: desktop speaker voice cloning

Review of PR #25, `feature/desktop-speaker-voice-cloning`, at `32a8773`, against
`main` at `d06d084`. Answers the prompt in
[`pr-25-feature-desktop-speaker-voice-cloning-review.md`](pr-25-feature-desktop-speaker-voice-cloning-review.md).

All required checks pass, matching the author's run:

| Check | Result |
| --- | --- |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `python -m unittest discover -s tests` | 281 tests, pass |
| `node --test tests/js/` | 92 tests, pass |
| `git diff --check main...HEAD` | clean |

**Merge-quality verdict: fix findings 1 and 2 first; 3 to 5 can follow.**
Findings 1 and 2 were measured; their output is quoted. Findings 3 to 5 are read
from the code and say so.

## Findings

### 1. HIGH — a reference WAV is written on every rolling ASR result, and three quarters of them are byte-identical

**Where** — `app/voice/cloning.py:250` (`_reference_id`), against the early
return at `app/voice/cloning.py:135`.

`_reference_id` hashes `request_id` and `segment_id` alongside `t0_ms`, `t1_ms`
and `text`. Neither is stable across rolling ASR results for the same audio:

- `request_id` is per ASR job, and jobs overlap on a rolling window;
- `segment_id` falls back to a positional index inside the result
  (`app/asr_bridge.py:524`), which shifts as the window slides.

So the same selected audio produces a new identity on every terminal result, the
`current.reference_id == reference_id` guard never fires, and
`_materialize_reference` re-clips, re-encodes and writes a new WAV.

**Trigger** — continuous speech with cloning enabled. The rolling ASR cadence is
roughly one job per 500 ms of new audio (`live.rolling.min_new_audio_ms` 500,
`pacing.base_emit_ms` 250).

**Observed**, driving the real `VoiceCloningWindow` with time-encoded source
audio so identical bytes really mean identical content:

```
60 rolling ASR results (= 30 s of speech)
  materializations          : 60
  WAV files                 : 60   total 7.33 MiB   avg 125 KiB
  unique audio content      : 15
  byte-identical duplicates : 45  (75%)  = 5.50 MiB wasted

extrapolated to 15 min of continuous speech:
  ~220 MiB of reference WAVs alone   (session cap = 256 MiB)
  reference WAVs alone reach the cap after ~17.5 min of speech
```

Three consequences. Reference WAVs alone consume most of the 256 MiB session
budget, so the storage guardrail fires on cloning overhead rather than on real
content, well before the artifacts an operator would expect. Each redundant
materialization re-reads and re-encodes the source WAVs on a worker thread. And
each one emits a `voice_cloning_status` event to the browser.

**Smallest safe correction** — identify a reference by what actually determines
its output: hash `(t0_ms, t1_ms, text)` only, dropping `request_id` and
`segment_id`. Projected against the same sequence:

```
current identity (request_id + segment_id + t0/t1/text): 60 materializations
identity on (t0, t1, text)                             : 15 materializations
75% fewer writes -> ~55 MiB instead of ~220 MiB over 15 min
```

**Missing test** — a rolling re-transcription covering the same intervals must
not materialize a second reference.

### 2. MEDIUM — two shared desktop modules are loaded twice under different URLs

**Where** — `static/desktop/index.html:88` onwards and the new `?v=` import
queries in `static/desktop/app.js` and `static/desktop/src/views/voice/*`.

This PR starts versioning transitive imports, but only along the voice path. A
walk of the desktop module graph (49 files) shows two modules imported both with
and without a query:

```
static/desktop/src/shared/api.js  -> ['', 'v=20260828-voice-cloning-1']
     static/desktop/app.js                      ?v=20260828-voice-cloning-1
     static/desktop/src/views/voice/session.js  ?v=20260828-voice-cloning-1
     static/desktop/src/views/account/index.js  ?(none)
     static/desktop/src/views/image/index.js    ?(none)
     static/desktop/src/views/pdf/index.js      ?(none)
     static/desktop/src/views/text/index.js     ?(none)

static/src/domain/storage.js      -> ['', 'v=20260828-voice-cloning-1']
     static/desktop/src/views/voice/session.js  ?v=20260828-voice-cloning-1
     static/desktop/src/shared/appearance.js    ?(none)
     static/desktop/src/views/text/index.js     ?(none)
```

ES modules are keyed by resolved URL including the query, so the browser
instantiates two copies of each. `api.js` holds module-level state —
`anonymousPrincipalReady` at `static/desktop/src/shared/api.js:173`, which
memoizes the `/api/me` bootstrap — so that memo is duplicated and the bootstrap
can run twice.

Both modules changed in this PR. The unversioned copy can therefore be served
stale from cache while the versioned copy is fresh, which is exactly the
"must not combine old and new voice-session JavaScript" hazard the prompt names.
Today the effect is benign, because the other views do not use the new exports.

**Smallest safe correction** — make it all-or-nothing per module: either every
import of a changed module carries the query, or none do and only the entry URL
is bumped. The current half-versioned state has the cost of both and the benefit
of neither.

**Missing test** — a module-graph check that no module is imported under two
different URLs.

### 3. LOW — `_new_preparation` can raise out of a synchronous speculative path

**Where** — `app/voice/tts_delivery.py:325` calling
`app/tts_bridge.py:423`.

`product_voice_cloning_settings` raises `ValueError` when the target language has
no BCP47 tag. `_new_preparation` does not catch it, and one of its callers is
synchronous: `prepare_definitive_part` runs from `_close_current_bubble` inside
the run loop, so the exception would reach `run()` and end the session.

Currently unreachable: all 41 languages offered by
`static/src/domain/languages.js` resolve to a tag. Verified by comparing the UI
list against `_bcp47_tag_for_language_name`. The risk is that the two lists
diverge later.

**Smallest safe correction** — treat an unsupported language like a missing
reference: return `None` and record the existing `voice_cloning_tts_skip` metric.

### 4. LOW — the reference identity does not actually participate in staleness

**Where** — `app/voice/tts_delivery.py:949`.

`_record_is_current` recomputes the key with `reference_id=record.reference_id`,
that is, the record's own identity. The reference component therefore always
matches and can never invalidate a preparation. It reads like a staleness input
but is a no-op.

Not invalidating is consistent with the design ("an existing TTS preparation
remains keyed to the reference identity it started with"), so the behaviour is
right; the mechanism is misleading. Anyone later relying on it to invalidate a
queued preparation would find it silently does nothing.

**Smallest safe correction** — compare against the lane's *current* reference id
if invalidation is wanted, or drop the parameter and state the intent in a
comment if it is not.

### 5. LOW — disabling cloning does not cancel already-queued cloned preparations

**Where** — `app/runtime.py:326` (`_update_voice_cloning`).

The handler calls `voice_cloning.set_enabled` but not
`tts_delivery.settings_changed`, and `voice_cloning.enabled` is not part of
`_synthesis_settings_key`. Preparations created while cloning was on therefore
survive the toggle.

**Trigger** — with cloning ready, speculative preparation fills its budget; the
user turns **Clone speaker voice** off; the user presses Speak on one of those
bubbles. `_dispatch_speak_sequence`'s cloning guard only blocks when cloning is
*enabled*, so `_play_part` takes the ready-hit path and plays the cloned voice
after the user disabled cloning.

Defensible as "the audio was already prepared", and it matches replay semantics.
Worth a deliberate decision rather than an accident.

**Smallest safe correction** — drop unsubscribed cloned preparations in
`_update_voice_cloning` when cloning is switched off.

## What holds up

- **Prompt and audio come from one selection.** `_materialize_reference` clips
  and joins from the same `selected` tuple and raises before writing if either
  half fails, so they cannot diverge.
- **Interval validation is sound.** `_normalize_candidates` rejects empty text,
  reversed and zero-length intervals, and anything outside the job WAV window,
  which guarantees a non-negative relative offset at clip time.
- **The newest overlapping result wins.** The selector walks backward and
  rejects any interval overlapping an already selected one, on absolute session
  timestamps, so a rolling re-transcription cannot duplicate spoken audio.
- **No cut inside a segment.** A candidate longer than `max_duration_s` is
  skipped, never truncated.
- **`min_duration_s` is the real threshold.** The cloning branch bypasses
  `_last_speech_reference_choice` entirely, so the hard-coded three-second term
  in `_last_speech_quality_score` no longer applies to cloning.
- **Lanes are independent.** Separate deques, references, state, and status
  events per lane; `_next_turn` sends the new lane's status.
- **Reference WAVs count against the session cap.** They land under
  `data/tts/<session>/voice_cloning/<lane>/`, which is inside the accounted TTS
  root, and `_directory_bytes` recurses.
- **Materialization runs off the event loop** via `asyncio.to_thread`, and its
  failures are handled: `SessionArtifactLimitExceeded` ends the session through
  the existing guardrail, `OSError`/`ValueError` leave the lane preparing and
  record a rejection metric. Fail-closed, no fallback voice.
- **The speculation budget is not consumed by a skipped bubble** — the `None`
  check precedes the decrement.
- **Manual Speak while preparing** sends a non-error `tts_status` with reason
  `voice_clone_preparing` and returns before the part is marked speaking, so the
  bubble stays pending.
- **Reaching ready does not replay the backlog** — nothing enqueues past bubbles.
- **Cloning is a separate semantic setting.** Create and live-update both
  validate through `normalize_voice_cloning_settings`, and `_update_tts_settings`
  refuses a backend change that would leave an enabled cloning session on a
  non-VoxCPM backend.
- **Capability reporting** distinguishes the *configured* backend from the
  displayed substitute, so a missing backend reports `voice_cloning: false`.
- **Enabling cloning never switches the backend.**
- **Metrics carry no transcript or audio** — only session, lane, state, reason,
  duration and segment counts.
- **The desktop option is disabled without capability**, is independent of
  **Automatically speak translations**, follows the active lane, and orders
  status as error > preparing > playback > ready.

## Unresolved risks

- **A failed config fetch is never retried.** `loadConfig` memoizes
  `configLoadPromise` and `loadConfigOnce` swallows the error, so a transient
  failure leaves `voiceCloningAvailable` false for the page's lifetime. Not a
  regression — the previous code also fetched once — but `start()` now awaits the
  memoized promise, so the retry it looks like it performs does not happen.
- **Disabling cloning clears the candidate deques**, so re-enabling requires
  speaking the full `min_duration_s` again. Reasonable, but not stated in the
  design.
- **One speaker per lane** is assumed; the design says so explicitly.
- **Preparing outranks playback status** in the desktop status line. Harmless
  while cloning gates all synthesis, but a replay of pre-cloning audio would be
  hidden behind the preparing message.

## Test gaps

- No test drives a rolling sequence of overlapping ASR results, which is why
  finding 1 went unnoticed; the existing tests feed disjoint results.
- No test covers reference-write frequency or cumulative reference storage.
- No test covers a module-graph URL check (finding 2).
- No test toggles cloning off while preparations are queued (finding 5).
- No test covers a target language without a BCP47 tag (finding 3).

## Paths not exercised

- Real ASR-pool, translation-services and TTS-pool interaction; everything ran
  against the real app modules but synthetic audio and segments.
- Actual VoxCPM Prompt + reference synthesis quality; the mapping was read, not
  heard.
- Browser behaviour of the two switches and the status line; only the DOM and
  state logic were read. Narrow widths and increased text size were not checked.
- Stereo or non-16 kHz source WAVs, and truncated WAVs.
- Two clients on one session, and desktop plus mobile at once.

## Resolution

Resolved in `ee50836`.

1. Reference identity now uses the selected lane, timestamps, and text, without
   request-local ASR or segment identifiers. A regression test verifies that an
   unchanged rolling selection does not write another reference WAV.
2. Every desktop consumer of the changed shared API, storage, and appearance
   modules now uses the same cache version. A module-graph test fails when one
   source module resolves through more than one URL or a preload uses a
   different version.
3. An unsupported cloning target language now fails closed before synchronous
   speculative preparation can raise. Manual demand receives a structured
   skipped status.
4. `_record_is_current` now documents that a preparation intentionally keeps
   the immutable reference it started with; later lane references apply only to
   later preparations.
5. A cloning-mode change drops unused, unsubscribed preparations from the old
   mode. Subscribed playback and completed replay audio keep their original
   voice.

The reported live direction-switch issue was also fixed. The desktop language
bar now follows the backend's current turn after `<->`, instead of continuing
to show the fixed setup order. Playback status also takes priority over the
cloning-preparation message while audio is active.

Post-fix validation: 284 Python tests and 95 JavaScript tests pass, including
the new rolling-reference, unsupported-language, mode-toggle, module-graph, and
live-direction regression coverage. Syntax, compilation, and diff checks pass.

## Re-review at `f4fe550`

The PR grew after `dcc29b3`: `f4fe550` adds the Female / Male / Clone speaker
selector, fallback synthesis while a lane prepares, the iOS playback transition,
removal of the Translate and Speak controls, and the turn-boundary preview fix.
Reviewed against `main` at `d06d084`, with extra attention to that commit.

| Check | Result |
| --- | --- |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `python -m unittest discover -s tests` | 292 tests, pass |
| `node --test tests/js/` | 106 tests, pass |
| `git diff --check main...HEAD` | clean |

**Merge-quality verdict: mergeable once finding 6 is settled.** Finding 6 is a
latent turn wedge with a one-line fix; finding 7 is a gap in a regression guard.
Findings 1 to 5 remain resolved — the reference-identity and module-graph fixes
still hold under the new code.

### 6. MEDIUM — Female or Male with an unmapped target language leaves the turn wedged

**Where** — `app/runtime.py:766` (the language guard) and
`app/voice/tts_delivery.py:352` into `app/voice/tts_delivery.py` `_play_part`.

`ee50836` gave Clone speaker two guards: a dispatch-level language check that
sends a structured `tts_status`, and a `try/except ValueError` in
`_new_preparation`. The new Female / Male path added in `f4fe550` has only the
second. The dispatch guard is still gated on
`self.voice_mode == VOICE_MODE_SPEAKER_CLONE`, so for a product voice
`_dispatch_speak_sequence` marks the part `speaking`, starts the task, and
`_play_part` then returns because `_new_preparation` gave `None` — without ever
settling the part.

**Trigger** — voice mode Female or Male, VoxCPM backend, and a target language
with no BCP47 tag; press Speak.

**Observed**:

```
part.speech_state        : speaking
turn.state               : open_speaking
tts_status sent to client: []
lane.tts_task            : None
```

The turn stays pinned in `OPEN_SPEAKING`, so `_source_event` drops all further
ASR and the bubble shows Preparing until the user presses Stop. This is the same
wedge class as finding 1 of the PR #21 review and finding 4 of PR #23.

Currently unreachable through the UI: all 41 languages in
`static/src/domain/languages.js` resolve to a tag. The speculative path is safe
— `prepare_definitive_part` returns before decrementing, so the budget is
preserved and the session does not end. Only the manual and automatic dispatch
paths wedge.

**Smallest safe correction** — settle the part in `_play_part` when
`_new_preparation` returns `None`: reset `speaking` to `pending` and refresh the
turn state. That closes the whole class rather than this one route. The
narrower alternative is to drop the `VOICE_MODE_SPEAKER_CLONE` condition from
the dispatch language guard so it covers every product voice mode.

**Missing test** — a product voice with an unsupported target language must
leave the bubble pending and the turn out of `OPEN_SPEAKING`.

### 7. LOW — the module-graph guard covers only the desktop entry

**Where** — `tests/js/desktop-module-graph.test.mjs:44`.

The test added for finding 2 walks `static/desktop/index.html` only. The mobile
graph rooted at `static/src/app.js` is unchecked, and it currently has a split:

```
static/src/settings/sheet.js -> ['', 'v=20260823-third-party-notices-1']
     static/src/app.js                ?v=20260823-third-party-notices-1
     static/src/session/lifecycle.js  ?(none)
```

That split predates this PR — verified against `main` — so it is not a defect
introduced here. The gap matters because `f4fe550` adds new versioned imports to
the mobile graph (`audio-playback.js` and `audio-session.js` at
`v=20260829-ios-playback-1`), which is exactly where the guard is now absent.
Those two are consistent today.

**Smallest safe correction** — parameterize the existing test over both entry
documents.

### Verification of the earlier findings under the new code

- **Finding 1** — the module-graph walk of the desktop entry now covers 52 files
  and reports one URL per module, with no preload mismatch. Reference identity
  still hashes only timestamps and text.
- **Finding 2** — desktop graph clean; see finding 7 for the mobile gap.
- **Findings 3 to 5** — the cloning language guard, the documented staleness
  intent, and the mode-change drop all survive the refactor into
  `voice_mode_changed`.

### What holds up in the new work

- **Fallback voice selection is correct.** Measured:

  ```
  session starts in speaker_clone -> fallback: female
  Female -> Clone -> Male -> Clone  ->  female, female, male, male
  ```

  So Clone speaker uses the last explicit Female or Male choice, and defaults to
  Female only when no such choice was made.
- **Reaching readiness drops only unused fallbacks for that lane.**
  `voice_cloning_reference_ready` skips other lanes, non-clone modes, and any
  subscribed record, so active playback and completed replay audio are untouched.
- **Stable voices do not smuggle in a last-speech reference.**
  `product_stable_voice_settings` sets `reference_source` to `stable_generated`,
  after which `_last_speech_reference_choice` returns `None`.
- **The stable-sample dependency is not new.**
  `VOXCPM2_DEFAULT_LANGUAGE_CONFIG` already used `reference_audio` with
  `stable_generated`, and `stable_voice_wav_path` falls back to the curated
  English sample.
- **The turn-boundary fix is correctly scoped.**
  `_accept_visible_previews_for_parts` writes lane scope only for the last part
  when it is still open, so an older closed part can be finalized without
  prefixing the current bubble, while the current open part still updates scope.
- **The iOS resume path is well guarded.** `_iosCaptureResumeTask` prevents a
  double open; `restoreMicrophoneCaptureAfterIosPlayback` re-checks app mode,
  mic state and `audioQueue.hasAudio()` before opening and again after
  `getUserMedia` resolves, including the session id, stopping the fresh capture
  when the expectation no longer holds. A failure during resume settles
  `micState` to `OFF` and clears capture muting.
- **The delayed start is cancelled everywhere it must be** — `stop`, `clear`,
  `playNext`, and `failPcmStream` all call `cancelPendingPlaybackStart`, and
  `schedulePendingPcm` refuses to schedule while the timer is pending.
- **Platform detection** matches iPhone/iPad/iPod by user agent plus the
  `MacIntel` with `maxTouchPoints > 1` idiom for iPadOS desktop mode, which does
  not match macOS Safari. Both the mobile and desktop queues apply the 90 ms
  delay.

### Unresolved risks

- **iOS behaviour is untested on a device**, as the prompt states. The logic
  reads correct, but the 90 ms constant, the audio-session type switch, and the
  interaction with the browser's own routing can only be judged on hardware.
- **`normalize_voice_mode` rejects Female and Male on a non-VoxCPM backend**
  rather than falling back silently. That is consistent with the capability
  gate, but it means a deployment that switches the backend mid-session gets an
  `invalid_voice_mode` error instead of a degraded product voice.

### Test gaps

- No test covers a product voice with an unsupported target language
  (finding 6).
- No test walks the mobile module graph (finding 7).
- No test exercises the iOS pause and resume race: playback starting while a
  resume is awaiting `getUserMedia`.
- No test covers the removed Translate and Speak controls, so nothing guards
  against a reachable dead path.

### Paths not exercised

- Any real device: iOS audio routing, the desktop layout at narrow widths, zoom
  and increased text size, and keyboard access to the voice selector.
- Real VoxCPM synthesis with the stable Female and Male samples; the settings
  mapping was read, not heard.
- Real ASR-pool and TTS-pool interaction.

### Resolution of findings 6 and 7

Both were fixed in the working tree on top of `f4fe550` (not yet committed at the
time of this check). Checks: 293 Python tests, 108 JavaScript tests, syntax,
compilation, and `git diff --check` all pass.

**Finding 6 — resolved with the broad correction.** `_play_part` now settles the
part when `_new_preparation` returns `None`, rather than only guarding the one
route that reached it. Re-running the reproduction:

```
voice_mode=female, language without a tag
  part.speech_state : pending          (was speaking)
  turn.state        : open_active_unspoken   (was open_speaking)
  lane.tts_task     : None
```

The turn is no longer pinned, so ASR resumes. Because the fix sits at the shared
exit rather than at the dispatch guard, it also covers any future
`_new_preparation` rejection. A regression test asserts the pending state, the
turn state, and the `tts_preparation_unavailable` turn update.

One cosmetic residue, not worth changing: no `tts_status` accompanies the turn
update, so a manual Speak on that path silently returns the bubble to speakable
where the cloning path explains itself. The route is unreachable through the UI.

**Finding 7 — resolved.** `desktop-module-graph.test.mjs` now runs over both the
desktop and mobile entry documents. The pre-existing mobile split was cleared by
dropping the stale query from `app.js`'s import of `settings/sheet.js`;
`sheet.js` is unchanged since `main` and was last touched in `cf11238`, so
dropping the cache-buster loses nothing, and the mobile entry URL was bumped
alongside it. Both graphs verified independently:

```
desktop graph: 52 files -> one URL per module, no preload mismatch
mobile  graph: 47 files -> one URL per module, no preload mismatch
```

**Also in this round, outside the findings.** A background-noise guidance note
for Clone speaker was added to the desktop view and the design document, with
its own test, and the desktop cache version moved from `-6` to `-7`. The mobile
entry sits at `-4` on its own counter; the two pages have separate entries, so
that difference is not a module-identity problem. Not reviewed in depth — it is
copy and rendering, outside the reported findings.

**Verdict: mergeable.** Findings 1 to 7 are resolved. The open items are the
untested paths already listed above, chiefly iOS behaviour on a real device.
