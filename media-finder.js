/* Finds a YouTube music video and instrumental for a lyrics record, without API keys.
   Official music videos come from Wikidata (property P1651, "YouTube video ID").
   YouTube search goes through public Invidious instances that allow cross-origin
   requests. Candidates are ranked by how closely their length matches the
   recording the lyrics were timed against, since that decides whether they sync. */
'use strict';

const MediaFinder = (() => {
  const INSTANCE_LIST = 'https://api.invidious.io/instances.json?sort_by=health';
  // Public clearnet instances from docs.invidious.io/instances. Directory
  // api/cors flags are hints; actual browser requests decide availability.
  const FALLBACK_INSTANCES = ['invidious.f5.si', 'inv.nadeko.net', 'invidious.nerdvpn.de',
    'yt.chocolatemoo53.com', 'invidious.tiekoetter.com'];
  const WIKIDATA = 'https://www.wikidata.org/w/api.php?format=json&origin=*';
  const VIDEO_ID = /^[\w-]{11}$/;

  const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const words = (s) => norm(s).split(' ').filter(Boolean);
  // Chinese, Japanese and Korean titles are not split by spaces, so CJK words match as substrings.
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
  const has = (hay, needle) => !!needle && (CJK.test(needle) ? String(hay || '').includes(needle)
    : ` ${hay} `.includes(` ${needle} `));
  const dropThe = (s) => s.replace(/^the /, '');

  // "Song (feat. X) - 2011 Remaster" → "Song"
  function baseTitle(title) {
    return String(title || '')
      .replace(/\s*[([][^)\]]*[)\]]/g, '')
      .replace(/\s[-–—]\s.*$/, '')
      .trim() || String(title || '');
  }

  function youtubeSearchURL(track, instrumental = false) {
    const song = baseTitle(track.trackName);
    const suffix = instrumental ? (CJK.test(`${track.artistName} ${song}`) ? '伴奏' : 'instrumental') : '';
    const q = [track.artistName, song, suffix].filter(Boolean).join(' ');
    return `https://www.youtube.com/results?${new URLSearchParams({ search_query: q })}`;
  }

  function artistParts(artist) {
    return String(artist || '').split(/\s*(?:,|&|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bwith\b|\/)\s*/i)
      .map((a) => dropThe(norm(a))).filter((a) => a.length > 1);
  }

  function artistMatches(name, artist) {
    const n = dropThe(norm(name));
    if (!n) return false;
    return artistParts(artist).some((a) => a === n) || (n.length >= 4 && has(dropThe(norm(artist)), n));
  }

  // Words in the video title that would make it a different performance or edit,
  // unless the song title itself contains them.
  const ALTERED = ['cover', 'reaction', 'live', 'remix', 'slowed', 'sped', 'nightcore', '8d', 'tutorial', 'lesson',
    'reverb', 'bass boosted', 'hour', 'hours', 'loop', 'mashup', 'parody', 'acoustic', 'teaser', 'trailer', 'snippet',
    'shorts', 'fan made', 'fanmade', 'ai', 'zumba', 'dance', 'choreography', 'workout', 'fitness', 'tiktok', 'extended',
    '翻唱', '抖音', '加速', '降速', '慢速', '教學', '教学', '舞蹈', '混音', '演唱會', '演唱会', '現場', '现场'];
  const INSTRUMENTAL = ['instrumental', 'karaoke', 'backing track', 'minus one', 'off vocal', 'no vocals', 'without vocals',
    'ktv', '伴奏', '伴唱', '卡拉ok', '消音', '去人聲', '去人声', '純音樂', '纯音乐', '無人聲', '无人声'];
  // Chinese lyric-video labels: 歌詞版, 動態歌詞, 字幕 and their simplified forms.
  const LYRIC_ZH = ['歌詞', '歌词', '字幕'];
  // Titles that mark a sing-along (karaoke) track rather than a plain instrumental.
  const KARAOKE = ['karaoke', 'ktv', '卡拉ok', '伴唱'];
  const NOT_BACKING = ['piano', 'guitar', 'violin', 'cello', 'sax', 'saxophone', 'drum', 'drums', 'ukulele', 'orchestra',
    'acapella', 'a cappella', 'vocals only', 'isolated vocals', 'lofi', 'lo fi', 'music box', 'chill',
    '鋼琴', '钢琴', '吉他', '小提琴', '古箏', '古筝', '二胡', '八音盒', '清唱', '純人聲', '纯人声'];

  const anyWord = (title, list, song) => list.some((w) => has(title, w) && !has(song, w));
  // Re-recordings such as "(Taylor's Version)" are a different performance.
  const reRecording = (title, song) => /\b\w+ s version\b/.test(title) && !/\b\w+ s version\b/.test(song);

  function describe(video, track) {
    const title = norm(video.title);
    const song = norm(track.trackName);
    const need = words(baseTitle(track.trackName));
    const titleWords = new Set(words(video.title));
    const author = norm(video.author);
    const topic = / - Topic$/i.test(video.author || '');
    const artistAuthor = artistMatches(String(video.author || '').replace(/\s*-\s*Topic$/i, '').replace(/\s*VEVO$/i, '').replace(/VEVO$/i, ''), track.artistName);
    return {
      title, song, author, topic,
      titleOk: need.length > 0 && need.every((w) => titleWords.has(w) || (CJK.test(w) && title.includes(w))),
      artistOk: artistParts(track.artistName).some((a) => has(dropThe(title), a) || has(title, a)) || artistAuthor,
      // "Official" in a title is easy to fake, so only the uploader counts.
      official: topic || artistAuthor || /vevo$/.test(author.replace(/ /g, '')),
      musicVideo: has(title, 'official video') || has(title, 'official music video') || has(title, 'music video') || has(title, 'mv'),
      lyricVideo: has(title, 'lyrics') || has(title, 'lyric') || has(title, 'lyric video')
        || LYRIC_ZH.some((w) => has(title, w)),
      diff: track.duration > 0 && video.length > 0 ? Math.abs(video.length - track.duration) : null,
    };
  }

  // Lower score is better.
  function rankVideos(track, results, wikidataIds = []) {
    const out = new Map();
    const official = new Set(wikidataIds);
    results.forEach((v, i) => {
      if (!v || !VIDEO_ID.test(v.id) || out.has(v.id)) return;
      const d = describe(v, track);
      const fromWikidata = official.has(v.id);
      if (!fromWikidata && (!d.titleOk || !d.artistOk)) return;
      if (anyWord(d.title, ALTERED, d.song) || anyWord(d.title, INSTRUMENTAL, d.song) || reRecording(d.title, d.song)) return;
      if (d.diff != null && d.diff > 45) return;
      const musicVideo = fromWikidata || d.musicVideo;
      const kind = musicVideo ? 'Music video' : d.topic ? 'Official audio' : d.lyricVideo ? 'Lyric video' : has(d.title, 'audio') ? 'Audio' : 'Video';
      const score = (d.diff == null ? 3 : Math.min(d.diff, 40)) * 1.5
        + ((fromWikidata || d.official) ? 0 : 5)
        + (musicVideo ? 0 : 3.5)
        + (d.lyricVideo ? 1.5 : 0)
        + (has(d.title, 'version') && !has(d.song, 'version') ? 4 : 0)
        + i * 0.2;
      out.set(v.id, { ...v, kind, official: fromWikidata || d.official, diff: d.diff, score });
    });
    // Official videos from Wikidata that the search did not return (length unknown).
    wikidataIds.forEach((id) => {
      if (VIDEO_ID.test(id) && !out.has(id)) out.set(id, { id, title: `${track.artistName} – ${track.trackName}`, author: '', length: 0, kind: 'Music video', official: true, diff: null, score: 4.5 + 3 * 1.5 });
    });
    return [...out.values()].sort((a, b) => a.score - b.score);
  }

  function rankInstrumentals(track, results) {
    const out = new Map();
    results.forEach((v, i) => {
      if (!v || !VIDEO_ID.test(v.id) || out.has(v.id)) return;
      const d = describe(v, track);
      if (!d.titleOk || !d.artistOk || !anyWord(d.title, INSTRUMENTAL, d.song)) return;
      if (anyWord(d.title, ALTERED.filter((w) => w !== 'cover'), d.song) || anyWord(d.title, NOT_BACKING, d.song) || reRecording(d.title, d.song)) return;
      const karaoke = KARAOKE.some((w) => has(d.title, w));
      if (has(d.title, 'cover') && !karaoke) return;
      if (d.diff != null && d.diff > 25) return;
      const kind = karaoke ? 'Karaoke track' : 'Instrumental';
      const score = (d.diff == null ? 4 : Math.min(d.diff, 25)) * 1.5
        + (has(d.title, 'official instrumental') || d.official ? -1 : 0)
        + (has(d.title, 'backing vocals') ? 0.5 : 0)
        + i * 0.2;
      out.set(v.id, { ...v, kind, diff: d.diff, score });
    });
    return [...out.values()].sort((a, b) => a.score - b.score);
  }

  async function getJSON(url, signal, ms = 8000) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, ms);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    }
  }

  let instancesPromise = null;
  let instancesExpire = 0;
  let preferred = null;
  const failedUntil = new Map();
  const publicHost = (host) => typeof host === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)
    && !/\.(onion|i2p|ygg)$/i.test(host);
  function instances() {
    if (!instancesPromise || Date.now() >= instancesExpire) {
      instancesExpire = Date.now() + 10 * 60 * 1000;
      instancesPromise = getJSON(INSTANCE_LIST, null, 4000)
        .then((list) => {
          if (!Array.isArray(list)) throw new Error('Unexpected instance directory');
          return list.filter((entry) => Array.isArray(entry) && publicHost(entry[0])
            && entry[1] && entry[1].type === 'https' && !entry[0].startsWith('inv-ygg.'))
            .sort((a, b) => Number(!!(b[1].api && b[1].cors)) - Number(!!(a[1].api && a[1].cors)))
            .map(([host]) => host);
        })
        .catch(() => { instancesExpire = Date.now() + 60000; return []; })
        .then((hosts) => [...new Set([...hosts, ...FALLBACK_INSTANCES])]);
    }
    return instancesPromise;
  }

  let helperPromise = null, helperExpires = 0, helperAudio = false;
  const helperURL = (path) => new URL(`api/media/${path}`, location.href).href;
  async function localHelper() {
    if (typeof location === 'undefined' || !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return false;
    if (!helperPromise || Date.now() >= helperExpires) {
      helperExpires = Date.now() + 60000;
      helperPromise = getJSON(helperURL('status'), null, 1500)
        .then((data) => {
          const available = data.provider === 'yt-dlp' && data.available === true;
          helperAudio = available && data.directAudio === true;
          return available;
        }).catch(() => { helperAudio = false; return false; });
    }
    return helperPromise;
  }

  async function localAudio() { await localHelper(); return helperAudio; }

  async function youtubeSearch(q, { signal } = {}) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (await localHelper()) {
      try {
        const data = await getJSON(`${helperURL('search')}?${new URLSearchParams({ q })}`, signal, 35000);
        if (!data || !Array.isArray(data.videos)) throw new Error('Unexpected direct search response');
        return data.videos.filter((v) => v && VIDEO_ID.test(v.id || ''))
          .map((v) => ({ id: v.id, title: String(v.title || ''), author: String(v.author || ''), length: Number(v.length) || 0 }));
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // A temporary YouTube error can still use the public mirror fallback.
      }
    }
    return invidiousSearch(q, { signal });
  }

  async function invidiousSearch(q, { signal } = {}) {
    const hosts = await instances();
    const order = preferred ? [preferred, ...hosts.filter((h) => h !== preferred)] : hosts;
    let lastError = null;
    for (const host of order) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if ((failedUntil.get(host) || 0) > Date.now()) continue;
      try {
        const list = await getJSON(`https://${host}/api/v1/search?${new URLSearchParams({ q, type: 'video' })}`, signal, 4000);
        if (!Array.isArray(list)) throw new Error('Unexpected search response');
        failedUntil.delete(host);
        preferred = host;
        return list
          .filter((v) => v && (v.type === 'video' || !v.type) && VIDEO_ID.test(v.videoId || '') && !v.liveNow && !v.isUpcoming)
          .map((v) => ({ id: v.videoId, title: v.title || '', author: v.author || '', length: Number(v.lengthSeconds) || 0 }));
      } catch (e) {
        if (signal && signal.aborted) throw e;
        failedUntil.set(host, Date.now() + 60000);
        if (preferred === host) preferred = null;
        lastError = e;
      }
    }
    throw lastError || new Error('No YouTube search service available');
  }

  const claims = (entity, prop) => ((entity.claims && entity.claims[prop]) || [])
    .filter((c) => c.rank !== 'deprecated')
    .map((c) => c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value)
    .filter((v) => v != null);

  async function wikidataVideos(track, { signal } = {}) {
    const title = baseTitle(track.trackName);
    const found = await getJSON(`${WIKIDATA}&action=wbsearchentities&type=item&language=en&limit=12&search=${encodeURIComponent(title)}`, signal);
    const ids = (found.search || []).map((s) => s.id).filter((id) => /^Q\d+$/.test(id));
    if (!ids.length) return [];
    const ents = await getJSON(`${WIKIDATA}&action=wbgetentities&props=claims|labels&languages=en&ids=${ids.join('|')}`, signal);
    const items = Object.values(ents.entities || {}).map((e) => ({
      label: (e.labels && e.labels.en && e.labels.en.value) || '',
      videos: claims(e, 'P1651').filter((v) => typeof v === 'string' && VIDEO_ID.test(v)),
      performers: claims(e, 'P175').map((v) => v.id).filter((id) => /^Q\d+$/.test(id || '')),
    })).filter((i) => i.videos.length && i.performers.length && norm(baseTitle(i.label)) === norm(title));
    if (!items.length) return [];
    const pids = [...new Set(items.flatMap((i) => i.performers))].slice(0, 50);
    const people = await getJSON(`${WIKIDATA}&action=wbgetentities&props=labels|aliases&languages=en&ids=${pids.join('|')}`, signal);
    const names = (id) => {
      const p = people.entities && people.entities[id];
      if (!p) return [];
      return [p.labels && p.labels.en && p.labels.en.value, ...((p.aliases && p.aliases.en) || []).map((a) => a.value)].filter(Boolean);
    };
    return [...new Set(items
      .filter((i) => i.performers.some((id) => names(id).some((n) => artistMatches(n, track.artistName))))
      .flatMap((i) => i.videos))];
  }

  // Returns { videos, instrumentals, errors } — lists are ranked best-first.
  async function find(track, { signal } = {}) {
    const artist = artistParts(track.artistName).length ? track.artistName : '';
    const q = `${artist} ${baseTitle(track.trackName)}`.trim();
    const zh = CJK.test(q);
    const [wd, main, audio, inst, instZh, lyricZh, subsZh] = await Promise.allSettled([
      wikidataVideos(track, { signal }),
      youtubeSearch(q, { signal }),
      youtubeSearch(`${q} official audio`, { signal }),
      youtubeSearch(`${q} instrumental`, { signal }),
      // Chinese uploads label backing tracks 伴奏 rather than "instrumental".
      zh ? youtubeSearch(`${q} 伴奏`, { signal }) : Promise.resolve([]),
      // Chinese lyric videos (歌詞版 / 字幕) are often the best-synced uploads.
      zh ? youtubeSearch(`${q} 歌詞`, { signal }) : Promise.resolve([]),
      zh ? youtubeSearch(`${q} 字幕`, { signal }) : Promise.resolve([]),
    ]);
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const value = (r) => (r.status === 'fulfilled' ? r.value : []);
    const wikidata = value(wd);
    const searches = [value(main), value(audio), value(lyricZh), value(subsZh)].flat();
    const instList = [...value(inst), ...value(instZh)];
    const ranked = rankVideos(track, [...searches, ...instList.filter((v) => wikidata.includes(v.id))], wikidata);
    // Always offer the official music video, even when its length differs.
    const videos = ranked.slice(0, 5);
    ranked.slice(5).filter((v) => wikidata.includes(v.id)).forEach((v) => videos.push(v));
    return {
      videos,
      instrumentals: rankInstrumentals(track, [...instList, ...searches]).slice(0, 5),
      errors: { wikidata: wd.reason || null, search: [main, audio, inst].every((r) => r.status === 'rejected') ? main.reason : null },
    };
  }

  return { find, rankVideos, rankInstrumentals, artistMatches, baseTitle, youtubeSearch, wikidataVideos, localHelper, localAudio, youtubeSearchURL };
})();

if (typeof module !== 'undefined') module.exports = MediaFinder;
