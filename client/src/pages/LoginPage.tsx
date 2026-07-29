import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const { setAuth, appTitle, toast } = useApp();

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/login', { password });
      setAuth(true, true);
    } catch (err) {
      toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={login}>
        <h1>{appTitle}</h1>
        <input
          type="password"
          placeholder="パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        <button className="pill primary" disabled={busy || !password}>
          ログイン
        </button>
      </form>
    </div>
  );
}
