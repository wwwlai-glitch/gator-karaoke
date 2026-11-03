/* Native song audio for visualizers, including browsers without tab capture. */
'use strict';
class DirectAudio {
  constructor(audio, { playback, connected, disconnected, changed }) {
    Object.assign(this, { audio, playback, connected, disconnected, changed });
    this.available = false;
    this.active = false;
    this.requested = null;
    this.generation = 0;
    this.audio.addEventListener('error', () => {
      if (!this.active) return;
      const id = this.requested;
      this.error = '歌曲音訊無法播放，請重試或改用音訊檔。';
      this.release(true);
      this.requested = id;
    });
  }

  update(id, restore = false) {
    if (id === this.requested) return;
    this.release(restore);
    this.requested = id;
    this.error = '';
    if (id) return this.prepare(id);
  }

  async prepare(id) {
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130000);
    this.loading = true;
    this.changed();
    try {
      const response = await fetch(`api/media/prepare?${new URLSearchParams({ id })}`, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not prepare song audio.');
      if (generation !== this.generation) return;
      const url = new URL(data.url, location.href);
      if (url.origin !== location.origin || url.pathname !== new URL('api/media/audio', location.href).pathname) {
        throw new Error('Unexpected song audio address.');
      }
      this.audio.src = url.href;
      this.audio.load();
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          this.audio.removeEventListener('loadedmetadata', loaded);
          this.audio.removeEventListener('error', failed);
          controller.signal.removeEventListener('abort', failed);
        };
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error('Song audio could not load.')); };
        this.audio.addEventListener('loadedmetadata', loaded, { once: true });
        this.audio.addEventListener('error', failed, { once: true });
        controller.signal.addEventListener('abort', failed, { once: true });
        if (this.audio.readyState >= 1) loaded();
        else if (controller.signal.aborted) failed();
      });
      if (generation !== this.generation) return;
      const { at, playing } = this.playback();
      this.audio.currentTime = Math.min(Math.max(0, at), this.audio.duration || at);
      this.active = true;
      this.connected();
      if (playing) this.playVideo();
    } catch (error) {
      if (generation === this.generation) {
        this.error = error.message;
        if (this.active) { this.release(true); this.requested = id; }
      }
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.loading = false;
        this.changed();
      }
    }
  }

  release(restore = false) {
    ++this.generation;
    if (this.controller) this.controller.abort();
    const wasActive = this.active;
    const playback = wasActive ? { at: this.getCurrentTime(), playing: this.getPlayerState() === 1 } : null;
    if (wasActive || this.loading) this.audio.pause();
    this.active = this.loading = false;
    this.requested = null;
    if (wasActive) this.disconnected(playback, restore);
    this.changed();
  }

  retry() { const id = this.requested; this.requested = null; return this.update(id); }
  getCurrentTime() { return this.audio.currentTime || 0; }
  getDuration() { return Number.isFinite(this.audio.duration) ? this.audio.duration : 0; }
  getPlayerState() { return this.audio.ended ? 0 : this.audio.paused ? 2 : 1; }
  playVideo() { this.audio.play().catch(() => {}); }
  pauseVideo() { if (this.active) this.audio.pause(); }
  seekTo(at) { if (this.active) this.audio.currentTime = Math.max(0, at); }
}
