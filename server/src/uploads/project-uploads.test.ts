import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { v4 as uuid } from 'uuid';
import {
  MAX_PROJECT_UPLOAD_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  ProjectUploadStore,
  UploadError,
  normalizeUploadName,
} from './project-uploads.js';

function createProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upload-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function* chunks(...values: Buffer[]) {
  for (const value of values) yield value;
}

test('同一消息的文件共用目录并保留安全原文件名', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const uploadId = uuid();
    const messageId = uuid();
    const attachment = await store.writeUpload({
      projectId: uuid(), projectPath: project.root, userId: uuid(), uploadId, messageId,
      name: '..\\相册/照片.JPG', mimeType: 'image/jpeg', declaredSize: 4,
      body: chunks(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    });
    assert.equal(attachment.name, '照片.JPG');
    assert.equal(path.basename(attachment.path), '照片.JPG');
    assert.equal(path.dirname(attachment.path), path.join(fs.realpathSync(project.root), '.relay_upload', 'tmp', messageId));
    assert.equal(fs.readFileSync(attachment.path).length, 4);
  } finally { project.cleanup(); }
});

test('上传文件名不能占用 manifest 内部命名空间或绕过容量统计', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const first = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId: uuid(), uploadId: uuid(),
      name: 'manifest.json', mimeType: 'application/json', declaredSize: 4, body: chunks(Buffer.from('DATA')),
    });
    assert.notEqual(path.basename(first.path).toLowerCase(), 'manifest.json');
    assert.equal(fs.readFileSync(first.path, 'utf8'), 'DATA');

    const second = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId: uuid(), uploadId: uuid(),
      name: '.manifest-user.txt', mimeType: 'text/plain', declaredSize: 5, body: chunks(Buffer.from('12345')),
    });
    assert.equal(fs.readFileSync(second.path, 'utf8'), '12345');
    assert.equal(store.getUsage(project.root).usedBytes, 9);
  } finally { project.cleanup(); }
});

test('危险扩展名检查以最终可移植文件名为准', () => {
  assert.throws(() => normalizeUploadName('setup.jar.'), /不允许上传/);
  assert.throws(() => normalizeUploadName('shortcut.lnk...'), /不允许上传/);
});

test('同一消息并发上传会合并 manifest 并为重名文件追加后缀', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const upload = (value: string) => store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId: uuid(),
      name: '报告.txt', mimeType: 'text/plain', declaredSize: value.length,
      body: chunks(Buffer.from(value)),
    });
    const drafts = await Promise.all([upload('a'), upload('bb')]);
    assert.deepEqual(drafts.map((draft) => path.basename(draft.path)).sort(), ['报告 (2).txt', '报告.txt']);
    assert.equal(new Set(drafts.map((draft) => path.dirname(draft.path))).size, 1);
    assert.equal(store.getUsage(project.root).temporaryFileCount, 2);
    const archived = store.prepareArchive({ projectPath: project.root, projectId, userId, messageId, drafts });
    assert.equal(new Set(archived.attachments.map((attachment) => path.dirname(attachment.path))).size, 1);
    assert.equal(path.dirname(archived.attachments[0].path), path.join(fs.realpathSync(project.root), '.relay_upload', 'messages', messageId));
  } finally { project.cleanup(); }
});

test('删除消息草稿中的单个附件会保留同组其他文件和目录', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const first = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId: uuid(),
      name: 'first.txt', mimeType: 'text/plain', declaredSize: 1, body: chunks(Buffer.from('a')),
    });
    const second = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId: uuid(),
      name: 'second.txt', mimeType: 'text/plain', declaredSize: 1, body: chunks(Buffer.from('b')),
    });
    assert.equal(store.deleteTemporary(project.root, first.uploadId, userId, projectId), true);
    assert.equal(fs.existsSync(first.path), false);
    assert.equal(fs.existsSync(second.path), true);
    assert.equal(store.getUsage(project.root).temporaryFileCount, 1);
    const archived = store.prepareArchive({ projectPath: project.root, projectId, userId, messageId, drafts: [second] });
    assert.equal(fs.existsSync(archived.attachments[0].path), true);
  } finally { project.cleanup(); }
});

