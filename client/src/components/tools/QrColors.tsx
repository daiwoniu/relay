import { useId, useRef, useState } from 'react';
import { hasReadableQrColors, isQrColor, qrHslToHex } from './qr-colors';
import Tooltip from '../ui/Tooltip';

const hues = [0, 35, 135, 200, 265, 330];
export const QR_CONNECTED_BORDER = 'color-mix(in srgb, var(--color-primary) 20%, var(--color-border))';
export const QR_COLOR_PALETTE = ['#000000', '#333333', '#666666', '#999999', '#cccccc', '#ffffff',
  '#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff',
  ...[12, 28, 45, 62, 80, 95].flatMap((lightness) => hues.map((hue) => qrHslToHex([hue, 75, lightness])))];

export function QrExpansionBridge({ leftEdge = false, rightEdge = false }: { leftEdge?: boolean; rightEdge?: boolean }) {
  return <span aria-hidden="true" data-qr-expansion-bridge="" className="pointer-events-none absolute -inset-x-px bottom-[calc(-0.75rem-1px)] h-[calc(0.75rem+2px)] border-x border-current bg-[var(--color-bg)]" style={{ color: QR_CONNECTED_BORDER }}>
    {(['left', 'right'] as const).map((side) => (side === 'left' ? leftEdge : rightEdge) ? null : <svg key={side} width="13" height="13" viewBox="0 0 13 13" fill="none" className={`absolute bottom-0 ${side === 'right' ? '-right-[13px] -scale-x-100' : '-left-[13px]'}`}><path d="M0 12.5A12.5 12.5 0 0 0 12.5 0H13V13H0Z" fill="var(--color-bg)" /><path d="M0 12.5A12.5 12.5 0 0 0 12.5 0" stroke="currentColor" strokeWidth="1" /></svg>)}
  </span>;
}

export function QrColorPanel({ id, label, value, colors, onChange, onClose, connectedSide }: {
  id: string; label: string; value: string; colors: readonly string[]; onChange: (value: string) => void; onClose: () => void; connectedSide?: 'left' | 'right';
}) {
  const [draft, setDraft] = useState(() => ({ source: value, hex: value }));
  const current = draft.source === value ? draft : { source: value, hex: value };
  function pick(hex: string) {
    setDraft({ source: hex, hex });
    onChange(hex);
  }
  return <div id={id} role="group" aria-label={`${label}选色面板`} style={{ borderColor: connectedSide ? QR_CONNECTED_BORDER : undefined }} className={`space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 ${connectedSide === 'left' ? 'rounded-tl-none' : connectedSide === 'right' ? 'rounded-tr-none' : ''}`}>
    <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{label}颜色</span><button type="button" onClick={onClose} className="min-h-10 rounded-lg px-3 text-sm text-[var(--color-primary)] hover:bg-[var(--color-bg-tertiary)]">收起</button></div>
    <div role="group" aria-label="调色板" className="grid grid-cols-6 gap-1.5">{colors.map((hex) => {
      const selected = value.toLowerCase() === hex;
      return <Tooltip key={hex} content={hex} asChild><button type="button" aria-label={`选择${hex}`} aria-pressed={selected} onClick={() => pick(hex)} style={{ background: hex, color: hasReadableQrColors('#000000', hex) ? '#000000' : '#ffffff' }} className={`flex min-h-10 min-w-0 items-center justify-center rounded-md border border-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] ${selected ? 'ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--color-bg)]' : 'hover:ring-2 hover:ring-[var(--color-primary)]'}`}>{selected && <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10" /></svg>}</button></Tooltip>;
    })}</div>
    <details className="text-sm"><summary className="w-fit cursor-pointer py-2 text-[var(--color-text-secondary)]">更多颜色</summary><label className="mt-2 flex items-center gap-3 text-sm"><span className="shrink-0">色值</span><input aria-label={`${label}十六进制色值`} type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={7} value={current.hex} aria-invalid={!isQrColor(current.hex.startsWith('#') ? current.hex : `#${current.hex}`)} onChange={(event) => {
      const text = event.target.value;
      const hex = (text.startsWith('#') ? text : `#${text}`).toLowerCase();
      if (isQrColor(hex)) { setDraft({ source: hex, hex: text }); onChange(hex); }
      else setDraft({ ...current, source: value, hex: text });
    }} onBlur={() => setDraft({ source: value, hex: value })} className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 font-mono text-base focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] sm:text-sm" /></label></details>
  </div>;
}

export default function QrColors({ foreground, background, onForeground, onBackground }: {
  foreground: string; background: string; onForeground: (value: string) => void; onBackground: (value: string) => void;
}) {
  const [active, setActive] = useState<'foreground' | 'background' | null>(null);
  const id = useId();
  const foregroundRef = useRef<HTMLButtonElement>(null), backgroundRef = useRef<HTMLButtonElement>(null);
  const choices = [
    { key: 'foreground' as const, label: '二维码', value: foreground, ref: foregroundRef },
    { key: 'background' as const, label: '背景', value: background, ref: backgroundRef },
  ];
  const selected = choices.find((choice) => choice.key === active);
  function close() { setActive(null); selected?.ref.current?.focus({ preventScroll: true }); }
  return <div className="space-y-3" onKeyDown={(event) => { if (event.key === 'Escape' && active) { event.stopPropagation(); close(); } }}>
    <p className="text-sm">自定义颜色</p><div className="grid grid-cols-2 gap-3">{choices.map((choice) => <button key={choice.key} ref={choice.ref} type="button" aria-label={`${choice.label}颜色`} aria-expanded={active === choice.key} aria-controls={id} onClick={() => setActive(active === choice.key ? null : choice.key)} style={{ borderColor: active === choice.key ? QR_CONNECTED_BORDER : undefined }} className={`relative flex min-w-0 items-center gap-3 border bg-[var(--color-bg)] p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] ${active === choice.key ? 'z-[1] rounded-t-xl border-b-0' : 'rounded-xl border-[var(--color-border)] hover:border-[var(--color-primary)]'}`}><span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-lg border border-black/10" style={{ background: choice.value }} /><span className="min-w-0"><span className="block text-sm">{choice.label}</span><span className="block text-xs text-[var(--color-text-secondary)]">{active === choice.key ? '正在选色' : '点击选色'}</span></span>{active === choice.key && <QrExpansionBridge leftEdge={choice.key === 'foreground'} rightEdge={choice.key === 'background'} />}</button>)}</div>
    {selected && <QrColorPanel key={active} id={id} label={selected.label} value={selected.value} colors={QR_COLOR_PALETTE} onChange={active === 'foreground' ? onForeground : onBackground} onClose={close} connectedSide={active === 'foreground' ? 'left' : 'right'} />}
  </div>;
}
