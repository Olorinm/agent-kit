// Runs in a fresh archive consumer installed with --ignore-scripts.
import assert from 'node:assert/strict';
import { Sandbox } from '@olorinm/agent-environment/sdk';
import { E2BSandboxClient } from '@olorinm/agent-environment/sandbox';
const bytes = [0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad, 0xff, 0];
async function* events() {
  yield { event: { event: { case: 'start', value: { pid: 1 } } } };
  for (const chunk of [bytes.slice(0, 4), bytes.slice(4, 5), bytes.slice(5)]) {
    yield { event: { event: { case: 'data', value: { output: { case: 'stdout', value: Uint8Array.from(chunk) } } } } };
  }
  yield { event: { event: { case: 'end', value: { exitCode: 0, exited: true, status: 'exited' } } } };
}
const sandbox = new Sandbox({ sandboxId: 'bytes', envdVersion: '0.2.0', domain: 'invalid' });
Object.defineProperty(sandbox.commands, 'rpc', { value: { start: () => events() } });
const client = new E2BSandboxClient({ domain: 'invalid', apiKey: 'fixture', createSandbox: async () => sandbox,
  verifyWorkspaceProbe: async () => { throw new Error('unused'); } });
await client.create();
const chunks = []; let exit;
for await (const chunk of client.exec('bytes', ['true'], { timeoutSeconds: 0, onExit: e => exit = e })) chunks.push(chunk);
assert.deepEqual(chunks.flatMap(c => [...c.bytes]), bytes);
assert.equal(chunks.map(c => c.text).join(''), '\uFEFF中�\0');
assert.deepEqual(exit, { exitCode: 0 });
console.log('PASS: installed archive preserves original bytes, split UTF-8 and BOM through the real SDK.');
