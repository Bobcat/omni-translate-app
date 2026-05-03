# MVP Turn-Taking Design

## Purpose

This note defines the MVP architecture for the ASR -> Translate -> TTS app.
It covers backend and frontend because the protocol, runtime model, and UI rules
must match.

## MVP Scope

The MVP supports one conversation between two fixed language sides:

- side A speaks one configured language
- side B speaks one configured language
- audio is captured from one browser microphone
- the user manually switches which side is currently speaking
- ASR and Translate update the live turn
- TTS is an explicit user action

Example:

```text
side A: Dutch
side B: English

active lane a_to_b:
  ASR Dutch -> translate Dutch to English

active lane b_to_a:
  ASR English -> translate English to Dutch
```

## Core Decision

The backend must model two fixed lanes per session, not one mutable direction.

```text
ConversationRuntime
  side_a_language
  side_b_language
  active_lane_id

  lane a_to_b
    source_language = side_a_language
    target_language = side_b_language
    current_turn
    kept_turn_history
    spoken_clip_history
    ASR runner
    ASR inflight state
    source transcript state
    translation runner
    translation bridge
    target transcript state

  lane b_to_a
    source_language = side_b_language
    target_language = side_a_language
    current_turn
    kept_turn_history
    spoken_clip_history
    ASR runner
    ASR inflight state
    source transcript state
    translation runner
    translation bridge
    target transcript state
```

Switching turns changes `active_lane_id`. It must not rebuild the whole session
or mutate the session languages.

Each lane has exactly one current turn. A turn contains the visible source and
target text for that lane. Kept turn history and spoken clip history are owned by
the app runtime, not by the ASR or translation runners.

## Live Turn Flow

ASR and Translate behave like the replay flow in `llm-workbench`: source preview
and commit events are passed to the translation runner, and source/target updates
are sent to the frontend as the live state changes.

TTS is separate from ASR and Translate. A translation may appear in the target
panel before anything is spoken.

```text
audio
  -> ASR preview/commit
  -> source update
  -> translation runner
  -> target update

speak_now
  -> snapshot current visible target text
  -> TTS/playback for that snapshot
  -> keep/archive the turn after successful playback
  -> start a new empty current turn
```

If ASR produces a bad result, the user can clear the current turn and try again.
Clearing a turn is an app-level action:

```text
reset_turn
  -> clear the visible source and target text for the active lane
  -> mark that current turn content as not kept by the app
  -> start a new empty current turn
  -> do not reset the ASR runner
  -> do not reset the translation runner
```

Later export should be based on app-level kept turn history, not on raw runner
state. Cleared turn content is not exported.

During local TTS playback, the frontend pauses or mutes microphone capture and
sends no microphone audio to the backend. Capture resumes after playback ends,
optionally after a short tail delay.

## Backend Invariants

The session languages are fixed for the lifetime of a session. During a live
session, the user can switch turns, but not redefine the languages.

Each lane owns the state that depends on source language and audio history:

- ASR runner
- current ASR work item, if any
- source transcript state
- translation runner and bridge

ASR work is lane-scoped. When an ASR request is submitted, the backend must keep
enough metadata to apply its result to the lane that submitted it. This matters
when the user switches turns while an ASR request is still running.

The app runtime owns kept turn history. The ASR and translation runners provide
live processing state; they are not the source of truth for which turn fragments
are kept, cleared, spoken, or exported.

Async ASR, translation, and TTS results belong to the lane and current turn for
which they were created. If that turn is no longer current, the app runtime must
ignore the result for visible/current-turn state.

## Protocol

Session creation:

```json
{
  "side_a_language": "Dutch",
  "side_b_language": "English"
}
```

Ready event:

```json
{
  "type": "ready",
  "side_a_language": "Dutch",
  "side_b_language": "English",
  "active_lane_id": "a_to_b",
  "lanes": {
    "a_to_b": {
      "source_language": "Dutch",
      "target_language": "English",
      "asr_language": "nl",
      "current_turn_id": "turn_1"
    },
    "b_to_a": {
      "source_language": "English",
      "target_language": "Dutch",
      "asr_language": "en",
      "current_turn_id": "turn_2"
    }
  }
}
```

Turn switch command:

```json
{
  "type": "set_active_lane",
  "lane_id": "b_to_a"
}
```

Turn switch acknowledgement:

```json
{
  "type": "active_lane_changed",
  "active_lane_id": "b_to_a"
}
```

Source and target updates:

```json
{
  "type": "source_update",
  "lane_id": "b_to_a",
  "turn_id": "turn_2",
  "committed_append": "...",
  "preview": "..."
}
```

```json
{
  "type": "target_update",
  "lane_id": "b_to_a",
  "turn_id": "turn_2",
  "committed_append": "...",
  "preview": "...",
  "tts": null
}
```

Speak now:

```json
{
  "type": "speak_now"
}
```

This requests TTS/playback for the current visible target text in the active
lane. After successful playback, the current turn is kept and the lane starts a
new empty current turn.

Reset current turn:

```json
{
  "type": "reset_turn"
}
```

This clears the current visible source and target text for the active lane.

Reset acknowledgement:

```json
{
  "type": "turn_reset_ack",
  "lane_id": "b_to_a",
  "old_turn_id": "turn_2",
  "new_turn_id": "turn_3"
}
```

## Frontend Rules

Before starting, the user chooses the two session languages. During a live
session those controls are locked.

The direction control switches the active lane. The text panels always show the
source and target state for that active lane.

Switching the active lane does not clear, archive, speak, or cancel either lane.

A reset-turn control clears the current visible source and target text for the
active lane.

When the active lane changes, the panel labels and contents change together:

```text
a_to_b active:
  source panel: side A language
  target panel: side B language

b_to_a active:
  source panel: side B language
  target panel: side A language
```

## Frontend Sketch

```text
+--------------------------------------+
| NL v -> EN v      [Start] [Settings] |
+--------------------------------------+
| Bron - NL                            |
|                                      |
| <Nog geen spraak>                    |
|                                      |
|                                      |
|                                      |
|                                      |
|                                      |
|                                      |
+--------------------------------------+
| Vertaling - EN                       |
|                                      |
| <Nog geen vertaling>                 |
|                                      |
|                                      |
|                                      |
|                                      |
|                                      |
|                                      |
+--------------------------------------+
| [Spreek uit]      [Wis]        [<->] |
+--------------------------------------+
```

## Implementation Phases

1. Add backend `ConversationLane`.
2. Add lane-aware protocol events.
3. Route audio, ASR polling, translation, reset-turn, and TTS through lane state.
4. Add app-level turn history per lane.
5. Disable frontend language controls during live sessions.
6. Verify turn switching across both lanes.
