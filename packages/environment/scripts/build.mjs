import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
process.chdir(fileURLToPath(root));
await rm('dist', { recursive: true, force: true });
await rm('.build', { recursive: true, force: true });
await mkdir('.build', { recursive: true });
// Apply OMA's original patch to an isolated SDK copy. The installed dependency
// remains untouched, and consumers need no install scripts or patch tooling.
await cp('node_modules/e2b', '.build/e2b', { recursive: true, dereference: true });
execFileSync('git', ['apply', '--directory=.build/e2b', 'patches/e2b@2.24.0.patch']);
execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' });
await build({
  entryPoints: ['.build/e2b/dist/index.mjs'], outfile: 'dist/sdk.js',
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  legalComments: 'linked',
});
await cp('.build/e2b/LICENSE', 'dist/E2B-LICENSE');
await cp('.build/e2b/dist/index.d.ts', 'dist/sdk.d.ts');
// Bundle only the server TOS client and the pinned HTTP dependency. Consumers
// need neither the SDK's browser proxy stack nor root-only npm overrides.
await writeFile('.build/tos-entry.mjs', "export { TosClient } from '@volcengine/tos-sdk';\n");
await build({ entryPoints: ['.build/tos-entry.mjs'], outfile: 'dist/tos-sdk.js',
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const __dirname = import.meta.dirname; const __filename = import.meta.filename;' },
  legalComments: 'linked' });
await cp('node_modules/@volcengine/tos-sdk/LICENSE', 'dist/TOS-LICENSE');
async function wire(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await wire(path);
    else if ((entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) && !['dist/sdk.js', 'dist/sdk.d.ts', 'dist/tos-sdk.js'].includes(path)) {
      let sdk = relative(dirname(path), 'dist/sdk.js').replaceAll('\\', '/');
      if (!sdk.startsWith('.')) sdk = './' + sdk;
      const text = await readFile(path, 'utf8');
      let tos = relative(dirname(path), 'dist/tos-sdk.js').replaceAll('\\', '/');
      if (!tos.startsWith('.')) tos = './' + tos;
      await writeFile(path, text.replace(/from (["'])e2b\1/g, `from "${sdk}"`)
        .replace(/from (["'])@volcengine\/tos-sdk\1/g, `from "${tos}"`));
    }
  }
}
await wire('dist');
