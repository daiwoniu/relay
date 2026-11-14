import { createHash } from 'node:crypto';
import type { NewsItemInput } from '../types.js';
import type { NewsSource, SourceCandidate } from '../sources/source-types.js';

const AI_TERMS = /\b(ai|a\.i\.|llm|model|models|agent|agents|gpt|claude|gemini|transformer|neural|machine learning|deep learning|inference|openai|anthropic|hugging ?face|ollama|vllm|qwen|deepseek|kimi|glm|minimax|robotics)\b|人工智能|大模型|智能体|机器学习|深度学习|神经网络|推理模型|通义千问|豆包|文心一言|智谱|书生·?浦语|月之暗面|深度求索/i;
const TRACKING_KEYS = /^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|source)$/i;

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function canonicalNewsUrl(raw: string, baseUrl: string): string {
  const url = new URL(raw, baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不安全的资讯链接');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (TRACKING_KEYS.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

function publishedTime(raw: SourceCandidate['rawPublishedAt'], fetchedAt: number): { value: number; fallback: boolean } {
  const parsed = typeof raw === 'number' ? (raw < 10_000_000_000 ? raw * 1000 : raw) : raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < Date.parse('2000-01-01T00:00:00Z') || parsed > fetchedAt + 86_400_000) return { value: fetchedAt, fallback: true };
  return { value: parsed, fallback: false };
}

export function isLikelyAi(candidate: SourceCandidate, source: NewsSource): boolean {
  if (source.kind === 'github_releases' || ['openai-news', 'deepmind-blog', 'google-ai-blog', 'arxiv-cs-ai-rss', 'arxiv-cs-lg-rss', 'arxiv-cs-ai-api'].includes(source.id)) return true;
  return AI_TERMS.test(`${candidate.title} ${candidate.description ?? ''}`);
}

export function normalizeCandidate(candidate: SourceCandidate, source: NewsSource, fetchedAt: number): NewsItemInput {
  const url = canonicalNewsUrl(candidate.rawUrl, candidate.baseUrl);
  const title = candidate.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) throw new Error('资讯标题为空');
  const description = candidate.description?.replace(/\s+/g, ' ').trim().slice(0, 1000) || null;
  const time = publishedTime(candidate.rawPublishedAt, fetchedAt);
  const text = `${title} ${description ?? ''}`;
  const topics: string[] = [];
  for (const [id, pattern] of [
    ['agent', /\bagents?\b|智能体/i], ['coding', /\bcode|coding|programming|developer\b|编程|开发工具/i],
    ['multimodal', /\bmultimodal|vision|image|video|audio\b|多模态|图像|视频/i],
    ['inference', /\binference|reasoning\b|推理/i], ['safety', /\bsafety|security|alignment\b|安全|对齐/i],
  ] as Array<[string, RegExp]>) if (pattern.test(text)) topics.push(id);
  const entities: string[] = [];
  for (const [id, pattern] of [
    ['openai', /\bopenai|chatgpt\b/i], ['anthropic', /\banthropic|claude\b/i], ['google', /\bgoogle|gemini|deepmind\b/i],
    ['meta', /\bmeta|llama\b/i], ['nvidia', /\bnvidia\b/i], ['microsoft', /\bmicrosoft|copilot\b/i],
    ['huggingface', /\bhugging\s?face|transformers\b/i], ['ollama', /\bollama\b/i], ['vllm', /\bvllm\b/i],
    ['qwen', /\bqwen\b|通义千问/i], ['deepseek', /\bdeepseek\b|深度求索/i], ['kimi', /\bkimi\b|月之暗面/i],
    ['doubao', /豆包/i], ['wenxin', /文心一言|文心大模型/i], ['zhipu', /\bglm\b|智谱/i],
    ['internlm', /\binternlm\b|书生·?浦语/i], ['minimax', /\bminimax\b|海螺AI/i],
  ] as Array<[string, RegExp]>) if (pattern.test(text)) entities.push(id);
  const eventTypeId = /\brelease|launch|announce|推出|发布/i.test(title) ? 'release'
    : /\bupdate|upgrade|version|更新|升级|新版本/i.test(title) ? 'update'
      : /\bresearch|paper|study|论文|研究/i.test(title) ? 'research' : null;
  const id = fingerprint(`${source.id}\0${url}`);
  return {
    id, eventId: fingerprint(url), sourceId: source.id, url, title, description,
    publishedAt: time.value, firstFetchedAt: fetchedAt, categoryId: source.categoryId || 'other',
    topicIds: topics, entityIds: entities, eventTypeId,
    language: /[\u4e00-\u9fff]/.test(title) || (description?.match(/[\u4e00-\u9fff]/g)?.length ?? 0) >= 20 ? 'zh' : 'en',
    originalPublisher: candidate.originalPublisher ?? null, timeIsFallback: time.fallback,
  };
}
