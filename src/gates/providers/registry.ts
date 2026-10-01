import type { MetricProvider } from './types.js';

/** Registry of metric providers. Unknown or duplicate ids fail at load; nothing resolves by default. */
export class MetricProviderRegistry {
  private readonly providers = new Map<string, MetricProvider>();

  register(provider: MetricProvider): void {
    if (!provider || typeof provider.id !== 'string' || !provider.id.trim()
      || typeof provider.version !== 'string' || !provider.version.trim()
      || typeof provider.sourceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(provider.sourceDigest)
      || !provider.metrics || typeof provider.metrics !== 'object'
      || typeof provider.compute !== 'function') {
      throw new Error('metric provider registration requires id, version, sourceDigest, metrics and compute');
    }
    if (provider.codeDigest !== undefined
      && (typeof provider.codeDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(provider.codeDigest))) {
      throw new Error(`metric provider ${provider.id} code digest is unknown`);
    }
    if (this.providers.has(provider.id)) throw new Error(`duplicate metric provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  get(id: unknown): MetricProvider {
    const provider = typeof id === 'string' ? this.providers.get(id) : undefined;
    if (!provider) throw new Error(`unknown metric provider: ${String(id)}`);
    return provider;
  }

  has(id: unknown): boolean {
    return typeof id === 'string' && this.providers.has(id);
  }

  ids(): string[] {
    return [...this.providers.keys()].sort();
  }
}
