import type {
  ApprovalTrustDuration,
  ApprovalTrustStateDto,
  PutSessionApprovalTrustRequest,
} from '../generated/relay-contracts.ts';
import { jsonBody, parseApiResponse, requestJson } from './client.ts';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApprovalTrustRequestOptions {
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

async function requestApprovalTrust(
  path: string,
  init: RequestInit,
  options: ApprovalTrustRequestOptions,
): Promise<ApprovalTrustStateDto> {
  if (!options.fetchImpl) {
    return requestJson<ApprovalTrustStateDto>(path, { ...init, signal: options.signal });
  }
  const response = await options.fetchImpl(path, {
    credentials: 'same-origin',
    ...init,
    signal: options.signal,
  });
  return parseApiResponse<ApprovalTrustStateDto>(response);
}

function approvalTrustPath(scope: 'project' | 'session', id: string): string {
  const collection = scope === 'project' ? 'projects' : 'sessions';
  return `/api/${collection}/${encodeURIComponent(id)}/approval-trust`;
}

export function getProjectApprovalTrust(
  projectId: string,
  options: ApprovalTrustRequestOptions = {},
): Promise<ApprovalTrustStateDto> {
  return requestApprovalTrust(approvalTrustPath('project', projectId), {}, options);
}

export function putProjectApprovalTrust(
  projectId: string,
  duration: ApprovalTrustDuration,
  options: ApprovalTrustRequestOptions = {},
): Promise<ApprovalTrustStateDto> {
  return requestApprovalTrust(approvalTrustPath('project', projectId), {
    method: 'PUT',
    ...jsonBody({ duration }),
  }, options);
}

export function clearProjectApprovalTrust(
  projectId: string,
  options: ApprovalTrustRequestOptions = {},
): Promise<ApprovalTrustStateDto> {
  return requestApprovalTrust(approvalTrustPath('project', projectId), { method: 'DELETE' }, options);
}

export function getSessionApprovalTrust(
  sessionId: string,
  options: ApprovalTrustRequestOptions = {},
): Promise<ApprovalTrustStateDto> {
  return requestApprovalTrust(approvalTrustPath('session', sessionId), {}, options);
}

export function putSessionApprovalTrust(
  sessionId: string,
  setting: PutSessionApprovalTrustRequest,
  options: ApprovalTrustRequestOptions = {},
): Promise<ApprovalTrustStateDto> {
  return requestApprovalTrust(approvalTrustPath('session', sessionId), {
    method: 'PUT',
    ...jsonBody(setting),
  }, options);
}

export function clearSessionApprovalTrust(
  sessionId: string,
  options: ApprovalTrustRequestOptions = {},
): Promise<ApprovalTrustStateDto> {
  return requestApprovalTrust(approvalTrustPath('session', sessionId), { method: 'DELETE' }, options);
}
