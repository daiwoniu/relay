import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FrontendCommandSchema,
  FrontendEventSchema,
  ErrorEventSchema,
  CodexVersionDtoSchema,
  SystemResourceStatusDtoSchema,
  EngineMaintenanceOperationDtoSchema,
  MaintenanceOutputSnapshotDtoSchema,
  EngineMaintenanceStatusDtoSchema,
  EngineConcurrencyDtoSchema,
  EngineModelCatalogDtoSchema,
  EnginePreferencesDtoSchema,
  MessageDtoSchema,
  MessageModelInfoDtoSchema,
  ClientDiagnosticsDtoSchema,
  MessageOriginDtoSchema,
  SessionDtoSchema,
  TurnQueueSnapshotDtoSchema,
  RELAY_PROTOCOL_VERSION,
  ApiErrorDtoSchema,
  AuthResponseDtoSchema,
  NotificationPreferencesDtoSchema,
  NotificationPreferencesResponseDtoSchema,
  NotificationSoundSchema,
  ProjectDeletionImpactDtoSchema,
  AccountThemeSettingsDtoSchema,
  AccountThemeSettingsResponseDtoSchema,
  ThemeSettingsInputSchema,
  ApprovalTrustStateDtoSchema,
  PutProjectApprovalTrustRequestSchema,
  PutSessionApprovalTrustRequestSchema,
  ApprovalDecisionSourceSchema,
  ApprovalDecisionScopeSchema,
  InteractionResolvedActionSchema,
  ChangedFileDtoSchema,
  FileAccessResponseDtoSchema,
  OkDtoSchema,
  SessionMessageMatchesResponseDtoSchema,
  SessionDeletionImpactDtoSchema,
  SessionSearchResponseDtoSchema,
  SessionUpdateResponseDtoSchema,
  SharedFrontendEventSchema,
  TrashRestoreResponseDtoSchema,
  TrashImpactDtoSchema,
  TrashProjectDeleteRequestSchema,
  TrashSessionDeleteRequestSchema,
  presentProject,
  presentPublicUser,
  presentSession,
  presentApiError,
} from './index.js';

const sessionId = '11111111-1111-4111-8111-111111111111';

test('异步提问回答必须显式引用有效问题 ID', () => {
  const answer = FrontendCommandSchema.parse({ type: 'send', sessionId, content: '提交', replyToAsyncQuestionId: 'async-question:call-1' });
  assert.equal(answer.type === 'send' ? answer.replyToAsyncQuestionId : undefined, 'async-question:call-1');
  const ordinary = FrontendCommandSchema.parse({ type: 'send', sessionId, content: '其他消息' });
  assert.equal(ordinary.type === 'send' ? ordinary.replyToAsyncQuestionId : undefined, undefined);
  assert.equal(FrontendCommandSchema.safeParse({ type: 'send', sessionId, content: '提交', replyToAsyncQuestionId: 'call-1' }).success, false);
});

test('后续消息状态事件与取消、恢复命令使用严格契约', () => {
  const followup = {
    id: 'message-1', sessionId, content: '继续补充', state: 'queued',
    createdAt: 1, errorCode: null, replyToAsyncQuestionId: null,
  };
  assert.equal(FrontendEventSchema.safeParse({ type: 'session_followup_snapshot', sessionId, followups: [followup] }).success, true);
  assert.equal(FrontendEventSchema.safeParse({ type: 'session_followup_updated', sessionId, followup }).success, true);
  assert.equal(FrontendEventSchema.safeParse({ type: 'session_followup_updated', sessionId, followup: { ...followup, userId: 'private' } }).success, false);
  assert.equal(FrontendCommandSchema.safeParse({ type: 'cancel_followup', sessionId, messageId: followup.id }).success, true);
  assert.equal(FrontendCommandSchema.safeParse({ type: 'resume_followups', sessionId }).success, true);
});

test('消息来源只接受受限客户端环境且发送命令不能伪造服务端事实', () => {
  const client = {
    source: 'web' as const,
    deviceType: 'desktop' as const,
    osName: 'Windows',
    osVersion: '11',
    browserName: 'Edge',
    browserVersion: '140.0.0.0',
    relayVersion: '0.19.0',
  };
  const command = FrontendCommandSchema.parse({ type: 'send', sessionId, content: '你好', client });
  assert.equal(command.type, 'send');
  assert.throws(() => FrontendCommandSchema.parse({
    type: 'send', sessionId, content: '你好', client, ip: '203.0.113.1',
  }));
  assert.equal(MessageOriginDtoSchema.parse({
    senderUserId: 'u1', senderUsername: 'xiang', senderDisplayName: '祥哥',
    ip: '192.168.1.8', receivedAt: 1, client,
  }).client?.browserName, 'Edge');
  assert.throws(() => MessageOriginDtoSchema.parse({
    senderUserId: 'u1', senderUsername: 'xiang', senderDisplayName: '祥哥',
    ip: '192.168.1.8', receivedAt: 1, client: { ...client, userAgent: 'raw' },
  }));
});

test('会话删除进度事件只接受真实阶段或清理信号', () => {
  assert.deepEqual(FrontendEventSchema.parse({
    type: 'session_deletion_progress', sessionId, stage: 'archiving',
  }), { type: 'session_deletion_progress', sessionId, stage: 'archiving' });
  assert.deepEqual(FrontendEventSchema.parse({
    type: 'session_deletion_progress', sessionId, stage: null,
  }), { type: 'session_deletion_progress', sessionId, stage: null });
  assert.throws(() => FrontendEventSchema.parse({
    type: 'session_deletion_progress', sessionId, stage: 'estimating',
  }));
});

