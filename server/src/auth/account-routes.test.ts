import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

test('账号资料、头像、改密与管理员重置形成完整认证闭环', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-account-routes-'));
  process.env.RELAY_DB_PATH = path.join(directory, 'relay.db');
  process.env.RELAY_ROOT = directory;
  try {
    const [{ initDB }, authModule, service, queries, password, defaultSystem] = await Promise.all([
      import('../db/index.js'),
      import('../routes/auth.js'),
      import('./service.js'),
      import('../db/queries.js'),
      import('./password.js'),
      import('../engine/default-system.js'),
    ]);
    await initDB();
    const admin = service.ensureDefaultAdmin(undefined, { username: 'admin', password: 'admin-password' });
    const member = queries.createUser('member', password.hashPassword('member-password'), 'member');
    const adminLogin = service.loginWithPassword('admin', 'admin-password');
    const otherAdminLogin = service.loginWithPassword('admin', 'admin-password');
    const memberLogin = service.loginWithPassword('member', 'member-password');
    assert.ok(adminLogin && otherAdminLogin && memberLogin);
    const app = new Hono().route('/api/auth', authModule.default);
    const adminCookie = `relay_session=${adminLogin.token}`;
    const memberCookie = `relay_session=${memberLogin.token}`;

    const themeResponse = await app.request('/api/auth/theme-settings', { headers: { cookie: adminCookie } });
    assert.equal(themeResponse.status, 200);
    const defaultTheme = (await themeResponse.json()).settings;
    assert.equal(defaultTheme.version, 2);
    assert.equal(defaultTheme.basePreference, 'system');
    assert.equal(defaultTheme.colorStyle, 'neutral');
    assert.equal(defaultTheme.textScale, 'standard');
    const savedThemeResponse = await app.request('/api/auth/theme-settings', {
      method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({
        ...defaultTheme,
        linkedProfiles: false,
        desktop: { ...defaultTheme.desktop, backgroundKind: 'preset', backgroundValue: 'mist', panelOpacity: 0.84 },
      }),
    });
    assert.equal(savedThemeResponse.status, 200);
    assert.equal((await savedThemeResponse.json()).settings.desktop.backgroundValue, 'mist');

    const colorfulThemeResponse = await app.request('/api/auth/theme-settings', {
      method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({
        ...defaultTheme,
        colorStyle: 'aurora',
        textScale: 'large',
      }),
    });
    assert.equal(colorfulThemeResponse.status, 200);
    const colorfulTheme = (await colorfulThemeResponse.json()).settings;
    const { colorStyle: _colorStyle, textScale: _textScale, ...legacyTheme } = colorfulTheme;
    const legacyThemeResponse = await app.request('/api/auth/theme-settings', {
      method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({
        ...legacyTheme,
        version: 1,
        basePreference: 'dark',
      }),
    });
    assert.equal(legacyThemeResponse.status, 200);
    const legacySavedTheme = (await legacyThemeResponse.json()).settings;
    assert.equal(legacySavedTheme.version, 2);
    assert.equal(legacySavedTheme.basePreference, 'dark');
    assert.equal(legacySavedTheme.colorStyle, 'aurora');
    assert.equal(legacySavedTheme.textScale, 'large');

    const webp = new Uint8Array(48);
    webp.set(Buffer.from('RIFF'), 0);
    new DataView(webp.buffer).setUint32(4, webp.length - 8, true);
    webp.set(Buffer.from('WEBP'), 8);
    webp.set(Buffer.from('VP8X'), 12);
    new DataView(webp.buffer).setUint32(16, 10, true);
    webp.set([0xff, 0x03, 0], 24);
    webp.set([0xff, 0x03, 0], 27);
    webp.set(Buffer.from('VP8 '), 30);
    new DataView(webp.buffer).setUint32(34, 10, true);
    webp.set([0, 0, 0, 0x9d, 0x01, 0x2a, 0x00, 0x04, 0x00, 0x04], 38);
    const assetBody = new FormData();
    assetBody.append('desktop', new File([webp], 'desktop.webp', { type: 'image/webp' }));
    assetBody.append('mobile', new File([webp], 'mobile.webp', { type: 'image/webp' }));
    const assetResponse = await app.request('/api/auth/theme-assets', { method: 'POST', headers: { cookie: adminCookie }, body: assetBody });
    assert.equal(assetResponse.status, 201);
    const { assetId } = await assetResponse.json();
    const readAssetResponse = await app.request(`/api/auth/theme-assets/${assetId}/desktop`, { headers: { cookie: adminCookie } });
    assert.equal(readAssetResponse.status, 200);
    assert.equal(readAssetResponse.headers.get('content-type'), 'image/webp');
    assert.equal(readAssetResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal((await app.request(`/api/auth/theme-assets/${assetId}/desktop`, { headers: { cookie: memberCookie } })).status, 404);

    const assetTheme = { ...defaultTheme, desktop: { ...defaultTheme.desktop, backgroundKind: 'asset', backgroundValue: assetId }, mobile: { ...defaultTheme.mobile, backgroundKind: 'asset', backgroundValue: assetId } };
    assert.equal((await app.request('/api/auth/theme-settings', { method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify(assetTheme) })).status, 200);
    assert.equal((await app.request(`/api/auth/theme-assets/${assetId}`, { method: 'DELETE', headers: { cookie: adminCookie } })).status, 409);
    assert.equal((await app.request('/api/auth/theme-settings', { method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify(defaultTheme) })).status, 200);
    assert.equal((await app.request(`/api/auth/theme-assets/${assetId}/desktop`, { headers: { cookie: adminCookie } })).status, 404);

    const profileResponse = await app.request('/api/auth/profile', {
      method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'Relay 管理员' }),
    });
    assert.equal(profileResponse.status, 200);
    assert.equal((await profileResponse.json()).user.displayName, 'Relay 管理员');

    const usernameOriginResponse = await app.request('/api/auth/change-username', {
      method: 'POST', headers: { cookie: adminCookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'relay-admin', currentPassword: 'admin-password' }),
    });
    assert.equal(usernameOriginResponse.status, 403);
    const usernamePasswordResponse = await app.request('/api/auth/change-username', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'relay-admin', currentPassword: 'wrong-password' }),
    });
    assert.equal(usernamePasswordResponse.status, 403);
    const usernameConflictResponse = await app.request('/api/auth/change-username', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'MEMBER', currentPassword: 'admin-password' }),
    });
    assert.equal(usernameConflictResponse.status, 409);
    const usernameResponse = await app.request('/api/auth/change-username', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'relay-admin', currentPassword: 'admin-password' }),
    });
    assert.equal(usernameResponse.status, 200);
    assert.equal((await usernameResponse.json()).user.username, 'relay-admin');
    assert.equal(service.authenticateSessionToken(adminLogin.token)?.username, 'relay-admin');
    assert.equal(service.authenticateSessionToken(otherAdminLogin.token), null);
    assert.equal(service.loginWithPassword('admin', 'admin-password'), null);
    assert.ok(service.loginWithPassword('relay-admin', 'admin-password'));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const limitedResponse = await app.request('/api/auth/change-username', {
        method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'another-name', currentPassword: 'wrong-password' }),
      });
      assert.equal(limitedResponse.status, attempt < 5 ? 403 : 429);
      if (attempt === 5) assert.ok(Number(limitedResponse.headers.get('retry-after')) > 0);
    }

    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const avatarResponse = await app.request('/api/auth/avatar', { method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'image/png' }, body: png });
    assert.equal(avatarResponse.status, 200);
    const avatarUser = (await avatarResponse.json()).user;
    assert.equal(typeof avatarUser.avatarUpdatedAt, 'number');
    const readAvatarResponse = await app.request(`/api/auth/users/${admin.id}/avatar`, { headers: { cookie: adminCookie } });
    assert.equal(readAvatarResponse.status, 200);
    assert.equal(readAvatarResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await readAvatarResponse.arrayBuffer()), png);

    const memberListResponse = await app.request('/api/auth/users', { headers: { cookie: memberCookie } });
    assert.equal(memberListResponse.status, 403);
    const adminListResponse = await app.request('/api/auth/users', { headers: { cookie: adminCookie } });
    assert.equal(adminListResponse.status, 200);
    assert.equal((await adminListResponse.json()).users.length, 2);

    const roleInjectionResponse = await app.request('/api/auth/users', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'intruder', initialPassword: 'temporary-password', role: 'admin' }),
    });
    assert.equal(roleInjectionResponse.status, 400);
    assert.equal((await app.request('/api/auth/users', {
      method: 'POST', headers: { cookie: adminCookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'cross-site', initialPassword: 'temporary-password' }),
    })).status, 403);
    const memberCreateResponse = await app.request('/api/auth/users', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'new-member', initialPassword: 'temporary-password', displayName: '新成员' }),
    });
    assert.equal(memberCreateResponse.status, 201);
    const createdUser = (await memberCreateResponse.json()).user;
    assert.equal(createdUser.role, 'member');
    assert.equal(createdUser.mustChangePassword, true);
    assert.equal(typeof createdUser.defaultProjectId, 'string');
    assert.equal(createdUser.disabledAt, null);
    const createdProject = queries.getProject(createdUser.defaultProjectId);
    assert.equal(createdProject?.owner_user_id, createdUser.id);
    assert.equal(createdProject?.is_system, 1);
    assert.equal(createdProject?.path, path.join(directory, 'workspace'));
    assert.equal((await app.request('/api/auth/users', {
      method: 'POST', headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'forbidden', initialPassword: 'temporary-password' }),
    })).status, 403);
    assert.equal((await app.request('/api/auth/users', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'new-member', initialPassword: 'temporary-password' }),
    })).status, 409);

    const defaultProjectResponse = await app.request('/api/auth/default-project', {
      method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: createdUser.defaultProjectId }),
    });
    assert.equal(defaultProjectResponse.status, 403);
    const invalidDefaultEngineResponse = await app.request('/api/auth/default-engine', {
      method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'unknown' }),
    });
    assert.equal(invalidDefaultEngineResponse.status, 400);
    const defaultEngineResponse = await app.request('/api/auth/default-engine', {
      method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'codebuddy' }),
    });
    assert.equal(defaultEngineResponse.status, 200);
    assert.equal((await defaultEngineResponse.json()).user.defaultEngine, 'codebuddy');
    assert.equal(queries.getUserById(member.id)?.default_engine, 'codebuddy');
    const originalGetModelCatalog = defaultSystem.defaultEngineSystem.modelCatalog.get.bind(defaultSystem.defaultEngineSystem.modelCatalog);
    const modelCatalog = {
      engineId: 'codebuddy' as const,
      fetchedAt: 1,
      stale: false,
      models: [{
        id: 'cb-model', displayName: 'CB Model', isDefault: true, inputModalities: ['text' as const],
        reasoning: { supported: false, scope: 'session' as const, options: [] },
      }],
    };
    try {
      defaultSystem.defaultEngineSystem.modelCatalog.get = async () => modelCatalog;
      const defaultModelResponse = await app.request('/api/auth/default-model', {
        method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'cb-model' }),
      });
      assert.equal(defaultModelResponse.status, 200);
      assert.equal((await defaultModelResponse.json()).user.defaultModelId, 'cb-model');
      assert.equal(queries.getUserById(member.id)?.default_model_id, 'cb-model');
      assert.equal((await app.request('/api/auth/default-model', {
        method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'missing-model' }),
      })).status, 422);
      assert.equal((await app.request('/api/auth/default-model', {
        method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: '' }),
      })).status, 400);

      defaultSystem.defaultEngineSystem.modelCatalog.get = async () => { throw new Error('catalog unavailable'); };
      assert.equal((await app.request('/api/auth/default-model', {
        method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'cb-model' }),
      })).status, 503);

      defaultSystem.defaultEngineSystem.modelCatalog.get = async () => {
        queries.setUserDefaultEngine(member.id, 'codex');
        return modelCatalog;
      };
      const changedEngineResponse = await app.request('/api/auth/default-model', {
        method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: 'cb-model' }),
      });
      assert.equal(changedEngineResponse.status, 409);
      assert.equal((await changedEngineResponse.json()).code, 'DEFAULT_ENGINE_CHANGED');

      const resetDefaultModelResponse = await app.request('/api/auth/default-model', {
        method: 'PATCH', headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ modelId: null }),
      });
      assert.equal(resetDefaultModelResponse.status, 200);
      assert.equal((await resetDefaultModelResponse.json()).user.defaultModelId, null);
    } finally {
      defaultSystem.defaultEngineSystem.modelCatalog.get = originalGetModelCatalog;
    }
    const disableResponse = await app.request(`/api/auth/users/${createdUser.id}/disabled`, {
      method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disableResponse.status, 200);
    assert.equal((await disableResponse.json()).user.disabledAt > 0, true);
    assert.equal(service.loginWithPassword('new-member', 'temporary-password'), null);
    const enableResponse = await app.request(`/api/auth/users/${createdUser.id}/disabled`, {
      method: 'PATCH', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ disabled: false }),
    });
    assert.equal(enableResponse.status, 200);
    assert.equal((await enableResponse.json()).user.disabledAt, null);

    const selfResetResponse = await app.request(`/api/auth/users/${admin.id}/reset-password`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin-password', newPassword: 'new-admin-password' }),
    });
    assert.equal(selfResetResponse.status, 400);
    const memberResetResponse = await app.request(`/api/auth/users/${member.id}/reset-password`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin-password', newPassword: 'new-member-password' }),
    });
    assert.equal(memberResetResponse.status, 200);
    assert.equal(service.authenticateSessionToken(memberLogin.token), null);
    assert.ok(service.loginWithPassword('member', 'new-member-password'));
    const auditRows = (await import('../db/index.js')).getDB().all(
      'SELECT action, resource_type, resource_id, owner_user_id, result FROM admin_audit_events ORDER BY occurred_at, rowid',
    );
    assert.deepEqual(auditRows.map((row) => [row.action, row.result]), [
      ['account.create', 'succeeded'],
      ['account.disable', 'started'], ['account.disable', 'succeeded'],
      ['account.enable', 'started'], ['account.enable', 'succeeded'],
      ['account.reset_password', 'started'], ['account.reset_password', 'succeeded'],
    ]);
    assert.equal(auditRows.every((row) => row.resource_type === 'user' && row.resource_id === row.owner_user_id), true);

    const changeResponse = await app.request('/api/auth/change-password', {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'admin-password', newPassword: 'new-admin-password' }),
    });
    assert.equal(changeResponse.status, 200);
    assert.match(changeResponse.headers.get('set-cookie') || '', /Max-Age=0/);
    assert.equal(service.authenticateSessionToken(adminLogin.token), null);
    assert.ok(service.loginWithPassword('relay-admin', 'new-admin-password'));
  } finally {
    delete process.env.RELAY_DB_PATH;
    delete process.env.RELAY_ROOT;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
