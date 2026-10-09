# Review prompt: voice-library curation gate and mobile dev mode (round 2)

Review PR #26, `feature/voice-library-curation-gate`, against `main`. This is the
second round. Review only; do not modify the implementation. Record the outcome
in
[`pr-26-feature-voice-library-curation-gate-findings-2.md`](pr-26-feature-voice-library-curation-gate-findings-2.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

Do not modify
[`pr-26-feature-voice-library-curation-gate-prompt-1.md`](pr-26-feature-voice-library-curation-gate-prompt-1.md)
or
[`pr-26-feature-voice-library-curation-gate-findings-1.md`](pr-26-feature-voice-library-curation-gate-findings-1.md);
each round writes only its own files. If you disagree with how a round-1 finding
was resolved, say so in `-findings-2.md` rather than editing the earlier record.

## What changed since round 1

Round 1 reviewed `e03d051`. The fixes are in `eaca201` and `43cf0c0`. `95ff6e7`
commits the round-1 findings file exactly as the reviewer wrote it, so the
record is on the branch; nothing in that file was edited.

**`eaca201` — strict entitlement booleans.** Finding 1. `EntitlementSet.is_enabled`
in [`saas/entitlements.py`](../../saas/entitlements.py) now returns
`self._values.get(key) is True` instead of coercing with `bool()`. This is shared
by every entitlement check in the app, not only the curation gate:
`image_translation.enabled` (`app/router.py`), `text_translation.enabled`,
`pdf_translation.enabled` and `pdf_translation.preview_first_pages`
(`app/credits/pdf_translation.py`). Coverage: a unit test over string, numeric,
null, list and object values, and a route test that assigns a plan whose
`voice_library.curate` is the string `"false"` and asserts a 403 with
`details.entitlement` and `details.plan`, plus an uncalled generate mock.

**`43cf0c0` — the four dev-mode defects.** Findings 2 to 6.

- Finding 2: `tests/js/dev-mode.test.mjs` installs a `navigator` stub through
  `Object.defineProperty`, because Node 18 has no global `navigator` while
  Node 24 exposes it as getter-only. The suite now asserts across the new cases.
- Finding 3: `static/src/app.js:134-141` calls `handleSettingsBack()` instead of
  `navigateSettingsPage('home')`, and
  `static/src/settings/sheet.js:103` refuses to restore a page for which
  `isDevOnlyPage` is true while dev mode is off.
- Finding 4: `static/src/settings/dev-mode.js` strips the parameter in both the
  enabling and disabling case.
- Finding 5: `static/src/domain/storage.js` accepts a persisted `devMode` only
  when it is exactly `true`.
- Finding 6: `saveDevToolsSettings` catches storage write failures.

## Review priorities

The fixes are the primary target. Report correctness, authorization, lifecycle,
protocol, and regression risks, with a concrete triggering sequence.

### Verifying the round-1 fixes

- Finding 1: confirm no reachable plan in `config/settings.json` or
  `config/local.json` relied on a truthy non-boolean value, and that no caller
  depends on the old coercion. Check each `is_enabled` and `require_enabled` call
  site, including the `preview_first_pages` default path.
- Finding 3: trace the settings history depth through turning the mode off from
  the Dev tools page, and through Back afterwards. Confirm
  `_settingsSheetDepth`, the popstate counter, the sheet close path and
  `voiceLibraryOnExit` still agree, and that no other entry can restore a
  dev-only page — including a `home` state pushed while the mode was on.
- Finding 4: check the stripping against a search string with other parameters,
  a hash, no query at all, and a `history.replaceState` that throws.
- Finding 6: confirm the swallowed write failure cannot hide a storage problem
  the app needs to know about elsewhere.
- For each fix, state whether the new test actually fails against the previous
  behaviour. A test that passes before and after is worth reporting.

### Regressions in the deferred areas

- Confirm the gate still refuses anonymous and non-developer callers, and that
  the public reads (`GET /api/config`, `audio.wav`, `audio.pending.wav`) and the
  server-side TTS reference lookup are unchanged.
- Confirm the module graph still resolves one URL per module and that
  `static/index.html`'s entry version matches the imports.
- Check the new `sheet.js` import of `dev-mode.js` for any load-order cycle
  through `pages.js` or `els.js` that the previous graph did not have.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- the `saas.plan_assignments` key being the identity id rather than the external
  subject, and its fragility when an identity is re-provisioned;
- server-side bounds or metering for ASR tuning, TTS options and image-render
  flags;
- authentication provisioning, plan catalogue values and credit accounting;
- broad mobile sheet restructuring, restyling, or removal of subpages;
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

The author's run: 309 Python tests pass. The JavaScript suite passes 115 of 118
on Node 24; the three failures are the pre-existing PDF credit-copy tests
(`3.000` against `3,000`), which reproduce with this branch's changes stashed and
did not reproduce in the round-1 environment. The author could not run Node 18,
so the round-1 finding 2 fix is reasoned rather than reproduced on that version —
treat it as needing your confirmation.

Browser and device verification is still **not** done: the dev switch, the
address-bar replacement, the hidden rows, the settings history behaviour and the
service worker's treatment of `?dev` navigation are unverified on a real device.

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
