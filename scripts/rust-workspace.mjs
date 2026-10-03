import { spawnSync } from 'node:child_process';

const operation = process.argv[2];
const argumentsByOperation = {
  clippy: ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
  'run-coach': ['run', '-p', 'agora-coach-api'],
  'run-model': ['run', '-p', 'buzzasr-gateway'],
  test: ['test', '--workspace'],
};

if (!argumentsByOperation[operation]) {
  throw new Error('Hindi kilalang Rust workspace operation.');
}

const command = process.platform === 'win32' ? 'rustup' : 'cargo';
const toolchain = process.platform === 'win32'
  ? ['run', '1.98.0-x86_64-pc-windows-gnu', 'cargo']
  : [];
const result = spawnSync(command, [...toolchain, ...argumentsByOperation[operation]], {
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
