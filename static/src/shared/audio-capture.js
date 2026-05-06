export class AudioCapture {
  constructor({ targetSampleRate = 16000, chunkMs = 40, preGain = 1, autoGainControl = false, onChunk, onLevel }) {
    this.targetSampleRate = Number(targetSampleRate);
    this.chunkSamples = Math.max(80, Math.round(this.targetSampleRate * Number(chunkMs) / 1000));
    this.preGain = normalizePreGain(preGain);
    this.autoGainControl = autoGainControl === true;
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.preGainNode = null;
    this.processor = null;
    this.silence = null;
    this.pending = new Float32Array(0);
    this.running = false;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone unavailable');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: false,
        echoCancellation: false,
        autoGainControl: this.autoGainControl ? { exact: true } : false,
      },
      video: false,
    });
    this.syncAutoGainControlSetting();
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('AudioContext unavailable');
    }
    this.context = new AudioContextCtor({ latencyHint: 'interactive' });
    this.source = this.context.createMediaStreamSource(this.stream);
    this.preGainNode = this.context.createGain();
    this.preGainNode.gain.value = this.preGain;
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.silence = this.context.createGain();
    this.silence.gain.value = 0;
    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      const input = event.inputBuffer.getChannelData(0);
      this.handleSamples(input, this.context.sampleRate);
    };
    this.source.connect(this.preGainNode);
    this.preGainNode.connect(this.processor);
    this.processor.connect(this.silence);
    this.silence.connect(this.context.destination);
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.processor) {
      try { this.processor.disconnect(); } catch {}
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.silence) {
      try { this.silence.disconnect(); } catch {}
      this.silence = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch {}
      this.source = null;
    }
    if (this.preGainNode) {
      try { this.preGainNode.disconnect(); } catch {}
      this.preGainNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.context) {
      try { this.context.close(); } catch {}
      this.context = null;
    }
    this.pending = new Float32Array(0);
  }

  handleSamples(samples, inputSampleRate) {
    const resampled = resampleLinear(samples, inputSampleRate, this.targetSampleRate);
    this.pending = concatFloat32(this.pending, resampled);
    while (this.pending.length >= this.chunkSamples) {
      const chunk = this.pending.slice(0, this.chunkSamples);
      this.pending = this.pending.slice(this.chunkSamples);
      this.onLevel?.(peakLevel(chunk));
      this.onChunk?.(floatToPcm16(chunk));
    }
  }

  setPreGain(value) {
    this.preGain = normalizePreGain(value);
    if (!this.preGainNode || !this.context) return;
    try {
      this.preGainNode.gain.setTargetAtTime(this.preGain, this.context.currentTime, 0.08);
    } catch {
      try { this.preGainNode.gain.value = this.preGain; } catch {}
    }
  }

  syncAutoGainControlSetting() {
    const track = this.audioTrack();
    const value = track?.getSettings?.().autoGainControl;
    if (typeof value === 'boolean') {
      this.autoGainControl = value;
    }
    return this.autoGainControl;
  }

  audioTrack() {
    return this.stream?.getAudioTracks?.()[0] || null;
  }
}

function normalizePreGain(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0.5, Math.min(3.0, numeric)) : 1;
}

function resampleLinear(input, inputRate, outputRate) {
  if (Math.round(inputRate) === Math.round(outputRate)) {
    return new Float32Array(input);
  }
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    output[i] = input[left] + (input[right] - input[left]) * frac;
  }
  return output;
}

function concatFloat32(left, right) {
  const out = new Float32Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out.buffer;
}

function peakLevel(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  return peak;
}
