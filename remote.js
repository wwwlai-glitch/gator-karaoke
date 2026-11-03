/* Phone song requests: search lyrics, preview the music video, then send the
   song to the big screen's singer queue over a PeerJS connection. */
'use strict';

(() => {
  const $ = (s) => document.querySelector(s);
  const API = 'https://lrclib.net/api';
  const VIDEO_ID = /^[\w-]{11}$/;
  const room = (new URLSearchParams(location.search).get('room') || '').toLowerCase();
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const pick = { track: null, videos: [], instrumentals: [], video: null, ctl: null };
  let conn = null;
  let peer = null;
  let searchCtl = null;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  /* ---------- connection to the big screen ---------- */
  function setConn(msg, ok = false) {
    const c = $('#conn');
    c.textContent = msg;
    c.classList.toggle('ok', ok);
    updateAdd();
  }

  function connect() {
    if (!/^[a-z0-9]{6}$/.test(room)) { setConn('找不到房間代碼，請重新掃描電視上的 QR Code。'); return; }
    if (typeof Peer !== 'function') { setConn('連線元件沒有載入，請重新整理頁面。'); return; }
    setConn('正在連線到電視…');
    if (!peer || peer.destroyed) {
      peer = new Peer({ debug: 0 });
      peer.on('open', openConn);
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      peer.on('error', (err) => {
        if (err && err.type === 'peer-unavailable') setConn('找不到電視端。請確認電視上的點歌頁面有開著，5 秒後重試…');
        else setConn('連線失敗，5 秒後重試…');
        setTimeout(retry, 5000);
      });
    } else if (peer.open) openConn();
  }

  function openConn() {
    if (conn && conn.open) return;
    conn = peer.connect(`gator-ktv-${room}`, { reliable: true });
    conn.on('open', () => { setConn(`已連線 · 房間 ${room.toUpperCase()}`, true); conn.send({ type: 'hello' }); });
    conn.on('data', onMessage);
    conn.on('close', () => { setConn('和電視的連線中斷，正在重新連線…'); setTimeout(retry, 2000); });
    conn.on('error', () => setTimeout(retry, 3000));
  }

  function retry() {
    if (conn && conn.open) return;
    conn = null;
    if (peer && peer.open) openConn(); else connect();
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'queue') renderQueue(msg);
    else if (msg.type === 'added') {
      const s = $('#addStatus');
      s.className = 'status ok';
      s.textContent = `已加入歌單！「${msg.track}」排在第 ${msg.position} 首。`;
      $('#addBtn').disabled = true;
      setTimeout(updateAdd, 1500);
    } else if (msg.type === 'error') {
      const s = $('#addStatus');
      s.className = 'status err';
      s.textContent = msg.message || '加入失敗，請再試一次。';
      updateAdd();
    }
  }

  function renderQueue({ items = [], now = null }) {
    const n = $('#now');
    n.hidden = !now;
    if (now) n.textContent = `現在演唱：${now.singer} · ${now.track}`;
    const ol = $('#queue');
    if (!items.length) { ol.replaceChildren(el('li', 'muted', '還沒有人點歌，第一首就是你的！')); return; }
    ol.replaceChildren(...items.map((q) => {
      const li = el('li');
      li.append(el('strong', '', q.singer), el('span', '', ` ${q.track}${q.artist ? ` · ${q.artist}` : ''}`));
      return li;
    }));
  }

  /* ---------- lyrics search (same sources as the big screen) ---------- */
  function fromLrclib(r) {
    const word = !!r.syncedLyrics && /<\d+:\d+/.test(r.syncedLyrics);
    return {
      key: String(r.id), source: 'lrclib', id: r.id,
      trackName: r.trackName, artistName: r.artistName, albumName: r.albumName, duration: Number(r.duration) || 0,
      timing: word ? 'word' : r.syncedLyrics ? 'line' : 'plain', instrumental: !!r.instrumental,
    };
  }
  function fromWordRecord(r) {
    return {
      key: `wt:${r.id || r.lyricsUrl}`, source: 'wordtiming', id: r.id, isrc: r.isrc,
      trackName: r.track_name, artistName: r.artist_name, albumName: r.album_name, duration: Number(r.duration) || 0,
      timing: 'word', lyricsUrl: r.lyricsUrl,
    };
  }

  async function search(q) {
    if (searchCtl) searchCtl.abort();
    const ctl = searchCtl = new AbortController();
    const status = $('#searchStatus');
    status.className = 'status';
    status.textContent = '搜尋中…';
    $('#results').replaceChildren();
    const [lrc, word] = await Promise.allSettled([
      fetch(`${API}/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal }).then((r) => {
        if (!r.ok) throw new Error(`LRCLIB ${r.status}`);
        return r.json();
      }),
      WordTiming.search(q, { signal: ctl.signal }),
    ]);
    if (searchCtl !== ctl) return;
    if (lrc.status === 'rejected' && word.status === 'rejected') {
      status.className = 'status err';
      status.textContent = '無法連上歌詞資料庫，請稍後再試。';
      return;
    }
    const lrcList = (lrc.status === 'fulfilled' ? lrc.value : []).map(fromLrclib).filter((r) => !r.instrumental && r.timing !== 'plain');
    const wordList = (word.status === 'fulfilled' ? word.value : []).map(fromWordRecord);
    const list = [...wordList, ...lrcList.filter((r) => r.timing === 'word'), ...lrcList.filter((r) => r.timing === 'line')].slice(0, 30);
    status.textContent = list.length ? '點一首歌來預覽 MV。' : '找不到有同步歌詞的版本。試試只輸入歌名，或輸入「歌手＋歌名」。';
    $('#results').replaceChildren(...list.map(resultItem));
  }

  function resultItem(r) {
    const li = el('li');
    const b = el('button', 'result');
    b.type = 'button';
    const side = el('span', 'r-side');
    side.append(el('span', `badge ${r.timing}`, r.timing === 'word' ? '逐字' : '逐行'), el('span', '', fmt(r.duration)));
    b.append(el('span', 'r-title', r.trackName), side, el('span', 'r-meta', [r.artistName, r.albumName].filter(Boolean).join(' · ')));
    b.addEventListener('click', () => {
      document.querySelectorAll('.result.on').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      choose(r);
    });
    li.append(b);
    return li;
  }

  /* ---------- MV preview ---------- */
  async function choose(track) {
    if (pick.ctl) pick.ctl.abort();
    const ctl = pick.ctl = new AbortController();
    Object.assign(pick, { track, videos: [], instrumentals: [], video: null });
    $('#previewCard').hidden = false;
    $('#picked').textContent = `${track.trackName}${track.artistName ? ` · ${track.artistName}` : ''}`;
    $('#player').replaceChildren(el('p', 'muted', '正在找 MV…'));
    $('#videos').replaceChildren();
    $('#mediaStatus').className = 'status';
    $('#mediaStatus').textContent = '';
    $('#addStatus').textContent = '';
    $('#instRow').hidden = true;
    $('#pasteUrl').value = '';
    $('#ytSearch').href = MediaFinder.youtubeSearchURL(track);
    updateAdd();
    $('#previewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

    let found;
    try {
      found = await MediaFinder.find(track, { signal: ctl.signal });
    } catch {
      if (ctl.signal.aborted) return;
      found = { videos: [], instrumentals: [], errors: { search: true } };
    }
    if (pick.ctl !== ctl) return;
    pick.videos = found.videos;
    pick.instrumentals = found.instrumentals;
    if (found.instrumentals.length) {
      $('#instRow').hidden = false;
      $('#instLabel').textContent = `用伴奏唱（去除原唱）· 找到 ${found.instrumentals.length} 個伴奏`;
    }
    if (found.videos.length) {
      preview(found.videos[0]);
      $('#mediaStatus').textContent = '畫面不對可以點下面換一支，滿意就按「加入歌單」。';
    } else {
      $('#player').replaceChildren(el('p', 'muted', '沒有自動找到 MV。'));
      $('#mediaStatus').className = 'status err';
      $('#mediaStatus').textContent = found.errors && found.errors.search
        ? '自動搜尋影片暫時無法使用。可以自己貼 YouTube 連結，或直接加入，由電視端再找一次。'
        : '找不到符合的 MV。可以自己貼 YouTube 連結，或直接加入，由電視端再找一次。';
      $('#pasteBox').open = true;
    }
    renderVideos();
    updateAdd();
  }

  function preview(v) {
    pick.video = v;
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${v.id}?playsinline=1&rel=0`;
    iframe.title = v.title || 'MV 預覽';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    $('#player').replaceChildren(iframe);
    renderVideos();
    updateAdd();
  }

  const KIND = { 'Music video': 'MV', 'Official audio': '官方音訊', 'Lyric video': '歌詞影片', Audio: '音訊', Video: '影片', 'Karaoke track': 'KTV 伴唱', Instrumental: '伴奏' };

  function renderVideos() {
    const D = pick.track && pick.track.duration;
    $('#videos').replaceChildren(...pick.videos.map((v) => {
      const li = el('li');
      const b = el('button', `video${pick.video && pick.video.id === v.id ? ' on' : ''}`);
      b.type = 'button';
      const img = el('img');
      img.src = `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
      img.alt = '';
      img.loading = 'lazy';
      const t = el('span', 'v-text');
      let fit = '';
      if (v.length && D) { const d = Math.round(v.length - D); fit = Math.abs(d) <= 2 ? ' · 與歌詞相符' : ` · ${d > 0 ? '長' : '短'} ${Math.abs(d)} 秒`; }
      t.append(el('span', 'v-title', v.title), el('span', 'v-meta', `${KIND[v.kind] || v.kind || ''}${v.length ? ` · ${fmt(v.length)}` : ''}${fit}`));
      b.append(img, t);
      b.addEventListener('click', () => preview(v));
      li.append(b);
      return li;
    }));
  }

  function videoId(input) {
    const s = String(input || '').trim();
    if (VIDEO_ID.test(s)) return s;
    try {
      const u = new URL(s);
      if (/(^|\.)youtu\.be$/.test(u.hostname)) return VIDEO_ID.test(u.pathname.slice(1, 12)) ? u.pathname.slice(1, 12) : null;
      if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
        const v = u.searchParams.get('v');
        if (v && VIDEO_ID.test(v)) return v;
        const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
        return m ? m[1] : null;
      }
    } catch { /* not a URL */ }
    return null;
  }

  /* ---------- add to the queue ---------- */
  function updateAdd() {
    const ready = !!(pick.track && conn && conn.open && $('#singer').value.trim());
    $('#addBtn').disabled = !ready;
    if (pick.track && !$('#singer').value.trim()) {
      const s = $('#addStatus');
      if (!s.textContent || s.dataset.hint) { s.className = 'status'; s.textContent = '先在最上面輸入你的名字。'; s.dataset.hint = '1'; }
    } else if ($('#addStatus').dataset.hint) {
      $('#addStatus').textContent = '';
      delete $('#addStatus').dataset.hint;
    }
  }

  function add() {
    const singer = $('#singer').value.trim();
    if (!singer || !pick.track || !conn || !conn.open) return;
    store.set('gkc.remote.name', singer);
    const inst = pick.instrumentals[0] || null;
    const { instrumental, ...song } = pick.track;
    conn.send({ type: 'add', item: {
      singer, song, yt: pick.video ? pick.video.id : null,
      inst: inst ? inst.id : null, instOn: !!inst && $('#instOn').checked,
    } });
    const s = $('#addStatus');
    delete s.dataset.hint;
    s.className = 'status';
    s.textContent = '傳送中…';
    $('#addBtn').disabled = true;
  }

  /* ---------- wiring ---------- */
  $('#singer').value = store.get('gkc.remote.name', '');
  $('#singer').addEventListener('input', updateAdd);
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (q) { $('#q').blur(); search(q); }
  });
  $('#pasteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = videoId($('#pasteUrl').value);
    if (!id) { $('#mediaStatus').className = 'status err'; $('#mediaStatus').textContent = '這看起來不是 YouTube 連結。'; return; }
    const v = { id, title: '你貼上的 YouTube 影片', author: '', length: 0, kind: 'Video' };
    if (!pick.videos.some((x) => x.id === id)) pick.videos.unshift(v);
    $('#mediaStatus').className = 'status';
    $('#mediaStatus').textContent = '已換成你貼上的影片。';
    preview(pick.videos.find((x) => x.id === id));
  });
  $('#addBtn').addEventListener('click', add);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) retry(); });
  connect();
})();
