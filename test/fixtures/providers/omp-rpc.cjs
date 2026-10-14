const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const config = JSON.parse(process.env.AIWG_OMP_TEST_CONFIG);
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');

if (config.mode === 'descendant') {
  setInterval(() => {}, 1000);
} else if (config.mode === 'ignore-eof') {
  process.on('SIGTERM', () => {});
  send({ type: 'ready' });
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else if (config.mode === 'eof') {
  send({ type: 'ready', supportedProtocolVersions: [1] });
  createInterface({ input: process.stdin }).once('line', () => {
    process.stdout.write(JSON.stringify({ type: 'response', id: 'aiwg-1', command: 'prompt', success: true }) + '\n',
      () => process.exit(0));
  });
} else if (config.mode === 'session') {
  send({ type: 'agent_end', messages: config.messages });
} else if (config.mode === 'dispose') {
  const child = spawn(process.execPath, [__filename], {
    stdio: 'ignore',
    env: { ...process.env, AIWG_OMP_TEST_CONFIG: JSON.stringify({ mode: 'descendant' }) },
  });
  send({ type: 'ready' });
  process.stdin.resume();
  process.stdin.on('end', () => setTimeout(() => {
    child.once('exit', () => {
      fs.writeFileSync(config.receipt, String(child.pid));
      process.exit(0);
    });
    child.kill('SIGTERM');
  }, 100));
} else if (config.mode === 'warm') {
  const log = label => fs.appendFileSync(config.trace, label + ' ' + Date.now() + '\n');
  if (process.argv[2] === '--version') {
    log('warmup');
    process.stdout.write('18.1.10\n');
  } else {
    log('rpc-start');
    process.stdin.resume();
    setTimeout(() => send({ type: 'ready' }), 150);
  }
} else if (config.mode === 'reject') {
  fs.writeFileSync(config.pidFile, String(process.pid));
  send({ type: 'ready', supportedProtocolVersions: [1, 2] });
  createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    send({ type: 'response', id: frame.id, command: frame.type, success: false });
  });
} else if (config.mode === 'negotiate') {
  send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, config.version] });
  setTimeout(() => process.stderr.write('fixture stderr noise'), 25);
  createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    send({ type: 'response', id: frame.id, command: frame.type, success: true,
      data: frame.type === 'get_state' ? { isStreaming: false } : { protocolVersion: 2 } });
    if (frame.type === 'prompt') {
      send({ type: 'agent_end', willContinue: true, messages: [] });
      send({ type: 'message_end', message: config.message });
      send({ type: 'agent_end', messages: [] });
    }
  });
} else {
  throw new Error('Unknown OMP fixture mode');
}
