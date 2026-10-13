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
  for(const file of ['dist/index.js','dist/oma.js','dist/cli.js','README.md','README.zh-CN.md','LICENSE'])assert.ok(files.includes(file),file);
  await writeFile(join(temp,'package.json'),JSON.stringify({private:true,type:'module'}));
  execFileSync('npm',['install','--ignore-scripts','--no-audit','--no-fund',join(temp,result[0].filename)],{cwd:temp,stdio:'pipe'});
  execFileSync(process.execPath,['--input-type=module','-e',`import {EnvironmentManager} from '@olorinm/agent-environment';import {createOmaSandboxClient} from '@olorinm/agent-environment/oma';if(typeof EnvironmentManager!=='function'||typeof createOmaSandboxClient!=='function')process.exit(1);`],{cwd:temp,stdio:'pipe'});
  const help=execFileSync(join(temp,'node_modules/.bin/agent-environment'),['--help'],{cwd:temp,encoding:'utf8'});
  assert.match(help,/cloud execution environments/);
  console.log('PASS: packed package installs independently; public imports and CLI work. '+files.length+' packaged files.');
}finally{await rm(temp,{recursive:true,force:true});}
