import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';

try {
  await access('.env', constants.F_OK);
} catch {
  const secret = randomBytes(32).toString('hex');
  const contents = [
    'NODE_ENV=development',
    'PORT=80',
    'DB_PATH=data/messenger.db',
    `SERVER_SECRET=${secret}`,
    'EXPOSE_DEV_CODE=true',
    'ALLOWED_ORIGINS=http://messenger.local,http://127.0.0.1,http://localhost',
    '',
  ].join('\n');
  await writeFile('.env', contents, { encoding: 'utf8', mode: 0o600 });
  console.log('Created a local .env file.');
}
