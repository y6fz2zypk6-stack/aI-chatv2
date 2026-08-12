/**
 * `BIND` の到達範囲の判定（§16.2）。副作用を持たせないこと（テストから直接読む）。
 */

/**
 * そのアドレスへのバインドで「到達範囲が絞れている」と言えるか。
 *
 * **「0.0.0.0 以外なら安全」ではない。** VPSの公開IP（`BIND=203.0.113.10`）を指定すると
 * 全インターフェースではないが公開されている、という状態になる。ここを取り違えると
 * パスワード無しの構成がそのまま起動してしまう。
 *
 * 安全と見なすのは次だけ:
 *   - ループバック（`127.0.0.0/8` / `::1` / `localhost`）
 *   - Tailscale の CGNAT 帯（`100.64.0.0/10`）。tailnet 内からしか届かない
 *
 * LAN のアドレス（`192.168.x.x` など）は含めない。同じLANの他の機器から届くうえ、
 * 「家のLANだから安全」は運用者の判断であって既定にはできない。
 * 解釈できない文字列（ホスト名など）も安全側に倒して「絞れていない」とする。
 */
export function isReachRestricted(bind: string): boolean {
  const raw = (bind ?? '').trim().toLowerCase();
  if (!raw) return false; // 未設定は全インターフェース
  if (raw === 'localhost') return true;

  // [::1]:port 形式で書かれることがあるので括弧を外す
  const v6 = raw.replace(/^\[/, '').replace(/\]$/, '');
  if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1') return true;

  // IPv4射影（::ffff:127.0.0.1）は下のIPv4判定へ回す
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6)?.[1] ?? raw;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;

  if (a === 127) return true; // 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10（Tailscale）
  return false;
}

/** 全インターフェースで待ち受ける指定か（警告文の出し分け用） */
export function bindsAllInterfaces(bind: string): boolean {
  const raw = (bind ?? '').trim();
  return !raw || raw === '0.0.0.0' || raw === '::' || raw === '[::]';
}
