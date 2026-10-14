import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfiguration} from '../dist/index.js';
import {loadWorkspaceConfiguration} from '../dist/workspace/index.js';

// Creates two billable sandboxes. Save every returned ID and retain shared
// objects until both environments have been removed. No existing data is used.
const {values:v}=parseArgs({options:{config:{type:'string'},workspaceConfig:{type:'string'},provider:{type:'string'},template:{type:'string'},report:{type:'string'}}});
for(const key of ['config','workspaceConfig','provider','template','report'])if(!v[key])throw new Error('--'+key+' required');
const workspaceId=randomUUID(),owner='acceptance',refs=[];
const report={startedAt:new Date().toISOString(),workspaceId,refs,checks:[],cleanup:[]};
await mkdir(dirname(v.report),{recursive:true,mode:0o700});
const save=()=>writeFile(v.report,JSON.stringify(report,null,2)+'\n',{mode:0o600});
await writeFile(v.report,JSON.stringify(report),{flag:'wx',mode:0o600});
const p=(await loadConfiguration(v.config)).provider(v.provider),backend=await loadWorkspaceConfiguration(v.workspaceConfig);
const check=async name=>{report.checks.push(name);await save();console.log(name);};
let binding;
try{
  binding=await backend.prepare(owner,workspaceId,v.template);report.binding=binding;await save();
  for(let i=0;i<2;i++){
    const ref=await p.create({template:binding.template,timeoutSeconds:1800,metadata:{...binding.metadata,'workspace-probe':workspaceId}});
    refs.push(ref);await save();await backend.verify(p,ref.id,binding);await check(`mount-${i+1}-verified`);
  }
  const file='素材/%2f-literal.bin',path=binding.target.mountPath+'/'+file,bytes=Uint8Array.from([0,255,128,10,13,42]);
  let exit;for await(const _ of p.exec(refs[0].id,['mkdir','-p',binding.target.mountPath+'/素材'],{onExit:r=>exit=r.exitCode})){}
  assert.equal(exit,0);await p.writeFile(refs[0].id,path,bytes);
  assert.deepEqual(await p.readFile(refs[1].id,path),bytes);
  assert.deepEqual((await backend.store.get(owner,workspaceId,file)).body,bytes);
  assert.equal(await backend.store.get('different-owner',workspaceId,file),null);
  await check('two-containers-shared-bytes-and-owner-isolation');
  const url=await backend.store.createSignedReadUrl(owner,workspaceId,file,60,{download:true});
  const download=await fetch(url);assert.equal(download.status,200);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  await check('signed-public-download');
  await p.writeFile(refs[0].id,'/home/user/private-snapshot-marker','native-state-retained');
  await p.pause(refs[0].id);
  const deadline=Date.now()+180000;
  while((await p.info(refs[0].id)).state!=='paused'){if(Date.now()>deadline)throw new Error('pause timeout');await delay(2000);}
  const restored=(await loadConfiguration(v.config)).provider(v.provider);
  await restored.resume(refs[0].id,1800);await backend.verify(restored,refs[0].id,binding);
  assert.equal(new TextDecoder().decode(await restored.readFile(refs[0].id,'/home/user/private-snapshot-marker')),'native-state-retained');
  assert.deepEqual(await restored.readFile(refs[0].id,path),bytes);
  await check('same-id-resume-retains-private-and-shared-data');
  for(const ref of refs){await restored.destroy(ref.id);report.cleanup.push(ref.id);await save();}
  assert.deepEqual((await backend.store.get(owner,workspaceId,file)).body,bytes);
  await check('workspace-survives-both-environments');
  await backend.store.delete(owner,workspaceId,file);report.passed=true;
}catch(error){report.failure=error?.code??error?.name??'probe_failed';report.status=error?.statusCode;process.exitCode=1;console.error('Workspace acceptance failed; inspect private report.');}
finally{
  for(const ref of refs.filter(r=>!report.cleanup.includes(r.id))){try{await p.destroy(ref.id);report.cleanup.push(ref.id);}catch{report.cleanupUnconfirmed=true;process.exitCode=1;}}
  report.finishedAt=new Date().toISOString();await save();
}
