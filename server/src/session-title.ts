export const DEFAULT_SESSION_TITLE = '新对话';
export const MAX_SESSION_TITLE_LENGTH = 24;

const NON_SUBSTANTIVE_MESSAGES = new Set([
  '好', '好的', '好吧', '可以', '行', '嗯', '嗯嗯', '收到', '明白', '知道了',
  '谢谢', '感谢', 'ok', 'okay', 'yes', 'no', '继续', '继续吧', '接着', '接着来',
  '下一步', '没问题', '符合', '合适', '符合适', '不符合', '不合适',
  '不需要', '不用', '不必', '没必要',
]);

const NON_SUBSTANTIVE_MESSAGE_PATTERNS = [
  /^(?:非常|太|真|很)?(?:好|好的|棒|不错|完美|赞|优秀|漂亮)(?:了|啊|呀|哦|啦)?$/u,
  /^(?:我)?(?:同意|赞同)(?:这个|此)?(?:方案)?(?:了)?$/u,
  /^(?:对|是|是的|没错|确认|确定|就这样|就是这样|按这个来|就按这个来|就按这个方案)$/u,
  /^(?:不)?(?:符合|合适|合理|正确|准确|清楚|可行|满意)(?:预期|要求|需求|这个方案)?$/u,
  /^(?:不需要|不用|不必|没必要)(?:了|的|吧)?$/u,
  /^(?:问题|需求|说明|补充说明|注意|另外注意|情况|背景|目标)(?:如下)?$/u,
  /^(?:谢谢|感谢|辛苦了|谢谢辛苦了|感谢辛苦了)$/u,
  /^(?:great|nice|perfect|awesome|agreed|thanks|thankyou|goodjob)$/i,
];

const NON_SUBSTANTIVE_MESSAGE_TOKENS = [
  '谢谢辛苦了', '感谢辛苦了', '就按这个方案', '按这个方案', '就按这个来', '按这个来',
  '就是这样', '同意', '赞同', '修正', '没问题', '下一步', '继续吧', '继续', '接着来', '接着',
  '辛苦了', '谢谢', '感谢', '确认', '确定', '没错', '是的', '收到', '明白', '知道了',
  '符合适', '不符合', '不合适', '符合', '合适', '不需要', '没必要', '不用', '不必',
  '非常', '好的', '好吧', '可以', '不错', '完美', '优秀', '漂亮', '嗯嗯', '一下',
  'great', 'nice', 'perfect', 'awesome', 'agreed', 'thanks', 'thankyou', 'goodjob', 'okay',
  'yes', 'no', 'ok', '这个', '方案', '赞', '棒', '好', '行', '嗯', '对', '是', '我', '此',
  '太', '真', '很', '的', '了', '啊', '呀', '哦', '啦', '吧',
];

