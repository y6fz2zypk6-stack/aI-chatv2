# Character Chat — ビジュアルノベル風AIチャットPWA

仕様書 v1.4 + 追補 v1.5.3 に基づく個人向けのチャットノベル風ロールプレイアプリ。
React + TypeScript + Vite / Express 5 + SQLite / OpenRouter。

## 実装状況（Phase 1〜7 + v1.5.3 完了）

| Phase | 内容 | 状態 |
|---|---|---|
| 1 | 認証 / DB / World・Character・Persona・Scenario・Chat のCRUD | ✅ |
| 2 | プロンプト組み立て / OpenRouter / SSE / 発話パース / 表示 | ✅ |
| 3 | ロアブック（キーワード発火 + 再帰 + 予算）/ 要約 / メモリー / V2取り込み | ✅ |
| 4 | ステート（時刻・場所・state_after）/ 現在の状況ブロック / ステート編集UI | ✅ |
| 5 | 営業時間・終電判定 / 場所・季節タグ発火 / 天候のアプリ管理 / separate_call抽出 | ✅ |
| 6 | 再生成・候補・編集・分岐（fork）/ オートプレイ / 書き出し・取り込み | ✅ |
| 7 | pendingイベント / PWA | ✅ |
| v1.5.3 | 進行フラグ（state.vars）/ 条件式DSL / 確率・チェック方式・優先度つきイベント | ✅ |

- チャット内でモデルを切替（ヘッダーのピル）。候補は `shared/types.ts` の `CURATED_MODELS`
- キャラクター・ペルソナのアイコンは画像をアップロード可能（丸枠のカメラバッジから）
- 書き出し: 世界一式（独自JSON・往復可）/ キャラクター（Character Card V2）/
  ロアブック（V2 character_book）/ 会話（JSON: 候補含む・テキスト）
- オートプレイ: `▶▶` ボタン。`autoplay_steps` 上限、`autoplay_judge` ONで
  区切り判定（CONTINUE/STOP）により自動停止
- 条件付きイベント: `/worlds/:id/events` で条件式（`when`）・チェック方式（`check`）・
  トリガー・確率・優先度・注入区分（事実／演出指示）・`set_vars` を編集。
  `/worlds/:id/events/evaluate` で最新のチャットに対する判定結果（どの段階で落ちたか）を確認できる
- 進行フラグ: 世界ごとに `vars_schema` でキーを定義し、会話の `state.vars` で保持。
  AIの `set_var:`・イベントの `set_vars`・手動編集の3経路で更新（権限は経路ごとに異なる）

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

### テスト

```bash
npm test
```

2段構成です。

1. `test/migrate.mjs` — 最古のスキーマのDBを作り、マイグレーション1〜3を通して
   seq採番・候補indexの採番し直し・`initial_state` のバックフィル・旧 `condition` の
   `when` への移行・`event_fires` の作り直しを検証します（冪等性も確認）
2. `test/run.mjs` — ステート・候補（variant）・再生成・分岐、および進行フラグと
   条件付きイベントを検証します

OpenRouter互換のモックを立てて応答内容（経過分・場所・`set_var`・STATEフェンスの欠落や
切断）を決定論的に与え、実APIを叩いて確認します。実行には `OPENROUTER_API_KEY` は不要で、
既存のDBには触りません。

### 本番（VPS）

```bash
npm run build
npm start              # Expressが client/dist を静的配信
```

`.env` の `APP_PASSWORD` を必ず設定してください（未設定だと認証が無効になります）。
HTTPSで公開する場合は `COOKIE_SECURE=1`、リバースプロキシ配下なら併せて `TRUST_PROXY=1` を
設定してください（未設定だと起動時に警告が出ます）。ログインは同一IPから5回失敗すると
15分ロックされます。

DBは `DB_PATH`（既定 `./data/app.sqlite`）の1ファイルです。バックアップはこのファイルの
コピーで完了します。スキーマは起動時に自動マイグレーションされます。

### 環境変数

