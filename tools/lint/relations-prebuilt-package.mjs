#!/usr/bin/env node
// Deliberately does not invoke prepack: a lint must detect, not repair, staleness.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrebuiltRelations } from '../../src/artifacts/prebuilt-relations.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errors = checkPrebuiltRelations(root);
for (const error of errors) console.error(`✗ ${error}`);
if (errors.length) process.exitCode = 1;
else console.log('✓ Prebuilt relationship and resolved binding tables match the shipped source');
