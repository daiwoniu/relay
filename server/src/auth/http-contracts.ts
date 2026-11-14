import { isIP } from 'node:net';
import { z } from 'zod';
import { ACCEPTANCE_SESSION_TTL_MS, SESSION_TTL_MS } from './session.js';

const newPassword = z.string().min(6).max(50);
const currentPassword = z.string().min(1).max(256);
const username = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, '账号只能包含字母、数字、点、下划线和连字符');
export const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: currentPassword,
  purpose: z.literal('headless_acceptance').optional() }).strict();
export const profilePatchSchema = z.object({ displayName: z.string().trim().max(40) }).strict();
export const changePasswordSchema = z.object({ currentPassword, newPassword }).strict();
export const changeUsernameSchema = z.object({ username, currentPassword }).strict();
export const adminResetPasswordSchema = z.object({ currentPassword, newPassword }).strict();
export const createMemberSchema = z.object({ username, initialPassword: newPassword, displayName: z.string().trim().max(40).optional(),
  canCreateProject: z.boolean().default(true), projectIds: z.array(z.string().uuid()).max(100).default([]) }).strict();
export const userDisabledPatchSchema = z.object({ disabled: z.boolean() }).strict();
export const userProjectPermissionPatchSchema = z.object({ canCreateProject: z.boolean() }).strict();
export const defaultProjectPatchSchema = z.object({ projectId: z.string().uuid() }).strict();
export const defaultEnginePatchSchema = z.object({ engine: z.enum(['codex', 'codebuddy', 'opencode', 'zcode']) }).strict();
export const defaultModelPatchSchema = z.object({ modelId: z.string().trim().min(1).max(200).nullable() }).strict();

export type LoginSessionPolicyInput = { purpose?: 'headless_acceptance'; marker?: string; remoteAddress?: string;
  proxiedClientAddress?: string; forwardedHost?: string; forwardedProto?: string };
function isLoopbackAddress(value?: string) {
  const address = value?.trim().toLowerCase().replace(/^\[|\]$/gu, '') || '';
  if (isIP(address) === 4) return address.startsWith('127.');
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  const mapped = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : '';
  return isIP(mapped) === 4 && mapped.startsWith('127.');
}
export function resolveLoginSessionPolicy(input: LoginSessionPolicyInput): { ttlMs: number; requiredRole?: 'admin' } | null {
  if (!input.purpose) return { ttlMs: SESSION_TTL_MS };
  if (input.marker !== 'headless-v1' || !isLoopbackAddress(input.remoteAddress)) return null;
  if (input.proxiedClientAddress && !isLoopbackAddress(input.proxiedClientAddress)) return null;
  if (input.forwardedHost?.trim() || input.forwardedProto?.trim()) return null;
  return { ttlMs: ACCEPTANCE_SESSION_TTL_MS, requiredRole: 'admin' };
}
