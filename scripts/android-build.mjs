import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'win32') throw new Error('请在 WSL2 中运行构建脚本，或者使用 Android Studio 打开 android 工程。');
const runtime = resolve(root, '.artifacts/runtime');
const cache = process.env.GRADLE_USER_HOME || resolve(root, '.artifacts/android-gradle');
await mkdir(runtime, { recursive: true });
await mkdir(cache, { recursive: true });
const args = ['--no-daemon', '--console=plain', '--max-workers=4'];
if (process.env.HTTPS_PROXY) {
  const proxy = new URL(process.env.HTTPS_PROXY);
  if (proxy.protocol !== 'http:') throw new Error('Gradle 的 HTTPS_PROXY 需要使用 HTTP 代理地址。');
  args.push(`-Dhttps.proxyHost=${proxy.hostname}`, `-Dhttps.proxyPort=${proxy.port || '80'}`,
    `-Dhttp.proxyHost=${proxy.hostname}`, `-Dhttp.proxyPort=${proxy.port || '80'}`, '-Dhttp.nonProxyHosts=localhost|127.*');
}
if (process.argv.length < 3) throw new Error('请指定 Gradle 任务与 -PcodexServerUrl，例如 assembleDebug -PcodexServerUrl=https://codex.example.com。');
args.push(...process.argv.slice(2));
const result = spawnSync(resolve(root, 'android/gradlew'), args, {
  cwd: resolve(root, 'android'), stdio: 'inherit',
  env: { ...process.env, GRADLE_USER_HOME: cache, TMPDIR: runtime, TMP: runtime, TEMP: runtime,
    ANDROID_USER_HOME: process.env.ANDROID_USER_HOME || resolve(root, '.artifacts/android-user'), ANDROID_TMP: runtime,
    JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS || ''} -Djava.io.tmpdir=${runtime}`.trim() },
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Android 构建失败，退出状态为 ${result.status}，终止信号为 ${result.signal}。`);
