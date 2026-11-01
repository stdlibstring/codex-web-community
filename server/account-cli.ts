import { input, password } from '@inquirer/prompts';
import { resolve } from 'node:path';
import { AccountStore, emailSchema, newPasswordSchema, passwordHash } from './account-store.js';
import { AccountMail } from './account-mail.js';

const command = process.argv[2];
if (!['password', 'email'].includes(command) || process.argv.length !== 3) {
  throw new Error('使用 npm run password:reset 或 npm run recovery:email。密码通过终端隐藏输入。');
}
if (!process.stdin.isTTY) throw new Error('请在交互终端里面运行账户管理命令。');
const state = resolve(process.env.CODEX_WEB_ROOT || process.cwd(), '.artifacts');
const store = new AccountStore(state);
if (command === 'password') {
  const revision = store.account().revision;
  const next = await password({ message: '输入新密码（至少十五个字符）：', mask: true,
    validate: value => newPasswordSchema.safeParse(value).success || '请输入十五至五百一十二个字符的密码。' });
  await password({ message: '再次输入新密码：', mask: true, validate: value => value === next || '两次输入的密码不同。' });
  store.replacePassword(await passwordHash(next), revision);
  console.log('访问密码已更新。全部设备的登录和未使用的恢复链接已撤销。');
} else {
  const mail = new AccountMail(store);
  if (!mail.config()) throw new Error('请先在网站的“登录与安全”里面配置邮件服务。');
  const email = emailSchema.parse(await input({ message: '输入新的恢复邮箱：', validate: value => emailSchema.safeParse(value).success || '请输入完整的邮箱地址。' }));
  store.cancelEmail();
  store.beginEmail(email, store.account().revision, true);
  console.log('验证邮件已提交给网站服务。请打开新邮箱中的链接完成绑定。');
}
store.close();
