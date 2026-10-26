import {randomBytes} from 'node:crypto';import {writeFileSync,existsSync} from 'node:fs';
if(existsSync('.env')){console.error('.env 已存在；为防止访问码失效，不覆盖。');process.exit(1)}
writeFileSync('.env',`NODE_ENV=development\nHOST=127.0.0.1\nPORT=3100\nADMIN_PASSWORD=${randomBytes(24).toString('base64url')}\nCODE_PEPPER=${randomBytes(32).toString('hex')}\n`,{mode:0o600});console.log('已生成 .env。请在本机查看 ADMIN_PASSWORD，并妥善保管；后台 /admin。');
