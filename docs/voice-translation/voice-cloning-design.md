# Speaker voice cloning for voice translation

Status: phases 1–3 implemented on `feature/desktop-speaker-voice-cloning`.
Phase 4 remains follow-up work after testing with real conversations.

## Decision summary

Desktop voice translation gets one user-facing option:

> **Clone speaker voice**

The product UI does not expose Prompt-only, Prompt + reference, stable-sample
selection, reference duration, or transcript alignment. Those controls remain
available for experiments in the current mobile TTS settings. They can move
behind **Dev tools** when the desktop UX is migrated to mobile.

When speaker cloning is enabled, the backend builds a recent-speech reference
for each conversation direction. It selects complete ASR segments and produces
the audio clip and transcript from the same selection. Product cloning uses
VoxCPM2's combined Prompt + reference mode.

The backend reports cloning as **Preparing** until it has a valid reference.
The desktop shows a clear status instead of silently using a stable generated
voice. Stable generated voices are an explicit voice source, not a fallback
for speaker cloning.

## Goals

- Offer speaker cloning through one understandable desktop option.
- Preserve the speaker's identity without exposing model-specific controls.
- Keep prompt audio and prompt text aligned exactly.
- Build a useful reference from recent speech across bubble boundaries.
- Make the first acceptable reference duration configurable for experiments.
- Keep reference state bounded and session-local.
- Preserve the existing responsive TTS streaming and replay behavior once a
  cloning reference is ready.
- Define a product UX that can later replace the normal mobile TTS form.

## Non-goals

- Remove the current mobile experiment controls in this phase.
- Change ASR-pool, translation-services, or TTS-pool behavior.
- Add speaker recognition or diarization for cloning.
- Persist a cloned voice across voice sessions.
- Train or fine-tune a voice model.
- Hide all TTS development controls before the desktop UX has been validated.
- Claim that three seconds is an optimal reference duration before it has been
  measured in this app.

## Product and experiment surfaces

The desktop voice view is the product-design surface. It exposes only choices
that a normal user can understand and predict.

The current mobile TTS settings are an experiment surface. They may continue
to expose:

- stable generated and last-speech reference sources;
- Prompt-only and Prompt + reference modes;
- model backend and per-language settings;
- reference trimming and cloning policy controls.

These controls do not define the final product UX. Later mobile work should
adopt the validated desktop interaction and place the remaining controls behind
**Dev tools**.

## VoxCPM2 cloning modes

VoxCPM2 has separate continuation and reference-audio paths:

| Input | Official model mode | Purpose |
|---|---|---|
| `reference_wav_path` | Isolated reference | Extract speaker timbre without a transcript. |
| `prompt_wav_path` + exact `prompt_text` | Continuation | Treat the clip as spoken context and continue its delivery. |
| Both paths, normally with the same WAV | Combined reference + continuation | Preserve continuation details and reinforce speaker identity. |

