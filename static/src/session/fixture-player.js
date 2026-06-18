// Replays an audio file through the live websocket as if it came from
// the mic. Started from the setup screen via the dev-only fixture
// button: the session opens *without* the mic ever turning on, so the
// pcm stream is exactly the fixture content (no ambient bleed during
// the brief gap between Start and FX-inject).

import { state } from '../state.js';
import { APP_MODES, MIC_STATES } from '../shared/constants.js';
import { startListening } from './lifecycle.js';
import { renderLifecycle } from '../ui/render-status.js';

const FIXTURE_URL = '/fixtures/panel_120s.mp3';
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 50;

let activeTimer = null;

export async function handleSetupFixtureClick() {
  if (state.appMode !== APP_MODES.SETUP) return;
  if (state.fixtureBusy) return;
  state.fixtureBusy = true;
  renderLifecycle();
  try {
    const pcm16 = await loadFixturePcm16();
    await startListening({ withMic: false });
    if (state.appMode !== APP_MODES.LIVE_RECORDING) return;
    if (!state.socket?.isOpen()) return;
    await streamPcm16(pcm16);
  } catch (error) {
    state.status = 'error';
  } finally {
    state.fixtureBusy = false;
    state.micState = MIC_STATES.OFF;
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    renderLifecycle();
  }
}

async function loadFixturePcm16() {
  const response = await fetch(FIXTURE_URL);
  if (!response.ok) throw new Error(`fixture_fetch_failed:${response.status}`);
  const buffer = await response.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new Ctx();
  let decoded;
  try {
    decoded = await decodeCtx.decodeAudioData(buffer.slice(0));
  } finally {
    decodeCtx.close?.();
  }
  const mono = downmixToMono(decoded);
  const resampled = decoded.sampleRate === TARGET_SAMPLE_RATE
    ? mono
    : resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
  return floatToPcm16(resampled);
}

function downmixToMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  if (channels === 1) return audioBuffer.getChannelData(0).slice();
  const out = new Float32Array(length);
  for (let ch = 0; ch < channels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  for (let i = 0; i < length; i++) out[i] /= channels;
  return out;
}

function resampleLinear(input, srcRate, dstRate) {
  if (srcRate === dstRate) return input;
  const ratio = srcRate / dstRate;
  const dstLen = Math.floor(input.length / ratio);
  const out = new Float32Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function floatToPcm16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

function streamPcm16(pcm16) {
  return new Promise((resolve) => {
    const samplesPerChunk = Math.round(TARGET_SAMPLE_RATE * (CHUNK_MS / 1000));
    let offset = 0;
    const tick = () => {
      activeTimer = null;
      if (!state.fixtureBusy || !state.socket?.isOpen() || offset >= pcm16.length) {
        resolve();
        return;
      }
      const end = Math.min(pcm16.length, offset + samplesPerChunk);
      const slice = pcm16.subarray(offset, end);
      const bytes = new Uint8Array(slice.byteLength);
      bytes.set(new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength));
      state.socket.sendAudio(bytes.buffer);
      offset = end;
      activeTimer = setTimeout(tick, CHUNK_MS);
    };
    tick();
  });
}
