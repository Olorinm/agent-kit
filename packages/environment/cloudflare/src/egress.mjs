/** Reviewed model endpoints. The trusted product selects services per environment; adding one is a source change. */
const rules=new Map([
 ['openai',(u,method)=>{
  if(u.hostname==='chatgpt.com') {
   // Native Codex discovers the signed-in workspace's model backend before inference.
   if(method==='GET'&&['/backend-api/wham/accounts/check','/backend-api/api/codex/accounts/check'].includes(u.pathname))return true;
   return ['GET','POST'].includes(method)&&/^\/backend-api\/codex(?:\/|$)/.test(u.pathname);
  }
  if(u.hostname==='api.openai.com')return method==='POST'&&['/v1/responses','/v1/responses/compact'].includes(u.pathname)||method==='GET'&&u.pathname==='/v1/models';
  if(u.hostname==='auth.openai.com')return method==='POST'&&u.pathname==='/oauth/token'&&!u.search;
  return false;
 }],
 ['anthropic',(u,method)=>{
  // Inference, token counting and model discovery only. Files, batches, admin and OAuth remain denied.
  if(u.hostname!=='api.anthropic.com')return false;
  return method==='POST'&&['/v1/messages','/v1/messages/count_tokens'].includes(u.pathname)||method==='GET'&&/^\/v1\/models(?:\/[^/]+)?$/.test(u.pathname);
 }],
]);
export const MODEL_SERVICES=Object.freeze([...rules.keys()]);
export const DEFAULT_MODEL_SERVICES=Object.freeze(['openai']);
/** @returns {string[] | undefined} */
export function modelServices(value) {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length>8||new Set(value).size!==value.length||value.some(name=>!MODEL_SERVICES.includes(name)))throw new Error('invalid_model_services');
 return value;
}
/** The guest cannot widen this list. Redirects must pass through the policy again. */
export function allowEgress(url, method, services = DEFAULT_MODEL_SERVICES) {
 const u=new URL(url);
 if(['deb.debian.org','security.debian.org'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port&&!u.search&&['GET','HEAD'].includes(method)&&/^\/(debian|debian-security)\//.test(u.pathname)&&!/%2f|%5c|%2e|\\/i.test(u.pathname))return true;
 if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||/%2f|%5c|%2e|\\/i.test(u.pathname))return false;
 if(services.some(name=>rules.get(name)?.(u,method)))return true;
 // Bootstrap package fetches. Publishing and arbitrary destinations remain denied.
 if(u.hostname==='registry.npmjs.org')return ['GET','HEAD'].includes(method)&&!u.search;
 return false;
}
