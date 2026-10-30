/** Provider path staging, logical-output resolution, and destination safety. */
import fs from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export function logicalProviderOutputPath(file, stage, target, mappings = []) {
  const mapping = [...mappings].sort((a, b) => b.to.length - a.to.length)
    .find(item => file === item.to || file.startsWith(`${item.to}${sep}`));
  if (mapping) return mapping.from + file.slice(mapping.to.length);
  return file === stage || file.startsWith(`${stage}${sep}`) ? target + file.slice(stage.length) : file;
}

export function assertNoSymlinkPath(destination, provider) {
  let current = resolve(destination);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`${provider} preserves symlink destination: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function captureProviderPathDescriptors(provider) {
  return Object.getOwnPropertyDescriptors(provider.paths);
}

export function setStagedProviderPath(provider, key, value) {
  try {
    Object.defineProperty(provider.paths, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  } catch {
    const descriptor = Object.getOwnPropertyDescriptor(provider.paths, key);
    if (descriptor?.set || descriptor?.writable) provider.paths[key] = value;
    else throw new Error(`Cannot stage provider path '${key}': accessor has no setter and cannot be redefined`);
  }
}

export function restoreProviderPaths(provider, descriptors) {
  for (const key of Object.keys(provider.paths)) {
    if (!(key in descriptors)) {
      try { delete provider.paths[key]; } catch { /* keep operator-owned key */ }
    }
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    try {
      Object.defineProperty(provider.paths, key, descriptor);
    } catch {
      if (descriptor.set || descriptor.writable) provider.paths[key] = descriptor.value;
    }
  }
}
