# Review findings: voice session runtime and storage guardrails

Review of PR #23, `feature/voice-session-guardrails`. First reviewed at
`d5719ad` against `main` at `682114f`; re-reviewed after the fixes at `e4627ac`.
Answers the prompt in
[`pr-23-feature-voice-session-guardrails-review.md`](pr-23-feature-voice-session-guardrails-review.md).

All required checks pass, matching the author's run:

| Check | Result |
| --- | --- |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `python -m unittest discover -s tests` | 264 tests, pass |
| `node --test tests/js/` | 91 tests, pass |
| `git diff --check main...HEAD` | clean |

**No blockers.** All five findings are non-blocking. Finding 1 is the only one
worth addressing before a production rollout, mainly because of the global lock.

Findings 1, 3 and 4 were measured against the real modules; their output is
quoted. Findings 2 and 5 are read from the code and say so.

## Resolution

Findings 1–4 and the run-loop risk were addressed in `c351c1d`:

1. Each session now has its own lock and running byte total. Both artifact
   directories are scanned only before the first write after process start.
   Session close releases the process-local accounting state.
2. The initial scan uses one `stat()` per path and ignores only a concurrent
   `FileNotFoundError`. Other filesystem errors still fail the write.
3. Limit messages scale bytes through KiB, MiB, GiB, and TiB without scientific
   notation. Tests cover one byte, a fractional KiB, the default, and one TiB.
4. Storage accounting now rejects session ids outside the server-generated
   `[A-Za-z0-9_-]` alphabet. It does not add another sanitizer.

The guardrail close path also wakes a run loop blocked on WebSocket input. A
regression test uses a WebSocket whose `receive()` never returns and confirms
that a background storage limit closes the lifecycle immediately. The design
now states that speculative TTS can consume the storage budget and end the
session.

Finding 5 remains accepted. The session ends immediately and both clients clear
their audio queues on `ended`; restoring temporary bubble state would not be
observable.

A focused re-review was requested after merge because Finding 1 was MEDIUM. It
must verify the incremental per-session accounting in `c351c1d`, the hard-cap
concurrency guarantees, accounting-state release, and the background run-loop
wake-up. The result belongs in a new **Re-review** section in this document.

The post-fix author run passed 269 Python tests and 91 JavaScript tests. It adds
coverage for incremental scanning, concurrent ASR/TTS writes, strict session-id
validation, readable limit units, and the background-close wake-up. The original
exact-limit and rejected-partial-file test remains in place.

## Re-review at `e4627ac`

Independent re-review of the fixes in `c351c1d`. PR #23 was merged as `fc58534`
before this round. All required checks confirmed:

| Check | Result |
| --- | --- |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `python -m unittest discover -s tests` | 269 tests, pass |
| `node --test tests/js/` | 91 tests, pass |
| `git diff --check origin/main...HEAD` | clean |

**All five findings and the run-loop risk are correctly resolved.** One latent
residual is recorded as finding 6 below; it is LOW and unreachable with the
current callers.

Three of the fixes are better than what the review proposed: strict id validation
instead of a fourth sanitizer, an incremental counter instead of only a
per-session lock, and waking the run loop through the existing `asr_ready` event
instead of a new mechanism.

### Finding 1 — resolved, with a large measured effect

Re-measured with 4096 files in the session directory:

```
first write   10.8 ms      (one scan per directory, at session start)
later writes   0.167 ms    average over 50 writes
cumulative    ~0.68 s      over ~4000 writes   (was ~30 s)
```

The per-write cost is now flat instead of growing, and the peak moved to session
start rather than the moment the cap comes into view. The scan really is
one-off: **2 directory scans across 20 writes**, not 40.

The critical invariant holds — ASR and TTS still share one usage record and one
lock, so the cap cannot silently double:

```
ASR and TTS share usage record : True   same lock: True
concurrent 400+400 with 500 left: [('ok','r1'), ('rejected','r2')]  disk 900 <= 1000
exact-limit write               : ACCEPTED
one byte over                   : REJECTED, partial file left = False
cached total vs disk            : equal
```

