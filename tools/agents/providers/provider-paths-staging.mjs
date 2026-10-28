/** Stage and restore provider path overrides without writing through getter-only accessors. */
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
