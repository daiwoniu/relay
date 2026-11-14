export interface SuggestedReplyCandidate {
  sourceMessageId: string;
  text: string;
}

interface SuggestedReplyMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  outcome?: string;
  isError?: boolean;
  stopped: boolean;
}

const MAX_SCAN_CHARACTERS = 1200;
const MAX_EXPLICIT_REPLY_CHARACTERS = 120;
const MAX_INFERRED_REPLY_CHARACTERS = 80;
const ALLOWED_INFERRED_REPLY_PREFIX = /^(?:确认|同意|允许|授权|继续|选择|采用|开始|符合|合适)/u;
const COMPLETION_CLAIM_PREFIX = /^(?:(?:确认|同意)\s*)?(?:已|完成|处理完|执行完|启动完成|停止完成)/u;
const URL_OR_PATH = /(?:https?:\/\/|www\.|[a-zA-Z]:[\\/]|(?:^|\s)\/(?:[\w.-]+\/)*[\w.-]+)/u;
const COMMAND_SYNTAX = /[;&|<>]|\$\(|\b(?:Remove-Item|Stop-Process|rm|sudo|pwsh|powershell|cmd)\b/iu;
const NUMBERED_OPTION = /(?:^|\s)(?:\d+|[一二三四五六七八九十]+)(?:\.(?!\d)|[)、])\s*/u;
const SENSITIVE_REPLY = /(?:密码|口令|验证码|私钥|api\s*key|secret|token)/iu;
const EXPLICIT_ALTERNATIVE = /(?:或|或者|或是|还是|任选(?:其一)?|二选一)|(?:确认|同意|允许|继续|选择|采用|开始|符合|合适)\s*[/／]\s*(?:确认|同意|允许|继续|选择|采用|开始|符合|合适)/u;
const NEGATED_REPLY_CONTEXT = /(?:无需(?:再)?|不用(?:再)?|不必(?:再)?|不要(?:再)?|请勿|不需要(?:你)?|不建议(?:你)?|不推荐(?:你)?|并非|并不|别(?:再)?|禁止|不(?:太|再)?)\s*$/u;
const NEGATED_QUESTION_CONTEXT = /是否\s*(?:(?:现在|目前|仍然|还是|真的|并)\s*)*(?:不|无需|不用|不必|不要|请勿|不可|不能|不应)/u;
const ALTERNATIVE_CHOICE_CONTEXT = /(?:还是|或者|或是|二选一)/u;
const EXAMPLE_CONTEXT = /(?:例如|示例|比如|假设|测试用例)[：:\s\S]{0,24}$/u;
const NON_DIRECTIVE_SPEAKER_CONTEXT = /(?:老师|妈妈|爸爸|文章|故事|材料|文档|代码|接口|字段|日志|系统|模型)\s*$/u;
const REPORTED_DIRECTIVE_CONTEXT = /(?:(?:(?:下面|以下)(?:是|为)?(?:一个)?(?:示例|反例)|(?:文档|规则|代码|接口|日志|系统|模型|页面|提示|说明)[^。！？\r\n]{0,24}(?:写着|显示|包含|如下|例如|提到|是))[：:\s]*|(?:文档|规则|代码|接口|日志|系统|模型|页面|提示|说明)(?:提示|说明)?\s*[：:]\s*)$/u;
const ALTERNATIVE_REPLY_SUFFIX = /^(?:或|或者|还是|和|以及|、|\/|／)/u;
const BARE_REPLY_CUE = /^(?:回复|告诉我|告知我|回我)/u;
const ACTION_COMPLETION_CUE = String.raw`(?:请\s*)?(?:完成|执行|操作|配置|填好|恢复|连接|发布|重启|测试|验证|成功|失败|确认)[^。！？\r\n]{0,30}后`;
const REPLY_CUE = String.raw`(?:(?:(?:请(?:明确)?|可以明确|(?<!不)需要(?:你|祥哥)?\s*(?:(?:本轮|现在|当前)\s*)?(?:单独|再次明确|明确)?|下一步(?:可)?|可以|直接|只需|你(?:可以|明确)?|祥哥|推荐|${ACTION_COMPLETION_CUE}|执行完(?:后)?|操作完(?:后)?|然后|再)\s*)?回复(?:我)?|(?:(?:请|直接|只需|${ACTION_COMPLETION_CUE}|执行完(?:后)?|操作完(?:后)?|然后|再)\s*)?告诉我|(?:(?:请|直接|${ACTION_COMPLETION_CUE}|然后|再)\s*)?(?:告知我|回我)|(?:你|祥哥)\s*说一句)`;
const REPLY_CUE_SUFFIX = String.raw`(?:\s*(?:一句|类似|以下内容|这个词|即可))?`;