### Finding 2 — resolved

`_directory_bytes` now takes one `stat()` per path and catches only
`FileNotFoundError`; other filesystem errors still fail the write. `_file_size`
does the same for the file being replaced. `S_ISREG` replaces `is_file()` with no
behavioural change.

### Finding 3 — resolved

Readable across the whole range:

```
1 -> "1 byte"          1536 -> "1.5 KiB"        268435456 -> "256 MiB"
1610612736 -> "1.5 GiB"   1099511627776 -> "1 TiB"    0 -> "0 bytes"
```

The `.rstrip("0").rstrip(".")` keeps "256 MiB" clean instead of "256.0 MiB".

### Finding 4 — resolved

Divergence now fails loudly instead of silently:

```
''  '   '                       -> session_id_required
'../escape'  'a/b'  'conv.2026.abc'  -> invalid_session_id
```

### Run-loop risk — resolved

Verified with a WebSocket whose `receive()` never returns, ending the session
from a background task:

```
run loop exited        : True after 9 ms
ended event            : ('session_storage_limit', '...reached the 256 MiB storage limit.')
websocket close code   : 1000
lifecycle.close_reason : session_storage_limit
```

Previously the loop waited until the duration deadline. Accounting release was
verified separately: usage entries for the session go **1 -> 0** on `close()`.

### Finding 5 — accepted

The reasoning in the Resolution matches what this review checked earlier: both
clients clear their audio queues on `ended`, so restoring temporary bubble state
would not be observable.

### Design document

Both items previously listed as unresolved risks are now written down: that
speculative TTS can consume the budget and end a session, and that external
changes to an active session directory are unsupported. The second is the right
way to bound the new cache.

### 6. LOW — an `extra_directory` outside both roots now splits the lock, not just the count

**Where** — `app/voice/session_storage.py`, the `_session_usage` key
`(token, directories)`.

The directories tuple is part of the key. For the real writers it always
coincides, because ASR and TTS both write inside the two roots, which is why they
share one record. A path outside them produces a second record:

```
extra_directory outside the roots -> same usage record: False | same lock: False
keys for this session in _SESSION_USAGE: 2
```

Two records means two locks, and then two concurrent writes can claim the same
remaining capacity. Before this commit that case was only a counting error; it is
now a concurrency gap as well. Unreachable with the current callers.

**Smallest safe correction** — key on `token` alone and keep the directories out
of the key.

### Noted for later, not blocking

The running total is only correct as long as nothing else touches the session
directories. That is now documented, but `app/tts_bridge.py:239`
(`TTSBridge.clear_session`) still exists and is called from nowhere. If it is
ever wired up while a session is live, the counter stays too high and sessions
end early — a dead function that breaks exactly the assumption just recorded.
Removing it or marking it is cheap.

## Findings

### 1. MEDIUM — the per-write directory scan grows quadratically over a session, under one process-wide lock

**Where** — `app/voice/session_storage.py:92` (`_directory_bytes`), called inside
`_WRITE_LOCK` at `app/voice/session_storage.py:59`.

Every WAV write scans both session directories in full with `rglob` plus a
`stat()` per file. ASR chunks are never deleted during a session — there is no
`unlink` anywhere in `asr_bridge` or `app/voice` — so the file count grows
monotonically towards the cap.

**Observed**, using sparse files and a warm page cache:

```
873 files (300 KiB chunks, 255.8 MiB):   3.3 ms scan   3.1 ms per write_session_artifact
4096 files (64 KiB chunks, 256.0 MiB):  14.7 ms scan  14.2 ms per write_session_artifact
cumulative lock-held time over a session: ~1.4 s and ~30 s respectively
```

Two things make this more than a microbenchmark. `_WRITE_LOCK` is module-global
rather than per session, so every ASR and TTS write of *every* concurrent session
serialises behind it. And the lock is held across both the scan and
`write_bytes`, so a multi-megabyte TTS WAV blocks ASR writes for the duration of
the write as well.

