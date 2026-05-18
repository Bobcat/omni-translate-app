const WORKLET_NAME = 'asr-capture-processor';

export class AudioCapture {
  constructor({ targetSampleRate = 16000, chunkMs = 40, preGain = 1, autoGainControl = false, onChunk, onLevel }) {
    this.targetSampleRate = Number(targetSampleRate);
    this.chunkMs = Number(chunkMs);
    this.chunkSamples = Math.max(80, Math.round(this.targetSampleRate * this.chunkMs / 1000));
    this.preGain = normalizePreGain(preGain);
    this.autoGainControl = autoGainControl === true;
    this.onChunk = onChunk;
    this.onLevel = onLevel;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.preGainNode = null;
    this.worklet = null;
    this.processor = null;
    this.silence = null;
    this.workletUrl = null;
    this.inputSampleRate = 0;
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
        sampleRate: this.targetSampleRate,
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
    this.inputSampleRate = Number(this.context.sampleRate || this.targetSampleRate);
    this.source = this.context.createMediaStreamSource(this.stream);
    this.preGainNode = this.context.createGain();
    this.preGainNode.gain.value = this.preGain;
    this.source.connect(this.preGainNode);

    let workletReady = false;
    if (this.context.audioWorklet && typeof window.AudioWorkletNode !== 'undefined') {
      try {
        this.workletUrl = buildWorkletModuleUrl();
        await this.context.audioWorklet.addModule(this.workletUrl);
        const node = new AudioWorkletNode(this.context, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1,
        });
        node.port.onmessage = (event) => this.handleSamples(event.data, this.inputSampleRate);
        this.preGainNode.connect(node);
        this.worklet = node;
        workletReady = true;
      } catch {
        // Fall through to ScriptProcessor below.
      }
    }

    if (!workletReady) {
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.silence = this.context.createGain();
      this.silence.gain.value = 0;
      this.processor.onaudioprocess = (event) => {
        if (!this.running) return;
        const input = event.inputBuffer.getChannelData(0);
        this.handleSamples(input, this.context.sampleRate);
      };
      this.preGainNode.connect(this.processor);
      this.processor.connect(this.silence);
      this.silence.connect(this.context.destination);
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    this.running = true;
  }

  stop() {
    this.running = false;
    if (this.worklet) {
      try { this.worklet.port.onmessage = null; } catch {}
      try { this.worklet.disconnect(); } catch {}
      this.worklet = null;
    }
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
    if (this.workletUrl) {
      try { URL.revokeObjectURL(this.workletUrl); } catch {}
      this.workletUrl = null;
    }
    this.inputSampleRate = 0;
    this.pending = new Float32Array(0);
  }

  handleSamples(samples, inputSampleRate) {
    if (!(samples instanceof Float32Array) || samples.length === 0) return;
    const resampled = downsampleAveraging(samples, inputSampleRate, this.targetSampleRate);
    if (!resampled || resampled.length === 0) return;
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

function buildWorkletModuleUrl() {
  const code = `
class AsrCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    this.port.postMessage(new Float32Array(channel));
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', AsrCaptureProcessor);
`;
  const blob = new Blob([code], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

function downsampleAveraging(input, inputRate, outputRate) {
  const inRate = Number(inputRate || 0);
  const outRate = Number(outputRate || 0);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) {
    return new Float32Array(0);
  }
  if (Math.round(inRate) === Math.round(outRate)) {
    return new Float32Array(input);
  }
  if (outRate > inRate) {
    return new Float32Array(input);
  }
  const ratio = inRate / outRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < output.length) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((offsetResult + 1) * ratio));
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i += 1) {
      accum += input[i];
      count += 1;
    }
    output[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
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
