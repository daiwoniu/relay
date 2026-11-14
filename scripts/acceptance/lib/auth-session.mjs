export function extractRelaySession(setCookies) {
  if (!Array.isArray(setCookies)) throw new Error('登录响应没有有效 relay_session Cookie');
  for (const header of setCookies) {
    if (typeof header !== 'string' || /[\r\n\0]/u.test(header)) continue;
    const match = /^\s*relay_session=([^;]*)/u.exec(header);
    if (!match) continue;
    let value;
    try {
      value = decodeURIComponent(match[1]);
    } catch {
      continue;
    }
    if (value && value.length <= 4096 && !/[\s;,\0]/u.test(value)) return { name: 'relay_session', value };
  }
  throw new Error('登录响应没有有效 relay_session Cookie');
}

export async function loginAndStoreSession({
  config,
  password,
  expectedOrigin = config?.origin,
  fetchImpl = fetch,
  protect,
  writeSession,
  writeConfig,
  now = Date.now,
}) {
  if (config?.origin !== expectedOrigin) throw new Error('验收目标与配置 origin 不一致');
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) throw new Error('密码长度无效');
  const loginResponse = await safeFetch(fetchImpl, `${config.origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Relay-Acceptance': 'headless-v1' },
    body: JSON.stringify({ username: config.username, password, purpose: 'headless_acceptance' }),
    redirect: 'error',
  }, '认证登录失败');
  if (!loginResponse.ok) throw new Error(`认证登录失败：${loginResponse.status}`);

  const cookie = extractRelaySession(readSetCookies(loginResponse.headers));
  const loginBody = await safeJson(loginResponse, '认证登录响应无效');
  const expiresAtMs = Number(loginBody?.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) throw new Error('认证登录响应缺少有效过期时间');

  const meResponse = await safeFetch(fetchImpl, `${config.origin}/api/auth/me`, {
    method: 'GET',
    headers: { Accept: 'application/json', Cookie: `${cookie.name}=${cookie.value}` },
    redirect: 'error',
  }, '认证自检失败');
  if (!meResponse.ok) throw new Error(`认证自检失败：${meResponse.status}`);
  const meBody = await safeJson(meResponse, '认证自检响应无效');
  if (!meBody?.user || typeof meBody.user.username !== 'string') throw new Error('认证自检响应无效');

  let encrypted;
  try {
    encrypted = await protect(cookie.value);
  } catch {
    throw new Error('DPAPI 加密失败');
  }
  if (typeof encrypted !== 'string' || encrypted.length === 0) throw new Error('DPAPI 加密失败');

  const storedConfig = {
    ...config,
    username: meBody.user.username,
    createdAt: new Date(now()).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  await writeSession(encrypted);
  await writeConfig(storedConfig);
  return { username: storedConfig.username, expiresAt: storedConfig.expiresAt };
}

export async function loadAndVerifySession({
  config,
  readSession,
  unprotect,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const expiresAtMs = Date.parse(config?.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) throw new Error('验收认证已过期，请重新运行 acceptance:auth');
  const encrypted = await readSession();
  let cookieValue;
  try {
    cookieValue = await unprotect(encrypted);
  } catch {
    throw new Error('DPAPI 解密失败，请重新运行 acceptance:auth');
  }
  if (typeof cookieValue !== 'string' || !cookieValue || /[\s;,\0]/u.test(cookieValue)) {
    throw new Error('DPAPI 解密失败，请重新运行 acceptance:auth');
  }
  const response = await safeFetch(fetchImpl, `${config.origin}/api/auth/me`, {
    method: 'GET',
    headers: { Accept: 'application/json', Cookie: `relay_session=${cookieValue}` },
    redirect: 'error',
  }, '认证自检失败');
  if (!response.ok) throw new Error(`认证自检失败：${response.status}`);
  const body = await safeJson(response, '认证自检响应无效');
  if (!body?.user || typeof body.user.username !== 'string') throw new Error('认证自检响应无效');
  return { cookieValue, user: body.user, expiresAt: config.expiresAt };
}

function readSetCookies(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers?.get?.('set-cookie');
  return value ? [value] : [];
}

async function safeFetch(fetchImpl, url, options, label) {
  try {
    return await fetchImpl(url, options);
  } catch {
    throw new Error(`${label}：网络请求失败`);
  }
}

async function safeJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(label);
  }
}
