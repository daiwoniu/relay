import type { NewsItemInput } from '../types.js';

const WINDOW_MS = 72 * 60 * 60_000;
const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with', 'new', 'today']);

function words(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((word) => word.length > 1 && !STOP_WORDS.has(word)) ?? []);
}

function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return union ? intersection / union : 0;
}

function versions(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/\bv?\d+(?:\.\d+){1,3}\b/g) ?? []).map((value) => value.replace(/^v/, '')));
}

export function chooseEventId(candidate: NewsItemInput, recent: NewsItemInput[]): string {
  let best: NewsItemInput | null = null;
  let bestScore = 0;
  for (const existing of recent) {
    if (Math.abs(candidate.publishedAt - existing.publishedAt) > WINDOW_MS) continue;
    if (candidate.entityIds.length && existing.entityIds.length && !candidate.entityIds.some((id) => existing.entityIds.includes(id))) continue;
    const candidateVersions = versions(candidate.title);
    const existingVersions = versions(existing.title);
    if (candidateVersions.size && existingVersions.size && ![...candidateVersions].some((version) => existingVersions.has(version))) continue;
    const crossLanguageVersion = candidate.language !== existing.language
      && candidate.entityIds.length > 0 && existing.entityIds.length > 0
      && candidateVersions.size > 0 && [...candidateVersions].some((version) => existingVersions.has(version))
      && candidate.eventTypeId !== null && candidate.eventTypeId === existing.eventTypeId;
    const score = crossLanguageVersion ? 0.95 : similarity(candidate.title, existing.title);
    if (score >= 0.7 && score > bestScore) { best = existing; bestScore = score; }
  }
  return best?.eventId ?? candidate.eventId;
}
