import { useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
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
}: {
  value: string;
  name?: string;
  className?: string;
}) {
  if (value && isImageAvatar(value)) {
    return (
      <span className={className}>
        <img src={value} alt={name ?? ''} />
      </span>
    );
  }
  return <span className={className}>{value || name?.slice(0, 1) || <Icon.person />}</span>;
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

// ---- レイアウト ----

export function TopBar({
  title,
  sub,
  back,
  actions,
}: {
  title: string;
  sub?: string;
  /** 戻り先。省略時は履歴を1つ戻る */
  back?: string;
  actions?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <button
        className="icon-btn"
        onClick={() => (back ? navigate(back) : navigate(-1))}
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
