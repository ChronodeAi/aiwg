// Fixture child process for bounded-child-process tests (#3062): reports
// whether stdin was immediately at EOF (fd closed/empty, as Node gives a
// child whose stdin is 'ignore') or actually delivered bytes.
import { readFileSync } from 'node:fs';

try {
  const data = readFileSync(0);
  process.stdout.write(data.length === 0 ? 'EOF\n' : `DATA:${data.toString('utf8')}\n`);
} catch {
  process.stdout.write('EOF\n');
}