test('拒绝危险扩展名、可执行文件头和符号链接上传根目录', async () => {
  assert.throws(() => normalizeUploadName('setup.exe'), UploadError);
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    await assert.rejects(() => store.writeUpload({
      projectId: uuid(), projectPath: project.root, userId: uuid(), messageId: uuid(), uploadId: uuid(),
      name: 'renamed.txt', mimeType: 'text/plain', declaredSize: 4,
      body: chunks(Buffer.from([0x4d, 0x5a, 0x90, 0x00])),
    }), /危险文件/);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upload-link-'));
    const linkProject = createProject();
    try {
      fs.symlinkSync(external, path.join(linkProject.root, '.relay_upload'), 'junction');
      assert.throws(() => store.getUsage(linkProject.root), /符号链接/);
    } finally {
      linkProject.cleanup();
      fs.rmSync(external, { recursive: true, force: true });
    }
  } finally { project.cleanup(); }
});

test('执行单文件、项目总量和并发预留限制，失败后释放预留', () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore({ projectLimitBytes: 10, fileLimitBytes: 8 });
    const first = uuid();
    store.reserve(project.root, first, 8);
    assert.equal(store.getUsage(project.root).reservedBytes, 8);
    assert.throws(() => store.reserve(project.root, uuid(), 3), /容量不足/);
    store.release(project.root, first);
    assert.equal(store.getUsage(project.root).reservedBytes, 0);
    assert.throws(() => store.reserve(project.root, uuid(), 9), /单文件/);
    assert.equal(MAX_UPLOAD_FILE_BYTES, 50 * 1024 * 1024);
    assert.equal(MAX_PROJECT_UPLOAD_BYTES, 1024 * 1024 * 1024);
  } finally { project.cleanup(); }
});

test('上传严格按实际流量计数并清理 .part 与过期临时目录', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore({ fileLimitBytes: 5, projectLimitBytes: 20, now: () => 48 * 60 * 60 * 1000 });
    const uploadId = uuid();
    await assert.rejects(() => store.writeUpload({
      projectId: uuid(), projectPath: project.root, userId: uuid(), messageId: uuid(), uploadId,
      name: 'note.txt', mimeType: 'text/plain', declaredSize: 4,
      body: chunks(Buffer.from('abc'), Buffer.from('de')),
    }), /声明大小不一致|单文件/);
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'tmp', uploadId)), false);
    assert.equal(store.getUsage(project.root).reservedBytes, 0);

    const staleId = uuid();
    const stale = path.join(project.root, '.relay_upload', 'tmp', staleId);
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'manifest.json'), JSON.stringify({
      version: 2, messageId: staleId, projectId: uuid(), userId: uuid(), createdAt: 0, updatedAt: 0, attachments: [],
    }));
    assert.equal(store.cleanupStaleTemporaryUploads(project.root), 1);
    assert.equal(fs.existsSync(stale), false);
  } finally { project.cleanup(); }
});

test('上传完成后复验最终文件大小并清理被替换的载荷', async () => {
  const project = createProject();
  const originalRename = fs.renameSync;
  try {
    let tampered = false;
    fs.renameSync = ((source: fs.PathLike, target: fs.PathLike) => {
      originalRename(source, target);
      if (!tampered && String(source).endsWith('.part')) {
        tampered = true;
        fs.writeFileSync(target, 'tampered');
      }
    }) as typeof fs.renameSync;
    const store = new ProjectUploadStore();
    const messageId = uuid();
    await assert.rejects(() => store.writeUpload({
      projectId: uuid(), projectPath: project.root, userId: uuid(), messageId, uploadId: uuid(),
      name: 'note.txt', mimeType: 'text/plain', declaredSize: 4, body: chunks(Buffer.from('test')),
    }), /发生变化/);
    const directory = path.join(project.root, '.relay_upload', 'tmp', messageId);
    assert.equal(fs.existsSync(directory) && fs.readdirSync(directory).some((entry) => entry === 'note.txt'), false);
  } finally {
    fs.renameSync = originalRename;
    project.cleanup();
  }
});

test('上传过程中管理目录被替换时拒绝继续写入或误删新目录', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const uploadId = uuid();
    async function* replacingBody() {
      yield Buffer.from('a');
      const messagesRoot = path.join(project.root, '.relay_upload', 'messages');
      fs.renameSync(messagesRoot, `${messagesRoot}-original`);
      fs.mkdirSync(messagesRoot);
      fs.writeFileSync(path.join(messagesRoot, 'sentinel.txt'), 'keep');
      yield Buffer.from('b');
    }
    await assert.rejects(() => store.writeUpload({
      projectId: uuid(), projectPath: project.root, userId: uuid(), messageId: uuid(), uploadId,
      name: 'note.txt', mimeType: 'text/plain', declaredSize: 2, body: replacingBody(),
    }), (error: unknown) => error instanceof UploadError && error.code === 'UPLOAD_PATH_CHANGED');
    assert.equal(fs.readFileSync(path.join(project.root, '.relay_upload', 'messages', 'sentinel.txt'), 'utf8'), 'keep');
  } finally { project.cleanup(); }
});

