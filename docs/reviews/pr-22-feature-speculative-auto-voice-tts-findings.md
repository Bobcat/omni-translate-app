# Review findings: speculative and automatic voice TTS

Review of PR #22, `feature/speculative-auto-voice-tts`, at `ff72325`. Answers the
prompt in
[`pr-22-feature-speculative-auto-voice-tts-review.md`](pr-22-feature-speculative-auto-voice-tts-review.md).

The base is `origin/main` at `bd0e554`, which contains the merge of PR #21. A
local `main` left at `cf11238` makes `git diff main...HEAD` show PR #21 as well;
the diff reviewed here is the 24 files against `origin/main`.

## Resolution

Findings 1–4 were addressed on 27 August 2026 in `ed459a8` and `8f31eec`:

1. Each preparation now serializes buffered and newly arriving PCM forwarding.
   A regression test suspends the first WebSocket chunk while synthesis keeps
   producing and verifies sequence numbers 0–5 arrive in order.
2. `_generate` always resolves its completion future. The generation worker
   catches failures per preparation, settles local state, continues with later
   queue entries, and can be restarted when a queued record is moved forward.
   A test fails the first `tts_stream_complete` send and verifies the second
   preparation still reaches `ready`.
3. The protocol now distinguishes `automatic` from `explicit` playback.
   Automatic playback keeps capture muted while output is audible, then resumes
   the existing microphone session. Explicit Speak retains the turn-ending
   microphone stop. Suppressing microphone input during playback remains
   intentional to prevent TTS output from feeding ASR.
4. URL playback now reports a load error or missing URL through
   `onItemFailed`, which lets both clients send `stop_tts`, clear the queue, and
   release capture muting.

Finding 5 needs no code change. Mobile assigns `is-low-quality-ref` during
preparation, but the only visible rule requires both `is-spoken` and
`is-low-quality-ref`; desktop does not render this marker. An unused speculative
preparation therefore shows no badge.

Finding 6 is intentional. A valid Replay action expresses renewed playback
intent and resets the speculation window even if the server-side artifact has
expired. The part then returns to pending, so the next Speak can generate fresh
audio. The design document now states this ordering explicitly.

Finding 7 remains an accepted bounded tradeoff. The complete PCM buffer enables
a late subscription to join generation, and it is released after forwarding,
completion, cancellation, or session cleanup.

The full post-fix run passes 259 Python tests and 89 JavaScript tests. Static
module syntax, `app/main.py` compilation, and `git diff --check` also pass.

At review time, all required checks passed, matching the author's run:

| Check | Result |
| --- | --- |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `python -m unittest discover -s tests` | 257 tests, pass |
| `node --test tests/js/` | 85 tests, pass |
| `git diff --check origin/main...HEAD` | clean |

Findings 1, 2 and 3 were reproduced against the real `ConversationRuntime` using
the fakes from `tests/test_turn_state_machine.py`. Their output is quoted per
finding. Findings 4 to 7 are read from the code; each says so where it matters.

## Findings

### 1. HIGH — chunk order breaks when a Speak joins an in-flight preparation

**Where** — `app/voice/tts_delivery.py:587` (`_forward_buffered_chunks`), reached
from both `app/voice/tts_delivery.py:569` (`_subscribe`) and
`app/voice/tts_delivery.py:412` (`deliver_from_synthesis`).

Both callers run on the event loop, and `_forward_buffered_chunks` yields at
every `lifecycle.send`. Nothing serialises the two loops per record, so they take
each other's turns on `send_lock`.

**Trigger** — a speculative preparation has buffered chunks 0-2 and is still
producing. The user presses Speak. Sending chunk 0 takes longer than the arrival
of chunk 3.

**Observed**, with a `send_json` that actually suspends, as a real socket does:

```
forwarded chunk sequence numbers: [0, 3, 1, 2, 4, 5]
```

The browser validates the sequence strictly (`static/src/shared/audio-playback.js:124`).
Chunk 3 after chunk 0 triggers `abortPcmStream('sequence_mismatch')`, which sends
`stop_tts` and returns the bubble to `pending`. The headline feature of this PR —
joining an in-flight preparation — loses its audio whenever this timing hits.

**Smallest safe correction** — give `_Preparation` an `asyncio.Lock` and wrap
`_forward_buffered_chunks` in it.

A lock-free alternative is to pop one chunk from the shared list immediately
before each `await`:

