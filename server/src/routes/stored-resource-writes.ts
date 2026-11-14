import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { EngineIdSchema, SessionUpdateResponseDtoSchema, OkDtoSchema, presentApiError } from '../contracts/index.js';
import type { StoredSoftDelete } from '../services/stored-soft-delete.js';
import type { EngineModelCatalog } from '../engine/models/types.js';
import type { EngineId } from '../engine/types.js';
import { EnginePreferencesValidationError, isEnginePreferencesLockedStatus, validateEnginePreferences } from '../engine/models/preferences.js';
import { normalizeProjectPathForOwnership } from '../db/multi-account.js';
import { isAllowedOrigin } from '../security.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError, operationIdentity } from '../storage/command-boundary.js';
import type { CoreStoragePort, StorageCommandEnvelope, StorageRejectionCode } from '../storage/contracts.js';
import { requireEmptyRequestBody } from './empty-request-body.js';

const uuid = z.string().uuid();
const bit = z.union([z.literal(0), z.literal(1)]);
const createProject = z.object({ path: z.string().min(1).max(2048), name: z.string().trim().min(1).max(100).optional() }).strict();
const updateProject = z.object({ name: z.string().trim().min(1).max(100).optional(), pinned: bit.optional(), deletion_protected: bit.optional() }).strict().refine((v) => Object.keys(v).length > 0);
const createSession = z.object({ title: z.string().trim().min(1).max(200).optional(), projectId: uuid.nullable().optional(), engine: EngineIdSchema.nullable().optional() }).strict();
const updateSession = z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: bit.optional(), archived: bit.optional(), project_id: uuid.nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0);
const preferences = z.object({ modelId: z.string().trim().min(1).max(200).nullable(), reasoningEffort: z.string().trim().min(1).max(64).nullable(),
  serviceTier: z.string().trim().min(1).max(64).nullable().optional(), expectedRevision: z.number().int().nonnegative() }).strict();
