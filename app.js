/* Gator Karaoke Club — synced lyrics from LRCLIB (https://lrclib.net) */
'use strict';

const API = 'https://lrclib.net/api';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};

/* ======================================================================
   LRC parsing — handles plain LRC, multi-timestamp lines, [offset:],
   and "enhanced" LRC with <mm:ss.xx> word timings.
   ====================================================================== */
const TIME_TAG = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/;
function tagTime(tag) {
  const m = tag.trim().match(TIME_TAG);
  if (!m) return null;
  const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac;
}

function parseBody(body) {
  // Returns { text, chunks: [{text, t}], endTag } — chunks only when word-timed.
  const re = /<(\d+:\d{1,2}(?:[.:]\d{1,3})?)>/g;
  if (!re.test(body)) return { text: body.trim(), chunks: null, endTag: null };
  re.lastIndex = 0;
  const chunks = [];
  let last = 0, lastT = null, m;
  const lead = body.slice(0, body.search(re));
  re.lastIndex = 0;
  while ((m = re.exec(body))) {
    const seg = body.slice(last, m.index);
    if (lastT != null && seg) chunks.push({ text: seg, t: lastT });
    lastT = tagTime(m[1]);
    last = re.lastIndex;
  }
  const tail = body.slice(last);
  let endTag = null;
  if (tail.trim()) chunks.push({ text: tail, t: lastT });
  else endTag = lastT;
  if (lead.trim() && chunks.length) chunks[0].text = lead + chunks[0].text;
  const text = chunks.map((c) => c.text).join('').trim();
  return { text, chunks: chunks.length ? chunks : null, endTag };
}

const CJK_RANGE = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_CHAR = new RegExp(`[${CJK_RANGE}]`, 'u');
const CJK_ALL = new RegExp(`[${CJK_RANGE}]`, 'gu');
// One token per CJK character; other runs (Latin words, numbers) stay whole. Spaces ride along.
const CJK_TOKENS = new RegExp(`\\s*(?:[${CJK_RANGE}]|[^\\s${CJK_RANGE}]+)\\s*`, 'gu');

function parseLRC(src) {
  let offset = 0;
  const raw = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const tags = [];
    let rest = rawLine, m;
    while ((m = rest.match(/^\s*\[([^\]]*)\]/))) { tags.push(m[1]); rest = rest.slice(m[0].length); }
    for (const tag of tags) {
      const om = tag.match(/^offset:\s*([+-]?\d+)/i);
      if (om) { offset = parseInt(om[1], 10) / 1000; continue; }
      const t = tagTime(tag);
      if (t != null) raw.push({ start: t, body: rest });
    }
  }
  raw.sort((a, b) => a.start - b.start);

  const lines = raw.map((r) => {
    const p = parseBody(r.body);
    return { start: Math.max(0, r.start - offset), text: p.text, chunks: p.chunks, endTag: p.endTag != null ? p.endTag - offset : null };
  });

  // Assign word timings. Without word tags we estimate a natural "wipe" speed.
  lines.forEach((L, i) => {
    const next = lines[i + 1] ? lines[i + 1].start : L.start + 8;
    L.gap = !L.text;
    if (L.gap) { L.end = L.start; L.words = [{ text: '♪', start: L.start, end: L.start }]; return; }

    if (L.chunks) {
      const ws = L.chunks.map((c) => ({ text: c.text, start: Math.max(0, c.t - offset) }));
      const lastStart = ws[ws.length - 1].start;
      const fallbackEnd = Math.min(next - 0.05, lastStart + 0.25 + ws[ws.length - 1].text.length * 0.08);
      L.end = L.endTag != null ? Math.min(L.endTag, next) : fallbackEnd;
      ws.forEach((w, j) => { w.end = j < ws.length - 1 ? ws[j + 1].start : Math.max(L.end, w.start + 0.05); });
      ws[0].text = ws[0].text.replace(/^\s+/, '');
      L.words = ws;
      L.wordSync = true;
      return;
    }

    const chars = L.text.replace(/\s+/g, '').length;
    const span = next - L.start;
    let dur, parts, weights;
    if (CJK_CHAR.test(L.text)) {
      // Chinese, Japanese and Korean are sung roughly one character per beat, far slower
      // than English syllables, and a line usually fills most of the time until the next
      // one. So each character gets its own wipe, spread over nearly the whole gap.
      const cjk = (L.text.match(CJK_ALL) || []).length;
      const longest = 0.5 + cjk * 0.62 + (chars - cjk) * 0.12;
      dur = Math.max(0.3, Math.min(span - 0.25, longest));
      parts = L.text.match(CJK_TOKENS) || [L.text];
      weights = parts.map((w) => (CJK_CHAR.test(w) ? 1 : w.trim().length * 0.35 + 0.3));
    } else {
      const est = 0.4 + chars * 0.075;
      dur = span < est * 1.8 ? Math.max(0.3, span - 0.15) : est * 1.25;
      parts = L.text.split(/(?<=\s)(?=\S)/);
      weights = parts.map((w) => w.trim().length + 1);
    }
    L.end = L.start + dur;
    const total = weights.reduce((a, b) => a + b, 0);
    let t = L.start;
    L.words = parts.map((w, j) => {
      const d = dur * weights[j] / total;
      const word = { text: w, start: t, end: t + d };
      t += d;
      return word;
    });
  });

  // Drop consecutive gap markers and trailing gaps; they add nothing.
  return lines.filter((L, i) => !(L.gap && (i === lines.length - 1 || (lines[i - 1] && lines[i - 1].gap))));
}

/* ======================================================================
   Media sources: local audio file, YouTube embed, or a free-running clock
   for audio playing on another device.
   ====================================================================== */
const audio = $('#audio');
let yt = null, ytReadyPromise = null, ytPlayerReady = null, ytVideoId = null, ytBlockedId = null;
let ytMode = store.get('gkc.ytMode', 'bg');
if (ytMode === 'mini') ytMode = 'viz';
if (!['bg', 'viz', 'off'].includes(ytMode)) ytMode = 'bg';
// Instrumental mode: a second, hidden player supplies the audio and the clock,
// while the music video (if any) plays muted and follows it.
let ytInst = null, ytInstReady = null, instVideoId = null, instOn = false;
const embeddedAudioPlayer = () => (instOn && ytInst ? ytInst : yt);
const directAudio = new DirectAudio(audio, {
  playback: () => {
    const p = embeddedAudioPlayer();
    const id = p && p.getVideoData && p.getVideoData().video_id;
    const sameSong = !id || id === directAudio.requested;
    return { at: sameSong ? media.time() : 0, playing: sameSong && media.playing() };
  },
  connected: () => {
    [yt, ytInst].forEach((p) => p && p.mute && p.mute());
    if (ytInst && ytInst.pauseVideo) ytInst.pauseVideo();
    renderSource();
  },
  disconnected: (playback, restore) => {
    if (restore && media.kind === 'yt') {
      const p = embeddedAudioPlayer();
      if (p && p.seekTo) p.seekTo(playback.at, true);
      if (p && p.unMute) p.unMute();
      if (p && playback.playing && p.playVideo) p.playVideo();
      else if (p && p.pauseVideo) p.pauseVideo();
    }
    renderSource();
  },
  changed: () => stageVisualizer.sourceChanged(),
});
const audioPlayer = () => directAudio.active ? directAudio : embeddedAudioPlayer();
const ytClock = new Map();

// getCurrentTime() advances in coarse steps; interpolate between them while playing.
function playerTime(p) {
  if (!p || !p.getCurrentTime) return 0;
  const raw = p.getCurrentTime() || 0, now = performance.now();
  const last = ytClock.get(p);
  if (!last || raw !== last.raw) ytClock.set(p, { raw, at: now });
  const playing = p.getPlayerState && p.getPlayerState() === 1;
  return playing ? raw + Math.min(1, (now - ytClock.get(p).at) / 1000) : raw;
}