```python
while record.chunks:
    chunk = record.chunks.pop(0)
    await self.runtime.lifecycle.send(...)
```

The pop order then matches the FIFO order of `send_lock`. The lock states the
intent more plainly.

**Missing test** — a Speak that joins while the pool keeps producing, driven
through a `send_json` that suspends. `FakeWebSocket.send_json`
(`tests/test_turn_state_machine.py:26`) never yields, so no existing test can
observe this.

### 2. HIGH — one failing send kills the generation worker and wedges TTS for the session

**Where** — `app/voice/tts_delivery.py:335` (`_run_generation_queue`), at
`app/voice/tts_delivery.py:344`.

There is no per-record error handling. `_generate` makes several
`lifecycle.send` calls that can raise, including the `tts_stream_complete` at
`app/voice/tts_delivery.py:531`. The exception leaves `_generate` before
`_resolve_done`, escapes the `while` loop and ends the worker.

**Observed** — two speculative preparations queued, the first failing on its
completion send:

```
worker alive:    False
stranded queue:  [('turn_1','turn_1_part_2')]     state: queued, done never resolved
```

`_move_to_front` (`app/voice/tts_delivery.py:652`) does not call
`_ensure_worker`, so a later Speak on the stranded bubble never restarts
generation:

```
lane.tts_task after Speak:        pending
Speak hung:                       True   (indefinitely)
subsequent Speak refused as busy: True
```

`_play_part` stays on `await asyncio.shield(record.done)`
(`app/voice/tts_delivery.py:279`), `lane.tts_task` is never cleared, and the
guard at `app/runtime.py:611` refuses every later Speak with `tts_busy`. TTS is
dead for the rest of the session.

**Smallest safe correction** — three small changes:

- put `_resolve_done(record)` in a `finally` inside `_generate`, so `done` always
  settles;
- wrap `await self._generate(record)` in `try/except Exception` in the worker,
  re-raising `CancelledError`, so the loop continues;
- call `_ensure_worker()` from `_move_to_front`.

**Missing test** — the worker survives a raising `send_json` and drains the rest
of the queue.

### 3. HIGH — automatic speaking freezes ASR during playback, then switches the microphone off

**Where** — `app/runtime.py:1010` together with the pre-existing guard at
`app/runtime.py:720`.

Automatic speaking sets the part to `speaking`, which puts the turn in
`OPEN_SPEAKING`, and `_source_event` then returns early. Until the browser sends
`tts_playback_complete`, every ASR commit is discarded.

**Observed** — three further ASR commits fed after bubble 1 was auto-spoken:

```
after bubble 1:  part=speaking  turn=open_speaking
parts before/after 3 further ASR commits:  1 / 1
source transcript now:  ['Test']
```

`onPlaybackComplete` then calls `stopMicrophoneCapture()` unconditionally
(`static/src/session/audio-queue.js:31`, desktop
`static/desktop/src/views/voice/session.js:227`). That second half is read from
the code, not measured. The net effect with `auto_speak` on by default: the
microphone stops after every sentence, and speech during playback is lost.

The mechanism predates this PR, but only an explicit Speak triggered it — where
"mic off afterwards" was a reasonable turn rule. Automatic and on by default
makes it continuous. The design document says nothing about the microphone or the
ASR freeze.

`test_auto_speak_handles_subsequent_bubbles_in_order`
(`tests/test_turn_state_machine.py:504`) does not cover this. It calls
`_close_current_bubble` directly, injects `playback_complete` between the two
bubbles, and builds the second part by hand — exactly the steps that do not
happen on their own in production.

**Smallest safe correction** — this is a design decision, not a one-liner. At
minimum, let `onPlaybackComplete` stop the microphone only for playback that came
from an explicit Speak (carry the reason on the item), and decide separately
whether `OPEN_SPEAKING` should keep blocking ASR while speaking automatically.

**Missing test** — an ASR commit arriving during automatic playback still reaches
the transcript.

### 4. MEDIUM — the URL playback path has no failure settlement, and is now the common path

**Where** — `static/src/shared/audio-playback.js:27`. The audio element has
`ended`, `play` and `pause` listeners, but no `error` listener.

With speculation, `tts_artifact_ready` into `enqueue` is the ordinary route for a
ready hit. If the WAV fetch fails — 404, network, expired artifact — no `ended`
fires, so `onItemEnded` never runs and `tts_playback_complete` is never sent.
`lane.pending_tts` keeps its entry, the part stays `speaking`, and the turn stays
in `OPEN_SPEAKING`. That is finding 1 from the PR #21 review again, now through
the URL path. `enqueue` also drops silently when `url` is missing
(`static/src/shared/audio-playback.js:50`).