function tailByUnicode(content: string, maximum: number): string {
  const characters = Array.from(content);
  return characters.length > maximum ? characters.slice(-maximum).join('') : content;
}

function stripMatchingWrapper(value: string, opening: string, closing: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(opening) && trimmed.endsWith(closing)
    ? trimmed.slice(opening.length, -closing.length).trim()
    : trimmed;
}

function normalizeExplicitReply(value: string): string {
  let candidate = value.trim().replace(/^>\s*/u, '');
  for (let pass = 0; pass < 4; pass += 1) {
    const previous = candidate;
    candidate = candidate.replace(/[。．，,；;：:！？!?]+$/u, '').trim();
    candidate = stripMatchingWrapper(candidate, '**', '**');
    candidate = stripMatchingWrapper(candidate, '__', '__');
    candidate = stripMatchingWrapper(candidate, '`', '`');
    candidate = stripMatchingWrapper(candidate, '“', '”');
    candidate = stripMatchingWrapper(candidate, '「', '」');
    candidate = stripMatchingWrapper(candidate, '『', '』');
    candidate = stripMatchingWrapper(candidate, '"', '"');
    if (candidate === previous) break;
  }
  return candidate;
}

function isInsideMarkdownCode(content: string, index: number): boolean {
  const before = content.slice(0, index);
  const fences = before.match(/```/gu)?.length ?? 0;
  if (fences % 2 === 1) return true;
  const line = before.slice(before.lastIndexOf('\n') + 1);
  const inlineTicks = [...line.matchAll(/`+/gu)].filter((match) => match[0].length === 1).length;
  return inlineTicks % 2 === 1;
}

function maskMarkdownCode(content: string): string {
  return content
    .replace(/```[\s\S]*?(?:```|$)/gu, (value) => value.replace(/[^\r\n]/gu, ' '))
    .replace(/`[^`\r\n]*`/gu, (value) => value.replace(/[^\r\n]/gu, ' '));
}

function hasBareCueBoundary(content: string, index: number, matchedText: string): boolean {
  if (!BARE_REPLY_CUE.test(matchedText)) return true;
  if (index === 0) return true;
  const prefix = content.slice(0, index);
  return /(?:[。！？；：，,\r\n]|(?:^|\n)\s*[-*>])\s*$/u.test(prefix);
}

function stripLeadingReplyFormatting(value: string): string {
  let normalized = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = normalized.replace(/^[\s。．，,；;：:！？!?*_`”」』"']+/u, '');
    if (next === normalized) break;
    normalized = next;
  }
  return normalized;
}

