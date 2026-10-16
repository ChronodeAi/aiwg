import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

/** Opaque pinned filesystem boundary; configuration is captured only once. */
export interface ContainedRoot {
  readonly configured: string;
  readonly root: string;
  readonly identity?: BigIntStats | null;
  readonly error?: Error;
}
export interface ContainmentOptions {
  /** Storage may create missing configured roots through a pinned ancestor. */
  createMissing?: boolean;
  /** Artifacts protect location pointers; ordinary storage metadata may opt out. */
  protectLocationPointer?: boolean;
  /** Storage refuses replacement of hardlinks; artifact atomic writes retain compatibility. */
  rejectLinkedWrites?: boolean;
}
export interface ContainedFile {
  handle: FileHandle;
  fullPath: string;
  close(): Promise<void>;
  commit(): Promise<void>;
}
export interface ContainedEntry {
  path: string;
  size: number;
  modifiedAt: Date;
}
export function validateContainedPath(relative: string): void;
export function pinContainedRoot(configured: string, projectRoot?: string, options?: ContainmentOptions): Promise<ContainedRoot>;
export function openContainedFile(store: ContainedRoot, relative: string, options?: { write?: boolean }): Promise<ContainedFile>;
export function readContainedFile(store: ContainedRoot, relative: string): Promise<string | null>;
export function writeContainedFile(store: ContainedRoot, relative: string, content: string): Promise<void>;
export function appendContainedFile(store: ContainedRoot, relative: string, content: string): Promise<void>;
export function deleteContainedFile(store: ContainedRoot, relative: string): Promise<void>;
export function listContainedFiles(store: ContainedRoot, prefix?: string): Promise<ContainedEntry[]>;