test('上传目录自带 Git 忽略规则，不依赖项目 .git 形态', () => {
  const project = createProject();
  try {
    fs.writeFileSync(path.join(project.root, '.git'), 'gitdir: elsewhere\n');
    new ProjectUploadStore().getUsage(project.root);
    assert.equal(fs.readFileSync(path.join(project.root, '.relay_upload', '.gitignore'), 'utf8'), '*\n');
    assert.equal(fs.existsSync(path.join(project.root, '.gitignore')), false);
  } finally { project.cleanup(); }
});

test('发送前重新验证草稿并原子归档，保存失败可回滚', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const draft = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId: uuid(), name: 'photo.jpg',
      mimeType: 'image/jpeg', declaredSize: 4, body: chunks(Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    });
    assert.throws(() => store.prepareArchive({
      projectPath: project.root, projectId, userId, messageId, drafts: [{ ...draft, size: 3 }],
    }), /信息已变化/);

    const archived = store.prepareArchive({ projectPath: project.root, projectId, userId, messageId, drafts: [draft] });
    assert.equal(fs.existsSync(draft.path), false);
    assert.equal(fs.existsSync(archived.attachments[0].path), true);
    assert.equal(store.listArchived(project.root).length, 1);
    archived.rollback();
    assert.equal(fs.existsSync(draft.path), true);
    assert.equal(store.listArchived(project.root).length, 0);
  } finally { project.cleanup(); }
});

test('归档前重新验证实际文件存在、类型和大小', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const draft = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId: uuid(), name: 'note.txt',
      mimeType: 'text/plain', declaredSize: 4, body: chunks(Buffer.from('test')),
    });
    fs.rmSync(draft.path);
    assert.throws(() => store.prepareArchive({ projectPath: project.root, projectId, userId, messageId, drafts: [draft] }), /不可用|发生变化/);
  } finally { project.cleanup(); }
});

test('重复 uploadId 不会删除既有用户草稿', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const uploadId = uuid();
    const messageId = uuid();
    const projectId = uuid();
    const userId = uuid();
    const original = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId,
      name: 'first.txt', mimeType: 'text/plain', declaredSize: 5, body: chunks(Buffer.from('first')),
    });
    await assert.rejects(() => store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId,
      name: 'second.txt', mimeType: 'text/plain', declaredSize: 6, body: chunks(Buffer.from('second')),
    }), /uploadId 已存在/);
    assert.equal(fs.readFileSync(original.path, 'utf8'), 'first');
  } finally { project.cleanup(); }
});

test('容量统计包含损坏 manifest 目录中的实际载荷', () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    store.getUsage(project.root);
    const directory = path.join(project.root, '.relay_upload', 'tmp', uuid(), 'nested');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'payload.dat'), Buffer.alloc(7));
    assert.equal(store.getUsage(project.root).usedBytes, 7);
  } finally { project.cleanup(); }
});

test('非管理员清理只能看到并删除自己的已归档上传', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const firstUser = uuid();
    const secondUser = uuid();
    const createArchived = async (userId: string, name: string) => {
      const draft = await store.writeUpload({
        projectId, projectPath: project.root, userId, messageId: uuid(), uploadId: uuid(), name,
        mimeType: 'text/plain', declaredSize: 1, body: chunks(Buffer.from('x')),
      });
      store.prepareArchive({ projectPath: project.root, projectId, userId, messageId: draft.messageId, drafts: [draft] });
      return draft;
    };
    const first = await createArchived(firstUser, 'first.txt');
    const second = await createArchived(secondUser, 'second.txt');
    assert.deepEqual(store.listArchived(project.root, firstUser).map((file) => file.name), ['first.txt']);
    assert.equal(store.deleteArchived(project.root, [second.id], firstUser), 0);
    assert.equal(store.deleteArchived(project.root, [first.id], firstUser), 1);
    assert.deepEqual(store.listArchived(project.root).map((file) => file.name), ['second.txt']);
  } finally { project.cleanup(); }
});

