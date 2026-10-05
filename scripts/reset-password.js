// 忘记管理密码时用：npm run reset-password
// 直接改数据库里的密码，所以只有能登录这台服务器的人才能执行。已保存的账号信息不受影响。
import readline from 'node:readline/promises';
import bcrypt from 'bcryptjs';
import { getSetting, setSetting } from '../server/db.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = process.argv[2] || (await rl.question('输入新的管理密码（至少 6 位，输入时会显示在屏幕上）：'));
rl.close();

if (password.length < 6) {
  console.error('密码至少 6 位，没有修改。');
  process.exit(1);
}
setSetting('password', bcrypt.hashSync(password, 10));
// 密码版本号加一，让所有已登录的设备失效
setSetting('pwd_ver', getSetting('pwd_ver', 0) + 1);
console.log('管理密码已重置。所有已登录的设备需要重新输入密码。服务不需要重启。');
