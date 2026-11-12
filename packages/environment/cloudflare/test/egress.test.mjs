import test from 'node:test';import assert from 'node:assert/strict';import {allowEgress} from '../src/egress.mjs';
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
