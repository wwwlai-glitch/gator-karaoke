const assert = require('node:assert/strict');
const { test } = require('node:test');
const PartyHost = require('../party-host.js');

const song = { key: '42', source: 'lrclib', id: 42, trackName: '晴天', artistName: '周杰倫', albumName: '葉惠美', duration: 270, timing: 'line' };

test('a phone request keeps only queue fields', () => {
  const item = PartyHost.sanitizeItem({ singer: '  小明 ', song: { ...song, syncedLyrics: 'x', evil: 1 }, yt: 'abcdefghijk', inst: 'zyxwvutsrqp', instOn: true, extra: 'drop' });
  assert.equal(item.singer, '小明');
  assert.equal(item.trackId, 42);
  assert.equal(item.yt, 'abcdefghijk');
  assert.equal(item.instOn, true);
  assert.equal(item.song.syncedLyrics, undefined);
  assert.equal(item.song.evil, undefined);
  assert.equal(item.extra, undefined);
});

test('malformed requests are rejected', () => {
  assert.equal(PartyHost.sanitizeItem(null), null);
  assert.equal(PartyHost.sanitizeItem({ singer: '', song }), null);
  assert.equal(PartyHost.sanitizeItem({ singer: 'A', song: { ...song, source: 'other' } }), null);
  assert.equal(PartyHost.sanitizeItem({ singer: 'A', song: { ...song, id: 0 } }), null);
  assert.equal(PartyHost.sanitizeItem({ singer: 'A', song: { source: 'wordtiming', trackName: 'X', lyricsUrl: 'javascript:alert(1)' } }), null);
});

test('bad video ids are dropped and instrumental needs an id', () => {
  const item = PartyHost.sanitizeItem({ singer: 'A', song, yt: 'not a video', inst: null, instOn: true });
  assert.equal(item.yt, null);
  assert.equal(item.instOn, false);
});
