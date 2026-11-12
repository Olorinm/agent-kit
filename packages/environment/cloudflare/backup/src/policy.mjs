export function uploadPath(path, source, now=Date.now()) {
  const match=/^\/v1\/upload\/(daily|weekly)\/([a-z]+)\/(\d{4}-\d{2}-\d{2})-([a-f0-9-]{36})\/(\d{5}\.agepart|manifest\.json)$/.exec(path);
  if(!match||match[2]!==source||Math.abs(Date.parse(match[3]+'T12:00:00Z')-now)>48*3600000)throw Error('invalid_upload_path');
  return path.slice('/v1/upload/'.length);
}
export function sizeAllowed(size) {return Number.isSafeInteger(size)&&size>0&&size<=32*1024*1024;}
