import { getDB } from '../db/index.js';
import { projectSessionCard, type SessionCardProjection } from './session-projection.js';

export class AssociationService {
  listWorkspaceSessions(workspacePath: string): SessionCardProjection[] {
    return getDB().all(
      `SELECT s.id AS session_id, s.title, s.status, s.updated_at, s.engine,
         COALESCE(s.selected_model_id, CASE WHEN s.engine = u.default_engine THEN u.default_model_id END) AS selected_model_id,
         p.path AS project_path,
         (SELECT COALESCE(m.content, '') FROM messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1) AS latest_message
       FROM sessions s JOIN projects p ON p.id = s.project_id LEFT JOIN users u ON u.id = s.owner_user_id
       WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.path = ?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)
       ORDER BY s.updated_at DESC`,
      [workspacePath],
    ).map((row) => projectSessionCard({
      sessionId: String(row.session_id), title: String(row.title ?? ''), projectPath: String(row.project_path),
      updatedAt: Number(row.updated_at ?? 0), status: String(row.status ?? 'unknown'),
      url: `/?session=${encodeURIComponent(String(row.session_id))}`,
      engine: typeof row.engine === 'string' ? row.engine : null,
      modelId: typeof row.selected_model_id === 'string' ? row.selected_model_id : null,
      latestMessage: typeof row.latest_message === 'string' ? row.latest_message : null,
    }));
  }
}
