import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30日

// 個人用のためインメモリセッションで足りる（再起動でログアウト）
const sessions = new Map<string, number>();

/**
 * Cookieに secure を付けるか。
 * COOKIE_SECURE で明示指定でき、未指定なら APP_URL が https のときだけ有効にする
 * （httpのローカル開発でログインできなくなるのを避けるため）。
 */
export function cookieSecure(): boolean {
  const explicit = process.env.COOKIE_SECURE;
  if (explicit !== undefined) return explicit === '1' || explicit.toLowerCase() === 'true';
  return (process.env.APP_URL || '').startsWith('https://');
}

function authRequired(): boolean {
  return !!process.env.APP_PASSWORD;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/',
  };
}

// ---- ログイン試行のレート制限 ----
// 個人用なのでIP単位のインメモリカウンタで足りる。
const MAX_FAILURES = 5;
const LOCK_MS = 1000 * 60 * 15; // 15分
const FAILURE_WINDOW_MS = 1000 * 60 * 15;

interface Attempt {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}
const attempts = new Map<string, Attempt>();

function clientKey(req: Request): string {
  // trust proxy が有効なら req.ip は X-Forwarded-For を解決した値になる
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** ロック中なら残り秒数、そうでなければ 0 */
function lockedFor(key: string): number {
  const a = attempts.get(key);
  if (!a) return 0;
  const remain = a.lockedUntil - Date.now();
  if (remain <= 0) {
    if (a.lockedUntil > 0) attempts.delete(key); // ロック明けで履歴を捨てる
    return 0;
  }
  return Math.ceil(remain / 1000);
}

function recordFailure(key: string): void {
  const nowMs = Date.now();
  const a = attempts.get(key);
  if (!a || nowMs - a.firstFailureAt > FAILURE_WINDOW_MS) {
    attempts.set(key, { failures: 1, firstFailureAt: nowMs, lockedUntil: 0 });
    return;
  }
  a.failures++;
  if (a.failures >= MAX_FAILURES) {
    a.lockedUntil = nowMs + LOCK_MS;
    a.failures = 0;
    a.firstFailureAt = nowMs;
  }
}

function isValidSession(req: Request): boolean {
  const sid = (req as Request & { cookies?: Record<string, string> }).cookies?.sid;
  if (!sid) return false;
  const exp = sessions.get(sid);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

/** APP_PASSWORD 未設定時は素通り（§9） */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authRequired() || isValidSession(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  if (!authRequired()) {
    res.json({ ok: true });
    return;
  }

  const key = clientKey(req);
  const locked = lockedFor(key);
  if (locked > 0) {
    res.status(429).json({
      error: `ログインの試行回数が多すぎます。${Math.ceil(locked / 60)}分ほど待ってからやり直してください`,
      retry_after: locked,
    });
    return;
  }

  const given = String(req.body?.password ?? '');
  const expected = process.env.APP_PASSWORD!;
  // 長さの差で分岐しないよう、両方をHMACで固定長にしてから比較する
  const secret = process.env.SESSION_SECRET || expected;
  const digest = (s: string) => createHmac('sha256', secret).update(s).digest();
  const ok = timingSafeEqual(digest(given), digest(expected));

  if (!ok) {
    recordFailure(key);
    res.status(401).json({ error: 'パスワードが違います' });
    return;
  }

  attempts.delete(key);
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  res.cookie('sid', sid, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  const sid = (req as Request & { cookies?: Record<string, string> }).cookies?.sid;
  if (sid) sessions.delete(sid);
  res.clearCookie('sid', cookieOptions());
  res.json({ ok: true });
});

authRouter.get('/session', (req, res) => {
  res.json({ authenticated: !authRequired() || isValidSession(req), authRequired: authRequired() });
});
