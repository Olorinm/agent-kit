import test from 'node:test';import assert from 'node:assert/strict';import {uploadPath,sizeAllowed} from '../src/policy.mjs';
test('upload scope refuses other sources, traversal, expired dates and invalid sizes',()=>{
 const date=new Date().toISOString().slice(0,10),p=`/v1/upload/daily/router/${date}-11111111-1111-4111-8111-111111111111/00000.agepart`;
 assert.ok(uploadPath(p,'router').startsWith('daily/router/'));
 for(const path of [p.replace('/router/','/relay/'),p.replace('00000.agepart','../key'),p.replace(date,'2020-01-01')])assert.throws(()=>uploadPath(path,'router'));
 assert.equal(sizeAllowed(32*1024*1024),true);for(const n of [0,-1,NaN,Infinity,33*1024*1024])assert.equal(sizeAllowed(n),false);
});
