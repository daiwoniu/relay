import { ApiErrorDtoSchema,ApprovalTrustStateDtoSchema, type ApiErrorDto } from './dto.js';
import type { ApprovalTrustState } from '../services/approval-trust.js';

export function presentApprovalTrustState(state:ApprovalTrustState){
  const setting=(value:ApprovalTrustState['projectSetting'])=>value?{scope:value.projectId?'project' as const:'session' as const,
    mode:value.mode,expiresAt:value.expiresAt,createdAt:value.createdAt,updatedAt:value.updatedAt}:null;
  return ApprovalTrustStateDtoSchema.parse({projectSetting:setting(state.projectSetting),sessionSetting:setting(state.sessionSetting),effective:state.effective});
}

export function presentApiError(
  error: string,
  options: { code?: unknown; canForceAccess?: unknown; [key: string]: unknown } = {},
): ApiErrorDto {
  const message = error.trim();
  if (!message) throw new Error('错误消息不能为空');
  return ApiErrorDtoSchema.parse({
    error: message,
    ...(typeof options.code === 'string' ? { code: options.code } : {}),
    ...(typeof options.canForceAccess === 'boolean' ? { canForceAccess: options.canForceAccess } : {}),
    ...(options.projectInTrash && typeof options.projectInTrash === 'object' ? { projectInTrash: options.projectInTrash } : {}),
  });
}
