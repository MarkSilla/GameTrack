import type { RouteContext, RouteHandler } from './local-sdk';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

type RateBucket = { count: number; resetAt: number };
type RateLimitKey = (context: RouteContext) => string;

const buckets = new Map<string, RateBucket>();
const MAX_RATE_LIMIT_BUCKETS = 10_000;

export function requestIp(request: RouteContext['request']) {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = request.headers['x-forwarded-for'];
    const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (firstForwarded?.trim()) return firstForwarded.trim().slice(0, 100);
  }
  return String(request.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

export function rateLimit(name: string, max: number, windowMs: number, getKey: RateLimitKey = context => requestIp(context.request)): RouteHandler {
  return context => {
    const now = Date.now();
    const key = `${name}:${String(getKey(context) || 'unknown').slice(0, 180)}`;
    let bucket = buckets.get(key);

    if (bucket && bucket.resetAt <= now) {
      buckets.delete(key);
      bucket = undefined;
    }

    if (!bucket) {
      if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        for (const [existingKey, existingBucket] of buckets) {
          if (existingBucket.resetAt <= now) buckets.delete(existingKey);
        }
      }
      if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
        return { status: 429, body: { error: 'Too many requests. Try again later.' }, headers: { 'Retry-After': String(Math.ceil(windowMs / 1000)) } };
      }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return {
        status: 429,
        body: { error: 'Too many requests. Try again later.' },
        headers: { 'Retry-After': String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))) },
      };
    }
    return undefined;
  };
}

export function constantTimeEquals(candidate: string, expected: string) {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function hashDeviceAccessCode(accessCode: string) {
  const salt = randomBytes(16).toString('hex');
  const digest = createHash('sha256').update(`${salt}:${accessCode}`).digest('hex');
  return `s1$${salt}$${digest}`;
}

export function verifyDeviceAccessCode(stored: string, candidate: string) {
  const match = /^s1\$([a-f0-9]{32})\$([a-f0-9]{64})$/i.exec(stored);
  if (!match) return constantTimeEquals(stored, candidate);
  const actual = createHash('sha256').update(`${match[1]}:${candidate}`).digest('hex');
  return constantTimeEquals(actual, match[2]);
}

export async function verifyTurnstile(token: string, remoteIp?: string) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret || !token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}