const media = {
  kind: 'clock',
  name: '舞台計時器',
  clock: { base: 0, startedAt: null },

  time() {
    if (this.kind === 'file') return audio.currentTime || 0;
    if (this.kind === 'yt') return playerTime(audioPlayer());
    const c = this.clock;
    return c.startedAt == null ? c.base : c.base + (performance.now() - c.startedAt) / 1000;
  },
  duration() {
    if (this.kind === 'file') return isFinite(audio.duration) ? audio.duration : 0;
    if (this.kind === 'yt') { const p = audioPlayer(); return (p && p.getDuration && p.getDuration()) || 0; }
    return state.track ? state.track.duration || 0 : 0;
  },
  playing() {
    if (this.kind === 'file') return !audio.paused && !audio.ended;
    if (this.kind === 'yt') { const p = audioPlayer(); return !!(p && p.getPlayerState && p.getPlayerState() === 1); }
    return this.clock.startedAt != null;
  },
  play() {
    if (this.kind === 'file') { if (audio.src) audio.play().catch(() => {}); return; }
    if (this.kind === 'yt') {
      const p = audioPlayer();
      if (p && p.playVideo) p.playVideo();
      if ((instOn || directAudio.active) && p !== yt && yt && ytVideoId && yt.playVideo) { yt.mute(); yt.playVideo(); }
      return;
    }
    if (this.clock.startedAt == null) this.clock.startedAt = performance.now();
  },
  pause() {
    if (this.kind === 'file') { audio.pause(); return; }
    if (this.kind === 'yt') { [yt, ytInst, directAudio].forEach((p) => p && p.pauseVideo && p.pauseVideo()); return; }
    if (this.clock.startedAt != null) { this.clock.base = this.time(); this.clock.startedAt = null; }
  },
  toggle() { this.playing() ? this.pause() : this.play(); },
  seek(t) {
    t = Math.max(0, t);
    if (this.kind === 'file') { if (audio.src) audio.currentTime = t; return; }
    if (this.kind === 'yt') {
      const p = audioPlayer();
      if (p && p.seekTo) p.seekTo(t, true);
      if ((instOn || directAudio.active) && p !== yt && yt && ytVideoId && yt.seekTo) yt.seekTo(t, true);
      ytClock.clear();
      return;
    }
    this.clock.base = t;
    if (this.clock.startedAt != null) this.clock.startedAt = performance.now();
  },
  use(kind, name) {
    if (this.kind !== kind) this.pause();
    if (kind !== 'yt') directAudio.release();
    this.kind = kind;
    this.name = name;
    $('#ytWrap').hidden = kind !== 'yt';
    renderSource();
    loadOffset();
    checkDuration();
    stageVisualizer.sourceChanged();
  },
  // True when the person brought their own audio (a file, a pasted link, or
  // another device); automatic video choices then must not replace it.
  own: false,
};

const stageVisualizer = new StageVisualizer({
  stage: $('#stage'), canvas: $('#vizCanvas'), audio,
  sourceKind: () => directAudio.active ? 'direct' : media.kind, playing: () => media.playing(), store, directAudio,
});

function renderSource() {
  let label = media.name;
  if (media.kind === 'yt' && instOn && mediaState.inst) {
    label = `伴奏 · ${mediaState.inst.title}${ytVideoId ? '（MV 靜音）' : ''}`;
  }
  if (directAudio.active) label += ' · direct audio';
  $('#sourceName').textContent = label;
}

// Keep a muted music video in step with the instrumental that is playing.
let lastFollow = 0;
function followVideo(now) {
  if (media.kind !== 'yt' || (!instOn && !directAudio.active) || !yt || !ytVideoId || ytBlockedId === ytVideoId || !yt.getPlayerState || now - lastFollow < 500) return;
  lastFollow = now;
  const p = audioPlayer();
  if (!p) return;
  const playing = p.getPlayerState() === 1;
  const vs = yt.getPlayerState();
  if (!yt.isMuted()) yt.mute();
  if (playing && vs !== 1 && vs !== 3 && vs !== 0) yt.playVideo();
  else if (!playing && vs === 1) yt.pauseVideo();
  const t = playerTime(p);
  const end = yt.getDuration ? yt.getDuration() : 0;
  if (playing && end && t < end - 1 && Math.abs((yt.getCurrentTime() || 0) - t) > 0.8) yt.seekTo(t, true);
}

/* ---------- local files ---------- */
let objectUrl = null;
async function loadFile(file) {
  if (!file) return;
  directAudio.release();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  stopInstrumental();
  media.own = true;
  media.use('file', file.name);
  selectTab('file');
  $('#ownAudio').open = true;

  const tags = await readId3(file).catch(() => null);
  let query;
  if (tags && tags.title) query = [tags.artist, tags.title].filter(Boolean).join(' ');
  else query = cleanTitle(file.name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/^\d{1,3}[\s.\-_]+/, '').replace(/_/g, ' '));

  const dur = await new Promise((res) => {
    if (isFinite(audio.duration) && audio.duration) return res(audio.duration);
    audio.addEventListener('loadedmetadata', () => res(audio.duration), { once: true });
    setTimeout(() => res(0), 4000);
  });
  autoFind(query, dur, tags);
}

// Minimal ID3v2.3/2.4 reader for title + artist.
async function readId3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;
  const ver = head[3];
  const size = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
  const buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 512 * 1024)).arrayBuffer());
  const out = {};
  let i = 0;
  if (head[5] & 0x40) { // extended header
    const ext = ver === 4 ? (buf[0] << 21) | (buf[1] << 14) | (buf[2] << 7) | buf[3] : ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) + 4;
    i = ext;
  }
  while (i + 10 < buf.length) {
    const id = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = ver === 4
      ? (buf[i + 4] << 21) | (buf[i + 5] << 14) | (buf[i + 6] << 7) | buf[i + 7]
      : (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
    const body = buf.subarray(i + 10, i + 10 + fsize);
    if (id === 'TIT2' || id === 'TPE1') {
      const enc = body[0];
      const label = enc === 0 ? 'latin1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
      const txt = new TextDecoder(label).decode(body.subarray(1)).replace(/\0+$/g, '').split('\0')[0].trim();
      out[id === 'TIT2' ? 'title' : 'artist'] = txt;
    }
    if (out.title && out.artist) break;
    i += 10 + fsize;
  }
  return out.title ? out : null;
}

/* ---------- YouTube ---------- */
function ytId(s) {
  s = s.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function loadYTApi() {
  if (ytReadyPromise) return ytReadyPromise;
  ytReadyPromise = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  });
  return ytReadyPromise;
}

let ytSearched = null;
let ytMetadataTimer = null, ytMetadataAttempts = 0;
let ytLookup = null;
// searchLyrics: true for a link the person pasted, whose title finds the lyrics.
async function loadYouTube(id, { searchLyrics = true } = {}) {
  if (id !== ytVideoId) directAudio.release();
  clearTimeout(ytMetadataTimer);
  ytMetadataAttempts = 0;
  ytVideoId = id;
  ytBlockedId = null;
  ytSearched = searchLyrics ? null : id;
  ytLookup = null;
  if (searchLyrics) { stopInstrumental(); selectTab('yt'); }
  media.use('yt', 'YouTube');
  applyYtMode();
  const YT = await loadYTApi();
  if (ytVideoId !== id || media.kind !== 'yt') return;
  const create = !yt;
  if (create) {
    ytPlayerReady = new Promise((resolve) => {
      yt = new YT.Player('ytPlayer', {
        videoId: id,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3 },
        events: {
          onReady: resolve,
          onStateChange: onYtState,
          onError: (e) => {
            ytBlockedId = ytVideoId;
            if (directAudio.available && ytMode === 'viz') {
              setWarn('這支 MV 無法播放，但仍可搭配視覺特效播放歌曲音訊。');
              return;
            }
            const blocked = e.data === 101 || e.data === 150;
            // An automatically chosen video falls through to the next candidate.
            if (!media.own && mediaState.video && mediaState.video.id === ytVideoId) { nextVideo(ytVideoId); return; }
            setWarn(blocked ? '這支影片不允許嵌入播放，請換一個版本（例如「Topic」官方音訊或歌詞影片）。' : 'YouTube 無法播放這支影片。');
          },
        },
      });
    });
  }
  await ytPlayerReady;
  if (ytVideoId !== id || media.kind !== 'yt') return;
  if (!create) yt.cueVideoById(id);
  if (instOn || directAudio.active) yt.mute(); else yt.unMute();
  onYtState();
}

