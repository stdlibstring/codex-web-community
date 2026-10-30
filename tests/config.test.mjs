import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema } from '../shared/config.mjs';
import { config } from './helpers.mjs';

test('端口冲突在启动服务之前被拒绝', () => {
  assert.throws(() => configSchema.parse({ ...config, enginePort: config.port }));
});

test('相对路径和无效证书主机名被拒绝', () => {
  assert.throws(() => configSchema.parse({ ...config, project: './project' }));
  assert.throws(() => configSchema.parse({ ...config, hostname: 'localhost,DNS:example.com' }));
});
