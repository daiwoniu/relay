import type { NewsSource } from './source-types.js';

function rss(id: string, name: string, url: string, categoryId: string, intervalMinutes: number, disabledReason?: string, region: 'cn' | 'global' = 'global'): NewsSource {
  return {
    id, name, kind: 'rss_atom', url, allowedHosts: [new URL(url).hostname],
    enabled: !disabledReason, intervalMinutes, categoryId, region, ...(disabledReason ? { disabledReason } : {}),
  };
}

function releases(id: string, name: string, repo: string, region: 'cn' | 'global' = 'global'): NewsSource {
  return {
    id, name, kind: 'github_releases',
    url: `https://api.github.com/repos/${repo}/releases?per_page=5`,
    allowedHosts: ['api.github.com'], enabled: true, intervalMinutes: 60, categoryId: 'open_source', region,
  };
}

/** 海外来源于 2026-10-15、国内来源于 2026-10-16 和 2026-10-19 探测；arXiv cs.LG 于 2026-10-20 复验。 */
export const SEED_SOURCES: NewsSource[] = [
  rss('ithome-rss', 'IT之家 · 中文报道', 'https://www.ithome.com/rss/', 'industry', 30, undefined, 'cn'),
  rss('aiera-rss', '新智元 · 中文报道', 'https://aiera.com.cn/feed/', 'industry', 30, undefined, 'cn'),
  rss('ifanr-rss', '爱范儿 · 中文报道', 'https://www.ifanr.com/feed', 'industry', 30, undefined, 'cn'),
  rss('tmtpost-rss', '钛媒体 · 中文报道', 'https://www.tmtpost.com/rss.xml', 'industry', 30, undefined, 'cn'),
  releases('deepseek-v3-releases', 'DeepSeek V3 · 官方发布', 'deepseek-ai/DeepSeek-V3', 'cn'),
  releases('internlm-releases', '书生·浦语 · 官方发布', 'internlm/internlm', 'cn'),
  releases('minicpm-v-releases', 'MiniCPM-V · 官方发布', 'OpenBMB/MiniCPM-V', 'cn'),
  releases('modelscope-swift-releases', '魔搭 ms-swift · 官方发布', 'modelscope/ms-swift', 'cn'),
  releases('modelscope-evalscope-releases', '魔搭 EvalScope · 官方发布', 'modelscope/evalscope', 'cn'),
  rss('openai-news', 'OpenAI 新闻', 'https://openai.com/news/rss.xml', 'models_products', 30),
  rss('deepmind-blog', 'Google DeepMind', 'https://deepmind.google/blog/rss.xml', 'research', 60),
  rss('google-ai-blog', 'Google AI 博客', 'https://blog.google/innovation-and-ai/technology/ai/rss/', 'industry', 60),
  rss('nvidia-blog', 'NVIDIA 博客', 'https://blogs.nvidia.com/feed/', 'industry', 60),
  rss('techcrunch-ai', 'TechCrunch AI', 'https://techcrunch.com/category/artificial-intelligence/feed/', 'industry', 30),
  rss('mit-tech-review', 'MIT Technology Review', 'https://www.technologyreview.com/feed/', 'industry', 60),
  rss('arxiv-cs-lg-rss', 'arXiv cs.LG RSS', 'https://rss.arxiv.org/rss/cs.LG', 'research', 1440),
  releases('openai-python-releases', 'OpenAI Python SDK', 'openai/openai-python'),
  releases('langchain-releases', 'LangChain', 'langchain-ai/langchain'),
  releases('transformers-releases', 'Transformers', 'huggingface/transformers'),
  releases('vllm-releases', 'vLLM', 'vllm-project/vllm'),
  releases('ollama-releases', 'Ollama', 'ollama/ollama'),
  {
    id: 'hacker-news-new', name: 'Hacker News 新故事', kind: 'hacker_news',
    url: 'https://hacker-news.firebaseio.com/v0/newstories.json',
    allowedHosts: ['hacker-news.firebaseio.com'], enabled: true, intervalMinutes: 60, categoryId: 'industry',
  },
];

/** 仅用于升级已有安装中的旧默认来源；不作为新安装的采集源。 */
export const LEGACY_DISABLED_SEED_SOURCES: NewsSource[] = [
  rss('arxiv-cs-ai-rss', 'arXiv cs.AI RSS', 'https://rss.arxiv.org/rss/cs.AI', 'research', 1440, '实测响应约 2.9 MiB，超过单来源 2 MiB 上限'),
  rss('arxiv-cs-lg-rss', 'arXiv cs.LG RSS', 'https://rss.arxiv.org/rss/cs.LG', 'research', 1440, '当前网络环境 8 秒内无法完成请求'),
  rss('arxiv-cs-ai-api', 'arXiv cs.AI API', 'https://export.arxiv.org/api/query?search_query=cat%3Acs.AI&start=0&max_results=25&sortBy=submittedDate&sortOrder=descending', 'research', 1440, '当前网络环境 8 秒内无法完成请求'),
  rss('huggingface-blog', 'Hugging Face 博客', 'https://huggingface.co/blog/feed.xml', 'industry', 60, '当前网络环境 TLS 握手失败'),
  rss('microsoft-ai-blog', 'Microsoft AI 博客', 'https://blogs.microsoft.com/ai/feed/', 'industry', 60, '实测返回 HTTP 410'),
];
