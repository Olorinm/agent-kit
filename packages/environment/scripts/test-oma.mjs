import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {createAlibabaProvider} from '../dist/index.js';
import {createOmaSandboxClient} from '../dist/oma.js';
import {fixture,collect} from '../test/fixture.mjs';

const checkout=process.env.OMA_CHECKOUT ?? process.argv[2];
if(!checkout)throw new Error('Usage: npm run test:oma -- /path/to/open-managed-agents');
const oma=resolve(checkout),project=resolve(import.meta.dirname,'..');
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:oma,encoding:'utf8'}).trim();
const sandbox=join(oma,'server/packages/sandbox/src');
const core=join(oma,'adapter/packages/core/src/tool-executor.ts');
const temporary=await mkdtemp(join(tmpdir(),'agent-environment-oma-'));
try{
  const check=join(temporary,'compatibility.mts');
  await writeFile(check,`
import type {SandboxClient} from ${JSON.stringify(join(sandbox,'sandbox-client.js'))};
import {createSandboxFileSystem} from ${JSON.stringify(join(sandbox,'sandbox-file-system.js'))};
import {createOmaSandboxClient} from ${JSON.stringify(join(project,'dist/oma.js'))};
import type {EnvironmentProvider} from ${JSON.stringify(join(project,'dist/index.js'))};
import {ExecAbortedBeforeStartError} from ${JSON.stringify(core.replace(/\.ts$/,'.js'))};
declare const provider:EnvironmentProvider;
const client:SandboxClient=createOmaSandboxClient({provider,defaultTemplate:'node',
  fileSystem:createSandboxFileSystem,abortedBeforeStart:()=>new ExecAbortedBeforeStartError(),
  verifyWorkspaceMount:async()=>{throw new Error('Test only; actual verifier is supplied by OMA.');}});
void client;
`);
  const program=ts.createProgram([check],{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.NodeNext,
    moduleResolution:ts.ModuleResolutionKind.NodeNext,strict:true,noEmit:true,skipLibCheck:true,
    typeRoots:[join(project,'node_modules/@types')],paths:{
      '@open-managed-agents/adapter-core':[core],
      '@oma-server/store':[join(oma,'server/packages/store/src/workspace-path.ts')],
    }});
  const errors=ts.getPreEmitDiagnostics(program);
  if(errors.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>project,getNewLine:()=> '\n'}));
  const loadOriginal=async path=>{
    const source=await readFile(path,'utf8');
    const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}});
    return import('data:text/javascript;base64,'+Buffer.from(outputText).toString('base64'));
  };
  const {createSandboxFileSystem}=await loadOriginal(join(sandbox,'sandbox-file-system.ts'));
  const {ExecAbortedBeforeStartError}=await loadOriginal(core);
  const f=fixture(),provider=createAlibabaProvider({id:'fixture',domain:'example.invalid',apiKey:'fixture',driver:f.driver});
  const client=createOmaSandboxClient({provider,defaultTemplate:'node',fileSystem:createSandboxFileSystem,
    abortedBeforeStart:()=>new ExecAbortedBeforeStartError(),verifyWorkspaceMount:async()=>{throw new Error('Cloud attestation is not exercised by this local test.');}});
  const {id}=await client.create();const native=client.fileSystem(id);
  const file=join(temporary,'binary');const bytes=Uint8Array.from([0,255,128,10,1]);
  await native.writeFile(file,bytes);await native.appendFile(file,bytes);
  assert.deepEqual([...await native.readFile(file)],[...bytes,...bytes]);
  await assert.rejects(native.writeFile(join(temporary,'no-parent','file'),bytes),{code:'ENOENT'});
  const link=join(temporary,'link');await symlink(file,link);
  assert.equal((await native.lstat(link)).isSymbolicLink,true);
  assert.equal((await native.stat(link)).isFile,true);
  assert.equal(await native.realpath(link),await realpath(file));
  assert.deepEqual((await native.readdir(temporary)).sort(),['binary','compatibility.mts','link']);
  await assert.rejects(collect(client.exec(id,['true'],{signal:AbortSignal.abort()})),ExecAbortedBeforeStartError);
  console.log('PASS: actual OMA SandboxClient type, original native filesystem + errno, and cancellation class. Revision '+revision);
}finally{await rm(temporary,{recursive:true,force:true});}
