import assert from 'node:assert/strict';
import test from 'node:test';
import { isCurrentWebSocketConnection } from './websocket-generation.ts';

const socketA = {};
const socketB = {};

test('只有当前 socket、当前代际且组件存活时允许处理事件', () => {
  assert.equal(isCurrentWebSocketConnection({
    socket: socketA,
    generation: 2,
    currentSocket: socketA,
    currentGeneration: 2,
    disposed: false,
  }), true);
  assert.equal(isCurrentWebSocketConnection({
    socket: socketA,
    generation: 1,
    currentSocket: socketA,
    currentGeneration: 2,
    disposed: false,
  }), false);
  assert.equal(isCurrentWebSocketConnection({
    socket: socketA,
    generation: 2,
    currentSocket: socketB,
    currentGeneration: 2,
    disposed: false,
  }), false);
  assert.equal(isCurrentWebSocketConnection({
    socket: socketA,
    generation: 2,
    currentSocket: socketA,
    currentGeneration: 2,
    disposed: true,
  }), false);
});
