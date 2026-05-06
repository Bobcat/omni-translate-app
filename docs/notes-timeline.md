# Design Notes Timeline

This file tracks the order and implementation status of the design notes. The
notes themselves stay as decision records; this timeline is the place to mark
what is implemented, refined, or still next.

## Status Values

```text
Done
  implemented in the current app

Done, refined later
  implemented as a baseline, with later notes replacing or sharpening specific
  details

Partly done
  some sections are implemented; remaining sections are still active work

Next
  agreed direction, not implemented yet
```

## Timeline

| Order | Note | Status | Code relation |
| --- | --- | --- | --- |
| 1 | [MVP Turn-Taking Design](mvp-turn-taking-design.md) | Done, refined later | Establishes the baseline app: two fixed lanes, fixed session languages, explicit turn switching, ASR -> Translate -> TTS, `speak_now`, and `clear_turn`. Later notes refine turn lifetime and playback behavior. |
| 2 | [Turn State Machine Next](turn-state-machine-next.md) | Done | Defines current app-level turn and `turn_part` behavior, including spoken-vs-unspoken content, guarded updates while speaking, and the flat `OPEN_*` turn states. Implemented in backend runtime, frontend state mapping, and turn-state tests. |
| 3 | [View Modes And Session Lifecycle](view-modes-session-lifecycle.md) | Partly done | Current Turn view, setup/running/ended shell, settings placement, language setup, status pill, export/clear, mobile styling, manual `RUNNING/listening` <-> `RUNNING/mic_off`, and automatic mic-off after TTS playback are implemented. Conversation view remains disabled. |

## Remaining Targets

Remaining targets from
[View Modes And Session Lifecycle](view-modes-session-lifecycle.md):

```text
Conversation view
No-speech timeout --> RUNNING/mic_off
Optional mic on/off UI sounds
Optional continuous listening setting
```

These should build on the implemented manual and automatic mic-state flow:

- keep the websocket session open
- stop browser microphone capture
- keep the current turn visible
- leave `Start mic` available from the source panel
- leave `Finish` available from mic-off
