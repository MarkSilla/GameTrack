import { router, json, error, db, requireAuth } from './local-sdk';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { notifySubscribers, realtimeSubscriptionRoutes } from './realtime-subscribers';
import { constantTimeEquals, hashDeviceAccessCode, hashSessionToken, rateLimit, requestIp, verifyDeviceAccessCode, verifyTurnstile } from './security';

const TABLE = 'gametracker_devices';

type DeviceCommand =
  | { id: string; type: 'end_game'; game_id: string; requested_at: string }
  | { id: string; type: 'add_game'; game: { id: string; name: string; executable: string; iconUrl?: string; iconDataUrl?: string; platform: string; status: string; hours: number }; requested_at: string }
  | { id: string; type: 'remove_game'; game_id: string; requested_at: string };

type DeviceRecord = {
  device_id: string;
  access_code: string;
  pairing_code?: string | null;
  pairing_expires_at?: string | null;
  owner_user_id?: string | null;
  games: unknown[];
  sessions: unknown[];
  active: unknown[];
  synced_at: string;
  pending_command?: DeviceCommand | null;
  last_command?: { id: string; type: DeviceCommand['type']; game_id?: string; completed_at: string; ok: boolean; message: string } | null;
};

async function findDevice(deviceId: string) {
  let nextToken: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await db.list<DeviceRecord>(TABLE, { limit: 100, nextToken });
    const match = page.items.find(item => item.device_id === deviceId);
    if (match) return match;
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  return undefined;
}

function authorizeAgent(input: { device_id?: string; access_code?: string }) {
  return { deviceId: String(input.device_id || '').trim(), accessCode: String(input.access_code || '').trim() };
}

function publicState(state: DeviceRecord) {
  return { device_id: state.device_id, games: state.games || [], sessions: state.sessions || [], active: state.active || [], synced_at: state.synced_at, command: state.pending_command || null, last_command: state.last_command || null };
}

