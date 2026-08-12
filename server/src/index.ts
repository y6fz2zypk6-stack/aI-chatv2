// .env の読み込み。**最上段の副作用importであることに意味がある**（env.ts の説明を参照）。
// ESMは本体より先に全importを評価するので、ここを本体側の呼び出しに変えると
// 下の './db/index.js' が DB_PATH 未設定のままDBを開いてしまう
import './env.js';
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

// 待ち受けるインターフェース。既定は全インターフェース（0.0.0.0）。
// Tailscale などVPN内だけに公開する場合は BIND=127.0.0.1 にして、
// tailscale serve 等のフロント側からループバックへ繋ぐ。
// identity ヘッダを信用する構成にするなら、偽装を防ぐためループバック固定が必須。
const bind = (process.env.BIND || '').trim();
const publiclyBound = !bind || bind === '0.0.0.0' || bind === '::';

/**
 * 全インターフェースに出しながらパスワードを設定していない構成は、待ち受ける前に止める（§16）。
 *
 * 警告ログだけでは、設定ミスに気づくのが「誰かに使われたあと」になる。
 * 漏れるのは会話だけでなく OpenRouter の利用権（＝請求）でもあるので、既定を安全側に倒す。
 *
 * 止まらない構成は3つ:
 *   - APP_PASSWORD を設定する
 *   - BIND で到達範囲を絞る（127.0.0.1 / Tailscale のアドレス）
 *   - ALLOW_UNAUTHENTICATED=1 を明示する（承知のうえで無認証にする場合）
 */
function refuseUnsafeStart(): boolean {
  if (!publiclyBound) return false;
  if (process.env.APP_PASSWORD) return false;
  if (process.env.ALLOW_UNAUTHENTICATED === '1') {
    console.warn(
      '[server] 警告: ALLOW_UNAUTHENTICATED=1 のため、認証なしで全インターフェースに公開します',
    );
    return false;
  }
  console.error(
    [
      '[server] 起動を中止しました: 認証なしで全インターフェースに公開しようとしています。',
      '  次のいずれかを設定してください。',
      '    APP_PASSWORD=<パスワード>      パスワードで保護する',
      '    BIND=127.0.0.1                到達範囲をこのホストだけに絞る（Tailscale等の背後に置く場合）',
      '    ALLOW_UNAUTHENTICATED=1       承知のうえで無認証のまま公開する',
    ].join('\n'),
  );
  return true;
}

const onListen = (): void => {
  console.log(`[server] ${bind || '0.0.0.0'}:${port} で待ち受けています`);
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[server] 警告: OPENROUTER_API_KEY が未設定です。生成機能は動作しません');
  }
  if (publiclyBound) {
    console.warn(
      '[server] 注意: 全インターフェースで待ち受けています。' +
        'VPN内だけに公開する場合は BIND=127.0.0.1 を設定してください',
    );
  }
  if (!process.env.APP_PASSWORD) {
    if (publiclyBound) {
      console.warn(
        '[server] 警告: APP_PASSWORD が未設定のまま外部に公開されています。' +
          'パスワードを設定するか BIND でアクセス元を絞ってください',
      );
    } else {
      console.warn(
        `[server] APP_PASSWORD が未設定です。${bind} に到達できる相手は認証なしで操作できます`,
      );
    }
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
};

if (refuseUnsafeStart()) process.exit(1);

// listen(port, host) は host を渡すとそのインターフェースだけに絞られる
const server = bind ? app.listen(port, bind, onListen) : app.listen(port, onListen);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRNOTAVAIL') {
    console.error(
      `[server] BIND=${bind} のアドレスがこのホストに存在しません。` +
        'ip addr で確認してください（Tailscale未起動の可能性があります）',
    );
  } else if (err.code === 'EADDRINUSE') {
    console.error(`[server] ポート ${port} は既に使われています`);
  } else {
    console.error('[server] 起動に失敗しました:', err.message);
  }
  process.exit(1);
});
