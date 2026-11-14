import sanitizeHtml from 'sanitize-html';
import type { SourceCandidate } from './source-types.js';

interface GithubRelease {
  html_url?: unknown;
  name?: unknown;
  tag_name?: unknown;
  body?: unknown;
  published_at?: unknown;
  draft?: unknown;
}

function releaseDescription(body: string): string | null {
  const chineseHeading = /^#{1,4}\s*(?:中文版|中文说明|中文更新|[^\n]{0,80}发布)\s*$/m.exec(body);
  const candidate = chineseHeading ? body.slice(chineseHeading.index) : body;
  return sanitizeHtml(candidate, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ').trim().slice(0, 1000) || null;
}

export function parseGithubReleases(json: string, sourceId: string, baseUrl: string): SourceCandidate[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new TypeError('GitHub Releases 响应不是数组');
  const result: SourceCandidate[] = [];
  for (const value of parsed as GithubRelease[]) {
    if (value.draft === true || typeof value.html_url !== 'string') continue;
    const title = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : typeof value.tag_name === 'string' ? value.tag_name.trim() : '';
    if (!title) continue;
    result.push({
      sourceId, rawUrl: value.html_url, baseUrl, title,
      description: typeof value.body === 'string' ? releaseDescription(value.body) : null,
      rawPublishedAt: typeof value.published_at === 'string' ? value.published_at : null,
    });
    if (result.length === 100) break;
  }
  return result;
}
