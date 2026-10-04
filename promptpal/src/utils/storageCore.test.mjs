import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStorage, FILES, LEGACY} from './storageCore.ts';
function fixture() {
 const files=new Map(); let failWrite=false; let failRemove=false;
 const io={read:async p=>files.get(p)??null, write:async(p,t)=>{if(failWrite){files.set(p,t.slice(0,12));throw Error('disk');}files.set(p,t);}, remove:async p=>{if(failRemove)throw Error('denied');files.delete(p);}};
 const validate=v=>{if(!v || typeof v.n!=='number')throw Error('invalid');return {n:v.n};};
 return {files, engine:()=>createStorage(io,{n:0},validate,validate), failWrite:()=>failWrite=true, failRemove:()=>failRemove=true, repair:()=>{failWrite=false;failRemove=false;}};
}
test('new installation and shared initialization',async()=>{const f=fixture(),e=f.engine(); assert.equal(e.load(),e.load());assert.equal((await e.load()).isReadOnly,false);assert.equal(f.files.size,0);});
test('alternating saves survive fresh load',async()=>{const f=fixture(),e=f.engine();await e.load();assert.equal((await e.save({n:1})).success,true);await e.save({n:2});assert.equal((await f.engine().load()).snapshot.n,2);assert.equal(f.files.size,2);});
test('partial write preserves previous snapshot and locks mutation',async()=>{const f=fixture(),e=f.engine();await e.load();await e.save({n:1});const old=f.files.get(FILES[0]);f.failWrite();assert.equal((await e.save({n:2})).fatal,true);assert.equal(f.files.get(FILES[0]),old);const restored=await f.engine().load();assert.equal(restored.snapshot.n,1);assert.equal(restored.isReadOnly,true);});
test('invalid payload is rejected before writing',async()=>{const f=fixture(),e=f.engine();await e.load();assert.equal((await e.save(null)).success,false);assert.equal(f.files.size,0);});
test('checksum mismatch is read-only and bytes retained',async()=>{const f=fixture(),e=f.engine();await e.load();await e.save({n:1});f.files.set(FILES[0],f.files.get(FILES[0]).replace('\\"n\\":1','\\"n\\":9'));const before=f.files.get(FILES[0]);assert.equal((await f.engine().load()).isReadOnly,true);assert.equal(f.files.get(FILES[0]),before);});
test('valid legacy loaded without overwriting source',async()=>{const f=fixture();f.files.set(LEGACY[0],'{"n":7}');const e=f.engine();assert.equal((await e.load()).snapshot.n,7);await e.save({n:8});assert.equal(f.files.get(LEGACY[0]),'{"n":7}');});
test('bad primary and valid legacy backup recover read-only',async()=>{const f=fixture();f.files.set(LEGACY[0],'bad');f.files.set(LEGACY[1],'{"n":4}');const r=await f.engine().load();assert.equal(r.snapshot.n,4);assert.equal(r.isReadOnly,true);});
test('reset handles unreadable JSON without loading plugin store',async()=>{const f=fixture();f.files.set(FILES[0],'bad');f.files.set(LEGACY[3],'old');const e=f.engine();await e.load();await e.reset();assert.equal(f.files.size,1);assert.equal((await f.engine().load()).snapshot.n,0);});
test('interrupted reset blocks old data until retry succeeds',async()=>{const f=fixture(),e=f.engine();await e.load();await e.save({n:8});f.failRemove();await assert.rejects(e.reset());const fresh=f.engine();const result=await fresh.load();assert.equal(result.isReadOnly,true);assert.equal(result.snapshot.n,0);f.repair();await fresh.reset();assert.equal((await f.engine().load()).isReadOnly,false);});
test('overlapping writes are refused',async()=>{const f=fixture(),e=f.engine();await e.load();const first=e.save({n:1});assert.equal((await e.save({n:2})).success,false);assert.equal((await first).success,true);});
