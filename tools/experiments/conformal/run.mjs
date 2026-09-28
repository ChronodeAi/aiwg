import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { applyPrimitiveAcceptance } from '../../../src/decision/acceptance.ts';
import { buildIntegrityMetadata } from '../../eval/src/integrity.ts';
import { freezeQualificationSplit, verifyQualificationSplits } from '../../../src/decision/qualification/quality.ts';
import { digest, rowHash, verifySplits, fit, predict, top, metrics, wilson, extendIntegrity, ordered } from './prototype.mjs';
const dir=new URL('./',import.meta.url);
const plan=JSON.parse(readFileSync(new URL('preregister.json',dir),'utf8'));
const frozen=JSON.parse(readFileSync(new URL('frozen.json',dir),'utf8'));
if(digest(plan)!==frozen.preregistrationHash) throw new Error('preregistration changed');
if(digest(readFileSync(new URL('prototype.mjs',dir),'utf8'))!==frozen.generatorHash) throw new Error('frozen prototype changed');
verifySplits(frozen.splits,frozen.hashes);
const frozenDataHash=digest(frozen);
if(process.argv.includes('--reverse')) for(const rows of Object.values(frozen.splits)) rows.reverse();
verifyQualificationSplits(['tuning','calibration','test'].map(name=>freezeQualificationSplit(name,frozen.splits[name].map(r=>r.id))));
const output=process.argv[2];
if(!output) throw new Error('explicit report output directory required');
mkdirSync(output,{recursive:true});
const report={schemaVersion:'conformal-study/v1',outcome:'INSUFFICIENT EVIDENCE',preregistrationHash:digest(plan),frozenDataHash,
 splitHashes:frozen.hashes, provenance:{origin:'synthetic-only',representativeWorkflowRows:0,liveCollection:'not-performed',nativeFile:'frozen.json',
  preregistrationCommit:'fbddd386c',freezeCommit:'490bbee79',codeHashes:Object.fromEntries(['prototype.mjs','run.mjs','preregister.json'].map(f=>[f,digest(readFileSync(new URL(f,dir),'utf8'))]))},
 actuals:{calls:0,inputTokens:0,outputTokens:0,costUsd:0},tasks:{}};
