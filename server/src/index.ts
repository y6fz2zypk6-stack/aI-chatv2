import 'dotenv/config';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DB初期化（import順が重要: db/index.ts がスキーマ適用を行う）
import './db/index.js';
import { seedIfEmpty } from './db/seed.js';

import { authRouter, cookieSecure, requireAuth } from './routes/auth.js';
import { charactersRouter } from './routes/characters.js';
import { chatsRouter } from './routes/chats.js';
import { eventsRouter } from './routes/events.js';
import { exportsRouter } from './routes/exports.js';
import { locationsRouter } from './routes/locations.js';
import { lorebookRouter } from './routes/lorebook.js';
import { messagesRouter } from './routes/messages.js';
import { personasRouter } from './routes/personas.js';
import { scenariosRouter } from './routes/scenarios.js';
import { settingsRouter } from './routes/settings.js';
import { worldsRouter } from './routes/worlds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

seedIfEmpty();

const app = express();

// リバースプロキシ配下では X-Forwarded-* を信頼する必要がある
// （req.ip がログイン制限に、req.protocol が https 判定に効く）。
// TRUST_PROXY に段数（例 1）または 'true' を設定する。既定は無効。
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  const n = Number(trustProxy);
  app.set('trust proxy', Number.isFinite(n) && trustProxy.trim() !== '' ? n : trustProxy);
}

app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// 認証（§9: APP_PASSWORD 未設定時は素通り）
app.use('/api', authRouter);
app.use('/api', requireAuth);

app.use('/api', settingsRouter);
app.use('/api', exportsRouter);
app.use('/api', eventsRouter);
app.use('/api', worldsRouter);
app.use('/api', charactersRouter);
app.use('/api', scenariosRouter);
app.use('/api', chatsRouter);
app.use('/api', messagesRouter);
app.use('/api', lorebookRouter);
app.use('/api', locationsRouter);
app.use('/api', personasRouter);

// クライアント静的配信（§3.1: Expressが dist/ を配信）
const clientDist = [
  path.resolve(__dirname, '../../../../client/dist'), // ビルド後: server/dist/server/src から
  path.resolve(__dirname, '../../client/dist'), // tsx実行時: server/src から
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(process.cwd(), '../client/dist'),
].find((p) => fs.existsSync(path.join(p, 'index.html')));

if (clientDist) {
  app.use(express.static(clientDist));
  // SPAフォールバック（URLベースルーティングのリロード耐性）
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .send('client/dist が見つかりません。`npm run build` を実行してください（開発時は Vite dev server を使用）');
  });
}

// エラーハンドラ
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[server]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  },
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[server] http://localhost:${port} で起動しました`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[server] 警告: OPENROUTER_API_KEY が未設定です。生成機能は動作しません');
  }
  if (!process.env.APP_PASSWORD) {
    console.warn('[server] 警告: APP_PASSWORD が未設定のため認証が無効です（公開VPSでは必須）');
  } else if (!cookieSecure()) {
    console.warn(
      '[server] 警告: 認証Cookieに secure が付いていません。HTTPS運用時は APP_URL を https:// にするか COOKIE_SECURE=1 を設定してください',
    );
  }
  if (cookieSecure() && !trustProxy) {
    console.warn(
      '[server] 注意: リバースプロキシ経由の場合は TRUST_PROXY=1 を設定してください（未設定だとIP判定が正しく働きません）',
    );
  }
});
