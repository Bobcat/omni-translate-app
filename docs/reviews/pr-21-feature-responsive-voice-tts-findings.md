# Review findings: responsive voice TTS streaming

Review of `feature/responsive-voice-tts` against `main` (merge base `cf11238`,
commits `bce9e98` and `e4b5da8`, 22 files). Answers the prompt in
[`pr-21-feature-responsive-voice-tts-review.md`](pr-21-feature-responsive-voice-tts-review.md).

The findings below describe the branch at `e4b5da8`. Fixes landed afterwards in
`d2862f7`; see [Resolution](#resolution) at the end for what each finding did.

All required checks passed at review time:

| Check | Result |
| --- | --- |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `python -m unittest discover -s tests` | 240 tests, pass |
| `node --test tests/js/` | 77 tests, pass |
| `git diff --check main...HEAD` | clean |

Findings 1, 2, 3, 4 and 5 were reproduced. Findings 1–3 use a fake
`AudioContext` harness modelled on `tests/js/audio-playback.test.mjs`; findings 4
and 5 run against the real `ConversationRuntime` with the fake TTS bridge from
`tests/test_turn_state_machine.py`. The reproductions are quoted per finding.

## Findings

### 1. HIGH — a client-side stream failure pins the turn in `OPEN_SPEAKING`

**Where** — `static/src/shared/audio-playback.js:152` (`failPcmStream`) and
`static/src/shared/audio-playback.js:135` (`completePcmStream`).

**Trigger** — any client-side rejection of a chunk:

- sequence mismatch (`audio-playback.js:111`);
- `atob` failure (`audio-playback.js:117`);
- PCM length not frame-aligned (`audio-playback.js:123`);
- no `AudioContext` available (`audio-playback.js:284`).

**Observed** — `failPcmStream` deletes the artifact from `pcmStreams` and never
calls `onItemEnded`. The `tts_stream_complete` that follows no longer finds the
item and returns `false`:

```
chunk seq 0, then chunk seq 2, then complete
  completePcmStream accepted = false    ended = []
```

The browser therefore never sends `tts_playback_complete`. On the server
`lane.pending_tts[artifact_id]` stays set and the part stays `speaking`, so
`app/runtime.py:1001` pins the turn to `OPEN_SPEAKING`. From there
`_source_event` (`app/runtime.py:709`) and `_translate_now`
(`app/runtime.py:661`) refuse all further ASR and translation. The session is
dead until the user presses Stop. The finished WAV exists on disk and its URL
sits in the ignored `tts_stream_complete`.

**Smallest safe correction** — make a client-side failure tell the server. Split
`failPcmStream` (server-triggered, keep as is) from an internal abort path that
also fires a new `onItemFailed` callback, wired to
`state.socket?.stopTts({laneId, turnId, artifactId})`. The server's `stop()`
already resets the parts to `pending` and clears `pending_tts`.

A larger variant recovers the audio too: mark the item `failed` instead of
deleting it, and let `completePcmStream` fall back to
`this.enqueue({...item, url})`. That plays the WAV and settles the item through
the existing `<audio>` `ended` path.

**Missing test** — a decode or sequence failure must still settle the item and
signal the server.

### 2. HIGH — a queued stream that completes with no chunks stalls the queue

**Where** — `static/src/shared/audio-playback.js:243` (`playNext` never calls
`finishPcmIfReady`).

**Trigger** — bubble 2 is queued behind bubble 1, its `tts_stream_complete`
arrives while bubble 1 is still playing, and bubble 2 produced no audio chunks.
That is reachable: `chunk_count == 0` passes the check at
`app/upstreams/tts_pool/client.py:178`, and empty PCM is dropped at
`app/voice/tts_delivery.py:182`.

**Observed** —

```
a1 plays, a2 completes with 0 chunks
  ended = ['a1']    current = a2    status = "Preparing audio"   (permanent)
```

`playNext` makes `a2` current, `schedulePendingPcm` schedules nothing, and no
`ended` event ever fires to trigger `finishPcmIfReady`. Same downstream effect as
finding 1: the turn stays `OPEN_SPEAKING`.

**Smallest safe correction** — in `playNext`, call `this.finishPcmIfReady(next)`
directly after `this.schedulePendingPcm(next)`.

**Missing test** — a stream that completes with zero chunks settles and the queue
advances.

### 3. MEDIUM-HIGH — a suspended `AudioContext` reports as playing and never recovers

**Where** — `static/src/shared/audio-playback.js:63` (`preparePcmPlayback`) and
`static/src/shared/audio-playback.js:281` (`schedulePendingPcm`).

`preparePcmPlayback` sets `blocked = false` when `resume()` resolves, without
checking `context.state`. `schedulePendingPcm` then schedules sources and sets
`playbackStarted` regardless of state.

**Observed**, with a context that stays `suspended` after `resume()` resolves:

```
blocked = false   started = ['a1']   status = "Playing audio"
resumeButton.hidden = true
```

Nothing is audible, there is no resume affordance, and no `ended` will fire — so
the item never settles and the turn pins as in findings 1 and 2.

**Scope today** — every entry point calls `preparePcmPlayback()` inside a user
gesture, so this is latent rather than live. Two reasons to fix it now:

- the planned "automatic speaking after every definitive target bubble" has no
  gesture to attach to;
- a context can also be suspended by the page going to the background, which the
  `<audio>` element path did not do. See the risks section.

**Smallest safe correction** — after `resume()`, set
`this.blocked = context.state !== 'running'`. In `schedulePendingPcm`, schedule
nothing (and keep `pendingChunks`) while `context.state !== 'running'`.

**Missing test** — a suspended context must set `blocked`, keep the resume button
visible, and not report the item as started.

### 4. MEDIUM — `cached_turn_artifacts` is never pruned

**Where** — `app/voice/tts_delivery.py:46`, written at
`app/voice/tts_delivery.py:282`.

`replay()` only ever reads the current turn (`app/voice/tts_delivery.py:61`), so
every closed turn's entries are dead weight, each holding a full TTS payload
including the `metrics` and `metadata` dicts. `_close_current_turn`
(`app/runtime.py:912`) clears `pending_tts` but not this cache.

**Observed** after three speak-and-close cycles:

```
cached_turn_artifacts:
  [('turn_1','turn_1_part_1'), ('turn_2','turn_2_part_1'), ('turn_3','turn_3_part_1')]
```

**Smallest safe correction** — drop the closed turn's entries in
`_close_current_turn`.

**Missing test** — the cache is empty for a turn after that turn closes.

### 5. MEDIUM — `active_stream_artifacts` leaks on a turn change before `started`

**Where** — `app/voice/tts_delivery.py:162` (`stream_started`) against
`app/voice/tts_delivery.py:212` (the `CancelledError` handler).

`stream_started` writes the artifact into the dict from the worker thread
*before* the staleness check inside `send_from_synthesis`. If the coroutine was
already cancelled by then, it has popped the still-empty `stream_artifact_id` and
nobody removes the entry afterwards — `stop()` only filters on the current turn
ID.

**Observed**, with a TTS fake that blocks until after `_next_turn`:

```
active_stream_artifacts after turn change:
  {'late_artifact': ('turn_1', ['turn_1_part_1'])}
```

Harmless to the logic, because a stale turn ID never matches again. It grows
without bound over a session.

**Smallest safe correction** — populate the dict only after
`send_from_synthesis` succeeds, or drop entries for the closed turn in
`_close_current_turn`.

### 6. MEDIUM — there is no way to stop during "Preparing"

**Where** — `static/src/ui/render-turn.js:126` and
`static/desktop/src/views/voice/index.js:196`.

The preparing button is `disabled`. The global Speak button is a debug control
and does not stop anything (`static/src/ui/action-buttons.js:31`). Between the
Speak click and the first scheduled chunk — which sets `state.audioPlayback` and
only then reveals the Stop button — a slow synthesis cannot be cancelled. The
server side of this path is correct and covered by
`test_stop_cancels_an_active_stream_and_returns_the_part_to_pending`; it is
simply unreachable from the UI.

**Smallest safe correction** — keep the preparing button clickable with
`data-audioAction="stop"` and apply only the spinner styling.

### 7. MEDIUM — a 5-second WebSocket stall destroys the bubble and the pool work

**Where** — `app/voice/tts_delivery.py:148` (`send_from_synthesis`).

The synthesis thread blocks on `future.result(timeout=5)`. On timeout the
exception propagates out of `synthesize_tts`, where the new handler at
`app/upstreams/tts_pool/client.py:170` cancels the gRPC call. The WAV is never
written, so there is no Replay fallback either — the part drops back to
`pending` and the pool work is discarded.

The stall is plausible on a poor mobile uplink, because `lifecycle.send` holds
one shared `send_lock` for chunk traffic and turn updates alike. It has not been
measured; see the risks section.

Related, minor: `future.cancel()` is a no-op once the coroutine has started, so a
timed-out chunk can still arrive after `tts_stream_failed`. That is harmless —
the client has already discarded the stream.

**Smallest safe correction** — on timeout, raise `_StaleTtsStream` instead of
propagating. Forwarding stops, synthesis still finishes, and the WAV lands so the
client can fall back to the URL path. That fallback depends on finding 1.

### 8. LOW-MEDIUM — cancellation reaches the pool only at the next callback

**Where** — `app/voice/tts_delivery.py:294` (`stop`).

`stop()` bumps `stream_generation` and cancels the asyncio task, but nothing
cancels the gRPC call directly. The worker thread notices only at its next
`on_audio_chunk`. If the pool stalls, the request and a thread-pool worker stay
occupied until `timeout_s`.

**Smallest safe correction** — pass a `threading.Event` cancel token into
`synthesize_tts` and check it between events.

### 9. LOW — tapping a "preparing" bubble sends `replay_tts` on mobile

**Where** — `static/src/ui/render-turn.js:25` into
`static/src/ui/render-turn.js:40`.

The coarse-pointer fallback picks up the disabled button through
`row.querySelector`, and `handleBubbleAudioAction` falls into the `else` branch
for `data-audioAction="preparing"`, calling `triggerReplayFromButton`. Harmless
today — `replay()` rejects a part that is not `spoken` — but it bypasses the
`disabled` attribute.

**Smallest safe correction** — return early on `action === 'preparing'`, or skip
disabled buttons in the row fallback.

### 10. LOW — a failed replay is now silent

**Where** — `app/voice/tts_delivery.py:62`.

The unavailable-artifact path sends `tts_status` with `state="unavailable"` and a
message, but both clients handle `tts_status` by calling `updateActionButtons()`
only (`static/src/session/messages.js:105`). On `main` this path emitted an
`error` event, which at least changed the status line. The user now sees nothing.

**Smallest safe correction** — surface `message`, or drop the event.

### 11. LOW — Stop during a replay cancels an unrelated in-flight synthesis

**Where** — `static/src/ui/render-turn.js:41` and
`static/desktop/src/views/voice/session.js:613`.

Both send `stop_tts` unconditionally, and the server cancels `lane.tts_task`
whether the stopped item was a replay (URL) or a live stream. Sequence: speak two
bubbles, bubble 1 finishes, replay bubble 1 while bubble 2 is still synthesising,
press Stop — bubble 2 dies. This may be intended. If not, gate the call on
`this.current?.kind === 'pcm'`.

### 12. INFO — whole-audio copies

**Where** — `app/upstreams/tts_pool/client.py:183` and `app/tts_bridge.py:309`.

The chunk list, `b"".join(chunks)`, the `BytesIO` inside `wav_bytes()` and
`write_bytes` mean roughly three full copies of the audio are resident at once.
This predates the branch. It is worth revisiting now that the PCM has already
been shipped to the browser: the accumulation exists only to write the WAV, and
streaming frames into `wave.open(path, "wb")` as they arrive would remove two
copies and the tail latency.

## What holds up

- `tts_clip_ready` is gone from all reachable code. A grep across `.py`, `.js`,
  `.mjs`, `.html` and `.md` returns nothing.
- Mobile and desktop handle an identical event sequence, including the
  deliberate absence of a turn filter on `tts_stream_failed`.
- No deadlock in the thread-to-loop handoff. `stop()` does not hold `send_lock`
  while awaiting `cancel_task`, so a pending `run_coroutine_threadsafe` send can
  always complete.
- Event order `started` → `chunk*` → `complete` is guaranteed. The worker thread
  awaits each chunk send before the next, and `complete` is sent only after the
  thread returns.
- The new `except Exception` plus `call.cancel()` in the pool client also covers
  the pre-existing protocol `ValueError`s, so a malformed pool stream no longer
  leaves the request running.
- Replay cannot expose another turn's or session's artifact. The cache is
  per-runtime, the key contains the turn ID, and `replay()` reads only the
  current turn.
- Part-ID addressing is applied consistently. `onItemEnded` now settles exactly
  `item.partIds` instead of the first `speaking` part.
- `omni-spin` (desktop) and `voice-audio-spin` (mobile) are both defined.

## Unresolved risks

- **Background playback on iOS.** Moving from `<audio>` to Web Audio means
  playback stops when the page is backgrounded or the screen locks, because the
  `AudioContext` is suspended. This was not tested on a device. It is a plausible
  behaviour change against `main` and should be checked on hardware.
- **Backpressure is unmeasured.** The 5-second timeout in finding 7 was chosen
  without numbers for realistic chunk sizes and uplinks.
- **The `AudioContext` is never closed.** `clear()` and `stop()` leave
  `this.pcmContext` alive for the life of the page.
- **Pre-existing, out of scope.** `GET /api/sessions/{session_id}/tts/{artifact_id}`
  (`app/router.py:681`) performs no session-ownership check; access control rests
  entirely on guessing a uuid4. This branch does not change it.

## Test gaps

- No test covers any client-side failure path. `tests/js/audio-playback.test.mjs`
  covers the happy path and stop-during-stream only. Missing: sequence gap,
  base64 failure, absent `AudioContext`, suspended context, stream with zero
  chunks, and `failPcmStream` on the current item while another item is queued.
- No test asserts cleanup. Nothing checks that `cached_turn_artifacts` and
  `active_stream_artifacts` are empty after a turn change or session close.
- No test simulates a slow `lifecycle.send`.

## Paths not exercised

- Real gRPC pool interaction. Everything here ran against fakes.
- The voice-library URL path under the rewritten `stop()`, which now iterates the
  whole queue rather than the current item only.
- WebSocket reconnection in the middle of a stream.
- The desktop keep-alive path, where the view is detached while audio plays.

## Resolution

Fixes landed in `d2862f7` ("Fix streamed TTS lifecycle edge cases", 19 files).
All checks pass on that commit: 247 Python tests (+7), 81 JS tests (+4),
`git diff --check` clean.

| # | Finding | Status |
| --- | --- | --- |
| 1 | Client-side stream failure pins the turn | Fixed — `abortPcmStream` → `onItemFailed` → `stopTts` |
| 2 | Zero-chunk stream stalls the queue | Fixed in three places |
| 3 | Suspended `AudioContext` reports as playing | Fixed, with recovery on `statechange` |
| 4 | `cached_turn_artifacts` never pruned | Fixed — `discard_turn` and `clear` |
| 5 | `active_stream_artifacts` leaks | Fixed — `before_send` runs on the loop |
| 6 | No way to stop during "Preparing" | Fixed |
| 7 | 5-second WebSocket stall destroys the bubble | **Open** |
| 8 | Cancellation does not reach the pool | Fixed — `TtsSynthesisCancellation` |
| 9 | Tapping a preparing bubble sends `replay_tts` | Fixed as a consequence of 6 |
| 10 | Failed replay is silent | Partly — the part returns to `pending`; `message` is still not shown |
| 11 | Stop during a replay cancels synthesis | Fixed, with one residual — see finding 13 |
| 12 | Whole-audio copies | Open (was INFO) |

Findings 2 and 3 are now defended at more than one layer. A stream with no audio
is rejected at the source (`tts_pool_empty_audio` in
`app/upstreams/tts_pool/client.py`), refused by `completePcmStream`, and drained
by the new `finishPcmIfReady` call in `playNext`.

The split between `failPcmStream` (server-initiated, silent) and
`abortPcmStream` (client-initiated, reports back) is the right shape. A
server-sent `tts_stream_failed` correctly does not echo a `stop_tts` back.

### Re-run of the review reproductions

All five now behave correctly against `d2862f7`:

```
sequence gap         -> failed=[a1,'sequence_mismatch']  stop_tts{turn_1, artifactId:''}
zero-chunk queued    -> ended=[a1]  failed=[a2,'empty_pcm_stream']  current=""
suspended context    -> blocked=true  started=[]  sources=0  resume button visible
        after resume -> blocked=false started=[a1] sources=1  (buffered chunk still plays)
server-sent failure  -> no stop_tts echoed back
cached_turn_artifacts after 3 closed turns -> []
active_stream_artifacts after turn change  -> {}
```

Regression coverage was added for findings 1, 2, 3, 4, 5, 8 and 10.

### 13. LOW — Stop during a replay marks a never-heard bubble as `spoken`

Found while reviewing the fix for finding 11.

**Where** — `static/src/ui/render-turn.js:43` and
`static/desktop/src/views/voice/session.js:621`.

Both gate `stopTts` on `!state.audioPlayback?.replay`. That inspects only what is
*playing*, not what is queued behind it.

**Trigger** — bubble 1 is replaying while bubble 2 is still synthesising, so
bubble 2's PCM stream sits in the queue. The user presses Stop.

**Observed** —

```
stop_tts sent to server?   false     (a replay is playing, so deliberately not)
hasNonReplayAudio()?       true      (bubble 2 is in fact queued)
audio heard from bubble 2: 0 sources
wire traffic:              [["tts_playback_complete","a2"]]
```

`audioQueue.stop()` discards bubble 2, but the item stays in `pcmStreams`. The
later `tts_stream_complete` falls into the `playbackStopped` branch at
`static/src/shared/audio-playback.js:161` and fires `onItemEnded`. The server is
told playback finished and marks the part `spoken`. Recoverable — Replay works —
but the state is wrong.

**Smallest safe correction** — gate on `audioQueue.hasNonReplayAudio()` instead
of `!state.audioPlayback?.replay`. It is `true` in exactly this case, so a
`stop_tts` goes out and the server returns bubble 2 to `pending`. On a plain
replay stop with nothing queued it is `false`, which keeps finding 11 fixed.

### Still open

- **Finding 7.** `send_from_synthesis` still propagates the `TimeoutError`, so a
  five-second WebSocket stall costs both the bubble and the pool work. Decide
  whether to degrade to the WAV path or accept this.
- **Finding 10.** The `message` on the unavailable-replay `tts_status` is still
  not surfaced. The part reset covers the worst of it.
- **Finding 12.** Unchanged.
- **Background playback on iOS.** Still untested on a device. This is the last
  open risk from the original review and is not a code issue.
