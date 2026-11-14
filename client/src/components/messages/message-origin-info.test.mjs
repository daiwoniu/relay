import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  getClientDescription,
  getDeviceDescription,
  getVisibleNetworkSource,
} from './message-origin-presentation.ts';

const info = await readFile(new URL('./MessageOriginInfo.tsx', import.meta.url), 'utf8');
const user = await readFile(new URL('./UserMessage.tsx', import.meta.url), 'utf8');
const list = await readFile(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');

test('用户消息直接显示设备信息入口且时间保持最右', () => {
  assert.match(user, /message-actions[\s\S]*?origin && <MessageOriginInfo[\s\S]*?<span className="shrink-0">\{formatSentTime\(createdAt\)\}<\/span>/);
  assert.match(info, /aria-label="查看设备信息"/);
  assert.match(info, /aria-haspopup="dialog"/);
  assert.match(info, /title="设备信息"/);
});

test('设备信息合并设备系统与客户端版本字段', async () => {
  for (const label of ['发送人', '设备', '浏览器', '客户端', '网络来源']) {
    assert.match(info, new RegExp(label));
  }
  assert.doesNotMatch(info, /<InfoRow label="系统"|<InfoRow label="来源"/);
  assert.match(info, /<HoverCard disabled=\{mobile\}/);
  assert.match(info, /<DetailsDialog open=\{detailsOpen\}/);
  assert.doesNotMatch(info, /Popover|服务端接收时间|formatReceivedAt|Message ID|Turn ID|deviceId/);

  assert.equal(getDeviceDescription({ source: 'web', deviceType: 'desktop', osName: 'Windows', osVersion: '11', relayVersion: '0.20.1' }), '电脑 · Windows 11');
  assert.equal(getDeviceDescription({ source: 'web', deviceType: 'phone', relayVersion: '0.20.1' }), '手机');
  assert.equal(getDeviceDescription(undefined), null);
  assert.equal(getClientDescription({ source: 'web', deviceType: 'desktop', relayVersion: '0.20.1' }), 'Web · Relay 0.20.1');
  assert.equal(getClientDescription({ source: 'pwa', deviceType: 'phone', relayVersion: '0.20.1' }), 'PWA · Relay 0.20.1');
  assert.equal(getClientDescription(undefined), null);
});

test('loopback 网络来源不展示，局域网来源保留', () => {
  assert.equal(getVisibleNetworkSource('127.0.0.1'), null);
  assert.equal(getVisibleNetworkSource('127.0.0.8'), null);
  assert.equal(getVisibleNetworkSource('::1'), null);
  assert.equal(getVisibleNetworkSource('::ffff:127.0.0.1'), null);
  assert.equal(getVisibleNetworkSource('local'), null);
  assert.equal(getVisibleNetworkSource('192.168.1.108'), '192.168.1.108');
});

test('消息列表向来源面板传递来源与移动端状态', () => {
  assert.match(list, /origin=\{msg\.origin\}/);
  assert.match(list, /mobile=\{mobile\}/);
});
