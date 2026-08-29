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


class FakeAudioContext extends FakeEventTarget {
  constructor({ state = 'running', resumeState = 'running' } = {}) {
    super();
    this.currentTime = 1;
    this.destination = {};
    this.state = state;
    this.resumeState = resumeState;
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
    this.state = this.resumeState;
    this.dispatch('statechange');
    return Promise.resolve();
  }
}


function pcmBase64(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString('base64');
}


function makeQueue({ context = new FakeAudioContext(), playbackStartDelayMs = 0 } = {}) {
  const ended = [];
  const failed = [];
  const started = [];
  const completed = [];
  const willStart = [];
  const statuses = [];
  const resumeButton = new FakeEventTarget();
  resumeButton.hidden = true;
  const audio = new FakeAudio();
  const queue = new AudioQueue({
    audio,
    resumeButton,
    audioContextFactory: () => context,
    playbackStartDelayMs,
    onPlaybackWillStart: (item) => willStart.push(item.artifactId),
    onStatus: (status) => statuses.push(status),
    onPlaybackStart: (item) => started.push(item.artifactId),
    onPlaybackIdle: () => {},
    onPlaybackComplete: (item) => completed.push(item.artifactId),
    onItemEnded: (item) => ended.push(item.artifactId),
    onItemFailed: (item, reason) => failed.push([item.artifactId, reason]),
  });
  return {
    queue,
    audio,
    context,
    ended,
    failed,
    willStart,
    started,
    completed,
    statuses,
    resumeButton,
  };
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
  assert.deepEqual(harness.willStart, ['tts_1']);
  assert.equal(harness.context.sources.length, 1);
  assert.equal(harness.ended.length, 0);
  assert.ok(harness.statuses.includes('Playing audio'));

  harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 1 });
  assert.equal(harness.ended.length, 0);

  harness.context.sources[0].finish();
  assert.deepEqual(harness.ended, ['tts_1']);
  assert.deepEqual(harness.completed, ['tts_1']);
});


test('a playback-start delay leaves PCM pending until the audio route can settle', async () => {
  const harness = makeQueue({ playbackStartDelayMs: 5 });
  harness.queue.startPcmStream({
    artifactId: 'tts_1',
    sampleRateHz: 16_000,
    channelCount: 1,
  });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });

  assert.deepEqual(harness.willStart, ['tts_1']);
  assert.equal(harness.context.sources.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(harness.context.sources.length, 1);
});


test('stopping during the playback-start delay prevents late PCM playback', async () => {
  const harness = makeQueue({ playbackStartDelayMs: 5 });
  harness.queue.startPcmStream({
    artifactId: 'tts_1',
    sampleRateHz: 16_000,
    channelCount: 1,
  });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });

  harness.queue.stop();
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(harness.context.sources.length, 0);
  assert.equal(harness.queue.current, null);
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


test('a queued live stream is detected while a replay is playing', () => {
  const harness = makeQueue();
  harness.queue.enqueue({
    artifactId: 'replay_1',
    url: '/fake/replay.wav',
    replay: true,
  });
  assert.equal(harness.queue.hasNonReplayAudio(), false);

  harness.queue.startPcmStream({
    artifactId: 'tts_2',
    sampleRateHz: 16_000,
    channelCount: 1,
  });

  assert.equal(harness.queue.current.replay, true);
  assert.equal(harness.queue.hasNonReplayAudio(), true);
});


test('a URL playback error settles the current item', () => {
  const harness = makeQueue();
  harness.queue.enqueue({ artifactId: 'tts_1', url: '/fake/missing.wav' });

  harness.audio.dispatch('error');

  assert.deepEqual(harness.failed, [['tts_1', 'url_playback_failed']]);
  assert.equal(harness.queue.current, null);
  assert.equal(harness.audio.src, '');
});


test('a URL item without a URL fails before entering the queue', () => {
  const harness = makeQueue();

  const accepted = harness.queue.enqueue({ artifactId: 'tts_1' });

  assert.equal(accepted, false);
  assert.deepEqual(harness.failed, [['tts_1', 'missing_audio_url']]);
  assert.equal(harness.queue.hasAudio(), false);
});


test('a client-side sequence failure aborts and reports the stream', () => {
  const harness = makeQueue();
  harness.queue.startPcmStream({ artifactId: 'tts_1', sampleRateHz: 16_000, channelCount: 1 });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });

  const accepted = harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 2,
    pcmBase64: pcmBase64([3, 4]),
  });

  assert.equal(accepted, false);
  assert.deepEqual(harness.failed, [['tts_1', 'sequence_mismatch']]);
  assert.equal(harness.queue.current, null);
  assert.equal(harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 1 }), false);
});


test('a completed stream without PCM aborts instead of stalling the queue', () => {
  const harness = makeQueue();
  harness.queue.startPcmStream({ artifactId: 'tts_1', sampleRateHz: 16_000, channelCount: 1 });

  const accepted = harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 0 });

  assert.equal(accepted, false);
  assert.deepEqual(harness.failed, [['tts_1', 'empty_pcm_stream']]);
  assert.equal(harness.queue.current, null);
  assert.equal(harness.queue.hasAudio(), false);
});


test('a queued empty stream is removed without blocking the current item', () => {
  const harness = makeQueue();
  harness.queue.startPcmStream({ artifactId: 'tts_1', sampleRateHz: 16_000, channelCount: 1 });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });
  harness.queue.completePcmStream({ artifact_id: 'tts_1', duration_ms: 1 });
  harness.queue.startPcmStream({ artifactId: 'tts_2', sampleRateHz: 16_000, channelCount: 1 });

  harness.queue.completePcmStream({ artifact_id: 'tts_2', duration_ms: 0 });

  assert.deepEqual(harness.failed, [['tts_2', 'empty_pcm_stream']]);
  assert.equal(harness.queue.current.artifactId, 'tts_1');
  harness.context.sources[0].finish();
  assert.equal(harness.queue.current, null);
});


test('a suspended AudioContext keeps chunks pending and exposes resume', async () => {
  const context = new FakeAudioContext({ state: 'suspended', resumeState: 'suspended' });
  const harness = makeQueue({ context });
  harness.queue.startPcmStream({ artifactId: 'tts_1', sampleRateHz: 16_000, channelCount: 1 });
  harness.queue.appendPcmChunk({
    artifactId: 'tts_1',
    sequenceNumber: 0,
    pcmBase64: pcmBase64([1, 2]),
  });

  harness.queue.preparePcmPlayback();
  await Promise.resolve();

  assert.equal(harness.context.sources.length, 0);
  assert.equal(harness.queue.blocked, true);
  assert.equal(harness.resumeButton.hidden, false);
  assert.equal(harness.queue.statusText(), 'Audio ready');

  context.state = 'running';
  context.dispatch('statechange');
  assert.equal(harness.context.sources.length, 1);
  assert.deepEqual(harness.started, ['tts_1']);
});
