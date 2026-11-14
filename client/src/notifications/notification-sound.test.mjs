import assert from 'node:assert/strict';
import test from 'node:test';
import { getNotificationSoundPeakGain, NOTIFICATION_SOUND_DEFINITIONS, NOTIFICATION_SOUND_OPTIONS } from './notification-sound.ts';

test('提供七种稳定且短促的内置提示音', () => {
  assert.deepEqual(NOTIFICATION_SOUND_OPTIONS.map((item) => item.label), ['轻柔双音', '清脆提示', '柔和铃声', '简短单音', '高穿透双响', '上扬三音', '低沉下降音']);
  assert.equal(Object.keys(NOTIFICATION_SOUND_DEFINITIONS).length, 7);
  for (const definition of Object.values(NOTIFICATION_SOUND_DEFINITIONS)) {
    assert.ok(definition.notes.length > 0);
    assert.ok(Math.max(...definition.notes.map((note) => note.stop)) <= 0.45);
  }
});

test('音量映射最高达到 0.55 并单调递增', () => {
  assert.equal(getNotificationSoundPeakGain(10), 0.055);
  assert.equal(getNotificationSoundPeakGain(45), 0.2475);
  assert.equal(getNotificationSoundPeakGain(80), 0.44);
  assert.equal(getNotificationSoundPeakGain(100), 0.55);
});
