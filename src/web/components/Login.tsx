import { useState } from 'react';
import { api } from '../api.ts';
import { Pip } from './Pip.tsx';

export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/login', { body: { token: token.trim() } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="login">
      <form onSubmit={submit} className="card">
        <div className="brand"><Pip size={30} /><span className="brand-name">Wayfinder</span></div>
        <label>
          App token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        <p className="muted small">On the machine running Wayfinder, run <code>npm run token</code> in the app folder to see it.</p>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit" disabled={!token.trim()}>Sign in</button>
      </form>
    </div>
  );
}
