import { resolve } from 'node:path';
import { readConfig } from './config.mjs';
import { createEventLogger } from './events.mjs';
import { createLabServer } from './http.mjs';

const config = readConfig();
const log = createEventLogger(resolve('.artifacts/logs/lab'));
const server = createLabServer(config, { log, dist: resolve('.artifacts/build/lab') });
server.on('error', error => {
  log({ event: 'server.failed', component: 'http', operation: 'listen', status: 'error', code: error.code });
  console.error(JSON.stringify({ event: 'server.failed', code: error.code }));
  process.exitCode = 1;
});
server.listen(config.port, '127.0.0.1', () => {
  log({ event: 'server.started', component: 'http', operation: 'listen', port: server.address().port, liveEnabled: config.liveEnabled });
  console.log(JSON.stringify({ event: 'server.ready', url: `http://127.0.0.1:${server.address().port}`, liveEnabled: config.liveEnabled }));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => {
  log({ event: 'server.stopped', component: 'http', operation: 'shutdown' });
  process.exit(0);
}));
