/* Phone requests for the big screen.
   The stage shows a QR code for remote.html with this screen's room code. Phones
   connect peer to peer (PeerJS; its free public server only introduces the two
   ends) and send songs, which land in the singer queue. The room code is kept in
   this browser so a printed or saved QR code keeps working after a reload. */
'use strict';

const PartyHost = (() => {
  const VIDEO_ID = /^[\w-]{11}$/;
  const ROOM_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  const MAX_QUEUE = 60;
  const conns = new Set();
  let peer = null;
  let retryTimer = null;

  const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // Keep only the fields the queue understands; anything else from a phone is dropped.
  function sanitizeItem(raw) {
    if (!raw || typeof raw !== 'object' || !raw.song || typeof raw.song !== 'object') return null;
    const s = raw.song;
    const source = s.source === 'wordtiming' ? 'wordtiming' : s.source === 'lrclib' ? 'lrclib' : null;
    const singer = text(raw.singer, 40);
    const trackName = text(s.trackName, 200);
    if (!source || !singer || !trackName) return null;
    const song = {
      key: text(s.key, 300), source, id: source === 'lrclib' ? num(s.id) : text(String(s.id ?? ''), 100),
      trackName, artistName: text(s.artistName, 200), albumName: text(s.albumName, 200),
      duration: num(s.duration), timing: ['word', 'line', 'plain'].includes(s.timing) ? s.timing : 'line',
    };
    if (source === 'lrclib' && !song.id) return null;
    if (source === 'wordtiming') {
      song.isrc = text(s.isrc, 40);
      song.lyricsUrl = text(s.lyricsUrl, 500);
      if (!/^https:\/\//.test(song.lyricsUrl)) return null;
    }
    if (!song.key) song.key = source === 'lrclib' ? String(song.id) : `wt:${song.id || song.lyricsUrl}`;
    const yt = VIDEO_ID.test(raw.yt) ? raw.yt : null;
    const inst = VIDEO_ID.test(raw.inst) ? raw.inst : null;
    return {
      singer, song, trackId: source === 'lrclib' ? song.id : null, track: trackName, artist: song.artistName,
      yt, inst, instOn: !!(inst && raw.instOn), fromPhone: true,
    };
  }

  function roomCode(store) {
    let code = store.get('gkc.room', '');
    if (!/^[a-z0-9]{6}$/.test(code)) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      code = [...bytes].map((b) => ROOM_CHARS[b % ROOM_CHARS.length]).join('');
      store.set('gkc.room', code);
    }
    return code;
  }

  function remoteURL(code) {
    return new URL(`remote.html?room=${code}`, location.href).href;
  }

  function qrSVG(url) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const m = 2;
    let path = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="點歌 QR Code"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#061433"/></svg>`;
  }

  function snapshot(queue, now) {
    return { type: 'queue', items: queue.map((q) => ({ singer: q.singer, track: q.track, artist: q.artist })), now };
  }

  function broadcast(msg) {
    conns.forEach((c) => { try { if (c.open) c.send(msg); } catch { /* a dropped phone is cleaned up on close */ } });
  }

  function setStatus(msg, ok = false) {
    const el = document.getElementById('qrStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('ok', ok);
  }

  function updateCount() {
    const n = [...conns].filter((c) => c.open).length;
    setStatus(n ? `${n} 支手機已連線` : '等待手機連線', true);
  }

  // hooks: { store, getQueue, getNow, add(item) → position or 0 when full }
  function start(hooks) {
    const code = roomCode(hooks.store);
    const url = remoteURL(code);
    const panel = document.getElementById('qrPanel');
    document.getElementById('qrCode').innerHTML = qrSVG(url);
    document.getElementById('qrRoom').textContent = code.toUpperCase();
    const link = document.getElementById('qrLink');
    link.href = url;
    const toggle = document.getElementById('qrToggle');
    const show = hooks.store.get('gkc.qr', true);
    toggle.checked = show;
    panel.hidden = !show;
    toggle.addEventListener('change', () => { panel.hidden = !toggle.checked; hooks.store.set('gkc.qr', toggle.checked); });

    if (typeof Peer !== 'function') { setStatus('點歌連線元件沒有載入'); return; }
    connect(code, hooks);
  }

  function connect(code, hooks) {
    clearTimeout(retryTimer);
    if (peer) { try { peer.destroy(); } catch { /* already gone */ } }
    setStatus('正在開啟點歌連線…');
    peer = new Peer(`gator-ktv-${code}`, { debug: 0 });
    peer.on('open', updateCount);
    peer.on('connection', (conn) => {
      conns.add(conn);
      conn.on('open', () => {
        updateCount();
        conn.send(snapshot(hooks.getQueue(), hooks.getNow()));
      });
      conn.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'add') {
          const item = sanitizeItem(msg.item);
          if (!item) { conn.send({ type: 'error', message: '這首歌的資料不完整，請重新選一次。' }); return; }
          if (hooks.getQueue().length >= MAX_QUEUE) { conn.send({ type: 'error', message: '歌單已經滿了，請等幾首唱完再點。' }); return; }
          const position = hooks.add(item);
          conn.send({ type: 'added', position, track: item.track });
        } else if (msg.type === 'hello') {
          conn.send(snapshot(hooks.getQueue(), hooks.getNow()));
        }
      });
      const drop = () => { conns.delete(conn); updateCount(); };
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('disconnected', () => {
      setStatus('點歌連線中斷，正在重新連線…');
      retryTimer = setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 2000);
    });
    peer.on('error', (err) => {
      if (err && err.type === 'unavailable-id') {
        setStatus('這個點歌房間已在另一個分頁或電腦開啟。請關掉其他分頁後重新整理。');
        return;
      }
      setStatus('點歌連線失敗，10 秒後重試…');
      retryTimer = setTimeout(() => connect(code, hooks), 10000);
    });
  }

  return { start, broadcast, snapshot, sanitizeItem };
})();

if (typeof module !== 'undefined') module.exports = PartyHost;
