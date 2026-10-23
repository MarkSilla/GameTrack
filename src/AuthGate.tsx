import { useEffect, useRef, useState } from 'react';
import { api, auth } from './local-client';
import { ArrowRight, Download, Gamepad2, MonitorDown, ShieldCheck, Sparkles, X } from 'lucide-react';

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    callback: (token: string) => void;
    'expired-callback'?: () => void;
    'error-callback'?: () => void;
  }) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi; }
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise<TurnstileApi>((resolve, reject) => {
    let script = document.querySelector<HTMLScriptElement>('script[data-gametracker-turnstile]');
    if (!script) {
      script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.gametrackerTurnstile = 'true';
    }
    const onLoad = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not initialize.'));
    const onError = () => reject(new Error('Unable to load human verification.'));
    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });
    if (!script.isConnected) document.head.appendChild(script);
  });
}

type RegistrationConfig = { turnstileSiteKey: string; inviteRequired: boolean };

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Awaited<ReturnType<typeof auth.getUser>>>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [registering, setRegistering] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [registrationConfig, setRegistrationConfig] = useState<RegistrationConfig>({ turnstileSiteKey: '', inviteRequired: false });
  const [registrationConfigReady, setRegistrationConfigReady] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const turnstileContainerRef = useRef<HTMLDivElement>(null);
  const turnstileWidgetRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    auth.getUser().then(current => {
      if (!cancelled) {
        setUser(current);
        setLoading(false);
      }
    }).catch(error => {
      if (!cancelled) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to check your account.');
        setLoading(false);
      }
    });
    void api.get<RegistrationConfig>('/api/auth/config').then(({ data }) => {
      if (!cancelled) {
        setRegistrationConfig({
          turnstileSiteKey: typeof data.turnstileSiteKey === 'string' ? data.turnstileSiteKey : '',
          inviteRequired: data.inviteRequired === true,
        });
      }
    }).catch(() => undefined).finally(() => {
      if (!cancelled) setRegistrationConfigReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!authOpen || !registering || !registrationConfig.turnstileSiteKey) {
      setTurnstileToken('');
      return;
    }
    let cancelled = false;
    let widgetId: string | null = null;
    void loadTurnstile().then(turnstile => {
      if (cancelled || !turnstileContainerRef.current) return;
      widgetId = turnstile.render(turnstileContainerRef.current, {
        sitekey: registrationConfig.turnstileSiteKey,
        callback: token => { setTurnstileToken(token); setErrorMessage(''); },
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => { setTurnstileToken(''); setErrorMessage('Human verification could not load. Please try again.'); },
      });
      turnstileWidgetRef.current = widgetId;
    }).catch(error => {
      if (!cancelled) setErrorMessage(error instanceof Error ? error.message : 'Unable to load human verification.');
    });
    return () => {
      cancelled = true;
      if (widgetId) {
        window.turnstile?.remove(widgetId);
        if (turnstileWidgetRef.current === widgetId) turnstileWidgetRef.current = null;
      }
    };
  }, [authOpen, registering, registrationConfig.turnstileSiteKey]);

  useEffect(() => {
    if (!authOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAuthOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [authOpen]);

  const openAuth = (createAccount = false) => {
    setRegistering(createAccount);
    setErrorMessage('');
    setInviteCode('');
    setTurnstileToken('');
    setAuthOpen(true);
  };

  const signIn = async () => {
    if (registering && registrationConfig.inviteRequired && !inviteCode.trim()) {
      setErrorMessage('Enter the invite code to create an account.');
      return;
    }
    if (registering && registrationConfig.turnstileSiteKey && !turnstileToken) {
      setErrorMessage('Complete human verification before creating an account.');
      return;
    }
    setSigningIn(true);
    setErrorMessage('');
    try {
      const result = registering
        ? await auth.register(name, email, password, { inviteCode, turnstileToken })
        : await auth.signIn(email, password);
      setUser(result.user);
    } catch (error) {
      const value = error as { code?: string; message?: string };
      setErrorMessage(value.message || (registering ? 'Registration failed. Please try again.' : 'Sign-in failed. Please try again.'));
      if (registering) {
        setTurnstileToken('');
        if (turnstileWidgetRef.current) window.turnstile?.reset(turnstileWidgetRef.current);
      }
    } finally {
      setSigningIn(false);
    }
  };

  if (loading || !registrationConfigReady) return <div className="auth-loading">Checking your GameTracker account…</div>;
  if (user) return <>{children}</>;

  return (
    <div className="landing-page">
      <header className="landing-nav">
        <div className="landing-brand">
          <span className="landing-mark"><img src="./resources/app-icon.png" alt="GameTracker app icon" /></span>
          <div><strong>GameTracker</strong><small>Gaming activity, under control.</small></div>
        </div>
        <button className="landing-signin" onClick={() => openAuth(false)}>
          Sign in <ArrowRight size={16} />
        </button>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-copy">
            <div className="landing-kicker"><span className="landing-pulse" /> PRIVATE · ACCOUNT-BASED TRACKING</div>
            <h1>Track your games.<br /><em>Control your setup.</em></h1>
            <p>GameTracker brings your gaming library, sessions, backlog, and paired Windows PC into one clean dashboard. Sign in once, then control your own PC from any device.</p>
            <div className="landing-actions">
              <button className="landing-primary" onClick={() => openAuth(true)}>Get started <ArrowRight size={17} /></button>
              <a className="landing-signin" href="https://github.com/MarkSilla/GameTracker.exe/releases/latest/download/GameTracker-Setup-1.7.1.exe"><Download size={16} /> Download for Windows</a>
              <span className="landing-note"><ShieldCheck size={15} /> Your account owns its paired devices and data.</span>
            </div>
          </div>
          <div className="landing-preview">
            <div className="preview-top"><span><i /> GAME TRACKER</span><small>YOUR DASHBOARD</small></div>
            <div className="preview-live"><div className="preview-icon"><Gamepad2 size={21} /></div><div><b>Live Monitor</b><span>Windows PC · Connected</span></div><strong>01:24:18</strong></div>
            <div className="preview-grid"><div><span>Playtime</span><b>42.6h</b></div><div><span>Games</span><b>18</b></div><div><span>Backlog</span><b>7</b></div></div>
            <div className="preview-row"><span><MonitorDown size={15} /> Paired Windows PC</span><b>● Online</b></div>
            <div className="preview-bar"><i /></div>
            <div className="preview-caption">Realtime game detection · End Game remotely · Session history</div>
          </div>
        </section>

        <section className="landing-features">
          <div className="feature-card"><MonitorDown size={20} /><h3>Remote control</h3><p>Pair your Windows Agent once, then monitor and end active games from the same dashboard on your phone or another PC.</p></div>
          <div className="feature-card"><Sparkles size={20} /><h3>Automatic tracking</h3><p>Configured Windows games are detected by the desktop agent and sessions update as games start and stop.</p></div>
          <div className="feature-card"><ShieldCheck size={20} /><h3>Private by account</h3><p>Sign in to access your dashboard. Your paired PCs, games, sessions, and controls stay scoped to your account.</p></div>
        </section>

        <section className="landing-bottom">
          <span>ONE DASHBOARD · ANY DEVICE</span>
          <h2>From your PC to your phone,<br />your game activity stays in sync.</h2>
          <button onClick={() => openAuth(false)}>Sign in to GameTracker <ArrowRight size={16} /></button>
        </section>
      </main>
      <footer className="landing-footer"><span>© 2026 GameTracker</span><span>Local-first · Account-secured · Responsive</span></footer>
      {authOpen && (
        <div className="landing-auth-backdrop" onClick={event => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className="landing-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="landing-auth-title">
            <div className="landing-auth-heading">
              <div>
                <h2 id="landing-auth-title">{registering ? 'Create your account' : 'Welcome back'}</h2>
                <p>{registering ? 'Create an account to start tracking your games.' : 'Sign in to open your GameTracker dashboard.'}</p>
              </div>
              <button className="landing-auth-close" type="button" onClick={() => setAuthOpen(false)} aria-label="Close sign-in form"><X size={18} /></button>
            </div>
            <form className="landing-auth-form" onSubmit={event => { event.preventDefault(); void signIn(); }}>
              {registering && <input className="landing-auth-input" value={name} onChange={event => setName(event.target.value)} placeholder="Name" autoComplete="name" required disabled={signingIn} />}
              <input className="landing-auth-input" value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" type="email" autoComplete="email" required disabled={signingIn} />
              <input className="landing-auth-input" value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 8 : undefined} maxLength={128} required disabled={signingIn} />
              {registering && registrationConfig.inviteRequired && <input className="landing-auth-input" value={inviteCode} onChange={event => setInviteCode(event.target.value)} placeholder="Invite code" autoComplete="off" required disabled={signingIn} />}
              {registering && registrationConfig.turnstileSiteKey && <div ref={turnstileContainerRef} className="landing-turnstile" />}
              {errorMessage && <div className="landing-error">{errorMessage}</div>}
              <button className="landing-auth-submit" type="submit" disabled={signingIn}>{signingIn ? 'Please wait…' : registering ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></button>
            </form>
            <button className="landing-auth-switch" type="button" disabled={signingIn} onClick={() => { setRegistering(current => !current); setErrorMessage(''); setInviteCode(''); setTurnstileToken(''); }}>
              {registering ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
