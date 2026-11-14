interface LocalTranslator {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface LocalTranslatorApi {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string; signal?: AbortSignal }): Promise<LocalTranslator>;
}

export interface ChineseNewsText { title: string; description: string | null }

export async function canTranslateNewsInBrowser(): Promise<boolean> {
  const api = (globalThis as typeof globalThis & { Translator?: LocalTranslatorApi }).Translator;
  if (!api) return false;
  try { return ['available', 'downloadable', 'downloading'].includes(await api.availability({ sourceLanguage: 'en', targetLanguage: 'zh' })); }
  catch { return false; }
}

export async function translateNewsInBrowser(title: string, description: string | null): Promise<ChineseNewsText> {
  const api = (globalThis as typeof globalThis & { Translator?: LocalTranslatorApi }).Translator;
  if (!api) throw new Error('当前浏览器不支持页内翻译，请使用浏览器的网页翻译功能');
  const languages = { sourceLanguage: 'en', targetLanguage: 'zh' };
  if (await api.availability(languages) === 'unavailable') throw new Error('当前浏览器不支持英译中，请使用浏览器的网页翻译功能');
  const translator = await api.create({ ...languages, signal: AbortSignal.timeout(90_000) });
  try {
    const translatedTitle = await translator.translate(title.slice(0, 300), { signal: AbortSignal.timeout(30_000) });
    const translatedDescription = description
      ? await translator.translate(description.slice(0, 400), { signal: AbortSignal.timeout(30_000) }) : null;
    if (!translatedTitle.trim()) throw new Error('翻译结果为空');
    return { title: translatedTitle.trim(), description: translatedDescription?.trim() || null };
  } finally {
    translator.destroy();
  }
}
