// One-shot Web Audio chirp for UI feedback (mic auto-off). Generates the
// tone with an oscillator + gain envelope so no asset file is needed.
// The AudioContext is created lazily on first use and reused.

let _ctx = null;
let _iosCueAudio = null;

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

// Single 880 Hz blip: mic is on.
export function playMicOnCue() {
  if (usesIosMicCuePath()) {
    return _playIosCue('on');
  }
  return _playCue([{ freq: 880, at: 0 }], 0.18);
}

// Two-note tu-du: 880 Hz dropping to 660 Hz: mic is off.
// Same cue for manual stop and auto-off; the name reflects the event,
// not the trigger.
export function playMicOffCue() {
  if (usesIosMicCuePath()) {
    return _playIosCue('off');
  }
  return _playCue([
    { freq: 880, at: 0 },
    { freq: 660, at: 0.10 },
  ], 0.22);
}

export function usesIosMicCuePath() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iphone|ipad|ipod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function _playCue(notes, durationS) {
  const audio = ctx();
  if (!audio) return false;
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
  return true;
}

function _playIosCue(kind) {
  const cueAudio = iosCueAudio()[kind];
  if (!cueAudio) return false;
  try {
    cueAudio.pause();
    cueAudio.currentTime = 0;
    const playPromise = cueAudio.play();
    if (playPromise?.catch) playPromise.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function iosCueAudio() {
  if (_iosCueAudio) return _iosCueAudio;
  _iosCueAudio = {
    on: createIosCueAudio([{ freq: 880, at: 0, duration: 0.16 }], 0.20),
    off: createIosCueAudio([
      { freq: 880, at: 0, duration: 0.09 },
      { freq: 660, at: 0.14, duration: 0.11 },
    ], 0.29, { sampleGain: 0.08 }),
  };
  return _iosCueAudio;
}

function createIosCueAudio(notes, durationS, { sampleGain = 0.32 } = {}) {
  const audio = new Audio(wavDataUrl(notes, durationS, { sampleGain }));
  audio.preload = 'auto';
  try { audio.load(); } catch {}
  return audio;
}

function wavDataUrl(notes, durationS, { sampleGain = 0.32 } = {}) {
  const sampleRate = 44100;
  const sampleCount = Math.max(1, Math.ceil(durationS * sampleRate));
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    let sample = 0;
    for (const note of notes) {
      if (t < note.at || t >= note.at + note.duration) continue;
      const localT = t - note.at;
      sample += Math.sin(2 * Math.PI * note.freq * localT) * noteEnvelope(localT, note.duration);
    }
    view.setInt16(44 + i * 2, Math.round(clamp(sample * sampleGain, -1, 1) * 0x7fff), true);
  }
  return `data:audio/wav;base64,${base64Bytes(bytes)}`;
}

function noteEnvelope(t, durationS) {
  const attackS = Math.min(0.008, durationS / 4);
  const releaseS = Math.min(0.026, durationS / 3);
  if (t < attackS) return t / attackS;
  if (t > durationS - releaseS) return Math.max(0, (durationS - t) / releaseS);
  return 1;
}

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    bytes[offset + i] = text.charCodeAt(i);
  }
}

function base64Bytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