test('同一物理目录下不同 Relay 项目的归档上传互不混用', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const userId = uuid();
    const projectA = uuid();
    const projectB = uuid();
    const archive = async (projectId: string, name: string) => {
      const draft = await store.writeUpload({
        projectId, projectPath: project.root, userId, messageId: uuid(), uploadId: uuid(), name,
        mimeType: 'text/plain', declaredSize: 1, body: chunks(Buffer.from('x')),
      });
      store.prepareArchive({ projectPath: project.root, projectId, userId, messageId: draft.messageId, drafts: [draft] });
      return draft;
    };
    const first = await archive(projectA, 'a.txt');
    const second = await archive(projectB, 'b.txt');

    assert.deepEqual(store.listArchived(project.root, undefined, projectA).map((file) => file.name), ['a.txt']);
    assert.equal(store.deleteArchived(project.root, [second.id], undefined, projectA), 0);
    assert.equal(store.deleteArchived(project.root, [first.id], undefined, projectA), 1);
    assert.deepEqual(store.listArchived(project.root, undefined, projectB).map((file) => file.name), ['b.txt']);
  } finally { project.cleanup(); }
});

test('彻底删除只把目标消息附件原子隔离到受控目录并可回滚', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const messageId = uuid();
    const draft = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId, uploadId: uuid(),
      name: 'trash.txt', mimeType: 'text/plain', declaredSize: 5, body: chunks(Buffer.from('trash')),
    });
    store.prepareArchive({ projectPath: project.root, projectId, userId, messageId, drafts: [draft] });
    const operationId = uuid();
    const quarantined = store.quarantineArchivedMessages({ projectPath: project.root, operationId, messageIds: [messageId] });
    assert.ok(quarantined);
    assert.equal(
      quarantined.quarantinePath,
      path.join(fs.realpathSync(project.root), '.relay_upload', '.trash-quarantine', operationId),
    );
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'messages', messageId)), false);
    assert.equal(fs.existsSync(path.join(quarantined.quarantinePath, messageId, 'manifest.json')), true);
    quarantined.rollback();
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'messages', messageId, 'manifest.json')), true);
    assert.equal(fs.existsSync(quarantined.quarantinePath), false);
  } finally { project.cleanup(); }
});

test('会话分支为新消息独立复制托管附件并支持失败回滚', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const projectId = uuid();
    const userId = uuid();
    const sourceMessageId = uuid();
    const targetMessageId = uuid();
    const firstDraft = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId: sourceMessageId, uploadId: uuid(),
      name: 'branch.txt', mimeType: 'text/plain', declaredSize: 6, body: chunks(Buffer.from('branch')),
    });
    const secondDraft = await store.writeUpload({
      projectId, projectPath: project.root, userId, messageId: sourceMessageId, uploadId: uuid(),
      name: 'second.txt', mimeType: 'text/plain', declaredSize: 6, body: chunks(Buffer.from('second')),
    });
    const sourceAttachments = store.prepareArchive({
      projectPath: project.root,
      projectId,
      userId,
      messageId: sourceMessageId,
      drafts: [secondDraft, firstDraft],
    }).attachments;
    const source = sourceAttachments[1]!;

    const copied = store.copyArchivedMessage({
      projectPath: project.root,
      sourceMessageId,
      targetMessageId,
      sourceAttachmentIds: sourceAttachments.map((attachment) => attachment.id),
    });
    assert.equal(copied.attachments.length, 2);
    assert.deepEqual(copied.attachments.map((attachment) => attachment.name), ['second.txt', 'branch.txt']);
    assert.notEqual(copied.attachments[1]!.id, source.id);
    assert.notEqual(copied.attachments[1]!.path, source.path);
    assert.equal(fs.readFileSync(copied.attachments[0]!.path, 'utf8'), 'second');
    assert.equal(fs.readFileSync(copied.attachments[1]!.path, 'utf8'), 'branch');
    assert.equal(store.listArchived(project.root).length, 4);

    copied.rollback();
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'messages', targetMessageId)), false);
    assert.equal(fs.existsSync(source.path), true);
    assert.throws(
      () => store.copyArchivedMessage({
        projectPath: project.root,
        sourceMessageId,
        targetMessageId: uuid(),
        sourceAttachmentIds: [uuid()],
      }),
      /附件列表与存档不一致/,
    );
  } finally { project.cleanup(); }
});

