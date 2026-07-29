# Character Chat — ビジュアルノベル風AIチャットPWA

仕様書 v1.4 に基づく個人向けのチャットノベル風ロールプレイアプリ。
React + TypeScript + Vite / Express 5 + SQLite / OpenRouter。

## 実装状況（Phase 1〜7 完了）

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 認証 / DB / World・Character・Persona・Scenario・Chat のCRUD | ✅ |
| 2 | プロンプト組み立て / OpenRouter / SSE / 発話パース / 表示 | ✅ |
| 3 | ロアブック（キーワード発火 + 再帰 + 予算）/ 要約 / メモリー / V2取り込み | ✅ |
| 4 | ステート（時刻・場所・state_after）/ 現在の状況ブロック / ステート編集UI | ✅ |
| 5 | 営業時間・終電判定 / 場所・季節タグ発火 / 天候のアプリ管理 / separate_call抽出 | ✅ |
| 6 | 再生成・候補・編集・分岐（fork）/ オートプレイ / 書き出し・取り込み | ✅ |
| 7 | pendingイベント / PWA | ✅ |

- 書き出し: 世界一式（独自JSON・往復可）/ キャラクター（Character Card V2）/
  ロアブック（V2 character_book）/ 会話（JSON: 候補含む・テキスト）
- オートプレイ: `▶▶` ボタン。`autoplay_steps` 上限、`autoplay_judge` ONで
  区切り判定（CONTINUE/STOP）により自動停止
- pendingイベント: `/worlds/:id/events` で条件（month/week/weekday/time_after等）・
  trigger（once / once_per_year / cooldown）・注入文を編集

## セットアップ

```bash
npm install
cp .env.example .env   # OPENROUTER_API_KEY 等を設定
```

### 開発

```bash
npm run dev
# server: http://localhost:3000 (API)
# client: http://localhost:5173 (Vite dev server、/api はプロキシ)
```

### 本番（VPS）

```bash
npm run build
npm start              # Expressが client/dist を静的配信
```

`.env` の `APP_PASSWORD` を必ず設定してください（未設定だと認証が無効になります）。
DBは `DB_PATH`（既定 `./data/app.sqlite`）の1ファイルです。バックアップはこのファイルの
コピーで完了します。

### 環境変数

| キー | 説明 |
|---|---|
| `OPENROUTER_API_KEY` | 必須。サーバ側のみが保持しブラウザには渡さない |
| `APP_PASSWORD` | 公開VPSでは必須。単一パスワード + httpOnly Cookieセッション |
| `SESSION_SECRET` | ランダムな長い文字列 |
| `DEFAULT_MODEL` / `UTILITY_MODEL` | 既定 `anthropic/claude-opus-5` / `anthropic/claude-sonnet-5` |
| `PORT` / `DB_PATH` / `APP_URL` / `APP_TITLE` | 任意 |

## 構成

```
shared/types.ts       API境界の共有型定義
server/src/
  db/                 schema.sql / マイグレーション / repo（テーブルごと）
  domain/             calendar（暦・唯一の時刻演算所）/ state / lorebook / summary / memory
  llm/                openrouter（SSE）/ prompt（§6組み立て）/ parse（発話+STATEフェンス）
  routes/             APIルート
client/src/
  pages/              画面（URLベースルーティング）
  public/fonts/       Zen Maru Gothic 自前ホスト（unicode-range分割woff2 / OFL）
```

## 初期データ

初回起動時にDBが空の場合、「ヴェイン古書店の世界」（場所10件 + 既定の暦・天候テーブル）が
投入されます。キャラクター・ロアは空なので、UIから登録するか、
V2カード（`chara_card_v2`）/ V2 `character_book` JSON を取り込んでください。

## 仕様書からの主な調整点

- 「⚠ +Xh」バッジ: 24時間超の経過を検知してステートバーに表示し、タップでステート編集
  パネルへ遷移する（ワンタップ取り消しではなく手動修正で対応）
- 準レギュラーの自動参加は「提案」（確認ダイアログ → 承認で参加者に追加）
- ステート編集の年月日・時分はサーバ側で通算分へ変換（時刻演算の calendar.ts 一本化を維持）
- 暦編集UI・イベント条件はJSONエディタ形式
- 過去メッセージの候補閲覧（めくり）は未対応。過去分の確定操作は「ここから分岐」に集約
- イベント発火履歴はチャット単位で記録。regenerate では既発火イベントは再注入されない
- 世界取り込み時、場所IDが既存と衝突する場合は `_2` 等の接尾辞を付けて自動リマップ
