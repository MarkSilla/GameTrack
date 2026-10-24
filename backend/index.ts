import { router, json, error, db, requireAuth } from './local-sdk';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { notifySubscribers, realtimeSubscriptionRoutes } from './realtime-subscribers';
import { hashDeviceAccessCode, hashSessionToken, rateLimit, verifyDeviceAccessCode } from './security';

const TABLE = 'gametracker_devices';
const SCREEN_SHARE_TABLE = 'gametracker_screen_shares';

type ScreenShareRecord = {
  share_id: string;
  device_id: string;
  owner_user_id: string;
  state: 'requested' | 'streaming' | 'ended';
  offer?: ScreenShareDescription;
  answer?: ScreenShareDescription;
  message?: string;
  created_at: string;
  expires_at: string;
};
type ScreenShareDescription = { type: 'offer' | 'answer'; sdp: string };

type DeviceCommand =
  | { id: string; type: 'end_game'; game_id: string; requested_at: string }
  | { id: string; type: 'add_game'; game: { id: string; name: string; executable: string; iconUrl?: string; iconDataUrl?: string; platform: string; status: string; hours: number }; requested_at: string }
  | { id: string; type: 'remove_game'; game_id: string; requested_at: string }
  | { id: string; type: 'shutdown'; requested_at: string };

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

async function findScreenShare(shareId: string) {
  let nextToken: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await db.list<ScreenShareRecord>(SCREEN_SHARE_TABLE, { limit: 1000, nextToken });
    const item = page.items.find(record => record.share_id === shareId);
    if (item) return item;
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  return undefined;
}

async function listScreenShares() {
  const records: Array<ScreenShareRecord & { id: string }> = [];
  let nextToken: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await db.list<ScreenShareRecord>(SCREEN_SHARE_TABLE, { limit: 1000, nextToken });
    records.push(...page.items);
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  return records;
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
  const sameSite = process.env.COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'None' : 'Lax');
  return `gt_session=${token}; HttpOnly; Path=/; SameSite=${sameSite}; Max-Age=604800${secure}`;
}

function expiredSessionCookie() {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.COOKIE_SAMESITE || (process.env.NODE_ENV === 'production' ? 'None' : 'Lax');
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

function resendEmailConfig() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM || '').trim();
  if (!apiKey || !from) return null;
  return { apiKey, from };
}

async function sendResendEmail(email: string, subject: string, text: string, html: string, config: { apiKey: string; from: string }) {
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.from,
        to: [email],
        subject,
        text,
        html,
      }),
    });
  } catch (cause) {
    console.error('Unable to send a GameTracker security email.', cause);
    return false;
  }
  if (!response.ok) {
    console.error(`Resend rejected a GameTracker security email (HTTP ${response.status}).`);
    return false;
  }
  return true;
}

function createEmailCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashEmailCode(code: string, salt: string) {
  return scryptSync(code, salt, 32).toString('hex');
}

