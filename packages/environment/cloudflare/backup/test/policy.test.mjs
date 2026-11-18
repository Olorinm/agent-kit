import test from 'node:test';import assert from 'node:assert/strict';import {uploadPath,sizeAllowed,uploadSources,securityCheck} from '../src/policy.mjs';
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
