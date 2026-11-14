export type ServiceErrorStatus = 400 | 403 | 404 | 409 | 422 | 500 | 501 | 502;

export interface ProjectInTrashSummary {
  id: string;
  name: string;
  sessionCount: number;
}

export class ServiceError extends Error {
  readonly status: ServiceErrorStatus;
  readonly code?: string;
  readonly projectInTrash?: ProjectInTrashSummary;

  constructor(status: ServiceErrorStatus, message: string, code?: string, options: { projectInTrash?: ProjectInTrashSummary } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.projectInTrash = options.projectInTrash;
  }
}

export function getServiceErrorResponse(error: unknown): { status: ServiceErrorStatus; message: string; code?: string; projectInTrash?: ProjectInTrashSummary } {
  if (error instanceof ServiceError) return {
    status: error.status,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.projectInTrash ? { projectInTrash: error.projectInTrash } : {}),
  };
  return { status: 500, message: '服务器内部错误' };
}
