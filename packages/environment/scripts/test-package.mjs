import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(join(tmpdir(),'agent-environment-package-'));
try{
  const result=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temp],{cwd:root,encoding:'utf8'}));
  const files=result[0].files.map(f=>f.path);
  for(const file of files)assert.ok(!/^(state|src|test|node_modules)\//.test(file),file);
  for(const file of ['dist/index.js','dist/sandbox/index.js','dist/contracts/index.js','dist/sdk.js','dist/E2B-LICENSE','dist/cli.js','dist/workspace/index.js','dist/tos-sdk.js','dist/TOS-LICENSE','README.md','README.zh-CN.md','LICENSE'])assert.ok(files.includes(file),file);
  await writeFile(join(temp,'package.json'),JSON.stringify({private:true,type:'module'}));
  execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund','typescript@5.9.3','@types/node@24.10.1',join(temp,result[0].filename)],{cwd:temp,stdio:'pipe'});
  execFileSync(process.execPath,['--input-type=module','-e',`import {EnvironmentManager} from '@olorinm/agent-environment';import {E2BSandboxClient,DefaultSandboxManager} from '@olorinm/agent-environment/sandbox';import {ExecAbortedBeforeStartError as A} from '@olorinm/agent-environment/contracts';import {ExecAbortedBeforeStartError as B} from '@olorinm/agent-environment';if(typeof EnvironmentManager!=='function'||typeof E2BSandboxClient!=='function'||typeof DefaultSandboxManager!=='function'||A!==B)process.exit(1);`],{cwd:temp,stdio:'pipe'});
  await writeFile(join(temp,'check-stream.mjs'), await readFile(join(root,'test/packaged-stream.mjs')));
  execFileSync(process.execPath, ['check-stream.mjs'], {cwd:temp,stdio:'inherit'});
  await writeFile(join(temp,'consumer.ts'), `
import {createAlibabaProvider, type E2BDriver} from '@olorinm/agent-environment';
import {E2BSandboxClient, DefaultSandboxManager} from '@olorinm/agent-environment/sandbox';
import {Sandbox, type CommandStartOpts} from '@olorinm/agent-environment/sdk';
import {TOSArtifactStore, VolcengineWorkspaceBackend, type WorkspaceBackend} from '@olorinm/agent-environment/workspace';
const options: CommandStartOpts = {onStdoutBytes: bytes => { const raw: Uint8Array = bytes; }};
void [createAlibabaProvider, E2BSandboxClient, DefaultSandboxManager, Sandbox, options];
declare const backend: WorkspaceBackend; void [TOSArtifactStore,VolcengineWorkspaceBackend,backend];
`);
  execFileSync(process.execPath,['--input-type=module','-e',`import {TOSArtifactStore} from '@olorinm/agent-environment/workspace';
const s=new TOSArtifactStore({bucket:'fixture',region:'cn-shanghai',accessKeyId:'test',accessKeySecret:'test'});
const u=new URL(await s.createSignedReadUrl('owner','workspace','素材/%2f.txt',60));
if(u.hostname!=='fixture.tos-cn-shanghai.volces.com'||!u.pathname.includes('%252f'))throw new Error('invalid signed URL');`],{cwd:temp,stdio:'inherit'});
  execFileSync(join(temp,'node_modules/.bin/tsc'), ['--noEmit','--strict','--target','ES2023','--module','NodeNext','--moduleResolution','NodeNext','consumer.ts'], {cwd:temp,stdio:'inherit'});
  const help=execFileSync(join(temp,'node_modules/.bin/agent-environment'),['--help'],{cwd:temp,encoding:'utf8'});
  assert.match(help,/cloud execution environments/);
  console.log('PASS: packed package installs independently; public imports and CLI work. '+files.length+' packaged files.');
}finally{await rm(temp,{recursive:true,force:true});}
