import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {stripTypeScriptTypes} from 'node:module';
// The real ingress object with the Cloudflare runtime replaced by in-memory storage and bucket.
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const runtime=moduleUrl('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const source=stripTypeScriptTypes(await readFile(new URL('../src/index.ts',import.meta.url),'utf8'),{mode:'transform'})
 .replace("from 'cloudflare:workers'",`from '${runtime}'`).replace("from '../../src/security.mjs'",`from '${new URL('../../src/security.mjs',import.meta.url)}'`).replace("from './policy.mjs'",`from '${new URL('../src/policy.mjs',import.meta.url)}'`);
const {BackupIngress}=await import(moduleUrl(source));
const sha=data=>createHash('sha256').update(data).digest('hex'),prefix='daily/router/2026-01-10-11111111-1111-4111-8111-111111111111/';
const age=Buffer.from(['age-encryption.org/v1','-> X25519 '+'A'.repeat(43),'B'.repeat(43),'--- '+'M'.repeat(43),'ciphertext'].join('\n'));
function fixture(env={}) {
 const state=new Map(),objects=new Map();
 const storage={async get(key){return state.get(key);},async put(key,value){if(typeof key==='string')state.set(key,value);else for(const [k,v] of Object.entries(key))state.set(k,v);},async transaction(work){return work(storage);}};
 const BACKUPS={
  async head(key){return objects.get(key)??null;},
  async get(key,options){const object=objects.get(key);if(!object)return null;const {offset,length}=options.range;return {arrayBuffer:async()=>Uint8Array.from(object.data.subarray(offset,offset+length)).buffer};},
  async put(key,body,options){if(objects.has(key))return null;const data=Buffer.from(typeof body==='string'?body:await new Response(body).arrayBuffer());
   if(sha(data)!==options.sha256)throw Error('checksum');objects.set(key,{data,size:data.length,customMetadata:options.customMetadata});return {key};}};
 const ingress=new BackupIngress({storage},{BACKUPS,...env});
 const put=(name,data,headers={})=>ingress.fetch(new Request('https://ingress.test/v1/upload/'+prefix+name,{method:'PUT',body:data,headers:{'Content-Length':String(data.length),'X-Content-SHA256':sha(data),...headers}}));
 const manifest=(parts,extra={})=>Buffer.from(JSON.stringify({format:'age-v1-chunks',recipient:'age1ours',encryptedBytes:parts.reduce((n,p)=>n+p.length,0),parts:parts.map((p,i)=>({name:String(i).padStart(5,'0')+'.agepart',bytes:p.length,sha256:sha(p)})),...extra}));
 return {state,objects,ingress,put,manifest,usage:()=>state.get('usage')};
}
test('a committed archive counts toward the daily quota and updates the status',async()=>{
 const f=fixture({BACKUP_RECIPIENTS:'["age1ours"]'}),second=Buffer.from('more ciphertext');
 assert.deepEqual(await(await f.put('00000.agepart',age)).json(),{ok:true});assert.deepEqual(await(await f.put('00001.agepart',second)).json(),{ok:true});
 const manifest=f.manifest([age,second]);
 assert.deepEqual(await(await f.put('manifest.json',manifest)).json(),{ok:true});
 assert.equal(f.usage().objects,3);assert.equal(f.usage().bytes,age.length+second.length+manifest.length);
 const status=await f.ingress.status();assert.ok(status.lastSuccess>0);assert.equal(status.lastArchive,prefix+'manifest.json');
});
test('a refused upload stores nothing, leaves the status alone and does not use the daily quota',async()=>{
 const f=fixture({BACKUP_RECIPIENTS:'["age1ours"]'}),plain=Buffer.from('not encrypted at all');
 const refused=async(response,status,error)=>{assert.equal(response.status,status);assert.equal((await response.json()).error,error);};
 for(let i=0;i<250;i++)await refused(await f.put('manifest.json',Buffer.from('{not json')),409,'upload_incomplete');
 assert.deepEqual({bytes:f.usage().bytes,objects:f.usage().objects},{bytes:0,objects:0});
 await refused(await f.put('manifest.json',f.manifest([age])),409,'upload_incomplete'); // the part is missing
 await refused(await f.put('00000.agepart',age,{'X-Content-SHA256':sha('other')}),409,'upload_incomplete');
 assert.equal((await f.put('00000.agepart',age)).status,200);
 await refused(await f.put('00000.agepart',age),409,'already_exists');
 await refused(await f.put('manifest.json',f.manifest([age],{recipient:'age1theirs'})),409,'recipient_refused');
 await refused(await f.put('manifest.json',f.manifest([age],{recipient:undefined})),409,'recipient_refused');
 await refused(await f.put('manifest.json',f.manifest([age],{encryptedBytes:1})),409,'upload_incomplete');
 assert.deepEqual({bytes:f.usage().bytes,objects:f.usage().objects},{bytes:age.length,objects:1});
 assert.deepEqual(await f.ingress.status(),{lastSuccess:0,lastArchive:null});assert.equal(f.objects.has(prefix+'manifest.json'),false);
 const unencrypted=fixture();
 assert.equal((await unencrypted.put('00000.agepart',plain)).status,200);
 await refused(await unencrypted.put('manifest.json',unencrypted.manifest([plain])),409,'not_an_age_archive');
 assert.deepEqual(await unencrypted.ingress.status(),{lastSuccess:0,lastArchive:null});
 const misconfigured=fixture({BACKUP_RECIPIENTS:'age1ours'});
 assert.equal((await misconfigured.put('00000.agepart',age)).status,200);
 await refused(await misconfigured.put('manifest.json',misconfigured.manifest([age])),409,'upload_incomplete');
});
test('the daily quota still stops stored objects, and without configured recipients any named recipient commits',async()=>{
 const f=fixture();f.state.set('usage',{day:new Date().toISOString().slice(0,10),bytes:0,objects:199});
 assert.equal((await f.put('00000.agepart',age)).status,200);
 const full=await f.put('manifest.json',f.manifest([age]));assert.equal(full.status,429);assert.equal(f.usage().objects,200);
 f.state.set('usage',{day:'2020-01-01',bytes:4*1024**3,objects:200});
 assert.deepEqual(await(await f.put('manifest.json',f.manifest([age],{recipient:'age1any'}))).json(),{ok:true});
 assert.equal(f.usage().objects,1);
});
