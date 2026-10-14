import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TOSArtifactStore,VolcengineWorkspaceBackend,WorkspaceMountUnavailable} from '../dist/workspace/index.js';

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'volc-workspace-'));
  const file=join(dir,'kubeconfig');
  writeFileSync(file,JSON.stringify({apiVersion:'v1',kind:'Config',clusters:[{name:'test',cluster:{server:'https://cluster.invalid'}}],users:[{name:'test',user:{token:'fixture'}}],contexts:[{name:'test',context:{cluster:'test',user:'test',namespace:'default'}}],'current-context':'test'}));
  const store=new TOSArtifactStore({bucket:'workspace-fixture',region:'cn-shanghai',accessKeyId:'fixture',accessKeySecret:'fixture'});
  const backend=new VolcengineWorkspaceBackend(store,{kubeconfigFile:file,namespace:'default',secretName:'storage',region:'cn-shanghai',uid:1001,gid:1001});
  const resources=new Map();
  const base={spec:{podTemplate:{metadata:{annotations:{'vci.volcengine.com/persistent-container':'true'}},spec:{automountServiceAccountToken:false,containers:[{name:'main',image:'example.invalid/host@sha256:fixture'}]}}}};
  const create=kind=>async({body})=>{const key=kind+'/'+body.metadata.name;if(resources.has(key))throw {code:409};const value=structuredClone(body);if(kind==='pv')delete value.spec.storageClassName;resources.set(key,value);return value;};
  const get=kind=>async({name})=>resources.get(kind+'/'+name);
  backend.core={createPersistentVolume:create('pv'),readPersistentVolume:get('pv'),createNamespacedPersistentVolumeClaim:create('pvc'),readNamespacedPersistentVolumeClaim:get('pvc'),readNamespacedPod:get('pod')};
  backend.custom={createNamespacedCustomObject:create('template'),getNamespacedCustomObject:async({name})=>name==='base'?base:resources.get('template/'+name)};
  return {backend,store,resources,base,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('static TOS templates isolate prefixes, preserve snapshot policy and reconcile repeated preparation',async()=>{
  const f=fixture();try{
    const a=await f.backend.prepare('owner','team','default--base');
    assert.deepEqual(await f.backend.prepare('owner','team','default--base'),a);
    const other=await f.backend.prepare('other','team','default--base');assert.notEqual(other.volume,a.volume);
    const template=f.resources.get('template/'+a.template.split('--')[1]);
    assert.equal(template.spec.podTemplate.metadata.annotations['vci.volcengine.com/persistent-container'],'true');
    assert.equal(f.resources.get('pv/'+a.volume).spec.csi.volumeAttributes.path,'/owner/team');
    f.resources.get('pv/'+a.volume).spec.csi.volumeAttributes.path='/other/team';
    await assert.rejects(f.backend.prepare('owner','team','default--base'),/conflicts/);
    await assert.rejects(f.backend.prepare('owner','team','other--base'));
  }finally{f.close();}
});
test('actual pod and PV authorization are required before any writable mount probe',async()=>{
  const f=fixture();try{
    const b=await f.backend.prepare('owner','team','default--base');let executions=0;
    const p={info:async()=>({state:'running',metadata:b.metadata}),async *exec(){executions++;}};
    f.resources.set('pod/sbx-test',{spec:{containers:[{volumeMounts:[{name:'workspace',mountPath:'/home/user/workspace'}]}],volumes:[{name:'workspace',persistentVolumeClaim:{claimName:'wrong'}}]}});
    await assert.rejects(f.backend.verify(p,'default--sbx-test',b),WorkspaceMountUnavailable);assert.equal(executions,0);
    f.resources.get('pod/sbx-test').spec.volumes[0].persistentVolumeClaim.claimName=b.volume;
    f.resources.get('pv/'+b.volume).spec.csi.volumeAttributes.bucket='other';
    await assert.rejects(f.backend.verify(p,'default--sbx-test',b),WorkspaceMountUnavailable);assert.equal(executions,0);
  }finally{f.close();}
});
test('TOS signed downloads use public endpoints and storage errors do not become missing files',async()=>{
 const f=fixture();try{
   const signed=new URL(await f.store.createSignedReadUrl('owner','team','素材/%2f.txt',60,{download:true}));
   assert.equal(signed.protocol,'https:');assert.equal(signed.hostname,'workspace-fixture.tos-cn-shanghai.volces.com');assert.ok(signed.pathname.includes('%252f'));
   await assert.rejects(f.store.createSignedReadUrl('owner','team','../private',60));
   await assert.rejects(f.store.createSignedReadUrl('owner','team','file',901));
   f.store.client.headObject=async()=>{throw {statusCode:404};};
   f.store.client.headBucket=async()=>{throw {code:'NoSuchBucket',statusCode:404};};
   await assert.rejects(f.store.stat('owner','team','missing'),{code:'NoSuchBucket'});
   f.store.client.headBucket=async()=>({});assert.equal(await f.store.stat('owner','team','missing'),null);
   f.store.client.getObjectV2=async()=>{throw {statusCode:404};};
   assert.equal(await f.store.get('owner','team','missing'),null);
   f.store.client.headBucket=async()=>{throw {statusCode:404};};
   await assert.rejects(f.store.get('owner','team','missing'),{statusCode:404});
   f.store.client.getObjectV2=async()=>{throw {code:'AccessDenied',statusCode:403};};
   await assert.rejects(f.store.get('owner','team','file'),{code:'AccessDenied'});
 }finally{f.close();}
});
test('TOS listing follows bounded continuation batches without unsigned local options',async()=>{
 const f=fixture();try{
   const calls=[];
   f.store.client.listObjectsType2=async input=>{
     calls.push(input);assert.ok(!('listOnlyOnce' in input));
     return {data:input.continuationToken
       ?{Contents:[{Key:'owner/team/b',Size:2,LastModified:'2026-01-01'}],IsTruncated:false}
       :{Contents:[{Key:'owner/team/.oma-workspace-checks/probe',Size:64},{Key:'owner/team/a',Size:1,LastModified:'2026-01-01'}],IsTruncated:true,NextContinuationToken:'next'}};
   };
   assert.deepEqual((await f.store.list('owner','team')).map(x=>x.path),['a','b']);
   assert.equal(calls.length,2);assert.equal(calls[1].continuationToken,'next');
   f.store.client.listObjectsType2=async()=>({data:{Contents:[],IsTruncated:true,NextContinuationToken:'repeated'}});
   await assert.rejects(f.store.list('owner','team'),/continuation/);
   f.store.client.listObjectsType2=async()=>({data:{Contents:[{Key:'other/team/file'}]}});
   await assert.rejects(f.store.list('owner','team'),/outside/);
 }finally{f.close();}
});
