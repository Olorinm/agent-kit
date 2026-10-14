import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OSSArtifactStore, workspaceObjectPrefix, validateArtifactPath, workspaceMountMetadata,
  createAlibabaWorkspaceVerifier, WorkspaceMountUnavailable } from '../dist/workspace/index.js';
import { createAlibabaProvider, createVolcengineProvider } from '../dist/index.js';
import { createOmaSandboxClient } from '../dist/oma.js';
import { fixture } from './fixture.mjs';

const options = { region: 'oss-cn-shanghai', bucket: 'workspace-fixture',
  accessKeyId: 'fixture-access-id', accessKeySecret: 'fixture-secret' };
const target = { mountPath: '/home/user/workspace', bucket: options.bucket, prefix: 'owner/project/' };
const spec = { bucket: options.bucket, prefix: target.prefix, agentName: 'workspace-agent',
  pvName: 'workspace-volume', credentialProviderName: 'workspace-credentials' };

function storage() {
  const objects = new Map();
  const missing = () => Object.assign(new Error('missing'), { code: 'NoSuchKey' });
  const client = {
    async put(key, body, opts) { objects.set(key, { body: Buffer.from(body), type: opts?.mime }); },
    async get(key) {
      const object = objects.get(key); if (!object) throw missing();
      return { content: object.body, res: { headers: { 'content-type': object.type } } };
    },
    async head(key) {
      const object = objects.get(key); if (!object) throw missing();
      return { res: { headers: { 'content-length': String(object.body.length), 'content-type': object.type, etag: 'fixture' } } };
    },
    async delete(key) { objects.delete(key); },
    async listV2(query) {
      const entries = [...objects].filter(([key]) => key.startsWith(query.prefix)).sort();
      const start = Number(query['continuation-token'] ?? 0), next = start + 2;
      return { objects: entries.slice(start, next).map(([name, value]) => ({ name, size: value.body.length })),
        isTruncated: next < entries.length, nextContinuationToken: String(next) };
    },
  };
  return { objects, client, store: new OSSArtifactStore({ ...options, client }) };
}

test('shared Workspace files survive independent clients and stay within owner/project prefixes', async () => {
  const f = storage(), second = new OSSArtifactStore({ ...options, client: f.client });
  const bytes = Uint8Array.from([7, 0, 255, 128, 10]).subarray(1);
  for (const path of ['素材/图 片.png', '.hidden', '%2f-literal', 'docs/a', 'docs/deep/b'])
    await f.store.put({ tenantId: 'owner', workspaceId: 'project', path, body: bytes });
  await f.store.put({ tenantId: 'owner', workspaceId: 'project-other', path: 'secret', body: 'private' });
  await f.store.put({ tenantId: 'other', workspaceId: 'project', path: 'secret', body: 'private' });
  await f.store.put({ tenantId: 'owner', workspaceId: 'project', path: 'empty', body: '' });
  assert.deepEqual([...(await second.get('owner', 'project', '素材/图 片.png')).body], [0, 255, 128, 10]);
  assert.equal((await second.get('owner', 'project', 'empty')).body.length, 0);
  assert.equal(await second.get('owner', 'project', 'secret'), null);
  assert.equal((await second.stat('owner', 'project', '素材/图 片.png')).contentType, 'image/png');
  f.objects.set('owner/project/.oma-workspace-checks/probe', { body: Buffer.from('check') });
  assert.equal((await second.list('owner', 'project')).length, 6);
  assert.deepEqual((await second.list('owner', 'project', 'docs/')).map(f => f.path), ['docs/a', 'docs/deep/b']);
  assert.equal(await second.delete('owner', 'project', 'empty'), true);
  assert.equal(await second.delete('owner', 'project', 'empty'), false);
});

test('workspace paths reject traversal, invalid IDs, control characters and the reserved probe area', async () => {
  const { store } = storage();
  for (const path of ['../file', '/file', 'a//b', 'a/./b', 'a\\b', 'a\nb', 'a\0b', '\ud800',
    '.oma-workspace-checks', '.oma-workspace-checks/a', '长'.repeat(400)]) {
    await assert.rejects(store.put({ tenantId: 'owner', workspaceId: 'project', path, body: 'x' }));
    await assert.rejects(store.get('owner', 'project', path));
    await assert.rejects(store.list('owner', 'project', path));
  }
  for (const id of ['', '..', 'a/b', 'a%2fb', 'x'.repeat(129)])
    assert.throws(() => workspaceObjectPrefix(id, 'project'));
  assert.equal(workspaceObjectPrefix('owner', 'project'), 'owner/project/');
  for (const name of ['README.md', 'mail@example.com', 'x^2.txt']) assert.equal(validateArtifactPath(name), name);
});

