import type {
  ProjectUploadDeleteResponseDto,
  ProjectUploadResponseDto,
  ProjectUploadsResponseDto,
  ProjectUploadUsageDto,
} from '../generated/relay-contracts';
import { ApiError, AUTH_REQUIRED_EVENT, parseApiErrorDto, requestJson, jsonBody } from './client';

export interface UploadProjectFileOptions {
  uploadId: string;
  messageId: string;
  onProgress?: (progress: number) => void;
  createRequest?: () => XMLHttpRequest;
}

export interface UploadProjectFileTask {
  promise: Promise<ProjectUploadResponseDto>;
  abort: () => void;
}

export function uploadProjectFile(projectId: string, file: File, options: UploadProjectFileOptions): UploadProjectFileTask {
  const request = options.createRequest?.() || new XMLHttpRequest();
  const promise = new Promise<ProjectUploadResponseDto>((resolve, reject) => {
    request.open('POST', `/api/projects/${encodeURIComponent(projectId)}/uploads`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.setRequestHeader('X-Relay-Upload-Id', options.uploadId);
    request.setRequestHeader('X-Relay-Message-Id', options.messageId);
    request.setRequestHeader('X-Relay-File-Name', encodeURIComponent(file.name));
    request.setRequestHeader('X-Relay-File-Size', String(file.size));
    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      options.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    request.onerror = () => reject(new ApiError(0, null, '无法连接 Relay'));
    request.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));
    request.onload = () => {
      let payload: unknown = null;
      try { payload = JSON.parse(request.responseText); } catch {}
      if (request.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(request.status, parseApiErrorDto(payload)));
        return;
      }
      resolve(payload as ProjectUploadResponseDto);
    };
    request.send(file);
  });
  return { promise, abort: () => request.abort() };
}

export function deleteUploadDraft(projectId: string, uploadId: string): Promise<ProjectUploadDeleteResponseDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/uploads/drafts/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
}

export function getProjectUploadUsage(projectId: string): Promise<ProjectUploadUsageDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/uploads/usage`);
}

export function listProjectUploads(projectId: string): Promise<ProjectUploadsResponseDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/uploads`);
}

export function deleteProjectUpload(projectId: string, attachmentId: string): Promise<ProjectUploadDeleteResponseDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' });
}

export function deleteSelectedProjectUploads(projectId: string, attachmentIds: string[]): Promise<ProjectUploadDeleteResponseDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/uploads/delete`, {
    method: 'POST',
    ...jsonBody({ attachmentIds }),
  });
}

export function clearProjectUploads(projectId: string): Promise<ProjectUploadDeleteResponseDto> {
  return requestJson(`/api/projects/${encodeURIComponent(projectId)}/uploads`, { method: 'DELETE' });
}