The official Hi-Fi/Ultimate Cloning recipe uses the combined path for maximum
similarity. The prompt transcript must match the prompt audio. See the official
[Usage Guide](https://voxcpm.readthedocs.io/en/latest/usage_guide.html#hi-fi-cloning),
[API Reference](https://voxcpm.readthedocs.io/en/latest/reference/api.html), and
[architecture description](https://voxcpm.readthedocs.io/en/latest/models/architecture.html#isolated-reference-audio-channel).

The official guide calls 5 to 30 seconds a practical reference-audio range. Its
cookbook recommends at least five seconds. This design starts with an
experimental three-second minimum to learn whether a shorter first reference is
acceptable in an interactive app. The setting must be changeable without a
code edit.

## User experience

### Option off

Voice translation uses the deployment's normal configured TTS voice. No recent
speaker audio is retained for cloning policy beyond the existing ASR lifecycle.

### Option on, reference not ready

The active conversation direction is in **Preparing** state. The desktop shows:

> **Preparing voice cloning**
>
> Speak naturally for a few more seconds. Cloning starts once enough clear
> speech has been captured.

The product client does not request cloned TTS while the active direction is
preparing. Automatic speaking and speculative generation skip those bubbles.
A manual Speak action receives a non-error `voice_clone_preparing` result and
keeps the same status visible. The app does not substitute a stable generated
voice.

Bubbles skipped while preparing are not played automatically later. Once the
reference is ready, a manual Speak action may generate speech for an earlier
bubble with the current valid reference.

### Option on, reference ready

The backend reports **Ready**. The desktop may show a short confirmation:

> **Voice cloning ready**

New definitive bubbles use combined Prompt + reference cloning. Existing
automatic, speculative, streaming, and replay rules still apply. Replaying a
completed bubble reuses its stored WAV; it does not regenerate that bubble with
a newer reference window.

### Direction changes

Readiness belongs to a conversation direction, not to the session as a whole.
Each direction has its own recent-speech window. Switching to a direction that
is still collecting returns the visible state to **Preparing**.

This proof of concept assumes one speaker identity per direction. Multiple
people speaking on the same side can mix identities because speaker recognition
and diarization are out of scope.

## Cloning state

The backend owns this state for each conversation lane:

```text
off -> preparing -> ready
 ^         |          |
 |         +----------+-- reset or invalidated
 +----------------------- cloning disabled
```

| State | Meaning |
|---|---|
| `off` | Speaker cloning is disabled for the session. |
| `preparing` | No valid recent-speech reference meets the configured policy. |
| `ready` | A bounded audio and transcript pair is available for this lane. |

The browser displays the state. It does not decide whether an ASR fragment is
safe for cloning.

## Recent-speech window

Each finalized ASR result contributes reference candidates with this
provenance:

```text
lane id
ASR request id
source WAV path
source WAV timeline start and end
ASR segment id
segment start and end timestamps
segment text
quality fields needed by the existing reference score
```

The runtime must retain the source WAV timeline offset. ASR segment timestamps
are currently absolute within the session timeline; clipping a job WAV requires
subtracting that WAV's start offset.

Candidates are kept in a bounded deque of at most 24 terminal ASR results per
lane. The selector walks backward
from the newest complete ASR segment and chooses a chronological set that:

- has non-empty text and valid monotonic timestamps;
- belongs to the same lane;
- contains no duplicated or overlapping source interval;
- forms a segment-only clip, so speech coverage and inter-segment silence are
  controlled by construction;
- reaches `min_duration_s`;
- does not exceed `max_duration_s`.

The duration is the sum of the selected complete segment clips, including any
silence inside those segment boundaries. Selection may cross bubble and ASR-job
boundaries. It may use a
previous bubble or the end of a previous bubble to bring a short current bubble
up to the minimum.

The first implementation clips only at complete ASR-segment boundaries. The app
does not currently retain reliable word timestamps. A segment that cannot fit
within the maximum is skipped; it is not cut at an arbitrary audio position.
Word-level clipping is separate work if segment-level selection proves too
coarse.

## Materializing an exact pair

One backend function must materialize both outputs together:

```text
selected reference segments
  -> clip each matching source interval
  -> concatenate clips in chronological order
  -> join only the selected segment texts
  -> return one immutable reference object
```

The result contains at least:

```text
reference id or content hash
WAV path
prompt transcript
duration
segment count
source request ids
created time
```

Code must not clip the audio in one path and assemble the transcript in another.
If either output fails validation, the pair is unusable for Prompt mode.

Small silence gaps inside selected ASR segment boundaries remain. Clips from
separate source WAVs are concatenated directly in chronological order. The
materializer must not duplicate spoken audio.

## Reference lifecycle

The selector updates after a terminal ASR result has valid segments. It does
not update from target translation text.

Once the lane first reaches the configured minimum, it enters **Ready**. Later
speech can replace the reference with a newer valid window. A replacement gets
a new reference identity so new synthesis uses the new window.

An existing TTS preparation remains keyed to the reference identity it started
with. A reference update does not rewrite or invalidate a completed WAV. A
queued preparation that has not started may use the new reference only if its
preparation key is replaced before generation.

The reference deque and materialized clips are deleted through the existing
voice-session cleanup lifecycle. Nothing is stored in browser storage or reused
by another session.

## Configuration

The implementation uses these initial deployment settings:

```json
{
  "tts": {
    "voice_cloning": {
      "recent_speech_window": {
        "min_duration_s": 3,
        "max_duration_s": 10
      }
    }
  }
}
```

`min_duration_s` is the experimental first-ready threshold. It must be greater
than zero and no greater than `max_duration_s`.

`max_duration_s` bounds prompt context, reference payload size, and selection
work. Ten seconds is an app UX and latency choice, not an official VoxCPM2
limit.

These are server-owned defaults. Normal desktop users do not edit them. The
mobile development surface may expose them later for experiments.

## Session setting and capability

The user-facing session setting is semantic:

```json
{
  "voice_cloning": {
    "enabled": true
  }
}
```

It does not expose VoxCPM2's Prompt or reference fields. The backend maps the
setting to the supported TTS model and validates that speaker cloning is
available. The config endpoint should report that capability so the desktop can
hide or disable the option when the loaded backend cannot support it.

Changing the option affects future TTS preparation. It does not regenerate or
replace stored audio for existing bubbles.

## Backend ownership

The conversation runtime owns source-audio provenance because it receives ASR
results and knows each lane's timeline. It delegates bounded reference-window
selection and materialization to a voice-cloning component under `app/voice/`.

The TTS delivery layer receives an immutable reference object when it creates a
preparation. It does not search ASR history itself. The TTS bridge converts that
object into the pool request's Prompt + reference fields.

The TTS-pool client remains a protocol boundary. It does not choose segments,
manage desktop state, or implement product fallback policy.

## Browser protocol

The backend sends the current lane state after session readiness, direction
changes, cloning-setting changes, and reference-state changes:

```json
{
  "type": "voice_cloning_status",
  "lane_id": "a_to_b",
  "state": "preparing",
  "reason": "insufficient_clear_speech"
}
```

Normal product copy is selected in the browser from the state and reason. The
protocol does not send transcript text or reference audio.

A manual Speak request made while preparing receives a structured skipped
result rather than a generic TTS failure. The browser keeps the bubble pending
and leaves the cloning status visible.

## Interaction with automatic and speculative TTS

Cloning readiness is an admission condition when speaker cloning is enabled:

- automatic generation starts only for bubbles finalized while the lane is
  ready;
- speculative generation starts only while the lane is ready;
- manual demand while preparing is skipped with a structured reason;
- reaching ready does not enqueue the existing bubble backlog;
- disabling cloning makes future bubbles use the normal configured voice.

The speculation budget does not decrement for a bubble skipped because cloning
is preparing. There was no TTS preparation.

## Storage and limits

Materialized reference WAVs count toward the existing per-session artifact cap.
The deque retains only enough source metadata and WAV ownership to build the
configured maximum window. It must not retain an unbounded copy of every bubble.

Voice-session duration and storage limits remain authoritative. Reaching either
limit ends the session through the existing guardrail behavior.

## Observability

Record metrics without transcript text or audio contents:

| Metric | Purpose |
|---|---|
| cloning enabled or disabled | Measures use of the product option. |
| time and bubbles until lane ready | Shows first-use delay. |
| selected duration and segment count | Compares the experimental window settings. |
| reference replacement count | Shows how often the active voice basis changes. |
| selection rejection reason | Separates too-short, too-long, invalid-timestamp, overlap, and low-quality cases. |
| automatic/speculative/manual request skipped while preparing | Measures the UX impact of strict readiness. |
| Prompt + reference synthesis outcome | Compares cloning reliability with normal TTS. |
| final bubble to first PCM | Detects cloning-related latency regressions. |

Metrics should include backend and lane identifiers already used by voice TTS
metrics. They must not include transcript text.

## Delivery plan

### Phase 1: reference-window backend

- [x] Retain ASR WAV timeline offsets with segment provenance.
- [x] Add bounded per-lane recent-speech deques.
- [x] Select complete, non-overlapping ASR segments within configured bounds.
- [x] Materialize audio and transcript through one fail-closed function.
- [x] Count reference artifacts under the session storage cap.
- [x] Test cross-bubble selection, overlap rejection, boundary durations,
  cleanup, and exact transcript membership.

### Phase 2: cloning session state

- [x] Add validated semantic `voice_cloning.enabled` session state.
- [x] Report `off`, `preparing`, and `ready` per lane.
- [x] Key TTS preparations by immutable reference identity.
- [x] Use Prompt + reference for product cloning.
- [x] Skip automatic, speculative, and manual generation while preparing.
- [x] Prohibit stable-sample fallback from cloning mode.
- [x] Test direction changes, option changes, stale references, and replay.

### Phase 3: desktop UX

- [x] Add **Clone speaker voice** to the desktop voice surface.
- [x] Show Preparing and Ready status from backend events.
- [x] Explain a manual Speak skip without treating it as an error.
- [x] Keep automatic speaking independent from the cloning option.
- [x] Test the first bubbles, direction switching, reload, and session restart.

### Phase 4: tune and migrate

- [ ] Compare three- and five-second first-ready thresholds with real sessions.
- [ ] Check clone quality and first-PCM latency across supported languages.
- [ ] Choose product defaults from observed results.
- [ ] Migrate the validated desktop UX to mobile.
- [ ] Put the remaining mobile experiment controls behind **Dev tools**.

## Acceptance checks

The first product implementation is complete when:

- enabling cloning never produces a stable generated voice unless that source
  was explicitly selected outside cloning mode;
- the desktop clearly shows when the active lane is collecting speech;
- a short bubble can be combined with earlier segments from the same lane;
- every Prompt transcript contains only text belonging to the supplied audio;
- no audio is cut inside an ASR segment;
- cloning becomes ready at the configured minimum, not a hard-coded duration;
- automatic and speculative TTS do not generate cloning audio while preparing;
- reaching ready affects future bubbles without automatically reading the
  backlog;
- each lane maintains independent readiness and reference identity;
- replay reuses the original completed WAV;
- reference metadata and artifacts remain bounded by the session lifecycle.

## Resolved product decisions

- **Clone speaker voice** is off by default.
- The browser remembers the option in `localStorage`.
- The option is available only when TTS is enabled and the active loaded backend
  is VoxCPM-family. It does not switch backends automatically.
- The Ready confirmation remains visible while the session is idle. Playback
  status takes priority while audio is active.

## Open decisions

- Whether three seconds is acceptable after testing, or the first-ready default
  should move to the official five-second recommendation.
- Whether a later version should use reliable word timestamps to split one long
  ASR segment.
