import { createServer } from 'node:http';
import { handler } from './index';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const defaultOrigins = process.env.NODE_ENV === 'production'
  ? ['https://gametrack-beige.vercel.app']
  : ['http://localhost:5173'];
const configuredOrigins = (process.env.CORS_ORIGIN || '').split(',');
const allowedOrigins = new Set(
  [...defaultOrigins, ...configuredOrigins]
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
);

function applyCors(response: import('node:http').ServerResponse, request: import('node:http').IncomingMessage) {
  const origin = request.headers.origin;
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-store');
  if (process.env.NODE_ENV === 'production') {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  if (!origin) return true;
  response.setHeader('Vary', 'Origin');
  if (!allowedOrigins.has(origin.replace(/\/+$/, ''))) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Id, X-User-Name, X-User-Email');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return true;
}

const server = createServer(async (request, response) => {
  const corsAllowed = applyCors(response, request);
  if (!corsAllowed) {
    response.statusCode = 403;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: 'Origin is not allowed.' }));
    return;
  }
  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }
  try {
    const result = await handler(request);
    response.statusCode = result.status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    Object.entries(result.headers || {}).forEach(([name, value]) => response.setHeader(name, value));
    response.end(JSON.stringify(result.body));
  } catch (error) {
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: process.env.NODE_ENV === 'production' ? 'Internal server error.' : error instanceof Error ? error.message : 'Internal server error.' }));
  }
});

server.listen(port, host, () => {
  console.log(`GameTracker backend listening on ${host}:${port}`);
});
