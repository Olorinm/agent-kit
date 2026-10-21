// Only encrypted bytes leave the container. The recovery identity is never deployed.
export const archiveScript=String.raw`
import os,sqlite3,tarfile,tempfile,pathlib,subprocess,hashlib,time,contextlib
os.umask(0o077)
with tempfile.TemporaryDirectory(prefix='mau-snapshot-',dir='/tmp') as tmp:
 replacements={}
 roots=[p for p in ('/home/user','/projects','/workspace') if os.path.isdir(p) and not os.path.islink(p)]
 def files():
  for base in roots:
   for root,dirs,names in os.walk(base,followlinks=False):
    dirs[:]=[d for d in dirs if d not in ('.cache','node_modules','.npm','.git')]
    for name in names:yield pathlib.Path(root)/name
 for p in files():
  if p.is_file() and not p.is_symlink() and p.suffix in ('.sqlite','.db'):
   try:
    with p.open('rb') as f:header=f.read(16)
    if header!=b'SQLite format 3\x00':continue
    dst=pathlib.Path(tmp)/hashlib.sha256(str(p).encode()).hexdigest()
    deadline=time.monotonic()+10
    def progress(status,remaining,total):
     if time.monotonic()>deadline:raise RuntimeError('sqlite_backup_timeout')
    with contextlib.closing(sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)) as a,contextlib.closing(sqlite3.connect(dst)) as b:a.backup(b,pages=256,progress=progress)
    replacements[str(p).lstrip('/')]=dst
   except Exception:raise RuntimeError('sqlite_backup_failed')
 age=subprocess.Popen(['/usr/local/bin/age','-r',os.environ['RECIPIENT']],stdin=subprocess.PIPE)
 try:
  with tarfile.open(fileobj=age.stdin,mode='w|gz') as tar:
   def filt(m):
    if m.name in replacements or m.name.endswith(('-wal','-shm')) or any(x in m.name.split('/') for x in ('.cache','node_modules','.npm','.git')):return None
    return m if m.isfile() or m.isdir() or m.issym() else None
   for root in roots:tar.add(root,arcname=root.lstrip('/'),filter=filt)
   for name,p in replacements.items():tar.add(p,arcname=name,recursive=False)
  age.stdin.close()
  if age.wait()!=0:raise RuntimeError('encryption_failed')
 except BaseException:
  age.kill();age.wait();raise
`;
export async function installAge(c:Container,bucket:R2Bucket,key:string,expected:string) {
 const probe=await(await c.exec(['sh','-c','test -x /usr/local/bin/age'])).output();if(probe.exitCode===0)return;
 const object=await bucket.get(key);if(!object)throw Error('backup_program_missing');const bytes=await object.arrayBuffer();
 const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');if(sha!==expected)throw Error('backup_program_integrity');
 const result=await(await c.exec(['node','-e',"const fs=require('fs');let b=[];process.stdin.on('data',c=>b.push(c));process.stdin.on('end',()=>{fs.writeFileSync('/usr/local/bin/age',Buffer.concat(b),{mode:0o755})});"],{stdin:new Blob([bytes]).stream()})).output();if(result.exitCode!==0)throw Error('backup_program_install');
}
export async function archiveAgent(c:Container,bucket:R2Bucket,id:string,recipient:string) {
 if(!/^age1[0-9a-z]{58}$/.test(recipient))throw Error('backup_recipient_invalid');
 const date=new Date(),name=date.toISOString().slice(0,10)+'-'+crypto.randomUUID(),prefixes=[`daily/agents/${id}/${name}/`,...(date.getUTCDay()===0?[`weekly/agents/${id}/${name}/`]:[])];
 const p=await c.exec(['python3','-c',archiveScript],{env:{RECIPIENT:recipient},stderr:'ignore',signal:AbortSignal.timeout(180000)});
 const parts:{name:string;bytes:number;sha256:string}[]=[];let buffer=new Uint8Array(16*1024*1024),used=0,total=0;
 const save=async()=>{if(!used)return;const bytes=buffer.slice(0,used),sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join(''),name=String(parts.length).padStart(5,'0')+'.agepart';
  for(const prefix of prefixes)await bucket.put(prefix+name,bytes,{sha256,onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256}});parts.push({name,bytes:used,sha256});used=0;
 };
 try {
  const reader=p.stdout!.getReader();
  for(;;){const result=await reader.read();if(result.done)break;const chunk=result.value as Uint8Array;let offset=0;total+=chunk.length;if(total>1024**3)throw Error('backup_size_limit');
   while(offset<chunk.length){const count=Math.min(buffer.length-used,chunk.length-offset);buffer.set(chunk.subarray(offset,offset+count),used);used+=count;offset+=count;if(used===buffer.length)await save();}
  }
  await save();if(await p.exitCode!==0||!parts.length)throw Error('backup_failed');
  const manifest=JSON.stringify({format:'age-v1-chunks',source:'agents',archiveVersion:2,archiveRoots:['/home/user','/projects','/workspace'],environmentId:id,createdAt:date.toISOString(),recipient,encryptedBytes:total,parts});
  for(const prefix of prefixes)await bucket.put(prefix+'manifest.json',manifest,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  return {version:2,createdAt:Date.now(),key:prefixes[0]+'manifest.json',bytes:total};
 }catch(error){p.kill();throw error;}
}