function ensureInstPlayer() {
  ytInstReady = ytInstReady || loadYTApi().then((YT) => new Promise((resolve) => {
    const p = new YT.Player('ytInstPlayer', {
      width: 200, height: 113,
      playerVars: { playsinline: 1, rel: 0, controls: 0, iv_load_policy: 3 },
      events: {
        onReady: () => { ytInst = p; resolve(p); },
        onStateChange: () => checkDuration(),
        onError: () => { if (instVideoId && !(directAudio.available && ytMode === 'viz')) nextInstrumental(instVideoId); },
      },
    });
  }));
  return ytInstReady;
}

function youtubeIdentity(data) {
  const title = cleanTitle(data.title);
  const parts = title.split(/\s[-–—]\s/);
  // An ordinary uploader/channel name is not necessarily the recording artist.
  const channel = data.author || '';
  const artist = parts.length > 1 ? parts.shift()
    : /\s*-\s*Topic$|VEVO$/i.test(channel) ? channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim() : '';
  return { title: parts.length ? parts.join(' - ') : title, artist };
}

function onYtState() {
  clearTimeout(ytMetadataTimer);
  if (media.kind !== 'yt') return;
  if (yt && yt.getDuration) checkDuration();
  if (!yt || !yt.getVideoData) return;
  const data = yt.getVideoData() || {};
  const dur = yt.getDuration ? yt.getDuration() : 0;
  if (!data.title || (data.video_id && data.video_id !== ytVideoId)) {
    if (ytMetadataAttempts++ < 40) ytMetadataTimer = setTimeout(onYtState, 250);
    return;
  }
  media.name = `YouTube · ${data.title}`;
  renderSource();
  const identity = youtubeIdentity(data);
  if (ytSearched !== ytVideoId) {
    ytSearched = ytVideoId;
    const lookup = ytLookup = { id: ytVideoId, identity, track: null, timingArtist: identity.artist };
    // Render the original LRCLIB lyrics as soon as a title is available. Neither
    // video duration nor the extra word-timing request may gate this search.
    autoFind([identity.artist, identity.title].filter(Boolean).join(' '), dur, identity,
      () => media.kind === 'yt' && ytLookup === lookup && ytVideoId === lookup.id)
      .then((track) => {
        lookup.track = track;
        refineYouTubeTiming(lookup);
      });
  } else if (ytLookup) {
    ytLookup.identity = identity;
    refineYouTubeTiming(ytLookup);
  }
  if (!identity.artist && ytMetadataAttempts++ < 40) ytMetadataTimer = setTimeout(onYtState, 250);
}

function refineYouTubeTiming(lookup) {
  if (ytLookup !== lookup || media.kind !== 'yt' || lookup.id !== ytVideoId
    || !lookup.track || state.track !== lookup.track || !lookup.identity.artist
    || lookup.timingArtist === lookup.identity.artist) return;
  lookup.timingArtist = lookup.identity.artist;
  if (state.lines.some((L) => L.wordSync)) return;
  // Late artist metadata can repair an ambiguous title-only match without
  // loading the song again, resetting sync, or moving playback.
  startWordTiming(lookup.track, { ...lookup.track, trackName: lookup.identity.title, artistName: lookup.identity.artist });
}