test('发送命令只接受有界白名单浏览器诊断快照', () => {
  const clientDiagnostics = {
    capturedAt: 123,
    userAgent: 'Mozilla/5.0 HuaweiBrowser/6.1.7 Chrome/144.0.0.0',
    appVersion: '5.0',
    platform: 'Linux armv8l',
    vendor: 'Huawei',
    languages: ['zh-CN', 'zh'],
    timezone: 'Asia/Shanghai',
    hardwareConcurrency: 8,
    maxTouchPoints: 10,
    standalone: false,
    online: true,
    userAgentData: {
      mobile: true,
      platform: 'Android',
      brands: [{ brand: 'Chromium', version: '144' }],
      highEntropy: { platformVersion: '10.0.0', model: 'HUAWEI' },
    },
    screen: { width: 1260, height: 2720, devicePixelRatio: 3 },
    viewport: { width: 420, height: 850 },
    connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false },
  };
  assert.deepEqual(ClientDiagnosticsDtoSchema.parse(clientDiagnostics), clientDiagnostics);
  const command = FrontendCommandSchema.parse({ type: 'send', sessionId, content: '你好', clientDiagnostics });
  assert.equal(command.type, 'send');
  assert.throws(() => FrontendCommandSchema.parse({
    type: 'send', sessionId, content: '你好', clientDiagnostics: { ...clientDiagnostics, cookie: 'secret' },
  }));
  assert.throws(() => FrontendCommandSchema.parse({
    type: 'send', sessionId, content: '你好', clientDiagnostics: { ...clientDiagnostics, userAgent: 'x'.repeat(4097) },
  }));
});

test('interaction 决定来源、作用域和动作使用严格枚举', () => {
  assert.equal(ApprovalDecisionSourceSchema.parse('session_trust'), 'session_trust');
  assert.equal(ApprovalDecisionScopeSchema.parse('project'), 'project');
  assert.equal(InteractionResolvedActionSchema.parse('resolved_elsewhere'), 'resolved_elsewhere');
  assert.throws(() => ApprovalDecisionSourceSchema.parse('allow_always'));
  assert.throws(() => ApprovalDecisionScopeSchema.parse('account'));
  assert.throws(() => InteractionResolvedActionSchema.parse('accept_once'));
});

test('授权信任 REST 与多端事件契约严格且不接收客户端 expiresAt', () => {
  const state = ApprovalTrustStateDtoSchema.parse({
    projectSetting: {
      scope: 'project', mode: 'trusted', expiresAt: null, createdAt: 1, updatedAt: 1,
    },
    sessionSetting: null,
    effective: {
      trusted: true,
      source: 'project_trust',
      effectiveScope: 'project',
      expiresAt: null,
      sessionOverridesProject: false,
      diagnostic: null,
    },
  });
  assert.equal(PutProjectApprovalTrustRequestSchema.parse({ duration: 'one_hour' }).duration, 'one_hour');
  assert.equal(PutSessionApprovalTrustRequestSchema.parse({ mode: 'manual', duration: 'permanent' }).mode, 'manual');
  assert.throws(() => PutProjectApprovalTrustRequestSchema.parse({ duration: 'one_hour', expiresAt: 123 }));
  assert.throws(() => PutSessionApprovalTrustRequestSchema.parse({ mode: 'future', duration: 'permanent' }));
  const event = FrontendEventSchema.parse({
    type: 'approval_trust_updated',
    scope: 'project',
    scopeId: sessionId,
  });
  assert.equal(event.type, 'approval_trust_updated');
  assert.throws(() => FrontendEventSchema.parse({ ...event, command: 'secret command' }));
  assert.throws(() => FrontendEventSchema.parse({ ...event, state }));
});

