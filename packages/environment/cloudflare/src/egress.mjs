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
/** Services whose requests name their account, so an environment can be held to its own. */
export const ACCOUNT_SERVICES=Object.freeze(['openai']);
/** @returns {Record<string,string[]> | undefined} An empty object removes a stored selection. */
export function modelAccounts(value) {
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([name,ids])=>!ACCOUNT_SERVICES.includes(name)||!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))))throw new Error('invalid_model_accounts');
 return value;
}
/**
 * The account a ChatGPT access token names. The signature is not checked here: the provider refuses a token it did
 * not sign, so a token naming an admitted account is that account's or useless.
 */
function tokenAccount(authorization) {
 const token=/^Bearer [A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(authorization??'');
 if(!token)return undefined;
 try {
  const bytes=Uint8Array.from(atob(token[1].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  const account=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof account==='string'?account:undefined;
 } catch {return undefined;}
}
/**
 * Why a request to an admitted destination is refused for an environment held to its model accounts; undefined when
 * it is not. Destination rules alone let the guest send data to someone else's account at the same provider.
 * OpenAI: the ChatGPT backend needs an access token of a listed account. The API host authenticates with keys that
 * name no account, so it is closed. Token refresh stores nothing and stays open.
 * @param {string} url @param {Headers} headers @param {Record<string,string[]>} [accounts]
 */
export function accountRefusal(url, headers, accounts) {
 const allowed=accounts&&Object.hasOwn(accounts,'openai')?accounts.openai:undefined;
 if(!allowed)return undefined;
 const host=new URL(url).hostname;
 if(host==='api.openai.com')return 'model_api_key_not_allowed';
 if(host!=='chatgpt.com')return undefined;
 const account=tokenAccount(headers.get('authorization'));
 if(!account)return 'model_account_required';
 // The backend also reads the account from this header; it may not name another one either.
 const named=headers.get('chatgpt-account-id');
 return allowed.includes(account)&&(named===null||allowed.includes(named))?undefined:'model_account_not_allowed';
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