test('storage failures cannot masquerade as missing files or empty listings', async () => {
  const f = storage();
  const failure = Object.assign(new Error('private SDK details'), { code: 'NoSuchBucket' });
  f.client.listV2 = async () => { throw failure; };
  await assert.rejects(f.store.stat('owner', 'project', 'absent'), failure);
  await assert.rejects(f.store.exists('owner', 'project', 'absent'), failure);
  await assert.rejects(f.store.delete('owner', 'project', 'absent'), failure);
  await assert.rejects(f.store.list('owner', 'project'), failure);
  f.client.get = async () => { throw failure; };
  await assert.rejects(f.store.get('owner', 'project', 'absent'), failure);
  f.client.listV2 = async () => ({ objects: [{ name: 'other/project/secret', size: 1 }], isTruncated: false });
  await assert.rejects(f.store.list('owner', 'project'), /outside/);
  f.client.listV2 = async () => ({ objects: [], isTruncated: true, nextContinuationToken: 'same' });
  await assert.rejects(f.store.list('owner', 'project'), /continuation/);
});

test('signed reads use the public endpoint, encode names and limit expiry', async () => {
  const f = storage();
  const store = new OSSArtifactStore({ ...options, endpoint: 'https://oss-cn-shanghai-internal.aliyuncs.com', client: f.client });
  const url = new URL(await store.createSignedReadUrl('owner', 'project', '素材/图 片.png', 60, { download: true }));
  assert.equal(url.protocol, 'https:');
  assert.equal(url.host, 'workspace-fixture.oss-cn-shanghai.aliyuncs.com');
  assert.equal(decodeURIComponent(url.pathname), '/owner/project/素材/图 片.png');
  assert.match(url.searchParams.get('response-content-disposition'), /filename\*/);
  assert.ok(!url.toString().includes(options.accessKeySecret));
  for (const ttl of [0, -1, 901, 1.5]) await assert.rejects(store.createSignedReadUrl('owner', 'project', 'a', ttl));
  assert.throws(() => new OSSArtifactStore({ ...options, publicEndpoint: 'http://example.com' }));
});

function mounted() {
  const f = fixture(), s = storage();
  const provider = createAlibabaProvider({ id: 'ali', domain: 'example.invalid', apiKey: 'fixture', driver: f.driver });
  const metadata = workspaceMountMetadata(spec, target.mountPath);
  const realPath = '/run/csi/mount-root/oss/' + 'a'.repeat(32);
  const name = 'b'.repeat(32), content = 'c'.repeat(64);
  let cleanupFails = false, probeFails = false;
  const runs = [];
  provider.exec = async function* (id, argv, opts) {
    runs.push({ id, argv });
    const cleanup = argv.length === 5;
    if (cleanup) {
      if (!cleanupFails) s.objects.delete(target.prefix + '.oma-workspace-checks/' + name);
      opts.onExit({ exitCode: cleanupFails ? 1 : 0 });
      yield { stream: 'stdout', text: cleanupFails ? '' : 'OMA_WORKSPACE_PROBE_REMOVED\n' };
    } else {
      if (!probeFails) s.objects.set(target.prefix + '.oma-workspace-checks/' + name, { body: Buffer.from(content) });
      opts.onExit({ exitCode: probeFails ? 1 : 0 });
      yield { stream: 'stdout', text: probeFails ? '' : JSON.stringify({ probeName: name, content, realPath }) };
    }
  };
  const verify = createAlibabaWorkspaceVerifier({ provider, store: s.store });
  async function create() {
    const ref = await provider.create({ template: 'fixture', metadata });
    f.records.get(ref.id).metadata['security.agents.kruise.io/storage-auth'] = JSON.stringify([{
      credentialProviderName: spec.credentialProviderName,
      attributes: { 'bucket-name': target.bucket, 'sub-path': 'owner/project' },
    }]);
    return ref;
  }
  return { ...f, ...s, provider, metadata, verify, create, runs,
    failProbe() { probeFails = true; }, failCleanup() { cleanupFails = true; } };
}

