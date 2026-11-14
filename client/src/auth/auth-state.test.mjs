import assert from 'node:assert/strict';
import test from 'node:test';
import { getInitialAuthFailureState, getLoginErrorMessage } from './auth-state.ts';

test('登录错误优先使用服务端安全提示', () => {
  assert.equal(getLoginErrorMessage(401, { error: '用户名或密码错误' }), '用户名或密码错误');
  assert.equal(getLoginErrorMessage(429, { error: '登录失败次数过多，请稍后再试' }), '登录失败次数过多，请稍后再试');
});

test('登录错误在响应损坏或服务不可用时提供稳定提示', () => {
  assert.equal(getLoginErrorMessage(500, null), '登录服务暂时不可用，请稍后重试');
  assert.equal(getLoginErrorMessage(0, null), '无法连接 Relay，请检查服务是否已启动');
});

test('初始化认证只有 401 进入游客状态，网络错误保留重试入口', () => {
  assert.equal(getInitialAuthFailureState(401), 'guest');
  assert.equal(getInitialAuthFailureState(0), 'error');
  assert.equal(getInitialAuthFailureState(500), 'error');
});
