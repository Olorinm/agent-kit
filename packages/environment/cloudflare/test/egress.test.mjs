import test from 'node:test';import assert from 'node:assert/strict';import {allowEgress,accountRefusal,modelAccounts,modelServices,MODEL_SERVICES,DEFAULT_MODEL_SERVICES} from '../src/egress.mjs';
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
 assert.deepEqual(DEFAULT_MODEL_SERVICES,['openai']);assert.deepEqual(MODEL_SERVICES,['openai','anthropic','google','deepseek']);
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
test('the Google service admits streamed Gemini API inference for Antigravity with an API key only',()=>{
 const api='https://generativelanguage.googleapis.com',ccpa='https://daily-cloudcode-pa.googleapis.com';
 const admitted=[[api+'/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse','POST'],[api+'/v1beta/models/gemini-4-neon:streamGenerateContent','POST'],[api+'/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse','POST']];
 for(const [url,method] of admitted) {
  for(const services of [undefined,[],['openai'],['anthropic'],['openai','anthropic']])assert.equal(allowEgress(url,method,services),false,url);
  for(const services of [['google'],['openai','google'],['openai','anthropic','google']])assert.equal(allowEgress(url,method,services),true,url);
 }
 for(const [url,method] of [...openai,...anthropic])assert.equal(allowEgress(url,method,['google']),false,url);
 // Other Gemini API methods and resources, the Google sign-in's Cloud Code backend and OAuth, and every other Google host.
 const model=api+'/v1beta/models/gemini-3.8-flash';
 const denied=[[model+':streamGenerateContent','GET'],[model+':generateContent','POST'],[model+':countTokens','POST'],[model+':embedContent','POST'],[model+':batchGenerateContent','POST'],[model,'GET'],[api+'/v1beta/models','GET'],
  [model+':streamGenerateContentX','POST'],[model+':streamGenerateContent/extra','POST'],[api+'/v1beta/models/:streamGenerateContent','POST'],[api+'/v1beta/models/a/b:streamGenerateContent','POST'],[api+'/v1beta/tunedModels/m:streamGenerateContent','POST'],
  [api+'/v1/models/gemini-3.8-flash:streamGenerateContent','POST'],[api+'/v1beta/models/gemini-3.8-flash%3AstreamGenerateContent','POST'],[api+'/v1beta/files','POST'],[api+'/upload/v1beta/files','POST'],[api+'/v1beta/cachedContents','POST'],[api+'/','GET'],
  ['http://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent','POST'],[api+':8443/v1beta/models/m:streamGenerateContent','POST'],['https://user:secret@generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent','POST'],
  ['https://generativelanguage.googleapis.com.evil.test/v1beta/models/m:streamGenerateContent','POST'],['https://aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m:streamGenerateContent','POST'],
  [ccpa+'/v1internal:streamGenerateContent','POST'],[ccpa+'/v1internal:loadCodeAssist','POST'],['https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent','POST'],['https://oauth2.googleapis.com/token','POST'],['https://accounts.google.com/o/oauth2/v2/auth','GET'],
  ['https://play.googleapis.com/log','POST'],['https://www.googleapis.com/oauth2/v2/userinfo','GET'],['https://www.googleapis.com/drive/v3/files','POST'],['https://storage.googleapis.com/bucket/object','PUT']];
 for(const [url,method] of denied)for(const services of [['google'],['openai','anthropic','google']])assert.equal(allowEgress(url,method,services),false,url);
 // A key the guest holds names no account the gateway could hold it to.
 assert.throws(()=>modelAccounts({google:['account-1']}),{message:'invalid_model_accounts'});
 // The narrow rule is what applies whenever the gateway does not hold the Google key, whatever else it holds.
 for(const credentials of [undefined,{},{openai:'codex-main'},Object.create({google:'inherited'})]) {
  for(const [url,method] of admitted)assert.equal(allowEgress(url,method,['openai','google'],credentials),true,url);
  for(const [url,method] of denied)assert.equal(allowEgress(url,method,['openai','google'],credentials),false,url);
 }
 assert.deepEqual(modelServices(['openai','google']),['openai','google']);
});
test('with the Google key held by the gateway the whole Gemini API host is admitted, and nothing else',()=>{
 const api='https://generativelanguage.googleapis.com',held={google:'gemini-main'},model=api+'/v1beta/models/gemini-3.8-flash';
 // Requests the narrow rule refuses: other methods, model listing, files, caches, tuning, the Live API, a key in the query.
 const opened=[[model+':streamGenerateContent?alt=sse','POST'],[model+':generateContent','POST'],[model+':countTokens','POST'],[model+':embedContent','POST'],[model,'GET'],[api+'/v1beta/models','GET'],[api+'/v1beta/models?pageSize=50','GET'],
  [api+'/v1/models/gemini-3.8-flash:streamGenerateContent','POST'],[api+'/v1beta/files','POST'],[api+'/v1beta/files/abc','DELETE'],[api+'/upload/v1beta/files?uploadType=resumable','POST'],[api+'/upload/v1beta/files?upload_id=1','PUT'],
  [api+'/v1beta/cachedContents','POST'],[api+'/v1beta/cachedContents/c1','PATCH'],[api+'/v1beta/tunedModels/m:streamGenerateContent','POST'],[api+'/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent','GET'],
  [api+'/','GET'],[api+'/v1beta/models?key=AIza-someone-else','GET'],[api+':443/v1beta/models','GET']];
 for(const [url,method] of opened) {
  for(const services of [['google'],['openai','google'],['openai','anthropic','google']])for(const credentials of [held,{openai:'codex-main',google:'gemini-main'}])assert.equal(allowEgress(url,method,services,credentials),true,url);
  // Holding a key does not select the service, and holding another service's key does not open this one.
  for(const services of [undefined,[],['openai'],['openai','anthropic']])assert.equal(allowEgress(url,method,services,held),false,url);
 }
 for(const [url,method] of opened.slice(1))assert.equal(allowEgress(url,method,['openai','google'],{openai:'codex-main'}),false,url);
 // The checks every destination passes still apply, and no other host is opened.
 const closed=[['http://generativelanguage.googleapis.com/v1beta/models','GET'],[api+':8443/v1beta/models','GET'],['https://user:secret@generativelanguage.googleapis.com/v1beta/models','GET'],[api+'/v1beta/files%2f..%2fmodels','GET'],[api+'/v1beta/files%5c..%5cmodels','GET'],
  ['https://generativelanguage.googleapis.com.evil.test/v1beta/models','GET'],['https://evil.generativelanguage.googleapis.com/v1beta/models','GET'],['https://aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m:streamGenerateContent','POST'],
  ['https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent','POST'],['https://oauth2.googleapis.com/token','POST'],['https://accounts.google.com/o/oauth2/v2/auth','GET'],['https://www.googleapis.com/drive/v3/files','POST'],
  ['https://storage.googleapis.com/bucket/object','PUT'],['https://play.googleapis.com/log','POST'],['https://evil.test/collect','POST']];
 for(const [url,method] of closed)assert.equal(allowEgress(url,method,['openai','anthropic','google'],held),false,url);
 // The other services are what they were.
 for(const [url,method] of [...openai,...anthropic])assert.equal(allowEgress(url,method,['google'],held),false,url);
 for(const [url,method] of openai)assert.equal(allowEgress(url,method,['openai','google'],held),true,url);
 assert.equal(allowEgress('https://api.openai.com/v1/files','POST',['openai','google'],held),false);
});
test('model service selections accept only short lists of distinct reviewed names',()=>{
 assert.equal(modelServices(undefined),undefined);
 for(const value of [[],['openai'],['anthropic'],['openai','anthropic'],['anthropic','openai']])assert.deepEqual(modelServices(value),value);
 for(const value of [null,'openai',{0:'openai',length:1},0,true,['openai','openai'],['unknown'],['openai','unknown'],['OpenAI'],[''],[1],[null],[['openai']],['constructor'],['__proto__'],Array(9).fill('openai'),Array.from({length:9},(_,i)=>'service-'+i)])
  assert.throws(()=>modelServices(value),{message:'invalid_model_services'},JSON.stringify(value));
});
const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');
const accessToken=(account,extra={})=>`Bearer ${b64({alg:'RS256'})}.${b64({exp:1,'https://api.openai.com/auth':{chatgpt_account_id:account,...extra}})}.${b64('signature')}`;
const ours='11111111-1111-4111-8111-111111111111',theirs='22222222-2222-4222-8222-222222222222',codex='https://chatgpt.com/backend-api/codex/responses';
const refusal=(url,headers,accounts={openai:[ours]})=>accountRefusal(url,new Headers(headers),accounts);
test('an environment held to its OpenAI account reaches the ChatGPT backend only with that account\'s token',()=>{
 for(const url of [codex,'https://chatgpt.com/backend-api/codex/models','https://chatgpt.com/backend-api/wham/accounts/check'])assert.equal(refusal(url,{Authorization:accessToken(ours)}),undefined,url);
 assert.equal(refusal(codex,{Authorization:accessToken(ours),'ChatGPT-Account-ID':ours}),undefined);
 // A WebSocket upgrade is a request like any other.
 assert.equal(refusal(codex,{Authorization:accessToken(ours),Upgrade:'websocket',Connection:'Upgrade'}),undefined);
 assert.equal(refusal(codex,{Authorization:accessToken(theirs),Upgrade:'websocket',Connection:'Upgrade'}),'model_account_not_allowed');
 assert.equal(refusal(codex,{Authorization:accessToken(theirs)}),'model_account_not_allowed');
 assert.equal(refusal(codex,{Authorization:accessToken(ours),'ChatGPT-Account-ID':theirs}),'model_account_not_allowed');
 assert.equal(refusal(codex,{Authorization:accessToken(theirs)},{openai:[ours,theirs]}),undefined);
 const garbage=[undefined,'','Bearer','Bearer sk-fixture-key','Bearer a.b','Bearer a.b.c.d',`Basic ${b64('user:pass')}`,accessToken(ours).replace('Bearer ','bearer '),accessToken(ours)+' x',accessToken(ours)+', '+accessToken(ours),
  `Bearer ${b64({})}.${b64('not json')}.${b64('s')}`,`Bearer ${b64({})}.${b64(null)}.${b64('s')}`,`Bearer ${b64({})}.${b64({chatgpt_account_id:ours})}.${b64('s')}`,`Bearer ${b64({})}.${b64({'https://api.openai.com/auth':{chatgpt_account_id:[ours]}})}.${b64('s')}`,
  `Bearer ${b64({})}.${b64({'https://api.openai.com/auth':ours})}.${b64('s')}`,`Bearer ${b64({})}.${Buffer.from([0xff,0xfe]).toString('base64url')}.${b64('s')}`,`Bearer ${b64({})}.a.${b64('s')}`];
 for(const value of garbage)assert.equal(refusal(codex,value===undefined?{}:{Authorization:value}),'model_account_required',String(value));
 // The account is read from the token, not from a header the guest writes.
 assert.equal(refusal(codex,{'ChatGPT-Account-ID':ours}),'model_account_required');
 assert.equal(refusal(codex,{Authorization:accessToken('constructor')},{openai:[ours]}),'model_account_not_allowed');
});
test('an environment held to its OpenAI account cannot use the key-authenticated API host; token refresh and other services stay open',()=>{
 for(const url of ['https://api.openai.com/v1/responses','https://api.openai.com/v1/responses/compact','https://api.openai.com/v1/models'])
  for(const headers of [{},{Authorization:'Bearer sk-fixture-key'},{Authorization:accessToken(ours)}])assert.equal(refusal(url,headers),'model_api_key_not_allowed',url);
 for(const url of ['https://auth.openai.com/oauth/token','https://api.anthropic.com/v1/messages','https://registry.npmjs.org/zod','http://deb.debian.org/debian/dists/trixie/InRelease'])assert.equal(refusal(url,{}),undefined,url);
});
test('without model accounts nothing about a request\'s credentials is checked',()=>{
 for(const accounts of [undefined,{},Object.create({openai:[ours]})])for(const url of [codex,'https://api.openai.com/v1/responses'])
  for(const headers of [{},{Authorization:accessToken(theirs)},{Authorization:'Bearer sk-fixture-key'}])assert.equal(accountRefusal(url,new Headers(headers),accounts),undefined,url);
});
test('model accounts accept short lists of distinct account ids for services that name their account',()=>{
 assert.equal(modelAccounts(undefined),undefined);
 for(const value of [{},{openai:[ours]},{openai:[ours,theirs]},{openai:['acct_1-A']}])assert.deepEqual(modelAccounts(value),value);
 for(const value of [null,'openai',[ours],0,true,{openai:[]},{openai:ours},{openai:[ours,ours]},{openai:[1]},{openai:[null]},{openai:['']},{openai:['a b']},{openai:['a/b']},{openai:['x'.repeat(129)]},{openai:Array.from({length:9},(_,i)=>'account-'+i)},
  {anthropic:[ours]},{unknown:[ours]},{openai:[ours],anthropic:[ours]},JSON.parse('{"__proto__":["a"]}'),{constructor:[ours]}])
  assert.throws(()=>modelAccounts(value),{message:'invalid_model_accounts'},JSON.stringify(value));
});

test('only the two pinned Linux Antigravity release artifacts can be downloaded', () => {
 const root = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/';
 for (const build of ['linux-x64/cli_linux_x64.tar.gz', 'linux-arm/cli_linux_arm64.tar.gz']) {
  const artifact = root + build;
  assert.equal(allowEgress(artifact, 'GET', []), true);
  assert.equal(allowEgress(artifact + '?data=example', 'GET', []), false);
  assert.equal(allowEgress(artifact, 'PUT', []), false);
 }
 assert.equal(allowEgress(root + 'other.tar.gz', 'GET', []), false);
});
