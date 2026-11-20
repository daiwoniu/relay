import { loadFeishuConfig } from '../integrations/feishu/config.js';
export { WORKSPACE_ID } from './workspace-config.js';
// Identity metadata only; never send credentials through storage commands or contracts.
export const WORKSPACE_CONNECTION_SCOPE = (() => { try { return loadFeishuConfig()?.scope ?? ''; } catch { return ''; } })();
