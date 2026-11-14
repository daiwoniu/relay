import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TRANSIENT_NOTICE_DELAY_MS,
  getDelayedComposerStatusNoticeIdentity,
  resolveVisibleComposerStatusNotice,
  resolveVisibleComposerStatusNotices,
  scheduleDelayedComposerStatusNotice,
} from './delayed-composer-status-notice.ts';

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    timers: {
      set(callback, delayMs) {
        const id = nextId++;
        pending.set(id, { callback, at: now + delayMs });
        return id;
      },
      clear(id) { pending.delete(id); },
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...pending]) {
        if (timer.at > now) continue;
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

const sending = { id: 'sending:正在发送…', message: '正在发送…', tone: 'processing' };
const verifying = { id: 'verifying:正在核实发送结果', message: '正在核实发送结果', tone: 'processing' };

test('info/processing 满 500ms 才发布', () => {
  const fake = createFakeTimers();
  const identity = getDelayedComposerStatusNoticeIdentity(sending, 'session-a');
  let visibleIdentity = 'stale';
  scheduleDelayedComposerStatusNotice(identity, (value) => { visibleIdentity = value; }, fake.timers);
  assert.equal(visibleIdentity, null);
  fake.advance(TRANSIENT_NOTICE_DELAY_MS - 1);
  assert.equal(visibleIdentity, null);
  fake.advance(1);
  assert.equal(visibleIdentity, identity);
  assert.equal(resolveVisibleComposerStatusNotice(sending, identity, visibleIdentity), sending);
});

test('阶段切换会取消旧计时并为新提示重新计时', () => {
  const fake = createFakeTimers();
  let visibleIdentity = null;
  const sendingIdentity = getDelayedComposerStatusNoticeIdentity(sending, 'session-a');
  const cancelSending = scheduleDelayedComposerStatusNotice(sendingIdentity, (value) => { visibleIdentity = value; }, fake.timers);
  fake.advance(300);
  cancelSending();
  const verifyingIdentity = getDelayedComposerStatusNoticeIdentity(verifying, 'session-a');
  scheduleDelayedComposerStatusNotice(verifyingIdentity, (value) => { visibleIdentity = value; }, fake.timers);
  fake.advance(499);
  assert.equal(visibleIdentity, null);
  fake.advance(1);
  assert.equal(visibleIdentity, verifyingIdentity);
});

test('scope 参与身份校验，旧会话提示不能进入新会话', () => {
  const oldIdentity = getDelayedComposerStatusNoticeIdentity(sending, 'session-a');
  const newIdentity = getDelayedComposerStatusNoticeIdentity(sending, 'session-b');
  assert.notEqual(oldIdentity, newIdentity);
  assert.equal(resolveVisibleComposerStatusNotice(sending, newIdentity, oldIdentity), null);
});

test('warning/danger 立即显示且不进入延迟计时', () => {
  for (const tone of ['warning', 'danger']) {
    const notice = { id: `${tone}:异常`, message: '异常', tone };
    assert.equal(getDelayedComposerStatusNoticeIdentity(notice, 'session-a'), null);
    assert.equal(resolveVisibleComposerStatusNotice(notice, null, null), notice);
  }
});

test('多条提示分别延迟，弹窗列表不会提前计入短暂处理状态', () => {
  const warning = { id: 'warning:附件被忽略', message: '附件被忽略', tone: 'warning' };
  const queued = { id: 'queued:消息已排队', message: '消息已排队', tone: 'info' };
  const candidates = [sending, warning, queued];
  assert.deepEqual(resolveVisibleComposerStatusNotices(candidates, 'session-a', new Set()).map(({ message }) => message), ['附件被忽略']);
  const visible = new Set([getDelayedComposerStatusNoticeIdentity(sending, 'session-a')]);
  assert.deepEqual(resolveVisibleComposerStatusNotices(candidates, 'session-a', visible).map(({ message }) => message), ['正在发送…', '附件被忽略']);
  assert.deepEqual(resolveVisibleComposerStatusNotices(candidates, 'session-b', visible).map(({ message }) => message), ['附件被忽略']);
});
