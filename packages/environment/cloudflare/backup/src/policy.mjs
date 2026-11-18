export function uploadPath(path, source, now=Date.now()) {
  const match=/^\/v1\/upload\/(daily|weekly)\/([a-z]+)\/(\d{4}-\d{2}-\d{2})-([a-f0-9-]{36})\/(\d{5}\.agepart|manifest\.json)$/.exec(path);
  if(!match||match[2]!==source||Math.abs(Date.parse(match[3]+'T12:00:00Z')-now)>48*3600000)throw Error('invalid_upload_path');
  return path.slice('/v1/upload/'.length);
}
export function sizeAllowed(size) {return Number.isSafeInteger(size)&&size>0&&size<=32*1024*1024;}
/** The sources that upload here: the names of the configured upload credentials. */
export function uploadSources(tokens) {
  const parsed=tokens?JSON.parse(tokens):{};
  return Object.keys(parsed).filter(source=>typeof parsed[source]==='string'&&parsed[source]);
}
/** The hourly check: the product answers, and every source committed a backup within 36 hours. No source is a failure. */
export function securityCheck(healthy, sources, now=Date.now()) {
  const backups=sources.map(s=>({source:s.source,fresh:!!s.lastSuccess&&now-s.lastSuccess<36*3600000}));
  return {ok:healthy&&backups.length>0&&backups.every(s=>s.fresh),healthy,backups};
}
