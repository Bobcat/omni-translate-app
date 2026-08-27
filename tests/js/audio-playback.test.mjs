import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioQueue } from '../../static/src/shared/audio-playback.js';


class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener();
  }
}


class FakeAudio extends FakeEventTarget {
  constructor() {
    super();
    this.src = '';
    this.paused = true;
  }

  play() {
    this.paused = false;
    this.dispatch('play');
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatch('pause');
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }

  load() {}
}


class FakeSource extends FakeEventTarget {
  constructor(context) {
    super();
    this.context = context;
    this.buffer = null;
    this.startedAt = null;
    this.stopped = false;
  }

  connect() {}

  start(at) {
    this.startedAt = at;
    this.context.sources.push(this);
  }

  stop() {
    this.stopped = true;
    this.dispatch('ended');
  }

  finish() {
    this.dispatch('ended');
  }
}


class FakeAudioContext {
  constructor() {
    this.currentTime = 1;
    this.destination = {};
    this.state = 'running';
    this.sources = [];
  }

  createBuffer(channelCount, frameCount, sampleRate) {
    const channels = Array.from(
      { length: channelCount },
      () => new Float32Array(frameCount),
    );
    return {
      duration: frameCount / sampleRate,
      getChannelData: (channel) => channels[channel],
      channels,
    };
  }

  createBufferSource() {
    return new FakeSource(this);
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}


function pcmBase64(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString('base64');
}


function makeQueue() {
  const context = new FakeAudioContext();
  const ended = [];
  const started = [];
  const completed = [];
  const statuses = [];
  const resumeButton = new FakeEventTarget();
  resumeButton.hidden = true;
  const queue = new AudioQueue({
    audio: new FakeAudio(),
    resumeButton,
    audioContextFactory: () => context,
    onStatus: (status) => statuses.push(status),
    onPlaybackStart: (item) => started.push(item.artifactId),
    onPlaybackIdle: () => {},
    onPlaybackComplete: (item) => completed.push(item.artifactId),
    onItemEnded: (item) => ended.push(item.artifactId),
  });
  return { queue, context, ended, started, completed, statuses };
}


test('PCM chunks start playing before the stream completes', () => {
  const harness = makeQueue();
  harness.queue.startPcmStream({
    artifactId: 'tts_1',
    sampleRateHz: 16_000,
    channelCount: 1,
  });

  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([-32768, 0, 32767]),
  });

  assert.deepEqual(harness.started, ['tts_1']);
  assert.equal(harness.context.sources.length, 1);
  assert.equal(harness.ended.length, 0);
  assert.ok(harness.statuses.includes('Playing audio'));

  harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 1 });
  assert.equal(harness.ended.length, 0);

  harness.context.sources[0].finish();
  assert.deepEqual(harness.ended, ['tts_1']);
  assert.deepEqual(harness.completed, ['tts_1']);
});


test('a queued PCM stream keeps bubble playback order', () => {
  const harness = makeQueue();
  harness.queue.startPcmStream({ artifactId: 'tts_1', sampleRateHz: 16_000, channelCount: 1 });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });
  harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 1 });

  harness.queue.startPcmStream({ artifactId: 'tts_2', sampleRateHz: 16_000, channelCount: 1 });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_2',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([3, 4]),
  });
  harness.queue.completePcmStream({ artifact_id: 'tts_2', duration_ms: 1 });

  assert.equal(harness.context.sources.length, 1);
  harness.context.sources[0].finish();
  assert.equal(harness.context.sources.length, 2);
  assert.deepEqual(harness.started, ['tts_1', 'tts_2']);

  harness.context.sources[1].finish();
  assert.deepEqual(harness.ended, ['tts_1', 'tts_2']);
});


test('stopping an in-flight stream settles it only after synthesis completes', () => {
  const harness = makeQueue();
  harness.queue.startPcmStream({ artifactId: 'tts_1', sampleRateHz: 16_000, channelCount: 1 });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });

  harness.queue.stop();
  assert.equal(harness.context.sources[0].stopped, true);
  assert.equal(harness.ended.length, 0);

  harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 1 });
  assert.deepEqual(harness.ended, ['tts_1']);
});
