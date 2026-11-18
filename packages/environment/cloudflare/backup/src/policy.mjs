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
/** The age recipients archives are expected to be encrypted to (`BACKUP_RECIPIENTS`, a JSON array of public keys). */
export function backupRecipients(value) {
  const parsed=value?JSON.parse(value):[];
  if(!Array.isArray(parsed)||parsed.some(r=>typeof r!=='string'||!r))throw Error('invalid_backup_recipients');
  return parsed;
}
/** The recipient stanza types in the age header an archive starts with. Throws when the bytes are not a complete age v1 header. */
export function ageStanzas(bytes) {
  const lines=new TextDecoder('latin1').decode(bytes).split('\n'),end=lines.findIndex(line=>line.startsWith('---'));
  if(lines[0]!=='age-encryption.org/v1'||end<2||end===lines.length-1||!/^--- [A-Za-z0-9+/]{43}$/.test(lines[end]))throw Error('not_an_age_archive');
  const types=lines.slice(1,end).filter(line=>line.startsWith('-> ')).map(line=>line.split(' ')[1]);
  if(!lines[1].startsWith('-> ')||types.some(type=>!type))throw Error('not_an_age_archive');
  return types.filter(type=>!type.endsWith('-grease'));
}
/**
 * What the ingress can tell about who an archive is encrypted to. It is a check against mistakes, not against the
 * holder of an upload credential: an age header does not reveal its recipient's public key, and the manifest's
 * `recipient` is the uploader's own statement. So: the archive starts with an age header for exactly one recipient
 * that is not a passphrase, and, when recipients are configured, the manifest names one of them. Whether the
 * archive decrypts is known only from a restore with the recovery identity.
 */
export function assertRecipient(manifest, firstBytes, recipients) {
  const types=ageStanzas(firstBytes);
  if(types.length!==1||types[0]==='scrypt')throw Error('recipient_refused');
  if(recipients.length&&!recipients.includes(manifest.recipient))throw Error('recipient_refused');
}
