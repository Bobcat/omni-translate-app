// One-shot Web Audio chirp for UI feedback (mic auto-off). Generates the
// tone with an oscillator + gain envelope so no asset file is needed.
// The AudioContext is created lazily on first use and reused.

let _ctx = null;

function ctx() {
  if (_ctx) return _ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    _ctx = new Ctor({ latencyHint: 'interactive' });
  } catch {
    _ctx = null;
  }
  return _ctx;
}

// Single 880 Hz blip — "mic is on".
export function playMicOnCue() {
  _playCue([{ freq: 880, at: 0 }], 0.18);
}

// Two-note "tu-du": 880 Hz dropping to 660 Hz — "mic is off".
export function playMicAutoOffCue() {
  _playCue([
    { freq: 880, at: 0 },
    { freq: 660, at: 0.10 },
  ], 0.22);
}

function _playCue(notes, durationS) {
  const audio = ctx();
  if (!audio) return;
  if (audio.state === 'suspended') {
    audio.resume().catch(() => {});
  }
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = 'sine';
  for (const note of notes) {
    osc.frequency.setValueAtTime(note.freq, now + note.at);
  }
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
  gain.gain.linearRampToValueAtTime(0, now + durationS);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(now);
  osc.stop(now + durationS + 0.02);
}
