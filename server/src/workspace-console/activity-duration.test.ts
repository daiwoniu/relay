import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readObservedTaskDurations } from './activity-duration.js';

test('merges overlapping task activity intervals without counting gaps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-activity-duration-'));
  try {
    const dir = path.join(root, '.tmp', 'task-activity', 'task-a');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'first.json'), JSON.stringify({ task_id: 'task-a', started_at: '2026-09-26T09:00:00+08:00', ended_at: '2026-09-26T10:00:00+08:00' }));
    await fs.writeFile(path.join(dir, 'second.json'), JSON.stringify({ task_id: 'task-a', started_at: '2026-09-26T09:30:00+08:00', ended_at: '2026-09-26T10:30:00+08:00' }));
    await fs.writeFile(path.join(dir, 'third.json'), JSON.stringify({ task_id: 'task-a', started_at: '2026-09-26T11:00:00+08:00', ended_at: null }));
    await fs.writeFile(path.join(dir, 'invalid.json'), '{');
    const durations = await readObservedTaskDurations(root, ['task-a', 'task-b'], Date.parse('2026-09-26T11:10:00+08:00'));
    assert.equal(durations.get('task-a'), 6000);
    assert.equal(durations.get('task-b'), undefined);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
