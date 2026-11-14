import assert from 'node:assert/strict';
import test from 'node:test';
import { detectDeviceCategory } from './device-category.ts';

test('优先使用与应用布局一致的视口断点', () => {
  assert.equal(detectDeviceCategory({ viewportWidth: 390, userAgentDataMobile: false, userAgent: 'Windows' }), 'mobile');
  assert.equal(detectDeviceCategory({ viewportWidth: 1023, userAgentDataMobile: false, userAgent: 'Windows' }), 'mobile');
  assert.equal(detectDeviceCategory({ viewportWidth: 1024, userAgentDataMobile: true, userAgent: 'iPhone' }), 'desktop');
});

test('缺少有效视口时使用 userAgentData.mobile', () => {
  assert.equal(detectDeviceCategory({ userAgentDataMobile: true, userAgent: 'Windows' }), 'mobile');
  assert.equal(detectDeviceCategory({ userAgentDataMobile: false, userAgent: 'iPhone' }), 'desktop');
});

test('缺少 userAgentData 时回退移动端 UA 检测', () => {
  assert.equal(detectDeviceCategory({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' }), 'mobile');
  assert.equal(detectDeviceCategory({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), 'desktop');
});