const timing=[], results=[];
function baseline(row, bins, calibrated) {
  const kind=plan.tasks[row.task].primitive, labels=plan.tasks[row.task].labels, chosen=top(row.p);
  const definition={spec:{answer:kind==='choice'?{kind,options:labels.map(id=>({id,description:id}))}:{kind,trueDescription:'requires review',falseDescription:'does not require review'}}};
  const risk=bins[Math.floor(Math.max(...row.p)*10)];
  const observation={status:'success',reason:'none',value:kind==='choice'?labels[chosen]:row.native.yesProbability,actualModel:plan.pins.servedModel,requestId:null,
    usage:{inputTokens:0,outputTokens:0,costUsd:0}, uncertainty:{source:'provider',profile:'synthetic-native/v1',calibration:'uncalibrated',confidence:null,
      distribution:kind==='choice'?row.native.distribution:null,calibrationRef:null,...(calibrated&&risk?{calibratedRisk:{value:risk.upper,calibrationRef:`synthetic-tuning:${digest(bins)}`}}:{})}};
  const route={disposition:'review'};
  const conditions=calibrated?[{metric:'calibrated-risk',op:'lte',thresholdBps:1000}]:kind==='choice'?[{metric:'selected-probability',op:'gte',thresholdBps:8000}]:null;
  const rules=conditions?[{id:'threshold',primitive:kind,all:conditions,route:{disposition:'act'}}]:[
    {id:'no',primitive:kind,all:[{metric:'yes-probability',op:'lte',thresholdBps:2000}],route:{disposition:'act'}},
    {id:'yes',primitive:kind,all:[{metric:'yes-probability',op:'gte',thresholdBps:8000}],route:{disposition:'act'}}];
  const policy={mode:'primitive-policy',version:'1.0.0',compatibleUncertaintyProfiles:['synthetic-native/v1'],precedence:'first-match',calibration:calibrated?'required':'advisory',
    rules,defaultRoute:route,missingEvidenceRoute:route,invalidEvidenceRoute:route,tieRoute:route};
  // Pure acceptance replay: the returned disposition never reaches an executor.
  return applyPrimitiveAcceptance(definition,policy,observation).acceptance.disposition==='act'?[chosen]:[];
}
for(const task of Object.keys(plan.tasks)) {
  const calibration=frozen.splits.calibration.filter(r=>r.task===task), tuning=frozen.splits.tuning.filter(r=>r.task===task);
  const compatibility={servedModel:plan.pins.servedModel,task,primitive:plan.tasks[task].primitive,definition:digest(plan.tasks[task]),adapter:plan.pins.adapter,
    population:plan.pins.population,method:'lac-v1',calibrationSplit:rowHash(calibration),codeVersion:frozen.generatorHash,alpha:plan.alpha};
  const profile=fit(calibration,plan.alpha,compatibility);
  const bins={}; for(let bin=0;bin<=10;bin++) {
    const members=tuning.filter(r=>Math.floor(Math.max(...r.p)*10)===bin);
    if(members.length) bins[bin]={n:members.length,...wilson(members.filter(r=>top(r.p)!==r.label).length,members.length)};
  }
  const detail={profile,calibratedBaseline:{source:'synthetic tuning decile error upper bound; not an approved D09 profile',bins},slices:{}};
  for(const split of ['test','shift']) {
    const rows=ordered(frozen.splits[split].filter(r=>r.task===task));
    const methods={lac:row=>predict(row,profile,compatibility).set,raw:row=>baseline(row,bins,false),calibrated:row=>baseline(row,bins,true),
      alwaysReview:()=>[],alwaysPredict:row=>[top(row.p)]};
    detail.slices[split]={};
    for(const [method,fn] of Object.entries(methods)) {
      const scored=rows.map(row=>{const start=performance.now(),set=fn(row);timing.push({task,split,method,ms:performance.now()-start});return {id:row.id,label:row.label,slice:row.slice,nativeHash:digest(row),set};});
      results.push(...scored.map(r=>({...r,task,split,method})));
      detail.slices[split][method]={overall:metrics(scored),classes:Object.fromEntries(plan.tasks[task].labels.map((name,i)=>[name,metrics(scored.filter(r=>r.label===i))])),
        strata:Object.fromEntries(['easy','tied','rare'].map(slice=>[slice,metrics(scored.filter(r=>r.slice===slice))]))};
    }
    // Descriptive curves only: no threshold is selected using these held-out results.
    detail.slices[split].riskCoverage=Array.from({length:11},(_,i)=>{const threshold=i/10;return {threshold,...metrics(rows.map(r=>({...r,set:Math.max(...r.p)>=threshold?[top(r.p)]:[]})))};});
    detail.slices[split].reliability=Array.from({length:10},(_,bin)=>{const selected=rows.filter(r=>Math.min(9,Math.floor(Math.max(...r.p)*10))===bin);return {bin,n:selected.length,
      probability:selected.length?selected.reduce((s,r)=>s+Math.max(...r.p),0)/selected.length:null,accuracy:selected.length?selected.filter(r=>top(r.p)===r.label).length/selected.length:null};});
    const c=detail.slices[split].lac.overall,b=detail.slices[split].calibrated.overall,g=plan.gates;
    detail.slices[split].syntheticGateDiagnostics={coverage:c.coverage95.lower>=g.minimumCoverageWilsonLower,
      usefulSize:c.meanSetSize<=(task==='choice'?g.maximumMeanSetSizeChoice:g.maximumMeanSetSizeNoul),review:c.reviewRate<=g.maximumReviewRate,
      risk:c.selectiveRisk!==null&&c.selectiveRisk<=g.maximumSelectiveRisk,
      baselineImprovement:b.selectiveRisk!==null&&c.selectiveRisk!==null&&c.selectiveRisk<=b.selectiveRisk&&c.reviewRate<b.reviewRate,
      representativeData:false,exchangeabilityApplicable:split==='test'};
  }
  report.tasks[task]=detail;
}
const nominalLac=results.filter(r=>r.split==='test'&&r.method==='lac');
const nominalCovered=nominalLac.filter(r=>r.set.includes(r.label)).length;
report.integrity=extendIntegrity(buildIntegrityMetadata({mode:'standard',freshWorkspaceRequired:true,freshWorkspaceVerified:false,changedArtifacts:[],sampleN:nominalLac.length,passedN:nominalCovered,overallScore:100*nominalCovered/nominalLac.length}),
 {outcome:report.outcome,preregistrationHash:digest(plan),splitHashes:frozen.hashes,nativeEvidenceHash:frozenDataHash,scoreMeaning:'Pooled nominal LAC set coverage, descriptive only; not selective risk or task-conditioned coverage',reason:'Synthetic demonstration; no independent trusted evaluation or representative data'});
