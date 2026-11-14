export interface MessageErrorGuidance {
  description: string;
  suggestion?: string;
}

interface MessageErrorGuidanceOptions {
  safeToRetry?: boolean;
  scope?: 'task' | 'request';
}

const unsafeRetrySuggestion = '请先检查处理过程和文件变更，确认没有产生副作用后再决定是否重新发送。';
const retrySuggestion = '可以重新发送；如果持续出现，请复制原始异常进行排查。';

const guide = (description: string, suggestion?: string): MessageErrorGuidance => ({
  description,
  ...(suggestion ? { suggestion } : {}),
});

const retryOrUnsafe = (options: MessageErrorGuidanceOptions, description: string, safe: string): MessageErrorGuidance =>
  guide(description, options.safeToRetry ? safe : options.scope === 'request' ? '请先核对操作是否已经生效，确认未生效后再重试，避免重复提交。' : unsafeRetrySuggestion);

type KnownGuidance = MessageErrorGuidance | ((options: MessageErrorGuidanceOptions) => MessageErrorGuidance);

const FINAL_ANSWER_MISSING = () => guide('任务已经结束，但 AI 没有生成可展示的最终回复。', '请先查看处理过程及文件变更，确认已有结果后再决定是否补发消息。');
const TURN_INTERRUPTED = () => guide('本轮任务已被中断，已产生的内容会继续保留。');
const CONNECTION_CLOSED = (engine: string) => (options: MessageErrorGuidanceOptions) =>
  retryOrUnsafe(options, `${engine} 连接在任务完成前已断开。`, '请检查引擎状态后重新发送。');

