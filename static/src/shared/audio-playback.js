export class AudioQueue {
  constructor({
    audio,
    resumeButton,
    onStatus,
    onPlaybackWillStart,
    onPlaybackStart,
    onPlaybackIdle,
    onPlaybackComplete,
    onItemEnded,
    onItemFailed,
    audioContextFactory = defaultAudioContextFactory,
    playbackStartDelayMs = 0,
  }) {
    this.audio = audio;
    this.resumeButton = resumeButton;
    this.onStatus = onStatus;
    this.onPlaybackWillStart = onPlaybackWillStart;
    this.onPlaybackStart = onPlaybackStart;
    this.onPlaybackIdle = onPlaybackIdle;
    this.onPlaybackComplete = onPlaybackComplete;
    this.onItemEnded = onItemEnded;
    this.onItemFailed = onItemFailed;
    this.queue = [];
    this.current = null;
    this.blocked = false;
    this.audioContextFactory = audioContextFactory;
    this.playbackStartDelayMs = Math.max(0, Number(playbackStartDelayMs) || 0);
    this.playbackStartTimer = null;
    this.pcmContext = null;
    this.pcmStreams = new Map();
    this.audio.addEventListener('ended', () => {
      if (this.current?.kind === 'pcm') return;
      const ended = this.current;
      const playbackWillComplete = this.queue.length === 0;
      if (ended) {
        this.onItemEnded?.(ended);
        try { ended.onComplete?.(ended); } catch {}
      }
      this.playNext();
      if (playbackWillComplete) this.onPlaybackComplete?.(ended);
    });
    this.audio.addEventListener('play', () => {
      this.blocked = false;
      this.onPlaybackStart?.(this.current);
      this.render();
    });
    this.audio.addEventListener('pause', () => this.render());
    this.audio.addEventListener('error', () => {
      const failed = this.current;
      if (failed?.kind !== 'url') return;
      this.current = null;
      this.blocked = false;
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.onItemFailed?.(failed, 'url_playback_failed');
      if (this.queue.length) this.playNext();
      else this.render();
    });
    this.resumeButton.addEventListener('click', () => {
      this.playOrResume();
    });
    this.render();
  }

  enqueue(item) {
    const queued = {
      ...item,
      kind: 'url',
      url: String(item?.url || ''),
      durationMs: Number(item?.duration_ms || 0),
    };
    if (!queued.url) {
      this.onItemFailed?.(queued, 'missing_audio_url');
      return false;
    }
    this.queue.push(queued);
    if (!this.current) {
      this.playNext();
    } else {
      this.render();
    }
    return true;
  }

  preparePcmPlayback() {
    const context = this.ensurePcmContext();
    if (!context) return false;
    if (context.state === 'running') {
      this.blocked = false;
      this.render();
      return true;
    }
    if (context.state === 'closed' || typeof context.resume !== 'function') return false;
    this.blocked = true;
    this.render();
    context.resume().then(() => {
      if (this.pcmContext !== context) return;
      this.blocked = context.state !== 'running';
      if (!this.blocked && this.current?.kind === 'pcm') {
        this.schedulePendingPcm(this.current);
      } else {
        this.render();
      }
    }).catch(() => {
      this.blocked = true;
      this.render();
    });
    return true;
  }

  startPcmStream(item) {
    const artifactId = String(item?.artifactId || item?.artifact_id || '').trim();
    const sampleRateHz = Number(item?.sampleRateHz || item?.sample_rate_hz || 0);
    const channelCount = Number(item?.channelCount || item?.channel_count || 0);
    if (!artifactId || sampleRateHz <= 0 || channelCount <= 0 || this.pcmStreams.has(artifactId)) return false;
    const streamItem = {
      ...item,
      kind: 'pcm',
      artifactId,
      durationMs: 0,
      stream: {
        sampleRateHz,
        channelCount,
        nextSequence: 0,
        pendingChunks: [],
        activeSources: new Set(),
        nextStartAt: 0,
        completed: false,
        playbackStarted: false,
        playbackStopped: false,
      },
    };
    this.pcmStreams.set(artifactId, streamItem);
    this.queue.push(streamItem);
    if (!this.current) this.playNext();
    else this.render();
    return true;
  }

  appendPcmChunk({ artifactId, sequenceNumber, pcmBase64 }) {
    const item = this.pcmStreams.get(String(artifactId || ''));
    if (!item || item.stream.completed || item.stream.playbackStopped) return false;
    const sequence = Number(sequenceNumber);
    if (!Number.isInteger(sequence) || sequence !== item.stream.nextSequence) {
      this.abortPcmStream(item.artifactId, 'sequence_mismatch');
      return false;
    }
    let pcm;
    try {
      pcm = decodeBase64Bytes(pcmBase64);
    } catch {
      this.abortPcmStream(item.artifactId, 'base64_decode_failed');
      return false;
    }
    const frameBytes = item.stream.channelCount * 2;
    if (!pcm.length || pcm.length % frameBytes) {
      this.abortPcmStream(item.artifactId, 'invalid_pcm_chunk');
      return false;
    }
    item.stream.nextSequence += 1;
    item.stream.pendingChunks.push(pcm);
    if (this.current === item) this.schedulePendingPcm(item);
    return true;
  }

  completePcmStream(tts) {
    const artifactId = String(tts?.artifact_id || tts?.artifactId || '').trim();
    const item = this.pcmStreams.get(artifactId);
    if (!item) return false;
    if (item.stream.nextSequence === 0) {
      this.abortPcmStream(artifactId, 'empty_pcm_stream');
      return false;
    }
    item.url = String(tts?.url || '');
    item.durationMs = Number(tts?.duration_ms || 0);
    item.stream.completed = true;
    if (item.stream.playbackStopped) {
      this.pcmStreams.delete(artifactId);
      this.onItemEnded?.(item);
      return true;
    }
    if (this.current === item) {
      this.schedulePendingPcm(item);
      this.finishPcmIfReady(item);
    }
    return true;
  }

  abortPcmStream(artifactId, reason) {
    return this.failPcmStream(artifactId, { notifyServer: true, reason });
  }

  failPcmStream(artifactId, { notifyServer = false, reason = '' } = {}) {
    const id = String(artifactId || '').trim();
    const item = this.pcmStreams.get(id);
    if (!item) return false;
    this.pcmStreams.delete(id);
    item.stream.playbackStopped = true;
    this.stopPcmSources(item);
    this.queue = this.queue.filter((queued) => queued !== item);
    if (notifyServer) this.onItemFailed?.(item, String(reason || 'pcm_stream_failed'));
    if (this.current === item) {
      this.cancelPendingPlaybackStart();
      this.current = null;
      this.playNext();
    }
    this.render();
    return true;
  }

  clear() {
    this.cancelPendingPlaybackStart();
    this.clearPcmStreams();
    this.queue = [];
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.onPlaybackIdle?.();
    this.render();
  }

  stop() {
    this.cancelPendingPlaybackStart();
    const stopped = [this.current, ...this.queue].filter(Boolean);
    for (const item of stopped) {
      if (item.kind === 'pcm') {
        item.stream.playbackStopped = true;
        item.stream.pendingChunks = [];
        this.stopPcmSources(item);
        if (item.stream.completed) {
          this.pcmStreams.delete(item.artifactId);
          this.onItemEnded?.(item);
        }
      } else {
        this.onItemEnded?.(item);
      }
    }
    this.queue = [];
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.onPlaybackIdle?.();
    this.render();
  }

  hasAudio() {
    return Boolean(this.current || this.queue.length || this.audio.src);
  }

  hasNonReplayAudio() {
    if (this.current && !this.current.replay) return true;
    return this.queue.some((item) => !item.replay);
  }

  currentArtifactId() {
    return String(this.current?.artifactId || '');
  }

  playOrResume() {
    if (this.current?.kind === 'pcm') {
      this.preparePcmPlayback();
      this.schedulePendingPcm(this.current);
      return;
    }
    if (!this.audio.src && this.queue.length) {
      this.playNext();
      return;
    }
    this.audio.play().catch(() => {
      this.blocked = true;
      this.render();
    });
  }

  playNext() {
    this.cancelPendingPlaybackStart();
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.audio.removeAttribute('src');
      this.audio.load();
      this.onPlaybackIdle?.();
      this.render();
      return;
    }
    this.current = next;
    this.onPlaybackWillStart?.(next);
    if (this.playbackStartDelayMs > 0) {
      this.playbackStartTimer = setTimeout(() => {
        this.playbackStartTimer = null;
        this.startCurrent(next);
      }, this.playbackStartDelayMs);
      this.render();
      return;
    }
    this.startCurrent(next);
  }

  startCurrent(next) {
    if (this.current !== next) return;
    if (next.kind === 'pcm') {
      this.schedulePendingPcm(next);
      this.finishPcmIfReady(next);
      this.render();
      return;
    }
    this.audio.src = next.url;
    this.audio.load();
    this.audio.play().catch(() => {
      this.blocked = true;
      this.render();
    });
    this.render();
  }

  render() {
    const hasAudio = this.hasAudio();
    const pcmBlocked = this.current?.kind === 'pcm' && this.blocked;
    const urlBlocked = this.current?.kind !== 'pcm' && this.blocked && this.audio.paused;
    this.resumeButton.hidden = !hasAudio || (!pcmBlocked && !urlBlocked);
    this.onStatus?.(this.statusText());
  }

  statusText() {
    if (this.blocked) return 'Audio ready';
    if (this.current?.kind === 'pcm') {
      if (!this.current.stream.playbackStarted) return 'Preparing audio';
      return this.queue.length ? `Playing audio, ${this.queue.length} queued` : 'Playing audio';
    }
    if (this.current && !this.audio.paused) return this.queue.length ? `Playing audio, ${this.queue.length} queued` : 'Playing audio';
    if (this.queue.length) return `${this.queue.length} audio clips queued`;
    return '';
  }

  ensurePcmContext() {
    if (!this.pcmContext) {
      this.pcmContext = this.audioContextFactory?.() || null;
      this.pcmContext?.addEventListener?.('statechange', () => {
        if (this.current?.kind !== 'pcm') return;
        this.blocked = this.pcmContext.state !== 'running';
        if (!this.blocked) this.schedulePendingPcm(this.current);
        else this.render();
      });
    }
    return this.pcmContext;
  }

  schedulePendingPcm(item) {
    if (this.current !== item || item.stream.playbackStopped || this.playbackStartTimer) return;
    const context = this.ensurePcmContext();
    if (!context) {
      this.abortPcmStream(item.artifactId, 'audio_context_unavailable');
      return;
    }
    if (context.state === 'closed') {
      this.abortPcmStream(item.artifactId, 'audio_context_closed');
      return;
    }
    if (context.state !== 'running') {
      this.blocked = true;
      this.render();
      return;
    }
    this.blocked = false;
    while (item.stream.pendingChunks.length) {
      const pcm = item.stream.pendingChunks[0];
      const frameCount = pcm.length / (item.stream.channelCount * 2);
      const buffer = context.createBuffer(
        item.stream.channelCount,
        frameCount,
        item.stream.sampleRateHz,
      );
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let channel = 0; channel < item.stream.channelCount; channel += 1) {
        const samples = buffer.getChannelData(channel);
        for (let frame = 0; frame < frameCount; frame += 1) {
          const offset = ((frame * item.stream.channelCount) + channel) * 2;
          samples[frame] = view.getInt16(offset, true) / 32768;
        }
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime + 0.03, item.stream.nextStartAt);
      item.stream.nextStartAt = startAt + buffer.duration;
      item.stream.activeSources.add(source);
      source.addEventListener('ended', () => {
        item.stream.activeSources.delete(source);
        this.finishPcmIfReady(item);
      }, { once: true });
      source.start(startAt);
      item.stream.pendingChunks.shift();
      if (!item.stream.playbackStarted) {
        item.stream.playbackStarted = true;
        this.onPlaybackStart?.(item);
      }
    }
    this.render();
  }

  finishPcmIfReady(item) {
    if (
      this.current !== item
      || item.stream.playbackStopped
      || !item.stream.completed
      || item.stream.pendingChunks.length
      || item.stream.activeSources.size
    ) return;
    const playbackWillComplete = this.queue.length === 0;
    this.pcmStreams.delete(item.artifactId);
    this.current = null;
    this.onItemEnded?.(item);
    this.playNext();
    if (playbackWillComplete) this.onPlaybackComplete?.(item);
  }

  stopPcmSources(item) {
    for (const source of [...item.stream.activeSources]) {
      try { source.stop(); } catch {}
    }
    item.stream.activeSources.clear();
  }

  clearPcmStreams() {
    for (const item of this.pcmStreams.values()) {
      item.stream.playbackStopped = true;
      this.stopPcmSources(item);
    }
    this.pcmStreams.clear();
  }

  cancelPendingPlaybackStart() {
    if (this.playbackStartTimer === null) return;
    clearTimeout(this.playbackStartTimer);
    this.playbackStartTimer = null;
  }
}

function defaultAudioContextFactory() {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  return AudioContextClass ? new AudioContextClass() : null;
}

function decodeBase64Bytes(value) {
  const binary = globalThis.atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
