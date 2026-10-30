import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { root, childEnvironment } from '../shared/config.mjs';
import { withDeployment } from './with-deployment.mjs';

await withDeployment(async (config) => {
  const tests = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/*.test.mjs'], {
    cwd: root, env: childEnvironment(config), stdio: 'inherit',
  });
  tests.on('error', (error) => { throw error; });
  const [code] = await once(tests, 'exit');
  process.exitCode = code ?? 1;
});
