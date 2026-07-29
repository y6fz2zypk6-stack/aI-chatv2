// Lucide 準拠のインラインSVGアイコン。絵文字は使わない。
// stroke を渡すと線画、渡さないと塗り。size は px。

interface Props {
  size?: number;
  className?: string;
}

function Svg({
  size,
  stroke,
  children,
  className,
}: {
  size: number;
  stroke?: number;
  children: React.ReactNode;
  className?: string;
}) {
  const strokeProps = stroke
    ? {
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: stroke,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
      }
    : { fill: 'currentColor' };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...strokeProps}>
      {children}
    </svg>
  );
}

export const Icon = {
  back: ({ size = 20, className }: Props = {}) => (
    <Svg size={size} stroke={2} className={className}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  ),
  chevL: ({ size = 11, className }: Props = {}) => (
    <Svg size={size} stroke={2.6} className={className}>
      <path d="M15 18l-6-6 6-6" />
    </Svg>
  ),
  chevR: ({ size = 15, className }: Props = {}) => (
    <Svg size={size} stroke={2.2} className={className}>
      <path d="M9 18l6-6-6-6" />
    </Svg>
  ),
  chevD: ({ size = 12, className }: Props = {}) => (
    <Svg size={size} stroke={2.6} className={className}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  ),
  plus: ({ size = 24, className }: Props = {}) => (
    <Svg size={size} stroke={2.4} className={className}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  minus: ({ size = 14, className }: Props = {}) => (
    <Svg size={size} stroke={2.4} className={className}>
      <path d="M5 12h14" />
    </Svg>
  ),
  check: ({ size = 18, className }: Props = {}) => (
    <Svg size={size} stroke={2.4} className={className}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  x: ({ size = 11, className }: Props = {}) => (
    <Svg size={size} stroke={2.6} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  send: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} className={className}>
      <path d="M3 20.5l19-8.5L3 3.5l4.3 8.5z" />
    </Svg>
  ),
  square: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} className={className}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </Svg>
  ),
  dots: ({ size = 17, className }: Props = {}) => (
    <Svg size={size} className={className}>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </Svg>
  ),
  heart: ({ size = 13, className }: Props = {}) => (
    <Svg size={size} className={className}>
      <path d="M12 21s-8-5.3-8-11a4.7 4.7 0 0 1 8-3.2A4.7 4.7 0 0 1 20 10c0 5.7-8 11-8 11z" />
    </Svg>
  ),
  play: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} className={className}>
      <path d="M8 5l11 7-11 7z" />
    </Svg>
  ),
  forward: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} className={className}>
      <path d="M4 5l8 7-8 7z" />
      <path d="M13 5l8 7-8 7z" />
    </Svg>
  ),
  castAdd: ({ size = 21, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 5 18.5V20" />
      <circle cx="10.5" cy="8" r="3.5" />
      <path d="M18 11.5h4M20 9.5v4" />
    </Svg>
  ),
  lines: ({ size = 21, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M4 6h16M4 11h16M4 16h10" />
    </Svg>
  ),
  fork: ({ size = 18, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <path d="M6 3v12a3 3 0 0 0 3 3h9" />
      <path d="M15 15l3 3-3 3" />
    </Svg>
  ),
  copy: ({ size = 18, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Svg>
  ),
  trash: ({ size = 18, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </Svg>
  ),
  camera: ({ size = 12, className }: Props = {}) => (
    <Svg size={size} stroke={2} className={className}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h1.8l1-1.6h5.4l1 1.6h1.8A1.5 1.5 0 0 1 18 8.5v8A1.5 1.5 0 0 1 16.5 18h-11A1.5 1.5 0 0 1 4 16.5z" />
      <circle cx="11" cy="12" r="2.6" />
    </Svg>
  ),
  refresh: ({ size = 13, className }: Props = {}) => (
    <Svg size={size} stroke={2.2} className={className}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </Svg>
  ),
  brain: ({ size = 21, className }: Props = {}) => (
    <Svg size={size} stroke={1.7} className={className}>
      <path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 9.5 19a2.5 2.5 0 0 0 2.5-2.5V5z" />
      <path d="M12 5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2A3 3 0 0 1 14.5 19 2.5 2.5 0 0 1 12 16.5V5z" />
    </Svg>
  ),
  bubble: ({ size = 21, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Svg>
  ),
  book: ({ size = 21, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </Svg>
  ),
  bookOpen: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </Svg>
  ),
  charFile: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h6" />
      <circle cx="12" cy="12.5" r="2.2" />
      <path d="M8.6 18.5a3.6 3.6 0 0 1 6.8 0" />
    </Svg>
  ),
  gear: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.2a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.2a2 2 0 0 1 1 1.7V20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.2a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.2a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  person: ({ size = 17, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M19 20v-1.5a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4V20" />
      <circle cx="12" cy="7.5" r="3.5" />
    </Svg>
  ),
  pin: ({ size = 15, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <path d="M12 17v5" />
      <path d="M9 10.8V4h6v6.8l2 3.2H7z" />
    </Svg>
  ),
  pencil: ({ size = 18, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  ),
  download: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <path d="M12 3v12" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M4 20h16" />
    </Svg>
  ),
  upload: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <path d="M12 15V3" />
      <path d="M7.5 7.5L12 3l4.5 4.5" />
      <path d="M4 20h16" />
    </Svg>
  ),
  search: ({ size = 16, className }: Props = {}) => (
    <Svg size={size} stroke={2} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  ),
  globe: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </Svg>
  ),
  pin2: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </Svg>
  ),
  calendar: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </Svg>
  ),
  sparkle: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </Svg>
  ),
  compass: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </Svg>
  ),
  scroll: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2z" />
      <path d="M6 4a2 2 0 0 0-2 2v2h2" />
      <path d="M9.5 9h6M9.5 13h6" />
    </Svg>
  ),
  archive: ({ size = 18, className }: Props = {}) => (
    <Svg size={size} stroke={1.9} className={className}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
      <path d="M10 12h4" />
    </Svg>
  ),
  home: ({ size = 19, className }: Props = {}) => (
    <Svg size={size} stroke={1.8} className={className}>
      <path d="M3 11l9-7 9 7" />
      <path d="M5.5 9.5V20h13V9.5" />
    </Svg>
  ),
};

export type IconName = keyof typeof Icon;