const CONTEXTUAL_MESSAGE_PATTERNS = [
  /^(?:那)?(?:先)?处理(?:第)?(?:一个|一项|这(?:个|项|些|两个|几个)?(?:事情|事项|任务)?|那(?:个|项|些|两个|几个)?(?:事情|事项|任务)?|两个(?:事情|事项|任务)?)(?:吧)?$/u,
  /^(?:再|再次|重新)?(?:看(?:看)?|检查|核查)(?:下|一下)?(?:(?:修改(?:的)?内容|代码|最新分支情况|分支情况|(?:有哪些)?待办(?:事项|事情)?))?(?:吧)?$/u,
  /^(?:先)?(?:合并|提交|推送|构建|部署|重启)(?:吧|了|好了)?$/u,
  /^(?:那)?(?:开始|开始设计|开始实施|开始设计实施)(?:吧)?$/u,
  /^(?:那)?开始(?:走)?(?:部署上线|上线|部署)?流程(?:吧)?$/u,
  /^(?:下面|下一步|接下来|然后)(?:建议)?(?:呢|做什么|怎么做|吧)?$/u,
  /^具体(?:修改|处理|做)什么(?:呢)?$/u,
  /^(?:已经)?(?:重启好了|完成了|分支干净了|处理好了)$/u,
  /^(?:jenkins)?(?:构建|部署|构建部署|重启)+(?:好了|完成了)$/iu,
  /^刷新后(?:重复|问题|现象).*(?:仍|还)(?:存在|一样)$/u,
  /^等待(?:该|这个|那个)?.{0,8}(?:合并|完成)后再(?:实施|处理|继续)$/u,
  /^(?:这个|那个|这).*(?:阶段|步骤).*(?:修改|处理|实施)(?:代码|内容)?$/u,
  /^(?:先)?(?:讨论|设计)(?:下|一下)?(?:这个|该)?(?:待办|方案|事情)(?:的)?(?:设计方案|方案)?(?:吧)?$/u,
  /^(?:补充下)?只需要(?:合并|提交|推送|构建|部署).*(?:即可|人工操作)$/u,
  /^(?!.*(?:失败|报错|异常|问题))(?:可以|确认)?(?:提交|合并|推送|构建|部署).*(?:分支|代码|构建|部署|提交|推送).*$/u,
  /^(?:刚才)?(?:原|当前|最新)?分支.*(?:提交|情况|干净).*$/u,
  /^之前(?:沟通|提到)?有(?:个|一个)?事情要处理$/u,
  /^(?:正常)?字体(?:就行|即可)(?:可以)?(?:加粗|调整|修改)(?:一下)?$/u,
  /^可以(?:合理)?(?:换行|加粗)(?:一下)?$/u,
  /^可以(?:调整|修改)(?:一下)?$/u,
  /^(?:补充|修改|处理|开始)(?:一下|下)?吧$/u,
  /^改成(?:红色|蓝色|绿色|黄色|黑色|白色|灰色|圆形|方形|粗体|细体|正常字体|默认样式)$/u,
  /^(?:确认|同意|允许|接受)(?:登记|克隆|发布|部署|实施|修改|执行|删除|升级|操作).{0,12}$/u,
  /^(?:继续)?(?:清理|补上|补掉|补强|发布|落地|配置|迁移|上传|升级|停止|统一|新增|优化|排查|标记|修正|审查|处理|实施|执行)(?:下|一下|试试)?吧$/u,
];

const GREETING_MESSAGE_PATTERN = /^你好(?:啊|呀|哈)?(?:\d+)?$/u;
const SHORT_FAULT_MESSAGES = new Set([
  '白屏', '黑屏', '蓝屏', '花屏', '崩溃', '闪退', '报错', '错误', '异常', '失败',
  '卡死', '死机', '假死', '冻结', '阻塞', '乱码', '超时', '宕机', '掉线', '断连',
  '断网', '中断', '离线', '失效', '失灵', '丢失', '泄漏', '冲突', '损坏',
]);
const CONTEXTUAL_COMPLETION_SUFFIX = /(?:ok了?|正常了?|完成了?|完了|重启了|重启好了)$/iu;
const CONTEXTUAL_COMPLETION_NEGATIVE = /(?:失败|报错|异常|问题|错误|不正常|未完成|没完成|仍然?|还是|还没|尚未)/u;

const LEADING_RESPONSE_PREFIX = /^(?:(?:好的?|好吧|可以|这个可以|行|嗯+|收到|明白(?:了)?|知道了|谢谢|感谢|同意|赞同|符合|合适|是的?|没错|确认|确定|对|不需要|不用|不必|没必要)(?:这个|此)?(?:方案)?)[，,、:：。.!！?？]+\s*/u;
const LEADING_RESPONSE_TASK_PREFIX = /^(?:好的?|可以|同意|赞同)(?=(?:增加|修正|修改|创建|实现|补充|讨论|设计|检查|处理))/u;
const LEADING_DISCOURSE_PREFIX = /^(?:另外|并且|还有|补充(?:一下|下)?)(?:[，,、:：]+\s*|\s+)/u;

export type SessionTitleMessageKind = 'ignore' | 'contextual' | 'topic';

export interface SessionTitleMessageClassification {
  kind: SessionTitleMessageKind;
  content: string;
}

function cleanSessionTitleContent(content: string): string {
  return content
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function consistsOnlyOfNonSubstantiveTokens(content: string): boolean {
  const reachable = new Uint8Array(content.length + 1);
  reachable[0] = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (!reachable[index]) continue;
    for (const token of NON_SUBSTANTIVE_MESSAGE_TOKENS) {
      if (content.startsWith(token, index)) reachable[index + token.length] = 1;
    }
  }
  return reachable[content.length] === 1;
}

