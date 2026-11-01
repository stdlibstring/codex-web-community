import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export async function registerVoice(server: FastifyInstance, root: string) {
  let busy = false;
  await server.register(async app => {
    app.addContentTypeParser(/^audio\//, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    app.post('/api/voice/transcribe', { bodyLimit: 16 * 1024 * 1024, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
      if (busy) return reply.code(429).send({ message: '正在转写另一段录音，请稍后重试。' });
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) return reply.code(400).send({ message: '录音内容为空。' });
      busy = true;
      const controller = new AbortController();
      const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once('close', disconnected);
      try {
        const output = await new Promise<string>((accept, reject) => {
          const child = execFile(resolve(root, '.artifacts/voice-venv/bin/python'), [resolve(root, 'scripts/voice-transcribe.py')], {
            cwd: root, timeout: 180000, maxBuffer: 1024 * 1024, signal: controller.signal,
            env: { ...process.env, TMPDIR: resolve(root, '.artifacts/runtime'), HF_HUB_OFFLINE: '1', OMP_NUM_THREADS: '8' },
          }, (error, stdout) => error ? reject(error) : accept(stdout));
          child.stdin!.on('error', reject);
          child.stdin!.end(request.body);
        });
        return JSON.parse(output) as { text: string; language: string };
      } finally {
        reply.raw.removeListener('close', disconnected);
        busy = false;
      }
    });
  });
}
