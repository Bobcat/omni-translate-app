# View Modes And Session Lifecycle

This note captures the frontend UX direction for switching between a focused
turn view and a continuous conversation view. It builds on the turn state
machine note, but does not change the backend turn protocol.

## View Modes

The app has two view modes:

```text
[ Turn ] [ Conversation ]
```

These are frontend presentations of the same session state. They are not backend
modes and they must not introduce separate ASR, translation, or TTS paths.

`Turn` is the focused control view for working on the current turn. It is better
for longer fragments, preview judgement, `speak_now`, `clear_turn`, and explicit
turn switching.

`Conversation` is the continuous conversation view. It is better for short
back-and-forth exchanges. It renders the session as a list of conversation
items built from app-level `turn_part` data.

## Session Lifecycle

The frontend has a session-level lifecycle above the turn state machine.

```text
SETUP --Start--> RUNNING --Finish--> ENDED --Clear--> SETUP
```

`PAUSED` is a future lifecycle state, not part of the next implementation phase.

```text
SETUP
  no open session
  language setup is available
  Start is the primary action

RUNNING
  websocket/session is open
  recording status is always visible
  language dropdowns are not shown
  language labels are shown subtly inside panels/items
  turn controls are available
  Finish closes the session

ENDED
  session is closed
  transcript/conversation remains visible for review
  live controls are gone
  Export and Clear are available
```

There is no `Start new session` action in `ENDED`. Starting another session is
intentionally two steps:

```text
ENDED --Clear--> SETUP --Start--> RUNNING
```

`Clear` in `ENDED` is a frontend session-clear action. It is not backend
`clear_turn`. Later, `Clear` should show a warning because clearing the ended
session makes export/share actions unavailable from the UI.

## Setup Screens

In `SETUP`, `Start` should be prominent and spatially connected to microphone
capture: a centered microphone affordance with a prominent start control below
it.

For `Turn`, the microphone/start affordance sits inside the source panel,
because the source panel is where speech first appears.

```text
+----------------------------------------------+
| [Turn] [Conversation]              [settings]|
+----------------------------------------------+
| Source / heard                       [NL v]  |
|                                              |
|                  (mic)                       |
|                 [Start]                      |
|                                              |
+----------------------------------------------+
| Translation / to speak               [EN v]  |
| <no translation yet>                         |
+----------------------------------------------+
```

For `Conversation`, the microphone/start affordance is centered in the main
conversation area, because there are no source/target panels.

```text
+----------------------------------------------+
| [Turn] [Conversation]              [settings]|
+----------------------------------------------+
|             [NL v] -> [EN v]                 |
|                                              |
|                  (mic)                       |
|                 [Start]                      |
|                                              |
+----------------------------------------------+
```

Language selection is setup content, not a topbar control. In `SETUP`, language
selectors should be compact dropdown pills with flags. In `Turn`, the selectors
sit in the source and translation panel headers. In `Conversation`, the same
selectors sit in a centered direction row above the microphone/start affordance.

The exact visual form for start may use either a round microphone/start button
or a microphone icon with a text `Start` button below it. The important
requirement is that `Start` is central, obvious, and not a small status chip.

## Running Screens

In `RUNNING`, language dropdowns are hidden. The active languages remain visible
as small labels in the panels or conversation items.

`RUNNING` must always show that the app is still recording. In ASCII, status
pills use round parentheses so they are not confused with buttons. Use a topbar
status pill:

```text
(Listening)
```

The pill should be subtle but unmistakable. A green tint and small pulsing dot
are appropriate. This is a session recording indicator, not a VAD indicator:
`Listening` means the session is open and microphone input is being captured;
`Speech detected` means VAD currently sees speech.

`Turn` keeps the current source and translation panels.

```text
+----------------------------------------------+
| (Listening) [Turn] [Conversation] [settings] |
+----------------------------------------------+
| Source / heard                            NL |
| ... current source text ...                  |
+----------------------------------------------+
| Translation / to speak                    EN |
| ... current translation ...                  |
+----------------------------------------------+
|             [ Speak now ]                    |
|       [ Clear turn ] [ Switch ]              |
|               [ Finish ]                     |
+----------------------------------------------+
```

`Conversation` renders the same session as a continuous list.

```text
+----------------------------------------------+
| (Listening) [Turn] [Conversation] [settings] |
+----------------------------------------------+
| EN -> NL                                     |
| Where do you live?                           |
| Waar woon je?                                |
|                                              |
| NL -> EN                                     |
| Ik woon in het centrum                       |
| I live downtown                              |
|                                              |
| EN -> NL                                     |
| <current speech preview...>                  |
| <current translation...>                     |
+----------------------------------------------+
|             [ Speak now ]                    |
|       [ Clear turn ] [ Switch ]              |
|               [ Finish ]                     |
+----------------------------------------------+
```

`Finish` is a session lifecycle action, not a turn action. It should be styled as
subtly dangerous: soft red background or red text.

`Clear turn` is a turn action. It should not share the exact same visual weight
or wording as session `Clear` in `ENDED`.

ASCII sketches always write this as `[settings]`. The app UI may render it as
a compact gear affordance where space is tight.

## Ended Screen

In `ENDED`, the session remains visible for review and export.

```text
+----------------------------------------------+
| (Finished) [Turn] [Conversation] [settings]  |
+----------------------------------------------+
| EN -> NL                                     |
| Where do you live?                           |
| Waar woon je?                                |
|                                              |
| NL -> EN                                     |
| Ik woon in het centrum                       |
| I live downtown                              |
+----------------------------------------------+
|          [ Export ] [ Clear ]                |
+----------------------------------------------+
```

`Export` means creating an external artifact, for example text, markdown, JSON,
or another file format. There is no separate `Save` action in the current scope.

`Clear` in `ENDED` removes the ended session from the UI and returns to `SETUP`.
It should be visually dangerous but quieter than `Finish`: outline or text-only
styling with red text is preferred.

## Future Pause State

`Pause` is useful when the conversation context continues but nearby speech
should temporarily not become part of the session.

Future behavior:

```text
RUNNING --Pause--> PAUSED --Resume--> RUNNING
PAUSED --Finish--> ENDED
```

`PAUSED` keeps the same session and visible transcript. Microphone capture stops
or stops being sent. `Resume` continues the same session.

`Pause` is intentionally out of scope for the next implementation phase.