function normalizeForClassification(content: string): string {
  return content
    .toLocaleLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
}

function stripLeadingResponsePrefix(content: string): string {
  let stripped = content.trim();
  let previous = '';
  while (stripped && stripped !== previous) {
    previous = stripped;
    stripped = stripped
      .replace(LEADING_RESPONSE_PREFIX, '')
      .replace(LEADING_RESPONSE_TASK_PREFIX, '')
      .replace(LEADING_DISCOURSE_PREFIX, '')
      .trim();
  }
  return stripped;
}

function isNonSubstantiveCompactMessage(compact: string): boolean {
  if (!compact) return true;
  if (NON_SUBSTANTIVE_MESSAGES.has(compact)) return true;
  if (NON_SUBSTANTIVE_MESSAGE_PATTERNS.some((pattern) => pattern.test(compact))) return true;
  if (consistsOnlyOfNonSubstantiveTokens(compact)) return true;
  return /^(?:选|选择)?(?:第)?(?:\d+|[一二三四五六七八九十]+)(?:个|项|条|种|号)?(?:吧)?$/u.test(compact);
}

function isContextualCompletionMessage(compact: string): boolean {
  return Array.from(compact).length <= 24
    && CONTEXTUAL_COMPLETION_SUFFIX.test(compact)
    && !CONTEXTUAL_COMPLETION_NEGATIVE.test(compact);
}

function classifySessionTitleSegment(content: string): SessionTitleMessageClassification {
  const candidate = stripLeadingResponsePrefix(content);
  const normalized = normalizeForClassification(candidate);
  const compact = normalized.replace(/[\p{P}\p{S}\s]+/gu, '');
  if (isNonSubstantiveCompactMessage(compact)) return { kind: 'ignore', content: '' };
  if (GREETING_MESSAGE_PATTERN.test(compact)) return { kind: 'ignore', content: '' };
  const compactLength = Array.from(compact).length;
  if (compactLength === 1) return { kind: 'ignore', content: '' };
  if (SHORT_FAULT_MESSAGES.has(compact)) return { kind: 'topic', content: candidate };
  if (
    CONTEXTUAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(compact))
    || isContextualCompletionMessage(compact)
  ) {
    return { kind: 'contextual', content: candidate };
  }
  if (compact.length <= 20 && /^(?:确认授权|确认提交)(?:阶段)?(?:一|二|三|\d+)?(?:代码)?(?:修改|提交|合并|推送)?$/u.test(compact)) {
    return { kind: 'contextual', content: candidate };
  }
  if (compactLength === 2) return { kind: 'contextual', content: candidate };
  return { kind: 'topic', content: candidate };
}

export function classifySessionTitleMessage(content: string): SessionTitleMessageClassification {
  const rank: Record<SessionTitleMessageKind, number> = { ignore: 0, contextual: 1, topic: 2 };
  let best: SessionTitleMessageClassification = { kind: 'ignore', content: '' };
  for (const segment of content.split(/(?:\r?\n|[;；])+/u)) {
    const classified = classifySessionTitleSegment(cleanSessionTitleContent(segment));
    if (rank[classified.kind] > rank[best.kind]) best = classified;
  }
  return best;
}

export function shouldUpdateAutomaticSessionTitle(
  currentTitle: string,
  kind: SessionTitleMessageKind,
): boolean {
  if (kind === 'ignore') return false;
  return currentTitle === DEFAULT_SESSION_TITLE || kind === 'topic';
}

export function generateSessionTitle(content: string): string {
  const cleaned = cleanSessionTitleContent(content);

  if (!cleaned) return DEFAULT_SESSION_TITLE;

  const characters = Array.from(cleaned);
  if (characters.length <= MAX_SESSION_TITLE_LENGTH) return cleaned;
  return `${characters.slice(0, MAX_SESSION_TITLE_LENGTH - 1).join('')}…`;
}

export function isSubstantiveSessionTitleMessage(content: string): boolean {
  return classifySessionTitleMessage(content).kind !== 'ignore';
}
