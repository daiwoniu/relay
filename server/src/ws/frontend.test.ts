import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { codeBuddyInteractionAdapter } from '../codebuddy/adapter.js';
import { codexInteractionAdapter } from '../codex/adapter.js';
import type { EngineInteractionRequest } from '../engine/interactions.js';
import { parseMessageMetadata } from '../message-metadata.js';
import { buildFailedSendMessages, buildFailedSendUserContent, buildInteractionResponse as buildStandardInteractionResponse, createInteractionItem as createStandardInteractionItem, getPendingApprovalResolution, isTurnCancellingInteractionResponse, mergeSessionEventRecipients, parseFrontendMessage, resolveInterruptFailureStatus, resolveRecoveryInProgressStatus, resolveSessionStatusForVisibility, shouldFinalizeAsUserCancelled, updateAutomaticTitleBestEffort, upsertTurnItem } from './frontend.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const frontendSource = readFileSync(new URL('./frontend.ts', import.meta.url), 'utf8');
const approvalRoutingSource = readFileSync(new URL('./frontend-approval-routing.ts', import.meta.url), 'utf8');
const messagePresenterSource = readFileSync(new URL('../messages/presenter.ts', import.meta.url), 'utf8');
const messageStorageSource = readFileSync(new URL('../messages/storage.ts', import.meta.url), 'utf8');

function interactionAdapterForTest(method: string) {
  return method.startsWith('session/') ? codeBuddyInteractionAdapter : codexInteractionAdapter;
}

function createInteractionItem(requestId: string | number, method: string, params: Record<string, unknown>) {
  const request = { requestId, method, params };
  return createStandardInteractionItem(interactionAdapterForTest(method).normalize(request), method);
}

function buildInteractionResponse(
  method: string,
  params: Record<string, unknown>,
  command: Parameters<typeof buildStandardInteractionResponse>[2],
) {
  const request: EngineInteractionRequest = { requestId: command.interactionId, method, params };
  return buildStandardInteractionResponse(interactionAdapterForTest(method), request, command);
}
const sendFailureSource = readFileSync(new URL('./frontend-send-failures.ts', import.meta.url), 'utf8');
const frontendEventSchemaSource = readFileSync(new URL('../contracts/frontend-event.ts', import.meta.url), 'utf8');

test('send protocol carries only a task ID, not a client supplied workspace path', () => {
  const send = { type: 'send', sessionId, content: '开始处理', messageId: 'message-1', workspaceTaskId: 'task-a' };
  assert.equal(parseFrontendMessage(send)?.type, 'send');
  assert.throws(() => parseFrontendMessage({ ...send, workspacePath: 'D:/forged' }));
});

test('rejected first task send does not persist an unlinked user message', () => {
  assert.match(frontendSource, /if \(input\.workspaceTaskId && !existingUserMessage\) return false;/);
  assert.match(frontendSource, /workspaceTaskId: message\.workspaceTaskId/);
  assert.match(frontendSource, /workspaceTaskId: sendMessage\.workspaceTaskId/);
});

test('frontend façade 将低耦合职责委托给独立模块并保持有界', () => {
  for (const moduleName of [
    'frontend-client-hub',
    'frontend-client-authorization',
    'frontend-concurrency-recovery',
    'context-compaction',
    'frontend-interactions',
    'frontend-approval-routing',
    'frontend-model-selection',
    'frontend-protocol',
    'frontend-runtime-policy',
    'frontend-runtime-reset',
    'frontend-send-failures',
    'frontend-session-sync',
    'queued-turn-dispatch',
    '../services/engine-concurrency-api',
  ]) {
    assert.match(frontendSource, new RegExp(`from '${moduleName.startsWith('.') ? moduleName : `./${moduleName}`}\\.js'`));
  }
  assert.ok(frontendSource.split(/\r?\n/).length <= 1620);
});

test('上下文自动整理通知持久化会话计数', () => {
  assert.match(frontendSource, /persistContextCompactionItemSafely\(runtime\.sessionId, codexMsg, sessionService\.incrementContextCompactionCount\)/);
  assert.match(frontendSource, /noticeType === 'context_compaction'\) persistContextCompactionCountSafely\(runtime\.sessionId, codexMsg\.contextCompaction \|\| \{\}, sessionService\.incrementContextCompactionCount\)/);
});

test('会话事件接收者始终包含发起连接且保持去重', () => {
  const subscriber = { id: 'subscriber' };
  const initiator = { id: 'initiator' };

  assert.deepEqual([...mergeSessionEventRecipients(new Set([subscriber]), initiator)], [subscriber, initiator]);
  assert.deepEqual([...mergeSessionEventRecipients(new Set([initiator]), initiator)], [initiator]);
  assert.deepEqual([...mergeSessionEventRecipients(undefined, initiator)], [initiator]);
});

test('用户消息落库广播显式包含发起连接', () => {
  assert.match(frontendSource, /broadcastFrontendEvent\(\{[\s\S]*?type: 'message_saved',[\s\S]*?messageRevision: admission\.savedMessage\.revision,[\s\S]*?message: presentMessage\(admission\.savedMessage\.message\),[\s\S]*?\}, client\.ws\);/);
});

