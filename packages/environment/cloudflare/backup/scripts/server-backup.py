#!/usr/bin/env python3
"""Produce an age-encrypted, restorable archive; the upload credential cannot read/delete R2."""
import datetime, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, sys, tarfile, tempfile, urllib.request, uuid, fcntl
CHUNK=32*1024*1024
CONFIG=pathlib.Path('/etc/mau-backup.json')

def upload(config,key,data):
    request=urllib.request.Request(config['endpoint']+'/v1/upload/'+key,data=data,method='PUT',headers={
        'Authorization':'Bearer '+config['token'],'Content-Type':'application/octet-stream',
        'X-Content-SHA256':hashlib.sha256(data).hexdigest(),'User-Agent':'MauBackup/1.0'})
    with urllib.request.urlopen(request,timeout=180) as response:
        if response.status!=200 or not json.load(response).get('ok'):raise RuntimeError('upload_failed')

def main():
    os.umask(0o077)
    config=json.loads(CONFIG.read_text());output=pathlib.Path('/var/lib/mau-backups');output.mkdir(mode=0o700,exist_ok=True)
    with open('/run/mau-backup.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        date=datetime.datetime.now(datetime.timezone.utc);stamp=date.strftime('%Y-%m-%d')+'-'+str(uuid.uuid4())
        archive=output/(stamp+'.tar.gz.age')
        with tempfile.TemporaryDirectory(prefix='mau-backup-',dir='/run') as raw:
            stage=pathlib.Path(raw);replacements={};roots=[pathlib.Path(p) for p in config['paths']]
            for root in roots:
                candidates=[root] if root.is_file() else root.rglob('*.sqlite')
                for path in candidates:
                    if path.suffix!='.sqlite' or path.is_symlink() or not path.is_file():continue
                    saved=stage/('sqlite-'+hashlib.sha256(str(path).encode()).hexdigest())
                    with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=10) as src,sqlite3.connect(saved) as dst:src.backup(dst)
                    replacements[str(path)]=saved
            if config.get('postgresContainer'):
                dump=stage/'matrix.sql'
                with dump.open('wb') as target:subprocess.run(['docker','exec',config['postgresContainer'],'pg_dump','-U','synapse','-d','synapse','--no-owner','--no-acl'],stdout=target,check=True)
                replacements['restore/matrix.sql']=dump
            inventory=stage/'restore.json';inventory.write_text(json.dumps({'format':'mau-server-backup-v1','createdAt':date.isoformat(),'source':config['source'],'paths':config['paths'],'sqliteConsistent':len(replacements),'postgres':'restore/matrix.sql' if config.get('postgresContainer') else None},indent=2))
            replacements['restore/inventory.json']=inventory
            process=subprocess.Popen(['age','-r',config['recipient'],'-o',str(archive)],stdin=subprocess.PIPE)
            try:
                with tarfile.open(fileobj=process.stdin,mode='w|gz') as tar:
                    def filt(info):
                        original='/'+info.name
                        if original in replacements or info.name.endswith(('-wal','-shm')) or any(x in info.name.split('/') for x in ['node_modules','.git','.cache','backups','archives']):return None
                        if not (info.isfile() or info.isdir() or info.issym()):return None
                        return info
                    for root in roots:
                        if not root.exists():raise RuntimeError('backup_source_missing')
                        tar.add(root,arcname=str(root).lstrip('/'),filter=filt)
                    for name,path in replacements.items():tar.add(path,arcname=name.lstrip('/'),recursive=False)
                process.stdin.close()
                if process.wait()!=0:raise RuntimeError('encryption_failed')
            except BaseException:
                process.kill();process.wait();archive.unlink(missing_ok=True);raise
        tiers=['daily']+(['weekly'] if date.weekday()==6 else [])
        manifest={'format':'age-v1-chunks','source':config['source'],'createdAt':date.isoformat(),'recipient':config['recipient'],'encryptedBytes':archive.stat().st_size,'parts':[]}
        with archive.open('rb') as stream:
            index=0
            while data:=stream.read(CHUNK):
                name=f'{index:05d}.agepart';digest=hashlib.sha256(data).hexdigest()
                for tier in tiers:upload(config,f'{tier}/{config["source"]}/{stamp}/{name}',data)
                manifest['parts'].append({'name':name,'bytes':len(data),'sha256':digest});index+=1
        content=json.dumps(manifest,separators=(',',':')).encode()
        for tier in tiers:upload(config,f'{tier}/{config["source"]}/{stamp}/manifest.json',content)
        (output/'last-success.json').write_text(json.dumps({'time':date.isoformat(),'archive':archive.name,'bytes':archive.stat().st_size,'remote':[f'{tier}/{config["source"]}/{stamp}/manifest.json' for tier in tiers]},indent=2))
        # Keep two additional encrypted copies outside Cloudflare. No decryption key is on this machine.
        for old in sorted(output.glob('*.tar.gz.age'),key=lambda p:p.stat().st_mtime,reverse=True)[2:]:old.unlink()
        print(json.dumps({'event':'backup_success','source':config['source'],'encryptedBytes':manifest['encryptedBytes'],'tiers':tiers}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'event':'backup_failed','type':type(error).__name__}),file=sys.stderr);sys.exit(1)
