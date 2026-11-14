import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import { createProjectUploadsRouter } from './project-uploads.js';
import { ProjectUploadStore } from '../uploads/project-uploads.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

function harness(options: { active?: number; role?: 'admin' | 'member'; userId?: string; ownerUserId?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upload-route-'));
  const store = new ProjectUploadStore();
  const audits: unknown[] = [];
  const app = new Hono();
  app.route('/api/projects', createProjectUploadsRouter({
    store,
    getProject: (id) => id === projectId ? {
      id: projectId, name: '项目', path: root, created_at: 1, updated_at: 1,
      pinned: 0, pinned_at: null, is_system: 0, owner_user_id: options.ownerUserId ?? userId,
    } : undefined,
    countActiveSessions: () => options.active || 0,
    authenticate: () => ({ id: options.userId ?? userId, username: 'user', displayName: '用户', role: options.role ?? 'admin', avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null }),
    auditedExternal: (input, action) => { audits.push(input); return action(); },
  }));
  return { app, root, store, audits, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('原始请求体完成上传、用量查询和草稿取消闭环', async () => {
  const current = harness();
  try {
    const uploadId = uuid();
    const messageId = uuid();
    const response = await current.app.request(`/api/projects/${projectId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'image/jpeg',
        'x-relay-upload-id': uploadId,
        'x-relay-message-id': messageId,
        'x-relay-file-name': encodeURIComponent('相册照片.jpg'),
        'x-relay-file-size': '4',
      },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    assert.equal(response.status, 201);
    const uploaded = await response.json() as any;
    assert.equal(uploaded.attachment.uploadId, uploadId);
    assert.equal(uploaded.attachment.name, '相册照片.jpg');
    assert.equal(uploaded.usage.temporaryFileCount, 1);

    const usage = await (await current.app.request(`/api/projects/${projectId}/uploads/usage`)).json() as any;
    assert.equal(usage.usedBytes, 4);
    assert.equal(usage.reservedBytes, 0);

    const deleted = await current.app.request(`/api/projects/${projectId}/uploads/drafts/${uploadId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json() as any).deletedCount, 1);
  } finally { current.cleanup(); }
});

test('管理员清理他人项目上传时携带固定审计元数据', async () => {
  const adminId = '33333333-3333-4333-8333-333333333333';
  const current = harness({ role: 'admin', userId: adminId, ownerUserId: userId });
  try {
    assert.equal((await current.app.request(`/api/projects/${projectId}/uploads`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(current.audits, [{
      actorUserId: adminId, action: 'project.upload_delete', resourceType: 'project',
      resourceId: projectId, ownerUserId: userId,
    }]);
  } finally { current.cleanup(); }
});

test('普通成员不能通过项目 UUID 访问其他账号的上传资源', async () => {
  const current = harness({ role: 'member', userId: '33333333-3333-4333-8333-333333333333', ownerUserId: userId });
  try {
    assert.equal((await current.app.request(`/api/projects/${projectId}/uploads`)).status, 404);
    assert.equal((await current.app.request(`/api/projects/${projectId}/uploads/usage`)).status, 404);
  } finally { current.cleanup(); }
});

test('上传拒绝错误大小和危险文件且不遗留临时目录', async () => {
  const current = harness();
  try {
    const response = await current.app.request(`/api/projects/${projectId}/uploads`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-relay-upload-id': uuid(),
        'x-relay-message-id': uuid(),
        'x-relay-file-name': encodeURIComponent('renamed.txt'),
        'x-relay-file-size': '4',
      },
      body: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json() as any).code, 'DANGEROUS_UPLOAD');
    assert.equal(current.store.getUsage(current.root).temporaryFileCount, 0);
  } finally { current.cleanup(); }
});

test('项目运行中时拒绝已归档上传清理', async () => {
  const current = harness({ active: 1 });
  try {
    const listing = await current.app.request(`/api/projects/${projectId}/uploads`);
    assert.match((await listing.json() as any).cleanupBlockedReason, /运行中的会话/);
    const response = await current.app.request(`/api/projects/${projectId}/uploads`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, 'PROJECT_ACTIVE');
  } finally { current.cleanup(); }
});

test('上传路由不接受无效项目、uploadId 或文件名编码', async () => {
  const current = harness();
  try {
    assert.equal((await current.app.request('/api/projects/not-a-project/uploads', { method: 'POST' })).status, 400);
    const invalid = await current.app.request(`/api/projects/${projectId}/uploads`, {
      method: 'POST',
      headers: { 'x-relay-upload-id': 'bad', 'x-relay-file-name': '%E0%A4%A', 'x-relay-file-size': '1' },
      body: Buffer.from('x'),
    });
    assert.equal(invalid.status, 400);
  } finally { current.cleanup(); }
});
