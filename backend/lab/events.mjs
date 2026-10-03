import { mkdirSync, existsSync, statSync, renameSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export function createEventLogger(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'events.jsonl');
  return event => {
    const bounded = { timestamp: new Date().toISOString(), severity: /error|failed/.test(event.status ?? event.event) ? 'error' : 'info', codeVersion: 'agora-lab-1.0.0', ...event };
    if (existsSync(file) && statSync(file).size > 256 * 1024) {
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
    }
    appendFileSync(file, `${JSON.stringify(bounded)}\n`);
  };
}
