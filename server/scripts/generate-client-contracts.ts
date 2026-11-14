import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderClientContracts } from '../src/contracts/generator.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = path.resolve(SERVER_ROOT, '..', 'client', 'src', 'generated', 'relay-contracts.ts');
const expected = renderClientContracts();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n') : null;
  if (current !== expected) {
    console.error('客户端共享协议类型已漂移，请在 server 目录运行 npm run contracts:generate。');
    process.exit(1);
  }
  console.log('✓ 客户端共享协议类型与服务端契约一致');
} else {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, expected, 'utf8');
  console.log(`✓ 已生成 ${path.relative(path.resolve(SERVER_ROOT, '..'), OUTPUT_PATH)}`);
}
