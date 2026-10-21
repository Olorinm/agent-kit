#!/usr/bin/env python3
"""Mirror only encrypted Agent exports; no recovery private key is stored here."""
import sys,json,pathlib,urllib.request,urllib.parse,hashlib,re,os,time,fcntl
p=json.loads(pathlib.Path('/etc/mau-agent-backup-mirror.json').read_text());os.umask(0o077);
lock=open('/run/mau-agent-backup-mirror/lock','w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);
root=pathlib.Path('/var/lib/mau-backups/agents');root.mkdir(parents=True,exist_ok=True,mode=0o700)
def get(url,token,header='Authorization'):
 h={header:('Bearer ' if header=='Authorization' else '')+token,'User-Agent':'MauBackup/1.0'}
 with urllib.request.urlopen(urllib.request.Request(url,headers=h),timeout=180) as r:return r.read()
result=[]
for a in p['agents']:
 status=json.loads(get(p['gateway']+'/v1/environments/'+a['env']+'/security',p['gatewayToken'],'X-Environment-Control'))
 b=status['backup'];assert b.get('version')==2,'archive_version_not_current';assert 0<=time.time()*1000-b['createdAt']<36*3600000,'agent_backup_stale'
 key=b['key'];assert re.fullmatch(r'daily/agents/'+re.escape(a['env'])+r'/[a-f0-9.-]+/manifest.json',key)
 manifest=json.loads(get(p['backupUrl'].rstrip('/')+'/v1/restore?key='+urllib.parse.quote(key,safe=''),p['recoveryToken']))
 assert manifest['archiveVersion']==2 and manifest['environmentId']==a['env'] and manifest['encryptedBytes']<=1024**3
 folder=root/a['env'];folder.mkdir(exist_ok=True,mode=0o700);target=folder/(key.split('/')[-2]+'.tar.gz.age');temp=target.with_suffix('.partial');total=0
 valid=target.exists() and target.stat().st_size==manifest['encryptedBytes']
 if valid:
  with target.open('rb') as f:
   for part in manifest['parts']:
    if hashlib.sha256(f.read(part['bytes'])).hexdigest()!=part['sha256']:valid=False;break
 if valid:
  result.append({'agent':a['name'],'bytes':target.stat().st_size,'manifest':key,'offCloudflareCopy':str(target),'checksumsVerified':True});print(json.dumps(result[-1]),flush=True);continue
 with temp.open('wb') as f:
  for i,part in enumerate(manifest['parts']):
   assert part['name']==f'{i:05d}.agepart' and part['bytes']<=32*1024**2
   raw=get(p['backupUrl'].rstrip('/')+'/v1/restore?key='+urllib.parse.quote(key.rsplit('/',1)[0]+'/'+part['name'],safe=''),p['recoveryToken'])
   assert len(raw)==part['bytes'] and hashlib.sha256(raw).hexdigest()==part['sha256'];f.write(raw);total+=len(raw)
 assert total==manifest['encryptedBytes'];temp.replace(target);target.with_suffix('.manifest.json').write_text(json.dumps(manifest,indent=2))
 for old in sorted(folder.glob('*.tar.gz.age'),key=lambda x:x.stat().st_mtime,reverse=True)[2:]:old.unlink();old.with_suffix('.manifest.json').unlink(missing_ok=True)
 result.append({'agent':a['name'],'bytes':total,'manifest':key,'offCloudflareCopy':str(target),'checksumsVerified':True});print(json.dumps(result[-1]),flush=True)
(root/'last-success.json').write_text(json.dumps(result,indent=2))