function verifyEmailCode(code: string, salt: string, expectedHash: string) {
  const actual = Buffer.from(hashEmailCode(code, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendVerificationCodeEmail(email: string, code: string, config: { apiKey: string; from: string }) {
  const text = `Your GameTracker email verification code is ${code}. It expires in 10 minutes. If you did not try to create an account, ignore this email.`;
  const html = `<p>Your GameTracker email verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. If you did not try to create an account, ignore this email.</p>`;
  return sendResendEmail(email, 'Verify your GameTracker email', text, html, config);
}

function sendPasswordResetCodeEmail(email: string, code: string, config: { apiKey: string; from: string }) {
  const text = `Your GameTracker password reset code is ${code}. It expires in 10 minutes. If you did not request this code, ignore this email and secure your email account.`;
  const html = `<p>Your GameTracker password reset code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. If you did not request this code, ignore this email and secure your email account.</p>`;
  return sendResendEmail(email, 'Your GameTracker password reset code', text, html, config);
}

function sendPasswordChangedEmail(email: string, config: { apiKey: string; from: string }) {
  const text = 'Your GameTracker password was changed. If you did not make this change, immediately secure your email account and use Forgot password to set a new password.';
  const html = '<p>Your GameTracker password was changed.</p><p>If you did not make this change, immediately secure your email account and use Forgot password to set a new password.</p>';
  return sendResendEmail(email, 'Your GameTracker password was changed', text, html, config);
}

async function deleteUserAuthSessions(userId: string) {
  const sessionIds: string[] = [];
  let nextToken: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await db.list<{ userId?: string }>('auth_sessions', { limit: 1000, nextToken });
    sessionIds.push(...page.items.filter(session => session.userId === userId).map(session => String(session.id)));
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  if (sessionIds.length) await db.delete('auth_sessions', sessionIds);
}

async function deleteRecordsWhere(table: string, matches: (record: Record<string, unknown>) => boolean) {
  const ids: string[] = [];
  let nextToken: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await db.list<Record<string, unknown>>(table, { limit: 1000, nextToken });
    ids.push(...page.items.filter(matches).map(record => String(record.id)));
    nextToken = page.nextToken;
    if (!nextToken) break;
  }
  if (ids.length) await db.delete(table, ids);
}

function fullName(firstName: string, middleName: string, lastName: string) {
  return [firstName, middleName, lastName].filter(Boolean).join(' ');
}

export const handler = router({
  'GET /api/_healthcheck': [async () => json({ message: 'Success' })],
  'POST /api/auth/register': [
    rateLimit('auth-register-ip', 5, 60 * 60 * 1000),
    rateLimit('auth-register-global', 100, 60 * 60 * 1000, () => 'all'),
    rateLimit('auth-register-email', 5, 15 * 60 * 1000, ({ body }) => String((body as { email?: string } | undefined)?.email || '').trim().toLowerCase()),
    async ({ body }) => {
    const config = resendEmailConfig();
    if (!config) return error('Email verification is not configured on the server. Set RESEND_API_KEY and RESEND_FROM in the backend environment.', 503);
    const input = body as { email?: string; password?: string; firstName?: string; middleName?: string; lastName?: string };
    const email = String(input.email || '').trim().toLowerCase();
    const password = String(input.password || '');
    const firstName = String(input.firstName || '').trim();
    const middleName = String(input.middleName || '').trim();
    const lastName = String(input.lastName || '').trim();
    if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return error('Enter a valid email address.', 400);
    if (!firstName || !lastName) return error('First name and last name are required.', 400);
    if (firstName.length > 100 || middleName.length > 100 || lastName.length > 100) return error('Each name must be 100 characters or fewer.', 400);
    if (password.length < 8 || password.length > 128) return error('Password must be between 8 and 128 characters.', 400);
    const users = await db.list<{ email?: string }>('users', { limit: 1000 });
    if (users.items.some(user => user.email === email)) return error('An account with that email already exists.', 409);
    const code = createEmailCode();
    const codeSalt = randomBytes(16).toString('hex');
    await deleteRecordsWhere('pending_registrations', record => record.email === email);
    const [registrationId] = await db.add('pending_registrations', [{
      email,
      firstName,
      middleName,
      lastName,
      passwordHash: hashPassword(password),
      codeSalt,
      codeHash: hashEmailCode(code, codeSalt),
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }]);
    const sent = await sendVerificationCodeEmail(email, code, config);
    if (!sent) {
      await db.delete('pending_registrations', [registrationId]);
      return error('Unable to send the verification email right now. Check the Resend sender configuration and try again.', 502);
    }
    return json({ message: 'A verification code has been sent to your email.' });
    },
  ],

  'POST /api/auth/verify-email': [
    rateLimit('auth-verify-email-ip', 10, 15 * 60 * 1000),
    rateLimit('auth-verify-email-address', 8, 15 * 60 * 1000, ({ body }) => String((body as { email?: string } | undefined)?.email || '').trim().toLowerCase()),
    async ({ body }) => {
      const input = body as { email?: string; code?: string };
      const email = String(input.email || '').trim().toLowerCase();
      const code = String(input.code || '').trim();
      if (!/^\d{6}$/.test(code)) return error('Enter the 6-digit code from your email.', 400);
      const registrations = await db.list<{
        email?: string; firstName?: string; middleName?: string; lastName?: string;
        passwordHash?: string; codeSalt?: string; codeHash?: string; attempts?: number; expiresAt?: string;
      }>('pending_registrations', { limit: 1000 });
      const registration = registrations.items.find(item => item.email === email);
      const expiresAt = Date.parse(registration?.expiresAt || '');
      if (!registration?.id || !registration.firstName || !registration.lastName || !registration.passwordHash || !registration.codeSalt || !registration.codeHash || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        if (registration?.id) await db.delete('pending_registrations', [registration.id]);
        return error('That verification code is invalid or expired. Request a new code.', 400);
      }
      if (Number(registration.attempts || 0) >= 5) {
        await db.delete('pending_registrations', [registration.id]);
        return error('Too many incorrect codes. Start sign-up again to get a new code.', 429);
      }
      if (!verifyEmailCode(code, registration.codeSalt, registration.codeHash)) {
        const { id, ...record } = registration;
        await db.update('pending_registrations', [{ id, record: { ...record, attempts: Number(record.attempts || 0) + 1 } }]);
        return error('That verification code is incorrect.', 400);
      }

      const users = await db.list<{ email?: string }>('users', { limit: 1000 });
      if (users.items.some(item => item.email === email)) {
        await db.delete('pending_registrations', [registration.id]);
        return error('An account with that email already exists.', 409);
      }
      await db.delete('pending_registrations', [registration.id]);
      const name = fullName(registration.firstName, registration.middleName || '', registration.lastName);
      const userId = `user-${randomBytes(12).toString('hex')}`;
      await db.add('users', [{
        userId, email, name,
        firstName: registration.firstName,
        middleName: registration.middleName || '',
        lastName: registration.lastName,
        passwordHash: registration.passwordHash,
        emailVerified: true,
      }]);
      const session = await createAuthSession({ userId, name, email });
      return json({ user: publicUser({ userId, name, email }) }, { headers: { 'Set-Cookie': sessionCookie(session) } });
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

  'POST /api/auth/forgot-password': [
    rateLimit('auth-password-reset-ip', 5, 60 * 60 * 1000),
    rateLimit('auth-password-reset-global', 100, 60 * 60 * 1000, () => 'all'),
    rateLimit('auth-password-reset-email', 5, 15 * 60 * 1000, ({ body }) => String((body as { email?: string } | undefined)?.email || '').trim().toLowerCase()),
    async ({ body }) => {
      const config = resendEmailConfig();
      if (!config) return error('Password recovery is not configured on the server. Set RESEND_API_KEY and RESEND_FROM in the backend environment.', 503);
      const email = String((body as { email?: string } | undefined)?.email || '').trim().toLowerCase();
      if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
        return json({ message: 'If an account exists for that email, a verification code will be sent.' });
      }
      const users = await db.list<{ userId?: string; email?: string }>('users', { limit: 1000 });
      const user = users.items.find(item => item.email === email && item.userId);
      if (!user?.userId) return json({ message: 'If an account exists for that email, a verification code will be sent.' });

      await deleteRecordsWhere('password_reset_codes', record => record.userId === user.userId);
      const code = createEmailCode();
      const codeSalt = randomBytes(16).toString('hex');
      const [codeId] = await db.add('password_reset_codes', [{
        userId: user.userId,
        email,
        codeSalt,
        codeHash: hashEmailCode(code, codeSalt),
        attempts: 0,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }]);
      const sent = await sendPasswordResetCodeEmail(email, code, config);
      if (!sent) {
        await db.delete('password_reset_codes', [codeId]);
        return error('Unable to send a recovery email right now. Check the Resend sender configuration and try again.', 502);
      }
      return json({ message: 'If an account exists for that email, a verification code will be sent.' });
    },
  ],

  'POST /api/auth/reset-password': [
    rateLimit('auth-password-complete-ip', 10, 15 * 60 * 1000),
    rateLimit('auth-password-complete-email', 8, 15 * 60 * 1000, ({ body }) => String((body as { email?: string } | undefined)?.email || '').trim().toLowerCase()),
    async ({ body }) => {
      const input = body as { email?: string; code?: string; password?: string };
      const email = String(input.email || '').trim().toLowerCase();
      const code = String(input.code || '').trim();
      const password = String(input.password || '');
      if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return error('Enter the email address where you received the code.', 400);
      if (!/^\d{6}$/.test(code)) return error('Enter the 6-digit code from your email.', 400);
      if (password.length < 8 || password.length > 128) return error('Password must be between 8 and 128 characters.', 400);

      const resetCodes = await db.list<{ userId?: string; email?: string; codeSalt?: string; codeHash?: string; expiresAt?: string; attempts?: number }>('password_reset_codes', { limit: 1000 });
      const resetCode = resetCodes.items.find(item => item.email === email);
      const expiresAt = Date.parse(resetCode?.expiresAt || '');
      if (!resetCode?.id || !resetCode.userId || !resetCode.codeSalt || !resetCode.codeHash || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        if (resetCode?.id) await db.delete('password_reset_codes', [resetCode.id]);
        return error('That recovery code is invalid or expired. Request a new code.', 400);
      }
      if (Number(resetCode.attempts || 0) >= 5) {
        await db.delete('password_reset_codes', [resetCode.id]);
        return error('Too many incorrect codes. Request a new recovery code.', 429);
      }
      if (!verifyEmailCode(code, resetCode.codeSalt, resetCode.codeHash)) {
        const { id, ...record } = resetCode;
        await db.update('password_reset_codes', [{ id, record: { ...record, attempts: Number(record.attempts || 0) + 1 } }]);
        return error('That recovery code is incorrect.', 400);
      }

      const users = await db.list<{ userId?: string; email?: string; passwordHash?: string; id?: string }>('users', { limit: 1000 });
      const user = users.items.find(item => item.userId === resetCode.userId && item.email === email && typeof item.id === 'string');
      if (!user?.id) return error('That recovery code is invalid or expired. Request a new code.', 400);

      await db.delete('password_reset_codes', [resetCode.id]);
      const { id: userRecordId, ...userRecord } = user;
      await db.update('users', [{ id: userRecordId, record: { ...userRecord, passwordHash: hashPassword(password) } }]);
      await deleteUserAuthSessions(resetCode.userId);
      const emailConfig = resendEmailConfig();
      if (user.email && emailConfig) {
        await sendPasswordChangedEmail(user.email, emailConfig);
      } else {
        console.error('Unable to send a GameTracker password-change notice because email settings are missing.');
      }
      return json({ ok: true }, { headers: { 'Set-Cookie': expiredSessionCookie() } });
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
    const input = body as { device_id?: string; game_id?: string; action?: 'shutdown' };
    const deviceId = String(input.device_id || '').trim();
    const gameId = String(input.game_id || '').trim();
    if (!deviceId || (!gameId && input.action !== 'shutdown')) return error('device_id and game_id are required', 400);
    if (input.action && input.action !== 'shutdown') return error('Unsupported device command.', 400);
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
    let command: DeviceCommand;
    if (input.action === 'shutdown') {
      command = { id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'shutdown', requested_at: new Date().toISOString() };
    } else {
      const games = Array.isArray(state.games) ? state.games as Array<{ id?: string }> : [];
      if (!games.some(item => item.id === gameId)) return error('Game is not configured on this device.', 404);
      const active = Array.isArray(state.active) ? state.active as Array<{ gameId?: string }> : [];
      if (!active.some(item => item.gameId === gameId)) return error('That game is not currently running.', 409);
      command = { id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: 'end_game', game_id: gameId, requested_at: new Date().toISOString() };
    }
    const updatedState: DeviceRecord = { ...state, pending_command: command };
    const ok = await db.update(TABLE, [{ id: state.id, record: updatedState }]);
    if (!ok[0]) return error('Unable to queue the game-control command.', 500);
    await notifySubscribers('device', deviceId, publicState(updatedState));
    return json({ ok: true, command });
  }],

  'POST /api/device/screen-share': [
    requireAuth(),
    rateLimit('screen-share-owner-ip', 20, 60 * 1000),
    async ({ body, user }) => {
      const input = body as { device_id?: string; action?: 'start' | 'stop'; share_id?: string };
      const deviceId = String(input.device_id || '').trim();
      if (!deviceId || !input.action) return error('device_id and action are required', 400);
      if (input.action !== 'start' && input.action !== 'stop') return error('Unsupported screen share action.', 400);
      const device = await findDevice(deviceId);
      if (!device) return error('Device not found', 404);
      if (device.owner_user_id !== user!.userId) return error('This PC is not paired to your account.', 403);

      if (input.action === 'stop') {
        const shareId = String(input.share_id || '').trim();
        const share = shareId ? await findScreenShare(shareId) : undefined;
        if (!share || share.device_id !== deviceId || share.owner_user_id !== user!.userId) return error('Screen share not found.', 404);
        if (share.state !== 'ended') {
          const updated = { ...share, state: 'ended' as const, message: 'Screen sharing was stopped from the dashboard.' };
          const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: share.id, record: updated }]);
          if (!ok[0]) return error('Unable to stop screen sharing.', 500);
        }
        return json({ ok: true });
      }

      const lastSync = Date.parse(String(device.synced_at || ''));
      if (!Number.isFinite(lastSync) || Date.now() - lastSync > 20000) return error('The Windows Agent is offline. Start it before requesting screen sharing.', 409);
      const existing = await listScreenShares();
      const now = Date.now();
      for (const expired of existing.filter(share => share.state !== 'ended' && Date.parse(share.expires_at) <= now)) {
        const updated = { ...expired, state: 'ended' as const, message: 'Screen share request expired.' };
        const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: expired.id, record: updated }]);
        if (!ok[0]) return error('Unable to expire an old screen share session.', 500);
      }
      const staleIds = existing.filter(share => share.state === 'ended' && now - Date.parse(share.created_at) > 24 * 60 * 60 * 1000).map(share => share.id);
      if (staleIds.length > 0) {
        const deleted = await db.delete(SCREEN_SHARE_TABLE, staleIds);
        if (deleted.some(ok => !ok)) return error('Unable to clean up expired screen share sessions.', 500);
      }
      const activeShare = existing.find(share => share.device_id === deviceId
        && share.state !== 'ended'
        && Date.parse(share.expires_at) > now);
      if (activeShare) return error('A screen share request or stream is already active for this PC.', 409);
      const shareId = randomBytes(18).toString('base64url');
      const share: ScreenShareRecord = {
        share_id: shareId,
        device_id: deviceId,
        owner_user_id: user!.userId,
        state: 'requested',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      };
      const [id] = await db.add(SCREEN_SHARE_TABLE, [share]);
      if (!id) return error('Unable to create a screen share request.', 500);
      return json({ share_id: shareId });
    },
  ],

  'POST /api/device/screen-share/offer': [
    requireAuth(),
    rateLimit('screen-share-offer-ip', 20, 60 * 1000),
    async ({ body, user }) => {
      const input = body as { device_id?: string; share_id?: string; offer?: ScreenShareDescription };
      const deviceId = String(input.device_id || '').trim();
      const shareId = String(input.share_id || '').trim();
      const sdp = String(input.offer?.sdp || '');
      if (!deviceId || !shareId || !sdp || sdp.length > 1000000) return error('A valid screen share offer is required.', 400);
      const share = await findScreenShare(shareId);
      if (!share || share.device_id !== deviceId || share.owner_user_id !== user!.userId) return error('Screen share not found.', 404);
      if (share.state !== 'requested' || Date.parse(share.expires_at) <= Date.now()) return error('Screen share request has expired.', 409);
      const updated = { ...share, offer: { type: 'offer' as const, sdp } };
      const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: share.id, record: updated }]);
      if (!ok[0]) return error('Unable to save the screen share offer.', 500);
      return json({ ok: true });
    },
  ],

  'GET /api/device/screen-share': [
    requireAuth(),
    async ({ query, user }) => {
      const deviceId = String(query.device_id || '').trim();
      const shareId = String(query.share_id || '').trim();
      const share = shareId ? await findScreenShare(shareId) : undefined;
      if (!share || share.device_id !== deviceId || share.owner_user_id !== user!.userId) return error('Screen share not found.', 404);
      if (share.state !== 'ended' && Date.parse(share.expires_at) <= Date.now()) {
        const updated = { ...share, state: 'ended' as const, message: 'Screen share request expired.' };
        const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: share.id, record: updated }]);
        if (!ok[0]) return error('Unable to expire the screen share request.', 500);
        return json({ state: updated.state, message: updated.message });
      }
      return json({ state: share.state, answer: share.answer || null, message: share.message || '' });
    },
  ],

  'POST /api/device/screen-share/agent': [
    rateLimit('screen-share-agent-ip', 120, 60 * 1000),
    async ({ body }) => {
      const input = body as {
        device_id?: string;
        access_code?: string;
        action?: 'poll' | 'answer' | 'decline' | 'stop';
        share_id?: string;
        answer?: ScreenShareDescription;
        message?: string;
      };
      const { deviceId, accessCode } = authorizeAgent(input);
      if (!deviceId || !accessCode || !input.action) return error('device_id, access_code and action are required.', 400);
      const device = await findDevice(deviceId);
      if (!device || !verifyDeviceAccessCode(String(device.access_code || ''), accessCode)) return error('Invalid device credentials.', 401);

      if (input.action === 'poll') {
        const shares = await listScreenShares();
        const currentTime = Date.now();
        const currentSessions = [];
        for (const share of shares.filter(item => item.device_id === deviceId && item.state !== 'ended')) {
          if (Date.parse(share.expires_at) <= currentTime) {
            const expired = { ...share, state: 'ended' as const, message: 'Screen share request expired.' };
            const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: share.id, record: expired }]);
            if (!ok[0]) return error('Unable to expire the screen share session.', 500);
            currentSessions.push({ share_id: share.share_id, state: expired.state, message: expired.message });
          } else if (share.state === 'streaming') {
            currentSessions.push({ share_id: share.share_id, state: share.state, message: share.message || '' });
          }
        }
        const requested = shares.find(share => share.device_id === deviceId
          && share.state === 'requested'
          && Boolean(share.offer?.sdp)
          && Date.parse(share.expires_at) > currentTime);
        const sessions = shares
          .filter(share => share.device_id === deviceId
            && share.state === 'ended'
            && currentTime - Date.parse(share.created_at) < 2 * 60 * 1000)
          .map(share => ({ share_id: share.share_id, state: share.state, message: share.message || '' }));
        return json({ request: requested ? { share_id: requested.share_id, offer: requested.offer } : null, sessions: [...currentSessions, ...sessions] });
      }

      const shareId = String(input.share_id || '').trim();
      const share = shareId ? await findScreenShare(shareId) : undefined;
      if (!share || share.device_id !== deviceId) return error('Screen share not found.', 404);
      if (share.state !== 'requested' || Date.parse(share.expires_at) <= Date.now()) return error('Screen share request has expired.', 409);
      if (input.action === 'answer') {
        const sdp = String(input.answer?.sdp || '');
        if (!sdp || sdp.length > 1000000) return error('A valid screen share answer is required.', 400);
        const updated = {
          ...share,
          state: 'streaming' as const,
          answer: { type: 'answer' as const, sdp },
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        };
        const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: share.id, record: updated }]);
        if (!ok[0]) return error('Unable to save the screen share answer.', 500);
        return json({ ok: true });
      }
      if (input.action === 'decline' || input.action === 'stop') {
        const updated = { ...share, state: 'ended' as const, message: String(input.message || (input.action === 'decline' ? 'Screen sharing was declined on the PC.' : 'Screen sharing was stopped on the PC.')).slice(0, 300) };
        const ok = await db.update(SCREEN_SHARE_TABLE, [{ id: share.id, record: updated }]);
        if (!ok[0]) return error('Unable to end the screen share.', 500);
        return json({ ok: true });
      }
      return error('Unsupported screen share action.', 400);
    },
  ],

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
