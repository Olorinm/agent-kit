import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CommandExitError, SandboxNotFoundError, FileNotFoundError } from 'e2b';

// Runs real local processes; cloud lifecycle remains a deterministic test double.
export function fixture() {
  const records = new Map();
  const calls = [];
  const running = new Set();
  let sequence = 0;
  const native = async fn => {
    try { return await fn(); }
    catch (e) { if (e.code === 'ENOENT') throw new FileNotFoundError('missing'); throw e; }
  };
  const handle = id => ({
    sandboxId: id,
    getHost: port => `${port}-${id}.sandbox.fixture`,
    trafficAccessToken: "fixture-traffic-token",
    commands: { async run(command, opts) {
      calls.push(['exec', command, opts]);
      const child = spawn('/bin/bash', ['-c', command], { cwd: opts.cwd, env: { ...process.env, ...opts.envs } });
      running.add(child);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', opts.onStdout); child.stderr.on('data', opts.onStderr);
      const finished = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          running.delete(child);
          if (code === 0) resolve({ exitCode: 0 });
          else reject(new CommandExitError({ exitCode: code ?? 137, error: signal ?? 'exit', stdout: '', stderr: '' }));
        });
      });
      return { wait: () => finished, kill: async () => child.kill('SIGKILL'), disconnect: async () => {} };
    } },
    files: {
      read: path => native(() => fs.readFile(path)),
      write: (path, bytes) => native(async () => {
        await fs.mkdir(dirname(path), {recursive: true});
        await fs.writeFile(path, typeof bytes === 'string' ? bytes : new Uint8Array(bytes));
      }),
      remove: path => native(() => fs.rm(path, {recursive: true})),
      list: path => native(async () => Promise.all((await fs.readdir(path)).map(async name => {
        const p = join(path, name), s = await fs.lstat(p);
        return {path: p, size: s.size, type: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'symlink', modifiedTime: s.mtime};
      }))),
    },
  });
  const get = id => { if (!records.has(id)) throw new SandboxNotFoundError('missing'); return records.get(id); };
  const driver = {
    async create(template, opts) {
      const id = 'test-' + ++sequence; calls.push(['create', template, opts]);
      records.set(id, {sandboxId: id, templateId: template, state: 'running', metadata: {...opts.metadata}});
      return handle(id);
    },
    async connect(id, opts) { get(id).state = 'running'; calls.push(['connect', id, opts]); return handle(id); },
    async info(id) { calls.push(['info', id]); return {...get(id)}; },
    async list() { return [...records.values()]; },
    async pause(id) { calls.push(['pause', id]); get(id).state = 'paused'; },
    async kill(id) { calls.push(['kill', id]); get(id); records.delete(id); },
    async setTimeout(id, ms) { get(id); calls.push(['timeout', id, ms]); },
  };
  return {driver, records, calls, running, handle};
}
export const collect = async iterable => { const out = []; for await (const c of iterable) out.push(c); return out; };
