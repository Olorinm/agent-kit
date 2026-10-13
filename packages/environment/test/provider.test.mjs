import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAlibabaProvider, createVolcengineProvider, ExecutionAbortedBeforeStart, EnvironmentManager } from '../dist/index.js';
import { createOmaSandboxClient } from '../dist/oma.js';
import { fixture, collect } from './fixture.mjs';
import { SandboxError } from 'e2b';

function setup(factory = createAlibabaProvider) {
  const f = fixture();
  return {...f, provider: factory({id: 'cloud', domain: 'example.invalid', apiKey: 'fixture-key', driver: f.driver})};
}
for (const factory of [createAlibabaProvider, createVolcengineProvider]) {
  test(factory.name + ': durable refs, explicit resume, no replacement on missing', async () => {
    const f = setup(factory), p = f.provider;
    const ref = await p.create({template: 'node', timeoutSeconds: 60, metadata: {owner: 'a'}});
    assert.equal(f.calls.find(c => c[0] === 'create')[2].apiUrl,
      factory === createAlibabaProvider ? 'https://api.example.invalid' : 'https://example.invalid');
    assert.deepEqual(Object.keys(ref).sort(), ['id','provider']);
    await p.pause(ref.id);
    await assert.rejects(collect(p.exec(ref.id, ['true'])), {code: 'environment_not_running'});
    const restored = factory({id:'cloud', domain:'example.invalid', apiKey:'fixture-key', driver:f.driver});
    assert.equal((await restored.resume(ref.id)).state, 'running');
    await restored.setTimeout(ref.id, 42);
    assert.equal(f.calls.filter(c => c[0] === 'timeout').at(-1)[2], 42000);
    assert.equal((await restored.list({owner:'other'})).length, 0);
    await restored.destroy(ref.id); await restored.destroy(ref.id);
    await assert.rejects(restored.resume(ref.id), {code:'environment_missing'});
    assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  });
}
test('provider capabilities reject unsupported lifecycle and foreign mounts before dispatch', async () => {
  const {provider:p, calls} = setup(createVolcengineProvider);
  await assert.rejects(p.create({template:'node',onTimeout:'pause'}), {code:'unsupported_capability'});
  await assert.rejects(p.create({template:'node',metadata:{'e2b.agents.kruise.io/csi-volume-config':'{}'}}), {code:'foreign_metadata'});
  assert.equal(calls.length,0);
});
test('Volcengine flushes completed writes before pause and refuses an unsuccessful flush', async () => {
  const f=setup(createVolcengineProvider);const {id}=await f.provider.create({template:'node'});
  await f.provider.pause(id);
  assert.ok(f.calls.findIndex(c=>c[0]==='exec'&&c[1]==="exec -- 'sync'") < f.calls.findIndex(c=>c[0]==='pause'));
  await f.provider.pause(id);assert.equal(f.calls.filter(c=>c[0]==='pause').length,1);
  const bad=setup(createVolcengineProvider),create=bad.driver.create;
  bad.driver.create=async(...args)=>{const h=await create(...args);return {...h,commands:{run:async()=>({wait:async()=>({exitCode:1}),kill:async()=>true,disconnect:async()=>{}})}};};
  const b=await bad.provider.create({template:'node'});
  await assert.rejects(bad.provider.pause(b.id),{code:'pause_flush_failed'});
  assert.equal(bad.calls.some(c=>c[0]==='pause'),false);
});
test('status transport failure is never missing, unknown create is never retried', async () => {
  const f = setup(); f.driver.info = async () => { throw new Error('secret transport error'); };
  await assert.rejects(f.provider.info('id'), {code:'status_unavailable',message:'Environment status could not be read.'});
  let attempts=0; f.driver.create=async()=>{attempts++;throw new Error('secret');};
  await assert.rejects(f.provider.create({template:'node'}), {code:'create_unknown',outcomeUnknown:true});
  assert.equal(attempts,1);
});
test('accepted deletion with an unavailable status remains an uncertain mutation', async () => {
  const f=setup();const {id}=await f.provider.create({template:'node'});
  f.driver.info=async()=>{throw new Error('transport lost');};
  await assert.rejects(f.provider.destroy(id),{code:'delete_unknown',outcomeUnknown:true});
  assert.equal(f.records.has(id),false);
});
test('Volcengine missing response normalization never hides gateway failures or another ID', async () => {
  const f=setup(createVolcengineProvider);
  for(const message of ['404: route not found','404: Sandbox owner not found: another-id','403: Sandbox owner not found: id']) {
    f.driver.info=async()=>{throw new SandboxError(message);};
    await assert.rejects(f.provider.info('id'),{code:'status_unavailable'});
  }
  f.driver.info=async()=>{throw new SandboxError('404: Sandbox owner not found: id');};
  assert.equal((await f.provider.info('id')).state,'missing');
  const ali=setup();ali.driver.info=f.driver.info;
  await assert.rejects(ali.provider.info('id'),{code:'status_unavailable'});
});
test('argv fidelity, output separation, nonzero exit, and disabled timeout', async () => {
  const {provider:p,calls} = setup(); const {id} = await p.create({template:'node'});
  const args = ['', "it's a test", '$(echo injection)', '; touch forbidden', 'line\nline', '奶茶'];
  let exit;
  const chunks = await collect(p.exec(id, [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write("error");process.exitCode=7', ...args], {timeoutSeconds:0,onExit:e=>exit=e}));
  assert.deepEqual(JSON.parse(chunks.filter(c=>c.stream==='stdout').map(c=>c.text).join('')),args);
  assert.equal(chunks.filter(c=>c.stream==='stderr').map(c=>c.text).join(''),'error');
  assert.equal(exit.exitCode,7); assert.equal(p.hasUncertainExecution(id),false);
  assert.equal(calls.find(c=>c[0]==='exec')[2].timeoutMs,0);
});
test('pre-abort starts nothing; mid-stream abort kills and observes exit', async () => {
  const f=setup(),p=f.provider;const {id}=await p.create({template:'node'});
  await assert.rejects(collect(p.exec(id,['true'],{signal:AbortSignal.abort()})),ExecutionAbortedBeforeStart);
  assert.equal(f.calls.some(c=>c[0]==='exec'),false);
  let exit; const controller=new AbortController();
  await assert.rejects(async()=>{
    for await(const chunk of p.exec(id,[process.execPath,'-e','console.log("ready");setInterval(()=>{},1000)'],{signal:controller.signal,onExit:e=>exit=e})) controller.abort();
  },{name:'AbortError'});
  assert.equal(f.running.size,0);assert.equal(typeof exit.exitCode,'number');assert.equal(p.hasUncertainExecution(id),false);
});
test('abandoning output cancels process; transport loss marks uncertain without synthetic exit', async () => {
  const f=setup(),p=f.provider;const {id}=await p.create({template:'node'});
  for await(const chunk of p.exec(id,[process.execPath,'-e','console.log("ready");setInterval(()=>{},1000)'])) break;
  assert.equal(f.running.size,0);
  const bad=setup();bad.driver.create=async()=>({sandboxId:'lost',commands:{run:async()=>{throw new Error('transport');}}});
  await bad.provider.create({template:'node'});let exit;
  await assert.rejects(collect(bad.provider.exec('lost',['true'],{onExit:e=>exit=e})),{code:'execution_unknown'});
  assert.equal(exit,undefined);assert.equal(bad.provider.hasUncertainExecution('lost'),true);
});
test('exact bytes, recursive names including newline, symlinks, missing roots', async t => {
  const root=await mkdtemp(join(tmpdir(),'agent-environment-files-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {provider:p}=setup();const {id}=await p.create({template:'node'});
  const bytes=Uint8Array.from([99,0,255,128,1,88]).subarray(1,5), path=join(root,'nested','a\nb');
  await p.writeFile(id,path,bytes);assert.deepEqual([...await p.readFile(id,path)],[...bytes]);
  await symlink(root,join(root,'loop'));
  assert.deepEqual((await p.listFiles(id,root)).map(f=>f.path),[path]);
  await p.removeFile(id,join(root,'missing'));
  assert.deepEqual(await p.listFiles(id,join(root,'missing'),true),[]);
  await assert.rejects(p.listFiles(id,join(root,'missing')));
});
test('cancellation during startup kills the late handle and does not claim an unobserved exit',async()=>{
  const f=setup(),abort=new AbortController();let killed=0,exit;
  f.driver.create=async()=>({sandboxId:'late',commands:{run:async()=>{
    abort.abort();
    return {kill:async()=>{killed++;throw new Error('connection lost');},wait:()=>new Promise(()=>{}),disconnect:async()=>{}};
  }}});
  await f.provider.create({template:'node'});
  await assert.rejects(collect(f.provider.exec('late',['true'],{signal:abort.signal,onExit:e=>exit=e})),{code:'execution_unknown'});
  assert.equal(killed,1);assert.equal(exit,undefined);assert.equal(f.provider.hasUncertainExecution('late'),true);
});
test('cancel acknowledgement without observed exit has a bounded wait',async t=>{
  const f=setup(),abort=new AbortController();let killed,exit;
  const started=new Promise(resolve=>killed=resolve);
  f.driver.create=async()=>({sandboxId:'late',commands:{run:async()=>({
    kill:async()=>{killed();return true;},wait:()=>new Promise(()=>{}),disconnect:async()=>{},
  })}});
  await f.provider.create({template:'node'});
  t.mock.timers.enable({apis:['setTimeout']});
  const result=collect(f.provider.exec('late',['true'],{signal:abort.signal,onExit:e=>exit=e}));
  await Promise.resolve();await Promise.resolve();abort.abort();await started;
  t.mock.timers.tick(10_001);
  await assert.rejects(result,{code:'execution_unknown'});assert.equal(exit,undefined);
});
test('OMA preserves trusted mount coordinates, filesystem hooks and cancellation class', async () => {
  const {provider}=setup();let checks=[];
  class OmaAbort extends Error {}
  const oma=createOmaSandboxClient({provider,defaultTemplate:'node',fileSystem:b=>b,abortedBeforeStart:()=>new OmaAbort(),
    mapCreate:r=>({...r,metadata:{cloud:'mapped'}}),verifyWorkspaceMount:async(ref,target,metadata)=>{checks.push({...metadata});}});
  const {id}=await oma.create({metadata:{owner:'a'}});await oma.verifyWorkspaceMount(id,{mountPath:'/w',bucket:'b',prefix:'a/'});
  await oma.reconnect(id,{owner:'a'});await oma.verifyWorkspaceMount(id,{mountPath:'/w',bucket:'b',prefix:'a/'});
  assert.deepEqual(checks,[{owner:'a'},{owner:'a'}]);
  assert.equal(oma.fileSystem(id),oma.fileSystem(id));
  await assert.rejects(collect(oma.exec(id,['true'],{signal:AbortSignal.abort()})),OmaAbort);
  await assert.rejects(oma.verifyWorkspaceMount('other',{}),{code:'unbound_environment'});
  assert.throws(()=>new EnvironmentManager([provider,provider]),{code:'duplicate_provider'});
});


test('application endpoints use SDK host and traffic token, never cloud/envd credentials', async () => {
  const f = fixture();
  const provider = createVolcengineProvider({id: 'volc', apiKey: 'private-cloud-key', domain: 'fixture', driver: f.driver});
  const ref = await provider.create({template: 'tools'});
  const endpoint = await provider.httpEndpoint(ref.id, 37420);
  assert.deepEqual(endpoint, {url: `https://37420-${ref.id}.sandbox.fixture`, headers: {'e2b-traffic-access-token': 'fixture-traffic-token'}});
  assert.ok(!JSON.stringify(endpoint).includes('private-cloud-key'));
  await assert.rejects(provider.httpEndpoint(ref.id, 0), /port/i);
  const proxy = createVolcengineProvider({id:'proxy', apiKey:'secret',domain:'fixture',serviceUrl:'http://127.0.0.1:8080/gateway',allowHttp:true,driver:f.driver});
  const routed = await proxy.httpEndpoint(ref.id, 37420);
  assert.equal(routed.url, 'http://127.0.0.1:8080/gateway');
  assert.equal(routed.headers['E2b-Sandbox-Id'], ref.id);
  assert.equal(routed.headers['E2b-Sandbox-Port'], '37420');
  assert.equal(routed.headers.Authorization, undefined);
});
