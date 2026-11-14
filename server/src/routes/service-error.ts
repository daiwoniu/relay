import type { Context } from 'hono';
import { getServiceErrorResponse } from '../services/errors.js';
import { presentApiError } from '../contracts/index.js';

export function respondServiceError(c: Context, error: unknown): Response {
  const result = getServiceErrorResponse(error);
  return c.json(presentApiError(result.message, { code: result.code, projectInTrash: result.projectInTrash }), result.status);
}
