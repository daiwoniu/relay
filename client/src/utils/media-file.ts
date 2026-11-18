export interface MediaFileType {
  kind: 'audio' | 'video';
  mimeType: string;
}

const mediaTypes = new Map<string, MediaFileType>([
  ['mp3', { kind: 'audio', mimeType: 'audio/mpeg' }],
  ['wav', { kind: 'audio', mimeType: 'audio/wav' }],
  ['m4a', { kind: 'audio', mimeType: 'audio/mp4' }],
  ['aac', { kind: 'audio', mimeType: 'audio/aac' }],
  ['ogg', { kind: 'audio', mimeType: 'audio/ogg' }],
  ['oga', { kind: 'audio', mimeType: 'audio/ogg' }],
  ['opus', { kind: 'audio', mimeType: 'audio/ogg' }],
  ['flac', { kind: 'audio', mimeType: 'audio/flac' }],
  ['weba', { kind: 'audio', mimeType: 'audio/webm' }],
  ['mp4', { kind: 'video', mimeType: 'video/mp4' }],
  ['m4v', { kind: 'video', mimeType: 'video/mp4' }],
  ['webm', { kind: 'video', mimeType: 'video/webm' }],
  ['ogv', { kind: 'video', mimeType: 'video/ogg' }],
  ['mov', { kind: 'video', mimeType: 'video/quicktime' }],
  ['mkv', { kind: 'video', mimeType: 'video/x-matroska' }],
  ['avi', { kind: 'video', mimeType: 'video/x-msvideo' }],
]);

export function getMediaFileType(filePath: string): MediaFileType | undefined {
  const extension = /\.([^./\\]+)$/.exec(filePath)?.[1].toLowerCase();
  return extension ? mediaTypes.get(extension) : undefined;
}
