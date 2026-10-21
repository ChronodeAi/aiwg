import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildIndex, prepareIndexArtifact } from '../../../src/artifacts/index-builder.js';
import { indexPreparationWorkers, resolveIndexWorkers, runIndexPreparation, type IndexPreparationJob } from '../../../src/artifacts/index-preparation.js';
const builderUrl = new URL('../../../src/artifacts/index-builder.ts', import.meta.url).href;
let root: string;
const bundle = 'agentic/code/addons/example';
function put(relative: string, text: string) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), {recursive:true});fs.writeFileSync(file,text);return file; }
function read(output: string, file: string) { return JSON.parse(fs.readFileSync(path.join(output,'.aiwg/.index/framework',file),'utf8')); }
function job(file: string): IndexPreparationJob { const stat=fs.statSync(file);return {fullPath:file,relativePath:path.relative(root,file),mtimeMs:stat.mtimeMs,birthtimeMs:stat.birthtimeMs,sizeBytes:stat.size}; }
beforeEach(() => {
  root=fs.mkdtempSync(path.join(os.tmpdir(),'aiwg-index-preparation-'));
  for(const key of ['HOME','XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']) vi.stubEnv(key,path.join(root,key));
  for(const key of ['AIWG_ARTIFACTS_PATH','AIWG_PROJECT_ARTIFACTS_PATH','AIWG_PROJECT_AIWG_DIR']) vi.stubEnv(key,'');
  vi.stubEnv('AIWG_INDEX_WORKERS', '');
  vi.spyOn(os, 'availableParallelism').mockReturnValue(16);
  vi.spyOn(os, 'freemem').mockReturnValue(8 * 1024 ** 3);
  vi.spyOn(process, 'availableMemory').mockReturnValue(8 * 1024 ** 3);
  put('package.json','{"name":"aiwg","version":"1.0.0"}');
  for(const kind of ['frameworks','addons','extensions']) fs.mkdirSync(path.join(root,'agentic/code',kind),{recursive:true});
  for(let index=0;index<70;index++) put(`${bundle}/docs/doc-${index}.md`,`# Document ${index}\n\n@${bundle}/docs/doc-0.md\n`);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});
