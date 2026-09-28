import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

process.umask(0o077);
const dataDir = process.env.WB_DATA_DIR || join(homedir(), '.workbuddy2api');
const cli = process.env.WB_CLI || '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
const source = process.env.WB_SOURCE_PRODUCT_CONFIG || resolve(dirname(cli), '../product.json');
if (!existsSync(cli) || !existsSync(source)) {
  throw new Error('Install WorkBuddy first, or set WB_CLI and WB_SOURCE_PRODUCT_CONFIG.');
}
const product = JSON.parse(readFileSync(source, 'utf8'));
if (!product.authentication?.id) throw new Error('Unsupported WorkBuddy product configuration');
product.authentication.type = 'account-scoped-external-link';
const productPath = process.env.WB_PRODUCT_CONFIG || join(dataDir, 'product-gateway.json');
const tokenPath = process.env.WB_TOKEN_FILE || join(dataDir, 'token');
for (const dir of [dataDir, dirname(productPath), dirname(tokenPath)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(productPath, JSON.stringify(product), { mode: 0o600 });
chmodSync(productPath, 0o600);
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
chmodSync(tokenPath, 0o600);
console.log('Setup complete. Local runtime files:', dataDir);
console.log('Start with npm start, then run npm run login in another terminal.');
