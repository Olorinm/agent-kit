import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { WORKSPACE_MOUNT_PROBE, WORKSPACE_MOUNT_PROBE_CLEANUP } from '../dist/workspace/mount-probe.js';

// Run the actual Python probes and descriptor-relative filesystem operations.
// Only cloud mountinfo, CSI path and uid/gid are supplied by this local fixture;
// this exercises fallback/symlink rejection without claiming a real CSI mount.
const runner = String.raw`
import builtins, contextlib, io, json, os, sys, tempfile
from unittest.mock import patch
case = json.loads(sys.stdin.read())
real = '/run/csi/mount-root/oss/' + 'a' * 32
mode = case['mode']
with tempfile.TemporaryDirectory() as root:
    saved_open = os.open
    def mapped_open(path, flags, *args, **kwargs):
        if path == real: path = root
        return saved_open(path, flags, *args, **kwargs)
    device = os.stat(root).st_dev
    volume = 'ext4' if mode == 'local-directory' else 'fuse.ossfs'
    mountinfo = '10 1 %d:%d / %s rw - %s ossfs rw\n' % (os.major(device), os.minor(device), real, volume)
    if mode == 'control-symlink': os.symlink('/tmp', root + '/.oma-workspace-checks')
    output = io.StringIO()
    status = 0
    with patch.object(os, 'geteuid', return_value=0 if mode == 'root-user' else 1000), \
         patch.object(os, 'getegid', return_value=1000), \
         patch.object(os.path, 'realpath', return_value=real), \
         patch.object(os, 'open', side_effect=mapped_open), \
         patch.object(builtins, 'open', side_effect=lambda *a, **kw: io.StringIO(mountinfo)), \
         contextlib.redirect_stdout(output):
        sys.argv = ['probe', '/home/user/workspace']
        try: exec(case['probe'], {})
        except SystemExit as error: status = error.code
    if status:
        print(json.dumps({'status': status, 'output': output.getvalue()}))
    else:
        probe = json.loads(output.getvalue())
        with open(root + '/.oma-workspace-checks/' + probe['probeName'], 'rb') as file:
            saved = file.read().decode('ascii')
        cleanup = io.StringIO()
        with patch.object(os, 'open', side_effect=mapped_open), contextlib.redirect_stdout(cleanup):
            sys.argv = ['cleanup', probe['realPath'], probe['probeName']]
            try: exec(case['cleanup'], {})
            except SystemExit as error: status = error.code
        print(json.dumps({'status': status, 'content': saved, 'probe': probe, 'cleanup': cleanup.getvalue(),
                         'remaining': os.listdir(root + '/.oma-workspace-checks')}))
`;

test('original mount probe verifies closed bytes and cleanup uses the captured mount path', () => {
  const run = spawnSync('python3', ['-c', runner], { encoding: 'utf8', input: JSON.stringify({
    mode: 'mounted', probe: WORKSPACE_MOUNT_PROBE, cleanup: WORKSPACE_MOUNT_PROBE_CLEANUP,
  }) });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.status, 0);
  assert.equal(result.content, result.probe.content);
  assert.match(result.content, /^[a-f0-9]{64}$/);
  assert.equal(result.cleanup.trim(), 'OMA_WORKSPACE_PROBE_REMOVED');
  assert.deepEqual(result.remaining, []);
});

test('original mount probe rejects a local fallback, root execution and a symlinked probe directory', () => {
  for (const mode of ['local-directory', 'root-user', 'control-symlink']) {
    const run = spawnSync('python3', ['-c', runner], { encoding: 'utf8', input: JSON.stringify({
      mode, probe: WORKSPACE_MOUNT_PROBE, cleanup: WORKSPACE_MOUNT_PROBE_CLEANUP,
    }) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 1, mode);
  }
});
