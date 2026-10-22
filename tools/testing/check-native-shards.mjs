#!/usr/bin/env node
/** Verify native file discovery and sharding without importing test bodies. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVitest } from 'vitest/node';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function assertPartition(inventory, shards) {
  const members = shards.flat();
  if (!inventory.length || new Set(inventory).size !== inventory.length) {
    throw new Error('Native inventory must be nonempty and unique');
  }
  if (new Set(members).size !== members.length) throw new Error('Native shards overlap');
  const expected = new Set(inventory);
  if (members.length !== inventory.length || members.some(file => !expected.has(file))) {
    throw new Error('Native shard union differs from the unsharded inventory');
  }
}

export async function inspectNativeShards(count, { root = repositoryRoot, config = 'config/vitest.config.js' } = {}) {
  if (!Number.isSafeInteger(count) || count < 2) throw new Error('Shard count must be an integer of at least 2');
  const ctx = await createVitest('test', { root, config, watch: false, reporters: [] });
  try {
    const specs = await ctx.globTestSpecifications();
    const name = spec => path.relative(root, spec.moduleId).split(path.sep).join('/');
    const inventory = specs.map(name).sort();
    const shards = [];
    // Use the installed runner's configured sequencer, not a copy of its hash
    // algorithm. Discovery does not run global setup or collect test bodies.
    for (let index = 1; index <= count; index++) {
      ctx.config.shard = { index, count };
      const sequencer = new ctx.config.sequence.sequencer(ctx);
      shards.push((await sequencer.shard([...specs])).map(name).sort());
    }
    assertPartition(inventory, shards);
    return { inventory, shards };
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await inspectNativeShards(Number(process.argv[2]))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
