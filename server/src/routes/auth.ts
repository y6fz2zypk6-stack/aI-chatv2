import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30日

// 個人用のためインメモリセッションで足りる（再起動でログアウト）
const sessions = new Map<string, number>();

function authRequired(): boolean {
  return !!process.env.APP_PASSWORD;
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
  const given = String(req.body?.password ?? '');
  const expected = process.env.APP_PASSWORD!;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ error: 'パスワードが違います' });
    return;
  }
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  res.cookie('sid', sid, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    secure: (process.env.APP_URL || '').startsWith('https'),
  });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  const sid = (req as { cookies?: Record<string, string> }).cookies?.sid;
  if (sid) sessions.delete(sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

authRouter.get('/session', (req, res) => {
  res.json({ authenticated: !authRequired() || isValidSession(req), authRequired: authRequired() });
});
