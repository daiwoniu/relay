export function createCodexServiceDefinition(root, endpoint) {
  return {
    id: 'codex',
    name: 'Codex',
    port: endpoint.port,
    healthUrl: endpoint.readyUrl,
    displayUrl: endpoint.wsUrl,
    command: 'codex',
    args: ['app-server', '--listen', endpoint.wsUrl],
    terminateTreeFirst: true,
    cwd: root,
  };
}

export function createBackendCodexEnvironment(endpoint) {
  return {
    CODEX_WS_URL: endpoint.wsUrl,
    CODEX_READY_URL: endpoint.readyUrl,
  };
}
