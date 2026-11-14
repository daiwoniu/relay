export async function loginAndGetCookie(baseUrl, headers = {}) {
  const username = process.env.RELAY_VERIFY_USERNAME || 'admin';
  const password = process.env.RELAY_VERIFY_PASSWORD || 'admin';
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`认证登录失败：${response.status} ${await response.text()}`);
  const setCookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const cookie = setCookies
    .flatMap((value) => value.split(/,(?=\s*[^;,=]+=[^;,]+)/))
    .map((value) => value.trim().split(';', 1)[0])
    .find((value) => value.startsWith('relay_session='));
  if (!cookie) throw new Error('认证登录没有返回会话 Cookie');
  return cookie;
}
