#!/usr/bin/env python3
"""Upload an age-encrypted, restorable archive of a product's state to the backup ingress.

Usage: server-backup.py CONFIG.json

CONFIG.json (private, mode 0600):
  paths      directories and files to archive
  exclude    optional glob patterns; a path with a matching component is left out
  source     the name of this product's upload credential at the ingress
  endpoint   the ingress URL
  recipient  the age public key that archives are encrypted to
  token      the upload-only credential; it cannot read, list or delete archives

SQLite databases (*.sqlite) are copied with the backup API, so they are consistent while
the product runs. Nothing is left on this machine afterwards.
"""
import datetime, fcntl, fnmatch, hashlib, json, os, pathlib, sqlite3, subprocess, sys, tarfile, tempfile, urllib.request, uuid

CHUNK = 32 * 1024 * 1024


def upload(config, key, data):
    request = urllib.request.Request(config['endpoint'] + '/v1/upload/' + key, data=data, method='PUT', headers={
        'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/octet-stream',
        'X-Content-SHA256': hashlib.sha256(data).hexdigest(), 'User-Agent': 'MauBackup/1.0'})
    with urllib.request.urlopen(request, timeout=180) as response:
        if response.status != 200 or not json.load(response).get('ok'):
            raise RuntimeError('upload_failed')


def consistent_databases(roots, stage):
    """Copy every database below the roots; the copies replace the live files in the archive."""
    copies = {}
    for root in roots:
        for path in ([root] if root.is_file() else root.rglob('*.sqlite')):
            if path.suffix != '.sqlite' or path.is_symlink() or not path.is_file():
                continue
            copy = stage / ('sqlite-' + hashlib.sha256(str(path).encode()).hexdigest())
            with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=10) as source, sqlite3.connect(copy) as target:
                source.backup(target)
            copies[str(path)] = copy
    return copies


def write_archive(config, roots, stage, archive, created):
    copies = consistent_databases(roots, stage)
    inventory = stage / 'inventory.json'
    inventory.write_text(json.dumps({'format': 'mau-server-backup-v1', 'createdAt': created.isoformat(), 'source': config['source'],
                                     'paths': config['paths'], 'sqliteConsistent': len(copies)}, indent=2))
    exclude = config.get('exclude', [])

    def keep(info):
        if '/' + info.name in copies or info.name.endswith(('-wal', '-shm')):
            return None
        if any(fnmatch.fnmatch(part, pattern) for part in info.name.split('/') for pattern in exclude):
            return None
        return info if info.isfile() or info.isdir() or info.issym() else None

    process = subprocess.Popen(['age', '-r', config['recipient'], '-o', str(archive)], stdin=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdin, mode='w|gz') as tar:
            for root in roots:
                if not root.exists():
                    raise RuntimeError('backup_source_missing')
                tar.add(root, arcname=str(root).lstrip('/'), filter=keep)
            for original, copy in copies.items():
                tar.add(copy, arcname=original.lstrip('/'), recursive=False)
            tar.add(inventory, arcname='restore/inventory.json', recursive=False)
        process.stdin.close()
        if process.wait() != 0:
            raise RuntimeError('encryption_failed')
    except BaseException:
        process.kill()
        process.wait()
        raise


def main(config_file):
    os.umask(0o077)
    config = json.loads(pathlib.Path(config_file).read_text())
    roots = [pathlib.Path(path) for path in config['paths']]
    with open(pathlib.Path(tempfile.gettempdir()) / ('backup-' + config['source'] + '.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        created = datetime.datetime.now(datetime.timezone.utc)
        stamp = created.strftime('%Y-%m-%d') + '-' + str(uuid.uuid4())
        with tempfile.TemporaryDirectory(prefix='backup-') as work:
            stage = pathlib.Path(work)
            archive = stage / 'archive.tar.gz.age'
            write_archive(config, roots, stage, archive, created)
            tiers = ['daily'] + (['weekly'] if created.weekday() == 6 else [])
            manifest = {'format': 'age-v1-chunks', 'source': config['source'], 'createdAt': created.isoformat(),
                        'recipient': config['recipient'], 'encryptedBytes': archive.stat().st_size, 'parts': []}
            with archive.open('rb') as stream:
                while data := stream.read(CHUNK):
                    name = f'{len(manifest["parts"]):05d}.agepart'
                    for tier in tiers:
                        upload(config, f'{tier}/{config["source"]}/{stamp}/{name}', data)
                    manifest['parts'].append({'name': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
            # The ingress commits a manifest only when every part it names is present.
            for tier in tiers:
                upload(config, f'{tier}/{config["source"]}/{stamp}/manifest.json', json.dumps(manifest, separators=(',', ':')).encode())
    print(json.dumps({'event': 'backup_success', 'source': config['source'], 'encryptedBytes': manifest['encryptedBytes'], 'tiers': tiers}))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        main(sys.argv[1])
    except Exception as error:
        print(json.dumps({'event': 'backup_failed', 'type': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
