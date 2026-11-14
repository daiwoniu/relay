import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('PowerShell 进程控制排除自身并限定 Edge user-data-dir 参数', () => {
  const content = fs.readFileSync(new URL('./process-control.ps1', import.meta.url), 'utf8');
  assert.match(content, /ProcessId\s+-ne\s+\$PID/u);
  assert.match(content, /Name\s+-ieq\s+'msedge\.exe'/u);
  assert.match(content, /--user-data-dir=/u);
});
