import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { computeFloatingPosition } from '../ui/floating-position';
import type { HostedSite } from '../../generated/relay-contracts';

export default function HostingMoreMenu({ site, anchor, onClose, onAction }: {
  site: HostedSite;
  anchor: HTMLButtonElement;
  onClose: () => void;
  onAction: (action: 'update' | 'rename' | 'toggle' | 'delete') => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<{left:number;top:number} | null>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = anchor.getBoundingClientRect(), size = menu.getBoundingClientRect();
    const point = computeFloatingPosition(rect, size, {width:window.innerWidth,height:window.innerHeight}, {preferredPlacement:'bottom',gap:5,padding:8});
    setPosition({...point,left:point.placement==='bottom'||point.placement==='top'?Math.max(8,Math.min(rect.right-size.width,window.innerWidth-size.width-8)):point.left});
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  }, [anchor]);
  useEffect(() => {
    const menu=menuRef.current;
    const outside = (event:PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !anchor.contains(event.target)) closeRef.current();
    };
    const scroll = (event:Event) => { if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) closeRef.current(); };
    const close = () => closeRef.current();
    document.addEventListener('pointerdown',outside);
    window.addEventListener('scroll',scroll,true);
    window.addEventListener('resize',close);
    return () => {
      document.removeEventListener('pointerdown',outside);
      window.removeEventListener('scroll',scroll,true);
      window.removeEventListener('resize',close);
      if (anchor.isConnected && (document.activeElement===document.body || menu?.contains(document.activeElement))) anchor.focus();
    };
  }, [anchor]);
  return createPortal(<div ref={menuRef} role="menu" aria-label={`${site.name}的更多操作`} className="hosting-more-menu" style={{...position,visibility:position?'visible':'hidden'}} onKeyDown={event=>{
    if (event.key==='Escape'||event.key==='Tab') {event.preventDefault();event.stopPropagation();onClose();anchor.focus();return;}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();event.stopPropagation();
    const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],index=buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();
  }}>
    <button type="button" role="menuitem" onClick={()=>onAction('update')}>更新内容</button>
    <button type="button" role="menuitem" onClick={()=>onAction('rename')}>重命名</button>
    <button type="button" role="menuitem" onClick={()=>onAction('toggle')}>{site.enabled?'停用':'启用'}</button>
    <button type="button" role="menuitem" className="hosting-danger" onClick={()=>onAction('delete')}>删除</button>
  </div>,document.body);
}
