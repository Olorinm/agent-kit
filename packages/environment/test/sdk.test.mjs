import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createAlibabaProvider,createVolcengineProvider} from '../dist/index.js';
import {sdkDriver} from '../dist/driver.js';

for (const factory of [createAlibabaProvider,createVolcengineProvider]) {
  test(factory.name+': real E2B SDK HTTP contract and pagination',async t=>{
    const calls=[];let state='running',deleted=false;
    const record={sandboxID:'sandbox-fixture',templateID:'template-fixture',envdVersion:'0.4.5',envdAccessToken:'fixture-envd-secret',startedAt:new Date().toISOString(),endAt:new Date(Date.now()+60000).toISOString(),metadata:{owner:'alice'},cpuCount:1,memoryMB:512};
    const server=createServer(async(req,res)=>{
      let data='';for await(const chunk of req)data+=chunk;
      const url=new URL(req.url,'http://fixture');calls.push({method:req.method,path:url.pathname,query:url.searchParams,headers:req.headers,body:data?JSON.parse(data):undefined});
      res.setHeader('content-type','application/json');
      if(req.headers['x-api-key']!=='fixture-api-key'){res.writeHead(401);res.end('{"code":401,"message":"unauthorized"}');return;}
      if(url.pathname==='/v2/sandboxes'){
        if(!url.searchParams.has('nextToken')){res.setHeader('x-next-token','second');res.end(JSON.stringify([{...record,state}]));}
        else res.end(JSON.stringify([{...record,sandboxID:'other',metadata:{owner:'bob'},state}]));return;
      }
      if(req.method==='DELETE'){deleted=true;res.writeHead(204);res.end();return;}
      if(deleted){res.writeHead(404);res.end(JSON.stringify(factory===createVolcengineProvider
        ? {code:'NOT_FOUND',message:'Sandbox owner not found: sandbox-fixture'}
        : {code:404,message:'missing'}));return;}
      if(url.pathname.endsWith('/pause')){state='paused';res.writeHead(204);res.end();return;}
      if(url.pathname.endsWith('/timeout')){res.writeHead(204);res.end();return;}
      if(url.pathname.endsWith('/connect'))state='running';
      res.end(JSON.stringify({...record,state}));
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
    // This fixture tests real SDK control-plane HTTP; the envd process stream
    // has its own execution tests and live acceptance probe.
    const driver={...sdkDriver,create:async(...args)=>{
      const handle=await sdkDriver.create(...args);
      return {sandboxId:handle.sandboxId,files:handle.files,commands:{run:async command=>{
        assert.equal(command,"exec 'sync'");
        return {wait:async()=>({exitCode:0}),kill:async()=>true,disconnect:async()=>{}};
      }}};
    }};
    const provider=factory({id:'fixture',apiKey:'fixture-api-key',apiUrl:`http://127.0.0.1:${server.address().port}`,allowHttp:true,pausedRetention:'1h',driver});
    const ref=await provider.create({template:'template-fixture',timeoutSeconds:12,metadata:{owner:'alice'},env:{TEST:'value'},onTimeout:factory===createAlibabaProvider?'pause':'kill'});
    assert.deepEqual(ref,{provider:'fixture',id:'sandbox-fixture'});
    const creation=calls[0];assert.equal(creation.path,'/sandboxes');assert.equal(creation.body.timeout,12);
    assert.equal(creation.body.secure,true);assert.equal(creation.body.templateID,'template-fixture');
    assert.equal(creation.body.autoPause,factory===createAlibabaProvider);assert.deepEqual(creation.body.autoResume,{enabled:false});
    assert.deepEqual(creation.body.envVars,{TEST:'value'});
    assert.equal(JSON.stringify(await provider.info(ref.id)).includes('fixture-envd-secret'),false);
    assert.equal((await provider.list({owner:'alice'})).length,1);
    assert.equal(calls.filter(c=>c.path==='/v2/sandboxes').length,2);
    await provider.pause(ref.id);assert.equal((await provider.info(ref.id)).state,'paused');
    await provider.resume(ref.id,25);assert.equal(calls.find(c=>c.path.endsWith('/connect')).body.timeout,25);
    assert.equal(calls.find(c=>c.path.endsWith('/timeout')).body.timeout,25);
    await provider.setTimeout(ref.id,31);assert.equal(calls.filter(c=>c.path.endsWith('/timeout')).at(-1).body.timeout,31);
    await provider.destroy(ref.id);await provider.destroy(ref.id);
    assert.equal((await provider.info(ref.id)).state,'missing');
  });
}
test('ambient SDK overrides fail closed before any request',async()=>{
  const previous=process.env.E2B_SANDBOX_URL;process.env.E2B_SANDBOX_URL='https://other.invalid';
  try{
    const p=createAlibabaProvider({id:'a',domain:'expected.invalid',apiKey:'fixture'});
    await assert.rejects(p.create({template:'node'}),{code:'create_unknown'});
  }finally{if(previous===undefined)delete process.env.E2B_SANDBOX_URL;else process.env.E2B_SANDBOX_URL=previous;}
});