test('模型目录、会话偏好和逐轮模型快照使用严格公开契约', () => {
  const preferences = EnginePreferencesDtoSchema.parse({ modelId: 'gpt-5.6-terra', reasoningEffort: 'high', revision: 2 });
  const catalog = EngineModelCatalogDtoSchema.parse({
    engineId: 'codex',
    fetchedAt: 1,
    stale: false,
    models: [{
      id: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      description: 'Balanced model',
      isDefault: true,
      inputModalities: ['text', 'image'],
      contextWindow: 200_000,
      costLabel: '标准',
      reasoning: {
        supported: true,
        scope: 'model',
        defaultOptionId: 'medium',
        options: [{ id: 'medium', label: '中等', description: '平衡速度与质量' }],
      },
    }],
  });
  const modelInfo = MessageModelInfoDtoSchema.parse({
    engineId: 'codex',
    requested: { id: 'gpt-5.6-terra', reasoningEffort: 'high' },
    effective: { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', reasoningEffort: 'high', provider: 'OpenAI' },
    serviceTier: 'priority',
    resolvedServiceTier: 'priority',
    rerouted: false,
  });
  const session = SessionDtoSchema.parse({
    id: sessionId,
    title: '模型会话',
    created_at: 1,
    updated_at: 2,
    pinned: 0,
    pinned_at: null,
    project_id: null,
    engine: 'codex',
    codex_archived: false,
    can_fork: false,
    status: 'idle',
    engine_preferences: preferences,
  });
  const message = MessageDtoSchema.parse({
    id: 'message-1',
    session_id: sessionId,
    turn_id: 'turn-1',
    role: 'assistant',
    content: '完成',
    phase: null,
    created_at: 3,
    duration: 1,
    stopped: false,
    modelInfo,
  });

  assert.equal(catalog.models[0]?.reasoning.options[0]?.id, 'medium');
  assert.equal(session.engine_preferences.revision, 2);
  assert.equal(message.modelInfo?.effective.displayName, 'GPT-5.6 Terra');
  assert.equal(message.modelInfo?.serviceTier, 'priority');
  const sendCommand = FrontendCommandSchema.parse({ type: 'send', sessionId, content: '继续', enginePreferences: preferences });
  assert.equal(sendCommand.type === 'send' ? sendCommand.enginePreferences?.revision : undefined, 2);
  assert.equal(FrontendEventSchema.parse({ type: 'engine_preferences_updated', sessionId, preferences }).type, 'engine_preferences_updated');
  assert.throws(() => EnginePreferencesDtoSchema.parse({ ...preferences, endpoint: 'https://secret.example' }));
  assert.throws(() => MessageModelInfoDtoSchema.parse({ ...modelInfo, account: 'secret' }));
  assert.throws(() => MessageModelInfoDtoSchema.parse({ ...modelInfo, effective: { ...modelInfo.effective, id: 'x'.repeat(201) } }));
});

test('并发与队列契约保持严格脱敏并支持三类增量事件', () => {
  const windows = [5, 15, 60].map((windowMinutes) => ({ windowMinutes, totalCount: 0, overloadCount: 0, requestRetryCount: 0, completionRetryCount: 0, cooldownCount: 0, startAcceptedCount: 0 }));
  const concurrency = EngineConcurrencyDtoSchema.parse({ resourceKey: 'codex:default', engineId: 'codex', label: 'Codex', maxActiveTurns: 2, activeTurns: 1, queuedTurns: 1, cooldownUntil: null, probeInProgress: false, windows });
  const queue = TurnQueueSnapshotDtoSchema.parse({ queueId: '22222222-2222-4222-8222-222222222222', sessionId, engineId: 'codex', resourceKey: 'codex:default', label: 'Codex', state: 'queued', position: 1, activeTurns: 1, maxActiveTurns: 2, cooldownUntil: null, createdAt: 1 });
  assert.equal(FrontendEventSchema.parse({ type: 'engine_concurrency_updated', concurrency }).type, 'engine_concurrency_updated');
  assert.equal(FrontendEventSchema.parse({ type: 'turn_queue_updated', sessionId, queue }).type, 'turn_queue_updated');
  assert.equal(FrontendEventSchema.parse({ type: 'turn_queue_started', sessionId, queueId: queue.queueId }).type, 'turn_queue_started');
  assert.throws(() => EngineConcurrencyDtoSchema.parse({ ...concurrency, endpoint: 'https://secret.example' }));
});

test('修改文件契约要求路径作用域与 external 标记一致', () => {
  assert.equal(ChangedFileDtoSchema.safeParse({ path: 'src/app.ts', changeType: 'modified' }).success, true);
  assert.equal(ChangedFileDtoSchema.safeParse({ path: 'E:\\office\\app.ts', changeType: 'modified', external: true }).success, true);
  assert.equal(ChangedFileDtoSchema.safeParse({ path: 'E:\\office\\app.ts', changeType: 'modified' }).success, false);
  assert.equal(ChangedFileDtoSchema.safeParse({ path: 'src/app.ts', changeType: 'modified', external: true }).success, false);
  assert.equal(ChangedFileDtoSchema.safeParse({ path: 'E:\\office\\..\\app.ts', changeType: 'modified', external: true }).success, false);
  assert.equal(ChangedFileDtoSchema.safeParse({ path: 'E:\\office\\app.ts', changeType: 'modified', external: false }).success, false);
});

test('共享契约 presenter 只输出浏览器允许读取的 DTO 字段', () => {
  assert.deepEqual(presentProject({
    id: 'project-1',
    name: '项目',
    path: 'D:\\work',
    created_at: 1,
    updated_at: 2,
    pinned: 0,
    pinned_at: null,
    is_system: 1,
    secret: '不得输出',
  }), {
    id: 'project-1',
    name: '项目',
    path: 'D:\\work',
    created_at: 1,
    updated_at: 2,
    pinned: 0,
    pinned_at: null,
    is_system: 1,
    deletion_protected: 0,
    members_can_view_sessions: 0,
  });

  assert.deepEqual(presentSession({
    id: sessionId,
    title: '会话',
    created_at: 1,
    updated_at: 2,
    pinned: 0,
    pinned_at: null,
    project_id: null,
    engine: 'codex',
    codex_archived: 1,
    status: 'idle',
    message_revision: 7,
    message_count: 3,
    assistant_message_count: 1,
    archived: 0,
    codex_thread_id: 'internal-thread',
  }), {
    id: sessionId,
    title: '会话',
    created_at: 1,
    updated_at: 2,
    pinned: 0,
    pinned_at: null,
    project_id: null,
    engine: 'codex',
    codex_archived: true,
    can_fork: false,
    status: 'idle',
    engine_preferences: {
      modelId: null,
      reasoningEffort: null,
      serviceTier: null,
      revision: 0,
    },
    message_count: 3,
    assistant_message_count: 1,
    context_compaction_count: 0,
  });

  assert.deepEqual(presentPublicUser({
    id: 'user-1',
    username: 'admin',
    display_name: '管理员',
    role: 'admin',
    avatar_updated_at: 10,
    password_hash: '不得输出',
  }), {
    id: 'user-1', username: 'admin', displayName: '管理员', role: 'admin', avatarUpdatedAt: 10,
    defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null,
    canCreateProject: true,
  });
});

test('共享契约校验 subscribe send cancel 浏览器命令', () => {
  assert.equal(FrontendCommandSchema.parse({ type: 'subscribe', sessionId }).type, 'subscribe');
  const backgroundSubscribe = FrontendCommandSchema.parse({
    type: 'subscribe', sessionId, active: false, includeMessages: false,
  });
  assert.equal(backgroundSubscribe.type === 'subscribe' ? backgroundSubscribe.active : null, false);
  assert.equal(FrontendCommandSchema.parse({ type: 'unsubscribe', sessionId }).type, 'unsubscribe');
  assert.equal(FrontendCommandSchema.parse({ type: 'send', sessionId, content: '你好' }).type, 'send');
  const sendWithEngine = FrontendCommandSchema.parse({ type: 'send', sessionId, content: '你好', engine: 'codebuddy' });
  assert.equal(sendWithEngine.type === 'send' ? sendWithEngine.engine : null, 'codebuddy');
  assert.equal(FrontendCommandSchema.parse({ type: 'cancel', sessionId }).type, 'cancel');
  assert.throws(() => FrontendCommandSchema.parse({ type: 'subscribe', sessionId, extra: true }));
  assert.equal(FrontendCommandSchema.parse({
    type: 'send',
    sessionId,
    content: '',
    attachments: [{
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'host_file',
      name: 'report.txt',
      path: 'C:\\work\\report.txt',
      size: 12,
      accessToken: '44444444-4444-4444-8444-444444444444',
    }],
  }).type, 'send');
  assert.equal(FrontendCommandSchema.parse({
    type: 'send',
    sessionId,
    content: '',
    attachments: [{
      id: '55555555-5555-4555-8555-555555555555',
      kind: 'uploaded_file',
      messageId: '44444444-4444-4444-8444-444444444444',
      uploadId: '66666666-6666-4666-8666-666666666666',
      projectId: '77777777-7777-4777-8777-777777777777',
      name: 'photo.jpg',
      path: 'D:\\project\\.relay_upload\\tmp\\draft\\photo.jpg',
      size: 1024,
      mimeType: 'image/jpeg',
    }],
  }).type, 'send');
  assert.throws(() => FrontendCommandSchema.parse({ type: 'send', sessionId, content: 'x'.repeat(100_001) }));
  assert.equal(FrontendCommandSchema.parse({
    type: 'respond_interaction',
    operationId: '22222222-2222-4222-8222-222222222222',
    sessionId,
    interactionId: 'approval-1',
    action: 'accept',
  }).type, 'respond_interaction');
  assert.throws(() => FrontendCommandSchema.parse({
    type: 'respond_interaction',
    sessionId,
    interactionId: 'approval-1',
    action: 'accept',
  }));
});

test('共享契约校验 sync_state item 和 message_saved 服务端事件', () => {
  const item = {
    id: 'item-1',
    type: 'reasoning',
    status: 'completed',
    details: { content: '完成分析' },
  };
  const message = {
    id: 'message-1',
    session_id: sessionId,
    turn_id: 'turn-1',
    role: 'assistant',
    content: '完成',
    phase: 'final_answer',
    created_at: 1,
    duration: 100,
    stopped: false,
    items: [item],
    processContent: '分析过程',
    processTimeline: [
      { type: 'narrative', itemId: 'reply-1', content: '分析过程' },
      { type: 'operation', itemId: 'item-1' },
    ],
    changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
    changedFilesIncomplete: true,
    tokenUsage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 },
  };
  const { items: _items, processContent: _processContent, processTimeline: _processTimeline, ...summaryBase } = message;
  const summary = {
    ...summaryBase,
    hasDetails: true,
    processItemCount: 1,
    processNarrativeCount: 1,
    changedFileCount: 1,
  };
  assert.equal(SharedFrontendEventSchema.parse({
    type: 'sync_state',
    protocolVersion: RELAY_PROTOCOL_VERSION,
    sessionId,
    messageRevision: 3,
    messageHasMore: true,
    messageNextCursor: { beforeCreatedAt: 1, beforeId: 'message-1' },
    messages: [summary],
    isRunning: true,
    currentContent: '生成中',
    processSteps: [item],
    processTimeline: message.processTimeline,
    startTime: 1,
    requestForwarded: true,
    isStopping: false,
  }).type, 'sync_state');
  assert.equal(SharedFrontendEventSchema.parse({ type: 'item_start', sessionId, item }).type, 'item_start');
  assert.equal(SharedFrontendEventSchema.parse({ type: 'item_complete', sessionId, item }).type, 'item_complete');
  assert.equal(SharedFrontendEventSchema.parse({ type: 'message_saved', sessionId, messageRevision: 4, message }).type, 'message_saved');
  assert.throws(() => SharedFrontendEventSchema.parse({ type: 'item_start', sessionId, item, extra: true }));
});