function isTerminalActionSuffix(suffix: string): boolean {
  const normalized = stripLeadingReplyFormatting(suffix);
  if (!normalized) return true;
  if (ALTERNATIVE_REPLY_SUFFIX.test(normalized)) return false;
  const firstBlock = normalized.split(/\r?\n\s*\r?\n/u, 1)[0].trim();
  if (/(?:示例|反例|举例|假设|测试用例|测试样例|只是测试)/u.test(firstBlock)) return false;
  return /^(?:后(?:即可|进入|继续|实施|执行)|即可|就|我(?:会|再|就|将|马上|立即|继续|执行|实施|开始|更新|帮|来|从|按|直接|才会|只(?:执行|做|修改|上传|启动))|收到|授权|本次|这(?:只|次)(?:提交|修改|执行|操作|授权|回复)|仅(?:提交|修改|执行|操作|授权|回复|生成)|不会|不包含|不执行|不修改|完成后|随后|然后|该(?:动作|授权|操作|检查|回复))/u.test(firstBlock)
    || /^后面的[^。！？\r\n]{0,40}我(?:会|全部|继续|再|就)/u.test(firstBlock)
    || /^[^。！？\r\n]{0,40}(?:后[,，]?\s*)?我(?:会|再|就|将|马上|立即|继续|执行|实施|开始|更新|帮|来|从|按|直接|才会|只(?:执行|做|修改|上传|启动))/u.test(firstBlock);
}

function isExplicitDirectiveMatch(content: string, match: RegExpMatchArray): boolean {
  const index = match.index ?? 0;
  if (isInsideMarkdownCode(content, index)) return false;
  if (!hasBareCueBoundary(content, index, match[0])) return false;
  const prefix = content.slice(Math.max(0, index - 32), index);
  if (
    NEGATED_REPLY_CONTEXT.test(prefix)
    || EXAMPLE_CONTEXT.test(prefix)
    || NON_DIRECTIVE_SPEAKER_CONTEXT.test(prefix)
    || REPORTED_DIRECTIVE_CONTEXT.test(prefix)
  ) return false;
  const endIndex = index + match[0].length;
  const suffix = content.slice(endIndex);
  return isTerminalActionSuffix(suffix);
}

function collectExplicitReplies(content: string): string[] {
  const patterns = [
    new RegExp(`${REPLY_CUE}${REPLY_CUE_SUFFIX}\\s*[:：]?\\s*(?:\\*\\*|__)?\\s*\\x60([^\\x60\\r\\n]+)\\x60`, 'gu'),
    new RegExp(`${REPLY_CUE}${REPLY_CUE_SUFFIX}\\s*[:：]?\\s*(?:\\*\\*|__)?\\s*[“「『]([^”」』\\r\\n]+)[”」』]`, 'gu'),
    new RegExp(`${REPLY_CUE}${REPLY_CUE_SUFFIX}\\s*[:：]?\\s*(?:\\*\\*|__)?\\s*"([^"\\r\\n]+)"`, 'gu'),
    new RegExp(`${REPLY_CUE}${REPLY_CUE_SUFFIX}\\s*[:：]?\\s*\\*\\*([^*\\r\\n]+)\\*\\*`, 'gu'),
    new RegExp(`${REPLY_CUE}${REPLY_CUE_SUFFIX}[ \\t]*[:：][ \\t]*(?:\\r?\\n[ \\t]*){1,3}(?:>[ \\t]*)?([^\\r\\n]+)`, 'gu'),
  ];
  const matches: string[] = [];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (!isExplicitDirectiveMatch(content, match)) continue;
      matches.push(normalizeExplicitReply(match[1]));
    }
  }
  return [...new Set(matches)];
}

function isStructurallySafeReply(candidate: string, maximum: number): boolean {
  if (!candidate || /[\r\n]/u.test(candidate)) return false;
  if (Array.from(candidate).length > maximum) return false;
  if (
    URL_OR_PATH.test(candidate)
    || COMMAND_SYNTAX.test(candidate)
    || NUMBERED_OPTION.test(candidate)
    || SENSITIVE_REPLY.test(candidate)
  ) return false;
  return true;
}

function isSafeExplicitReply(candidate: string): boolean {
  return isStructurallySafeReply(candidate, MAX_EXPLICIT_REPLY_CHARACTERS)
    && !EXPLICIT_ALTERNATIVE.test(candidate);
}

