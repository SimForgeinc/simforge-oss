import { spawn } from 'node:child_process';
import path from 'node:path';
import { repositoryRoot } from './drive/model-socket.js';

/** The Python trainer owns recipe validation, immutable configs and checkpoint export. */
export async function trainCommand(argv: readonly string[]): Promise<number> {
  const root = repositoryRoot();
  const python = process.env['SIMFORGE_TRAIN_PYTHON'] ?? path.join(root, 'adapters/gym/.venv/bin/python');
  const child = spawn(python, ['-m', 'simforge_oss_gym.train', ...argv], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: [process.env['PYTHONPATH'], path.join(root, 'adapters/gym'), path.join(root, 'adapters/policy-endpoint')].filter(Boolean).join(path.delimiter) },
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
