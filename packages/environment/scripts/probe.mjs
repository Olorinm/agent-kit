import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve,posix} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfiguration} from '../dist/index.js';

// This intentionally provisions one BILLABLE environment and destroys only it.
const {values:v}=parseArgs({options:{config:{type:'string'},provider:{type:'string'},template:{type:'string'},workspace:{type:'string'},report:{type:'string'}}});
for(const key of ['config','provider','template','workspace','report'])if(!v[key])throw new Error('--'+key+' is required');
if(!v.workspace.startsWith('/'))throw new Error('--workspace must be an absolute, template-mounted durable directory');
const manager=await loadConfiguration(v.config),provider=manager.provider(v.provider),probeId=randomUUID();
const reportPath=resolve(v.report);await mkdir(dirname(reportPath),{recursive:true,mode:0o700});
const report={probeId,provider:provider.id,startedAt:new Date().toISOString(),checks:[],cleanup:'not-created'};
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
const record=async name=>{report.checks.push(name);await save();console.log(name);};
const stage=async name=>{report.stage=name;await save();console.log('Starting '+name);};
let ref;
try{
  await stage('create');
  report.cleanup='creation-outcome-unknown';await save();
  ref=await provider.create({template:v.template,timeoutSeconds:600,metadata:{'agent-environment-probe':probeId}});
  report.ref=ref;report.cleanup='required';await save();
  const path=posix.join(v.workspace,'agent-environment-probe-'+probeId+'.bin');
  const bytes=Uint8Array.from([0,255,128,1,10,13,42]);
  await stage('binary-files');
  await provider.writeFile(ref.id,path,bytes);assert.deepEqual([...await provider.readFile(ref.id,path)],[...bytes]);await record('binary-files');
  await stage('exec');
  let exit,output='';for await(const chunk of provider.exec(ref.id,['printf','%s','kernel-independent'],{onExit:e=>exit=e}))if(chunk.stream==='stdout')output+=chunk.text;
  assert.equal(exit.exitCode,0);assert.equal(output,'kernel-independent');await record('exec');
  await stage('list');
  const found=await provider.list({'agent-environment-probe':probeId});assert.ok(found.some(item=>item.id===ref.id));await record('list');
  await stage('pause');
  await provider.pause(ref.id);
  const deadline=Date.now()+180000;
  while((await provider.info(ref.id)).state!=='paused'){if(Date.now()>deadline)throw new Error('pause deadline');await delay(3000);}
  await record('pause-observed');
  await stage('resume');
  const restored=(await loadConfiguration(v.config)).provider(v.provider);
  assert.equal((await restored.resume(ref.id,600)).state,'running');
  assert.deepEqual([...await restored.readFile(ref.id,path)],[...bytes]);await record('resume-existing-id-and-durable-bytes');
  await restored.removeFile(ref.id,path);
}catch(error){
  report.failure=error?.code??'probe_failed';report.failureType=error?.name??'Error';process.exitCode=1;
  console.error('Probe failed. Inspect the private report and cloud resources before retrying.');
}finally{
  if(ref){try{await provider.destroy(ref.id);report.cleanup='confirmed-missing';}catch{report.cleanup='unconfirmed';process.exitCode=1;console.error('Cleanup unconfirmed; inspect environment '+ref.id);}}
  report.finishedAt=new Date().toISOString();await save();
}
