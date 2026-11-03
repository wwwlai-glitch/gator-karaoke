const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
function setup(fetch = async () => ({ok:true,json:async () => ({url:'api/media/audio?id=abcdefghijk'})})) {
  const listeners = new Map(), calls = [];
  const audio = {paused:true,ended:false,readyState:0,currentTime:0,duration:200,
    addEventListener(name,fn) { if (!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(fn); },
    removeEventListener(name,fn) { listeners.get(name)?.delete(fn); },
    load() { this.readyState=1; }, pause() {this.paused=true;}, async play() {this.paused=false;},
  };
  const context = vm.createContext({fetch,URL,URLSearchParams,AbortController,setTimeout,clearTimeout,location:new URL('http://localhost:8767/')});
  vm.runInContext(readFileSync(require.resolve('../direct-audio.js'),'utf8')+'\nthis.DirectAudio=DirectAudio;',context);
  const v = new context.DirectAudio(audio,{playback:()=>({at:42,playing:true}),connected:()=>calls.push('connected'),
    disconnected:(p,restore)=>calls.push([p.at,p.playing,restore]),changed:()=>{}});
  return {v,audio,calls,fire(name){for(const fn of listeners.get(name)||[]) fn();}};
}
test('native audio takes over at the current position and supports transport controls',async()=>{
  const {v,audio,calls}=setup();
  await v.update('abcdefghijk');
  assert.equal(v.active,true); assert.equal(audio.currentTime,42); assert.equal(v.getPlayerState(),1);
  v.seekTo(70); v.pauseVideo(); assert.equal(v.getCurrentTime(),70); assert.equal(v.getPlayerState(),2);
  v.playVideo(); v.update(null,true);
  assert.equal(v.active,false); assert.deepEqual(calls,['connected',[70,true,true]]);
});
test('an obsolete fetch cannot replace a new source or a local file',async()=>{
  let resolve;
  const {v,audio}=setup(()=>new Promise(r=>resolve=r));
  const pending=v.update('abcdefghijk');
  v.release(); audio.src='blob:own-file';
  resolve({ok:true,json:async()=>({url:'api/media/audio?id=abcdefghijk'})}); await pending;
  assert.equal(audio.src,'blob:own-file'); assert.equal(v.active,false);
});
test('preparation errors leave embedded playback available and can be retried',async()=>{
  let count=0;
  const {v}=setup(async()=>++count===1?{ok:false,json:async()=>({error:'Try again'})}:{ok:true,json:async()=>({url:'api/media/audio?id=abcdefghijk'})});
  await v.update('abcdefghijk'); assert.equal(v.active,false); assert.equal(v.error,'Try again');
  await v.update('abcdefghijk'); assert.equal(count,1);
  await v.retry(); assert.equal(v.active,true); assert.equal(count,2);
});
test('a playback error restores the embed without an endless automatic retry',async()=>{
  const {v,fire,calls}=setup(); await v.update('abcdefghijk'); fire('error');
  assert.equal(v.active,false); assert.equal(v.requested,'abcdefghijk'); assert.match(v.error,/無法播放/);
  assert.deepEqual(calls.at(-1),[42,true,true]);
});
test('unexpected remote audio URLs are rejected',async()=>{
  const {v,audio}=setup(async()=>({ok:true,json:async()=>({url:'https://untrusted.example/audio'})}));
  await v.update('abcdefghijk'); assert.equal(v.active,false); assert.equal(audio.src,undefined);
  assert.match(v.error,/Unexpected/);
});
