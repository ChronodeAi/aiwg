import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { publish, validateInputs, mirror } from '../../../tools/release/direct-stable-publish.mjs';
const roots=[];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p,{recursive:true,force:true}); });
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aiwg-direct-release-'));roots.push(dir);
 const pairs=[['aiwg','aiwg'],['@aiwg/cli','aiwg-cli'],['@aiwg/cockpit','aiwg-cockpit']];
 const packages=pairs.map(([name,stem])=>{const filename=`${stem}-2026.10.4.tgz`, bytes=Buffer.from(`fixture:${name}`);fs.writeFileSync(path.join(dir,filename),bytes);return {package:name,filename,sha256:createHash('sha256').update(bytes).digest('hex'),installed_version:'2026.10.4',status:'success'};});
 fs.writeFileSync(path.join(dir,'installed-smoke.json'),JSON.stringify({pass:true,packages}));return {dir,packages};
}
function fake(packages,{badIdentity=false,missingProvenance=false,conflict=false,next=false,wrongLatest=false}={}) {
 const calls=[];
 return {calls, spawn(_cmd,args){calls.push(args);if(args[0]==='publish')return {status:conflict?1:0,stderr:conflict?'EPUBLISHCONFLICT':''};
 if(args[0]==='dist-tag')return {status:0};
 if(args[2]==='dist-tags')return {status:0,stdout:JSON.stringify({latest:wrongLatest?'2026.10.3':'2026.10.4',...(next?{next:'2026.10.4'}:{})})};
 const pkg=packages.find(p=>`${p.package}@2026.10.4`===args[1]); const bytes=Buffer.from(`fixture:${pkg.package}`);
 return {status:0,stdout:JSON.stringify({name:pkg.package,version:'2026.10.4',dist:{shasum:badIdentity?'bad':createHash('sha1').update(bytes).digest('hex'),integrity:`sha512-${createHash('sha512').update(bytes).digest('base64')}`,attestations:missingProvenance?{}:{url:'https://example.invalid/attestation',provenance:{predicateType:'https://slsa.dev/provenance/v1'}}}})};
 }};
}
describe('direct stable exact tarball publication',()=>{
 it('publishes three smoke-bound tarballs and recovers verified conflicts',async()=>{const {dir,packages}=fixture(), f=fake(packages,{conflict:true});const result=await publish({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn});expect(result.complete).toBe(true);for(const item of result.packages) expect(item.attestations).toEqual({url:'https://example.invalid/attestation',provenance:{predicateType:'https://slsa.dev/provenance/v1'}});expect(result.packages.map(p=>p.disposition)).toEqual(['already-published','already-published','already-published']);expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(3);});
 it('rejects altered tarballs before any publication',()=>{const {dir}=fixture();fs.writeFileSync(path.join(dir,'aiwg-2026.10.4.tgz'),'altered');expect(()=>validateInputs(dir,'2026.10.4')).toThrow(/Tarball changed/);});
 it.each([{badIdentity:true},{missingProvenance:true}])('rejects unverified registry conflicts %j',async options=>{const {dir,packages}=fixture(),f=fake(packages,{...options,conflict:true});await expect(publish({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn})).rejects.toThrow();expect(f.calls.filter(a=>a[0]==='publish')).toHaveLength(1);});
 it('does not mirror before all three public identities verify',async()=>{const {dir,packages}=fixture(),f=fake(packages,{badIdentity:true});await expect(mirror({directory:dir,version:'2026.10.4',receipt:path.join(dir,'receipt'),spawn:f.spawn})).rejects.toThrow();expect(f.calls.some(a=>a[0]==='publish')).toBe(false);});
 it.each([{next:true},{wrongLatest:true}])('rejects invalid stable tags and retains an incomplete receipt %j',async options=>{const {dir,packages}=fixture(),f=fake(packages,options);const receipt=path.join(dir,'receipt');await expect(publish({directory:dir,version:'2026.10.4',receipt,spawn:f.spawn})).rejects.toThrow(/tag policy/);expect(JSON.parse(fs.readFileSync(receipt)).complete).toBe(false);});
});
