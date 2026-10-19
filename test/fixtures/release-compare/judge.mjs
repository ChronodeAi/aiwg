// Offline transport fixture. Never invokes a model.
import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const dimensions = Object.fromEntries(Object.keys(request.rubric).map(key => [key, 4]));
process.stdout.write(JSON.stringify({ model: request.model, winner: 'tie', reason: 'Offline identical fixture responses.',
  scores: { left: dimensions, right: dimensions } }));
