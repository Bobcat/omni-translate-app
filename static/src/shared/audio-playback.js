export class AudioQueue {
  constructor({ audio, resumeButton, onStatus, onPlaybackStart, onPlaybackIdle, onPlaybackComplete, onItemEnded }) {
    this.audio = audio;
    this.resumeButton = resumeButton;
    this.onStatus = onStatus;
    this.onPlaybackStart = onPlaybackStart;
    this.onPlaybackIdle = onPlaybackIdle;
    this.onPlaybackComplete = onPlaybackComplete;
    this.onItemEnded = onItemEnded;
    this.queue = [];
    this.current = null;
    this.blocked = false;
    this.audio.addEventListener('ended', () => {
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
    this.resumeButton.addEventListener('click', () => {
      this.playOrResume();
    });
    this.render();
  }

  enqueue(item) {
    if (!item?.url) return;
    this.queue.push({
      ...item,
      url: String(item.url),
      durationMs: Number(item.duration_ms || 0),
    });
    if (!this.current) {
      this.playNext();
    } else {
      this.render();
    }
  }

  clear() {
    this.queue = [];
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.onPlaybackIdle?.();
    this.render();
  }

  stop() {
    const ended = this.current;
    this.queue = [];
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (ended) this.onItemEnded?.(ended);
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

  playOrResume() {
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
    this.resumeButton.hidden = !hasAudio || (!this.blocked && !this.audio.paused);
    this.onStatus?.(this.statusText());
  }

  statusText() {
    if (this.blocked) return 'Audio ready';
    if (this.current && !this.audio.paused) return this.queue.length ? `Playing audio, ${this.queue.length} queued` : 'Playing audio';
    if (this.queue.length) return `${this.queue.length} audio clips queued`;
    return '';
  }
}
