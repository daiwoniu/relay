import fs from 'node:fs';
import net from 'node:net';

const SERVICE_CONFIG_KEYS = [
  'CODEX_HOST',
  'CODEX_PORT',
  'BACKEND_LISTEN_HOST',
  'BACKEND_LISTEN_PORT',
  'FRONTEND_LISTEN_HOST',
  'FRONTEND_LISTEN_PORT',
];
const CONFIG_KEYS = new Set([...SERVICE_CONFIG_KEYS, 'PUBLIC_ALLOWED_ADDRESSES']);
const WILDCARD_ADDRESS = '0.0.0.0';

export function loadRelayConfig(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Relay 配置文件不存在：${filePath}`);
  return parseRelayConfig(fs.readFileSync(filePath, 'utf8'));
}

export function parseRelayConfig(content) {
  const values = new Map();
  for (const [index, rawLine] of String(content).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`Relay 配置第 ${index + 1} 行格式无效，应使用 KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    const value = unquote(line.slice(separator + 1).trim());
    if (!CONFIG_KEYS.has(key)) throw new Error(`未知配置项：${key}`);
    if (values.has(key)) throw new Error(`重复配置项：${key}`);
    values.set(key, value);
  }

  for (const key of SERVICE_CONFIG_KEYS) {
    if (!values.has(key)) throw new Error(`缺少配置项：${key}`);
  }

  const codexHost = normalizeCodexHost(values.get('CODEX_HOST'));
  const codexPort = normalizeCodexPort(values.get('CODEX_PORT'));
  const codexAuthority = net.isIP(codexHost) === 6 ? `[${codexHost}]:${codexPort}` : `${codexHost}:${codexPort}`;
  const backend = normalizeHttpEndpoint('后端', values.get('BACKEND_LISTEN_HOST'), values.get('BACKEND_LISTEN_PORT'));
  const frontend = normalizeHttpEndpoint('前端', values.get('FRONTEND_LISTEN_HOST'), values.get('FRONTEND_LISTEN_PORT'));
  const servicePorts = [codexPort, backend.port, frontend.port];
  if (new Set(servicePorts).size !== servicePorts.length) throw new Error('Codex、后端和前端监听端口不能重复');

  const rawAddresses = values.get('PUBLIC_ALLOWED_ADDRESSES') || '';
  const addressValues = rawAddresses.split(',').map((item) => item.trim()).filter(Boolean);
  const wildcard = addressValues.includes(WILDCARD_ADDRESS);
  if (wildcard && addressValues.length > 1) throw new Error('0.0.0.0 不能与其他地址混用');
  const addresses = wildcard ? [] : deduplicateAddresses(addressValues.map(normalizeAddress));

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

function unquote(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) return value.slice(1, -1);
  return value;
}

function normalizeCodexHost(value) {
  const host = String(value || '').trim().toLowerCase();
  const version = net.isIP(host);
  const loopback = version === 4 ? /^127\./.test(host) : version === 6 && ['::1', '0:0:0:0:0:0:0:1'].includes(host);
  if (!loopback) throw new Error(`Codex IP 必须是回环地址：${host || '(空)'}`);
  return host;
}

function normalizeCodexPort(value) {
  const raw = String(value || '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`Codex 端口无效：${raw || '(空)'}`);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Codex 端口无效：${raw}`);
  return port;
}

function normalizeHttpEndpoint(name, hostValue, portValue) {
  const listenHost = String(hostValue || '').trim().toLowerCase();
  const ipVersion = net.isIP(listenHost);
  if (!ipVersion) throw new Error(`${name}监听 IP 无效：${listenHost || '(空)'}`);
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
  if (!/^\d+$/.test(raw)) throw new Error(`${name}监听端口无效：${raw || '(空)'}`);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name}监听端口无效：${raw}`);
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
  if (!raw || raw.includes('://') || /[\s/?#@*]/.test(raw)) throw new Error(`公网地址格式无效：${raw || '(空)'}`);

  let url;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    throw new Error(`公网地址格式无效：${raw}`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new Error(`公网地址格式无效：${raw}`);
  }
  const port = url.port ? Number.parseInt(url.port, 10) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`公网地址端口无效：${raw}`);
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
