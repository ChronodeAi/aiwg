import { readFileSync, writeFileSync } from 'node:fs';
import { generate, rowHash, digest } from './prototype.mjs';
const plan=JSON.parse(readFileSync(new URL('./preregister.json',import.meta.url),'utf8'));
const splits=generate(plan);
// No metrics, fit, or final-test inspection occurs in this freezing step.
const frozen={schemaVersion:'conformal-frozen-data/v1',preregistrationHash:digest(plan), generatorHash:digest(readFileSync(new URL('./prototype.mjs',import.meta.url),'utf8')),
 hashes:Object.fromEntries(Object.entries(splits).map(([name,rows])=>[name,rowHash(rows)])),splits};
writeFileSync(new URL('./frozen.json',import.meta.url),JSON.stringify(frozen));