const KNOWN_CODES: Record<string, KnownGuidance> = {
  TURN_START_PREPARATION_FAILED: guide(
    'Relay 在启动本轮任务前准备失败。消息已保存，但本轮尚未发送给 AI 引擎。',
    '请在服务维护中检查所选引擎的状态，恢复可用后重新发送。如果引擎正常仍出现此提示，请提供发生时间和错误码，以便排查 Relay 日志。',
  ),
  TURN_PREPARATION_ENGINE_UNAVAILABLE: guide('本轮任务尚未发送：AI 引擎未能启动或连接不可用。', '请检查引擎维护中的状态；若 Codex 无法启动，请在服务维护中完整重启 Relay，恢复后重新发送。'),
  TURN_PREPARATION_CONNECTION_TIMEOUT: guide('本轮任务尚未发送：准备引擎或连接服务时超时。', '请检查引擎状态和网络；服务恢复可用后重新发送。持续超时请提供发生时间和下方原始异常。'),
  TURN_PREPARATION_MODEL_UNAVAILABLE: guide('本轮任务尚未发送：所选模型不存在、不受支持或暂不可用。', '请刷新模型列表，选择当前引擎可用的模型后重新发送。'),
  TURN_PREPARATION_ATTACHMENT_INVALID: guide('本轮任务尚未发送：附件读取或校验失败。', '请根据原始异常移除失效附件、重新上传，或选择支持该附件类型的模型。'),
  TURN_PREPARATION_STORAGE_UNAVAILABLE: guide('本轮任务尚未发送：Relay 无法读取或确认本轮所需的数据。', '请先查看会话是否已保存并检查 Relay 日志，恢复存储服务后重新发送；不要删除数据库或重复提交。'),
  TURN_PREPARATION_CONFLICT: guide('本轮任务尚未发送：准备期间会话状态发生变化，原任务已不符合启动条件。', '请刷新会话确认当前任务状态；已有任务时等待其结束，需要继续时再重新发送。'),
  TURN_PREPARATION_ACCESS_DENIED: guide('本轮任务尚未发送：账号、项目或引擎的访问权限校验未通过。', '请根据原始异常检查登录状态与项目权限，恢复访问后重新发送。'),
  CODEX_CONNECT_FAILED: guide('无法建立 Codex 连接，本轮任务未正常启动。', '请检查引擎状态；Codex 启动失败时可完整重启 Relay，恢复后重新发送。'),
  CODEX_PROTOCOL_ERROR: guide('与 Codex 的通信内容不符合预期协议。', '请检查 Relay 与 Codex 版本是否兼容，并提供下方原始异常排查。'),
  ZCODE_AUTH_REQUIRED: guide('ZCode 尚未登录或登录状态已失效。', '请在 ZCode 中完成登录，恢复可用后重新发送。'),
  ZCODE_PROCESS_START_FAILED: guide('ZCode 子进程启动失败。', '请检查 ZCode 安装与引擎维护状态，恢复后重新发送。'),
  ZCODE_PROCESS_EXITED: guide('ZCode 子进程退出，本轮处理未能完成。', '请查看已产生的结果及引擎维护状态，恢复后再决定是否重新发送。'),
  ZCODE_PROTOCOL_ERROR: guide('与 ZCode 的通信内容不符合预期协议。', '请检查引擎版本和配置，并提供下方原始异常排查。'),
  ZCODE_CONNECTION_CLOSED: CONNECTION_CLOSED('ZCode'),
  ZCODE_FINAL_ANSWER_MISSING: FINAL_ANSWER_MISSING,
  ZCODE_TURN_INTERRUPTED: TURN_INTERRUPTED,
  CODEX_SERVER_OVERLOADED: (options) => retryOrUnsafe(options, '当前模型容量已满，暂时无法完成本次处理。', '建议稍后重新发送。'),
  CODEX_THREAD_ARCHIVED: guide('该会话已在 ChatGPT/Codex 中归档，无法继续处理。', '请在 Codex 会话菜单中取消归档后重试。'),
  CODEX_CONNECTION_TIMEOUT: guide('连接 Codex app-server 超时，任务已中断。', '请检查 Codex app-server 与网络后重新发送。'),
  CODEX_CONNECTION_ERROR: guide('Codex 连接异常。', '请确认 Codex app-server 已启动后重试。'),
  CODEX_CONNECTION_CLOSED: CONNECTION_CLOSED('Codex'),
  CODEX_NOT_CONNECTED: guide('与 Codex 的连接已断开。', '请重新发送；如果持续出现，请检查 Codex 状态。'),
  CODEX_TURN_ERROR: (options) => retryOrUnsafe(options, 'Codex 发送消息失败。', retrySuggestion),
  CODEX_USAGE_LIMIT_EXCEEDED: guide('Codex 使用额度已达到限制。', '请检查额度后稍后重新发送。'),
  CODEX_RESPONSE_STREAM_DISCONNECTED: (options) => retryOrUnsafe(options, 'Codex 响应流已断开，本轮回复不完整。', '可以重新发送。'),
  RESTART_RECOVERY_FAILED: guide('恢复重启前的任务失败。', '请打开原会话查看已保留的结果，必要时重新发送。'),
  CODEX_INIT_FAILED: guide('Codex 会话初始化失败，本条消息尚未正常开始处理。', '可以稍后重新发送；如果持续出现，请检查 Codex 状态。'),
  CODEBUDDY_AUTH_REQUIRED: guide('CodeBuddy 尚未登录，无法开始处理。', '请先完成 CodeBuddy 登录后重试。'),
  CODEBUDDY_PROCESS_START_FAILED: guide('CodeBuddy 子进程启动失败。', '请检查 CodeBuddy 安装与配置后重试；如持续出现，请查看引擎维护面板。'),
  CODEBUDDY_PROCESS_EXITED: guide('CodeBuddy 子进程已退出，本轮任务中断。', '请确认引擎维护面板中的状态后重新发送。'),
  CODEBUDDY_PROTOCOL_ERROR: guide('与 CodeBuddy 的通信出现异常，消息未正常处理。', '请更新 CodeBuddy 或 Relay 后重试。'),
  CODEBUDDY_PROMPT_STALLED: (options) => retryOrUnsafe(options, 'CodeBuddy 长时间没有响应，已回收连接。', '可以重新发送。'),
  CODEBUDDY_TURN_CANCELLED: guide('本轮 CodeBuddy 任务已取消。'),
  CODEBUDDY_CONNECTION_CLOSED: CONNECTION_CLOSED('CodeBuddy'),
  OPENCODE_AUTH_REQUIRED: guide('OpenCode 尚未登录，无法开始处理。', '请先完成 OpenCode 登录后重试。'),
  OPENCODE_PROCESS_START_FAILED: guide('OpenCode 子进程启动失败。', '请检查 OpenCode 安装与配置后重试；如持续出现，请查看引擎维护面板。'),
  OPENCODE_PROCESS_EXITED: guide('OpenCode 子进程已退出，本轮任务中断。', '请确认引擎维护面板中的状态后重新发送。'),
  OPENCODE_PROTOCOL_ERROR: guide('与 OpenCode 的通信出现异常，消息未正常处理。', '请更新 OpenCode 或 Relay 后重试。'),
  OPENCODE_PROMPT_STALLED: (options) => retryOrUnsafe(options, 'OpenCode 长时间没有响应，已回收连接。', '可以重新发送。'),
  OPENCODE_TURN_CANCELLED: guide('本轮 OpenCode 任务已取消。'),
  OPENCODE_CONNECTION_CLOSED: CONNECTION_CLOSED('OpenCode'),
  OPENCODE_FINAL_ANSWER_MISSING: FINAL_ANSWER_MISSING,
  CODEBUDDY_FINAL_ANSWER_MISSING: FINAL_ANSWER_MISSING,
  FINAL_ANSWER_MISSING: FINAL_ANSWER_MISSING,
  CODEX_TURN_INTERRUPTED: TURN_INTERRUPTED,
  CODEBUDDY_TURN_INTERRUPTED: TURN_INTERRUPTED,
  OPENCODE_TURN_INTERRUPTED: TURN_INTERRUPTED,
  ENGINE_REQUIRED: guide('当前会话尚未选择可用的 AI 引擎。', '请选择可用引擎后重新发送。'),
  ENGINE_ALREADY_BOUND: guide('当前会话已经绑定了其他 AI 引擎，不能在发送时切换。', '请继续使用当前会话的引擎；需要更换引擎时新建会话。'),
  ENGINE_UNAVAILABLE: guide('当前选择的 AI 引擎不可用。', '请检查引擎状态，恢复可用后重新发送。'),
  ENGINE_UNAVAILABLE_AFTER_MAINTENANCE: guide('当前选择的 AI 引擎不可用。', '请检查引擎状态，恢复可用后重新发送。'),
  ENGINE_MAINTENANCE_IN_PROGRESS: guide('当前选择的 AI 引擎正在维护，暂时不能处理新消息。', '请等待维护完成后重新发送。'),
  SERVICE_RECOVERY_IN_PROGRESS: guide('Relay 服务正在恢复会话状态，暂时不能处理新消息。', '请稍后重新发送。'),
  SESSION_BUSY: guide('当前会话已有任务正在处理，暂时不能同时发送另一条消息。', '请等待当前任务结束后重新发送。'),
  PROJECT_NOT_FOUND: guide('当前会话关联的项目已经不存在或无法访问。', '请重新选择项目或新建会话。'),
  ATTACHMENT_INVALID: guide('消息中的附件未通过安全校验，未进入任务处理。', '请移除失效附件或重新选择文件。'),
  MESSAGE_PROCESSING_FAILED: (options) => retryOrUnsafe(options, 'Relay 在处理这条消息时发生异常，任务未能正常继续。', retrySuggestion),
  STORAGE_UNAVAILABLE: guide('Relay 暂时无法读取或确认数据，当前操作结果尚无法确认。', '请先刷新并核对实际状态，查看 Relay 日志；确认操作未生效后再重试，不要删除数据库。'),
  OPERATION_EXPIRED: guide('本次操作的确认已过期。', '请刷新当前页面并重新发起操作。'),
  FORBIDDEN: guide('当前账号没有执行此操作的权限。', '请检查账号、项目权限；如需权限，请联系管理员。'),
  UNAUTHORIZED: guide('登录状态已失效，当前请求未通过身份校验。', '请重新登录，确认账号后再发起操作。'),
  NOT_FOUND: guide('要操作的资源已不存在或当前账号无法访问。', '请刷新列表并重新选择资源，检查它是否已被删除或移入回收站。'),
  CONFLICT: guide('资源状态已经变化，本次操作与当前状态冲突。', '请刷新并核对当前状态，确认尚未生效后再重新操作。'),
  OVERLOADED: guide('Relay 当前处理队列已满，暂时无法受理更多操作。', '请等待现有任务结束，核对本次操作结果后再重试。'),
  INVALID_ARGUMENT: guide('提交的参数未通过校验。', '请根据原始异常检查填写内容、附件和当前选择，修正后重新提交。'),
  PAYLOAD_TOO_LARGE: guide('提交的消息、附件或数据超过允许大小。', '请缩短内容、减少附件或拆分数据后重新提交。'),
  NOT_SUPPORTED: guide('当前服务或引擎不支持此操作。', '请检查版本、模型和操作类型是否受支持；必要时更换可用引擎。'),
  NOT_SUBMITTED: guide('当前操作尚未成功提交。', '请确认服务可用及当前任务状态，确认未提交后再发起操作。'),
  SUPERSEDED: guide('本次操作已被较新的操作替代。', '请刷新查看最新状态，使用当前页面继续操作。'),
};

