import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const action = process.argv[2] || 'status';
if (!['login', 'status'].includes(action)) throw new Error('Use login or status');
const dataDir = process.env.WB_DATA_DIR || join(homedir(), '.workbuddy2api');
const token = readFileSync(process.env.WB_TOKEN_FILE || join(dataDir, 'token'), 'utf8').trim();
const base = `http://127.0.0.1:${Number(process.env.WB_GATEWAY_PORT || 18490)}`;
const response = await fetch(`${base}/v1/backend-auth/${action}`, {
  method: action === 'login' ? 'POST' : 'GET',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(action === 'login' ? { body: '{}' } : {}),
  signal: AbortSignal.timeout(25000),
});
if (!response.ok) throw new Error(`Authorization endpoint returned HTTP ${response.status}`);
const data = (await response.json()).data || {};
if (action === 'status') {
  console.log(data.authenticated === true ? 'Authenticated' : 'Authorization required');
  process.exitCode = data.authenticated === true ? 0 : 1;
} else if (data.authUrl) {
  const url = new URL(data.authUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'www.workbuddy.cn') {
    throw new Error('Unexpected authorization destination; inspect the installed WorkBuddy version.');
  }
  const child = spawn('open', [url.href], { stdio: 'ignore' });
  child.on('error', () => { console.error('Unable to open the authorization page. macOS is required.'); process.exitCode = 1; });
  child.on('exit', code => {
    if (code) { console.error('Unable to open the authorization page.'); process.exitCode = 1; }
    else console.log('Complete authorization in your browser, then run npm run auth:status.');
  });
} else if (data.authenticated) {
  console.log('Authenticated');
} else {
  throw new Error('No authorization URL returned; check auth:status before retrying.');
}
