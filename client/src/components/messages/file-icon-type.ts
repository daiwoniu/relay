export type FileIconType = 'image' | 'code' | 'markdown' | 'config' | 'archive' | 'audio' | 'video' | 'table' | 'document' | 'generic';

const EXTENSION_TYPES: Record<string, FileIconType> = {
  avif: 'image', bmp: 'image', gif: 'image', ico: 'image', jpeg: 'image', jpg: 'image', png: 'image', svg: 'image', webp: 'image',
  c: 'code', cc: 'code', cpp: 'code', cs: 'code', css: 'code', go: 'code', h: 'code', hpp: 'code', html: 'code', java: 'code', js: 'code',
  jsx: 'code', kt: 'code', kts: 'code', less: 'code', mjs: 'code', php: 'code', py: 'code', rb: 'code', rs: 'code', sass: 'code',
  scss: 'code', sh: 'code', svelte: 'code', swift: 'code', ts: 'code', tsx: 'code', vue: 'code',
  markdown: 'markdown', md: 'markdown', mdx: 'markdown',
  conf: 'config', config: 'config', env: 'config', ini: 'config', json: 'config', lock: 'config', properties: 'config', toml: 'config', xml: 'config', yaml: 'config', yml: 'config',
  '7z': 'archive', bz2: 'archive', gz: 'archive', rar: 'archive', tar: 'archive', tgz: 'archive', xz: 'archive', zip: 'archive',
  aac: 'audio', flac: 'audio', m4a: 'audio', mp3: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', wav: 'audio', weba: 'audio',
  avi: 'video', m4v: 'video', mkv: 'video', mov: 'video', mp4: 'video', ogv: 'video', webm: 'video',
  csv: 'table', ods: 'table', tsv: 'table', xls: 'table', xlsx: 'table',
  doc: 'document', docx: 'document', odt: 'document', pdf: 'document', rtf: 'document', txt: 'document',
};

const CONFIG_FILE_NAMES = new Set(['.dockerignore', '.editorconfig', '.env', '.gitattributes', '.gitignore', '.npmrc', 'dockerfile']);
const DOCUMENT_FILE_NAMES = new Set(['license', 'makefile', 'notice', 'procfile']);

export function getFileIconType(filePath: string): FileIconType {
  const normalized = filePath.trim().replace(/[?#].*$/, '').replace(/\\/g, '/');
  const fileName = normalized.split('/').filter(Boolean).pop()?.toLowerCase() || '';
  if (CONFIG_FILE_NAMES.has(fileName)) return 'config';
  if (DOCUMENT_FILE_NAMES.has(fileName)) return 'document';
  const extension = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
  return EXTENSION_TYPES[extension] || 'generic';
}
