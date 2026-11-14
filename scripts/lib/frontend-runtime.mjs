import path from 'node:path';
import { getFrontendBuildLabel, getFrontendBuildPaths, getFrontendBuildStatus, isCompleteFrontendRelease, readFrontendBuildState } from './frontend-build.mjs';

export function parseFrontendRuntimeArguments(rawArgs) {
  const args = new Set(rawArgs.filter((argument) => !['help', '--help'].includes(argument)));
  const development = args.has('--dev');
  const lan = args.has('--lan');
  if (lan && !development) throw new Error('--lan 只能与 --dev 一起使用');
  return { mode: development ? 'development' : 'production', lan };
}

export function getRunningProductionBuildId(status) {
  return status?.mode === 'production'
    && typeof status.buildId === 'string'
    && /^[a-f0-9]{8,16}$/.test(status.buildId)
    ? status.buildId
    : null;
}

export function createFrontendService(root, options) {
  const frontend = options.frontendEndpoint;
  const backend = options.backendEndpoint;
  if (!frontend || !backend) throw new Error('前端服务缺少统一监听配置');
  if (options.mode === 'development') {
    const vitePath = path.join(root, 'client', 'node_modules', 'vite', 'bin', 'vite.js');
    return {
      id: 'frontend',
      name: 'Vite 前端',
      port: frontend.port,
      healthUrl: `${frontend.origin}/__relay/frontend-status`,
      displayUrl: frontend.origin,
      command: 'node',
      args: [vitePath, '--host', options.lan ? '0.0.0.0' : frontend.listenHost, '--port', String(frontend.port)],
      cwd: path.join(root, 'client'),
      env: { RELAY_DEV_LAN: options.lan ? '1' : '0' },
      requiredPaths: options.clientRuntimePrerequisites || [],
    };
  }
  if (!options.buildId || !options.releaseDir) throw new Error('正式前端服务缺少活动构建');
  const buildState = readFrontendBuildState(getFrontendBuildPaths(root).state);
  const buildLabel = options.buildLabel || getFrontendBuildLabel(buildState, options.buildId);
  return {
    id: 'frontend',
    name: '正式前端网关',
    port: frontend.port,
    healthUrl: `${frontend.origin}/__relay/frontend-status`,
    displayUrl: frontend.origin,
    command: 'node',
    args: ['--import', 'tsx', 'src/frontend-gateway.ts'],
    cwd: path.join(root, 'server'),
    env: {
      RELAY_FRONTEND_RELEASE_DIR: options.releaseDir,
      RELAY_FRONTEND_BUILD_ID: options.buildId,
      ...(buildLabel ? { RELAY_FRONTEND_BUILD_LABEL: buildLabel } : {}),
      RELAY_TOKEN_FILE: path.join(root, 'server', 'data', 'access-token'),
      RELAY_SERVER_URL: backend.origin,
    },
    requiredPaths: [
      ...(options.serverRuntimePrerequisite ? [options.serverRuntimePrerequisite] : []),
      path.join(root, 'server', 'src', 'frontend-gateway.ts'),
      path.join(options.releaseDir, 'index.html'),
    ],
  };
}

export function getActiveFrontendRelease(root) {
  const paths = getFrontendBuildPaths(root);
  const state = readFrontendBuildState(paths.state);
  if (!state.activeBuildId) return null;
  const releaseDir = path.join(paths.releases, state.activeBuildId);
  if (!isCompleteFrontendRelease(releaseDir)) return null;
  return { buildId: state.activeBuildId, buildLabel: getFrontendBuildLabel(state, state.activeBuildId), releaseDir };
}

export function getLauncherRuntimeStatus(root, mode) {
  if (mode === 'development') {
    return { frontendMode: 'development', activeBuildId: null, activeBuildLabel: null, frontendBuildRequired: false, frontendBuildReason: null };
  }
  const status = getFrontendBuildStatus(root);
  return {
    frontendMode: 'production',
    activeBuildId: status.activeBuildId,
    activeBuildLabel: status.activeBuildLabel,
    frontendBuildRequired: !status.fresh,
    frontendBuildReason: status.reason,
  };
}