| キー | 説明 |
|---|---|
| `OPENROUTER_API_KEY` | 必須。サーバ側のみが保持しブラウザには渡さない |
| `APP_PASSWORD` | 公開VPSでは必須。単一パスワード + httpOnly Cookieセッション |
| `SESSION_SECRET` | ランダムな長い文字列 |
| `COOKIE_SECURE` | 認証Cookieに `Secure` を付ける。未設定なら `APP_URL` が https:// のときだけ有効 |
| `TRUST_PROXY` | リバースプロキシ配下で `X-Forwarded-*` を信頼する段数（nginx等の背後なら `1`）。ログイン制限のIP判定に必要 |
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
  theme.css           デザイントークン（配色・角丸・チャット13変数）
  icons.tsx           Lucide準拠のインラインSVG。絵文字は使わない
  components.tsx      アバター・トップバー・トグル・ステッパー等の共通部品
  public/fonts/       Zen Maru Gothic / Noto Sans JP / Archivo（unicode-range分割woff2 / OFL）
```

## デザイン

見出し・UIは Zen Maru Gothic、本文は Noto Sans JP、数字とラベルは Archivo。
白ベースに淡い暖色の面（`--surface-2`）を重ね、枠線はヘアラインのみ。アクセントは
オレンジ（`--accent: #e9834b`）で、ユーザー吹き出しと主要ボタンにだけ使う。
アイコンは全て線画のインラインSVG。ナレーションは吹き出しを持たず、ハート付きの独立行にする。

アバター画像はクライアント側で正方形に切り出し320pxへ縮小、WebPのdata URLとして
`avatar` 列に保存する（DBを1ファイルに保ち、書き出しにも画像が含まれる）。

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
- イベントの判定は**assistantの生成が完了して `state_after` が確定した直後**に走り、
  注入は**次のターン**のプロンプトに載る（v1.5.3 §6。v1.4 の「生成前に判定して同じターンに注入」
  から変更）。停止した生成では判定しない
- イベント発火履歴はチャット単位で記録。regenerate は対象メッセージの発火記録を削除して
  から判定し直す。fork は分岐点までの発火記録を引き継ぐ
- イベントの抽選と天候はシード固定（`chatId:eventId:drawKey`）。再生成しても結果が変わらない。
  スコープを持つ trigger では `drawKey` を `scopeKey` で置き換える（連結しない）
- 進行フラグの `private_note` はプロンプトに一切載せない（作者向けのメモ欄）
- `update_mode: system_only` のキーはLLMの `set_var` を破棄し警告を返す。イベントの
  `set_vars` と手動編集からは更新できる（手動編集のみ `monotonic` も無視できる救済手段）
- 世界取り込み時、場所IDが既存と衝突する場合は `_2` 等の接尾辞を付けて自動リマップ
- 場所のエリアは `worlds.areas`（`[{id, name}]`）で世界ごとに持つ。`id` は `locations.area` と
  イベント条件の `location_area` から参照されるため作成後は不変で、アプリから変えられるのは
  `name` と並び順のみ（リネームで参照が壊れるのを避けるため）。使用中のエリアは削除できない。
  変更は `PUT /worlds/:id/areas` 専用ルートのみで、汎用の `PUT /worlds/:id` からは変更できない
- 会話の順序は `messages.seq`（チャット内連番）が正で、ULIDの時系列性には依存しない。
  `UNIQUE(chat_id, seq)` と `UNIQUE(message_id, index)` をDB側で保証している
- `chats.initial_state` にChat作成時の初期ステートを保持する。先頭メッセージの再生成の
  基準と、全メッセージ削除時の復元に使う（シナリオを参照しないので、シナリオを編集・
  削除しても既存Chatの挙動が変わらない）
- 要約・知識抽出の境界は `up_to_seq` / `extracted_up_to_seq` で持つ（境界のメッセージを
  削除しても範囲が壊れない）
- pendingイベントの発火記録は `generation_status = complete` のときのみ。途中で停止した
  生成では記録せず、次のターンで改めて発火判定する
