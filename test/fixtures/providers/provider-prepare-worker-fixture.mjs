import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { retainPreparationChannel } from '../../../tools/agents/providers/provider-prepare-channel.mjs';

let order;
process.once('SIGTERM', () => {
  fs.appendFileSync(process.env.AIWG_COORDINATOR_TRACE, `term:${order}:${process.pid}:${Date.now()}\n`);
  setTimeout(() => {
    fs.appendFileSync(process.env.AIWG_COORDINATOR_TRACE, `exit:${order}:${process.pid}:${Date.now()}\n`);
    process.exit(0);
  }, 30);
});

process.once('message', request => {
  if (request.args.includes('--unref-delay')) retainPreparationChannel();
  order = request.order;
  const delay = Number(request.args.find(value => value.startsWith('--delay='))?.slice(8) || 0);
  const linger = Number(request.args.find(value => value.startsWith('--linger='))?.slice(9) || 0);
  const fail = request.args.includes('--fail');
  const waitForSibling = request.args.includes('--wait-for-sibling');
  const exit = () => linger ? setTimeout(() => process.exit(0), linger) : process.exit(0);
  fs.appendFileSync(process.env.AIWG_COORDINATOR_TRACE, `start:${request.order}:${Date.now()}\n`);
  const run = () => {
    if (request.args.includes('--hold-for-termination')) {
      setInterval(() => {}, 1_000);
      return;
    }
    if (waitForSibling && !fs.readFileSync(process.env.AIWG_COORDINATOR_TRACE, 'utf8').includes('start:1:')) {
      if (Date.now() >= deadline) {
        process.send({ version: 1, type: 'error', capability: request.capability, jobId: request.jobId, error: { message: 'fixture sibling readiness timed out' } }, exit);
      } else setTimeout(run, 10);
      return;
    }
    if (fail) {
      process.send({ version: 1, type: 'error', capability: request.capability, jobId: request.jobId, error: { message: 'fixture failure' } }, exit);
      return;
    }
    const plan = { jobId: request.jobId, order: request.order, attempt: request.attempt };
    const body = Buffer.from(JSON.stringify(plan));
    const planPath = `${request.scratch}/plan.json`;
    fs.writeFileSync(planPath, body);
    fs.appendFileSync(process.env.AIWG_COORDINATOR_TRACE, `end:${request.order}:${Date.now()}\n`);
    process.send({
      version: 1,
      type: 'prepared',
      capability: request.capability,
      jobId: request.jobId,
      plan: { path: planPath, size: body.length, sha256: createHash('sha256').update(body).digest('hex') },
    }, exit);
  };
  const deadline = Date.now() + 10_000;
  const timer = setTimeout(run, delay);
  if (request.args.includes('--unref-delay') || request.args.includes('--unref-delay-unheld')) timer.unref();
});
