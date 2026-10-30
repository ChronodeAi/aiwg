import 'vitest';
declare module 'vitest' {
  export interface ProvidedContext {
    defaultLaneHome: string;
    basePackageHome: string;
    basePackageManifest: { name: string; version: string; files: Array<{ path: string }> };
  }
}
