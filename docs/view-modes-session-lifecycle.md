# View Modes And Session Lifecycle

This note captures the current frontend UX direction for view modes and session
lifecycle. It builds on the turn state machine note and does not introduce
separate backend ASR, translation, or TTS paths.

## View Modes

The app has two presentation modes:

```text
[ Turn ] [ Conversation ]
```

`Turn` is the current implemented control view. It is optimized for the active
turn: source preview, translation, `speak_now`, `clear_turn`, and explicit turn
switching.

`Conversation` is a future presentation of the same session state as a
continuous list of app-level `turn_part` data. It must not introduce a separate
backend mode.

## Lifecycle

The frontend has a session lifecycle above the turn state machine:

```text
SETUP --Start--> RUNNING/listening
RUNNING/listening --Mic off--> RUNNING/mic_off
RUNNING/mic_off --Start mic--> RUNNING/listening
RUNNING/mic_off --Finish--> FINALIZING --> ENDED
ENDED --Clear--> SETUP
```

`RUNNING` means the conversation session and websocket are open. Microphone
capture is a sub-state of `RUNNING`, not a separate top-level session state.

## Current Turn Layout

The current app layout has:

- topbar: view-mode selector on the left, status pill on the right
- source and target panels
- source-panel header action overlay during running: clear turn at left, switch
  turn centered with language labels around the icon
- bottom dock: settings at left, session/turn actions to the right

Language dropdowns are visible only in `SETUP`. During a running session the
active source and target languages are shown around the switch-turn control.

## SETUP

In `SETUP`, there is no open session. The user chooses source and target
languages in the panel headers. The microphone/start affordance is centered in
the source panel. The setup switch button is centered in the bottom dock.

```text
+------------------------------------------------+
| [Turn] [Conversation]                          |
+------------------------------------------------+
| What is heard                         [Dutch v]|
|                                                |
|                    (mic)                       |
|                                                |
+------------------------------------------------+
| What will be spoken                 [English v]|
|                                                |
+------------------------------------------------+
| [settings]             [ NL  <->  EN ]         |
+------------------------------------------------+
```

The same session can also be started from `Settings > Microphone` while staying
inside the settings sheet, so the user can immediately inspect input level.

## RUNNING/listening

In `RUNNING/listening`, the browser microphone track is open. Microphone audio
may be sent to the backend unless playback or turn state temporarily blocks it.

The status pill shows `(Listening)`. This is a microphone capture indicator, not
a VAD indicator. VAD state is shown separately as `Speech detected`.

The right dock action is `Mic off`, not `Finish`. `Mic off` stops microphone
capture and keeps the session open.

```text
+------------------------------------------------+
| [Turn] [Conversation]              (Listening) |
+------------------------------------------------+
| [clear turn]          NL  <->  EN              |
| What is heard                                  |
| ... current source text ...                    |
+------------------------------------------------+
| What will be spoken                            |
| ... current translation ...                    |
+------------------------------------------------+
| [settings]      [ Speak now ]       [Mic off] |
+------------------------------------------------+
```

## RUNNING/mic_off

In `RUNNING/mic_off`, the browser microphone track is stopped. The websocket and
conversation session remain open. The current turn remains visible, direction
can be switched, and the user can start the microphone again.

The status pill shows `(Mic off)`.

In Turn view, the mic/start affordance appears in the same source-panel area as
the setup start affordance. It always stays in that fixed position.

`Finish` is available from `RUNNING/mic_off` and ends the session. It is not the
same action as pausing the microphone.

```text
+------------------------------------------------+
| [Turn] [Conversation]                (Mic off) |
+------------------------------------------------+
| [clear turn]          NL  <->  EN              |
| What is heard                                  |
| ... current source text ...                    |
|                                                |
|                    (mic)                       |
+------------------------------------------------+
| What will be spoken                            |
| ... current translation ...                    |
+------------------------------------------------+
| [settings]        [ Speak now ]       [Finish] |
+------------------------------------------------+
```

## Automatic Mic-Off

Default behavior is turn-by-turn listening. The microphone is not kept open
indefinitely after a translated/spoken exchange.

Automatic mic-off triggers:

- after TTS playback completes for the current spoken content
- after a configured no-speech timeout, if that setting is enabled later

Mic on/off may later play short local UI sounds. These sounds are frontend
feedback only. They must not create ASR input and must not play over TTS output.

Continuous listening may become a later setting. If added, it should be explicit
because the microphone remains open across exchanges and after TTS when the
same speaker continues.

## ENDED

In `ENDED`, the session is closed. The transcript remains visible for review and
export. Live controls are gone.

```text
+------------------------------------------------+
| [Turn] [Conversation]                (Finished)|
+------------------------------------------------+
| What is heard                                  |
| ... ended source text ...                      |
+------------------------------------------------+
| What will be spoken                            |
| ... ended translation ...                      |
+------------------------------------------------+
| [settings]                  [ Export ] [Clear] |
+------------------------------------------------+
```

`Export` creates an external artifact, for example text, markdown, JSON, or
another file format. There is no separate `Save` action in the current scope.

`Clear` removes the ended session from the UI and returns to `SETUP`. It should
be visually dangerous but quieter than `Finish`.
