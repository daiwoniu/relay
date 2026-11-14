import { MAX_THEME_ASSET_BYTES } from './theme/theme-assets.js';
import { MAX_UPLOAD_FILE_BYTES } from './uploads/project-uploads.js';

export const DEFAULT_API_REQUEST_BODY_LIMIT = 2 * 1024 * 1024;
export const THEME_ASSET_REQUEST_BODY_LIMIT = (MAX_THEME_ASSET_BYTES * 2) + (256 * 1024);
export const PROJECT_UPLOAD_REQUEST_BODY_LIMIT = MAX_UPLOAD_FILE_BYTES + (64 * 1024);

export function getApiRequestBodyLimit(method: string, path: string): number {
  if (method.toUpperCase() !== 'POST') return DEFAULT_API_REQUEST_BODY_LIMIT;
  if (path === '/api/auth/theme-assets') return THEME_ASSET_REQUEST_BODY_LIMIT;
  if (/^\/api\/projects\/[0-9a-f-]{36}\/uploads$/i.test(path)) return PROJECT_UPLOAD_REQUEST_BODY_LIMIT;
  return DEFAULT_API_REQUEST_BODY_LIMIT;
}
