import net from 'node:net';
import { normalizeClientIp } from './client-ip.mjs';
import { loadKvConfig, parseKvConfig } from './kv-config.mjs';

const SERVICE_CONFIG_KEYS = [
  'CODEX_HOST',
  'CODEX_PORT',
  'BACKEND_LISTEN_HOST',
  'BACKEND_LISTEN_PORT',
  'FRONTEND_LISTEN_HOST',
  'FRONTEND_LISTEN_PORT',
];
const CONFIG_KEYS = new Set([...SERVICE_CONFIG_KEYS, 'PUBLIC_ALLOWED_ADDRESSES', 'TRUSTED_PROXY_IPS']);
const WILDCARD_ADDRESS = '0.0.0.0';

export function loadRelayConfig(filePath) {
  const { values, sources } = loadKvConfig(filePath, { allowedKeys: CONFIG_KEYS, required: true });
  return normalizeRelayConfig(values, sources, filePath);
}

export function parseRelayConfig(content) {
  return normalizeRelayConfig(parseKvConfig(content, { allowedKeys: CONFIG_KEYS, source: 'Relay 配置' }));
}

function normalizeRelayConfig(values, sources = new Map(), source = 'Relay 配置') {
  const check = (keys, validate) => {
    try { return validate(); }
    catch (error) {
      const context = keys.map(key => `${sources.get(key) || source} [${key}]`).join(', ');
      throw new Error(`${context}：${error.message}`);
    }
  };
  for (const key of SERVICE_CONFIG_KEYS) {
    if (!values.has(key)) throw new Error(`${source}：缺少配置项：${key}`);
  }

  const codexHost = check(['CODEX_HOST'], () => normalizeCodexHost(values.get('CODEX_HOST')));
  const codexPort = check(['CODEX_PORT'], () => normalizeCodexPort(values.get('CODEX_PORT')));
  const codexAuthority = net.isIP(codexHost) === 6 ? `[${codexHost}]:${codexPort}` : `${codexHost}:${codexPort}`;
  const backend = check(['BACKEND_LISTEN_HOST', 'BACKEND_LISTEN_PORT'], () => normalizeHttpEndpoint('后端', values.get('BACKEND_LISTEN_HOST'), values.get('BACKEND_LISTEN_PORT')));
  const frontend = check(['FRONTEND_LISTEN_HOST', 'FRONTEND_LISTEN_PORT'], () => normalizeHttpEndpoint('前端', values.get('FRONTEND_LISTEN_HOST'), values.get('FRONTEND_LISTEN_PORT')));
  const servicePorts = [codexPort, backend.port, frontend.port];
  check(['CODEX_PORT', 'BACKEND_LISTEN_PORT', 'FRONTEND_LISTEN_PORT'], () => {
    if (new Set(servicePorts).size !== servicePorts.length) throw new Error('Codex、后端和前端监听端口不能重复');
  });

  const rawAddresses = values.get('PUBLIC_ALLOWED_ADDRESSES') || '';
  const addressValues = rawAddresses.split(',').map((item) => item.trim()).filter(Boolean);
  const wildcard = addressValues.includes(WILDCARD_ADDRESS);
  const addresses = check(['PUBLIC_ALLOWED_ADDRESSES'], () => {
    if (wildcard && addressValues.length > 1) throw new Error('0.0.0.0 不能与其他地址混用');
    return wildcard ? [] : deduplicateAddresses(addressValues.map(normalizeAddress));
  });
  const trustedProxyIps = check(['TRUSTED_PROXY_IPS'], () => [...new Set((values.get('TRUSTED_PROXY_IPS') || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    const ip = normalizeClientIp(value);
    if (!ip || ip === '0.0.0.0' || ip === '::') throw new Error('TRUSTED_PROXY_IPS 必须是明确的代理 IP，不支持通配地址、域名或网段');
    return ip;
  }))]);
  check(['TRUSTED_PROXY_IPS', 'PUBLIC_ALLOWED_ADDRESSES'], () => {
    if (trustedProxyIps.length && wildcard) throw new Error('TRUSTED_PROXY_IPS 要求 PUBLIC_ALLOWED_ADDRESSES 使用精确地址，不能使用通配模式');
  });

  return {
    codex: {
      host: codexHost,
      port: codexPort,
      authority: codexAuthority,
      wsUrl: `ws://${codexAuthority}`,
      readyUrl: `http://${codexAuthority}/readyz`,
    },
    backend,
    frontend,
    trustedProxyIps,
    publicAccess: {
      enabled: wildcard || addresses.length > 0,
      wildcard,
      addresses,
    },
  };
}

