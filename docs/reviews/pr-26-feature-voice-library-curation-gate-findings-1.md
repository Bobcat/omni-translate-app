# Review findings: voice-library curation gate and mobile dev mode

Review of PR #26, `feature/voice-library-curation-gate`, at `e03d051`, against
`main` at `9edceb8`. Answers the prompt in
[`pr-26-feature-voice-library-curation-gate-prompt-1.md`](pr-26-feature-voice-library-curation-gate-prompt-1.md).

The Python suite and static checks pass. The JavaScript suite does not pass in
this checkout's Node 18.19 environment:

| Check | Result |
| --- | --- |
| `python -m unittest discover -s tests` | 307 tests, pass |
| `node --test tests/js/*.test.mjs` | 108 of 114 pass; all 6 new dev-mode tests fail |
| `node --input-type=module --check < static/src/app.js` | pass |
| `python -m py_compile app/main.py` | pass |
| `git diff --check main...HEAD` | clean |

The six JavaScript failures are finding 2. The three pre-existing PDF
credit-copy failures named in the prompt did not reproduce under this machine's
locale.

**Merge-quality verdict: fix findings 1 and 2 before merge. Findings 3 to 6 are
small but should be fixed in the same dev-mode change.**

## Findings

### 1. MEDIUM — a non-boolean entitlement value can grant access to all three shared writes

**Where** — `saas/entitlements.py:29` (`EntitlementSet.is_enabled`), reached by
`app/saas_setup.py:190`.

`is_enabled` converts the configured value with `bool(...)`. Any non-empty
string and any non-zero number therefore enables the capability. A plan entry
such as `"voice_library": {"curate": "false"}` passes the only authorization
check. A principal assigned to that plan can generate, promote, or delete the
deployment-wide sample.

**Observed** with `EntitlementSet.require_enabled("voice_library.curate")`:

```text
True      -> ALLOWED
False     -> REFUSED
'false'   -> ALLOWED
'true'    -> ALLOWED
1         -> ALLOWED
0         -> REFUSED
```

This contradicts the required fail-closed behavior for every non-boolean plan
value. The shipped configuration is currently safe: the grant is the boolean
`true`. The defect is exposed by a malformed future or deployment-local plan
entry.

**Smallest safe correction** — make boolean entitlement resolution strict:
`self._values.get(key) is True`. This keeps missing keys and explicit `false`
disabled and refuses every other type.

**Missing regression test** — cover string, numeric, null, list, and object
values. At least one route test should use a malformed assigned plan and assert
403 `ENTITLEMENT_DISABLED`, including the entitlement and plan details, while
the voice-library function mock remains uncalled.

### 2. MEDIUM — the new dev-mode test file fails before any assertion on Node 18

**Where** — `tests/js/dev-mode.test.mjs:9` and `:34`.

`loadModule()` imports `dev-mode.js`, which imports the application state. State
initialization calls `guessSetupLanguages()`, and that reads
`navigator.languages`. `installBrowserStubs` installs `window` and
`localStorage`, but not `navigator`.

**Trigger** — run the required command with this checkout's Node 18.19:

```text
node --test tests/js/*.test.mjs
108 pass, 6 fail
ReferenceError: navigator is not defined
  at guessSetupLanguages (.../static/src/domain/languages.js:74)
```

All six failures come from the new test file. None of its dev-mode assertions
run. Newer Node releases expose a partial global `navigator`, which explains why
the author's Node 24 run did not catch this, but the repository declares no
minimum Node version.

**Smallest safe correction** — install a minimal `globalThis.navigator` with
`language` and `languages` before the first dynamic import. Remove it during
test cleanup if the file later shares a process with tests that require another
navigator shape.

### 3. LOW — browser Back reopens Dev tools after dev mode is turned off

**Where** — `static/src/app.js:133-139`, through
`static/src/settings/sheet.js:67-73` and `:91-100`.

**Trigger**:

1. Open Settings with dev mode enabled.
2. Open **Dev tools**. This pushes a `dev-tools` settings history entry.
3. Turn **Dev mode** off. `handleDevModeChange` calls
   `navigateSettingsPage('home')`, which pushes a second `home` entry.
4. Use browser Back.

The popstate handler restores the preceding `dev-tools` entry without checking
`isDevMode`. The hidden page is reachable again while the switch is off. This
also makes browser history disagree with the visible menu state.

**Smallest safe correction** — return through the existing back path instead of
pushing `home`; from the Dev tools page, `handleSettingsBack()` pops to the
existing root entry.

**Missing regression test** — model the settings history sequence, turn the
switch off, dispatch the resulting popstate, then verify that another Back does
not restore any page for which `isDevOnlyPage` is true.

### 4. LOW — disabling through `?dev=0` or `?dev=false` leaves the switch in the URL

**Where** — `static/src/settings/dev-mode.js:45-52`.

