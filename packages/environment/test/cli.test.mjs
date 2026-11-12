import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const cli=resolve(import.meta.dirname,'../dist/cli.js');
const invoke=args=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,[cli,...args]);let stdout='',stderr='';
  p.stdout.on('data',c=>stdout+=c);p.stderr.on('data',c=>stderr+=c);p.once('error',reject);
  p.once('close',code=>resolve({code,stdout,stderr}));
});
test('CLI isolates key files, reads status without waking, and suppresses provider secrets',async t=>{
  const root=await mkdtemp(join(tmpdir(),'agent-environment-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const key='fixture-private-api-key';let calls=0;
  const server=createServer((req,res)=>{
    calls++;assert.equal(req.method,'GET');assert.equal(req.headers['x-environment-control'],key);
    res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'status_unavailable',message:'Do not expose '+key}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const keyFile=join(root,'api.key'),config=join(root,'providers.json');
  await writeFile(keyFile,key,{mode:0o600});
  await writeFile(config,JSON.stringify({providers:[{kind:'cloudflare',id:'test',apiUrl:`http://127.0.0.1:${server.address().port}`,apiKeyFile:'api.key',allowHttp:true}]}));
  const result=await invoke(['info','--config',config,'--provider','test','--id','e85982d9-ea40-4be4-9646-02c07b7109d2']);
  assert.equal(result.code,1);assert.equal(calls,1);assert.equal(result.stdout,'');
  assert.equal(result.stderr.includes(key),false);assert.equal(JSON.parse(result.stderr).error,'status_unavailable');
  if(process.platform!=='win32'){
    await chmod(keyFile,0o644);
    const insecure=await invoke(['info','--config',config,'--provider','test','--id','e85982d9-ea40-4be4-9646-02c07b7109d2']);
    assert.equal(JSON.parse(insecure.stderr).error,'insecure_key_file');assert.equal(calls,1);
  }
});

test('configuration accepts only supported provider kinds',async t=>{
  const root=await mkdtemp(join(tmpdir(),'agent-environment-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'api.key'),'key',{mode:0o600});
  await writeFile(join(root,'providers.json'),JSON.stringify({providers:[{kind:'unknown',id:'x',apiKeyFile:'api.key'}]}));
  const result=await invoke(['list','--config',join(root,'providers.json'),'--provider','x']);
  assert.equal(result.code,1);assert.equal(JSON.parse(result.stderr).error,'invalid_config');
});
