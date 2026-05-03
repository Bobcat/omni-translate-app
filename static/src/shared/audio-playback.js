export class AudioQueue {
  constructor({ audio, resumeButton, onStatus }) {
    this.audio = audio;
    this.resumeButton = resumeButton;
    this.onStatus = onStatus;
    this.queue = [];
    this.current = null;
    this.blocked = false;
    this.audio.addEventListener('ended', () => this.playNext());
    this.audio.addEventListener('play', () => {
      this.blocked = false;
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
    this.queue.push({ url: String(item.url), durationMs: Number(item.duration_ms || 0) });
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
    this.render();
  }

  hasAudio() {
    return Boolean(this.current || this.queue.length || this.audio.src);
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
    if (this.blocked) return 'Audio klaar';
    if (this.current && !this.audio.paused) return this.queue.length ? `Speelt audio, ${this.queue.length} in wachtrij` : 'Speelt audio';
    if (this.queue.length) return `${this.queue.length} audiofragmenten in wachtrij`;
    return '';
  }
}
