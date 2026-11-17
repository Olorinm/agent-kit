import test from 'node:test';import assert from 'node:assert/strict';import {allowEgress,modelServices,MODEL_SERVICES,DEFAULT_MODEL_SERVICES} from '../src/egress.mjs';
test('agent egress permits model and package fetches, denies arbitrary destinations, ports and writes',()=>{
 for(const [url,method] of [['https://chatgpt.com/backend-api/codex/responses','POST'],['https://api.openai.com/v1/models','GET'],['https://registry.npmjs.org/zod','GET'],['https://auth.openai.com/oauth/token','POST']])assert.equal(allowEgress(url,method),true);
 for(const [url,method] of [['https://evil.test/collect','POST'],['http://chatgpt.com/backend-api/codex/responses','POST'],['https://chatgpt.com:8443/backend-api/codex/responses','POST'],['https://chatgpt.com/share','POST'],['https://open.feishu.cn/open-apis/im/v1/messages','POST'],['https://api.openai.com/v1/files','POST'],['https://registry.npmjs.org/zod','PUT'],['https://registry.npmjs.org/zod?secret=1','GET'],['https://127.0.0.1/','GET'],['https://chatgpt.com.evil.test/backend-api/codex/responses','POST']])assert.equal(allowEgress(url,method),false,url);
});
test('signed Debian package bootstrap is limited to official repositories and read methods',()=>{
 assert.equal(allowEgress('http://deb.debian.org/debian/dists/trixie/InRelease','GET'),true);
 assert.equal(allowEgress('https://security.debian.org/debian-security/dists/trixie-security/InRelease','GET'),true);
 for(const u of ['http://deb.debian.org/upload','http://deb.debian.org/debian/file?payload=secret','http://deb.debian.org:8080/debian/file','http://deb.debian.org.evil.test/debian/file'])assert.equal(allowEgress(u,'GET'),false);
 assert.equal(allowEgress('http://deb.debian.org/debian/file','POST'),false);
});
test('native workspace discovery is read-only and does not expose other account routes',()=>{
 for(const path of ['/backend-api/wham/accounts/check','/backend-api/api/codex/accounts/check']) {
  assert.equal(allowEgress('https://chatgpt.com'+path,'GET'),true);
  assert.equal(allowEgress('https://chatgpt.com'+path,'POST'),false);
 }
 assert.equal(allowEgress('https://chatgpt.com/backend-api/wham/accounts/delete','GET'),false);
 assert.equal(allowEgress('https://chatgpt.com/backend-api/api/codex/accounts/check/extra','GET'),false);
});
const anthropic=[['https://api.anthropic.com/v1/messages','POST'],['https://api.anthropic.com/v1/messages?beta=true','POST'],['https://api.anthropic.com/v1/messages/count_tokens','POST'],['https://api.anthropic.com/v1/models','GET'],['https://api.anthropic.com/v1/models?limit=1000','GET'],['https://api.anthropic.com/v1/models/fixture-model','GET']];
const openai=[['https://chatgpt.com/backend-api/codex/responses','POST'],['https://chatgpt.com/backend-api/wham/accounts/check','GET'],['https://api.openai.com/v1/responses','POST'],['https://api.openai.com/v1/models','GET'],['https://auth.openai.com/oauth/token','POST']];
const packages=[['https://registry.npmjs.org/zod','GET'],['http://deb.debian.org/debian/dists/trixie/InRelease','GET'],['https://security.debian.org/debian-security/dists/trixie-security/InRelease','GET']];
test('model services are selected per environment and the default stays OpenAI only',()=>{
 assert.deepEqual(DEFAULT_MODEL_SERVICES,['openai']);assert.deepEqual(MODEL_SERVICES,['openai','anthropic']);
 assert.ok(Object.isFrozen(DEFAULT_MODEL_SERVICES));assert.ok(Object.isFrozen(MODEL_SERVICES));
 for(const [url,method] of anthropic) {
  assert.equal(allowEgress(url,method),false,url);
  assert.equal(allowEgress(url,method,['openai']),false,url);
  assert.equal(allowEgress(url,method,['openai','anthropic']),true,url);
  assert.equal(allowEgress(url,method,['anthropic']),true,url);
  assert.equal(allowEgress(url,method,[]),false,url);
 }
 for(const [url,method] of openai) {
  assert.equal(allowEgress(url,method),true,url);
  assert.equal(allowEgress(url,method,['openai','anthropic']),true,url);
  assert.equal(allowEgress(url,method,['anthropic']),false,url);
  assert.equal(allowEgress(url,method,[]),false,url);
 }
 for(const services of [undefined,[],['anthropic'],['openai','anthropic']])for(const [url,method] of packages)assert.equal(allowEgress(url,method,services),true,url);
 for(const services of [[],['anthropic'],['openai','anthropic']])for(const [url,method] of [['https://evil.test/collect','POST'],['https://registry.npmjs.org/zod','PUT'],['http://deb.debian.org/upload','GET']])assert.equal(allowEgress(url,method,services),false,url);
});
test('the Anthropic service admits inference, token counting and model discovery only',()=>{
 const denied=[['https://api.anthropic.com/v1/messages','GET'],['https://api.anthropic.com/v1/messages','PUT'],['https://api.anthropic.com/v1/messages','DELETE'],['https://api.anthropic.com/v1/messages/count_tokens','GET'],['https://api.anthropic.com/v1/models','POST'],['https://api.anthropic.com/v1/models/fixture-model','POST'],['https://api.anthropic.com/v1/models/fixture-model','DELETE'],
  ['https://api.anthropic.com/v1/messages/batches','POST'],['https://api.anthropic.com/v1/messages/batches','GET'],['https://api.anthropic.com/v1/messages/','POST'],['https://api.anthropic.com/v1/messages/count_tokens/extra','POST'],['https://api.anthropic.com/v1/models/','GET'],['https://api.anthropic.com/v1/models/fixture-model/extra','GET'],
  ['https://api.anthropic.com/v1/files','POST'],['https://api.anthropic.com/v1/files','GET'],['https://api.anthropic.com/v1/complete','POST'],['https://api.anthropic.com/v1/organizations/api_keys','GET'],['https://api.anthropic.com/v1/oauth/token','POST'],['https://api.anthropic.com/','GET'],['https://api.anthropic.com/v2/messages','POST'],
  ['https://api.anthropic.com/v1/models/a%2Fb','GET'],['https://api.anthropic.com/v1/models/%2e%2e','GET'],['https://api.anthropic.com/v1/models/a\\b','GET'],['https://api.anthropic.com/v1/files/../messages/batches','POST'],
  ['http://api.anthropic.com/v1/messages','POST'],['https://api.anthropic.com:8443/v1/messages','POST'],['https://user:secret@api.anthropic.com/v1/messages','POST'],
  ['https://anthropic.com/v1/messages','POST'],['https://console.anthropic.com/v1/messages','POST'],['https://api.anthropic.com.evil.test/v1/messages','POST'],['https://evil.test/v1/messages','POST']];
 for(const [url,method] of denied)for(const services of [['anthropic'],['openai','anthropic']])assert.equal(allowEgress(url,method,services),false,url);
 assert.equal(allowEgress('https://api.anthropic.com/v1/models/../messages','POST',['anthropic']),true);
 for(const name of ['constructor','__proto__','toString','unknown'])assert.equal(allowEgress('https://api.anthropic.com/v1/messages','POST',[name]),false,name);
});
test('model service selections accept only short lists of distinct reviewed names',()=>{
 assert.equal(modelServices(undefined),undefined);
 for(const value of [[],['openai'],['anthropic'],['openai','anthropic'],['anthropic','openai']])assert.deepEqual(modelServices(value),value);
 for(const value of [null,'openai',{0:'openai',length:1},0,true,['openai','openai'],['unknown'],['openai','unknown'],['OpenAI'],[''],[1],[null],[['openai']],['constructor'],['__proto__'],Array(9).fill('openai'),Array.from({length:9},(_,i)=>'service-'+i)])
  assert.throws(()=>modelServices(value),{message:'invalid_model_services'},JSON.stringify(value));
});
