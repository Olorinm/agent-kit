import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dirname, '..');
const upstream = process.argv[2];
if (!upstream) throw new Error('Pass the pinned OMA checkout path');
const pin = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim();
if (revision !== pin.revision) throw new Error(`Expected OMA ${pin.revision}, received ${revision}`);
const temporary = await mkdtemp(join(tmpdir(), 'environment-upstream-'));
try {
  for (const entry of pin.files) {
    const bytes = await readFile(join(upstream, entry.upstream));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error(`Upstream content changed: ${entry.upstream}`);
    const destination = join(temporary, entry.local);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  execFileSync('git', ['apply', join(root, 'patches/oma-extraction.patch')], { cwd: temporary });
  for (const entry of pin.files) {
    const expected = await readFile(join(temporary, entry.local));
    const actual = await readFile(join(root, entry.local));
    if (!expected.equals(actual)) throw new Error(`Unrecorded upstream change: ${entry.local}`);
  }
  console.log(`PASS: ${pin.files.length} upstream files reproduce exactly from ${pin.revision} plus the extraction patch.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
