import { createHash } from 'node:crypto';
export const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const digest = value => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
export const ordered = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
export const rowHash = rows => digest(ordered(rows));
export function validate(row) {
  if (row.lifecycle !== 'active' || row.sensitivity !== 'public-synthetic' || row.origin !== 'synthetic-native' || row.ood) throw new Error('unsupported provenance/lifecycle: no evaluation or live fallback');
  if (!['choice', 'noul'].includes(row.task) || !row.id || !row.entity || !Array.isArray(row.p) || row.p.length !== (row.task === 'choice' ? 3 : 2)
      || row.p.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(row.p.reduce((a,b) => a+b,0)-1)>1e-10
      || !Number.isInteger(row.label) || row.label < 0 || row.label >= row.p.length) throw new Error('invalid native evidence');
}
export function verifySplits(splits, hashes) {
  const ids = new Set(), entities = new Set();
  for (const [name, rows] of Object.entries(splits)) {
    if (!rows.length || rowHash(rows) !== hashes[name]) throw new Error('split hash mismatch');
    for (const row of rows) {
      validate(row);
      if (ids.has(row.id) || entities.has(row.entity)) throw new Error('overlapping ID/entity');
      ids.add(row.id); entities.add(row.entity);
    }
  }
}
export function quantile(scores, alpha) {
  if (!(alpha > 0 && alpha < 1) || !scores.length || scores.some(x => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error('invalid calibration');
  const rank = Math.ceil((scores.length + 1) * (1 - alpha));
  return rank > scores.length ? Infinity : [...scores].sort((a,b) => a-b)[rank-1];
}
export const predictionSet = (p, q) => p.flatMap((value, i) => 1-value <= q ? [i] : []);
export const top = p => p.indexOf(Math.max(...p));
export function fit(rows, alpha, compatibility) {
  rows.forEach(validate);
  if (rows.some(r => r.task !== compatibility.task)) throw new Error('primitive mismatch');
  return {schemaVersion:'conformal-derived/v1', compatibility:structuredClone(compatibility), calibrationHash:rowHash(rows),
    q: quantile(rows.map(r => 1-r.p[r.label]), alpha), alpha};
}
export function predict(row, profile, compatibility) {
  validate(row);
  if (digest(profile.compatibility) !== digest(compatibility) || row.task !== compatibility.task) throw new Error('incompatible conformal profile');
  return {id:row.id, nativeHash:digest(row), set:predictionSet(row.p,profile.q), authorization:false};
}
export function wilson(k, n) {
  if (!n) return null;
  const z=1.959963984540054, p=k/n, d=1+z*z/n, c=(p+z*z/(2*n))/d, h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return {lower:c-h, upper:c+h};
}
export function metrics(rows) {
  const n=rows.length, covered=rows.filter(r=>r.set.includes(r.label)).length, sizes=rows.map(r=>r.set.length).sort((a,b)=>a-b);
  const accepted=rows.filter(r=>r.set.length===1), wrong=accepted.filter(r=>r.set[0]!==r.label).length;
  return {n, supported:n>=50, coverage:n?covered/n:null, coverage95:wilson(covered,n), meanSetSize:n?sizes.reduce((a,b)=>a+b,0)/n:null,
    p50:n?sizes[Math.ceil(n*.5)-1]:null,p90:n?sizes[Math.ceil(n*.9)-1]:null,p95:n?sizes[Math.ceil(n*.95)-1]:null,
    reviewRate:n?1-accepted.length/n:null, reviewCostUnits:n-accepted.length, selectiveRisk:accepted.length?wrong/accepted.length:null,
    selectiveRisk95:wilson(wrong,accepted.length),falseAutoRate:n?wrong/n:null, acceptedN:accepted.length};
}
export function extendIntegrity(integrity, evidence) {
  if (!['PROMOTE','HOLD','ROLLBACK'].includes(integrity?.release_gate?.decision)) throw new Error('missing upstream integrity');
  return {...structuredClone(integrity), conformal:{schemaVersion:'conformal-evidence/v1',...evidence},
    release_gate:{...structuredClone(integrity.release_gate), decision:integrity.release_gate.decision==='ROLLBACK'?'ROLLBACK':'HOLD'}};
}
export function generate(plan) {
  const splits={};
  for (const [split, spec] of Object.entries(plan.splits)) {
    let state=spec.seed>>>0;
    const rand=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
    splits[split]=[];
    for (const task of Object.keys(plan.tasks)) for(let i=0;i<spec.nPerTask;i++) {
      const mode=rand(), slice=mode<.7?'easy':mode<.9?'tied':'rare';
      const p=task==='choice'?(slice==='easy'?[.9,.05,.05]:slice==='tied'?[.45,.45,.1]:[.05,.05,.9]):(slice==='easy'?[.95,.05]:slice==='tied'?[.5,.5]:[.1,.9]);
      const actual=split==='shift'?[...p].reverse():p;
      let u=rand(),label=actual.length-1; for(let j=0;j<actual.length;j++){u-=actual[j];if(u<0){label=j;break;}}
      const id=`${task}/${split}/${i}`;
      splits[split].push({id,entity:id,task,split,slice,p,label,native:task==='noul'?{yesProbability:p[1]}:{distribution:Object.fromEntries(plan.tasks.choice.labels.map((label,j)=>[label,p[j]]))},origin:'synthetic-native',lifecycle:'active',sensitivity:'public-synthetic'});
    }
    splits[split]=ordered(splits[split]);
  }
  return splits;
}
