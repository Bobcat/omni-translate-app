# Voice session runtime and storage guardrails

Status: implemented on `feature/voice-session-guardrails`; awaiting review.

## Decision

Every live voice session has two server-owned limits:

| Limit | Default | What happens at the limit |
|---|---:|---|
| Active session duration | 15 minutes | The backend ends the voice session. |
| Temporary ASR and TTS audio | 256 MiB per session | The backend rejects the next WAV write and ends the voice session. |

The limits protect a proof-of-concept deployment from a forgotten microphone
that keeps receiving speech from a television, radio, or other continuous
source. Silence-based microphone auto-off does not cover that case because the
audio contains speech.

## Configuration

The defaults live in `config/settings.json`:

```json
{
  "live": {
    "max_session_duration_s": 900,
    "max_session_artifact_bytes": 268435456
  }
}
```

These values are deployment settings. The browser cannot raise them.

## Duration boundary

The duration clock starts when the backend accepts the session WebSocket. ASR
activity, TTS playback, microphone pauses, and browser activity do not reset
the clock. The lifecycle checks the monotonic deadline before accepting the
next WebSocket or ASR-completion event. An operation already in progress may
finish before the lifecycle reaches that check.

At the deadline, the backend:

1. marks the session completed;
2. sends an `ended` event with reason `session_duration_limit`;
3. closes the WebSocket and session resources.

## Storage boundary

The cap counts regular files in both of these session directories:

```text
data/asr_chunks/<session-id>/
data/tts/<session-id>/
```

ASR and TTS writes share one lock around usage calculation and file writing, so
concurrent writes cannot both reserve the same remaining capacity. Replacing a
file counts only the replacement size. A write that would exceed the cap is
rejected before bytes are written.

The TTS pool can finish one final synthesis before the app knows the complete
WAV size. If that WAV does not fit, the app does not store it and ends the
session with reason `session_storage_limit`. Avoiding that last synthesis would
require an audio-size estimate or a reservation protocol with the TTS pool;
that is outside this change.

## Browser behavior

Mobile and desktop handle the same two `ended` reasons. They stop microphone
capture and audio playback, return to voice setup, and show the message supplied
by the backend. A new start action clears the message. Normal user-initiated
session completion does not show a limit warning.

## Retention

Ending a limited session does not immediately delete its artifacts. The normal
`live.session_export_ttl_s` retention remains in effect, currently 15 minutes,
so a just-ended session follows the same cleanup path as any other session.

## Out of scope

- A global disk quota across sessions.
- Per-account quotas or SaaS usage accounting.
- Deleting old bubbles while a session remains active.
- Changing ASR-pool, translation-services, or TTS-pool behavior.
- Persisting voice-session history beyond the existing retention window.
