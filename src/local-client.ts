export type LocalUser = {
  userId: string;
  name?: string;
  email?: string;
};

type ApiResponse<T = any> = { data: T; status: number; headers: Headers };
type ApiError = Error & { response?: { status: number; data: any } };
type RealtimeMessage = { type?: string; payload?: any; [key: string]: any };
type RealtimeConnection = {
  ready: Promise<void>;
  connectionId: string | null;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error?: Event | Error) => void): void;
  onMessage(handler: (message: RealtimeMessage) => void): void;
  disconnect(): void;
};

const LOCAL_USER_KEY = 'gt-local-user';
const API_BASE_URL = String(import.meta.env.VITE_API_URL || '')
  .trim()
  .replace(/\/+$/, '');

function resolveApiUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  const isLocalDevelopment = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const baseUrl = isLocalDevelopment ? '' : API_BASE_URL || 'https://gametrack-itzg.onrender.com';
  return `${baseUrl}${url}`;
}

function writeLocalUser(user: LocalUser | null) {
  if (typeof window === 'undefined') return;
  if (user) window.localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(user));
  else window.localStorage.removeItem(LOCAL_USER_KEY);
}

async function parseResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function request<T = any>(method: string, url: string, payload?: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(resolveApiUrl(url), {
    method,
    credentials: 'include',
    headers: {
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    const message = (data && typeof data === 'object' && ('error' in data || 'message' in data)
      ? String((data as { error?: unknown; message?: unknown }).error || (data as { message?: unknown }).message)
      : '') || `Request failed with HTTP ${response.status}`;
    const error = new Error(message) as ApiError;
    error.response = { status: response.status, data };
    throw error;
  }
  return { data: data as T, status: response.status, headers: response.headers };
}

class LocalRealtimeConnection implements RealtimeConnection {
  ready = Promise.resolve();
  connectionId: string | null = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private closeHandlers: Array<() => void> = [];
  private disconnected = false;
  onOpen(handler: () => void) { void this.ready.then(() => { if (!this.disconnected) handler(); }); }
  onClose(handler: () => void) { this.closeHandlers.push(handler); }
  onError(_handler: (error?: Event | Error) => void) {}
  onMessage(_handler: (message: RealtimeMessage) => void) {}
  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.connectionId = null;
    this.closeHandlers.forEach(handler => handler());
  }
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, payload?: unknown) => request<T>('POST', url, payload),
};

export const auth = {
  async getUser() {
    try {
      const response = await api.get<{ user: LocalUser | null }>('/api/auth/me');
      const user = response.data.user;
      writeLocalUser(user);
      return user;
    } catch {
      writeLocalUser(null);
      return null;
    }
  },
  async signIn(email: string, password: string) {
    const response = await api.post<{ user: LocalUser }>('/api/auth/login', { email, password });
    writeLocalUser(response.data.user);
    return response.data;
  },
  async register(firstName: string, middleName: string, lastName: string, email: string, password: string) {
    const response = await api.post<{ message: string }>('/api/auth/register', { firstName, middleName, lastName, email, password });
    return response.data;
  },
  async verifyEmail(email: string, code: string) {
    const response = await api.post<{ user: LocalUser }>('/api/auth/verify-email', { email, code });
    writeLocalUser(response.data.user);
    return response.data;
  },
  async requestPasswordReset(email: string) {
    const response = await api.post<{ message: string }>('/api/auth/forgot-password', { email });
    return response.data;
  },
  async resetPassword(email: string, code: string, password: string) {
    const response = await api.post<{ ok: boolean }>('/api/auth/reset-password', { email, code, password });
    writeLocalUser(null);
    return response.data;
  },
  async signOut() {
    await api.post('/api/auth/logout');
    writeLocalUser(null);
  },
};

export const ws = {
  connect(_options?: { heartbeatIntervalMs?: number }): RealtimeConnection { return new LocalRealtimeConnection(); },
};
