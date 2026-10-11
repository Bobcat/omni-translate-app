# Review prompt: mobile voice options (round 5)

Review PR #27, `feature/mobile-voice-options`, against `main`. This is the fifth
round. Review only; do not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-5.md`](pr-27-feature-mobile-voice-options-findings-5.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify the files from earlier rounds; each round writes only its own.

## What changed since round 4

Round 4 reviewed `001468e`. The fixes are in `6d93c85`.

**Finding 1, and the question round 4 settled.** You confirmed this was a real
ordering defect rather than a harness artefact, and you were right: with the
panel open the teardown counted one step from the current entry, so the
asynchronous traversal landed on the session entry after setup had already run.
The panel now records what the entry below its overlay is when it opens
(`voiceOptionsSheetEntryBelowIsSession`), and the teardown uses that plus the
in-flight close to decide how many entries to leave, suppressing the setup
transition's own history sync while it owns the traversal.

**Finding 2.** A reopen while a close is in flight sets `_reopenAfterClose` and
waits; when the close's popstate lands, the sheet claims a fresh overlay entry
and keeps the panel visible. It never marks the outgoing entry as owned.

**Finding 3.** `_pendingAutoSpeak` is now an object holding the user's latest
value and the number of echoes outstanding. While any are pending, the
`auto_speak` field of any echo is dropped from the merge, so the control keeps
the user's choice; the count decreases per echo and the server becomes
authoritative again once it reaches zero. A message with
`code === "invalid_tts_settings"` clears it outright.

The test harness was the reason these did not surface locally. Traversal is now
asynchronous in it — the index moves and popstate fires in a task — and
`settle()` drains that before assertions. The author also added `history.length`
to the stub, since the implementation consults it.

## Browser verification by the author

One scenario per page load, because two scenarios in one load share the history
stack:

| Scenario | Result |
| --- | --- |
| Close button | session entry current, app live, panel hidden |
| Teardown with the panel open | `history.state` null (baseline), setup, and a Forward afterwards does not reopen the panel |
| Close then reopen before the traversal | panel visible on `voiceOptionsSheet`, and Back afterwards closes only the panel with the app live |
| Forward after closing | panel reopens, session live |

## Review priorities

- Re-check the four scenarios, and the ones still not covered: a teardown while
  a close is in flight, Back while a session end is in flight, two open/close
  cycles in a row, Forward twice, a completed swipe, and a session end arriving
  between two panel opens. The history bookkeeping now spans the panel, the
  session transition and the teardown, so look for an order that strands an
  entry or leaves the panel visible without one.
- Finding 3: confirm the count cannot drift. Sequences worth trying: a single
  change echoed twice, two changes with only one echo, an echo that arrives
  after a teardown, a rejection followed by a normal echo, and a socket drop
  with echoes outstanding.
- Check that the entry-below bookkeeping in the panel cannot go stale — it is
  recorded at open time and cleared on reset; say whether any path can leave it
  describing an entry that has since gone.
- Confirm the round-1 to round-3 fixes still hold, especially that no path sends
  a partial TTS delta and that closing the panel never ends a session.

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

The author's run: 309 Python tests pass; the JavaScript suite passes 176 of 179,
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