**Smallest safe correction** — add an `error` listener that settles the current
item through the same `onItemFailed` path PR #21 added for PCM.

**Missing test** — a URL item whose load fails settles and reports to the server.

### 5. LOW — speculation sets a visible quality badge on bubbles nobody asked to speak

**Where** — `app/voice/tts_delivery.py:302`, where `_new_preparation` calls
`_set_part_reference_quality`.

That writes `part.low_quality_reference`, which renders as `is-low-quality-ref`.
On the next `turn_update` the "uncertain voice quality" marker appears on a bubble
that was only prepared speculatively. `speech_state` itself is correctly left
alone, so that part of the requirement holds.

**Smallest safe correction** — keep the value on the record and write it to the
part at `_subscribe`.

### 6. LOW — Replay resets the speculation budget before checking availability

**Where** — `app/voice/tts_delivery.py:176`, with the availability check only at
`app/voice/tts_delivery.py:179`.

A Replay that ends in "audio is no longer available" still releases eight fresh
speculative bubbles. It is self-limiting, because the part then moves to
`pending`, so it cannot be repeated on the same bubble.

**Smallest safe correction** — move the reset below the availability check.

### 7. INFO — one extra whole-audio copy per speculation

An unsubscribed preparation buffers the complete PCM as base64 in `record.chunks`
(about 1.33x the WAV) until generation finishes, on top of the three copies PR #21
already had. The buffer is released properly — the list swap in
`_forward_buffered_chunks` and the clear at `app/voice/tts_delivery.py:540` — so
this is a peak, not a leak. Unused speculative WAVs do stay on disk until
`clear_session`.

## What holds up

- `tts_replay_ready` is gone from all code. Only the design document still names
  it, as a retired path.
- `tts_artifact_ready` is gated by `shouldApplyCurrentTurnMessage` on both
  clients, so a delayed artifact cannot attach to a new turn or lane.
- Preference precedence is right on both clients. Mobile calls `applyTtsConfig`
  before `mergeStoredTtsConfigIntoState` (`static/src/app.js:132`); desktop uses
  `loadAutoSpeakPreference() ?? config`. A stored `false` wins over the server
  default.
- `persistAutoSpeakPreference` spreads `loadTtsGlobalConfig()`, and that loader
  preserves `backend`, `kokoro_voices` and `ultimate_cloning`. The shared
  `tts_global` update loses nothing. Every localStorage access is wrapped in
  try/catch, and the reset loop over `APP_STORAGE_KEYS` includes this key.
- `_synthesis_settings_key` excludes `auto_speak`, so toggling the setting does
  not invalidate in-flight preparations.
- The budget is server-owned, `min_value=0`, defaults to 8, and resets only after
  the validity checks in `_dispatch_speak_sequence`. Stop does not reset it.
- Metrics carry no source or translated text.
- No double counts. `tts_prepared_artifact` with action `used` is guarded by
  `record.used`; `unused` fires only for `state == "ready"`.
- `discard_turn` and `clear()` settle preparations, the queue, cancellation
  handles and artifact metadata consistently.

## Unresolved risks

- The default `FakeWebSocket.send_json` still does not suspend. The regression
  suite now has a targeted suspending WebSocket for joined-generation chunk
  ordering, but other send interleavings may still need purpose-built tests.
- **iOS background playback** is still untested on a device. It was explicitly
  out of scope, but automatic speaking increases the exposure considerably.

## Test gaps

- No test reaches `_close_current_bubble` through the production ASR route. Every
  automatic-speaking test calls it directly.
- One targeted test now fails `tts_stream_complete`. Failures on stream start or
  individual chunks use the same worker boundary but are not injected
  separately.
- Consecutive-bubble ordering is never really exercised, because in production
  only one automatic speak can be in flight at a time (finding 3).

## Paths not exercised

- Real gRPC pool interaction. Everything ran against fakes.
- Actual browser behaviour for `tts_artifact_ready`. DOM-less queue tests now
  cover missing and failed URLs, but no real browser was run.
- A lane change during an in-flight speculative generation.
- localStorage under quota errors or disabled storage in a real browser.
- Two clients, mobile and desktop, on the same session at once.
