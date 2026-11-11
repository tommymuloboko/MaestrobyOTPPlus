import { useState } from 'react';
import { api, sessionStore, type Session } from './api';

const DEMO_PASSWORD = 'Maestro#2026';
const DEMO_ACCOUNTS = [
  { email: 'fleet@acme.test', label: 'Customer', sub: 'Acme Logistics' },
  { email: 'fleet@buildco.test', label: 'Customer', sub: 'BuildCo Mining' },
  { email: 'supplier@mainline.test', label: 'Supplier', sub: 'Station Manager' },
  { email: 'attendant@mainline.test', label: 'Attendant', sub: 'Pump terminal' },
  { email: 'admin@maestro.test', label: 'Admin', sub: 'Platform' },
  { email: 'omc@mainline.test', label: 'OMC Administrator', sub: 'Maestro Fuel Depots' },
];

const FEATURES = [
  'Order → approve → OTP → dispense in one flow',
  'Customer-specific contract pricing',
  'Live tank and pump monitoring',
  'Maestro Sentinel™ fraud detection',
];

export default function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const s = await api.login(email, password);
      sessionStore.set(s);
      onLogin(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <aside className="login-brand">
        <div className="logo">
          <span className="logo-mark">M</span>
          <span className="logo-text">Maestro</span>
        </div>
        <div className="login-pitch">
          <h1>Fuel ordering and dispensing, in one intelligent ecosystem.</h1>
          <ul>
            {FEATURES.map((f) => <li key={f}><span className="tick">✓</span>{f}</li>)}
          </ul>
        </div>
        <small>Maestro FuelOrder™ · walking skeleton</small>
      </aside>

      <main className="login-main">
        <form className="login-card" onSubmit={submit}>
          <h2>Welcome back</h2>
          <p className="login-sub">Sign in to your Maestro workspace</p>

          {error && <div className="error" role="alert">{error}</div>}

          <label>Email
            <input type="email" value={email} autoComplete="username" required autoFocus
              placeholder="you@company.com" onChange={(e) => setEmail(e.target.value)} />
          </label>

          <label>Password
            <div className="pw">
              <input type={show ? 'text' : 'password'} value={password} required
                autoComplete="current-password" placeholder="Your password"
                onChange={(e) => setPassword(e.target.value)} />
              <button type="button" className="pw-toggle" onClick={() => setShow(!show)}>
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <button type="submit" className="cta green wide" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="demo">
            <span className="demo-title">Demo accounts · password <code>{DEMO_PASSWORD}</code></span>
            <div className="demo-grid">
              {DEMO_ACCOUNTS.map((a) => (
                <button type="button" key={a.email} className="demo-chip"
                  onClick={() => { setEmail(a.email); setPassword(DEMO_PASSWORD); setError(''); }}>
                  <b>{a.label}</b>
                  <small>{a.sub}</small>
                </button>
              ))}
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