At the shipped defaults and realistic chunk sizes this is a few milliseconds per
write — not a stall, but a cost that grows with session length and peaks exactly
when the cap comes into view.

**Smallest safe correction** — keep a running byte total per session and update it
incrementally inside the lock, scanning only on a session's first write. As an
intermediate step, make the lock per session instead of global.

**Missing test** — none. This is a performance property, not a correctness defect.

### 2. LOW — `_directory_bytes` has a TOCTOU between `is_file()` and `stat()`

**Where** — `app/voice/session_storage.py:96`.

```python
for path in directory.rglob("*"):
    if path.is_file():
        total += path.stat().st_size
```

Two syscalls. If the file disappears in between, `stat()` raises
`FileNotFoundError` out of `write_session_artifact`. In ASR that lands in the
generic `except Exception` and surfaces as `asr_submit_failed`; in TTS as
`tts_failed`. A storage decision degrades into a generic error.

The cleanup sweep does **not** race here. `cleanup_expired`
(`app/sessions.py:147`) skips sessions with `ws_connected`, and
`_remove_orphaned_artifacts` skips names in `active_session_ids`, so a live
session is never swept. The trigger is therefore external deletion or a second
process, not the normal flow.

**Smallest safe correction** — wrap the body in `try/except OSError: continue`.
One line.

### 3. LOW — `_format_bytes` emits scientific notation outside a narrow range

**Where** — `app/voice/session_lifecycle.py:252`.

`f"{mib:g}"` uses six significant digits. At the default 256 MiB the message
reads correctly, but a deployment that changes the cap gets this in the UI:

```
limit=1099511627776  ->  "...reached the 1.04858e+06 MiB storage limit."
limit=            1  ->  "...reached the 9.53674e-07 MiB storage limit."
```

`min_value=1` explicitly permits that lower bound. `_format_duration` does not
have the problem: it formats minutes as an `int`.

**Smallest safe correction** — round and scale the unit, for example GiB above
1024 MiB, using `:.0f` or `:.1f` instead of `:g`.

**Missing test** — the message for a non-default configured limit.

### 4. LOW — three different sanitizers for the same session identity

**Where** — `app/asr_bridge.py:471` (sanitizes silently), `app/tts_bridge.py:1096`
(raises), `app/voice/session_storage.py:78` (raw `strip()`).

For real, server-generated ids all three agree:

```
conv_20260827T130000Z_a1b2c3d4  ->  asr / tts / storage tokens all identical
```

They diverge as soon as an id contains a character outside `[A-Za-z0-9_-]`:

```
conv.2026.abc  ->  asr: conv_2026_abc   tts: raise   storage: conv.2026.abc
```

`_session_artifact_directories` would then point at non-existent paths, and each
write would count only its own directory through `extra_directory`. ASR and TTS
accounting would split and the effective cap would silently double. Unreachable
today, because `app/sessions.py:66` generates ids from a fixed alphabet.

**Smallest safe correction** — have `session_storage` use the same tokenizer as
the writers instead of a raw `strip()`.

### 5. LOW — the TTS storage limit leaves the bubble mid-state and sends no `tts_stream_failed`

**Where** — `app/voice/tts_delivery.py:501`.

The handler clears the record and ends the session, but does not return
`part.speech_state` to `pending` the way the generic handler does, and sends no
`tts_stream_failed`. That is harmless today: the browser receives `ended`, and
`resetLiveRecordingToSetup` into `clearAllLanes` into `audioQueue.clear()` tears
the PCM stream down.

It does depend entirely on `ended` arriving, and that send sits inside
`contextlib.suppress(Exception)` (`app/voice/session_lifecycle.py:191`). If it
fails, the user sees only a closing socket and a return to setup with no notice.

**Smallest safe correction** — none urgent. For symmetry, reset the part to
`pending` as the generic branch does.

## What holds up

The accounting core is solid. Tested against the real module:

