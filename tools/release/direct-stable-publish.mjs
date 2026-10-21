#!/usr/bin/env node
// Publish the exact smoke-tested tarballs from this signed-tag workflow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { verifyRegistryPackageIdentity } from './release-promotion.mjs';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
const SURFACES = [{ name: 'aiwg', stem: 'aiwg' }, { name: '@aiwg/cli', stem: 'aiwg-cli' }, { name: '@aiwg/cockpit', stem: 'aiwg-cockpit' }];
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function validateInputs(directory, version) {
  if (!/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('Invalid stable version');
  const smoke = JSON.parse(fs.readFileSync(path.join(directory, 'installed-smoke.json'), 'utf8'));
  if (smoke.pass !== true || !Array.isArray(smoke.packages) || smoke.packages.length !== 3) throw new Error('Missing installed smoke evidence');
  return SURFACES.map(surface => {
    const filename = `${surface.stem}-${version}.tgz`;
    const matches = smoke.packages.filter(x => x.package === surface.name && x.filename === filename && x.installed_version === version && x.status === 'success');
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256)) throw new Error(`Invalid smoke evidence for ${surface.name}`);
    const file = path.join(directory, filename), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || sha256(file) !== matches[0].sha256) throw new Error(`Tarball changed for ${surface.name}`);
    return { name: surface.name, filename, file, sha256: matches[0].sha256 };
  });
}
export async function publish({ directory, version, receipt, spawn = boundedSpawnSync, env = process.env }) {
  const packages = validateInputs(directory, version);
  const record = { schema: 'aiwg-direct-stable-publication/v1', version, packages: [], complete: false };
  const fd = fs.openSync(receipt, 'wx', 0o600);
  const save = () => { const b = Buffer.from(JSON.stringify(record, null, 2) + '\n'); fs.ftruncateSync(fd, 0); fs.writeSync(fd, b, 0, b.length, 0); fs.fsyncSync(fd); };
  const npm = args => spawn('npm', args, 'long', { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  try {
    save();
    for (const item of packages) {
      validateInputs(directory, version);
      const result = npm(['publish', item.file, '--ignore-scripts', '--access', 'public', '--tag', 'latest', '--registry', 'https://registry.npmjs.org', '--provenance']);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      const conflict = /(?:EPUBLISHCONFLICT|cannot publish over the previously published versions|package version already exists|\b409\b)/i.test(output);
      if (result.error || (result.status !== 0 && !conflict)) throw new Error(`Publish failed for ${item.name}`);
      let metadata;
      for (let attempt = 0; attempt < (conflict ? 5 : 1); attempt++) {
        const view = npm(['view', `${item.name}@${version}`, '--json', '--registry', 'https://registry.npmjs.org']);
        if (!view.error && view.status === 0) { try { metadata = JSON.parse(view.stdout); } catch {} if (metadata) break; }
        if (conflict && attempt < 4) await new Promise(resolve => setTimeout(resolve, 3000));
      }
      // A confirmed publish may take time to become visible. An observed
      // identity mismatch remains fatal; a conflict must prove the whole identity.
      let identity = { package: item.name, version, sha256: item.sha256 };
      if ((metadata?.name && metadata.name !== item.name) || (metadata?.version && metadata.version !== version)) throw new Error(`Registry package identity mismatch for ${item.name}@${version}`);
      const bytes = fs.readFileSync(item.file);
      if ((metadata?.dist?.shasum && metadata.dist.shasum !== createHash('sha1').update(bytes).digest('hex')) ||
          (metadata?.dist?.integrity && metadata.dist.integrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}`)) {
        throw new Error(`Registry package identity mismatch for ${item.name}@${version}`);
      }
      if ((metadata?.name && metadata?.version && metadata?.dist?.shasum && metadata?.dist?.integrity) || conflict) {
        identity = verifyRegistryPackageIdentity({ file: item.file, packageName: item.name, version, metadata });
      }
      validateInputs(directory, version);
      const attestations = metadata?.dist?.attestations ?? null;
      const provenance = typeof attestations?.url === 'string' && attestations.url && attestations?.provenance?.predicateType === 'https://slsa.dev/provenance/v1' ? 'observed' : 'pending';
      const registryIdentity = metadata?.name && metadata?.version && metadata?.dist?.shasum && metadata?.dist?.integrity ? 'verified' : 'pending';
      if (registryIdentity === 'pending' || provenance === 'pending') console.warn(`::warning::Registry identity or provenance pending for ${item.name}@${version}; post-asset checks will retry.`);
      record.packages.push({ ...identity, attestations, registry_identity: registryIdentity, provenance, disposition: result.status === 0 ? 'published' : 'already-published' }); save();
    }
    record.complete = true; save(); return record;
  } finally { fs.closeSync(fd); }
}
export async function mirror({ directory, version, receipt, spawn = boundedSpawnSync, env = process.env }) {
  const registry = 'https://git.integrolabs.net/api/packages/roctinam/npm/';
  if (!/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('Invalid stable version');
  const packages = SURFACES.map(({name, stem}) => {
    const filename = `${stem}-${version}.tgz`, file = path.join(directory, filename), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Invalid public tarball ${name}`);
    return {name, filename, file, sha256:sha256(file)};
  });
  const verifyFiles = () => { for (const item of packages) if (sha256(item.file) !== item.sha256) throw new Error(`Tarball changed: ${item.name}`); };
  const npm = args => spawn('npm', args, 'long', { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  // All three public artifacts must already exist and match before any local publication.
  for (const item of packages) {
    const result = npm(['view', `${item.name}@${version}`, '--json', '--registry', 'https://registry.npmjs.org']);
    if (result.error || result.status !== 0) throw new Error(`Public package unavailable: ${item.name}`);
    const metadata = JSON.parse(result.stdout);
    verifyRegistryPackageIdentity({file:item.file, packageName:item.name, version, metadata});
    if (!metadata?.dist?.attestations?.url || metadata.dist.attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1') throw new Error(`Missing public provenance: ${item.name}`);
  }
  const record = { schema:'aiwg-direct-stable-mirror/v1', version, packages:[], complete:false };
  const fd = fs.openSync(receipt, 'wx', 0o600);
  const save = () => { const b=Buffer.from(JSON.stringify(record,null,2)+'\n'); fs.ftruncateSync(fd,0); fs.writeSync(fd,b,0,b.length,0); fs.fsyncSync(fd); };
  try {
    save();
    for (const item of packages) {
      verifyFiles();
      const result = npm(['publish',item.file,'--ignore-scripts','--access','public','--tag','latest','--registry',registry]);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.error || (result.status !== 0 && !/(?:EPUBLISHCONFLICT|cannot publish over the previously published versions|package version already exists|\b409\b)/i.test(output))) throw new Error(`Mirror publish failed for ${item.name}`);
      let metadata;
      for(let i=0;i<5;i++){const view=npm(['view',`${item.name}@${version}`,'--json','--registry',registry]);if(!view.error && view.status===0){metadata=JSON.parse(view.stdout);break;}await new Promise(resolve=>setTimeout(resolve,3000));}
      const identity=verifyRegistryPackageIdentity({file:item.file,packageName:item.name,version,metadata});
      verifyFiles();
      const tag=npm(['dist-tag','add',`${item.name}@${version}`,'latest','--registry',registry]);
      if(tag.error || tag.status!==0)throw new Error(`Mirror tag failed for ${item.name}`);
      record.packages.push({...identity,disposition:result.status===0?'published':'already-published'});save();
    }
    record.complete=true;save();return record;
  } finally { fs.closeSync(fd); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: {type:'string'}, version: {type:'string'}, receipt: {type:'string'}, mirror: {type:'boolean'} } });
    if (values.mirror) await mirror(values); else await publish(values);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
