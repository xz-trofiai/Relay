import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { claudeDesktopAdapter } from '../src/adapters/claude-desktop.mjs';
import { desktopLineage, observeDesktops } from '../src/desktop-continuity.mjs';
import { request } from '../src/client.mjs';

const temp = t => { const p = mkdtempSync(join(tmpdir(), 'relay-continuity-')); t.after(() => rmSync(p,{recursive:true,force:true})); return p; };
const desktop = (store, alias, native, channel = 'main') => store.register({kind:'claude-desktop',alias,native_id:native,channel});
const send = (store, from, to, key = uuid()) => store.send(from.id,{recipient:to,body:'fixture',idempotency_key:key});
const snapshot = (native = uuid()) => ({native,host:'local_'+uuid(),prior:[]});

test('desktop host observation requires matching owned metadata; concurrent live owners are conflicts', async t => {
  const root = temp(t), registry=join(root,'registry'), metadata=join(root,'records');
  const dir=join(metadata,'account','workspace'); mkdirSync(dir,{recursive:true}); mkdirSync(registry);
  const current=snapshot(), older=uuid();
  const file=join(dir,current.host+'.json');
  const record={sessionId:current.host,cliSessionId:current.native,priorCliSessionIds:[older]};
  assert.equal(await desktopLineage(metadata,current.host,current.native),null);
  writeFileSync(file,JSON.stringify(record));
  assert.deepEqual(await desktopLineage(metadata,current.host,current.native),[older]);
  await assert.rejects(desktopLineage(metadata,current.host,older),/disagrees/);
  const path2=join(metadata,'account','workspace2'); mkdirSync(path2);
  symlinkSync(file,join(path2,current.host+'.json'));
  await assert.rejects(desktopLineage(metadata,current.host,current.native),/Unsafe/);
  rmSync(path2,{recursive:true});
  for (const [i,id] of [current.native,older].entries()) writeFileSync(join(registry,(900+i)+'.json'),JSON.stringify({sessionId:id,entrypoint:'claude-desktop'}));
  const obs=await observeDesktops({root:metadata,registry,discover:async id=>({native_id:id,host_session_id:current.host})});
  assert.equal(obs.length,2); assert.ok(obs.every(x=>/Overlapping/.test(x.error)));
});

test('inbound mail follows a verified rotation before recipient uses plugin; reply keeps the original identity', async t => {
  const home=mkdtempSync(join(tmpdir(),'relay-continuity-')), original=snapshot(), current=uuid();
  let seen=original; const frames=[];
  const driver=claudeDesktopAdapter({home,discover:async id=> id===seen.native ? {socket:'test',host_session_id:seen.host} : null,write:async (_,f)=>frames.push(f)});
  const daemon=await startDaemon({home,port:0,adapters:{'claude-desktop':driver},desktopObserver:async()=>[seen],desktopScanInterval:0,interval:60000});
  t.after(async()=>{await daemon.close();rmSync(home,{recursive:true,force:true});});
  const owner={url:daemon.url,token:daemon.ownerToken}, enroll=(id,opts={})=>request(owner,'/v1/enroll',{kind:'claude-desktop',native_id:id,...opts});
  await assert.rejects(enroll(original.native),/explicitly register/);
  const member=(await enroll(original.native,{alias:'website'})).endpoint;
  const peer=daemon.store.register({kind:'manual',alias:'peer',channel:'main'});
  const msg=send(daemon.store,peer,'website');
  seen={...original,native:current,prior:[original.native]};
  await daemon.tick();
  assert.equal(frames.length,1); assert.equal(frames[0].session_id,current);
  assert.equal(frames[0].uuid,msg.id); assert.match(frames[0].message.content,/session-cli.mjs/);
  const resumed=(await enroll(current)).endpoint;
  assert.equal(resumed.token,member.token); assert.equal(resumed.id,member.id); assert.equal(resumed.alias,'website');
  const reply=await request({url:daemon.url,token:member.token},'/v1/messages/'+msg.id+'/reply',{body:'response',idempotency_key:'reply'});
  assert.equal(reply.thread_id,msg.thread_id); assert.equal(reply.recipient,peer.id);
  await assert.rejects(enroll(original.native,{host:original.host,prior:[current]}),/no verified live/);
});

test('legacy split retains both addresses and active threads, without claiming historical backlog; persists on restart', t=>{
  const path=join(temp(t),'db'), old=snapshot(), next={...old,native:uuid(),prior:[old.native]};
  let store=new Store(path); t.after(()=>store.close());
  const stale=desktop(store,'website',old.native), generated='claude-'+next.native, live=desktop(store,generated,next.native);
  const peer=store.register({alias:'peer',kind:'manual',channel:'main'});
  const obsolete=send(store,peer,'website','original'), outgoing=send(store,live,peer.id), incoming=send(store,peer,live.id);
  const historical=send(store,stale,peer.id);
  const originalReceipt={...store.db.prepare('SELECT * FROM deliveries WHERE message_id=?').get(obsolete.id)};
  store.reconcileDesktop(next); store.close(); store=new Store(path);
  assert.equal(store.reconcileDesktop(next,{}).endpoint.alias,'website');
  assert.equal(store.sessions('main').length,2);
  assert.equal(store.authenticate(stale.token),undefined);
  assert.equal(store.authenticate(live.token).id,live.id);
  assert.equal(store.message(obsolete.id).recipient,stale.id);
  assert.deepEqual({...store.db.prepare('SELECT * FROM deliveries WHERE message_id=?').get(obsolete.id)},originalReceipt);
  for(const addr of ['website',generated,live.id,stale.id]) assert.equal(send(store,peer,addr).recipient,live.id);
  assert.equal(send(store,peer,'website','original').id,obsolete.id);
  for(const parent of [outgoing,historical]){
    const r=store.reply(peer.id,parent.id,{body:'answer',idempotency_key:uuid()});
    assert.equal(r.recipient,live.id);assert.equal(r.thread_id,parent.thread_id);
  }
  assert.equal(store.reply(live.id,incoming.id,{body:'ok',idempotency_key:'live-reply'}).thread_id,incoming.thread_id);
  assert.throws(()=>store.ack(live.id,obsolete.id),/Only the recipient/);
  assert.equal(store.reconcileDesktop({...next,native:uuid(),prior:[old.native,next.native]},{}).endpoint.id,live.id);
});

test('ambiguity, pause, missing lineage and cross-channel conflicts cannot create, merge or steal an identity', t=>{
  const store=new Store(join(temp(t),'db')); t.after(()=>store.close());
  const original=snapshot(), old=store.reconcileDesktop(original,{alias:'named'}).endpoint;
  store.pause(old.id,true);
  const next={...original,native:uuid(),prior:[original.native]};
  assert.throws(()=>store.reconcileDesktop({...next,prior:null},{}),/does not confirm/);
  assert.throws(()=>store.reconcileDesktop({...next,host:'local_'+uuid()},{}),/different recorded host/);
  assert.throws(()=>store.reconcileDesktop({...next,error:'two live owners'},{}),/two live owners/);
  assert.equal(store.reconcileDesktop(next,{}).endpoint.paused,1);
  const third={...next,native:uuid(),prior:[next.native]}, other=desktop(store,'claude-'+third.native,third.native,'private');
  assert.throws(()=>store.reconcileDesktop(third,{}),/cannot be safely consolidated/);
  assert.equal(store.routeId(old.id),old.id); assert.equal(store.endpoint(other.id).channel,'private');
  assert.equal(store.sessions().length,2);
});