test('管理员分支附件重写目标项目和账号归属，错误来源身份不能复制', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore(), projectId = uuid(), userId = uuid(), messageId = uuid();
    const targetProjectId = uuid(), targetUserId = uuid(), targetMessageId = uuid();
    const draft = await store.writeUpload({ projectId, projectPath: project.root, userId, messageId, uploadId: uuid(),
      name: 'identity.txt', mimeType: 'text/plain', declaredSize: 3, body: chunks(Buffer.from('abc')) });
    const source = store.prepareArchive({ projectPath: project.root, projectId, userId, messageId, drafts: [draft] }).attachments;
    const input = { projectPath: project.root, sourceMessageId: messageId, targetMessageId,
      sourceAttachmentIds: source.map((a) => a.id), sourceIdentity: { projectId, userId }, targetIdentity: { projectId: targetProjectId, userId: targetUserId } };
    assert.throws(() => store.copyArchivedMessage({ ...input, sourceIdentity: { projectId, userId: targetUserId } }), /无权访问/);
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'messages', targetMessageId)), false);
    const copied = store.copyArchivedMessage(input);
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(copied.attachments[0]!.path), 'manifest.json'), 'utf8'));
    assert.equal(manifest.projectId, targetProjectId); assert.equal(manifest.userId, targetUserId); assert.equal(manifest.messageId, targetMessageId);
    const original = JSON.parse(fs.readFileSync(path.join(path.dirname(source[0]!.path), 'manifest.json'), 'utf8'));
    assert.equal(original.projectId, projectId); assert.equal(original.userId, userId);
    copied.rollback(); assert.equal(fs.readFileSync(source[0]!.path, 'utf8'), 'abc');
  } finally { project.cleanup(); }
});

test('附件记录对应目录已缺失时视为无需隔离且不遗留半成品', () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    store.getUsage(project.root);
    const operationId = uuid();
    const quarantined = store.quarantineArchivedMessages({
      projectPath: project.root,
      operationId,
      messageIds: [uuid()],
    });
    assert.equal(quarantined, undefined);
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', '.trash-quarantine', operationId)), false);
  } finally { project.cleanup(); }
});

test('原项目目录已不存在时无需隔离且不重建目录', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upload-missing-'));
  const missingProject = path.join(parent, 'deleted-project');
  try {
    const quarantined = new ProjectUploadStore().quarantineArchivedMessages({
      projectPath: missingProject,
      operationId: uuid(),
      messageIds: [uuid()],
    });
    assert.equal(quarantined, undefined);
    assert.equal(fs.existsSync(missingProject), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('部分附件目录缺失时只隔离仍存在的托管目录', async () => {
  const project = createProject();
  try {
    const store = new ProjectUploadStore();
    const messageId = uuid();
    const userId = uuid();
    const draft = await store.writeUpload({
      projectId: uuid(), projectPath: project.root, userId, messageId, uploadId: uuid(),
      name: 'mixed.txt', mimeType: 'text/plain', declaredSize: 5, body: chunks(Buffer.from('mixed')),
    });
    store.prepareArchive({ projectPath: project.root, projectId: draft.projectId, userId, messageId, drafts: [draft] });
    const quarantined = store.quarantineArchivedMessages({
      projectPath: project.root,
      operationId: uuid(),
      messageIds: [messageId, uuid()],
    });
    assert.ok(quarantined);
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'messages', messageId)), false);
    assert.equal(fs.existsSync(path.join(quarantined.quarantinePath, messageId)), true);
    quarantined.rollback();
    assert.equal(fs.existsSync(path.join(project.root, '.relay_upload', 'messages', messageId)), true);
  } finally { project.cleanup(); }
});

test('附件目录被替换为目录联接时拒绝隔离', () => {
  const project = createProject();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-upload-external-'));
  try {
    const store = new ProjectUploadStore();
    store.getUsage(project.root);
    const messageId = uuid();
    fs.symlinkSync(external, path.join(project.root, '.relay_upload', 'messages', messageId), 'junction');
    assert.throws(() => store.quarantineArchivedMessages({
      projectPath: project.root,
      operationId: uuid(),
      messageIds: [messageId],
    }), (error: unknown) => error instanceof UploadError && error.status === 403);
  } finally {
    project.cleanup();
    fs.rmSync(external, { recursive: true, force: true });
  }
});
