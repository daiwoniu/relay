import { ApiError } from '../../api/client';
import { listProjects } from '../../api/projects';
import { getSession, listSessions } from '../../api/sessions';
import type { StoredChatLocation } from '../../stores/chat-location';
import { mergeUrlSessionIntoNavigationSessions } from '../../stores/chat-location';

type UrlSessionLocation = Extract<StoredChatLocation, { kind: 'session' }>;

export async function loadSidebarNavigation(
  signal: AbortSignal,
  urlSessionLocation: UrlSessionLocation | null,
) {
  const urlSessionRequest = urlSessionLocation
    ? getSession(urlSessionLocation.sessionId, { signal }).catch((error) => {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    })
    : Promise.resolve(null);
  const [sessions, projects, urlSession] = await Promise.all([
    listSessions(signal),
    listProjects(signal),
    urlSessionRequest,
  ]);
  return {
    sessions: mergeUrlSessionIntoNavigationSessions(sessions, urlSession),
    projects,
  };
}
