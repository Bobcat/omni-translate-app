# Review findings: voice-library curation gate and mobile dev mode, round 2

Review of PR #26, `feature/voice-library-curation-gate`, at `de09769`, against
`main` at `9edceb8`. Answers the round-2 prompt in
[`pr-26-feature-voice-library-curation-gate-prompt-2.md`](pr-26-feature-voice-library-curation-gate-prompt-2.md).

All required checks pass in this checkout:

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests` | 309 tests, pass |
| `node --test tests/js/*.test.mjs` | 118 tests, pass on Node 18.19 |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |

**Merge-quality verdict: the six round-1 defects are fixed. Add the focused
history regression test in finding 1 before merge; no behavioral blocker remains.**

## Findings

### 1. LOW — the settings-history repair still has no regression test

**Where** — the repaired paths are `static/src/app.js:135-141` and
`static/src/settings/sheet.js:92-109`; `tests/js/dev-mode.test.mjs` exercises
neither module nor any settings history transition.

The implementation now handles the original sequence correctly:

1. Opening Settings pushes `home` and sets depth 1.
2. Opening Dev tools pushes `dev-tools` and sets depth 2.
3. Turning dev mode off calls `handleSettingsBack()`, which pops instead of
   pushing another `home` entry.
4. The resulting `home` popstate reduces depth to 1.
5. Another Back closes the sheet and resets depth to 0.

The popstate handler also maps a stored dev-only entry to the sheet root while
dev mode is off. The current code is sound, but the test suite does not lock in
either half. Reverting `handleSettingsBack()` to `navigateSettingsPage('home')`,
or removing the new popstate guard, leaves all 118 JavaScript tests green.

The missing coverage also leaves the close-path skip counter and
`voiceLibraryOnExit` interaction unexercised. The latter remains correct in the
current flow: returning from Voice library to Dev tools invokes the existing
page-exit hook before the switch can be turned off.

**Smallest safe correction** — add one focused browser-history test for the
sequence above. Assert the pushed entries, fallback from a dev-only popstate,
and the final sheet close. Include a Voice library -> Dev tools transition and
assert one `voiceLibraryOnExit` call before toggling the mode. This can use a
narrow DOM/history stub; no production abstraction is needed.

## Round-1 fix verification

| Round-1 finding | Result | Does the new test fail before the fix? |
| --- | --- | --- |
| 1. Strict entitlement booleans | resolved | yes; the unit test fails on truthy non-booleans and the malformed-plan route test does not return the required 403 |
| 2. Node 18 `navigator` | resolved | yes; round 1 observed all six tests fail before their assertions |
| 3. Settings history | resolved in code | no test was added |
| 4. Strip disabling URL values | resolved | the `?dev=0` replacement assertion fails before the fix |
| 5. Strict persisted `devMode` | resolved | yes for truthy malformed values; the pre-change-entry test passes before and after |
| 6. Swallow dev-settings write failure | resolved | yes; `initDevMode()` throws before the fix |

The new test named `stripping the parameter keeps the unrelated query and hash`
uses `?dev&mobile=1` without a hash. It checks the unrelated query only, and the
same case already passed before the round-2 fix because the old true branch also
called `stripDevParam`. A separate targeted harness confirmed that the current
code preserves `#section`, leaves a URL without `dev` untouched, and keeps the
runtime mode when `history.replaceState` throws. Those cases are not persistent
regression coverage.

## What holds up

- `EntitlementSet.is_enabled` now accepts only the boolean `true`. Every boolean
  entitlement in `config/settings.json` and the reachable developer plan in
  `config/local.json` already uses a JSON boolean. No caller depended on truthy
  strings, numbers, lists, or objects.
- The strict change preserves PDF behavior. The anonymous plan's
  `pdf_translation.preview_first_pages` is explicitly `true`; plans without the
  key still resolve it to false, as before.
- The malformed curation-plan route test asserts 403 `ENTITLEMENT_DISABLED`,
  both detail fields, and an uncalled generation mock. The generic entitlement
  test covers truthy and falsy non-boolean JSON shapes.
- Swallowing `saveDevToolsSettings` failures is local to that preference. No
  caller used an exception from this writer as a storage-health signal. Runtime
  state still changes for the current visit.
- `?dev`, `?dev=0`, and `?dev=false` now share one apply-and-strip path. Other
  query parameters and hashes are preserved. A failed address-bar replacement
  does not undo the in-memory or stored choice.
- The new `sheet.js` dependency adds no cycle: both `sheet.js` and `pages.js`
  depend on the side-effect-free `dev-mode.js`; `dev-mode.js` does not import
  either one. All modules still resolve under one URL in the mobile graph.
- The entry remains `/src/app.js?v=20261008-dev-mode-1`, matching the final
  feature diff. The service worker still has no caching fetch handler.
- The three voice-library writes remain gated before voice-library I/O.
  Anonymous, unknown-plan, malformed-plan, and valid non-developer principals
  are refused. The assigned developer principal with the boolean grant is
  allowed.
- `GET /api/config`, both WAV routes, session creation, and the server-side
  stable-reference path are unchanged by the fixes.

## Unresolved risks and untested paths

- No browser or device run was performed. Sheet animation, Back/Forward gestures,
  swipe-to-close, focus behavior, and actual address-bar replacement remain
  unverified outside stubs and code inspection.
- Node 24 was not available in this checkout. Node 18.19 now passes all 118 tests;
  the author's three locale-dependent PDF failures did not reproduce here.
- The real Supabase verifier and deployment-local developer assignment were not
  exercised end to end. Their resolution path is unchanged from round 1.
