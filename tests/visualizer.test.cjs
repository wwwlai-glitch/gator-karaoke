const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup(getDisplayMedia, userAgent = '') {
  const scope = vm.createContext({ navigator: { userAgent, mediaDevices: { getDisplayMedia } },
    MediaStream: class { constructor(tracks) { this.getTracks = () => tracks; } },
    performance: { now: () => 1000 }, requestAnimationFrame() {}, cancelAnimationFrame() {},
  });
  vm.runInContext(readFileSync(require.resolve('../visualizer.js'), 'utf8') + '\nthis.Visualizer = StageVisualizer;', scope);
  const v = Object.create(scope.Visualizer.prototype);
  let kind = 'yt', created = 0, destinations = 0;
  const connected = new Set(), classes = new Set(), captured = [];
  const fileNode = { connect() { destinations++; } };
  Object.assign(v, {
    enabled: true, captureVersion: 0, names: ['one', 'two'],
    sourceKind: () => kind, status: {}, shareButton: {}, shareHint: {}, audio: { addEventListener() {} },
    engine: { connectAudio(node) { connected.add(node); }, disconnectAudio(node) { connected.delete(node); } },
    context: { destination: {}, resume: async () => {},
      createMediaElementSource() { created++; return fileNode; }, createMediaStreamSource: (stream) => { captured.push(stream); return {}; } },
    init: async () => {},
    canvas: { width: 800, height: 600 },
    stage: { classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); } } },
  });
  return { v, connected, classes, captured, kind(value) { kind = value; },
    created: () => created, destinations: () => destinations };
}
function stream(audio = true, surface = 'browser') {
  const tracks = [{ kind: 'video', enabled: true, getSettings: () => ({ displaySurface: surface }), stops: 0, stop() { this.stops++; }, addEventListener() {} }];
  if (audio) tracks.push({ kind: 'audio', stops: 0, stop() { this.stops++; }, addEventListener() {} });
  return { tracks, getTracks: () => tracks, getVideoTracks: () => [tracks[0]], getAudioTracks: () => audio ? [tracks[1]] : [] };
}

test('file audio is routed to speakers once and its node is reused across source changes', () => {
  const h = setup();
  h.kind('file'); h.v.sourceChanged(); h.v.sourceChanged();
  h.kind('yt'); h.v.sourceChanged();
  assert.equal(h.connected.size, 0);
  h.kind('file'); h.v.sourceChanged();
  assert.equal(h.created(), 1);
  assert.equal(h.destinations(), 1);
  assert.equal(h.connected.size, 1);
});

test('Firefox never opens a screen picker and direct audio connects without capture', async () => {
  let pickerCalls = 0;
  const h = setup(async () => { pickerCalls++; return stream(); }, 'Mozilla/5.0 Firefox/145.0');
  await h.v.capture();
  assert.equal(pickerCalls, 0);
  assert.match(h.v.status.textContent, /Firefox 無法擷取/);
  h.kind('direct'); h.v.sourceChanged();
  assert.equal(h.created(), 1);
  assert.equal(h.connected.size, 1);
  assert.equal(h.v.shareButton.hidden, true);
  assert.match(h.v.status.textContent, /不需要分享螢幕/);
});

test('shared audio is analyzed without a second speaker connection and every track stops', async () => {
  const s = stream();
  const h = setup(async () => s);
  await h.v.capture();
  assert.equal(h.connected.size, 1);
  assert.equal(h.destinations(), 0);
  assert.equal(s.tracks[0].enabled, false);
  assert.deepEqual(h.captured[0].getTracks(), [s.tracks[1]]);
  h.v.stopCapture();
  assert.equal(h.connected.size, 0);
  assert.ok(s.tracks.every((t) => t.stops === 1));
  assert.equal(h.v.stream, null);
});

test('the picker prefers this browser tab and excludes monitor/system audio capture', async () => {
  let options;
  const { v } = setup(async (value) => { options = value; return stream(); });
  await v.capture();
  assert.equal(options.video.displaySurface, 'browser');
  assert.equal(options.preferCurrentTab, true);
  assert.equal(options.selfBrowserSurface, 'include');
  assert.equal(options.monitorTypeSurfaces, 'exclude');
  assert.equal(options.systemAudio, 'exclude');
  assert.equal(options.audio.suppressLocalAudioPlayback, false);
});

test('a screen or window selected in a browser ignoring picker hints is released', async () => {
  for (const surface of ['monitor', 'window']) {
    const s = stream(true, surface);
    const { v, connected } = setup(async () => s);
    await v.capture();
    assert.equal(connected.size, 0);
    assert.ok(s.tracks.every((track) => track.stops === 1));
    assert.match(v.status.textContent, /請選擇一個瀏覽器分頁/);
  }
});

test('sharing without an audio track gives guidance and releases the video track', async () => {
  const s = stream(false);
  const { v } = setup(async () => s);
  await v.capture();
  assert.match(v.status.textContent, /沒有分享到音訊/);
  assert.equal(s.tracks[0].stops, 1);
});

test('a pending share cannot survive leaving visualizer mode, even after re-enabling it', async () => {
  let resolve;
  const { v, connected } = setup(() => new Promise((r) => { resolve = r; }));
  const pending = v.capture();
  v.stopCapture();
  const s = stream(); resolve(s);
  await pending;
  assert.equal(connected.size, 0);
  assert.ok(s.tracks.every((t) => t.stops === 1));
});

test('switching to a local file stops capture and connects file audio', async () => {
  const s = stream();
  const h = setup(async () => s);
  await h.v.capture();
  h.kind('file'); h.v.sourceChanged();
  assert.ok(s.tracks.every((t) => t.stops === 1));
  assert.equal(h.connected.size, 1);
  assert.equal(h.created(), 1);
});

test('capture is cleaned up if audio initialization fails', async () => {
  const s = stream();
  const { v } = setup(async () => s);
  v.context.resume = async () => { throw new Error('audio unavailable'); };
  await v.capture();
  assert.ok(s.tracks.every((t) => t.stops === 1));
  assert.match(v.status.textContent, /無法分享音訊/);
});

test('fullscreen resizes the output canvas and renderer together without cropping', () => {
  const { v } = setup();
  let size = { width: 900, height: 600 };
  const calls = [];
  v.stage.getBoundingClientRect = () => size;
  v.engine.setRendererSize = (width, height) => {
    assert.equal(v.canvas.width, width);
    assert.equal(v.canvas.height, height);
    calls.push([width, height]);
  };
  // The method belongs to a VM realm, so give that realm a browser pixel ratio.
  const context = vm.createContext({ window: { devicePixelRatio: 2 } });
  const source = readFileSync(require.resolve('../visualizer.js'), 'utf8');
  vm.runInContext(source + '\nthis.resize = StageVisualizer.prototype.resize;', context);
  context.resize.call(v);
  size = { width: 2560, height: 1440 };
  context.resize.call(v);
  context.resize.call(v);
  assert.deepEqual(calls, [[1350, 900], [1600, 900]]);
  size = { width: 900, height: 600 };
  context.resize.call(v);
  assert.deepEqual(calls.at(-1), [1350, 900]);
});