test('mount verifier checks authorization and independent object readback, then removes the probe', async () => {
  const f = mounted(), first = await f.create(), second = await f.create();
  for (const ref of [first, second]) await f.verify(ref, target, f.metadata);
  assert.equal(f.runs.length, 4);
  assert.equal(f.objects.size, 0);
  assert.deepEqual(JSON.parse(f.metadata['e2b.agents.kruise.io/csi-volume-config']), [{
    pvName: 'workspace-volume', mountPath: '/home/user/workspace', subPath: 'owner/project',
    attributes: { credentialProviderName: 'workspace-credentials' },
  }]);
});

test('missing, forged and mismatched mount authorizations fail before any filesystem probe', async () => {
  const f = mounted(), ref = await f.create(), info = f.records.get(ref.id);
  const good = { ...info.metadata };
  for (const patch of [
    { 'security.agents.kruise.io/storage-auth': '[]' },
    { 'security.agents.kruise.io/storage-auth': '{' },
    { 'security.agents.kruise.io/agent-name': 'someone-else' },
    { 'security.agents.kruise.io/storage-auth': JSON.stringify([{ credentialProviderName: spec.credentialProviderName,
      attributes: { 'bucket-name': 'other-bucket', 'sub-path': 'owner/project' } }]) },
  ]) {
    info.metadata = { ...good, ...patch };
    await assert.rejects(f.verify(ref, target, f.metadata), WorkspaceMountUnavailable);
  }
  info.metadata = good;
  await assert.rejects(f.verify(ref, { ...target, bucket: 'other-bucket' }, f.metadata), WorkspaceMountUnavailable);
  await assert.rejects(f.verify({ ...ref, provider: 'other' }, target, f.metadata), WorkspaceMountUnavailable);
  await assert.rejects(f.verify(ref, { ...target, prefix: 'owner/project-other/' }, f.metadata), WorkspaceMountUnavailable);
  await assert.rejects(f.verify(ref, target, {}), WorkspaceMountUnavailable);
  assert.equal(f.runs.length, 0);
});

test('probe and readback failures remain failures; readback failure still cleans up without leaking SDK secrets', async () => {
  const f = mounted(), ref = await f.create();
  f.client.get = async () => { throw new Error('secret signed request'); };
  await assert.rejects(f.verify(ref, target, f.metadata), error =>
    error instanceof WorkspaceMountUnavailable && !error.message.includes('secret'));
  assert.equal(f.objects.size, 0);
  assert.equal(f.runs.length, 2);
  const bad = mounted(), badRef = await bad.create(); bad.failProbe();
  await assert.rejects(bad.verify(badRef, target, bad.metadata), WorkspaceMountUnavailable);
  assert.equal(bad.runs.length, 1);
  const cleanup = mounted(), cleanupRef = await cleanup.create(); cleanup.failCleanup();
  await assert.rejects(cleanup.verify(cleanupRef, target, cleanup.metadata), WorkspaceMountUnavailable);
});

test('OMA uses the concrete verifier after create and reconnect; VCI rejects the Alibaba recipe', async () => {
  const f = mounted();
  const oma = createOmaSandboxClient({ provider: f.provider, defaultTemplate: 'fixture', fileSystem: b => b,
    verifyWorkspaceMount: f.verify });
  const { id } = await oma.create({ metadata: f.metadata });
  f.records.get(id).metadata['security.agents.kruise.io/storage-auth'] = JSON.stringify([{
    credentialProviderName: spec.credentialProviderName,
    attributes: { 'bucket-name': target.bucket, 'sub-path': 'owner/project' },
  }]);
  await oma.verifyWorkspaceMount(id, target);
  const restored = createOmaSandboxClient({ provider: f.provider, defaultTemplate: 'fixture', fileSystem: b => b,
    verifyWorkspaceMount: f.verify });
  assert.equal(await restored.reconnect(id, f.metadata), true);
  await restored.verifyWorkspaceMount(id, target);
  assert.equal(f.runs.length, 4);
  const volc = createVolcengineProvider({ id: 'volc', domain: 'example.invalid', apiKey: 'fixture', driver: f.driver });
  await assert.rejects(volc.create({ template: 'fixture', metadata: f.metadata }), { code: 'foreign_metadata' });
});