export function getRelayServicePorts(config) {
  return [config.codex.port, config.backend.port, config.frontend.port];
}

export function getRelayServiceTargets(config) {
  return [
    { host: config.codex.host, port: config.codex.port },
    { host: config.backend.connectHost, port: config.backend.port },
    { host: config.frontend.connectHost, port: config.frontend.port },
  ];
}

export function isLocalOrPrivateHost(hostHeader) {
  const address = tryNormalizeAddress(hostHeader);
  if (!address) return false;
  const hostname = stripIpv6Brackets(address.hostname);
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || /^(?:fc|fd)[0-9a-f]{2}:/i.test(hostname);
}

export function isConfiguredPublicHost(hostHeader, config) {
  if (!config?.publicAccess?.enabled) return false;
  if (config.publicAccess.wildcard) return Boolean(tryNormalizeAddress(hostHeader));
  const address = tryNormalizeAddress(hostHeader);
  return Boolean(address && config.publicAccess.addresses.some((allowed) => allowed.authority === address.authority));
}

export function isAllowedRequestHost(hostHeader, config) {
  return isLocalOrPrivateHost(hostHeader) || isConfiguredPublicHost(hostHeader, config);
}

export function isPublicOriginAllowed(origin, config) {
  if (!config?.publicAccess?.enabled || !origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
    if (config.publicAccess.wildcard) return true;
    return config.publicAccess.addresses.some((allowed) => allowed.origin === url.origin.toLowerCase());
  } catch {
    return false;
  }
}

export function getViteAllowedHosts(config) {
  if (config.publicAccess.wildcard) return true;
  return [...new Set(config.publicAccess.addresses.map((address) => stripIpv6Brackets(address.hostname)))];
}

export function formatPublicAccessStatus(config) {
  if (!config.publicAccess.enabled) return ['公网访问：未启用'];
  if (config.publicAccess.wildcard) {
    return [
      '公网访问：允许任意公网地址',
      '  警告：PUBLIC_ALLOWED_ADDRESSES=0.0.0.0 会关闭公网 Host 限制',
    ];
  }
  return ['公网访问：已启用', ...config.publicAccess.addresses.map((address) => `  ${address.origin}`)];
}

function normalizeCodexHost(value) {
  const host = String(value || '').trim().toLowerCase();
  const version = net.isIP(host);
  const loopback = version === 4 ? /^127\./.test(host) : version === 6 && ['::1', '0:0:0:0:0:0:0:1'].includes(host);
  if (!loopback) throw new Error('Codex IP 必须是回环地址');
  return host;
}

function normalizeCodexPort(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) throw new Error('Codex 端口无效');
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Codex 端口无效');
  return port;
}

function normalizeHttpEndpoint(name, hostValue, portValue) {
  const listenHost = String(hostValue || '').trim().toLowerCase();
  const ipVersion = net.isIP(listenHost);
  if (!ipVersion) throw new Error(`${name}监听 IP 无效`);
  const port = normalizeServicePort(name, portValue);
  const connectHost = listenHost === '0.0.0.0' ? '127.0.0.1' : isUnspecifiedIpv6(listenHost) ? '::1' : listenHost;
  const listenAuthority = formatAuthority(listenHost, port);
  const authority = formatAuthority(connectHost, port);
  return {
    listenHost,
    port,
    listenAuthority,
    connectHost,
    authority,
    origin: `http://${authority}`,
  };
}

function normalizeServicePort(name, value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name}监听端口无效`);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name}监听端口无效`);
  return port;
}

function formatAuthority(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function isUnspecifiedIpv6(host) {
  return host === '::' || host === '0:0:0:0:0:0:0:0';
}

function deduplicateAddresses(addresses) {
  const seen = new Set();
  return addresses.filter((address) => {
    if (seen.has(address.authority)) return false;
    seen.add(address.authority);
    return true;
  });
}

function tryNormalizeAddress(value) {
  try {
    return normalizeAddress(value);
  } catch {
    return null;
  }
}

function normalizeAddress(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.includes('://') || /[\s/?#@*]/.test(raw)) throw new Error('公网地址格式无效');

  let url;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    throw new Error('公网地址格式无效');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new Error('公网地址格式无效');
  }
  const port = url.port ? Number.parseInt(url.port, 10) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('公网地址端口无效');
  const hostname = url.hostname.toLowerCase();
  const authority = port === 443 ? hostname : `${hostname}:${port}`;
  return {
    hostname,
    port,
    authority,
    origin: port === 443 ? `https://${hostname}` : `https://${hostname}:${port}`,
  };
}

function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}
