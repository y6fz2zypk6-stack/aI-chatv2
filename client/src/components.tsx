import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReferenceMeta } from '@shared/types';
import { api, ApiError } from './api';
import { Icon } from './icons';

// ---- アバター ----

/** avatar 値が画像（data URL / URL / パス）かどうか */
export function isImageAvatar(v: string): boolean {
  return /^(data:image\/|https?:\/\/|\/)/.test(v.trim());
}

export function Avatar({
  value,
  name,
  className = '',
  fallback,
}: {
  value: string;
  name?: string;
  className?: string;
  /**
   * 画像もアバター値も無いときに、頭文字の代わりに出すもの。
   * その場限りのモブのように「頭文字が手がかりにならない」相手に使う（§7）。
   * 文字をそのままアバターにしている人物を上書きしないよう、`value` より後ろで効く。
   */
  fallback?: ReactNode;
}) {
  if (value && isImageAvatar(value)) {
    return (
      <span className={className}>
        <img src={value} alt={name ?? ''} />
      </span>
    );
  }
  return (
    <span className={className}>{value || fallback || name?.slice(0, 1) || <Icon.person />}</span>
  );
}

/**
 * 画像を正方形にトリミングし、最大 max px へ縮小した data URL を返す。
 * DBを1ファイルに保つため、画像はファイルではなく avatar 列へ埋め込む。
 */
export async function fileToAvatarDataUrl(file: File, max = 320): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(side, max);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();
  // WebPが使えれば優先（同画質でJPEGより小さい）
  const webp = canvas.toDataURL('image/webp', 0.85);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * 長辺を max に収めて縮小した data URL を返す。**切り抜かない。**
 *
 * `fileToAvatarDataUrl` とはあえて分けてある。あちらは丸アイコン用の
 * 正方形クロップが本質で、こちらは**全身や服装を渡す**のが目的なので、
 * 切り抜きの有無を共通化すると片方の都合がもう片方へ漏れる（§21.4）。
 */
export async function fileToReferenceDataUrl(file: File, max = 1024): Promise<string> {
  // スマホ写真の回転（EXIF）を反映する。アバター側は既存の見え方を変えたくないので触らない
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  // 元が小さければ拡大しない。粗い画像を引き伸ばしても情報は増えない
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // 参照に使うので、アバター（0.85）より品質を上げる
  const webp = canvas.toDataURL('image/webp', 0.92);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', 0.92);
}

/** 名前欄の左に置く、丸いアイコン枠＋カメラバッジ。押すと画像を選べる */
export function AvatarPicker({
  value,
  name,
  onChange,
}: {
  value: string;
  name: string;
  onChange: (dataUrl: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="id-av"
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      title="タップして画像を選択"
    >
      <Avatar value={value} name={name} />
      <span className="cam">
        <Icon.camera />
      </span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          onChange(await fileToAvatarDataUrl(file));
        }}
      />
    </div>
  );
}

/** バイト数を読める単位に。アルバムと同じ書式 */
function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 参照用の高画質画像（§21.4）。キャラクターとペルソナの編集画面で使う。
 *
 * **本体の保存とは別に、選んだ時点で保存する。** 通常APIのボディ上限は256kbで、
 * キャラ本体の PUT に画像を混ぜると通らない（専用ルートだけ上限が大きい）。
 */
export function ReferencePicker({
  base,
  onError,
}: {
  /** `/characters/xxx` か `/personas/xxx` */
  base: string;
  onError: (message: string) => void;
}) {
  const [meta, setMeta] = useState<ReferenceMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setMeta(await api.get<ReferenceMeta>(`${base}/reference`));
    } catch (err) {
      // 404は「未設定」。それ以外は黙らせない
      if (err instanceof ApiError && err.status === 404) setMeta(null);
      else onError((err as Error).message);
    }
    // onError は毎描画で作られることがあるので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const data_url = await fileToReferenceDataUrl(file);
      setMeta(await api.put<ReferenceMeta>(`${base}/reference`, { data_url }));
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`${base}/reference`);
      setMeta(null);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="refpick">
      {meta && (
        <div className="shot">
          {/* 差し替えるとIDが変わるので、URLがそのままキャッシュキーになる */}
          <img src={`/api/references/${meta.id}/image`} alt="参照画像" />
        </div>
      )}
      <div className="acts">
        <button className="pill sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Icon.upload size={14} />
          {meta ? '差し替える' : '画像を選ぶ'}
        </button>
        {meta && (
          <>
            <button className="pill sm danger" disabled={busy} onClick={() => void remove()}>
              外す
            </button>
            <span className="n">{bytesLabel(meta.bytes)}</span>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
    </div>
  );
}

