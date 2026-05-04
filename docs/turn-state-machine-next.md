# Turn State Machine Next

This note captures the turn-boundary model discussed after the MVP baseline was
closed. It does not redefine the MVP design note.

## Terms

`turn` is the highest-level app object for live conversation state. A turn has a
direction, visible source text, visible target text, TTS/playback state, and an
eventual outcome.

`turn_part` is an app-level playback unit inside a turn. It is not an ASR or
WhisperX segment, and it does not claim to be one semantic speech act. A
`turn_part` groups the source text, target text, and speech state that belong
together for the live UI.

`lane` is a backend routing context, for example `nl_to_en` or `en_to_nl`. A lane
selects the ASR, translation, and TTS path used by a turn. The user-facing action
is starting the next turn, not browsing between lanes.

```text
session
  current_turn
    direction
    lane_id
    parts[]
  closed_turns[]
  discarded_turns[]

lane
  lane_id
  source_language
  target_language
  asr_runner
  translation_runner
```

The ASR and translation runners may keep their own internal state. The visible
source text, visible target text, spoken markers, playback state, and later
export decisions are owned by app-level turn state.

## Turn Part UI

Spoken parts remain visible while the turn is still active, but they are visually
marked as already handled. The same part structure is used in the source and
target panels.

```text
source panel
  spoken part A

  current part B

target panel
  spoken translation A

  current translation B
```

The spacing between parts should be small, paragraph-like spacing. Spoken
content should look handled, not disabled.

## Manual Flow

```text
current_turn
  speak_now
    -> speak not-yet-spoken target text for the current turn
    -> mark the affected part(s) as speaking
    -> keep the current turn open

  tts_playback_complete
    -> mark the spoken part(s) as spoken
    -> keep the current turn open
    -> further ASR/translation starts in a new current part

  next_turn(direction)
    -> close the current turn
    -> create a new current turn for the requested direction
    -> route the new turn through the matching backend lane

  clear_turn
    -> discard the current turn
    -> create a fresh current turn with the same direction
```

`speak_now` must not speak the whole visible target text again after part of the
turn was already spoken. It speaks only the not-yet-spoken target text for the
current turn.

## Future Setting

A later setting may make playback completion start the next turn automatically.
If that setting is enabled, playback completion should trigger the same
backend-owned `next_turn` operation as a manual turn switch.

## Required Guards

Events that belong to an older turn must not repopulate the current live panels
after that turn has been closed or discarded.

`speak_now` applies to the current turn when the backend receives the command. It
must not speak content from a previous turn or another direction.

## Transition Matrix

The turn state enum is flat for implementation convenience. States with the
`OPEN_` prefix are live/current-turn states. `CLOSED` and `DISCARDED` are
terminal lifecycle states.

```text
TurnState
  OPEN_EMPTY
  OPEN_ACTIVE_UNSPOKEN
  OPEN_SPEAKING
  OPEN_SPOKEN_IDLE
  CLOSED
  DISCARDED
```

```text
is_open_turn(state)
  true:  OPEN_EMPTY, OPEN_ACTIVE_UNSPOKEN, OPEN_SPEAKING, OPEN_SPOKEN_IDLE
  false: CLOSED, DISCARDED
```

```text
FROM \ TO              OPEN_EMPTY  OPEN_ACTIVE_UNSPOKEN  OPEN_SPEAKING  OPEN_SPOKEN_IDLE  CLOSED  DISCARDED
------------------------------------------------------------------------------------------------------------
OPEN_EMPTY             x           1                     x              x                 2       3
OPEN_ACTIVE_UNSPOKEN   x           x                     4              x                 5       6
OPEN_SPEAKING          x           x                     x              7                 8       9
OPEN_SPOKEN_IDLE       x           10                    x              x                 11      12
CLOSED                 x           x                     x              x                 x       x
DISCARDED              x           x                     x              x                 x       x
```

1. First ASR/translation content arrives in an empty turn.
2. `next_turn(direction)` closes an empty current turn.
3. `clear_turn` discards an empty current turn.
4. `speak_now` starts TTS for not-yet-spoken target text.
5. `next_turn(direction)` closes an active unsaid turn.
6. `clear_turn` discards an active unsaid turn.
7. `tts_playback_complete` marks the speaking part(s) as spoken.
8. `next_turn(direction)` closes the current turn while TTS is pending or
   playing; later playback results for that turn must not repopulate live state.
9. `clear_turn` discards the current turn while TTS is pending or playing; later
   playback results for that turn must not repopulate live state.
10. New ASR/translation content arrives after all visible target text was spoken.
11. `next_turn(direction)` closes a spoken-idle current turn.
12. `clear_turn` discards a spoken-idle current turn.

## State-Derived Behavior

The UI should derive its controls from the same state table the backend enforces.
Do not show an enabled action that the backend would reject in the current state.

```text
State                 Mic Input   ASR Updates  Speak Now  Clear Turn  Next Turn
-------------------------------------------------------------------------------
OPEN_EMPTY            accepted    accepted     disabled   enabled     enabled
OPEN_ACTIVE_UNSPOKEN  accepted    accepted     enabled    enabled     enabled
OPEN_SPEAKING         paused      guarded      disabled   enabled     enabled
OPEN_SPOKEN_IDLE      accepted    accepted     disabled   enabled     enabled
CLOSED                ignored     ignored      disabled   disabled    disabled
DISCARDED             ignored     ignored      disabled   disabled    disabled
```

`paused` means the frontend should stop sending microphone audio. The backend
still guards the state and rejects or ignores audio if it arrives.

`guarded` means late ASR or translation events may still be accepted only if they
belong to work that was already valid for the current turn before speaking
started. They must not create new live content while the turn is speaking.
