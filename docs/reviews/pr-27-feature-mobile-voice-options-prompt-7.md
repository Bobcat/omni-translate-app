# Review prompt: mobile voice options (round 7)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the seventh
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-7.md`](pr-27-feature-mobile-voice-options-findings-7.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 6

Round 6 reviewed `edfc729`. The fix is in `a6cddb3`.

**The step counting is gone, by design.** Your finding showed that no count is
safe while another pop may be in flight — a two-entry jump started during a
close overtook it and crossed the app's own entry into another document. So
`applySessionTeardown` no longer counts or jumps:

1. it marks a teardown pending, closes the panel through the panel's own path,
   and resets the session-only voice state;
2. `resetLiveRecordingToSetup()` runs only when the panel's overlay has actually
   left the stack — immediately when the panel was not involved, otherwise from
   `retrySessionTeardown()`, which the router calls after the overlay's
   `popstate`.

Each layer therefore pops exactly its own entry, and the setup transition pops
the session entry through the existing sync. The entry-below marker and the
helpers that fed it (`voiceOptionsSheetEntryBelowIsSession`,
`voiceOptionsSheetCloseInFlight`, `_sessionBaseIndex`) are deleted rather than
kept.

**Your second finding** is fixed by updating the confirmed automatic-speaking
value on *every* accepted echo, before that field is removed from the merge, so
a later rejection restores the most recent value the server accepted.

**The harness gained the sentinel you used**: an entry below the app baseline,
with a test asserting the app stops there and the sentinel is still reachable
afterwards.

## Browser verification by the author

One scenario per page load:

| Scenario | `history.state` | app mode | panel |
| --- | --- | --- | --- |
| Close button | `live_recording` | live | hidden |
| Forward after closing | `voiceOptionsSheet` | live | open |
| Teardown without the panel | `null` | setup | hidden |
| Teardown with the panel open | `null` | setup | hidden |
| Teardown during a programmatic close | `null` | setup | hidden |
| Teardown after a rapid reopen | `null` | setup | hidden |
| Teardown after a Forward reopen | `null` | setup | hidden |

## An architectural question for you

Six rounds have been spent on one thing: this panel's relationship with browser
history. Round 4 confirmed the teardown ordering was genuinely wrong, round 5
found the step count broke the ordinary session end, round 6 found it removed the
wrong entry in three reopening sequences. Each fix was correct for the sequence
it was shown and wrong for another. Round 7 replaces counting with a two-stage
teardown, and the author has verified seven sequences in a browser — but the
pattern is not encouraging, and you have watched it more closely than anyone.

So, beyond the findings: **what would you do with this panel's history model?**

The options the author sees:

1. Keep it as it is now — one overlay entry, owned by the panel, popped by the
   panel, with the teardown completed by the router once that pop lands.
2. Remove the panel's history entry altogether. The panel becomes a pure
   overlay: it opens and closes without touching the stack, and browser Back
   while it is open would end the session (the router already does that for a
   live session). That trades the whole class of defects for a Back that does
   not close the panel first.
3. Give the panel an entry but never let the teardown touch history: the session
   exit could leave the overlay entry to the panel and accept that a session
   ending with the panel open leaves one stale entry, cleared on the next open.
4. Something else, including a different routing model for live sessions — the
   session entry itself is the other half of this, since it is pushed and popped
   by the same module.

The constraint set: the mobile app is turn-based; a live voice session is a
distinct mode rather than a page; `static/src/ui/language-sheet.js` and
`static/src/settings/sheet.js` already solve "Back closes the sheet" with an
entry and a popstate skip; and the same router serves both sheets and the
session exit. The author is willing to take the larger change if it is the
honest one, and would rather hear that now than after another round.

## Review priorities

- The pending teardown is the new risk. Check whether it can be left set, or
  completed at the wrong moment: a popstate that never arrives, a second
  teardown while one is pending, a teardown followed by a new session opening
  the panel, a teardown whose `resetLiveRecordingToSetup()` runs twice, and a
  teardown when the panel was closed but its popstate is still queued.
- Re-check the seven scenarios, and two sessions in a row without a reload.
- Confirm the panel's own close path still pops exactly its own entry in every
  route: button, scrim, swipe, browser Back, and Forward afterwards.
- Finding 2: check the confirmed value across a burst with mixed accept and
  reject responses, and a rejection arriving twice.
- Confirm the round-1 to round-5 fixes still hold, especially that closing the
  panel never ends a session and that no path sends a partial TTS delta.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- per-bubble voice selection: the protocol's voice mode is session scoped;
- porting the desktop TTS detail controls to mobile;
- server-side bounds or metering for voice, ASR tuning or image rendering;
- Cloudflare cache configuration, which lives outside this repository;
- the pre-existing PDF credit-copy JavaScript failures noted under Verification.

## Verification

Run:

```bash
python -m unittest discover -s tests
node --test tests/js/*.test.mjs
node --input-type=module --check < static/src/app.js
python -m py_compile app/main.py
git diff --check main...HEAD
```

The author's run: 309 Python tests pass; the JavaScript suite passes 184 of 187,
the three failures being the pre-existing PDF credit-copy tests.

Still unverified by anyone: a real session with a microphone. Live voice
switching, clone preparation, websocket loss mid-session, PCM autoplay policy
and the swipe gesture have not been exercised on a device.

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

Finish with your answer to the architectural question above. A recommendation
with its trade-offs is more useful here than a verdict on the current shape: the
author will act on it rather than defend the existing code.