test('共享契约校验完整服务端事件和协议版本', () => {
  assert.equal(RELAY_PROTOCOL_VERSION, 35);
  const approval = {
    id: 'approval-1',
    sessionId,
    sessionTitle: '会话',
    engine: 'codex',
    kind: 'command_approval',
    title: '运行命令',
    summary: 'npm test',
    details: { command: 'npm test' },
    availableActions: ['accept', 'decline'],
    createdAt: 1,
  };
  const events = [
    { type: 'protocol_info', protocolVersion: RELAY_PROTOCOL_VERSION },
    { type: 'request_forwarded', sessionId },
    { type: 'turn_start', sessionId, turnId: 'turn-1' },
    { type: 'turn_complete', sessionId, turnId: 'turn-1' },
    { type: 'turn_cancelling', sessionId },
    { type: 'turn_cancelled', sessionId },
    { type: 'delta', sessionId, itemId: 'item-1', content: '片段', phase: 'commentary' },
    { type: 'message_complete', sessionId, turnId: 'turn-1', content: '完成', usage: { promptTokens: 10 } },
    { type: 'session_updated', sessionId, session: { id: sessionId, title: '会话', created_at: 1, updated_at: 2, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, can_fork: false, status: 'idle', engine_preferences: { modelId: null, reasoningEffort: null, revision: 0 } } },
    { type: 'session_deleted', sessionId },
    { type: 'project_updated', project: { id: sessionId, name: '项目', path: 'D:\\work', created_at: 1, updated_at: 2, pinned: 1, pinned_at: 2, is_system: 0 } },
    { type: 'project_deleted', projectId: sessionId },
    { type: 'model_info', sessionId, model: 'gpt-5', platformOs: 'windows' },
    { type: 'token_usage', sessionId, usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 }, turnOutputUsage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 260, reasoningOutputTokens: 80, totalTokens: 1460, modelContextWindow: 200000 }, currentTurn: true },
    { type: 'pending_approvals_snapshot', approvals: [approval] },
    { type: 'pending_approval_upserted', approval },
    { type: 'pending_approval_resolved', sessionId, interactionId: 'approval-1', resolvedAction: 'accept' },
    { type: 'pending_approval_resolved', sessionId, interactionId: 'approval-1', resolvedAction: 'resolved_elsewhere' },
    { type: 'interaction_response_result', operationId: '22222222-2222-4222-8222-222222222222', sessionId, interactionId: 'approval-1', outcome: 'accepted' },
    { type: 'notification_preferences_updated', preferences: {
      desktopSystemEnabled: true, desktopSoundEnabled: false,
      desktopSessionEndSystemEnabled: true, desktopSessionEndSoundEnabled: false,
      mobileSystemEnabled: false, mobileSoundEnabled: true,
      mobileSessionEndSystemEnabled: false, mobileSessionEndSoundEnabled: true,
      approvalSound: 'gentle_dual', sessionEndSound: 'crisp', desktopSoundVolume: 45, mobileSoundVolume: 80,
    } },
    { type: 'theme_settings_updated', settings: {
      version: 2,
      basePreference: 'system',
      colorStyle: 'neutral',
      textScale: 'standard',
      linkedProfiles: true,
      desktop: { backgroundKind: 'none', backgroundValue: null, blur: 0, fit: 'cover', position: 'center', overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 1, glassBlur: 0, borderStrength: 0.55 },
      mobile: { backgroundKind: 'none', backgroundValue: null, blur: 0, fit: 'cover', position: 'center', overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 1, glassBlur: 0, borderStrength: 0.55 },
      updatedAt: 1,
    } },
    { type: 'conversation_defaults_updated', user: {
      id: sessionId, username: 'member', displayName: 'Member', role: 'member', avatarUpdatedAt: null,
      defaultProjectId: null, defaultEngine: 'codebuddy', defaultModelId: null, mustChangePassword: false, disabledAt: null,
    } },
    { type: 'sidebar_order_updated', order: { scope: 'projects', custom: true, items: [] } },
    { type: 'error', protocolVersion: RELAY_PROTOCOL_VERSION, sessionId, messageId: '22222222-2222-4222-8222-222222222222', message: '失败', code: 'FAILED' },
  ];
  for (const event of events) assert.equal(FrontendEventSchema.parse(event).type, event.type);
  assert.equal(ErrorEventSchema.parse(events.at(-1)).messageId, '22222222-2222-4222-8222-222222222222');
  assert.throws(() => FrontendEventSchema.parse({ type: 'error', message: '缺少版本' }));
  assert.throws(() => FrontendEventSchema.parse({ type: 'sync_state', protocolVersion: 1 }));
});