const NESTED_ANALYSIS_LIMIT = 16_384;

function extractNestedMessage(errorMessage: string | undefined): string | null {
  if (!errorMessage) return null;
  const trimmed = errorMessage.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    if (!parsed || typeof parsed !== 'object') return null;
    const raw = parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string'
      ? parsed.error.message
      : typeof parsed.message === 'string'
        ? parsed.message
        : '';
    const message = typeof raw === 'string' ? raw.trim() : '';
    return message ? message.slice(0, NESTED_ANALYSIS_LIMIT) : null;
  } catch {
    return null;
  }
}

function classifyErrorText(errorMessage: string, options: MessageErrorGuidanceOptions): MessageErrorGuidance | null {
  const text = errorMessage.toLowerCase();
  if (/用户名或密码|密码.*(?:错误|不正确)|invalid credentials|incorrect password/i.test(text)) return guide('登录信息校验失败。', '请核对账号和密码；忘记密码时联系管理员重置。');
  if (/ENOENT|ENOTDIR|文件.*不存在|目录.*不存在/i.test(text)) return guide('要访问的文件或目录已不存在。', '请重新选择有效的文件或项目目录，确认文件未被移动或删除。');
  if (/unexpected token|JSON\.parse|invalid (?:json|input|date|time)|输入.*格式/i.test(text)) return guide('输入内容无法按要求解析。', '请根据原始异常检查输入格式、日期或 JSON 语法，修正后重新操作。');
  if (/EADDRINUSE|10048|address already in use|端口.*(?:占用|残留)|幽灵监听/i.test(text)) {
    return guide('服务启动失败：所需端口被占用或存在异常残留监听。', 'Codex 可在服务维护中完整重启 Relay，由启动器清理进程并在必要时切换空闲端口；如果仍失败，请提供发生时间和原始异常。');
  }
  if (/ENOSPC|disk.*full|磁盘.*(?:不足|已满)|空间不足/i.test(text)) return guide('可用磁盘空间不足，操作未能完成。', '请释放磁盘空间，核对数据是否已保存，再重新操作。');
  if (/out of memory|ENOMEM|内存不足/i.test(text)) return guide('可用内存不足，服务未能完成操作。', '请关闭不需要的程序，检查服务是否仍在运行，确认操作结果后再重试。');
  if (!/rate.?limit|tokens? per (?:minute|second)|\bTPM\b/i.test(text) && /context.*(?:length|window|limit)|(?:max(?:imum)?|input|output|total)[ _-]*tokens?.*(?:exceed|limit)|tokens?[ _-]*limit.*exceed|上下文.*(?:超|满)/i.test(text)) return guide('本轮内容超出模型的上下文容量。', '请缩短输入或减少附件；需要新建会话时，先保存必要的上下文。');
  if (/quota|usage.?limit|insufficient.*(?:credit|balance)|额度|余额不足/i.test(text)) return guide('AI 服务额度或余额不足，暂时无法继续处理。', '请检查所用账号的额度、套餐与重置时间，恢复可用后再发送。');
  if (/\b403\b|permission denied|EACCES|EPERM|无权|权限不足|拒绝访问/i.test(text)) return guide('当前操作没有通过访问权限检查。', '请根据原始异常核对账号、项目或文件的访问权限，恢复访问后重新操作。');
  if (/unauth|logout|login|authentication|\bauth\b|\b401\b|登录|身份校验/i.test(text)) {
    return guide('服务端未通过身份校验，可能是登录状态已失效。', options.scope === 'request' ? '请根据原始异常检查当前账号或上游服务的登录状态，恢复后重新操作。' : '请检查引擎登录状态后重新发送。');
  }
  if (/timeout|timed.?out|超时/i.test(text)) return guide('等待服务响应超时，暂时无法确认操作结果。', '请先查看当前任务或资源的实际状态；确认没有生效后再重试，持续超时请检查服务状态和网络。');
  if (/SQLITE_|database.*(?:locked|corrupt|unavailable)|数据库/i.test(text)) return KNOWN_CODES.STORAGE_UNAVAILABLE as MessageErrorGuidance;
  if (/请输入|请选择|不能为空|格式不正确|必须填写|无效.*(?:日期|时间|输入)/i.test(text)) return guide('填写或选择的内容未通过校验。', '请根据下方原始提示补全或修正内容，再重新提交。');
  if (/参数非法|invalid|unrecognized|validation|schema|protocol|bad request|\b400\b/i.test(text)) {
    return guide('请求或返回内容不符合服务端协议，消息未能正常处理。', '请刷新页面；如持续出现，请复制下方原始异常排查。');
  }
  if (/\b429\b|rate.?limit|tokens? per (?:minute|second)|\bTPM\b|overload|过载|限流|capacity/i.test(text)) {
    return retryOrUnsafe(options, '服务端暂时过载或触发限流，任务未能完成。', '建议稍后重新发送。');
  }
  if (/model.*(?:not found|unavailable|unsupported)|模型.*(?:不存在|不可用|不支持)/i.test(text)) {
    return guide('请求的模型、会话或资源已不存在或不可用。', '请重新选择模型或新建会话后重试。');
  }
  if (/not found|不存在|\b404\b/i.test(text)) return KNOWN_CODES.NOT_FOUND as MessageErrorGuidance;
  if (/expired|过期/i.test(text)) return guide('当前操作、确认或凭证已过期。', '请刷新状态；登录失效时重新登录，并重新发起需要的操作。');
  if (/\b500\b|internal server error|服务内部错误/i.test(text)) return guide('服务内部发生异常，当前操作未能完成。', '请先核对是否已经生效；持续失败请提供发生时间和原始异常，排查服务日志。');
  if (/disconnect|closed|connection|连接|failed to fetch|network.?error|网络|\b50[234]\b/i.test(text)) {
    return options.scope === 'request'
      ? guide('与 Relay 或上游服务的连接异常，操作结果尚无法确认。', '请检查网络与服务状态；恢复连接后先核对操作是否生效，避免重复提交。')
      : retryOrUnsafe(options, '与 AI 服务的连接已断开，任务未能完成。', '请检查引擎状态与网络后重新发送。');
  }
  return null;
}

