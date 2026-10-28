// Forked managed-admission submitter for the 100-request crash test: submits
// assigned requests with busy-lock retry and reports admitted counts over IPC.
import { FileAdmissionStore, SharedHostScheduler } from '../../src/serve/shared-host-scheduler.js';

const [storePath, policyJson, assignmentsJson, tag, pauseAfter] = process.argv.slice(2);
const policy = JSON.parse(policyJson);
const assignments = JSON.parse(assignmentsJson) as Array<{ requestId: string; request: unknown }>;
const store = new FileAdmissionStore(storePath);
const scheduler = new SharedHostScheduler(store, policy);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let reported = 0;

for (const { requestId, request } of assignments) {
  let state = 'unknown';
  for (let attempt = 0; ; attempt += 1) {
    try {
      state = scheduler.submit(request as never).state;
      break;
    } catch (error) {
      if (!/busy; retry/.test((error as Error).message) || attempt >= 30_000) throw error;
      await sleep(1);
    }
  }
  const admitted = Object.values(store.read().records).filter(record => record.state === 'admitted');
  const members: Record<string, number> = {};
  for (const record of admitted) {
    const member = record.managed?.member ?? 'unscoped';
    members[member] = (members[member] ?? 0) + 1;
  }
  process.send?.({ tag, pid: process.pid, requestId, state, admitted: admitted.length, members });
  // Hold the owned child alive at the crash boundary until the parent kills it.
  if (++reported === Number(pauseAfter)) await new Promise(resolve => process.once('message', resolve));
}
process.send?.({ tag, pid: process.pid, done: true });
process.exit(0);