function normalizeGameName(value: unknown) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function normalizeExecutable(value: unknown) { const raw = String(value || '').trim().replace(/\\/g, '/'); return raw.split('/').pop()?.toLowerCase() || ''; }
function gameFromInput(input: Record<string, unknown>) {
  const name = String(input.name || '').trim();
  const executable = normalizeExecutable(input.executable);
  const iconUrl = String(input.iconUrl || '').trim();
  const iconDataUrl = String(input.iconDataUrl || '').trim();
  const id = String(input.id || '').trim() || `game-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (!name || !executable) return null;
  return { id, name, executable, iconUrl: /^https:\/\//i.test(iconUrl) ? iconUrl : undefined, iconDataUrl: /^data:image\//i.test(iconDataUrl) && iconDataUrl.length <= 220000 ? iconDataUrl : undefined, platform: String(input.platform || 'PC'), status: String(input.status || 'Backlog'), hours: Number(input.hours || 0) };
}

function normalizeSessions(input: unknown[]) {
  const byKey = new Map<string, unknown>();
  input.forEach(item => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const id = String(record.id || '').trim();
    const gameId = String(record.gameId || '').trim();
    const startedAt = String(record.startedAt || '').trim();
    const stableKey = id || `${gameId}:${startedAt}`;
    if (!stableKey || stableKey === ':') return;
    byKey.set(stableKey, item);
  });
  return Array.from(byKey.values()).slice(-500);
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && timingSafeEqual(actual, expectedBuffer);
}

function sessionCookie(token: string) {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.COOKIE_SAMESITE || 'Lax';
  return `gt_session=${token}; HttpOnly; Path=/; SameSite=${sameSite}; Max-Age=604800${secure}`;
}

function expiredSessionCookie() {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.COOKIE_SAMESITE || 'Lax';
  return `gt_session=; HttpOnly; Path=/; SameSite=${sameSite}; Max-Age=0${secure}`;
}

function createAuthSession(user: { userId: string; name?: string; email?: string }) {
  const token = randomBytes(32).toString('hex');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return db.add('auth_sessions', [{ tokenHash: hashSessionToken(token), userId: user.userId, name: user.name || '', email: user.email || '', createdAt: createdAt.toISOString(), expiresAt }]).then(() => token);
}

function requestSessionToken(request: { headers: { cookie?: string } }) {
  return String(request.headers.cookie || '').split(';').map(cookie => cookie.trim()).find(cookie => cookie.startsWith('gt_session='))?.slice('gt_session='.length) || '';
}

function publicUser(user: { userId: string; name?: string; email?: string }) {
  return { userId: user.userId, name: user.name || '', email: user.email || '' };
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'GET /api/auth/config': [async () => json({
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
    inviteRequired: Boolean(process.env.REGISTRATION_INVITE_CODE),
  })],

  'POST /api/auth/register': [
    rateLimit('auth-register-ip', 5, 60 * 60 * 1000),
    async ({ body, request }) => {
    const input = body as { email?: string; password?: string; name?: string; inviteCode?: string; turnstileToken?: string };
    const email = String(input.email || '').trim().toLowerCase();
    const password = String(input.password || '');
    const name = String(input.name || '').trim() || email.split('@')[0];
    if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return error('Enter a valid email address.', 400);
    if (name.length > 100) return error('Name must be 100 characters or fewer.', 400);
    if (password.length < 8 || password.length > 128) return error('Password must be between 8 and 128 characters.', 400);
    const inviteSecret = process.env.REGISTRATION_INVITE_CODE || '';
    if (inviteSecret && !constantTimeEquals(String(input.inviteCode || ''), inviteSecret)) return error('A valid invite code is required to create an account.', 403);
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY || '';
    const turnstileToken = String(input.turnstileToken || '').trim();
    if (turnstileSecret || turnstileToken) {
      if (!turnstileSecret) return error('Human verification is not configured on the server.', 503);
      if (!await verifyTurnstile(turnstileToken, requestIp(request))) return error('Human verification failed. Please try again.', 403);
    } else if ((process.env.NODE_ENV === 'production' || process.env.REGISTRATION_REQUIRE_PROTECTION === 'true') && !inviteSecret) {
      return error('Registration is disabled until an invite code or Turnstile is configured.', 503);
    }
    const users = await db.list<{ email?: string }>('users', { limit: 1000 });
    if (users.items.some(user => user.email === email)) return error('An account with that email already exists.', 409);
    const userId = `user-${randomBytes(12).toString('hex')}`;
    await db.add('users', [{ userId, email, name, passwordHash: hashPassword(password) }]);
    const token = await createAuthSession({ userId, name, email });
    return json({ user: publicUser({ userId, name, email }) }, { headers: { 'Set-Cookie': sessionCookie(token) } });
    },
  ],

  'POST /api/auth/login': [
    rateLimit('auth-login-ip', 20, 15 * 60 * 1000),
    rateLimit('auth-login-account', 8, 15 * 60 * 1000, ({ body }) => String((body as { email?: string } | undefined)?.email || '').trim().toLowerCase()),
    async ({ body }) => {
    const input = body as { email?: string; password?: string };
    const email = String(input.email || '').trim().toLowerCase();
    const password = String(input.password || '');
    if (password.length > 128) return error('Email or password is incorrect.', 401);
    const users = await db.list<{ userId?: string; email?: string; name?: string; passwordHash?: string }>('users', { limit: 1000 });
    const user = users.items.find(item => item.email === email);
    if (!user?.userId || !user.passwordHash || !verifyPassword(password, user.passwordHash)) return error('Email or password is incorrect.', 401);
    const token = await createAuthSession({ userId: user.userId, name: user.name, email });
    return json({ user: publicUser({ userId: user.userId, name: user.name, email }) }, { headers: { 'Set-Cookie': sessionCookie(token) } });
    },
  ],

  'GET /api/auth/me': [async ({ user }) => json({ user: user ? publicUser(user) : null })],

  'POST /api/auth/logout': [async ({ request }) => {
    const token = requestSessionToken(request);
    if (token) {
      const sessions = await db.list<{ token?: string; tokenHash?: string }>('auth_sessions', { limit: 1000 });
      const tokenHash = hashSessionToken(token);
      const session = sessions.items.find(item => item.tokenHash === tokenHash || item.token === token);
      if (session?.id) await db.delete('auth_sessions', [session.id]);
    }
    return json({ ok: true }, { headers: { 'Set-Cookie': expiredSessionCookie() } });
  }],

  'POST /api/device/sync': [
    rateLimit('device-sync-ip', 300, 60 * 1000),
    rateLimit('device-sync-id', 120, 60 * 1000, ({ body }) => String((body as { device_id?: string } | undefined)?.device_id || 'unknown')),
    async ({ body }) => {
    const input = body as { device_id?: string; access_code?: string; pairing_code?: string; pairing_expires_at?: string; games?: unknown[]; sessions?: unknown[]; active?: unknown[]; synced_at?: string; state?: { games?: unknown[]; sessions?: unknown[]; active?: unknown[]; synced_at?: string } };
    const incomingState = input.state && typeof input.state === 'object' ? input.state : input;
    const { deviceId, accessCode } = authorizeAgent(input);
    if (!deviceId || !accessCode) return error('device_id and access_code are required', 400);
    const existing = await findDevice(deviceId);
    if (existing && !verifyDeviceAccessCode(String(existing.access_code || ''), accessCode)) return error('Invalid device credentials.', 401);
    const incomingPairingCode = String(input.pairing_code || '').trim();
    const validIncomingPairingCode = /^\d{6}$/.test(incomingPairingCode) ? incomingPairingCode : null;
    const existingExpiry = Date.parse(String(existing?.pairing_expires_at || ''));
    const existingPairingIsValid = /^\d{6}$/.test(String(existing?.pairing_code || '')) && Number.isFinite(existingExpiry) && existingExpiry > Date.now();
    const incomingRepeatsExpiredCode = Boolean(existing?.pairing_code && existing.pairing_code === incomingPairingCode);
    const pairingCode = existing?.owner_user_id
      ? null
      : existingPairingIsValid
        ? String(existing?.pairing_code)
        : validIncomingPairingCode && !incomingRepeatsExpiredCode
          ? validIncomingPairingCode
          : String(randomInt(100000, 1000000));
    const pairingExpiresAt = existing?.owner_user_id
      ? null
      : existingPairingIsValid
        ? existing?.pairing_expires_at || null
        : new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const state: DeviceRecord = {
      device_id: deviceId,
      access_code: hashDeviceAccessCode(accessCode),
      pairing_code: pairingCode,
      pairing_expires_at: pairingExpiresAt,
      owner_user_id: existing?.owner_user_id || null,
      games: Array.isArray(incomingState.games) ? incomingState.games : [],
      sessions: Array.isArray(incomingState.sessions) ? normalizeSessions(incomingState.sessions) : [],
      active: Array.isArray(incomingState.active) ? incomingState.active : [],
      synced_at: String(incomingState.synced_at || new Date().toISOString()),
      pending_command: existing?.pending_command || null,
      last_command: existing?.last_command || null,
    };
    if (!existing) {
      const [id] = await db.add(TABLE, [state]);
      if (!id) return error('Unable to save device state', 500);
    } else {
      const ok = await db.update(TABLE, [{ id: existing.id, record: state }]);
      if (!ok[0]) return error('Unable to update device state', 500);
    }
    await notifySubscribers('device', deviceId, publicState(state));
    return json({ ok: true, synced_at: state.synced_at, command: state.pending_command || null, pairing_code: state.pairing_code || null, pairing_expires_at: state.pairing_expires_at || null, paired: Boolean(state.owner_user_id) });
    },
  ],

  'POST /api/device/pair': [
    requireAuth(),
    rateLimit('device-pair-ip', 8, 10 * 60 * 1000),
    rateLimit('device-pair-user', 8, 10 * 60 * 1000, ({ user }) => String(user?.userId || 'unknown')),
    async ({ body, user }) => {
    const input = body as { device_id?: string; pairing_code?: string; access_code?: string };
    const deviceId = String(input.device_id || '').trim();
    const pairingCode = String(input.pairing_code || '').trim();
    if (!pairingCode) return error('pairing_code is required', 400);
    if (!/^\d{6}$/.test(pairingCode)) return error('Pairing code must be exactly 6 digits.', 400);
    let state = deviceId ? await findDevice(deviceId) : null;
    if (!state) {
      let nextToken: string | undefined;
      for (let pageNumber = 0; pageNumber < 20 && !state; pageNumber += 1) {
        const listed = await db.list<DeviceRecord>(TABLE, { limit: 100, nextToken });
        state = listed.items.find(item => item.pairing_code === pairingCode) || null;
        nextToken = listed.nextToken;
        if (!nextToken) break;
      }
    }
    if (!state) return error('Invalid or already-used pairing code.', 401);
    if (!state.pairing_code || state.pairing_code !== pairingCode) return error('Invalid or already-used pairing code.', 401);
    const pairingExpiry = Date.parse(String(state.pairing_expires_at || ''));
    if (!Number.isFinite(pairingExpiry) || pairingExpiry <= Date.now()) return error('This pairing code has expired. Generate a new code from the Windows Agent.', 401);
    if (state.owner_user_id && state.owner_user_id !== user!.userId) return error('This PC is already paired to another GameTracker account.', 403);
    const updated = { ...state, owner_user_id: user!.userId, pairing_code: null, pairing_expires_at: null };
    const ok = await db.update(TABLE, [{ id: state.id, record: updated }]);
    if (!ok[0]) return error('Unable to pair this PC.', 500);
    await notifySubscribers('device', deviceId, publicState(updated));
    return json({ ok: true, device_id: deviceId, paired: true });
    },
  ],

  'GET /api/device/owned-list': [requireAuth(), async ({ user }) => {
    const page = await db.list<DeviceRecord>(TABLE, { limit: 100 });
    const devices = page.items.filter(item => item.owner_user_id === user!.userId).map(item => ({ device_id: item.device_id, synced_at: item.synced_at, online: Date.now() - Date.parse(item.synced_at) < 15000, game_count: Array.isArray(item.games) ? item.games.length : 0, active_count: Array.isArray(item.active) ? item.active.length : 0 }));
    return json({ devices });
  }],

  'POST /api/device/disconnect': [requireAuth(), rateLimit('device-disconnect-ip', 10, 60 * 60 * 1000), async ({ body, user }) => {
    const input = body as { device_id?: string };
    const deviceId = String(input.device_id || '').trim();
    if (!deviceId) return error('device_id is required', 400);
    const state = await findDevice(deviceId);
    if (!state) return error('Device not found', 404);
    if (state.owner_user_id !== user!.userId) return error('This PC is not paired to your account.', 403);
    const updatedState: DeviceRecord = { ...state, owner_user_id: null, pending_command: null, pairing_code: String(randomInt(100000, 1000000)), pairing_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
    const ok = await db.update(TABLE, [{ id: state.id, record: updatedState }]);
    if (!ok[0]) return error('Unable to disconnect this PC.', 500);
    await notifySubscribers('device', deviceId, publicState(updatedState));
    return json({ ok: true, device_id: deviceId, disconnected: true, pairing_code: updatedState.pairing_code, pairing_expires_at: updatedState.pairing_expires_at });
  }],

  'GET /api/device/owned-state': [requireAuth(), async ({ query, user }) => {
    const deviceId = String(query.device_id || '').trim();
    if (!deviceId) return error('device_id is required', 400);
    const state = await findDevice(deviceId);
    if (!state) return error('Device not found', 404);
    if (state.owner_user_id !== user!.userId) return error('This PC is not paired to your account.', 403);
    return json(publicState(state));
  }],

  'POST /api/device/owned-game-command': [requireAuth(), async ({ body, user }) => {
    const input = body as { device_id?: string; action?: 'add' | 'remove'; game?: Record<string, unknown>; game_id?: string };
    const deviceId = String(input.device_id || '').trim();
    const action = input.action;
    if (!deviceId || !action) return error('device_id and action are required', 400);
    const state = await findDevice(deviceId);
    if (!state) return error('Device not found', 404);
    if (state.owner_user_id !== user!.userId) return error('This PC is not paired to your account.', 403);
    if (state.pending_command) return error('Another device command is already pending.', 409);
    const currentGames = Array.isArray(state.games) ? state.games as Array<{ id?: string; name?: string; executable?: string }> : [];
    let command: DeviceCommand;
    if (action === 'add') {
      const game = gameFromInput(input.game || {});
      if (!game) return error('Game name and Windows executable are required.', 400);
      const duplicate = currentGames.find(item => item.id === game.id || normalizeGameName(item.name) === normalizeGameName(game.name) || normalizeExecutable(item.executable) === normalizeExecutable(game.executable));
      if (duplicate) {
        if (normalizeGameName(duplicate.name) === normalizeGameName(game.name)) return error(`Game already exists: ${String(duplicate.name || game.name)}.`, 409);
        return error(`Executable already registered: ${normalizeExecutable(duplicate.executable)}.`, 409);
      }
      command = { id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'add_game', game, requested_at: new Date().toISOString() };
    } else {
      const gameId = String(input.game_id || '').trim();
      if (!gameId) return error('game_id is required', 400);
      if (!currentGames.some(item => item.id === gameId)) return error('Game is not configured on this device.', 404);
      command = { id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'remove_game', game_id: gameId, requested_at: new Date().toISOString() };
    }
    const updatedState: DeviceRecord = { ...state, pending_command: command };
    const ok = await db.update(TABLE, [{ id: state.id, record: updatedState }]);
    if (!ok[0]) return error('Unable to queue the game command.', 500);
    await notifySubscribers('device', deviceId, publicState(updatedState));
    return json({ ok: true, command });
  }],

  'POST /api/device/owned-command': [requireAuth(), async ({ body, user }) => {
    const input = body as { device_id?: string; game_id?: string };
    const deviceId = String(input.device_id || '').trim();
    const gameId = String(input.game_id || '').trim();
    if (!deviceId || !gameId) return error('device_id and game_id are required', 400);
    const state = await findDevice(deviceId);
    if (!state) return error('Device not found', 404);
    if (state.owner_user_id !== user!.userId) return error('This PC is not paired to your account.', 403);
    if (state.pending_command) {
      const pendingAt = Date.parse(String(state.pending_command.requested_at || ''));
      const pendingAge = Number.isFinite(pendingAt) ? Date.now() - pendingAt : Number.POSITIVE_INFINITY;
      if (pendingAge >= 30000) {
        const recoveredState: DeviceRecord = { ...state, pending_command: null };
        const recovered = await db.update(TABLE, [{ id: state.id, record: recoveredState }]);
        if (!recovered[0]) return error('Unable to recover the previous game-control command.', 500);
        await notifySubscribers('device', deviceId, publicState(recoveredState));
      } else {
        return error('A game-control command is already pending. Please wait for the Windows Agent to finish it.', 409);
      }
    }
    const games = Array.isArray(state.games) ? state.games as Array<{ id?: string }> : [];
    if (!games.some(item => item.id === gameId)) return error('Game is not configured on this device.', 404);
    const active = Array.isArray(state.active) ? state.active as Array<{ gameId?: string }> : [];
    if (!active.some(item => item.gameId === gameId)) return error('That game is not currently running.', 409);
    const command: DeviceCommand = { id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'end_game', game_id: gameId, requested_at: new Date().toISOString() };
    const updatedState: DeviceRecord = { ...state, pending_command: command };
    const ok = await db.update(TABLE, [{ id: state.id, record: updatedState }]);
    if (!ok[0]) return error('Unable to queue the game-control command.', 500);
    await notifySubscribers('device', deviceId, publicState(updatedState));
    return json({ ok: true, command });
  }],

  'POST /api/device/command-result': [async ({ body }) => {
    const input = body as { device_id?: string; access_code?: string; command_id?: string; ok?: boolean; message?: string };
    const { deviceId, accessCode } = authorizeAgent(input);
    const commandId = String(input.command_id || '').trim();
    if (!deviceId || !accessCode || !commandId) return error('device_id, access_code and command_id are required', 400);
    const state = await findDevice(deviceId);
    if (!state) return error('Device not found', 404);
    if (!verifyDeviceAccessCode(String(state.access_code || ''), accessCode)) return error('Invalid access code', 401);
    if (!state.pending_command || state.pending_command.id !== commandId) return error('Command not found or already completed.', 409);
    const result = { id: commandId, type: state.pending_command.type, game_id: 'game_id' in state.pending_command ? state.pending_command.game_id : undefined, completed_at: new Date().toISOString(), ok: Boolean(input.ok), message: String(input.message || '') };
    const updatedState: DeviceRecord = { ...state, pending_command: null, last_command: result };
    const ok = await db.update(TABLE, [{ id: state.id, record: updatedState }]);
    if (!ok[0]) return error('Unable to save command result.', 500);
    await notifySubscribers('device', deviceId, publicState(updatedState));
    return json({ ok: true, result });
  }],

  ...realtimeSubscriptionRoutes,
});
