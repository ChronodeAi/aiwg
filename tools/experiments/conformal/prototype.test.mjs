import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate, digest, rowHash, verifySplits, validate, quantile, predictionSet, fit, predict, metrics, extendIntegrity } from './prototype.mjs';
const plan=JSON.parse(readFileSync(new URL('./preregister.json',import.meta.url),'utf8'));
const frozen=JSON.parse(readFileSync(new URL('./frozen.json',import.meta.url),'utf8'));
const rows=frozen.splits.calibration.filter(r=>r.task==='noul');
const key={task:'noul',servedModel:'pinned-model',primitive:'truth-probability',definition:'d',adapter:'a',population:'p',method:'lac-v1',calibrationSplit:rowHash(rows),codeVersion:'v1',alpha:.1};

test('CONF-01 frozen seed, hashes, disjoint IDs and entities',()=>{
 assert.equal(digest(plan),frozen.preregistrationHash);
 assert.deepEqual(generate(plan),frozen.splits);
 verifySplits(frozen.splits,frozen.hashes);
 const changed=structuredClone(frozen.splits);changed.test[0].entity=changed.calibration[0].entity;
 const hashes={...frozen.hashes,test:rowHash(changed.test)};
 assert.throws(()=>verifySplits(changed,hashes),/overlapping/);
 changed.test[0].p[0]=.7;assert.throws(()=>verifySplits(changed,hashes),/hash mismatch/);
});
test('CONF-02 finite sample rank, ties, missing classes and empty/singleton/full sets',()=>{
 assert.equal(quantile([.1,.2,.3,.4],.4),.3);
 assert.equal(quantile([.1],.1),Infinity);
 assert.deepEqual(predictionSet([.5,.5],.5),[0,1]);
 assert.deepEqual(predictionSet([.5,.5],.49),[]);
 assert.deepEqual(predictionSet([.9,.1],.2),[0]);
 assert.deepEqual(predictionSet([.9,.1],Infinity),[0,1]);
 assert.throws(()=>quantile([], .1));assert.throws(()=>quantile([NaN],.1));assert.throws(()=>quantile([.1],0));
 const absent=rows.map(r=>({...r,label:0}));
 assert.equal(fit(absent,.1,key).calibrationHash,rowHash(absent));
});
test('CONF-03 native evidence is unchanged and Noul never becomes confidence',()=>{
 const before=structuredClone(rows),profile=fit(rows,.1,key),out=predict(rows[0],profile,key);
 assert.deepEqual(rows,before);assert.equal(out.authorization,false);assert.equal(out.nativeHash,digest(rows[0]));
 assert.equal('confidence' in rows[0].native,false);
});
test('CONF-04 every compatibility dimension rejects drift including model alias resolution',()=>{
 const profile=fit(rows,.1,key);
 for(const field of Object.keys(key)) assert.throws(()=>predict(rows[0],profile,{...key,[field]:'changed'}),/incompatible/);
});
test('CONF-05 denied, held, deleted, OOD, provider and one-hot compatibility inputs do zero network/credential calls',()=>{
 const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=()=>{calls++;throw new Error('network forbidden');};
 try{
  for(const patch of [{lifecycle:'deleted'},{lifecycle:'held'},{sensitivity:'restricted'},{origin:'jev-live'},{origin:'llm-one-hot',p:[1,0]},{ood:true}]) {
   assert.throws(()=>validate({...rows[0],...patch}),/unsupported provenance/);
  }
  assert.equal(calls,0);
 }finally{globalThis.fetch=originalFetch;}
});
test('CONF-06 metrics use correct denominators and rare classes are unsupported',()=>{
 const r=metrics([{label:0,set:[0]},{label:1,set:[0]},{label:1,set:[0,1]},{label:0,set:[]}]);
 assert.equal(r.coverage,.5);assert.equal(r.reviewRate,.5);assert.equal(r.selectiveRisk,.5);assert.equal(r.falseAutoRate,.25);assert.equal(r.supported,false);
 assert.equal(metrics([]).selectiveRisk,null);
});
test('CONF-07 integrity extensions cannot upgrade HOLD or ROLLBACK',()=>{
 for(const decision of ['PROMOTE','HOLD','ROLLBACK']) {
  const original={sample_n:1,release_gate:{decision,reasons:['upstream']},integrity_state:'not-assessed'};
  const out=extendIntegrity(original,{outcome:'INSUFFICIENT EVIDENCE'});
  assert.equal(out.release_gate.decision,decision==='ROLLBACK'?'ROLLBACK':'HOLD');assert.equal(original.release_gate.decision,decision);
 }
 assert.throws(()=>extendIntegrity({},{}),/upstream/);
});
test('CONF-08 offline replay and shuffled completion order produce identical serialized evidence',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'conformal-test-'));
 try{
  for(const [name,args]of [['first',[]],['reverse',['--reverse']]]){
   const result=spawnSync(process.execPath,['--import','tsx',new URL('./run.mjs',import.meta.url).pathname,join(temporary,name),...args],{encoding:'utf8',env:{PATH:process.env.PATH}});
   assert.equal(result.status,0,result.stderr);
  }
  for(const file of ['report.json','per-example.jsonl','plots.svg']) assert.equal(readFileSync(join(temporary,'first',file),'utf8'),readFileSync(join(temporary,'reverse',file),'utf8'));
  const report=JSON.parse(readFileSync(join(temporary,'first','report.json'),'utf8'));
  assert.equal(report.outcome,'INSUFFICIENT EVIDENCE');assert.equal(report.provenance.liveCollection,'not-performed');
  assert.deepEqual(report.actuals,{calls:0,inputTokens:0,outputTokens:0,costUsd:0});
  for(const task of ['choice','noul'])assert.ok(report.tasks[task].slices.shift.lac.overall.coverage<report.tasks[task].slices.test.lac.overall.coverage-.5);
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
