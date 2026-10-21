import {DurableObject} from 'cloudflare:workers';
import {equalSecret} from '../../src/security.mjs';
import {uploadPath,sizeAllowed} from './policy.mjs';
interface Env { SOURCE_REVISION?:string; BACKUPS:R2Bucket; INGEST:DurableObjectNamespace<BackupIngress>; UPLOAD_TOKENS:string; STATUS_TOKEN:string; RECOVERY_TOKEN:string; HEALTH_CHECK_URL:string; }
const json=(x:unknown,status=200)=>Response.json(x,{status,headers:{'Cache-Control':'no-store'}});
export default {
 async fetch(request:Request,env:Env) {
  const url=new URL(request.url);
  if(url.pathname==='/health')return json({service:'mau-backups',revision:env.SOURCE_REVISION??null});
  if(request.headers.has('Origin'))return json({error:'unauthorized'},401);
  if(url.pathname==='/v1/restore'&&request.method==='GET'&&env.RECOVERY_TOKEN&&await equalSecret(request.headers.get('Authorization'),`Bearer ${env.RECOVERY_TOKEN}`)) {
   const key=url.searchParams.get('key')??'';
   if(!/^(daily|weekly)\/(router|relay|agents)\/[a-f0-9/.-]+\/(\d{5}\.agepart|manifest\.json)$/.test(key)||key.includes('..'))return json({error:'invalid_key'},400);
   const object=await env.BACKUPS.get(key);if(!object)return json({error:'missing'},404);
   return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(object.size),'Cache-Control':'no-store'}});
  }
  if(url.pathname==='/v1/status'&&env.STATUS_TOKEN&&await equalSecret(request.headers.get('Authorization'),`Bearer ${env.STATUS_TOKEN}`)) {
   const entries=await Promise.all(['router','relay'].map(async s=>[s,await env.INGEST.getByName(s).status()]));
   return json(Object.fromEntries(entries));
  }
  if(!env.UPLOAD_TOKENS)return json({error:'not_configured'},503);
  for(const [source,token] of Object.entries(JSON.parse(env.UPLOAD_TOKENS))) {
   if(typeof token!=='string'||!token||!await equalSecret(request.headers.get('Authorization'),`Bearer ${token}`))continue;
   if(request.method!=='PUT')return json({error:'upload_only'},405);
   try {uploadPath(url.pathname,source);} catch{return json({error:'path_refused'},403);}
   return env.INGEST.getByName(source).fetch(request);
  }
  return json({error:'unauthorized'},401);
 },
 async scheduled(_event:ScheduledController,env:Env) {
  const sources=await Promise.all(['router','relay'].map(async source=>({source,...await env.INGEST.getByName(source).status()})));
  let healthy=false;
  try {healthy=(await fetch(env.HEALTH_CHECK_URL,{signal:AbortSignal.timeout(10000),redirect:'error'})).ok;}catch{}
  const backups=sources.map(s=>({source:s.source,fresh:!!s.lastSuccess&&Date.now()-s.lastSuccess<36*3600000}));
  const ok=healthy&&backups.every(s=>s.fresh);
  (ok?console.log:console.error)(JSON.stringify({event:'mau_security_check',ok,healthy,backups}));
 }
} satisfies ExportedHandler<Env>;
export class BackupIngress extends DurableObject<Env> {
 async status(){return {lastSuccess:await this.ctx.storage.get<number>('lastSuccess')??0,lastArchive:await this.ctx.storage.get<string>('lastArchive')??null};}
 async fetch(request:Request) {
  const url=new URL(request.url),key=url.pathname.slice('/v1/upload/'.length),size=Number(request.headers.get('Content-Length'));
  if(!sizeAllowed(size)||!request.body)return json({error:'invalid_size'},413);
  const checksum=request.headers.get('X-Content-SHA256');if(!checksum||!/^[a-f0-9]{64}$/.test(checksum))return json({error:'checksum_required'},400);
  const day=new Date().toISOString().slice(0,10);
  const accepted=await this.ctx.storage.transaction(async txn=>{
   const old=await txn.get<{day:string;bytes:number;objects:number}>('usage');
   const usage=old?.day===day?old:{day,bytes:0,objects:0};
   if(usage.bytes+size>4*1024**3||usage.objects>=200)return false;
   await txn.put('usage',{day,bytes:usage.bytes+size,objects:usage.objects+1});return true;
  });
  if(!accepted)return json({error:'daily_backup_quota'},429);
  try {
   if(key.endsWith('/manifest.json')) {
    if(size>65536)return json({error:'manifest_too_large'},413);
    const text=await request.text(),manifest=JSON.parse(text),prefix=key.slice(0,key.lastIndexOf('/')+1);
    if(manifest.format!=='age-v1-chunks'||!Array.isArray(manifest.parts)||!manifest.parts.length||manifest.parts.length>100)throw Error('manifest');
    let total=0;
    for(let i=0;i<manifest.parts.length;i++) {
     const part=manifest.parts[i];if(part.name!==`${String(i).padStart(5,'0')}.agepart`)throw Error('part_name');
     const object=await this.env.BACKUPS.head(prefix+part.name);
     if(!object||object.size!==part.bytes||object.customMetadata?.sha256!==part.sha256)throw Error('missing_part');
     total+=part.bytes;
    }
    if(total!==manifest.encryptedBytes)throw Error('size');
    const saved=await this.env.BACKUPS.put(key,text,{sha256:checksum,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
    if(!saved)return json({error:'already_exists'},409);
    await this.ctx.storage.put({lastSuccess:Date.now(),lastArchive:key});
    console.log(JSON.stringify({event:'backup_complete',source:key.split('/')[1],bytes:total}));
   } else {
    const saved=await this.env.BACKUPS.put(key,request.body,{sha256:checksum,onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256:checksum}});
    if(!saved)return json({error:'already_exists'},409);
   }
   return json({ok:true});
  }catch{return json({error:'upload_incomplete'},409);}
 }
}