// ---- レイアウト ----

export function TopBar({
  title,
  sub,
  back,
  onBack,
  actions,
}: {
  title: string;
  sub?: string;
  /** 戻り先。省略時は履歴を1つ戻る */
  back?: string;
  /**
   * 画面内の状態だけで前の表示に戻す場合に使う（URLが変わらない編集画面など）。
   * 指定したときは back より優先し、遷移は行わない。
   */
  onBack?: () => void;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <button
        className="icon-btn"
        onClick={() => (onBack ? onBack() : back ? navigate(back) : navigate(-1))}
        aria-label="戻る"
      >
        <Icon.back />
      </button>
      <div className="title">
        <b>{title}</b>
        {sub && <span className="sub">{sub}</span>}
      </div>
      {actions}
    </header>
  );
}

export function HomeHead({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="home-head">
      <h1>{title}</h1>
      {actions && <div className="acts">{actions}</div>}
    </div>
  );
}

// ---- フォーム部品 ----

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`toggle${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <span className="knob" />
    </button>
  );
}

export function Check({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`check${on ? ' on' : ''}`}
      onClick={() => onChange(!on)}
      role="checkbox"
      aria-checked={on}
    >
      <Icon.check size={14} />
    </button>
  );
}

export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="stepper">
      <button onClick={() => onChange(clamp(value - step))} aria-label="減らす">
        <Icon.minus />
      </button>
      <input
        className="val"
        type="number"
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
      />
      <button onClick={() => onChange(clamp(value + step))} aria-label="増やす">
        <Icon.plus size={14} />
      </button>
    </div>
  );
}

/**
 * 継承 / ON / OFF の3値トグル（v1.5.3 §9.3）。
 * null は「上位から継承」を表す。
 */
export function TriToggle({
  value,
  onChange,
  inheritedLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  inheritedLabel?: string;
}) {
  const opts: { v: number | null; label: string }[] = [
    { v: null, label: inheritedLabel ? `継承（${inheritedLabel}）` : '継承' },
    { v: 1, label: 'ON' },
    { v: 0, label: 'OFF' },
  ];
  return (
    <div className="row" style={{ gap: 4 }}>
      {opts.map((o) => (
        <span
          key={String(o.v)}
          className={`chip${value === o.v ? ' on' : ''}`}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </span>
      ))}
    </div>
  );
}

/** ラベル＋説明＋右側の操作 を1行にする（設定画面など） */
export function SettingRow({
  label,
  hint,
  sub,
  children,
}: {
  label: string;
  hint?: string;
  sub?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`setting${sub ? ' sub' : ''}`}>
      <div className="txt">
        <label>{label}</label>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="select-wrap">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        <div className="acts">
          <button className="pill sm" onClick={onClose}>
            キャンセル
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** 一覧の1行 */
export function Row({
  avatar,
  avatarTinted,
  name,
  desc,
  stamp,
  onClick,
  actions,
  chevron,
}: {
  avatar?: ReactNode;
  avatarTinted?: boolean;
  name: ReactNode;
  desc?: ReactNode;
  stamp?: string;
  onClick?: () => void;
  actions?: ReactNode;
  chevron?: boolean;
}) {
  return (
    <div className={`chatrow${onClick ? ' tappable' : ''}`} onClick={onClick}>
      {avatar !== undefined && <span className={`av${avatarTinted ? ' tinted' : ''}`}>{avatar}</span>}
      <div className="body">
        <div className="line">
          <span className="nm">{name}</span>
          {stamp && <span className="stamp">{stamp}</span>}
        </div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      {actions && <div className="acts">{actions}</div>}
      {chevron && (
        <span className="chev">
          <Icon.chevR />
        </span>
      )}
    </div>
  );
}