report.gaps=['No representative frozen D11 Choice/Noul distributions with independently validated labels and populations',
 'No approved D09 calibrated-risk profile for the evaluated population; synthetic tuning baseline cannot replace one',
 'No live provider collection; D10 projection/egress and D14 retention/lineage must be satisfied before a separately authorized study',
 'No validated ordinal action loss: Score excluded', 'No fresh locked evaluation workspace verification'];
results.sort((a,b)=>`${a.task}/${a.split}/${a.method}/${a.id}`.localeCompare(`${b.task}/${b.split}/${b.method}/${b.id}`));
report.perExampleHash=digest(results);
writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');
writeFileSync(`${output}/per-example.jsonl`,results.map(r=>JSON.stringify(r)).join('\n')+'\n');
const times={schemaVersion:'conformal-timing/v1',unit:'milliseconds',scope:'local per-row method only; no provider latency',measurements:[]};
for(const task of Object.keys(plan.tasks))for(const split of ['test','shift'])for(const method of ['lac','raw','calibrated','alwaysReview','alwaysPredict']){
 const values=timing.filter(r=>r.task===task&&r.split===split&&r.method===method).map(r=>r.ms).sort((a,b)=>a-b);
 times.measurements.push({task,split,method,n:values.length,meanMs:values.reduce((a,b)=>a+b,0)/values.length,p95Ms:values[Math.ceil(values.length*.95)-1]});
}
writeFileSync(`${output}/timing.json`,JSON.stringify(times,null,2)+'\n');
// Dependency-free standalone SVG plots, numeric content only.
const colors={test:'#1464a0',shift:'#ad3b16'};
let svg='<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="680" viewBox="0 0 1000 680"><rect width="1000" height="680" fill="white"/><style>text{font:13px sans-serif}</style><text x="20" y="20">Synthetic diagnostics only — blue: test; orange: shift</text>';
for(const [ti,task]of Object.keys(plan.tasks).entries())for(let chart=0;chart<3;chart++){
 const x=50+chart*330,y=60+ti*310,w=260,h=220;
 svg+=`<text x="${x}" y="${y-10}">${task}: ${['risk vs acceptance','reliability','set size frequency'][chart]}</text><path d="M${x} ${y}V${y+h}H${x+w}" stroke="black" fill="none"/>`;
 for(const split of ['test','shift']){
  const d=report.tasks[task].slices[split];
  const points=chart===0?d.riskCoverage.filter(p=>p.selectiveRisk!==null).map(p=>[1-p.reviewRate,p.selectiveRisk]):chart===1?d.reliability.filter(p=>p.n).map(p=>[p.probability,p.accuracy]):Array.from({length:plan.tasks[task].labels.length+1},(_,k)=>[k/plan.tasks[task].labels.length,results.filter(r=>r.task===task&&r.split===split&&r.method==='lac'&&r.set.length===k).length/600]);
  svg+=`<polyline points="${points.map(([a,b])=>`${x+a*w},${y+h-b*h}`).join(' ')}" fill="none" stroke="${colors[split]}" stroke-width="2"/>`;
 }
 svg+=`<text x="${x}" y="${y+h+18}">0</text><text x="${x+w-10}" y="${y+h+18}">${chart===2?plan.tasks[task].labels.length:1}</text><text x="${x-18}" y="${y+8}">1</text>`;
}
writeFileSync(`${output}/plots.svg`,svg+'</svg>\n');
console.log(JSON.stringify({outcome:report.outcome,report:`${output}/report.json`,splitHashes:frozen.hashes}));