test('发送失败历史保留用户正文并只记录安全附件名', () => {
  assert.equal(buildFailedSendUserContent('  请分析  ', []), '请分析');
  assert.equal(buildFailedSendUserContent('', ['报告.pdf']), '发送附件：报告.pdf');
  assert.equal(buildFailedSendUserContent('请分析', ['报告.pdf', '数据.xlsx']), '请分析\n\n发送附件：报告.pdf、数据.xlsx');
  assert.equal(buildFailedSendUserContent('', ['C:\\secret\\报告.pdf', '../../数据.xlsx', '换行\n名称.txt']), '发送附件：报告.pdf、数据.xlsx、换行 名称.txt');
});

test('有效会话前置失败原子保存用户消息和异常回复', () => {
  assert.match(sendFailureSource, /function buildFailedSendMessages[\s\S]*?role: 'assistant'[\s\S]*?phase: 'error'[\s\S]*?role: 'user'/);
  assert.match(frontendSource, /function persistSendFailure[\s\S]*?getMessageRecord[\s\S]*?sessionService\.saveMessages\(buildFailedSendMessages/);
  assert.match(frontendSource, /existingSession[\s\S]*?deletionState\.getSessionBlock[\s\S]*?return false;/);
  assert.match(frontendSource, /for \(const saved of savedMessages\)[\s\S]*?type: 'message_saved'[\s\S]*?client\.ws/);
  assert.match(frontendSource, /classifySessionTitleMessage\(buildFailedSendUserContent\(input\.content, input\.attachmentNames\)\)/);
  assert.match(frontendSource, /if \(input\.code !== 'SESSION_BUSY'\) setSessionStatus\(input\.sessionId, 'failed'\)/);
  assert.match(frontendSource, /if \(persistSendFailure\([\s\S]*?\)\) return;/);
  assert.match(frontendSource, /console\.error\('\[Relay\] Failed to persist rejected send:'/);
  assert.match(frontendSource, /console\.error\('\[Relay\] Failed to publish persisted rejected send:'/);
  assert.match(frontendSource, /if \(recoveryError\) \{[\s\S]*?rejectSend\(client,/);
  assert.match(frontendSource, /Failed to send frontend message:[\s\S]*?rejectSend\(client,/);
});

test('用户消息已经落库时只补异常回复并复用原 turn', () => {
  const existingUserMessage = {
    id: 'user-1', session_id: sessionId, turn_id: 'turn-existing', role: 'user' as const,
    content: '已保存', phase: null, items: null, metadata: null, created_at: 1, duration: null, stopped: 0,
  };
  const messages = buildFailedSendMessages({
    sessionId, messageId: existingUserMessage.id, content: '已保存', attachmentNames: [],
    message: '后续处理失败', code: 'MESSAGE_PROCESSING_FAILED',
  }, existingUserMessage);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.turn_id, 'turn-existing');
  assert.equal(messages[0]?.phase, 'error');
});

test('发送失败落库的用户消息仍保留私有浏览器诊断快照', () => {
  const clientDiagnostics = {
    capturedAt: 123,
    userAgent: 'Mozilla/5.0 HuaweiBrowser/6.1.7 Chrome/144.0.0.0',
    standalone: false,
  };
  const messages = buildFailedSendMessages({
    sessionId, content: '失败消息', attachmentNames: [], message: '暂时不可用', code: 'UNAVAILABLE',
    clientDiagnostics,
  });
  const userMessage = messages.find((message) => message.role === 'user');
  assert.deepEqual(parseMessageMetadata(userMessage?.metadata).clientDiagnostics, clientDiagnostics);
});

test('会话忙异常保留历史但不终止原任务流式状态', () => {
  const clientSource = readFileSync(new URL('../../../client/src/hooks/useRelayWebSocket.ts', import.meta.url), 'utf8');
  assert.match(clientSource, /msg\.message\.isError && msg\.message\.errorCode !== 'SESSION_BUSY'/);
});

test('发送与交互统一通过数据库会话引擎及 engineConnection 路由', () => {
  assert.match(frontendSource, /engineRegistry\.connect\(relaySession\.engine,/);
  assert.match(frontendSource, /externalSessionId: relaySession\.engine_session_id/);
  assert.match(frontendSource, /engineRegistry\.get\(runtime\.engine\)\.interactions/);
  assert.match(frontendSource, /runtime\.engineConnection\.respondToInteraction\(pending\.request\.requestId, result\)/);
  assert.match(approvalRoutingSource, /input\.runtime\.pendingInteractions\.has\(interactionId\) \|\| input\.runtime\.settledInteractionIds\.has\(interactionId\)/);
  assert.doesNotMatch(frontendSource, /interactionAdapterForMethod/);
  assert.doesNotMatch(frontendSource, /runtime\.codex(?:Send|Interrupt|Respond|Close)/);
});

test('授权请求冻结信任后仅对普通授权执行一次性自动允许', () => {
  const requestSource = frontendSource.slice(
    frontendSource.indexOf("codexMsg.type === 'server_request'"),
    frontendSource.indexOf("codexMsg.type === 'server_request_resolved'"),
  );
  const routed = requestSource.indexOf('routeIncomingApproval');
  const completed = requestSource.indexOf("routed.outcome === 'accepted'");
  const pendingBroadcast = requestSource.indexOf('pending_approval_upserted');
  assert.ok(routed >= 0 && completed > routed && pendingBroadcast > completed);
  assert.match(approvalRoutingSource, /normalizeInteractionOrFallback[\s\S]*?settledInteractionIds[\s\S]*?resolveTrust[\s\S]*?attemptAutoAccept/);
  assert.match(approvalRoutingSource, /if \(input\.runtime\.engineConnection !== connection\) return \{ outcome: 'connection_lost' \}/);
  assert.ok(approvalRoutingSource.indexOf('pendingInteractions.set') > approvalRoutingSource.indexOf('attemptAutoAccept'));
});

test('适配器不回显 server_request_resolved，避免覆盖刚提交的用户决定', () => {
  for (const adapterPath of ['../zcode/adapter.ts', '../codebuddy/adapter.ts', '../opencode/adapter.ts']) {
    const adapterSource = readFileSync(new URL(adapterPath, import.meta.url), 'utf8');
    const respondBlock = adapterSource.slice(
      adapterSource.indexOf('respondToInteraction:'),
      adapterSource.indexOf('close: () => {', adapterSource.indexOf('respondToInteraction:')),
    );
    assert.ok(respondBlock.includes('respondToInteraction'), `${adapterPath} 缺少 respondToInteraction`);
    assert.doesNotMatch(respondBlock, /emit\(\s*\{\s*type:\s*'server_request_resolved'/);
  }
});

test('独立授权卡片走空闲窗合并落库，新回合发送强制冲刷', () => {
  assert.match(frontendSource, /standaloneInteractionItems\.push\(item\)/);
  assert.match(frontendSource, /STANDALONE_INTERACTION_IDLE_MS/);
  assert.match(frontendSource, /flushStandaloneInteractions\(runtime\)/);
  assert.match(frontendSource, /if \(pendingRuntime\?\.standaloneInteractionTimer\) flushStandaloneInteractions\(pendingRuntime\)/);
  // 合并窗计时器随运行时重置清理，避免跨回合残留
  assert.match(readFileSync(new URL('./frontend-runtime-reset.ts', import.meta.url), 'utf8'), /standaloneInteractionTimer/);
});

test('内部引擎事件元数据不进入浏览器事件协议', () => {
  assert.match(frontendSource, /engineRegistry\.connect\(relaySession\.engine,/);
  assert.doesNotMatch(frontendEventSchemaSource, /\bmeta\s*:/);
  assert.doesNotMatch(frontendEventSchemaSource, /\bdiagnostic\s*:/);
  assert.doesNotMatch(frontendEventSchemaSource, /\bhealth\s*:/);
});

test('接受合法的订阅、发送和取消消息', () => {
  assert.equal(parseFrontendMessage({ type: 'subscribe', sessionId }).type, 'subscribe');
  assert.equal(parseFrontendMessage({ type: 'unsubscribe', sessionId }).type, 'unsubscribe');
  assert.equal(parseFrontendMessage({ type: 'send', sessionId, content: '你好' }).type, 'send');
  assert.equal(parseFrontendMessage({ type: 'cancel', sessionId }).type, 'cancel');
  assert.equal(parseFrontendMessage({ type: 'respond_interaction', operationId, sessionId, interactionId: 'interaction:1', action: 'accept' }).type, 'respond_interaction');
  assert.throws(() => parseFrontendMessage({ type: 'subscribe', sessionId, engine: 'codebuddy' }));
  const sendWithEngine = parseFrontendMessage({ type: 'send', sessionId, content: '你好', engine: 'codebuddy' });
  assert.equal(sendWithEngine.type === 'send' ? sendWithEngine.engine : null, 'codebuddy');
});

test('首次发送先完成前置校验并由准入事务原子绑定草稿', () => {
  const deletionCheck = frontendSource.indexOf('const deletionBlock = deletionState.getSessionBlock');
  const engineRequiredCheck = frontendSource.indexOf("code: 'ENGINE_REQUIRED'");
  const projectCheck = frontendSource.indexOf("message: '会话所属项目不存在'");
  const attachmentCheck = frontendSource.indexOf('preparedAttachments = prepareMessageAttachments');
  const availabilityCheck = frontendSource.indexOf('await validateSendEnginePreferences(targetEngine, turnPreferences, !relaySession.engine)');
  const binding = frontendSource.indexOf('bindEngine: !relaySession.engine');
  assert.ok(deletionCheck >= 0 && engineRequiredCheck > deletionCheck && projectCheck > deletionCheck);
  assert.ok(availabilityCheck > projectCheck && attachmentCheck > availabilityCheck && binding > attachmentCheck);
  assert.doesNotMatch(frontendSource, /sessionService\.bindEngine\(sessionId/);
  assert.match(frontendSource, /const sendOperation = \(\) => handleSend\(client, sendMessage\)/);
  assert.match(frontendSource, /options\.trackWork \? options\.trackWork\(sendOperation\) : sendOperation\(\)/);
});

test('发送原子进入 queued 后再广播自动标题和订阅快照', () => {
  const handleSendSource = frontendSource.slice(
    frontendSource.indexOf('async function handleSend'),
    frontendSource.indexOf('function handleInteractionResponse'),
  );
  const admission = handleSendSource.indexOf('getTurnAdmissionService().enqueue');
  const automaticTitle = handleSendSource.indexOf('sessionService.updateAutomaticTitle(sessionId, title)');
  const subscribeCurrentSession = handleSendSource.indexOf('subscribe(client, sessionId)');
  assert.ok(admission >= 0);
  assert.ok(automaticTitle > admission);
  assert.ok(subscribeCurrentSession > automaticTitle);
});

test('发送在入队前建立稳定 attempt 且用户消息复用同一标识', () => {
  const handleSendSource = frontendSource.slice(
    frontendSource.indexOf('async function handleSend'),
    frontendSource.indexOf('function handleInteractionResponse'),
  );
  const createAttempt = handleSendSource.indexOf('const attemptId = uuid()');
  const saveUserTurn = handleSendSource.indexOf('turn_id: attemptId');
  const admission = handleSendSource.indexOf('getTurnAdmissionService().enqueue');
  assert.ok(createAttempt >= 0 && saveUserTurn > createAttempt);
  assert.ok(admission >= 0 && saveUserTurn > admission);
  assert.match(handleSendSource, /void getTurnScheduler\(\)\.drain\(admission\.queue\.resourceKey\)/);
});

test('无 Adapter 事件的本地失败在统一终态投影前补写安全事实', () => {
  assert.match(frontendSource, /recordRuntimeEngineError\(runtime, code\);[\s\S]*?failRuntime\([\s\S]*?启动任务失败/);
  assert.match(frontendSource, /recordRuntimeRecoveryInterrupted\(runtime, code\);[\s\S]*?finishRecoveredFailure/);
  assert.match(frontendSource, /recordRuntimeRecoveryFailed\(runtime, 'RESTART_RECOVERY_SESSION_MISSING'\);[\s\S]*?failRuntime/);
});

test('两个引擎的四条终态路径统一使用事实仲裁与原子投影', () => {
  const completedSource = frontendSource.slice(
    frontendSource.indexOf('function saveAndBroadcastAssistant'),
    frontendSource.indexOf('function failRuntime'),
  );
  const failedSource = frontendSource.slice(
    frontendSource.indexOf('function failRuntime'),
    frontendSource.indexOf('function finishRecoveredFailure'),
  );
  const recoveredSource = frontendSource.slice(
    frontendSource.indexOf('function finishRecoveredFailure'),
    frontendSource.indexOf('function hydrateRecoveredRuntime'),
  );
  const stoppedSource = frontendSource.slice(
    frontendSource.indexOf('function finalizeInterruptedRuntime'),
    frontendSource.indexOf('function interruptRuntime'),
  );

  const stoppedFact = stoppedSource.indexOf('recordInterruptConfirmed');
  assert.match(completedSource, /projectEngineTerminal/);
  assert.match(failedSource, /projectEngineTerminal/);
  assert.match(recoveredSource, /projectEngineTerminal/);
  assert.match(stoppedSource, /projectEngineTerminal/);
  assert.ok(stoppedFact >= 0 && stoppedFact < stoppedSource.indexOf('projectEngineTerminal'));
  for (const source of [completedSource, failedSource, recoveredSource, stoppedSource]) {
    assert.doesNotMatch(source, /sessionService\.saveMessage|setActiveTurnUsage|setActiveTurn\(|setSessionStatus/);
  }
  assert.doesNotMatch(frontendSource, /compareLegacyTerminal|terminalShadow|createTerminalShadow/);
});

test('统一终态投影按 runtime engine 仲裁且保持旧 UI 可见状态', () => {
  assert.match(frontendSource, /function projectEngineTerminal[\s\S]*?arbitrateTerminalDecision[\s\S]*?engineTerminalProjection\.project/);
  assert.match(frontendSource, /function projectEngineTerminal[\s\S]*?engineId: runtime\.engine/);
  assert.match(frontendSource, /projectEngineTerminal[\s\S]*?sessionStatus: decision.outcome/);
  assert.doesNotMatch(frontendSource, /projectCodexTerminal|codexTerminalProjection/);
  assert.doesNotMatch(frontendSource, /hasActiveSessionSubscriber/);
});

test('生产终态广播失败不阻断已提交终态后的 runtime 清理', () => {
  const publishSource = frontendSource.slice(
    frontendSource.indexOf('function broadcastProjectedTerminal'),
    frontendSource.indexOf('function saveAndBroadcastAssistant'),
  );
  const failureSource = frontendSource.slice(
    frontendSource.indexOf('function failRuntime'),
    frontendSource.indexOf('function finishRecoveredFailure'),
  );
  assert.match(publishSource, /publishEngineTerminalProjectionSafely\(result/);
  assert.match(publishSource, /type: 'message_saved'[\s\S]*?broadcastSessionUpdate/);
  assert.match(failureSource, /try \{[\s\S]*?broadcastFrontendEvent[\s\S]*?broadcastProjectedTerminal\(projected, options\)[\s\S]*?\} finally \{[\s\S]*?clearRuntimeState/);
});

test('Codex 归档标记在终态 session 更新广播前落库', () => {
  const failureSource = frontendSource.slice(
    frontendSource.indexOf('function failRuntime'),
    frontendSource.indexOf('function finishRecoveredFailure'),
  );
  const markArchived = failureSource.indexOf('sessionService.markCodexArchived(runtime.sessionId, true)');
  const publishTerminal = failureSource.indexOf('broadcastProjectedTerminal(projected, options)');
  assert.ok(markArchived >= 0 && publishTerminal > markArchived);
});

test('turn_start 只确认既有 attempt 的 lease 并补外部 turn', () => {
  const turnStartSource = frontendSource.slice(
    frontendSource.indexOf("codexMsg.type === 'turn_start'"),
    frontendSource.indexOf("codexMsg.type === 'delta'"),
  );
  assert.match(turnStartSource, /runtime\.currentTurnId = codexMsg\.turnId/);
  assert.match(turnStartSource, /sessionService\.setActiveTurn\(runtime\.sessionId, codexMsg\.turnId/);
  assert.match(turnStartSource, /markLeaseRunningInDatabase\(db, runtime\.attemptId/);
  assert.doesNotMatch(turnStartSource, /setActiveAttempt/);
});

test('自动标题更新失败不阻断后续引擎发送链路', () => {
  const originalConsoleError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  let continued = false;
  try {
    updateAutomaticTitleBestEffort(() => { throw new Error('标题数据库写入失败'); });
    continued = true;
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(continued, true);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]?.[0]), /Failed to update automatic session title/);
});

test('将 Codex 授权请求转换为稳定的交互项并生成响应', () => {
  const item = createInteractionItem(7, 'item/commandExecution/requestApproval', {
    command: 'npm test',
    cwd: 'G:\\AI\\relay',
    reason: '需要运行测试',
    commandActions: [{ command: 'npm test' }],
    networkApprovalContext: { host: 'registry.npmjs.org' },
    additionalPermissions: { network: true },
    proposedExecpolicyAmendment: ['npm', 'test'],
    proposedNetworkPolicyAmendments: [{ host: 'registry.npmjs.org' }],
    fileChanges: { 'package-lock.json': { type: 'update' } },
  });
  assert.equal(item.id, 'interaction:7');
  assert.equal(item.type, 'interaction');
  assert.equal((item.details as Record<string, unknown>).interactionKind, 'command_approval');
  assert.deepEqual((item.details as Record<string, unknown>).commandActions, [{ command: 'npm test' }]);
  assert.deepEqual((item.details as Record<string, unknown>).networkApprovalContext, { host: 'registry.npmjs.org' });
  assert.deepEqual((item.details as Record<string, unknown>).additionalPermissions, { network: true });
  assert.deepEqual((item.details as Record<string, unknown>).fileChanges, { 'package-lock.json': { type: 'update' } });
  assert.deepEqual(buildInteractionResponse(
    'item/commandExecution/requestApproval',
    {},
    { type: 'respond_interaction', operationId, sessionId, interactionId: item.id, action: 'accept_for_session' },
  ), { decision: 'acceptForSession' });

  assert.throws(() => buildInteractionResponse(
    'item/commandExecution/requestApproval',
    { availableDecisions: ['accept', 'decline'] },
    { type: 'respond_interaction', operationId, sessionId, interactionId: item.id, action: 'accept_for_session' },
  ), /当前不可用/);
});

test('将 CodeBuddy ACP 权限与用户输入请求映射为统一交互响应', () => {
  const permission = createInteractionItem(9, 'session/request_permission', {
    sessionId: 'cb-session',
    options: [
      { kind: 'allow_always', name: 'Always Allow', optionId: 'always' },
      { kind: 'allow_once', name: 'Allow', optionId: 'once' },
      { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
    ],
    toolCall: {
      toolCallId: 'tool-1',
      rawInput: { command: 'Write-Output CODEBUDDY_PROBE', description: '执行探针' },
      _meta: { 'codebuddy.ai/toolName': 'Bash', secret: '不得透传' },
    },
    _meta: { 'codebuddy.ai/requestId': 'private-request' },
  });
  assert.equal((permission.details as Record<string, unknown>).interactionKind, 'command_approval');
  assert.equal((permission.details as Record<string, unknown>).command, 'Write-Output CODEBUDDY_PROBE');
  assert.deepEqual((permission.details as Record<string, unknown>).availableDecisions, ['acceptForSession', 'accept', 'decline', 'cancel']);
  assert.equal(JSON.stringify(permission.details).includes('_meta'), false);
  assert.deepEqual(buildInteractionResponse(
    'session/request_permission',
    { options: [{ kind: 'allow_once', optionId: 'once' }] },
    { type: 'respond_interaction', operationId, sessionId, interactionId: permission.id, action: 'accept' },
  ), { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.deepEqual(buildInteractionResponse(
    'session/request_permission',
    { options: [{ kind: 'reject_once', optionId: 'reject' }] },
    { type: 'respond_interaction', operationId, sessionId, interactionId: permission.id, action: 'decline' },
  ), { outcome: { outcome: 'selected', optionId: 'reject' } });
  assert.deepEqual(buildInteractionResponse(
    'session/request_permission',
    { options: [] },
    { type: 'respond_interaction', operationId, sessionId, interactionId: permission.id, action: 'cancel' },
  ), { outcome: { outcome: 'cancelled' } });
  assert.throws(() => buildInteractionResponse(
    'session/request_permission',
    { options: [{ kind: 'allow_once', optionId: 'once' }] },
    { type: 'respond_interaction', operationId, sessionId, interactionId: permission.id, action: 'accept_for_session' },
  ), /当前不可用/);

  const userInput = createInteractionItem(10, 'session/request_user_input', {
    questions: [{ id: 'name', question: '名称' }],
  });
  assert.equal((userInput.details as Record<string, unknown>).interactionKind, 'user_input');
  assert.deepEqual(buildInteractionResponse(
    'session/request_user_input',
    {},
    { type: 'respond_interaction', operationId, sessionId, interactionId: userInput.id, action: 'submit', answers: { name: ['Relay'] } },
  ), { answers: { name: ['Relay'] } });
});

test('真实授权与 MCP 待处理请求生成对应解决事件', () => {
  assert.equal(getPendingApprovalResolution('item/commandExecution/requestApproval', 'accept'), 'accept');
  assert.equal(getPendingApprovalResolution('session/request_permission', 'accept_for_session'), 'accept_for_session');
  // zcode 的权限方法必须在白名单内，否则用户决定后不广播 resolved，前端通知不消失
  assert.equal(getPendingApprovalResolution('interaction/requestPermission', 'accept'), 'accept');
  assert.equal(getPendingApprovalResolution('interaction/requestPermission', 'decline'), 'decline');
  assert.equal(getPendingApprovalResolution('mcpServer/elicitation/request', 'submit'), 'submitted');
  assert.equal(getPendingApprovalResolution('mcpServer/elicitation/request', 'accept'), 'submitted');
  assert.equal(getPendingApprovalResolution('mcpServer/elicitation/request', 'decline'), 'decline');
  assert.equal(getPendingApprovalResolution('mcpServer/elicitation/request', 'cancel'), 'cancel');
  assert.equal(getPendingApprovalResolution('session/request_user_input', 'submit'), null);

  assert.deepEqual(buildInteractionResponse(
    'mcpServer/elicitation/request',
    {},
    { type: 'respond_interaction', operationId, sessionId, interactionId: 'interaction:mcp', action: 'submit', formData: { environment: 'staging' } },
  ), { action: 'accept', content: { environment: 'staging' }, _meta: null });
  assert.deepEqual(buildInteractionResponse(
    'mcpServer/elicitation/request',
    {},
    { type: 'respond_interaction', operationId, sessionId, interactionId: 'interaction:mcp', action: 'decline' },
  ), { action: 'decline', content: null, _meta: null });

  const interactionResponseSource = frontendSource.slice(
    frontendSource.indexOf('function handleInteractionResponse'),
    frontendSource.indexOf('function finalizeInterruptedRuntime'),
  );
  const updateRuntime = interactionResponseSource.indexOf('completeRuntimeInteraction(runtime, message.interactionId');
  const sendAccepted = interactionResponseSource.indexOf("sendInteractionResponseResult(client, message, 'accepted')");
  const publishApprovalResolution = interactionResponseSource.indexOf("type: 'pending_approval_resolved'");
  assert.ok(updateRuntime >= 0 && sendAccepted > updateRuntime);
  assert.ok(publishApprovalResolution > sendAccepted);
  const failedReturn = interactionResponseSource.indexOf("sendInteractionResponseResult(client, message, 'failed'");
  const removePending = interactionResponseSource.indexOf('runtime.pendingInteractions.delete(message.interactionId)');
  assert.ok(failedReturn >= 0 && removePending > failedReturn);
  assert.match(interactionResponseSource, /const approvalResolution = getPendingApprovalResolution\(pending\.request\.method, message\.action\)/);
  assert.match(interactionResponseSource, /resolvedAction: message\.action, source: 'user', decidedAt: Date\.now\(\)/);
  assert.match(frontendSource, /resolvedAction: 'resolved_elsewhere', source: 'resolved_elsewhere', decidedAt: Date\.now\(\)/);
  assert.match(approvalRoutingSource, /resolvedAction: 'accept', source: decision\.source, expiresAt: decision\.expiresAt/);
  assert.match(messagePresenterSource, /details\.decisionSource = decisionSource\.data/);
  assert.match(messagePresenterSource, /details\.effectiveScope = effectiveScope/);
  assert.match(messagePresenterSource, /details\.trustExpiresAt = trustExpiresAt/);
  assert.match(messagePresenterSource, /details\.decidedAt = decidedAt/);
  assert.match(messageStorageSource, /UNBOUNDED_ITEM_TYPES\.has\(item\.type\).*return details/);
});

test('真实授权方法拒绝只属于输入表单的 submit 动作', () => {
  for (const method of [
    'session/request_permission',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ]) {
    assert.throws(() => buildInteractionResponse(
      method,
      { options: [{ kind: 'allow_once', optionId: 'once' }] },
      { type: 'respond_interaction', operationId, sessionId, interactionId: 'interaction:submit', action: 'submit' },
    ), /授权决定当前不可用/);
  }
});

test('CodeBuddy ACP 授权按真实工具类型分类且未知工具使用中性权限', () => {
  const createPermission = (toolName: string, rawInput: Record<string, unknown>) => createInteractionItem(
    20,
    'session/request_permission',
    {
      options: [{ kind: 'allow_once', optionId: 'once' }],
      toolCall: { rawInput, _meta: { 'codebuddy.ai/toolName': toolName } },
    },
  ).details as Record<string, unknown>;

  assert.equal(createPermission('Bash', { command: 'npm test' }).interactionKind, 'command_approval');
  const write = createPermission('Write', { filePath: 'D:\\workspace\\a.ts', content: '不得传给浏览器' });
  assert.equal(write.interactionKind, 'file_approval');
  assert.deepEqual(write.rawInput, { filePath: 'D:\\workspace\\a.ts' });
  const network = createPermission('WebFetch', { url: 'https://example.com?token=secret' });
  assert.equal(network.interactionKind, 'permissions_approval');
  assert.deepEqual(network.networkApprovalContext, { toolName: 'WebFetch' });
  assert.equal(JSON.stringify(network).includes('token=secret'), false);
  const unknown = createPermission('CustomTool', { value: 'opaque' });
  assert.equal(unknown.interactionKind, 'permissions_approval');
  assert.equal(unknown.title, '需要授权使用工具');
});

test('CodeBuddy ACP 空或未知选项只保留明确支持的取消动作', () => {
  const empty = createInteractionItem(21, 'session/request_permission', {
    options: [], toolCall: { _meta: { 'codebuddy.ai/toolName': 'Write' }, rawInput: { path: 'a.ts' } },
  });
  const unknown = createInteractionItem(22, 'session/request_permission', {
    options: [{ kind: 'future_option', optionId: 'future' }], toolCall: { _meta: { 'codebuddy.ai/toolName': 'CustomTool' } },
  });
  assert.deepEqual((empty.details as Record<string, unknown>).availableDecisions, ['cancel']);
  assert.deepEqual((unknown.details as Record<string, unknown>).availableDecisions, ['cancel']);
});

test('新版授权 cancel 明确会取消当前回合，旧版 denied 仍只是拒绝工具', () => {
  const command = (action: 'accept' | 'accept_for_session' | 'decline' | 'cancel') => ({
    type: 'respond_interaction' as const,
    operationId,
    sessionId,
    interactionId: 'interaction:cancel-current-tool',
    action,
  });

  assert.deepEqual(buildInteractionResponse(
    'item/commandExecution/requestApproval',
    { availableDecisions: ['accept', 'cancel'] },
    command('cancel'),
  ), { decision: 'cancel' });
  assert.equal(isTurnCancellingInteractionResponse(
    'item/commandExecution/requestApproval',
    { decision: 'cancel' },
  ), true);
  assert.deepEqual(buildInteractionResponse(
    'item/fileChange/requestApproval',
    {},
    command('cancel'),
  ), { decision: 'cancel' });
  assert.equal(isTurnCancellingInteractionResponse('item/fileChange/requestApproval', { decision: 'cancel' }), true);
  assert.deepEqual(buildInteractionResponse('execCommandApproval', {}, command('cancel')), { decision: 'denied' });
  assert.equal(isTurnCancellingInteractionResponse('execCommandApproval', { decision: 'denied' }), false);
  assert.deepEqual(buildInteractionResponse('applyPatchApproval', {}, command('cancel')), { decision: 'denied' });
  assert.deepEqual(buildInteractionResponse('execCommandApproval', {}, command('decline')), { decision: 'denied' });
  assert.deepEqual(buildInteractionResponse(
    'item/permissions/requestApproval',
    { permissions: { network: true, fileSystem: { read: ['/tmp'] } } },
    command('cancel'),
  ), { permissions: {}, scope: 'turn' });
  assert.equal(shouldFinalizeAsUserCancelled(true, 'CODEX_TURN_INTERRUPTED'), true);
  assert.equal(shouldFinalizeAsUserCancelled(true, 'CODEBUDDY_TURN_INTERRUPTED'), true);
  assert.equal(shouldFinalizeAsUserCancelled(false, 'CODEX_TURN_INTERRUPTED'), false);
  assert.equal(shouldFinalizeAsUserCancelled(true, 'CODEX_TURN_FAILED'), false);
  assert.match(frontendSource, /runtime\.interactionCancelRequested = true/);
  assert.match(frontendSource, /const \{ code, userMessage, originalMessage \} = codexMsg\.diagnostic/);
  assert.match(frontendSource, /finalizeInterruptedRuntime\(runtime, \{ message: originalMessage \|\| userMessage, code \}\)/);
  assert.match(frontendSource, /failRuntime\(runtime, originalMessage \|\| userMessage, code/);
  assert.match(frontendSource, /errorCode: originalError\.code[\s\S]*?errorMessage: originalError\.message/);
});

test('拒绝未知类型和超大内容，允许附件消息使用空正文', () => {
  assert.throws(() => parseFrontendMessage({ type: 'unknown', sessionId }));
  assert.equal(parseFrontendMessage({ type: 'send', sessionId, content: '' }).type, 'send');
  assert.throws(() => parseFrontendMessage({ type: 'send', sessionId, content: 'x'.repeat(100_001) }));
});

test('同一 Codex 工具项按 ID 合并而不是重复保存', () => {
  const started = { id: 'item-1', type: 'commandExecution', status: 'in_progress', command: 'rtk git status' };
  const repeated = { id: 'item-1', type: 'commandExecution', status: 'in_progress', cwd: 'D:\\relay' };
  const completed = { id: 'item-1', type: 'commandExecution', status: 'completed', durationMs: 4100 };

  let items = upsertTurnItem([], started);
  items = upsertTurnItem(items, repeated);
  items = upsertTurnItem(items, completed);

  assert.deepEqual(items, [{
    id: 'item-1',
    type: 'commandExecution',
    status: 'completed',
    command: 'rtk git status',
    cwd: 'D:\\relay',
    durationMs: 4100,
  }]);
});

test('订阅与查看不能覆盖真实终态', () => {
  assert.equal(resolveSessionStatusForVisibility('pending', true), 'pending');
  assert.equal(resolveSessionStatusForVisibility('processing', true), 'processing');
  assert.equal(resolveSessionStatusForVisibility('awaiting_action', true), 'awaiting_action');
  assert.equal(resolveSessionStatusForVisibility('stopping', true), 'stopping');
  assert.equal(resolveSessionStatusForVisibility('completed', true), 'completed');
  assert.equal(resolveSessionStatusForVisibility('failed', true), 'failed');
  assert.equal(resolveSessionStatusForVisibility('stopped', true), 'stopped');
  assert.equal(resolveSessionStatusForVisibility('interrupted', true), 'interrupted');
  assert.equal(resolveSessionStatusForVisibility('completed', false), 'completed');
});

test('订阅不清除终态，已读必须显式确认结果且只广播给本人', () => {
  const subscribeSource = frontendSource.slice(
    frontendSource.indexOf('function subscribe('),
    frontendSource.indexOf('function resolveSendAttemptId'),
  );
  assert.doesNotMatch(subscribeSource, /setSessionStatus\(sessionId, 'idle'\)/);
  const readSource = readFileSync(new URL('./session-read.ts', import.meta.url), 'utf8');
  assert.match(readSource, /result\.messageId !== message\.messageId/);
  assert.match(readSource, /publish\(client\.userId, \{ type: 'session_reads'/);
});

test('删除中断失败时恢复原运行状态而不是形成终态', () => {
  assert.equal(resolveInterruptFailureStatus('processing', true, 0), 'processing');
  assert.equal(resolveInterruptFailureStatus('pending', false, 0), 'pending');
  assert.equal(resolveInterruptFailureStatus('stopping', true, 0), 'processing');
  assert.equal(resolveInterruptFailureStatus('stopping', false, 1), 'awaiting_action');
});

test('恢复快照状态同时服从真实待处理授权队列', () => {
  assert.equal(resolveRecoveryInProgressStatus(false, 0), 'processing');
  assert.equal(resolveRecoveryInProgressStatus(true, 0), 'awaiting_action');
  assert.equal(resolveRecoveryInProgressStatus(false, 1), 'awaiting_action');
});

test('重启遗留任务服从 Adapter 恢复策略且未声明时安全中断', () => {
  assert.match(frontendSource, /adapter\.recovery\?\.restartMode \?\? 'interrupt'/);
  assert.doesNotMatch(frontendSource, /session\.engine === 'codebuddy'[\s\S]*?RESTART_INTERRUPTED/);
});

test('活动恢复快照导入后向已订阅客户端广播权威运行快照', () => {
  assert.match(
    frontendSource,
    /if \(snapshot\.status === 'inProgress'\)[\s\S]*?broadcastRuntimeSyncState\(runtime\);/,
  );
});

test('授权响应与会话通知仅会话所有人可用', () => {
  // 授权按钮仅会话所有人可操作：有查看权限的项目成员被拒
  assert.match(frontendSource, /const ownerUserId = sessionService\.getRecord\(message\.sessionId\)\?\.owner_user_id;/);
  assert.match(frontendSource, /!canManageOwnedResource\(client\.actor, ownerUserId\)/);
  assert.match(frontendSource, /'只有会话所有人可以处理此授权'/);
  // 授权票据事件需要同步给会话所有人和管理员，保证代操作后通知能自动收敛
  assert.match(frontendSource, /function broadcastSessionResourceEvent\(sessionId: string, event: FrontendEvent\): void \{[\s\S]*?broadcastSessionResourceEventToClients\(sessionId, ownerUserId, event\);/);
});