function applyYtMode() {
  const wrap = $('#ytWrap');
  wrap.className = `yt-wrap ${ytMode === 'viz' ? 'off' : ytMode}`;
  $$('#ytMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === ytMode)));
  stageVisualizer.setEnabled(ytMode === 'viz');
}

// Two-line KTV layout: only the line being sung and the next one, over the full video.
let lyricMode = store.get('gkc.lyricMode', 'two');
if (!['two', 'scroll'].includes(lyricMode)) lyricMode = 'two';
function applyLyricMode() {
  $('#stage').classList.toggle('two-line', lyricMode === 'two');
  $$('#lyricMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === lyricMode)));
  state.focus = -2;
}

function cleanTitle(t) {
  return t
    .replace(/[([{【][^)\]}】]*(official|video|audio|lyric|lyrics|visuali[sz]er|hd|hq|4k|remaster(ed)?|mv|m\/v|live|explicit|clean)[^)\]}】]*[)\]}】]/gi, ' ')
    .replace(/\b(official (music )?video|official audio|lyric video|with lyrics|lyrics?)\b/gi, ' ')
    .replace(/\s(ft|feat)\.?\s.*$/i, ' ')
    .replace(/[|•].*$/, ' ')
    .replace(/["“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ======================================================================
   Lyrics search (LRCLIB)
   ====================================================================== */
const state = { track: null, lines: [], offset: 0, results: [], focus: -2, active: -2 };
let searchCtl = null;
let trackVersion = 0;

// Results from both sources share one shape. key is stable across sessions
// (LRCLIB ids keep their old form so saved sync offsets still apply).
function fromLrclib(r) {
  const word = !!r.syncedLyrics && /<\d+:\d+/.test(r.syncedLyrics);
  return {
    key: String(r.id), source: 'lrclib', id: r.id,
    trackName: r.trackName, artistName: r.artistName, albumName: r.albumName, duration: Number(r.duration) || 0,
    timing: word ? 'word' : r.syncedLyrics ? 'line' : 'plain', instrumental: !!r.instrumental,
    syncedLyrics: r.syncedLyrics, plainLyrics: r.plainLyrics,
  };
}
function fromWordRecord(r) {
  return {
    key: `wt:${r.id || r.lyricsUrl}`, source: 'wordtiming', id: r.id, isrc: r.isrc,
    trackName: r.track_name, artistName: r.artist_name, albumName: r.album_name, duration: Number(r.duration) || 0,
    timing: 'word', lyricsUrl: r.lyricsUrl,
  };
}

async function searchLrclib(q, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}`, { signal });
    if (res.ok) return res.json();
    // LRCLIB occasionally sheds load with 429/5xx; back off and retry a couple of times.
    if (attempt >= 2 || !(res.status === 429 || res.status >= 500)) throw new Error(`LRCLIB returned ${res.status}`);
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  }
}

// Word-timed results always come first, then line-timed, then untimed.
function mergeResults(lrclib, word) {
  const lrc = lrclib.map(fromLrclib);
  const by = (t) => lrc.filter((r) => r.timing === t);
  return [...word.map(fromWordRecord), ...by('word'), ...by('line'), ...by('plain')];
}

async function runSearch(q, { quiet = false } = {}) {
  const status = $('#searchStatus');
  q = q.trim();
  if (!q) return [];
  if (searchCtl) searchCtl.abort();
  const ctl = searchCtl = new AbortController();
  status.className = 'status';
  status.textContent = '搜尋中…';
  const [lrc, word] = await Promise.allSettled([
    searchLrclib(q, ctl.signal),
    WordTiming.search(q, { signal: ctl.signal }),
  ]);
  if (searchCtl !== ctl) return [];
  if (lrc.status === 'rejected' && word.status === 'rejected') {
    status.className = 'status err';
    status.textContent = `無法連上歌詞資料庫（${lrc.reason && lrc.reason.message}）。`;
    return [];
  }
  const list = mergeResults(lrc.status === 'fulfilled' ? lrc.value : [], word.status === 'fulfilled' ? word.value : []);
  state.results = list;
  state.searchNotes = { word: word.status === 'rejected', lrclib: lrc.status === 'rejected' };
  renderResults();
  if (!quiet) status.textContent = list.length ? '' : '找不到符合的歌。試試只輸入歌名，或輸入「歌手＋歌名」。';
  return list;
}

const RESULT_GROUPS = [
  { timing: 'word', cls: 'word', label: '逐字', sub: '每個字準時亮起' },
  { timing: 'line', cls: 'sync', label: '逐行', sub: '逐字變色為估算' },
  { timing: 'plain', cls: '', label: '無時間軸', sub: '僅顯示歌詞' },
];

function renderResults() {
  const box = $('#results');
  const onlySynced = $('#syncedOnly').checked;
  const list = state.results.filter((r) => !r.instrumental && (!onlySynced || r.timing !== 'plain'));
  const groups = RESULT_GROUPS.map((g) => {
    const items = list.filter((r) => r.timing === g.timing).slice(0, 25);
    if (!items.length) return null;
    const section = el('section', 'r-group');
    const head = el('h3', `r-group-head ${g.cls}`, g.label);
    head.append(el('span', '', g.sub));
    const ul = el('ul', 'r-list');
    ul.append(...items.map(resultItem));
    section.append(head, ul);
    return section;
  }).filter(Boolean);
  if (state.searchNotes && state.searchNotes.word && state.results.length) {
    groups.unshift(el('p', 'hint', '目前無法載入逐字歌詞，只顯示 LRCLIB 的結果。'));
  }
  if (state.searchNotes && state.searchNotes.lrclib && state.results.length) {
    groups.push(el('p', 'hint', 'LRCLIB 沒有回應，因此沒有逐行歌詞結果。'));
  }
  box.replaceChildren(...groups);
  if (state.results.length && !list.length) {
    $('#searchStatus').textContent = '只找到沒有時間軸的歌詞。取消勾選「只顯示同步歌詞」就能看歌詞。';
  }
}

function resultItem(r) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'result' + (state.track && state.track.key === r.key ? ' on' : '');
  const title = el('span', 'r-title', r.trackName);
  const meta = el('span', 'r-meta', [r.artistName, r.albumName].filter(Boolean).join(' · '));
  const side = el('span', 'r-side');
  const badge = r.timing === 'word' ? el('span', 'badge word', '逐字')
    : r.timing === 'line' ? el('span', 'badge sync', '逐行') : el('span', 'badge plain', '純文字');
  side.append(badge, el('span', '', fmt(r.duration)));
  b.append(title, side, meta);
  b.addEventListener('click', () => loadTrack(r));
  li.append(b);
  return li;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Search, then auto-load the synced result whose length best matches the audio.
async function autoFind(q, duration, tags, isCurrent = () => true) {
  const version = trackVersion;
  const current = () => isCurrent() && trackVersion === version;
  $('#q').value = q;
  let list = await runSearch(q, { quiet: true });
  if (!current()) return;
  if (!list.length && tags && tags.title) { $('#q').value = tags.title; list = await runSearch(tags.title, { quiet: true }); }
  if (!current()) return;
  const synced = list.filter((r) => (r.timing ? r.timing !== 'plain' : r.syncedLyrics) && !r.instrumental);
  const status = $('#searchStatus');
  if (!synced.length) {
    status.textContent = list.length ? '找到這首歌，但沒有同步歌詞。可以從下方選一個版本看歌詞。' : '沒有自動配對到歌詞，請在上方自行搜尋。';
    return;
  }
  const scored = synced.map((r, i) => ({ r, score: (duration ? Math.abs(r.duration - duration) : 0) + (r.timing === 'word' ? 0 : 2) + i * 0.4 }));
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0];
  const diff = duration ? Math.abs(best.r.duration - duration) : 0;
  if (!duration || diff <= 8) {
    const identity = tags && tags.title && tags.artist
      ? { trackName: tags.title, artistName: tags.artist }
      : null;
    loadTrack(best.r, identity, { auto: true });
    status.textContent = `已自動配對「${best.r.trackName}」。不對的話，可以從下方換一個。`;
    return best.r;
  } else {
    status.textContent = '沒有長度接近你的音訊的結果，請從下方選一個最接近的。';
  }
}

/* ======================================================================
   Stage rendering
   ====================================================================== */
const lyricsEl = $('#lyrics');
const viewport = $('#viewport');
const countdown = $('#countdown');
let wordTimingCtl = null;

// opts.auto: chosen automatically for the person's own audio, so their source stays.
function loadTrack(r, identity = null, { auto = false, prefer = null } = {}) {
  trackVersion++;
  const version = trackVersion;
  if (wordTimingCtl) wordTimingCtl.abort();
  wordTimingCtl = null;
  state.track = r;
  state.lines = r.syncedLyrics ? parseLRC(r.syncedLyrics) : [];
  state.active = state.focus = -2;
  $('#trackTitle').textContent = r.trackName;
  $('#trackArtist').textContent = [r.artistName, r.albumName].filter(Boolean).join(' · ');
  $('#welcome').hidden = true;
  const plain = $('#plain');
  const pending = r.source === 'wordtiming';
  plain.hidden = !!state.lines.length;
  plain.textContent = state.lines.length ? '' : pending ? '歌詞載入中…' : (r.plainLyrics || '這首歌沒有歌詞文字。');
  renderLines();
  loadOffset();
  renderResults();
  checkDuration();
  document.title = `${r.trackName} · 鱷魚 KTV`;
  const vocals = state.lines.filter((L) => !L.gap);
  if (pending) {
    loadWordTimedTrack(r, version);
  } else if (vocals.length && vocals.every((L) => L.wordSync)) {
    setTimingStatus('目前使用：LRCLIB 逐字時間軸', '', null, 'word');
  } else if (auto) {
    // Matched automatically, so look for word timings of the same recording.
    startWordTiming(r, identity ? { ...r, ...identity } : r);
  } else {
    setTimingStatus(vocals.length ? '目前使用：LRCLIB 逐行時間軸 · 逐字變色為估算' : '目前使用：這首歌沒有時間軸 · 僅顯示歌詞');
  }
  findMediaFor(r, { place: !auto && !(media.own && media.kind === 'clock'), prefer });
}

async function loadWordTimedTrack(track, version) {
  const ctl = wordTimingCtl = new AbortController();
  const retry = () => { if (state.track === track) loadWordTimedTrack(track, trackVersion); };
  setTimingStatus('逐字時間軸載入中…', '', null, 'word');
  try {
    const result = await WordTiming.load(track, { signal: ctl.signal });
    if (version !== trackVersion || wordTimingCtl !== ctl) return;
    showLines(result.lines);
    setTimingStatus('目前使用：逐字時間軸，來源 ', result.source, null, 'word');
  } catch (e) {
    if (ctl.signal.aborted || version !== trackVersion) return;
    // Fall back to LRCLIB's line timing for the same recording.
    const params = new URLSearchParams({ track_name: track.trackName, artist_name: track.artistName, duration: String(Math.round(track.duration || 0)) });
    if (track.albumName) params.set('album_name', track.albumName);
    const fallback = await fetch(`${API}/get?${params}`, { signal: ctl.signal }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    if (ctl.signal.aborted || version !== trackVersion) return;
    if (fallback && fallback.syncedLyrics) {
      showLines(parseLRC(fallback.syncedLyrics));
      setTimingStatus('逐字時間軸沒有載入成功，改用 LRCLIB 逐行時間軸', '', retry);
    } else {
      $('#plain').hidden = false;
      $('#plain').textContent = (fallback && fallback.plainLyrics) || '無法載入這份歌詞。';
      setTimingStatus('無法載入這首歌的逐字時間軸', '', retry);
    }
  }
}

function showLines(lines) {
  state.lines = lines;
  state.active = state.focus = -2;
  $('#plain').hidden = !!lines.length;
  renderLines();
}

function setTimingStatus(message, source = '', retry = null, tone = '') {
  const status = $('#timingStatus');
  status.hidden = false;
  status.className = `timing-source${tone ? ` ${tone}` : ''}`;
  status.textContent = message;
  if (source) {
    const a = el('a', '', source);
    a.href = source === 'lrc.red' ? 'https://lrc.red/' : 'https://lyrics.binimum.org/';
    a.target = '_blank';
    a.rel = 'noopener';
    status.append(a);
  }
  if (retry) {
    const button = el('button', 'timing-retry', '重新載入逐字時間軸');
    button.type = 'button';
    button.addEventListener('click', retry);
    status.append(document.createTextNode(' · '), button);
  }
}

function startWordTiming(track, identity) {
  if (state.track !== track || track.source === 'wordtiming') return;
  if (wordTimingCtl) wordTimingCtl.abort();
  const ctl = wordTimingCtl = new AbortController();
  setTimingStatus(state.lines.length ? '目前使用：逐行時間軸 · 正在尋找逐字時間軸…' : '沒有時間軸歌詞');
  upgradeWordTiming(track, ctl, identity);
}

async function upgradeWordTiming(track, ctl, identity) {
  const timeout = setTimeout(() => ctl.abort(), 22000);
  const fallback = () => state.lines.length ? '目前使用：逐行時間軸 · 逐字變色為估算' : '沒有時間軸歌詞';
  const retry = () => startWordTiming(track, identity);
  try {
    const result = await WordTiming.lookup(identity, { signal: ctl.signal });
    if (wordTimingCtl !== ctl || state.track !== track) return;
    if (!result) {
      setTimingStatus(fallback() + ' · 這個版本沒有逐字時間軸', '', retry);
      return;
    }
    showLines(result.lines);
    setTimingStatus('目前使用：逐字時間軸，來源 ', result.source, null, 'word');
  } catch {
    if (wordTimingCtl === ctl && state.track === track) setTimingStatus(fallback() + ' · 逐字時間軸服務暫時無法使用', '', retry);
  } finally {
    clearTimeout(timeout);
  }
}

function renderLines() {
  const frag = document.createDocumentFragment();
  state.lines.forEach((L, i) => {
    const d = el('div', 'line' + (L.gap ? ' gap' : ''));
    L.el = d;
    L.wordEls = L.words.map((w) => {
      // Spaces separate the glyphs but must not consume their highlight time.
      const [, before, text, after] = w.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const s = el('span', 'w', text);
      d.append(document.createTextNode(before), s, document.createTextNode(after));
      return s;
    });
    L.lastP = null;
    d.addEventListener('click', () => {
      media.seek(L.start - state.offset - 0.6);
      if (!media.playing()) media.play();
    });
    frag.append(d);
  });
  lyricsEl.replaceChildren(frag);
  lyricsEl.style.transform = 'translateY(0)';
  countdown.hidden = true;
}

function findActive(t) {
  const L = state.lines;
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function centerOn(idx) {
  const L = state.lines[idx] || state.lines[0];
  if (!L) return;
  if (lyricMode === 'two') { lyricsEl.style.transform = 'translateY(0)'; return 0; }
  const y = viewport.clientHeight * 0.45 - (L.el.offsetTop + L.el.offsetHeight / 2);
  lyricsEl.style.transform = `translateY(${y}px)`;
  return y;
}

function frame() {
  directAudio.update(ytMode === 'viz' && media.kind === 'yt' && directAudio.available
    ? (instOn ? instVideoId : ytVideoId) : null, ytMode !== 'viz' && media.kind === 'yt');
  const mt = media.time();
  const t = mt + state.offset;
  const lines = state.lines;

  if (lines.length) {
    const a = findActive(t);
    const cur = lines[a];
    const next = lines[a + 1];
    // In a long instrumental stretch, focus the upcoming line so singers can read ahead.
    const inGap = !cur || cur.gap || (next && t > cur.end + 1.2 && next.start - cur.end > 3.5);
    const focus = inGap && next ? a + 1 : Math.max(a, 0);

    if (a !== state.active || focus !== state.focus) {
      const prevActive = state.active;
      state.active = a; state.focus = focus;
      lines.forEach((L, i) => {
        L.el.classList.toggle('sung', i < a || (i === a && !inGap));
        L.el.classList.toggle('focus', i === focus);
        L.el.classList.toggle('near', Math.abs(i - focus) === 1);
        L.el.classList.toggle('next', i === focus + 1);
      });
      if (prevActive >= 0 && lines[prevActive] && prevActive !== a) clearWords(lines[prevActive]);
      centerOn(focus);
    }

    if (cur && !cur.gap && t <= cur.end + 0.1) {
      cur.el.classList.remove('sung');
      cur.wordEls.forEach((s, j) => {
        const w = cur.words[j];
        const p = w.end <= w.start ? (t >= w.start ? 1 : 0) : Math.min(1, Math.max(0, (t - w.start) / (w.end - w.start)));
        const v = p.toFixed(3);
        if (s._p !== v) { s.style.setProperty('--p', v); s._p = v; }
      });
    } else if (cur && !cur.gap && !cur.el.classList.contains('sung')) {
      clearWords(cur);
      cur.el.classList.add('sung');
    }

    // Countdown dots before a line that follows silence.
    const up = lines[focus];
    const gapStart = a < 0 ? 0 : (cur.gap ? cur.start : cur.end);
    const remaining = up ? up.start - t : 0;
    if (up && !up.gap && focus > a && up.start - gapStart >= 3.5 && remaining > 0 && remaining <= 4) {
      countdown.hidden = false;
      countdown.style.top = `${up.el.offsetTop + lyricsEl.offsetTop + lyricsY() - 30}px`;
      const lit = Math.ceil(remaining - 1);
      [...countdown.children].forEach((d, i) => d.classList.toggle('out', i >= lit));
    } else countdown.hidden = true;
  }

  // Transport
  const dur = media.duration() || (state.track && state.track.duration) || 0;
  const seek = $('#seek');
  if (!seek.matches(':active')) { seek.max = dur || 100; seek.value = Math.min(mt, dur || 100); }
  $('#curTime').textContent = fmt(mt);
  $('#durTime').textContent = fmt(dur);
  $('#playBtn').classList.toggle('on', media.playing());
  followVideo(performance.now());

  requestAnimationFrame(frame);
}

function lyricsY() {
  const m = lyricsEl.style.transform.match(/translateY\((-?[\d.]+)px\)/);
  return m ? parseFloat(m[1]) : 0;
}

function clearWords(L) {
  L.wordEls.forEach((s) => { s.style.removeProperty('--p'); s._p = null; });
}

/* ---------- sync controls ---------- */
function setOffset(v) {
  state.offset = Math.round(v * 100) / 100;
  const key = offsetKey();
  if (key) store.set(key, state.offset);
  state.active = state.focus = -2;
  state.lines.forEach(clearWords);
  renderOffset();
}
function renderOffset() {
  const o = state.offset;
  $('#offVal').textContent = Math.abs(o) < 0.05 ? '±0.0s' : `${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(1)}s`;
  $('#offVal').title = o > 0 ? '歌詞提早顯示' : o < 0 ? '歌詞延後顯示' : '未調整時間';
}
function tapSync() {
  if (!state.lines.length) return;
  // The line in focus (or the next one, if focus is already being sung) starts *now*.
  const mt = media.time();
  const t = mt + state.offset;
  let target = state.lines[state.focus];
  if (!target || (state.focus === state.active && t - target.start > 0.4)) target = state.lines[state.active + 1];
  while (target && target.gap) target = state.lines[state.lines.indexOf(target) + 1];
  if (!target) return;
  setOffset(target.start - mt);
  const b = $('#tapBtn');
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 200);
}

function setWarn(msg) {
  const w = $('#warn');
  w.hidden = !msg;
  w.textContent = msg || '';
}
function checkDuration() {
  const d = media.kind === 'clock' ? 0 : media.duration();
  if (!state.track || !d) { setWarn(''); return; }
  const diff = state.track.duration - d;
  if (Math.abs(diff) > 4) {
    setWarn(`注意：這份歌詞比音訊${diff > 0 ? '長' : '短'} ${Math.round(Math.abs(diff))} 秒，可能是不同版本。可以換一個結果，或用「對拍」修正。`);
  } else setWarn('');
}

/* ======================================================================
   Video & backing track — found automatically for the chosen lyrics
   ====================================================================== */
const mediaState = { track: null, videos: [], instrumentals: [], video: null, inst: null, ctl: null, failed: new Set(), searching: false, error: '', showAll: false, showAllInst: false };
MediaFinder.localHelper().then((connected) => {
  const label = $('#helperStatus');
  label.hidden = false;
  label.textContent = connected ? '已連接 YouTube 直接搜尋 · 不需要 API 金鑰。'
    : '如果自動搜尋失效，可以到 YouTube 找影片，再把連結貼到下方。';
});
MediaFinder.localAudio().then((available) => {
  directAudio.available = available;
  stageVisualizer.sourceChanged();
});
// On by default: this is a karaoke night, so sing over the backing track unless someone turns it off.
let instPref = store.get('gkc.backing', true);

function setMediaStatus(msg, err = false) {
  const status = $('#mediaStatus');
  status.className = `status${err ? ' err' : ''}`;
  status.textContent = msg;
}

function renderMediaFallback(track, show) {
  const panel = $('#mediaFallback');
  panel.hidden = !show && !panel.dataset.engaged;
  $('#youtubeSearch').href = MediaFinder.youtubeSearchURL(track);
  $('#youtubeInstrumentalSearch').href = MediaFinder.youtubeSearchURL(track, true);
  $('#manualVideoHint').textContent = track.duration
    ? `選擇長度接近 ${fmt(track.duration)} 的版本，歌詞會比較準。` : '';
}

// place: cue the best video automatically (false when the person's own audio should stay).
async function findMediaFor(track, { place = true, prefer = null } = {}) {
  if (mediaState.ctl) mediaState.ctl.abort();
  const ctl = new AbortController();
  stopInstrumental();
  Object.assign(mediaState, { track, videos: [], instrumentals: [], video: null, inst: null, ctl, failed: new Set(), searching: true, showAll: false, showAllInst: false });
  delete $('#mediaFallback').dataset.engaged;
  $('#manualVideoUrl').value = '';
  $('#manualVideoStatus').textContent = '';
  $('#manualInstrumental').checked = false;
  // Give hosted users a usable path while public mirrors are still responding.
  renderMediaFallback(track, true);
  setMediaStatus('正在尋找 MV 和伴奏…');
  renderMedia();
  let found;
  try {
    found = await MediaFinder.find(track, { signal: ctl.signal });
  } catch {
    if (ctl.signal.aborted || mediaState.ctl !== ctl) return;
    found = { videos: [], instrumentals: [], errors: { search: true } };
  }
  if (mediaState.ctl !== ctl || state.track !== track) return;
  mediaState.searching = false;
  const saved = (id, kind) => ({ id, title: '隨排隊清單儲存', author: '', length: 0, kind, diff: null });
  if (prefer && prefer.yt && !found.videos.some((v) => v.id === prefer.yt)) found.videos.unshift(saved(prefer.yt, '已存的影片'));
  if (prefer && prefer.inst && !found.instrumentals.some((v) => v.id === prefer.inst)) found.instrumentals.unshift(saved(prefer.inst, '已存的伴奏'));
  mediaState.videos = found.videos;
  mediaState.instrumentals = found.instrumentals;
  mediaState.inst = (prefer && prefer.inst && found.instrumentals.find((v) => v.id === prefer.inst)) || found.instrumentals[0] || null;

  const searchDown = found.errors && found.errors.search;
  renderMediaFallback(track, !!searchDown || !found.videos.length || !found.instrumentals.length);
  if (!found.videos.length) {
    setMediaStatus(searchDown ? '自動搜尋影片暫時無法使用，請貼上 YouTube 連結，或使用下方的音訊檔。' : '找不到符合的影片，請使用下方的自己的音訊。', !!searchDown);
  } else if (place) {
    const pick = (prefer && prefer.yt && found.videos.find((v) => v.id === prefer.yt)) || found.videos[0];
    chooseVideo(pick);
    const fit = pick.diff != null && pick.diff <= 2 ? '，長度與歌詞相符' : '';
    setMediaStatus(`已準備好${kindLabel(pick.kind)}${fit}。準備好就按播放。`);
  } else {
    setMediaStatus('正在播放你自己的音訊。點選下方影片可以切換。');
  }
  if (mediaState.inst && (prefer ? prefer.instOn : instPref) && (place || media.kind === 'yt')) setInstrumental(true);
  renderMedia();
}

function chooseVideo(v) {
  mediaState.video = v;
  media.own = false;
  loadYouTube(v.id, { searchLyrics: false });
  renderMedia();
}

function nextVideo(failedId) {
  mediaState.failed.add(failedId);
  const next = mediaState.videos.find((v) => !mediaState.failed.has(v.id));
  if (next) {
    setMediaStatus('這支影片無法在這裡播放，已改用下一個符合的影片。');
    chooseVideo(next);
  } else {
    setMediaStatus('找到的影片都無法在這裡播放，請使用下方的自己的音訊。', true);
    if (mediaState.track) renderMediaFallback(mediaState.track, true);
    renderMedia();
  }
}

function stopInstrumental() {
  if (!instOn) return;
  directAudio.release();
  instOn = false;
  if (ytInst && ytInst.pauseVideo) ytInst.pauseVideo();
  if (yt && yt.unMute) yt.unMute();
  renderSource();
  loadOffset();
  renderMedia();
}

async function setInstrumental(on) {
  if (!on) { stopInstrumental(); checkDuration(); return; }
  const pick = mediaState.inst;
  if (!pick) return;
  const wasPlaying = media.playing();
  const at = media.time();
  media.pause();
  directAudio.release();
  instOn = true;
  renderMedia();
  const p = await ensureInstPlayer();
  if (!instOn || mediaState.inst !== pick) return;
  if (instVideoId !== pick.id) { instVideoId = pick.id; p.cueVideoById(pick.id); }
  if (media.kind !== 'yt') { media.own = false; media.use('yt', 'YouTube'); }
  if (yt && ytVideoId && yt.mute) yt.mute();
  ytClock.clear();
  renderSource();
  loadOffset();
  checkDuration();
  if (wasPlaying) { media.seek(at); media.play(); }
}

function chooseInstrumental(v) {
  mediaState.inst = v;
  instVideoId = null;
  if (instOn) { instOn = false; setInstrumental(true); } else setInstrumental(true);
  renderMedia();
}

function nextInstrumental(failedId) {
  mediaState.failed.add(failedId);
  const next = mediaState.instrumentals.find((v) => !mediaState.failed.has(v.id));
  if (next) chooseInstrumental(next);
  else { stopInstrumental(); setMediaStatus('找到的伴奏都無法在這裡播放。', true); }
}

const KIND_LABELS = { 'Music video': 'MV', 'Official audio': '官方音訊', 'Lyric video': '歌詞影片', 'Audio': '音訊',
  'Video': '影片', 'Karaoke track': 'KTV 伴唱', 'Instrumental': '伴奏' };
function kindLabel(kind) { return KIND_LABELS[kind] || kind || ''; }

function mediaItem(v, on, onClick) {
  const li = document.createElement('li');
  const b = el('button', `media${on ? ' on' : ''}`);
  b.type = 'button';
  const img = el('img');
  img.src = `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
  img.alt = '';
  img.loading = 'lazy';
  const text = el('span', 'm-text');
  const meta = el('span', 'm-meta', [kindLabel(v.kind), v.author, v.length ? fmt(v.length) : ''].filter(Boolean).join(' · '));
  const D = mediaState.track && mediaState.track.duration;
  if (v.length && D) {
    const d = Math.round(v.length - D);
    meta.append(document.createTextNode(' · '),
      Math.abs(d) <= 2 ? el('span', 'fit', '與歌詞相符') : el('span', 'off', `${d > 0 ? '長' : '短'} ${Math.abs(d)} 秒`));
  }
  text.append(el('span', 'm-title', v.title), meta);
  b.append(img, text);
  b.addEventListener('click', onClick);
  li.append(b);
  return li;
}

function renderMedia() {
  const { videos, instrumentals } = mediaState;
  const current = media.kind === 'yt' ? ytVideoId : null;
  let shown = mediaState.showAll ? videos : videos.slice(0, 3);
  const playing = videos.find((v) => v.id === current);
  if (playing && !shown.includes(playing)) shown = [...shown, playing];
  const items = shown.map((v) => mediaItem(v, v.id === current, () => { setMediaStatus(''); chooseVideo(v); }));
  if (videos.length > shown.length) {
    const li = document.createElement('li');
    const more = el('button', 'media-more', `再顯示 ${videos.length - shown.length} 個`);
    more.type = 'button';
    more.addEventListener('click', () => { mediaState.showAll = true; renderMedia(); });
    li.append(more);
    items.push(li);
  }
  $('#videoList').replaceChildren(...items);

  const toggle = $('#instToggle');
  toggle.disabled = !instrumentals.length;
  toggle.checked = instOn;
  $('#instCount').textContent = mediaState.searching ? '' : instrumentals.length ? `找到 ${instrumentals.length} 個` : mediaState.track ? '沒有找到' : '';
  const list = $('#instList');
  list.hidden = !instOn || !instrumentals.length;
  const instShown = mediaState.showAllInst ? instrumentals : instrumentals.filter((v) => v === mediaState.inst);
  const instItems = instShown.map((v) => mediaItem(v, mediaState.inst === v, () => chooseInstrumental(v)));
  if (instrumentals.length > instShown.length) {
    const li = document.createElement('li');
    const more = el('button', 'media-more', `顯示其他 ${instrumentals.length - instShown.length} 個伴奏`);
    more.type = 'button';
    more.addEventListener('click', () => { mediaState.showAllInst = true; renderMedia(); });
    li.append(more);
    instItems.push(li);
  }
  list.replaceChildren(...instItems);
}

/* ---------- sync offsets, remembered per song and per audio source ---------- */
function offsetKey() {
  if (!state.track) return null;
  const src = media.kind === 'yt' ? (instOn ? instVideoId : ytVideoId) : null;
  return `gkc.off.${state.track.key}${src ? `@${src}` : ''}`;
}
function loadOffset() {
  const key = offsetKey();
  state.offset = key ? store.get(key, 0) : 0;
  state.active = state.focus = -2;
  if (state.lines) state.lines.forEach((L) => L.wordEls && clearWords(L));
  renderOffset();
}

/* ======================================================================
   Singer queue
   ====================================================================== */
let queue = store.get('gkc.queue', []);
function renderQueue() {
  const ol = $('#queue');
  ol.replaceChildren(...queue.map((q, i) => {
    const li = document.createElement('li');
    const mid = el('div');
    const extra = (q.instOn ? ' · 伴奏' : q.yt ? ' · MV' : '') + (q.fromPhone ? ' · 手機點歌' : '');
    mid.append(el('div', 'q-name', q.singer), el('div', 'q-song', `${q.track} · ${q.artist}${extra}`));
    const x = el('button', 'q-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `移除 ${q.singer}`);
    x.addEventListener('click', () => { queue.splice(i, 1); saveQueue(); });
    li.append(mid, x);
    return li;
  }));
  if (!queue.length) ol.replaceChildren(el('p', 'queue-empty', '還沒有人排隊。先選一首歌，輸入名字，再按「加入」。'));
  $('#nextUp').disabled = !queue.length;
}
let nowPlaying = null;
function saveQueue() {
  store.set('gkc.queue', queue);
  renderQueue();
  if (typeof PartyHost !== 'undefined') PartyHost.broadcast(PartyHost.snapshot(queue, nowPlaying));
}

// LRCLIB sometimes sheds load for a moment; a queued song should not be lost to that.
async function fetchLrclibById(id) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}/get/${id}`);
      if (res.ok) return res.json();
      if (attempt >= 3 || !(res.status === 429 || res.status >= 500)) throw new Error(`LRCLIB returned ${res.status}`);
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function nextSinger() {
  const q = queue.shift();
  saveQueue();
  if (!q) return;
  $('#nowWrap').hidden = false;
  $('#nowSinger').textContent = q.singer;
  nowPlaying = { singer: q.singer, track: q.track };
  if (typeof PartyHost !== 'undefined') PartyHost.broadcast(PartyHost.snapshot(queue, nowPlaying));
  const prefer = { yt: q.yt || null, inst: q.inst || null, instOn: !!q.instOn };
  try {
    let track = q.song;
    // LRCLIB lyrics are fetched again rather than kept in storage.
    if (!track || track.source === 'lrclib') {
      track = fromLrclib(await fetchLrclibById(track ? track.id : q.trackId));
    }
    media.own = false;
    loadTrack(track, null, { prefer });
    media.seek(0);
  } catch {
    setWarn('無法取得這首排隊歌曲的歌詞。');
  }
}

/* ======================================================================
   Wiring
   ====================================================================== */
function selectTab(name) {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('.tabpanel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
$$('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

$('#fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });
// Let a file be dropped anywhere on the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f && !drop.contains(e.target)) loadFile(f);
});
audio.addEventListener('loadedmetadata', checkDuration);

$('#ytForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = ytId($('#ytUrl').value);
  if (!id) { setWarn('這看起來不是 YouTube 連結。'); return; }
  media.own = true;
  mediaState.video = null;
  loadYouTube(id);
  renderMedia();
});
$('#mediaFallback').addEventListener('focusin', () => { $('#mediaFallback').dataset.engaged = 'true'; });
$('#youtubeSearch').addEventListener('click', () => {
  $('#mediaFallback').dataset.engaged = 'true';
  $('#manualInstrumental').checked = false;
});
$('#youtubeInstrumentalSearch').addEventListener('click', () => {
  $('#mediaFallback').dataset.engaged = 'true';
  $('#manualInstrumental').checked = true;
});
$('#manualVideoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('#manualVideoStatus');
  const id = ytId($('#manualVideoUrl').value);
  if (!id) {
    status.className = 'status err';
    status.textContent = '請貼上有效的 YouTube 影片連結。';
    return;
  }
  const track = mediaState.track;
  if (!track) return;
  if (mediaState.ctl) mediaState.ctl.abort();
  mediaState.ctl = null;
  mediaState.searching = false;
  const instrumental = $('#manualInstrumental').checked;
  const pick = { id, title: `${track.artistName} – ${track.trackName}`, author: '貼上的 YouTube 連結', length: 0,
    kind: instrumental ? 'Instrumental' : 'Video', diff: null };
  status.className = 'status';
  status.textContent = '正在載入你的 YouTube 連結…';
  try {
    if (instrumental) {
      if (!mediaState.instrumentals.some((v) => v.id === id)) mediaState.instrumentals.push(pick);
      mediaState.inst = pick;
      instPref = true;
      store.set('gkc.backing', true);
      await setInstrumental(true);
    } else {
      stopInstrumental();
      if (!mediaState.videos.some((v) => v.id === id)) mediaState.videos.unshift(pick);
      mediaState.video = pick;
      media.own = true;
      await loadYouTube(id, { searchLyrics: false });
    }
    if (mediaState.track !== track) return;
    media.own = true;
    status.textContent = '連結已載入，準備好就按播放。';
    setMediaStatus('正在用你的 YouTube 連結搭配選好的歌詞。');
  } catch (error) {
    console.error('Could not load the pasted YouTube link', error);
    status.className = 'status err';
    status.textContent = 'YouTube 無法載入這個連結，請換一支影片或改用音訊檔。';
  }
  renderMedia();
});
$('#instToggle').addEventListener('change', (e) => {
  instPref = e.target.checked;
  store.set('gkc.backing', instPref);
  setInstrumental(instPref);
});
$$('#ytMode button').forEach((b) => b.addEventListener('click', () => { ytMode = b.dataset.mode; store.set('gkc.ytMode', ytMode); applyYtMode(); }));
applyYtMode();

$('#useClock').addEventListener('click', () => {
  stopInstrumental();
  media.own = true;
  media.use('clock', '舞台計時器');
  media.seek(0);
  renderMedia();
});

let debounce;
$('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(debounce); runSearch($('#q').value); });
$('#q').addEventListener('input', () => {
  clearTimeout(debounce);
  const v = $('#q').value;
  if (v.trim().length >= 3) debounce = setTimeout(() => runSearch(v), 450);
});
$('#syncedOnly').addEventListener('change', renderResults);

$('#queueForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const singer = $('#singer').value.trim();
  if (!singer) { $('#singer').focus(); return; }
  if (!state.track) { setWarn('請先載入一首歌，再加入排隊。'); return; }
  const { syncedLyrics, plainLyrics, ...song } = state.track;
  const item = {
    singer, song, trackId: state.track.id, track: state.track.trackName, artist: state.track.artistName,
    yt: media.kind === 'yt' ? ytVideoId : null, inst: mediaState.inst ? mediaState.inst.id : null, instOn,
  };
  queue.push(item);
  recordRequest(item);
  $('#singer').value = '';
  saveQueue();
});
$('#nextUp').addEventListener('click', nextSinger);
renderQueue();

$('#playBtn').addEventListener('click', () => media.toggle());
$('#seek').addEventListener('input', (e) => media.seek(parseFloat(e.target.value)));
$('#offMinus').addEventListener('click', () => setOffset(state.offset - 0.1));
$('#offPlus').addEventListener('click', () => setOffset(state.offset + 0.1));
$('#tapBtn').addEventListener('click', tapSync);
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : $('#stage').requestFullscreen().catch(() => {}));
$('#fsBtn').addEventListener('click', toggleFs);
new FullscreenControls($('#stage'), $('#stageControls'));
document.addEventListener('fullscreenchange', () => setTimeout(() => { state.focus = -2; }, 60));
window.addEventListener('resize', () => { state.focus = -2; });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, button') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); media.toggle(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); media.seek(media.time() - 5); }
  else if (k === 'ArrowRight') { e.preventDefault(); media.seek(media.time() + 5); }
  else if (k === '[') setOffset(state.offset - (e.shiftKey ? 0.5 : 0.1));
  else if (k === ']') setOffset(state.offset + (e.shiftKey ? 0.5 : 0.1));
  else if (k === '{') setOffset(state.offset - 0.5);
  else if (k === '}') setOffset(state.offset + 0.5);
  else if (k === 't' || k === 'T') tapSync();
  else if (k === 'f' || k === 'F') toggleFs();
});

requestAnimationFrame(frame);

/* ---------- phone requests (QR code on the stage) ---------- */
if (typeof PartyHost !== 'undefined') {
  PartyHost.start({
    store,
    getQueue: () => queue,
    getNow: () => nowPlaying,
    add(item) { queue.push(item); saveQueue(); recordRequest(item); return queue.length; },
  });
}

/* ---------- lyric layout ---------- */
$$('#lyricMode button').forEach((b) => b.addEventListener('click', () => {
  lyricMode = b.dataset.mode;
  store.set('gkc.lyricMode', lyricMode);
  applyLyricMode();
}));
applyLyricMode();

/* ---------- auto-advance: when a song ends, the next singer starts on their own ---------- */
const AUTO_DELAY = 5;
let autoCountdown = null;
const autoToggle = $('#autoNext');
autoToggle.checked = store.get('gkc.autoNext', true);
autoToggle.addEventListener('change', () => { store.set('gkc.autoNext', autoToggle.checked); if (!autoToggle.checked) cancelAuto(); });

function stageIdle() {
  if (!state.track) return true;
  const d = media.duration();
  return d > 0 && !media.playing() && media.time() >= d - 1;
}
function cancelAuto() {
  if (!autoCountdown || autoCountdown.busy) return;
  clearInterval(autoCountdown.timer);
  autoCountdown = null;
  setWarn('');
}
async function playWhenReady() {
  // The video and backing track are found and cued in the background, and cueing
  // can stop a play that started too early, so keep at it until playback holds.
  const track = state.track;
  if (!track) return;
  let held = 0;
  for (let i = 0; i < 90 && state.track === track; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (mediaState.searching || mediaState.track !== track || media.kind !== 'yt' || !ytVideoId) continue;
    if (media.playing()) { if (++held >= 4) return; continue; }
    held = 0;
    media.play();
  }
}
setInterval(() => {
  if (autoCountdown) {
    if (autoCountdown.busy) return;
    // Someone pressed play, seeked back or emptied the queue: stop counting down.
    if (!queue.length || !stageIdle() || !autoToggle.checked) cancelAuto();
    return;
  }
  if (!autoToggle.checked || !queue.length || !stageIdle()) return;
  const q = queue[0];
  let left = AUTO_DELAY;
  const show = () => setWarn(`${left} 秒後換下一位：${q.singer} · ${q.track}`);
  show();
  autoCountdown = { timer: setInterval(async () => {
    left -= 1;
    if (left > 0) { show(); return; }
    // Hold the lock while the next song loads, so it is not skipped by a second countdown.
    clearInterval(autoCountdown.timer);
    autoCountdown.busy = true;
    setWarn('');
    try {
      await nextSinger();
      await playWhenReady();
    } finally {
      autoCountdown = null;
    }
  }, 1000) };
}, 500);

/* ---------- song history: every request is kept in a playlist named by date ---------- */
const HISTORY_KEY = 'gkc.history';
const DAY_STARTS_AT = 6; // songs requested before 6am belong to the previous night
const pad2 = (n) => String(n).padStart(2, '0');
function partyDate(at = Date.now()) {
  const d = new Date(at - DAY_STARTS_AT * 3600e3);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const dateLabel = (key) => key.replace(/-/g, '/');
const loadHistory = () => { const h = store.get(HISTORY_KEY, {}); return h && typeof h === 'object' ? h : {}; };
let historyView = null;
let historyDeleteArmed = null;

function recordRequest(item) {
  const h = loadHistory();
  const key = partyDate();
  const { fromPhone, ...entry } = item;
  (h[key] = h[key] || []).push({ ...entry, fromPhone: !!fromPhone, at: Date.now() });
  store.set(HISTORY_KEY, h);
  historyView = key;
  renderHistory();
}

function requeue(entries) {
  entries.forEach(({ at, ...e }) => queue.push({ ...e }));
  saveQueue();
}

function renderHistory() {
  const h = loadHistory();
  const keys = Object.keys(h).filter((k) => Array.isArray(h[k]) && h[k].length).sort().reverse();
  const sel = $('#historyDate');
  const box = $('#historyBox');
  box.hidden = !keys.length;
  $('#historyEmpty').hidden = !!keys.length;
  if (!keys.length) return;
  if (!historyView || !keys.includes(historyView)) historyView = keys[0];
  sel.replaceChildren(...keys.map((k) => {
    const o = el('option', '', `${dateLabel(k)} 的歌單（${h[k].length} 首）${k === partyDate() ? '· 今天' : ''}`);
    o.value = k;
    o.selected = k === historyView;
    return o;
  }));
  const list = h[historyView];
  $('#historyList').replaceChildren(...list.map((e) => {
    const li = el('li');
    const t = new Date(e.at);
    const mid = el('div');
    mid.append(el('div', 'q-name', e.track), el('div', 'q-song', `${e.singer} · ${e.artist || ''} · ${pad2(t.getHours())}:${pad2(t.getMinutes())}`));
    const b = el('button', 'btn ghost mini-btn', '再點一次');
    b.type = 'button';
    b.addEventListener('click', () => { requeue([e]); setWarn(`已把「${e.track}」加入排隊。`); });
    li.append(mid, b);
    return li;
  }));
  historyDeleteArmed = null;
  $('#historyDelete').textContent = '刪除這個歌單';
}

function downloadHistory() {
  const list = loadHistory()[historyView] || [];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['順序', '時間', '點歌的人', '歌名', '歌手', 'YouTube 影片', '用伴奏'].map(cell).join(',')];
  list.forEach((e, i) => {
    const t = new Date(e.at);
    rows.push([i + 1, `${pad2(t.getHours())}:${pad2(t.getMinutes())}`, e.singer, e.track, e.artist,
      e.yt ? `https://www.youtube.com/watch?v=${e.yt}` : '', e.instOn ? '是' : '否'].map(cell).join(','));
  });
  // A byte-order mark lets Excel open the Chinese text correctly.
  const blob = new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `鱷魚KTV歌單-${historyView}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$('#historyDate').addEventListener('change', (e) => { historyView = e.target.value; renderHistory(); });
$('#historyRequeue').addEventListener('click', () => {
  const list = loadHistory()[historyView] || [];
  if (!list.length) return;
  requeue(list);
  setWarn(`已把 ${dateLabel(historyView)} 的 ${list.length} 首歌加入排隊。`);
});
$('#historyDownload').addEventListener('click', downloadHistory);
$('#historyDelete').addEventListener('click', () => {
  // Two presses instead of a confirm dialog, which would freeze the stage.
  if (historyDeleteArmed !== historyView) {
    historyDeleteArmed = historyView;
    $('#historyDelete').textContent = '再按一次確認刪除';
    return;
  }
  const h = loadHistory();
  delete h[historyView];
  store.set(HISTORY_KEY, h);
  historyView = null;
  renderHistory();
});
renderHistory();