test('系统资源契约接受聚合内存榜单且拒绝进程控制信息', () => {
  const snapshot = SystemResourceStatusDtoSchema.parse({
    available: true,
    level: 'warning',
    committedBytes: 80,
    commitLimitBytes: 100,
    usagePercent: 80,
    observedAt: 123,
    warningThresholdPercent: 80,
    criticalThresholdPercent: 90,
  });
  assert.equal(snapshot.level, 'warning');
  assert.throws(() => SystemResourceStatusDtoSchema.parse({ ...snapshot, pid: 1 }));
  const processMemory = {
    relay: { privateBytes: 80, backendPrivateBytes: 20, processCount: 3, scope: 'managed' },
    topProcesses: [{ name: 'node.exe', privateBytes: 80, processCount: 3 }],
  };
  assert.deepEqual(SystemResourceStatusDtoSchema.parse({ ...snapshot, processMemory }).processMemory, processMemory);
  for (const entry of [
    { ...processMemory.topProcesses[0], pid: 1 },
    { ...processMemory.topProcesses[0], name: 'C:\\secret.exe' },
    { ...processMemory.topProcesses[0], privateBytes: -1 },
  ]) assert.throws(() => SystemResourceStatusDtoSchema.parse({ ...snapshot, processMemory: { ...processMemory, topProcesses: [entry] } }));
  assert.throws(() => SystemResourceStatusDtoSchema.parse({ ...snapshot, processMemory: {
    ...processMemory, topProcesses: Array(6).fill(processMemory.topProcesses[0]),
  } }));
});