export function getMessageErrorGuidance(
  errorCode?: string,
  errorMessage?: string,
  options: MessageErrorGuidanceOptions = {},
): MessageErrorGuidance | null {
  if (!errorCode && !errorMessage) return null;

  if (errorCode === 'INVALID_MESSAGE') {
    return guide(
      /unrecognized_keys|Unrecognized key/i.test(errorMessage || '')
        ? '当前请求包含服务端无法识别的参数，可能是前后端版本不一致。'
        : '当前请求的格式或参数不符合服务端协议。',
      '建议刷新页面；如果仍然出现，请重启 Relay。',
    );
  }

  const known = KNOWN_CODES[errorCode ?? ''];
  if (known) return typeof known === 'function' ? known(options) : known;

  const nested = extractNestedMessage(errorMessage);
  if (nested) {
    const analyzed = classifyErrorText(nested, options);
    if (analyzed) return analyzed;
    return guide('服务返回了未能识别的异常。', '请查看下方原始异常，提供发生时间、操作步骤和错误码排查。');
  }
  const classified = classifyErrorText(`${errorCode || ''} ${errorMessage || ''}`, options);
  if (classified) return classified;
  if (options.scope === 'request') return guide('当前操作未能完成，服务未提供可识别的具体原因。', '请查看原始异常并核对实际状态；确认未生效后再重试。持续失败请提供发生时间和操作步骤排查。');
  return guide('任务处理未能完成，可结合下方原始异常排查原因。', options.safeToRetry ? retrySuggestion : unsafeRetrySuggestion);
}
