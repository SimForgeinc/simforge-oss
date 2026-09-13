import { spawn } from 'node:child_process';

const useMock = process.argv.includes('--mock');
const children = [];
const start = (command, args) => {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });
  children.push(child);
  child.on('exit', (code) => { if (code && !process.exitCode) process.exitCode = code; });
};

if (useMock) start(process.execPath, [new URL('./mock-server.mjs', import.meta.url).pathname]);
start('pnpm', ['exec', 'vite']);

const stop = () => children.forEach((child) => child.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