test('共享契约校验常用 REST 包装响应', () => {
  assert.deepEqual(ApiErrorDtoSchema.parse({ error: '禁止访问', code: 'FORBIDDEN', canForceAccess: true }), {
    error: '禁止访问', code: 'FORBIDDEN', canForceAccess: true,
  });
  assert.deepEqual(OkDtoSchema.parse({ ok: true }), { ok: true });
  assert.equal(AuthResponseDtoSchema.parse({ user: {
    id: 'user-1', username: 'admin', displayName: '管理员', role: 'admin', avatarUpdatedAt: null,
    defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null,
  } }).user.role, 'admin');
  const preferences = {
    desktopSystemEnabled: false, desktopSoundEnabled: false,
    desktopSessionEndSystemEnabled: true, desktopSessionEndSoundEnabled: false,
    mobileSystemEnabled: true, mobileSoundEnabled: false,
    mobileSessionEndSystemEnabled: true, mobileSessionEndSoundEnabled: true,
    approvalSound: 'gentle_dual' as const, sessionEndSound: 'crisp' as const,
    desktopSoundVolume: 45, mobileSoundVolume: 80,
  };
  assert.deepEqual(NotificationPreferencesDtoSchema.parse(preferences), preferences);
  assert.equal(NotificationSoundSchema.parse('falling_low'), 'falling_low');
  assert.deepEqual(NotificationPreferencesResponseDtoSchema.parse({ preferences }), { preferences });
  const themeSettings = {
    version: 2 as const,
    basePreference: 'system' as const,
    colorStyle: 'neutral' as const,
    textScale: 'standard' as const,
    linkedProfiles: true,
    desktop: { backgroundKind: 'none' as const, backgroundValue: null, blur: 0, fit: 'cover' as const, position: 'center' as const, overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 1, glassBlur: 0, borderStrength: 0.55 },
    mobile: { backgroundKind: 'none' as const, backgroundValue: null, blur: 0, fit: 'cover' as const, position: 'center' as const, overlayColor: '#000000', overlayOpacity: 0, panelOpacity: 1, glassBlur: 0, borderStrength: 0.55 },
    updatedAt: 1,
  };
  assert.deepEqual(AccountThemeSettingsDtoSchema.parse(themeSettings), themeSettings);
  assert.deepEqual(AccountThemeSettingsResponseDtoSchema.parse({ settings: themeSettings }), { settings: themeSettings });
  const { colorStyle: _colorStyle, textScale: _textScale, ...legacyThemeSettings } = themeSettings;
  assert.equal(ThemeSettingsInputSchema.parse({ ...legacyThemeSettings, version: 1 }).version, 1);
  assert.equal(SessionUpdateResponseDtoSchema.parse({
    ok: true,
    session: { id: sessionId, title: '会话', created_at: 1, updated_at: 2, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, can_fork: false, status: 'idle', engine_preferences: { modelId: null, reasoningEffort: null, revision: 0 } },
  }).session.id, sessionId);
  assert.deepEqual(SessionDeletionImpactDtoSchema.parse({ hasLinkedCodexThread: true }), { hasLinkedCodexThread: true });
  assert.deepEqual(ProjectDeletionImpactDtoSchema.parse({ sessionCount: 73, linkedCodexSessionCount: 12, inProgressSessionCount: 2 }), { sessionCount: 73, linkedCodexSessionCount: 12, inProgressSessionCount: 2 });
  const snippet = { text: '…软键盘弹出…', matchStart: 1, matchLength: 3 };
  const match = { messageId: 'message-1', role: 'user', createdAt: 3, scope: 'message', snippet };
  assert.equal(SessionSearchResponseDtoSchema.parse({
    query: '软键盘',
    results: [{
      session: { id: sessionId, title: '会话', created_at: 1, updated_at: 2, pinned: 0, pinned_at: null, project_id: null, engine: 'codex', codex_archived: false, can_fork: false, status: 'idle', engine_preferences: { modelId: null, reasoningEffort: null, revision: 0 } },
      titleMatched: false,
      messageMatchCount: 1,
      latestMessageMatch: match,
    }],
  }).results[0].latestMessageMatch?.messageId, 'message-1');
  assert.deepEqual(SessionMessageMatchesResponseDtoSchema.parse({
    query: '软键盘',
    total: 2,
    truncated: true,
    matches: [match],
  }).matches[0].snippet, snippet);
  assert.equal(FileAccessResponseDtoSchema.parse({ ok: true, accessToken: 'token' }).accessToken, 'token');
});

