# Review prompt: mobile voice options

Review PR #27, `feature/mobile-voice-options`, against `main`. Review only; do
not modify the implementation. Record the outcome in
[`pr-27-feature-mobile-voice-options-findings-1.md`](pr-27-feature-mobile-voice-options-findings-1.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

## Required context

Read these before reviewing the code:

- [`AGENTS.md`](../../AGENTS.md) — the frontend rules and the desktop-variant
  section this PR has to respect.
- `static/src/domain/voice-selection.js` — the shared rules this PR introduces.
- `static/src/domain/cloning-status.js` — the status and guidance text, moved
  out of the desktop view.
- `app/voice/mode.py` — the backend's own copy of the product modes and how it
  rejects an unsupported value.

Background: the desktop voice view is the specification for behaviour. The
mobile app previously had no voice selection, no live control for automatic
speaking, and no cloning status.

## What the PR changes

**Shared rules.** The desktop voice session held the voice-selection rules,
including the fallback chain and the per-lane cloning status. They now live in
`static/src/domain/` and both frontends import them. `static/desktop/src/views/voice/session.js`
and `.../index.js` were changed to call them; the view's markup and behaviour
should be otherwise untouched.

**Mobile panel.** `static/src/ui/voice-options-sheet.js` renders the voice
choices, the automatic-speaking switch and the cloning status/guidance.
`static/src/session/voice-options.js` owns the mobile state, persistence and the
socket updates, and `static/src/session/messages.js` routes the new message
types into it. The icon is mounted into the titlebar only while a session runs.

## Review priorities

Report correctness, lifecycle, authorization and regression risks. Prefer a
concrete triggering sequence over style comments.

### The shared rules and desktop parity

- Compare `voiceFallbackModeFor` against the code it replaced on `main`. The
  author checked all 18 reachable combinations of requested mode, active mode
  and fallback and reports no differences; reproduce that, and say what happens
  for the combinations that are *not* reachable (an unknown stored mode, a
  fallback that is `speaker_clone`, `undefined` fallbacks).
- Check the clone case specifically: choosing the clone must fall back to the
  voice that was speaking until now, not to the previously prepared fallback.
  Trace `male -> female -> clone` in both frontends.
- Confirm `voiceModeSelectionStatus` reports the same voice the rules chose, and
  that the desktop status payload is unchanged from `main` for the same inputs.
- Look for behaviour that is now reachable in the mobile frontend but was never
  reachable in the desktop view: a mode change before any session exists, a mode
  change while the socket is closed, and a mode change while audio is queued.
- Confirm no rule was left duplicated: the desktop constants, status text and
  fallback logic should exist in exactly one place.

### The mobile panel

- Trace the panel's lifetime: opening from the titlebar, closing with its own
  button, closing with browser Back, and the session ending while it is open.
  It deliberately owns no history entry — confirm that closing it cannot move
  the page stack, and that Back closes it exactly once rather than falling
  through to the session handler. `static/src/session/lifecycle.js`'s popstate
  router and the settings sheet share that path.
- Check the icon mounting: `renderLifecycle` attaches and detaches the button.
  Confirm the click listener survives re-attachment, that repeated renders do
  not accumulate copies, that the `hidden` attribute and its CSS cannot
  disagree, and that nothing else holds a stale reference to the node.
- Check automatic speaking: the panel writes `state.ttsSettings.auto_speak`,
  which the dev-gated TTS settings page also owns. Confirm the two cannot
  disagree, and that the `tts_settings` message from the server does not undo a
  choice the user just made.
- Verify persistence: the voice mode and the automatic-speaking preference are
  both remembered, a malformed stored value cannot enable or select anything
  unexpected, and clearing app storage resets both.
- Confirm the panel closes on session end and that its state cannot leak into
  the next session.

### Wiring and regressions

- Confirm every changed and newly imported module resolves under one
  query-string version, and that the `?v=` values in `static/index.html` match
  what the entry imports.
- Check the module graph for a new cycle: `session/voice-options.js` imports
  `domain/storage.js` and `state.js`, `ui/voice-options-sheet.js` imports the
  session module, and `session/messages.js` imports both.
- Confirm the desktop voice view, the image view and the settings sheets are
  otherwise unchanged, and that the image view still hides its titlebar icons.
- Check the titlebar layout at narrow widths with the badge, the icon and the
  settings icon all present, including a long badge translation.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- per-bubble voice selection: the protocol's voice mode is session scoped;
- the dev-gated TTS detail controls (engine, per-language voice, texture, style);
- server-side bounds or metering for voice, ASR tuning or image rendering;
- the `saas.plan_assignments` keying and its fragility on re-provisioning;
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

The author's run: 309 Python tests pass. The JavaScript suite passes 152 of 155;
the three failures are the pre-existing PDF credit-copy tests, which also fail
on `main` and depend on the machine's locale.

The mobile UI was measured in a headless Chromium against the dev server at 390,
360 and 320px width. The author reports: the voice icon 8px from the settings
icon, the speech-detected badge 8px from the voice icon, the icon absent from
the document outside a session, the tap opening the panel, and the history
length unchanged across opening and closing. Reproduce what you can; the
measurements are not part of the test suite.

**Not exercised by anyone:** a real session with a microphone. Live voice
switching, the cloning status while the backend prepares a reference, and
automatic speaking during playback are unverified. The desktop voice session has
no automated test, so its unchanged behaviour rests on the reachable-state
comparison above rather than on a test.

One more thing worth knowing: during development a device running a stale
stylesheet showed the icon on the setup screen even though the new bundle was
loaded. That is why the icon is detached from the DOM rather than hidden, and
why the reviewer should not treat the mount/unmount approach as incidental.

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
