import test from 'node:test';import assert from 'node:assert/strict';import {uploadPath,sizeAllowed,uploadSources,securityCheck,backupRecipients,ageStanzas,assertRecipient} from '../src/policy.mjs';
test('upload scope refuses other sources, traversal, expired dates and invalid sizes',()=>{
 const date=new Date().toISOString().slice(0,10),p=`/v1/upload/daily/router/${date}-11111111-1111-4111-8111-111111111111/00000.agepart`;
 assert.ok(uploadPath(p,'router').startsWith('daily/router/'));
 for(const path of [p.replace('/router/','/relay/'),p.replace('00000.agepart','../key'),p.replace(date,'2020-01-01')])assert.throws(()=>uploadPath(path,'router'));
 assert.equal(sizeAllowed(32*1024*1024),true);for(const n of [0,-1,NaN,Infinity,33*1024*1024])assert.equal(sizeAllowed(n),false);
});
test('the check covers the sources that have an upload credential, and fails when one is stale or none exists',()=>{
 assert.deepEqual(uploadSources(JSON.stringify({router:'a',relay:'',other:1})),['router']);
 assert.deepEqual(uploadSources(undefined),[]);assert.deepEqual(uploadSources(''),[]);
 const now=Date.parse('2026-01-10T00:00:00Z'),hour=3600000,fresh={source:'router',lastSuccess:now-35*hour},stale={source:'relay',lastSuccess:now-37*hour};
 assert.deepEqual(securityCheck(true,[fresh],now),{ok:true,healthy:true,backups:[{source:'router',fresh:true}]});
 assert.equal(securityCheck(true,[fresh,stale],now).ok,false);
 assert.equal(securityCheck(true,[{source:'router',lastSuccess:0}],now).ok,false);
 assert.equal(securityCheck(false,[fresh],now).ok,false);
 assert.equal(securityCheck(true,[],now).ok,false);
});
const bytes=text=>new TextEncoder().encode(text),share='A'.repeat(43),mac='--- '+'M'.repeat(43);
const header=(...stanzas)=>bytes(['age-encryption.org/v1',...stanzas.flatMap(type=>[`-> ${type} ${share}`,share]),mac,'payload'].join('\n'));
test('the first part must start with an age header for one recipient that is not a passphrase',()=>{
 assert.deepEqual(ageStanzas(header('X25519')),['X25519']);
 assert.deepEqual(ageStanzas(header('X25519','ssh-ed25519')),['X25519','ssh-ed25519']);
 assert.deepEqual(ageStanzas(header('X25519','abc-grease')),['X25519']);
 for(const text of ['','payload only','age-encryption.org/v2\n-> X25519 a\nb\n'+mac+'\nx','age-encryption.org/v1\n'+mac+'\nx','age-encryption.org/v1\n-> X25519 a\nb\n--- short\nx',
  'age-encryption.org/v1\n-> X25519 a\nb\n','age-encryption.org/v1\n-> X25519 a\nb\n'+mac,'age-encryption.org/v1\nbody\n-> X25519 a\n'+mac+'\nx','age-encryption.org/v1\n-> \nb\n'+mac+'\nx','-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n'])
  assert.throws(()=>ageStanzas(bytes(text)),{message:'not_an_age_archive'},text);
 assert.doesNotThrow(()=>assertRecipient({},header('X25519'),[]));
 for(const stanzas of [['scrypt'],['X25519','X25519'],['abc-grease']])assert.throws(()=>assertRecipient({},header(...stanzas),[]),{message:'recipient_refused'});
});
test('with configured recipients the manifest must name one of them',()=>{
 assert.deepEqual(backupRecipients(undefined),[]);assert.deepEqual(backupRecipients(''),[]);assert.deepEqual(backupRecipients('["age1one","age1two"]'),['age1one','age1two']);
 for(const value of ['age1one','{"a":"age1one"}','[1]','[""]','"age1one"'])assert.throws(()=>backupRecipients(value));
 assert.doesNotThrow(()=>assertRecipient({recipient:'age1two'},header('X25519'),['age1one','age1two']));
 for(const manifest of [{},{recipient:'age1other'},{recipient:['age1one']}])assert.throws(()=>assertRecipient(manifest,header('X25519'),['age1one']),{message:'recipient_refused'});
 assert.doesNotThrow(()=>assertRecipient({recipient:'age1other'},header('X25519'),[]));
});
