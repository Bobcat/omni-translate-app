# Review findings: mobile voice options, round 6

Review of PR #27, `feature/mobile-voice-options`, at `edfc729`, against
`main` at `ff61d56`. Answers
[`pr-27-feature-mobile-voice-options-prompt-6.md`](pr-27-feature-mobile-voice-options-prompt-6.md).

All required checks pass in this checkout. The Python commands used the
repository virtual environment because this shell has no global `python`.

| Check | Result |
| --- | --- |
| `.venv/bin/python -m unittest discover -s tests` | 309 tests, pass on Python 3.12.3 |
| `node --test tests/js/*.test.mjs` | 182 tests, pass on Node 18.19.1 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `.venv/bin/python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |
| Supplemental teardown tests after rapid reopen, Forward reopen, and during programmatic close | all 3 fail: setup leaves `live_recording` current |
| Supplemental sentinel tests for ordinary teardown and teardown during in-flight Back | pass: traversal stops on the app baseline |
| Supplemental mixed accepted/rejected TTS test | fails: rollback restores the value from before the accepted update |
| Supplemental repeated/late rejection and two-session tests | pass |

The three pre-existing PDF credit-copy failures named in the prompt did not
reproduce; all 182 JavaScript tests passed.

**Merge-quality verdict: do not merge yet. The ordinary history paths and a
single rejected automatic-speaking update are fixed, but reopened overlays lose
the entry-below fact needed by teardown. A rejection after a partially accepted
update burst can also restore a value the server has already replaced.**

## Findings

### 1. MEDIUM — reopened and closing overlays lose the session entry during teardown

**Where** — `static/src/ui/voice-options-sheet.js:74-89`, `:122-166`, and
`static/src/session/lifecycle.js:468-488`. The test at
`tests/js/mobile-settings-and-voice.test.mjs:445-464` verifies rapid reopen only
until Back closes the panel; it does not tear the session down afterwards.

`closeVoiceOptionsSheet()` clears `_entryBelow` when it requests
`history.back()`, before the overlay entry has been popped. Neither reopen path
restores the value: the deferred reopen at lines 147-154 pushes a new overlay
without recording the current entry, and the Forward path at lines 162-166
reclaims the old overlay without restoring what sits below it.

This breaks three sequences:

- open, close, reopen before the close lands, wait for the new overlay, then
  end the session;
- open, close, use Forward to reopen, then end the session;
- open, request a programmatic close, then end the session before its Back
  traversal lands.

In each case `applySessionTeardown()` sees an overlay but
`voiceOptionsSheetEntryBelowIsSession()` returns false. It traverses one step
instead of two. My asynchronous supplemental tests end in setup with the stale
`live_recording` entry current instead of the app baseline. The next Back is a
dead navigation step, and Forward can revisit stale session history.

The ordinary paths are now correct. Supplemental tests with a sentinel below
the app baseline passed for teardown without the panel, with the panel open,
and during an in-flight browser Back. Those paths did not remove an entry the
app does not own.

**Smallest safe correction** — preserve `_entryBelow` until the requested close
actually lands. When a deferred reopen pushes a replacement overlay, record
the then-current entry before the push. When Forward re-enters the existing
overlay during a live session, restore the same entry-below invariant before
claiming ownership.

**Missing regression test** — extend the rapid-reopen test through session
teardown and assert the baseline is current. Add the same assertion after a
Forward reopen and when teardown starts during a programmatic close. Put a
sentinel below the baseline so over-traversal cannot be hidden by clamping.

### 2. MEDIUM — a rejection after one accepted pending update rolls back past the server's value

**Where** — `static/src/session/voice-options.js:117-125`, `:151-177`. The tests
at `tests/js/mobile-settings-and-voice.test.mjs:466-545` cover ordered echoes, a
first rejection, and a rejection after a fully settled confirmation. They do
not combine a remaining pending update with an earlier accepted echo.

Start with automatic speaking on. Tap off and then on before either response
arrives. If the server accepts off and rejects on, it ends on off. The first
echo only decrements `_pendingAutoSpeak.count`; `_confirmedAutoSpeak` remains
the original on value because it is updated only when the count reaches zero.
The rejection then clears all pending state and restores on. State, stored
preference, and the open switch disagree with the server.

The supplemental test reproduced this as `true` where the last accepted server
value was `false`.

**Smallest safe correction** — update `_confirmedAutoSpeak` from every accepted
`auto_speak` echo before removing that field from the snapshot. Continue to
show the latest optimistic choice while more responses are pending. A later
rejection can then restore the most recent value the server accepted.

**Missing regression test** — send two changes before either response. Deliver
an accepted echo for the first and `invalid_tts_settings` for the second. Assert
that state, persistence, and the open switch restore the first echoed value.

## What holds up

- Teardown without opening the panel, teardown with the panel open, and Back
  that already reached the baseline now use the correct step count.
- Closing the panel by button, scrim, or browser Back keeps the session alive.
  Settled Forward still reopens the panel without duplicating the live entry.
- Two ordinary sessions in one page load reset panel and pending TTS state.
- A first rejected automatic-speaking change rolls back state and persistence.
  A rejection after a fully settled confirmation restores that confirmation.
- An immediately repeated rejection is idempotent. A rejection arriving after
  session teardown fails the session-id guard.
- Ordered off -> on -> off echoes preserve the latest optimistic choice until
  all responses arrive.
- Automatic speaking still sends the full TTS snapshot. No mobile path has
  regressed to a partial update.
- Empty and removed backend lists still disable voice modes. Panel rendering
  and session creation use the same availability predicate.
- Open- and closed-socket finish paths still share teardown and clear cloning
  state. The mobile cache-busting query was updated.

## Unresolved risks and untested paths

- A missing response leaves automatic speaking pending until rejection or
  session teardown. There is no timeout or request identifier.
- Without request identifiers, an old duplicate rejection arriving after a new
  tap cannot be distinguished from rejection of that new tap. The current
  server sends one ordered response per update; this failure mode was not
  produced.
- The three failing history sequences were reproduced in the asynchronous
  harness, not in a browser. The author's browser checks cover only the three
  ordinary teardown scenarios.
- A completed swipe uses the shared close callback, but the gesture itself was
  not exercised.
- No real microphone/device session was run. Live mode switching, clone
  preparation, websocket loss, PCM autoplay policy, and audio capture remain
  unverified.