test('共享契约校验设备上传响应、项目用量和附件联合类型', async () => {
  const contracts = await import('./index.js');
  const draft = {
    id: '55555555-5555-4555-8555-555555555555',
    kind: 'uploaded_file' as const,
    messageId: '44444444-4444-4444-8444-444444444444',
    uploadId: '66666666-6666-4666-8666-666666666666',
    projectId: '77777777-7777-4777-8777-777777777777',
    name: 'photo.jpg',
    path: 'D:\\project\\.relay_upload\\tmp\\draft\\photo.jpg',
    size: 1024,
    mimeType: 'image/jpeg',
  };
  const usage = {
    usedBytes: 1024,
    reservedBytes: 2048,
    limitBytes: 1024 ** 3,
    archivedFileCount: 1,
    temporaryFileCount: 2,
  };
  assert.deepEqual(contracts.UploadedFileDraftDtoSchema.parse(draft), draft);
  assert.deepEqual(contracts.ProjectUploadResponseDtoSchema.parse({ attachment: draft, usage }), { attachment: draft, usage });
  assert.deepEqual(contracts.ProjectUploadUsageDtoSchema.parse(usage), usage);
  const persisted = contracts.MessageAttachmentDtoSchema.parse({
    id: draft.id,
    kind: 'uploaded_file',
    name: draft.name,
    path: 'D:\\project\\.relay_upload\\messages\\attachment\\photo.jpg',
    size: draft.size,
    mimeType: draft.mimeType,
    available: true,
  });
  assert.equal(persisted.kind, 'uploaded_file');
  if (persisted.kind === 'uploaded_file') assert.equal(persisted.available, true);
  assert.equal(contracts.MessageAttachmentSummaryDtoSchema.parse({
    id: draft.id,
    kind: 'uploaded_file',
    name: draft.name,
    size: draft.size,
    mimeType: draft.mimeType,
    available: false,
  }).kind, 'uploaded_file');
});

  assert.deepEqual(CodexVersionDtoSchema.parse({
    currentVersion: '0.42.0',
    latestVersion: '0.43.0',
    releaseOverview: {
      sourceStatus: 'available',
      counts: { features: 3, improvements: 0, fixes: 6, documentation: 0, chores: 2 },
      topics: ['permissions_security', 'mcp_extensions', 'plugins_skills'],
      officialSource: 'codex_github',
      officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.43.0',
    },
    updateAvailable: true,
    status: 'success',
    checkedAt: 123,
  }), {
    currentVersion: '0.42.0', latestVersion: '0.43.0', releaseOverview: {
      sourceStatus: 'available',
      counts: { features: 3, improvements: 0, fixes: 6, documentation: 0, chores: 2 },
      topics: ['permissions_security', 'mcp_extensions', 'plugins_skills'],
      officialSource: 'codex_github',
      officialUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.43.0',
    }, updateAvailable: true, status: 'success', checkedAt: 123,
  });
  assert.equal(CodexVersionDtoSchema.safeParse({
    currentVersion: '0.42.0', latestVersion: '0.43.0', updateAvailable: true, status: 'success', checkedAt: 123,
    releaseOverview: {
      sourceStatus: 'available', counts: { features: 1, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
      officialSource: 'codex_github',
      officialUrl: 'https://example.invalid/releases/tag/rust-v0.43.0',
    },
  }).success, false);
  assert.equal(CodexVersionDtoSchema.safeParse({
    currentVersion: '0.42.0', latestVersion: '0.43.0', updateAvailable: true, status: 'success', checkedAt: 123,
    releaseOverview: {
      sourceStatus: 'available', counts: { features: 1, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
      officialSource: 'codebuddy_cnb',
      officialUrl: 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.142.0.md',
    },
  }).success, false);
  assert.equal(CodexVersionDtoSchema.safeParse({
    currentVersion: '0.42.0', latestVersion: '0.43.0', updateAvailable: true, status: 'success', checkedAt: 123,
    releaseOverview: {
      sourceStatus: 'available', counts: { features: 1, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
      officialSource: 'codebuddy_cnb',
      officialUrl: 'https://cnb.cool/another/repository/-/blob/main/docs/release-notes/v2.142.0.md',
    },
  }).success, false);

  const mismatchedMaintenanceSource = {
    engineId: 'codex', label: 'Codex', installedVersion: '0.42.0', installedAt: 1_000_000_000_000, runningVersion: '0.42.0', latestVersion: '0.43.0',
    releaseOverview: {
      sourceStatus: 'available', counts: { features: 1, improvements: 0, fixes: 0, documentation: 0, chores: 0 }, topics: [],
      officialSource: 'codebuddy_cnb', officialUrl: 'https://cnb.cool/codebuddy/codebuddy-code/-/blob/main/docs/release-notes/v2.142.0.md',
    },
    releasePublishedAt: null, updateAvailable: true, latestCheckStatus: 'success', latestCheckedAt: 123,
    installSource: 'official_npm_global', activeTaskCount: 0, activeInstanceCount: 0, instanceVersions: [],
    readiness: 'ready', readinessCheckedAt: 123, recommendedAction: null, actions: [],
  };
  assert.equal(EngineMaintenanceStatusDtoSchema.safeParse(mismatchedMaintenanceSource).success, false);

test('引擎维护契约只暴露稳定版本、状态与固定动作', () => {
  const status = {
    engineId: 'codebuddy',
    label: 'CodeBuddy',
    installedVersion: '2.140.0',
    installedAt: 1_777_000_000_000,
    runningVersion: null,
    latestVersion: '2.150.0',
    releaseOverview: null,
    releasePublishedAt: 1_777_000_000_000,
    updateAvailable: true,
    latestCheckStatus: 'success',
    latestCheckedAt: 123,
    installSource: 'official_npm_global',
    activeTaskCount: 0,
    activeInstanceCount: 0,
    instanceVersions: [],
    readiness: 'ready',
    readinessCheckedAt: 456,
    recommendedAction: 'upgrade',
    actions: [{
      action: 'upgrade',
      label: '升级到 v2.150.0',
      enabled: true,
      reason: null,
      interruptsActiveTasks: false,
    }],
  };
  assert.deepEqual(EngineMaintenanceStatusDtoSchema.parse(status), status);
  assert.equal(EngineMaintenanceStatusDtoSchema.safeParse({ ...status, releasePublishedAt: Number.MAX_SAFE_INTEGER }).success, false);
  assert.equal(EngineMaintenanceStatusDtoSchema.safeParse({ ...status, command: 'npm install -g' }).success, false);
  assert.equal(EngineMaintenanceStatusDtoSchema.safeParse({ ...status, packageName: '@scope/pkg' }).success, false);

  const operation = {
    operationId: 'engine-op-1',
    engineId: 'codex',
    action: 'restart',
    status: 'processing',
    message: '正在重启 Codex',
    retryAfterMs: 0,
    output: {
      operationId: 'engine-op-1', sequence: 2, lines: ['vite building...', 'dist/index.html 2.90 kB'],
      status: 'running', updatedAt: 123,
    },
  };
  assert.deepEqual(EngineMaintenanceOperationDtoSchema.parse(operation), operation);
});

test('维护输出快照严格限制最近两行、长度、控制字符和 operation ID', () => {
  const snapshot = { operationId: 'op-1', sequence: 2, lines: ['第一行', '第二行'], status: 'running', updatedAt: 123 };
  assert.deepEqual(MaintenanceOutputSnapshotDtoSchema.parse(snapshot), snapshot);
  assert.throws(() => MaintenanceOutputSnapshotDtoSchema.parse({ ...snapshot, lines: ['1', '2', '3'] }));
  assert.throws(() => MaintenanceOutputSnapshotDtoSchema.parse({ ...snapshot, lines: ['x'.repeat(501)] }));
  assert.throws(() => MaintenanceOutputSnapshotDtoSchema.parse({ ...snapshot, lines: ['token\nleak'] }));
  assert.throws(() => MaintenanceOutputSnapshotDtoSchema.parse({ ...snapshot, operationId: '../escape' }));
  assert.throws(() => MaintenanceOutputSnapshotDtoSchema.parse({ ...snapshot, extra: true }));
});

test('HTTP 错误 presenter 只输出 ApiErrorDto 白名单字段', () => {
  assert.deepEqual(presentApiError('禁止访问', {
    code: 'FORBIDDEN',
    canForceAccess: true,
    ignored: '不得输出',
  }), { error: '禁止访问', code: 'FORBIDDEN', canForceAccess: true });
  assert.deepEqual(presentApiError('项目已在回收站', {
    code: 'PROJECT_IN_TRASH',
    projectInTrash: {
      id: sessionId,
      name: '旧项目',
      sessionCount: 2,
    },
    ignored: '不得输出',
  }), {
    error: '项目已在回收站',
    code: 'PROJECT_IN_TRASH',
    projectInTrash: { id: sessionId, name: '旧项目', sessionCount: 2 },
  });
  assert.throws(() => presentApiError('   '), /错误消息不能为空/);
});

test('空项目恢复允许返回零个会话', () => {
  assert.deepEqual(
    TrashRestoreResponseDtoSchema.parse({
      ok: true,
      restoredSessionCount: 0,
      unarchivedSessionCount: 0,
      unarchiveFailedSessionCount: 0,
      archiveStateSyncFailedSessionCount: 0,
    }),
    { ok: true, restoredSessionCount: 0, unarchivedSessionCount: 0, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0 },
  );
});

test('回收站影响与彻底删除请求契约严格拒绝路径和文件列表', () => {
  const revision = 'a'.repeat(64);
  const impact = {
    sessionCount: 1,
    messageCount: 2,
    shareCount: 3,
    attachmentCount: 4,
    releasableBytes: 5,
    impactRevision: revision,
  };
  assert.deepEqual(TrashImpactDtoSchema.parse(impact), impact);
  assert.deepEqual(
    TrashProjectDeleteRequestSchema.parse({ impactRevision: revision, confirmationName: '项目' }),
    { impactRevision: revision, confirmationName: '项目' },
  );
  assert.deepEqual(
    TrashSessionDeleteRequestSchema.parse({ impactRevision: revision }),
    { impactRevision: revision },
  );
  assert.throws(() => TrashProjectDeleteRequestSchema.parse({
    impactRevision: revision,
    confirmationName: '项目',
    path: 'D:/不得接受',
  }));
  assert.throws(() => TrashSessionDeleteRequestSchema.parse({
    impactRevision: revision,
    messageIds: ['不得接受'],
  }));
});
