# Review prompt: voice-library curation gate and mobile dev mode

Review PR #26, `feature/voice-library-curation-gate`, against `main`. Review
only; do not modify the implementation. Record the outcome in
[`pr-26-feature-voice-library-curation-gate-findings-1.md`](pr-26-feature-voice-library-curation-gate-findings-1.md),
which does not exist yet — create it with the same shape the other findings
files use: a header naming the PR, branch, reviewed commit and base commit, a
check table, a merge-quality verdict, then the findings ordered by severity.

The `-1` suffix is the round number. A later review round gets its own
`-prompt-2.md` and `-findings-2.md` pair, and so on: each round writes only its
own findings file and leaves the earlier prompts and findings untouched.

## Required context

Read these before reviewing the code:

- [`AGENTS.md`](../../AGENTS.md) — the `saas/` boundary and the frontend rules
  this PR has to respect.
- [`saas/entitlements.py`](../../saas/entitlements.py) — `EntitlementSet` and how
  plans become dotted entitlement keys.
- [`app/saas_setup.py`](../../app/saas_setup.py) — the host wiring and the new
  guard.
- [`app/voice_library.py`](../../app/voice_library.py) — what the gated writes
  actually do to `data/voice_library/stable`.

Background, not in this repository: the stable samples are deployment-wide
assets. A session whose target language selects the `stable_generated`
reference reads that language's `audio.wav` as its voice reference, and the TTS
bridge resolves that path on the server rather than over HTTP.

## What the PR changes

**Curation gate.** `POST /api/voice-library/stable`,
`…/{language}/{gender}/keep-pending` and `…/{language}/{gender}/discard-pending`
now require the caller's entitlements to enable `voice_library.curate`. Only the
developer plan declares it. `keep-pending` promotes the pending sample to the
`audio.wav` every session in that language uses; `discard-pending` removes it.
Before this change `keep-pending` and `discard-pending` resolved no principal at
all, and `stable` resolved one only to derive a TTS fairness key.

The read routes stay public on purpose: `GET …/audio.wav`,
`GET …/audio.pending.wav`, and the voice-library status block in `GET /api/config`.

**Mobile dev mode.** The mobile settings sheet hides the text-to-speech,
history, image-translation and Dev tools rows by default, leaving appearance,
microphone and info — the user-facing set the desktop settings view offers.
`?dev` turns the hidden rows back on for one visit, the choice persists in the
existing dev-tools storage entry, and a switch on the Dev tools page turns it
off again. The switch is a visibility filter, not an access boundary: its name
is the flag, and the parameter is stripped from the address bar after it applies.

## Review priorities

Report correctness, authorization, lifecycle, and regression risks. Prefer a
concrete triggering sequence over style comments.

### Entitlement gate and route behavior

- Verify the guard runs before any side effect on all three routes: no sample is
  generated, written, promoted or deleted for a caller that fails the check.
- Confirm the failure is a 403 carrying `ENTITLEMENT_DISABLED` with the
  entitlement key and plan in the details, and that it matches how other
  entitlement failures surface in this app.
- Check the guard against every principal shape the app can produce: the signed
  anonymous cookie, a fresh anonymous identity, a valid bearer whose plan has no
  curation capability, and the developer principal that
  `saas.plan_assignments` maps to the developer plan.
- Verify the capability fails closed: absent plan entry, unknown plan, empty
  plan mapping, or a plan value that is not a boolean must all refuse.
- Confirm no read path became gated, and that the TTS reference lookup still
  resolves its path for a session created by an unauthenticated caller.
- Check whether any other route in `app/router.py` mutates deployment-wide state
  with the same absence of a check. Report it as a finding only if this PR's
  change makes it reachable or implies a promise the code does not keep.

### Mobile dev mode

- Trace `?dev`, `?dev=1`, `?dev=true`, `?dev=0`, `?dev=false`, a bare `?dev`, an
  empty search string and an absent parameter from
  `static/src/settings/dev-mode.js` into `renderSettingsMenuRows`.
- Verify the persistence path: the first load applies and strips the parameter,
  later loads read storage, and `?dev=0` clears a remembered mode.
- Check that turning dev mode off while a developer subpage is open leaves no
  reachable dead page, and that the sheet's own page state, back handling and
  swipe-to-close still agree afterwards.
- Confirm the new `devMode` key cannot be clobbered by the other dev-tools
  setting, by `clearAppLocalStorage`, or by a stored entry written before this
  change; check what a malformed stored value does.
- Verify every changed and newly imported module resolves under one query-string
  version, and that the cache-busting version in `static/index.html` matches what
  the entry actually imports.
- Check accessibility and layout: hidden rows must stay out of the tab order and
  the accessibility tree, the new switch keeps its label association, and the
  remaining rows render correctly.
- Assess the honest claim in the code comment and commit message that dev mode is
  not a security boundary. If any hidden subpage can change shared state in a way
  the gate does not cover, that is a finding.

### Scope and hygiene

- Confirm no fallback or compatibility path was added for the removed menu rows.
- Confirm the PR leaves the mobile microphone page, the desktop frontend, and the
  `saas/` package untouched apart from what the gate needs.
- Check the two commits are self-contained and that neither mixes the gate with
  the UI change.

## Intentional exclusions

Do not report these as missing scope unless this PR makes them unsafe:

- the `saas.plan_assignments` key being the identity id rather than the external
  subject, and its fragility when an identity is re-provisioned — recorded and
  deliberately deferred;
- server-side bounds or metering for ASR tuning, TTS options and image-render
  flags, which are session- or device-scoped;
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

The author's run: 307 Python tests pass; 111 of 114 JavaScript tests pass, and
the three failures are the pre-existing PDF credit-copy tests (`3.000` against
`3,000`) that reproduce with this branch's changes stashed. Syntax checks and
`git diff --check` are clean.

`node --test tests/js/` as written in the repository instructions fails on
Node 24 with `Cannot find module '/…/tests/js'`; the glob form above is the
working command.

Manual verification in a browser is **not** done. The dev switch, the
address-bar stripping, the hidden rows and the service worker's treatment of
`?dev` navigation all still need a device check, so treat them as unverified
paths rather than as tested behavior.

The `voice_library.curate` grant lives in gitignored `config/local.json`. On a
checkout without that file the developer plan does not exist, so curation
correctly refuses everyone; do not read that as a defect in the gate.

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
