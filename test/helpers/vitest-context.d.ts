import 'vitest';
declare module 'vitest' {
  export interface ProvidedContext {
    basePackageHome: string;
    basePackageManifest: { name: string; version: string; files: Array<{ path: string }> };
  }
}
