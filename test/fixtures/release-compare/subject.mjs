// Offline transport fixture. Never invokes a model.
import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({ model: request.model, trace: {
  completed: true, failed: false, tools: [], text: '{"action":"follow","reason":"Fixture policy"}',
}, usage: { input_tokens: 0, output_tokens: 0 } }));
