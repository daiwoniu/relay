import { z } from 'zod';
import { ANALYTICS_TOOL_IDS } from '../analytics/registry.js';

export const ToolIdSchema = z.enum(ANALYTICS_TOOL_IDS);
export const ToolsStateSchema = z.object({
  pinned: z.array(ToolIdSchema).max(ToolIdSchema.options.length),
  usage: z.record(ToolIdSchema, z.object({ count: z.number().int().min(1).max(1_000_000), lastUsed: z.number().int().nonnegative().safe() }).strict()),
}).strict();
export const ToolsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('use'), toolId: ToolIdSchema }).strict(),
  z.object({ action: z.literal('pin'), toolId: ToolIdSchema, pinned: z.boolean() }).strict(),
]);
export type ToolsState = z.infer<typeof ToolsStateSchema>;
export type ToolsAction = z.infer<typeof ToolsActionSchema>;
export const TOOLS_SCHEMA_SQL = `CREATE TABLE user_tools_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL CHECK(length(state_json)<=4096), updated_at INTEGER NOT NULL)`;