describe('bounded independent index preparation',()=>{
  it('limits threads by jobs, CPU, memory and explicit serial policy',()=>{
    const gb=1024**3;
    expect(indexPreparationWorkers(100,8,16,8*gb)).toBe(4);
    expect(indexPreparationWorkers(100,4,3,8*gb)).toBe(2);
    expect(indexPreparationWorkers(100,4,16,gb)).toBe(0);
    expect(indexPreparationWorkers(100,4,16,512*1024**2)).toBe(0);
    expect(indexPreparationWorkers(20,4,16,8*gb)).toBe(0);
    expect(indexPreparationWorkers(100,4,2,8*gb)).toBe(0);
    expect(indexPreparationWorkers(100,1,16,8*gb)).toBe(0);
    expect(()=>indexPreparationWorkers(100,-1)).toThrow(/nonnegative/);
    expect(indexPreparationWorkers(64,undefined,16,8*gb,16*1024**2)).toBe(0);
    expect(indexPreparationWorkers(3000,undefined,16,8*gb,333000)).toBe(0);
    expect(indexPreparationWorkers(999,undefined,16,8*gb,16*1024**2)).toBe(0);
    expect(indexPreparationWorkers(1000,undefined,16,8*gb,16*1024**2-1)).toBe(0);
    expect(indexPreparationWorkers(1000,undefined,16,8*gb,16*1024**2)).toBe(4);
    expect(indexPreparationWorkers(64,2,16,8*gb,100)).toBe(2);
  });
  it('reserves process overhead as well as the worker heap', () => {
    expect(indexPreparationWorkers(100, 4, 16, 1024 ** 3)).toBe(0);
    expect(indexPreparationWorkers(100, 4, 16, 1536 * 1024 ** 2)).toBe(2);
  });
  it('resolves flag/API overrides before the environment, including serial zero', () => {
    vi.stubEnv('AIWG_INDEX_WORKERS', '3');
    expect(resolveIndexWorkers()).toBe(3);
    expect(resolveIndexWorkers(0)).toBe(0);
    expect(resolveIndexWorkers('2')).toBe(2);
    vi.stubEnv('AIWG_INDEX_WORKERS', 'invalid');
    expect(resolveIndexWorkers(0)).toBe(0);
    expect(() => resolveIndexWorkers()).toThrow(/AIWG_INDEX_WORKERS/);
    for (const value of ['', '-1', '1.5', 'Infinity', '9007199254740992']) {
      expect(() => resolveIndexWorkers(value)).toThrow(/nonnegative/);
    }
  });
  it('keeps oversized artifacts out of workers while preserving input order', async () => {
    const jobs = Array.from({length:70}, (_,i) => job(path.join(root,`${bundle}/docs/doc-${i}.md`)));
    jobs[0].sizeBytes = 32 * 1024 ** 2;
    const serial = vi.fn(prepareIndexArtifact);
    const result = await runIndexPreparation(jobs, serial, builderUrl, 2);
    expect(serial).toHaveBeenCalledWith(jobs[0]);
    expect(result.results).toEqual(jobs.map(prepareIndexArtifact));
    expect(result.diagnostics.join(' ')).toMatch(/serial/);
  });
  it('recovers an early worker exit serially with an ordered result and diagnostic', async () => {
    const module = put('early-exit.mjs', `
      export function prepareIndexArtifact(job) {
        if (process.send) process.exit(0);
        return { checksum: job.relativePath };
      }
    `);
    const jobs = Array.from({length:70}, (_,i) => job(path.join(root,`${bundle}/docs/doc-${i}.md`)));
    const result = await runIndexPreparation(jobs, j => ({checksum:j.relativePath}), new URL('file://' + module).href, 2);
    expect(result.results.map(r => r.checksum)).toEqual(jobs.map(j => j.relativePath));
    expect(result.diagnostics.join(' ')).toMatch(/exited.*serial/);
  });
  it('keeps automatic small and lightweight batches on the shared serial extractor',async()=>{
    const base=Array.from({length:70},(_,i)=>job(path.join(root,`${bundle}/docs/doc-${i}.md`)));
    for(const jobs of [base.slice(0,64),Array.from({length:3000},(_,i)=>base[i%base.length])]) {
      const serial=vi.fn(prepareIndexArtifact);
      const result=await runIndexPreparation(jobs,serial,builderUrl);
      expect(result.workerCount).toBe(0);expect(serial).toHaveBeenCalledTimes(jobs.length);
      expect(result.results).toHaveLength(jobs.length);
    }
  });
  it('executes bounded real workers in input order using source extraction rather than serial callback or stale dist',async()=>{
    const jobs=Array.from({length:70},(_,i)=>job(path.join(root,`${bundle}/docs/doc-${i}.md`)));
    const serial=vi.fn(prepareIndexArtifact);
    const result=await runIndexPreparation(jobs,serial,builderUrl,2);
    expect(result.workerCount).toBe(indexPreparationWorkers(jobs.length,2));
    if(result.workerCount) expect(serial).not.toHaveBeenCalled();
    else expect(serial).toHaveBeenCalledTimes(jobs.length);
    expect(result.results.map(item=>item.entry?.title)).toEqual(jobs.map((_,i)=>`Document ${i}`));
    expect(result.results).toEqual(jobs.map(prepareIndexArtifact));
  });
  it('loads the built worker and extractor directly from dist for installed runtime layouts',()=>{
    const dist=new URL('../../../dist/src/artifacts/',import.meta.url);
    expect(fs.existsSync(new URL('index-worker.mjs',dist))).toBe(true);
    const jobs=Array.from({length:70},(_,i)=>job(path.join(root,`${bundle}/docs/doc-${i}.md`)));
    const result=execFileSync(process.execPath,['--input-type=module','-e',`
      const moduleUrl = ${JSON.stringify(new URL('index-builder.js',dist).href)};
      const {prepareIndexArtifact} = await import(moduleUrl);
      const {runIndexPreparation} = await import(${JSON.stringify(new URL('index-preparation.js',dist).href)});
      const prepared = await runIndexPreparation(${JSON.stringify(jobs)},prepareIndexArtifact,moduleUrl,2);
      console.log(JSON.stringify({workers:prepared.workerCount,titles:prepared.results.map(item=>item.entry.title)}));
    `],{encoding:'utf8',timeout:60000});
    expect(JSON.parse(result).titles).toEqual(jobs.map((_,i)=>`Document ${i}`));
  });
  it('preserves serial metadata, graph and relationship semantics for operational and malformed documents',async()=>{
    put(`${bundle}/skills/work/SKILL.md`,'---\nname: work\npaths: ["src/**"]\noperational_state: ready\n---\n# Work\n');
    put(`${bundle}/rules/contract.md`,'---\nactivation: bound\nenforcement: high\nsummary: Follow the contract.\nbound_to: {skills: [work]}\n---\n# Contract\n');
    put(`${bundle}/flows/release.yaml`,'apiVersion: workflow.aiwg.io/v1\nkind: FlowPlaybook\nmetadata:\n  name: release\nspec:\n  steps: []\n');
    put(`${bundle}/docs/malformed.md`,'---\nname: [unclosed\n---\n# Malformed\n');
    put(`${bundle}/runbooks/recovery.md`,'---\ntype: runbook\ndescription: Recover service.\n---\n# Recovery\n\n## Procedure\nRestart service.\n\n## Verification\nConfirm health.\n');
    put(`${bundle}/schemas/deploy.schema.json`,JSON.stringify({title:'Deploy',description:'Deployment configuration.',type:'object'}));
    put(`${bundle}/docs/state.md`,'---\nstate_transfer:\n  deleted_at: 2026-07-20T08:30:00-04:00\noperational_state:\n  source_repo: example/project\n  source_kind: issue\n  source_id: 1\n  observed_state: open\n  observed_at: 2026-07-21T10:00:00Z\n  classification: fresh\n---\n# State\n');
    const serial=path.join(root,'serial'),parallel=path.join(root,'parallel');
    await buildIndex(root,{graph:'framework',force:true,quiet:true,outputDir:serial,workers:0});
    await buildIndex(root,{graph:'framework',force:true,quiet:true,outputDir:parallel,workers:2});
    expect(read(parallel,'metadata.json').entries).toEqual(read(serial,'metadata.json').entries);
    for(const file of ['tags.json','dependencies.json']) expect(read(parallel,file)).toEqual(read(serial,file));
    const a=read(serial,'relations.json'),b=read(parallel,'relations.json');delete a.generatedAt;delete b.generatedAt;
    expect(b).toEqual(a);
    const entries=read(parallel,'metadata.json').entries;
    expect(entries[`${bundle}/flows/release.yaml`].type).toBe('flow');
    expect(entries[`${bundle}/runbooks/recovery.md`].type).toBe('runbook');
    expect(entries[`${bundle}/schemas/deploy.schema.json`].type).toBe('schema');
    expect(entries[`${bundle}/docs/state.md`].stateTransfer).toBeDefined();
    expect(entries[`${bundle}/docs/state.md`].operationalState).toBeDefined();
  });
  it('retains receipt/stat reuse and checksum-only reuse without reparsing unchanged contents',async()=>{
    const output=path.join(root,'output');
    await buildIndex(root,{graph:'framework',quiet:true,outputDir:output,workers:2});
    const original=read(output,'metadata.json').entries;
    const readSpy=vi.spyOn(fs,'readFileSync');
    await buildIndex(root,{graph:'framework',quiet:true,outputDir:output,workers:2});
    expect(readSpy.mock.calls.some(([file])=>String(file).endsWith('/metadata.json'))).toBe(false);
    readSpy.mockRestore();
    const file=path.join(root,`${bundle}/docs/doc-0.md`),stat=fs.statSync(file);
    fs.utimesSync(file,stat.atime,new Date(stat.mtimeMs+10000));
    await buildIndex(root,{graph:'framework',quiet:true,outputDir:output,workers:2});
    expect(read(output,'metadata.json').entries).toEqual(original);
  });
  it.each(['read', 'parse'])('terminates workers after %s errors and leaves prior metadata/relations untouched',async failure=>{
    const output=path.join(root,'output');
    await buildIndex(root,{graph:'framework',quiet:true,outputDir:output,workers:0});
    const before=fs.readFileSync(path.join(output,'.aiwg/.index/framework/metadata.json'),'utf8');
    const relationBefore=fs.readFileSync(path.join(output,'.aiwg/.index/framework/relations.json'),'utf8');
    const doomed=put(`${bundle}/docs/doomed.md`,failure === 'read' ? '# Removed during preparation\n' : '---\ntags:\n  - toString: 7\n---\n# Invalid tag metadata\n');
    const original=fs.statSync;
    vi.spyOn(fs,'statSync').mockImplementation(((file:any,...args:any[])=>{
      const stat=(original as any)(file,...args);
      if(failure === 'read' && String(file)===doomed) fs.rmSync(doomed);
      return stat;
    }) as any);
    await expect(buildIndex(root,{graph:'framework',force:true,quiet:true,outputDir:output,workers:2})).rejects.toThrow(/doomed.md/);
    expect(fs.readFileSync(path.join(output,'.aiwg/.index/framework/metadata.json'),'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(output,'.aiwg/.index/framework/relations.json'),'utf8')).toBe(relationBefore);
  });
});
