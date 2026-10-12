// The implementation is also imported by tests in the separate Node runner.
import { writeExecutable as write, writeExecutableSync as writeSync } from './write-executable.mjs';

export async function writeExecutable(path: string, content: string): Promise<void> {
  await write(path, content);
}

export function writeExecutableSync(path: string, content: string): void {
  writeSync(path, content);
}