```
exact-limit write                ACCEPTED   (correct: > , not >=)
one byte over                    REJECTED   partial file left behind = False
replacement write                counts only the replacement (900 -> 950)
concurrent ASR+TTS, 500 left     ['ok' tts, 'rejected' asr] -> total 900 <= 1000
session_id '' / '   '            rejected (session_id_required)
session_id '../escape'           rejected (invalid_session_id)
get_int clamping                 duration 30 -> 900, artifact -> 268435456
```

The lock boundary around calculation and write is therefore correct: two
concurrent writes cannot claim the same remaining capacity.

Also verified:

- **The deadline starts at accept.** `deadline_mono` is set immediately after
  `websocket.accept()` and uses `loop.time()`, which is monotonic.
- **No starvation.** The deadline check is the first thing in `wait_for_input`,
  ahead of the ASR-ready check, and `asyncio.wait` receives the remaining time as
  its timeout. Neither continuous audio nor ASR events can skip it.
- **One settlement, correct reason.** `_end_for_guardrail` guards on
  `self.closed`, sets `close_reason`, and `close()` passes it to
  `SESSIONS.close`. Two guardrails firing yields one `ended`.
- **Retention still applies.** `SESSIONS.close` sets
  `expires_unix = max(expires, now + export_ttl_s)` regardless of reason.
- **The browser cannot raise the limits.** Both are read through
  `get_int("live.…")` from config, not from `self.live_settings`, and
  `_update_live_settings` goes through `normalize_live_settings_delta`.
- **A rejected artifact never reaches the ASR pool.** `write_session_artifact` is
  at `app/asr_bridge.py:179`, before the `ASRSubmitRequest` at
  `app/asr_bridge.py:212`.
- **No artifact is published after the exception.** `_generate_record` returns
  before `tts_payload`, `state="ready"` and `pending_tts`.
- **The specific exception precedes the generic one** in both handlers.
- **The close race is covered.** Both clients guard their `onClose` with
  `if (state.socket !== socket) return`, and `cleanupClientSession` /
  `cleanupSession` null `state.socket` synchronously before the asynchronous
  close event. The limit notice survives cleanup.
- **No stale notice.** Mobile clears `sessionEndMessage` in `startListening` and
  `resetLiveRecordingToSetup`, and renders it only in SETUP; image translation is
  a separate `appMode`. Desktop clears `status` and `statusMessage` in `start()`.
  A normal Finish carries reason `pause_listening`, for which
  `voiceSessionEndMessage` returns an empty string.
- **The voice library falls outside the cap.** It lives under
  `data/voice_library/stable/`, not under a session directory.

## Unresolved risks

- **The run loop only ends when the client disconnects.** When the storage limit
  is hit from the TTS generation worker, `_end_for_guardrail` closes the socket,
  but the loop is inside `wait_for_input` awaiting `websocket.receive()`. The
  disconnect normally arrives at once; if it does not, the loop waits until the
  duration deadline and `SESSIONS.close` is delayed accordingly.
- **Speculative TTS can end the session.** A preparation the user never asked for
  can hit the cap and close the session. Defensible — storage really is full —
  but the design document does not mention it.
- **The mobile layout with the longest message** was not opened in a browser.
  `.setup-session-notice` has a `max-width: 300px` in fixed pixels, which does not
  scale with enlarged text; the longest default message is 84 characters.

## Test gaps

The five added Python tests and two JavaScript tests cover the happy paths. Not
covered:

- concurrent ASR and TTS writes competing for the same remaining capacity —
  verified by hand here, but there is no regression test;
- exact-limit writes and the absence of a partial file;
- invalid session ids and filesystem errors during the scan;
- the duration deadline racing incoming WebSocket input or an ASR-ready event;
- retention after a guardrail ends a session;
- the client close race — the JavaScript tests exercise `voiceSessionEndMessage`
  only, not the `ended` into `onClose` ordering.

## Paths not exercised

- A real 15-minute session or a real 256 MiB of artifacts. Every measurement used
  sparse files and reduced limits.
- Real ASR-pool and TTS-pool interaction.
- Browser behaviour of the notice. Only the DOM and state logic were read.
- Several concurrent sessions competing for `_WRITE_LOCK`.