function stableId(userId: string, key: string, kind: string) {
  const h = createHash('sha256').update(JSON.stringify([userId, key, kind])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
/** Candidate mutation routes only; application bootstrap supplies filesystem, deletion and publication boundaries. */
export function createStoredResourceWritesRouter(options: {
  port: CoreStoragePort; storeId: string; generation: number;
  prepareProject: (requestedPath: string) => Promise<string>; // absolute realpath of an existing directory
  initializeProjectFiles: (realPath: string) => void | Promise<void>; // idempotent, only after commit
  getCatalog: (engine: EngineId, options?: { preferCached?: boolean }) => Promise<EngineModelCatalog>;
  isEngineAvailable: (engine: EngineId) => boolean | Promise<boolean>;
  assertNotDeleting: (kind: 'project' | 'session', id: string) => void;
  changed: (kind: 'project' | 'session', id: string) => void | Promise<void>; // read current projections; never publish receipt values
  softDelete?:Pick<StoredSoftDelete,'delete'>;
}) {
  options = Object.freeze({ ...options });
  const router = new Hono<RelayEnv>();
  const guard = createRequireStoredUserSession(options.port);
  for (const route of ['/projects', '/projects/:id', '/sessions', '/sessions/:id', '/sessions/:id/engine-preferences']) router.use(route, guard);
  type C = Context<RelayEnv>;
  const failure = (c: C, code: StorageRejectionCode) => {
    if (code === 'FORBIDDEN' || code === 'NOT_FOUND') return c.json(presentApiError('资源不存在或没有操作权限'), 404);
    if (code === 'INVALID_ARGUMENT') return c.json(presentApiError('无效的资源参数'), 400);
    if (code === 'CONFLICT' || code === 'OPERATION_EXPIRED') return c.json(presentApiError('状态已变化或操作冲突，请刷新后重试', { code }), 409);
    return c.json(presentApiError('存储暂不可用，请稍后核对状态', { code: 'STORAGE_UNAVAILABLE' }), 503);
  };
  router.onError((error, c) => error instanceof EnginePreferencesValidationError
    ? c.json(presentApiError(error.message, { code: error.code }), 422)
    : failure(c, error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE'));
  const begin = (c: C) => {
    if (!isAllowedOrigin(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许'), 403);
    const key = uuid.safeParse(c.req.header('x-relay-operation-id') ?? randomUUID());
    if (!key.success) return failure(c, 'INVALID_ARGUMENT');
    c.header('x-relay-operation-id', key.data); return key.data;
  };
  function requestFor(c: C, key: string, command: StorageCommandEnvelope['command']): StorageCommandEnvelope {
    const principal = c.get('relayStoragePrincipal')!;
    return { protocolVersion: 1, storeId: options.storeId, workerGeneration: options.generation,
      requestId: randomUUID(), operationId: `resources:${createHash('sha256').update(principal.userId).digest('hex').slice(0,32)}:${key}`, principal, command };
  }
  const execute = (c: C, key: string, command: StorageCommandEnvelope['command']) => executeStoredCommand(options.port, requestFor(c, key, command));
  async function publish(kind: 'project' | 'session', id: string) {
    try { await options.changed(kind, id); } catch { console.warn('[Resources] 当前资源通知暂不可用'); }
  }
  async function sessionResult(c: C, key: string, command: Extract<StorageCommandEnvelope['command'], { name: 'session.create' | 'session.update' | 'session.setPreferences' }>, knownCommitted = false) {
    options.assertNotDeleting('session', command.input.sessionId);
    const result = knownCommitted ? { state: 'committed' as const } : await execute(c, key, command);
    if (result.state === 'rejected') return failure(c, result.code);
    await publish('session', command.input.sessionId);
    if (result.state === 'unknown') return c.json(presentApiError('操作结果暂时无法确认，请刷新核对', { code: 'STORAGE_RESULT_UNKNOWN' }), 503);
    try {
      const session = await options.port.readSession({ principal: c.get('relayStoragePrincipal')!, sessionId: command.input.sessionId });
      if (!session) throw new Error('CURRENT_PROJECTION_UNAVAILABLE');
      return command.name === 'session.create' ? c.json(session, 201) : c.json(SessionUpdateResponseDtoSchema.parse({ ok: true, session }));
    } catch { return c.json(presentApiError('操作已保存，当前会话状态暂不可用', { code: 'RESOURCE_STATE_UNAVAILABLE' }), 503); }
  }
  router.post('/projects', async (c) => {
    const key = begin(c); if (key instanceof Response) return key;
    const parsed = createProject.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return failure(c, 'INVALID_ARGUMENT');
    if (!path.isAbsolute(parsed.data.path)) return failure(c, 'INVALID_ARGUMENT');
    let realPath: string;
    try { realPath = await options.prepareProject(parsed.data.path); } catch { return c.json(presentApiError('项目路径不存在或不可访问'), 400); }
    const principal = c.get('relayStoragePrincipal')!;
    const name = parsed.data.name ?? (path.basename(realPath) || realPath);
    const result = await execute(c, key, { name: 'project.create', input: { projectId: stableId(principal.userId, key, 'project'), path: realPath, name } });
    if (result.state === 'rejected') return failure(c, result.code);
    if (result.state === 'unknown') return c.json(presentApiError('项目创建结果暂时无法确认，请刷新核对', { code: 'STORAGE_RESULT_UNKNOWN' }), 503);
    const value = result.value as { projectId: string; created: boolean };
    await publish('project', value.projectId);
    try {
      const project = await options.port.readProject({ principal, projectId: value.projectId }); if (!project) throw new Error('CURRENT_PROJECTION_UNAVAILABLE');
      const currentPath = await options.prepareProject(project.path);
      if (normalizeProjectPathForOwnership(currentPath) !== normalizeProjectPathForOwnership(project.path)) throw new Error('PROJECT_PATH_CHANGED');
      // A second current-principal check after filesystem awaits prevents initialization using a revoked login.
      if (!await options.port.readProject({ principal, projectId: value.projectId })) throw new Error('CURRENT_PROJECTION_UNAVAILABLE');
      // Ensure on both create and existing-project retries; the initializer must preserve existing files.
      await options.initializeProjectFiles(currentPath);
      return c.json(project, value.created ? 201 : 200);
    } catch { return c.json(presentApiError('项目已保存，目录初始化或状态刷新尚未完成', { code: 'PROJECT_INITIALIZATION_INCOMPLETE' }), 503); }
  });
  router.patch('/projects/:id', async (c) => {
    const key = begin(c); if (key instanceof Response) return key;
    const id = uuid.safeParse(c.req.param('id')), parsed = updateProject.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !parsed.success) return failure(c, 'INVALID_ARGUMENT');
    options.assertNotDeleting('project', id.data);
    const v = parsed.data;
    const result = await execute(c, key, { name: 'project.update', input: { projectId: id.data, changes: {
      ...(v.name === undefined ? {} : { name: v.name }), ...(v.pinned === undefined ? {} : { pinned: v.pinned === 1 }),
      ...(v.deletion_protected === undefined ? {} : { deletionProtected: v.deletion_protected === 1 }),
    } } });
    if (result.state === 'rejected') return failure(c, result.code);
    await publish('project', id.data);
    return result.state === 'unknown' ? c.json(presentApiError('操作结果暂时无法确认，请刷新核对', { code: 'STORAGE_RESULT_UNKNOWN' }), 503) : c.json({ ok: true });
  });
  router.post('/sessions', async (c) => {
    const key = begin(c); if (key instanceof Response) return key;
    const parsed = createSession.safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return failure(c, 'INVALID_ARGUMENT');
    if (parsed.data.engine && !await options.isEngineAvailable(parsed.data.engine)) return failure(c, 'NOT_SUPPORTED');
    if (parsed.data.projectId) options.assertNotDeleting('project', parsed.data.projectId);
    return sessionResult(c, key, { name: 'session.create', input: { sessionId: stableId(c.get('relayStoragePrincipal')!.userId, key, 'session'),
      projectId: parsed.data.projectId ?? null, title: parsed.data.title ?? null, engine: parsed.data.engine ?? null } });
  });
  router.patch('/sessions/:id', async (c) => {
    const key = begin(c); if (key instanceof Response) return key;
    const id = uuid.safeParse(c.req.param('id')), parsed = updateSession.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !parsed.success) return failure(c, 'INVALID_ARGUMENT');
    const v = parsed.data; if (v.project_id) options.assertNotDeleting('project', v.project_id);
    return sessionResult(c, key, { name: 'session.update', input: { sessionId: id.data, changes: {
      ...(v.title === undefined ? {} : { title: v.title }), ...(v.pinned === undefined ? {} : { pinned: v.pinned === 1 }),
      ...(v.archived === undefined ? {} : { archived: v.archived === 1 }), ...(v.project_id === undefined ? {} : { projectId: v.project_id }),
    } } });
  });
  router.patch('/sessions/:id/engine-preferences', async (c) => {
    const key = begin(c); if (key instanceof Response) return key;
    const id = uuid.safeParse(c.req.param('id')), parsed = preferences.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !parsed.success) return failure(c, 'INVALID_ARGUMENT');
    const command = { name: 'session.setPreferences' as const, input: { sessionId: id.data, ...parsed.data } };
    const request = requestFor(c, key, command), identity = operationIdentity(request);
    const receipt = await options.port.lookup({ storeId: options.storeId, operationId: request.operationId, principal: request.principal,
      expected: { commandName: command.name, inputDigest: identity.inputDigest } });
    if (receipt.state === 'committed') return sessionResult(c, key, command, true);
    if (receipt.state === 'expired') return failure(c, 'OPERATION_EXPIRED');
    if (receipt.state === 'unavailable') return failure(c, 'STORAGE_UNAVAILABLE');
    if (receipt.state === 'rejected') return failure(c, receipt.code);
    const current = await options.port.readSession({ principal: c.get('relayStoragePrincipal')!, sessionId: id.data });
    if (!current) return failure(c, 'NOT_FOUND');
    if (!current.engine || isEnginePreferencesLockedStatus(current.status)) return failure(c, 'CONFLICT');
    const values = parsed.data;
    const serviceTier = values.serviceTier === undefined ? values.modelId === current.engine_preferences.modelId ? current.engine_preferences.serviceTier ?? null : null : values.serviceTier;
    validateEnginePreferences(await options.getCatalog(current.engine), { ...values, serviceTier });
    return sessionResult(c, key, command);
  });
  for(const kind of ['project','session'] as const)router.delete(`/${kind}s/:id`,async(c)=>{
    c.header('Cache-Control','private, no-store');
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许'),403);
    // The candidate requires a retained key: an ambiguous DELETE must not silently create a second intent.
    const key=uuid.safeParse(c.req.header('x-relay-operation-id')),id=uuid.safeParse(c.req.param('id'));
    if(!key.success||!id.success||Object.keys(c.req.query()).length)return failure(c,'INVALID_ARGUMENT');
    await requireEmptyRequestBody(c.req.raw);
    c.header('x-relay-operation-id',key.data.toLowerCase());
    if(!options.softDelete)return failure(c,'STORAGE_UNAVAILABLE');
    const result=await options.softDelete.delete(c.get('relayStoragePrincipal')!,{kind,id:id.data},key.data.toLowerCase());
    if(result.state==='committed')return c.json(OkDtoSchema.parse({ok:true}));
    if(result.state==='rejected')return failure(c,result.code);
    return c.json(presentApiError('删除结果暂时无法确认，请保留操作标识并稍后核对',{code:'SOFT_DELETE_RESULT_UNKNOWN'}),503);
  });
  return router;
}
