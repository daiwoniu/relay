import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../components/ui/tsx-test-helper.mjs';

const stub = (path, source) => [new URL(path, import.meta.url).href, source];
const { AuthProvider, useAuth } = await loadTsxForTest(new URL('./AuthContext.tsx', import.meta.url).href, new Map([
  stub('../stores/preview-preferences.ts', 'export const usePreviewPreferences = {};'),
  stub('../analytics/tracker.ts', 'export const tracker = {reset(){},resume(){}};'),
  stub('../api/client.ts', 'export class ApiError extends Error {} export const AUTH_REQUIRED_EVENT = "auth-required";'),
  stub('../api/auth.ts', 'export async function login(username) {return {user: {id: username}};} export async function logout() {} export async function getCurrentUser() {}'),
  stub('./auth-state.ts', 'export const getInitialAuthFailureState = () => "guest"; export const getLoginErrorMessage = () => "error";'),
  stub('./authenticated-state.ts', 'export async function activateAuthenticatedClientState() {} export async function resetAuthenticatedClientState() {}'),
  stub('../theme/theme-bootstrap.ts', 'export function resetThemeBootstrapFromLocalPreference() {}'),
]));

test('设置回写同步检查当前身份，退出后短路，切换账号后使用新身份', async () => {
  let auth;
  function CaptureAuth() { auth = useAuth(); return null; }
  // SSR captures the real handlers; synchronous identity refs must not depend on a later render/effect.
  renderToStaticMarkup(React.createElement(AuthProvider, { skipInitialCheck: true }, React.createElement(CaptureAuth)));
  await auth.login('account-a', 'unused');
  let initialIdentityChecked = false;
  auth.updateUser({ get id() { initialIdentityChecked = true; return 'account-a'; } });
  assert.equal(initialIdentityChecked, true);
  await auth.logout();
  auth.updateUser({ get id() { throw new Error('logged-out updates must be ignored'); } });
  await auth.login('account-b', 'unused');
  let inspected = false;
  auth.updateUser({ get id() { inspected = true; return 'account-a'; } });
  assert.equal(inspected, true);
  auth.updateUser({ id: 'account-b' });
});