The true branch calls `stripDevParam`; the false branch only updates storage.
Opening `/?dev=0` with a remembered enabled mode correctly stores `false`, but
`history.replaceState` is never called and `?dev=0` remains in the address bar.
Every reload then reapplies the switch, and a copied or bookmarked URL carries
it along. This contradicts the one-visit behavior and the comment that the
parameter is stripped after application.

**Observed** with a history stub: state and storage became `false`, while the
last replacement URL stayed `null`.

**Smallest safe correction** — when the parameter is present, apply its boolean
meaning and call `stripDevParam()` in both the enabling and disabling cases.

**Missing regression test** — assert the replacement URL for `?dev=0` and
`?dev=false`, including preservation of unrelated query parameters and hashes.

### 5. LOW — malformed persisted values can enable dev mode

**Where** — `static/src/domain/storage.js:184-194`.

`Boolean(saved.devMode)` treats any truthy value as enabled. For example, an old
or malformed `{"devMode":"false"}` entry loads as `devMode: true`. Although dev
mode is deliberately not an authorization boundary, malformed storage should
fail closed and keep developer rows hidden.

**Smallest safe correction** — accept only a boolean:
`typeof saved.devMode === 'boolean' ? saved.devMode : false`.

**Missing regression test** — cover string, numeric, array, object, null, and
pre-change entries without a `devMode` property.

### 6. LOW — a rejected local-storage write can abort application initialization

**Where** — `static/src/settings/dev-mode.js:39-48` and
`static/src/domain/storage.js:197-199`, called from `static/src/app.js:257`.

**Trigger** — visit with `?dev` in a browser where `localStorage.getItem` works
but `setItem` throws, for example because storage is blocked or the quota is
unavailable. `setDevMode(true)` mutates runtime state and then lets the storage
exception escape. `init()` stops before it renders the settings filter and the
remaining initial UI. The top-level catch only changes the app status to error.
The parameter is not stripped either.

The read helper and most other storage writers already treat unavailable local
storage as non-fatal. This new startup write should do the same.

**Smallest safe correction** — catch storage write failures inside
`saveDevToolsSettings`, consistent with the other persistence helpers. Runtime
mode can still apply for the current visit.

**Missing regression test** — make `localStorage.setItem` throw and assert that
`initDevMode` still completes, applies the URL value in memory, and strips the
parameter.

## What holds up

- All three write routes call the guard before generation, promotion, deletion,
  or other voice-library file access. Fresh anonymous and existing anonymous
  callers resolve to plans without the capability and receive the shared SaaS
  403 error shape.
- The error handler returns `ENTITLEMENT_DISABLED` with both
  `details.entitlement` and `details.plan`. Missing plan entries, unknown plans,
  and empty plan mappings resolve to an empty entitlement set and are refused.
- A verified bearer resolves through the configured identity-to-plan assignment.
  With a boolean `true` grant, the developer principal reaches all three writes;
  a valid bearer on the normal user plan does not.
- `GET /api/config`, `audio.wav`, and `audio.pending.wav` remain public. Session
  creation remains public, and the stable TTS reference is still resolved from
  the server-side path rather than through a newly gated HTTP read.
- The voice-library client uses the shared authenticated API wrapper, so a
  signed-in developer sends the bearer token to the new gate.
- Dev-only rows use the native `hidden` property, backed by an explicit CSS
  `[hidden]` rule, so hidden buttons leave layout, tab order, and the
  accessibility tree. The new switch remains associated with its wrapping
  label.
- The existing `showControls` value and the new `devMode` value are preserved
  when either switch writes a valid settings object. A pre-change object without
  `devMode` loads disabled. Resetting all app storage deliberately removes the
  complete dev-tools entry.
- Every frontend module has one resolved URL in the module graph. The updated
  entry query in `static/index.html` is `20261008-dev-mode-1`; the service worker
  has no caching fetch handler.
- The gate and mobile UI changes are in separate implementation commits. The
  desktop frontend, microphone page, and domain-free `saas/` package are
  otherwise unchanged.

## Unresolved risks and untested paths

- No browser or device run was performed. Visual layout, switch interaction,
  swipe-to-close, address-bar replacement, and actual browser accessibility
  behavior remain unverified.
- The real Supabase verifier and the deployment's gitignored developer plan
  assignment were not exercised end to end. The route tests use a stub verifier
  and an isolated store.
- The new route tests do not explicitly assert the signed-anonymous, valid
  non-developer bearer, response `details.plan`, public voice-library read, or
  anonymous-session stable-reference cases. Those paths were inspected in code,
  but only broader existing tests cover parts of them.
- The Node 24 result from the prompt was not rerun because this checkout exposes
  Node 18.19 only. Finding 2 is therefore an environment-compatibility failure,
  not evidence that the same six tests fail on Node 24.
