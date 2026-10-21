/** The guest cannot widen this list. Redirects must pass through the policy again. */
export function allowEgress(url, method) {
 const u=new URL(url);
 if(['deb.debian.org','security.debian.org'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port&&!u.search&&['GET','HEAD'].includes(method)&&/^\/(debian|debian-security)\//.test(u.pathname)&&!/%2f|%5c|%2e|\\/i.test(u.pathname))return true;
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||/%2f|%5c|%2e|\\/i.test(u.pathname))return false;
 if(u.hostname==='chatgpt.com') {
  // Native Codex discovers the signed-in workspace's model backend before inference.
  if(method==='GET'&&['/backend-api/wham/accounts/check','/backend-api/api/codex/accounts/check'].includes(u.pathname))return true;
  return ['GET','POST'].includes(method)&&/^\/backend-api\/codex(?:\/|$)/.test(u.pathname);
 }
 if(u.hostname==='api.openai.com')return method==='POST'&&['/v1/responses','/v1/responses/compact'].includes(u.pathname)||method==='GET'&&u.pathname==='/v1/models';
 if(u.hostname==='auth.openai.com')return method==='POST'&&u.pathname==='/oauth/token'&&!u.search;
 // Bootstrap package fetches. Publishing and arbitrary destinations remain denied.
 if(u.hostname==='registry.npmjs.org')return ['GET','HEAD'].includes(method)&&!u.search;
 return false;
}