function isSafeInferredReply(candidate: string): boolean {
  return isStructurallySafeReply(candidate, MAX_INFERRED_REPLY_CHARACTERS)
    && ALLOWED_INFERRED_REPLY_PREFIX.test(candidate)
    && !COMPLETION_CLAIM_PREFIX.test(candidate);
}

function inferClosedQuestionReply(content: string): string | null {
  const tail = maskMarkdownCode(tailByUnicode(content, 600)).trim();
  const questions = [...tail.matchAll(/[^。！？?]{1,400}[？?]/gu)];
  const question = questions.length > 0 ? questions[questions.length - 1][0].trim() : '';
  if (question && NEGATED_QUESTION_CONTEXT.test(question)) return null;
  const optionMentions = [...question.matchAll(/方案\s*([1-9]\d?)/gu)];
  const recommendedOption = question.match(/是否按方案\s*([1-9]\d?)\s*[^？?\r\n]{0,80}[？?]/u);
  if (
    recommendedOption
    && optionMentions.length === 1
    && !ALTERNATIVE_CHOICE_CONTEXT.test(question)
  ) return recommendedOption[1];
  if (optionMentions.length > 1 || ALTERNATIVE_CHOICE_CONTEXT.test(question)) return null;
  if (/是否允许我[\s\S]{0,300}[？?]/u.test(question)) return '允许';
  if (/是否授权[\s\S]{0,300}[？?]/u.test(question)) return '授权';
  if (/是否确认我[\s\S]{0,300}[？?]/u.test(question)) return '确认';
  if (/请确认[:：][\s\S]{0,300}[？?]/u.test(question)) return '确认';
  if (/请确认(?:一下)?\s*[:：]?[\s\S]{0,260}(?:对吗|对吧)[？?]/u.test(question)) return '确认';
  if (/是否[^？?\r\n]{0,80}符合(?:你的)?预期[？?]/u.test(question)) return '符合';
  if (/是否[^？?\r\n]{0,80}合适[？?]/u.test(question)) return '合适';
  if (/(?:可以|是否)[^？?\r\n]{0,24}继续(?:吗)?[？?]/u.test(question)) return '继续';
  if (/是否同意[^？?\r\n]{0,80}[？?]/u.test(question)) return '同意';
  if (/是否允许[^？?\r\n]{0,80}[？?]/u.test(question)) return '允许';
  if (!question && /如果(?:这部分|以上|上述)[^，,。\r\n]{0,40}确认[，,]/u.test(tail)) return '确认';
  if (/是否确认[？?]/u.test(question)) return '确认';
  if (/(?:设计|方案)[^。！？?\r\n]{0,40}(?:完整|明确)[，,。]?\s*是否现在[^？?\r\n]{0,80}[？?]/u.test(question)) return '同意';
  return null;
}

export function extractSuggestedReply(content: string): string | null {
  if (!content.trim()) return null;
  const matches = collectExplicitReplies(tailByUnicode(content, MAX_SCAN_CHARACTERS));
  if (matches.length > 1) return null;
  if (matches.length === 1) return isSafeExplicitReply(matches[0]) ? matches[0] : null;
  const inferred = inferClosedQuestionReply(content);
  if (/^[1-9]\d?$/u.test(inferred ?? '')) return inferred;
  return inferred && isSafeInferredReply(inferred) ? inferred : null;
}

export function selectSuggestedReplyCandidate(
  messages: SuggestedReplyMessage[],
  sessionRunning: boolean,
): SuggestedReplyCandidate | null {
  if (sessionRunning || messages.length === 0) return null;
  const latest = messages[messages.length - 1];
  if (
    latest.role !== 'assistant'
    || latest.isError
    || latest.stopped
    || (latest.outcome && latest.outcome !== 'completed')
  ) return null;
  const text = extractSuggestedReply(latest.content);
  return text ? { sourceMessageId: latest.id, text } : null;
}
