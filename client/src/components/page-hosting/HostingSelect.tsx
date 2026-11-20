import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface HostingOption { value: string; label: string; description?: string; icon?: ReactNode; disabled?: boolean }

export default function HostingSelect({ label, value, options, onChange, disabled = false, placeholder = '请选择' }: {
  label: string; value: string; options: HostingOption[]; onChange: (value: string) => void; disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [placement, setPlacement] = useState({ up: false, height: 240 });
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const selected = options.find(option => option.value === value);
  const optionVersion=JSON.stringify(options.map(option=>[option.value,Boolean(option.disabled)]));
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);setOpen(false);trigger.current?.focus({ preventScroll: true });
  };
  const show = () => {const selectedIndex=options.findIndex(option=>option.value===value&&!option.disabled);setActive(Math.max(0,selectedIndex>=0?selectedIndex:options.findIndex(option=>!option.disabled)));search.current={text:'',time:0};setOpen(true);};
  useLayoutEffect(() => setOpen(false), [disabled, optionVersion, value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {if (!root.current?.contains(event.target as Node)) setOpen(false);};
    const scroll = (event: Event) => {if (!list.current?.contains(event.target as Node)) setOpen(false);};
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', scroll, true);
    return () => {document.removeEventListener('pointerdown', outside);window.removeEventListener('scroll', scroll, true);};
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const measure = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const dialog = root.current?.closest('[role="dialog"]')?.getBoundingClientRect();
      const viewport = window.visualViewport;
      const bottom = Math.min((viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 12, dialog?.bottom ?? Infinity);
      const top = Math.max((viewport?.offsetTop ?? 0) + 12, dialog?.top ?? 0);
      const below = bottom - rect.bottom - 8, above = rect.top - top - 8;
      const up = below < 180 && above > below;
      setPlacement({ up, height: Math.max(72, Math.min(240, up ? above : below)) });
    };
    measure();window.addEventListener('resize', measure);window.visualViewport?.addEventListener('resize', measure);
    return () => {window.removeEventListener('resize', measure);window.visualViewport?.removeEventListener('resize', measure);};
  }, [open, options.length]);
  useEffect(() => {
    if (!open || !list.current) return;
    const element=list.current.querySelector<HTMLElement>(`[data-option-index="${active}"]`);
    if (!element) return;
    const top=element.offsetTop,bottom=top+element.offsetHeight;
    if(top<list.current.scrollTop)list.current.scrollTop=top;
    else if(bottom>list.current.scrollTop+list.current.clientHeight)list.current.scrollTop=bottom-list.current.clientHeight;
  }, [open, active]);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {event.preventDefault();event.stopPropagation();setOpen(false);return;}
    if (event.key === 'Tab') {setOpen(false);return;}
    if (event.key === 'Enter' || event.key === ' ') {event.preventDefault();if (open) choose(active);else show();return;}
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        show();
        if(event.key==='Home')setActive(Math.max(0,options.findIndex(option=>!option.disabled)));
        if(event.key==='End'){for(let index=options.length-1;index>=0;index--)if(!options[index].disabled){setActive(index);break;}}
        return;
      }
      const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1;
      let index = event.key === 'Home' ? -1 : event.key === 'End' ? options.length : active;
      for (let count = 0; count < options.length; count++) {index = (index + step + options.length) % options.length;if (!options[index].disabled) {setActive(index);break;}}
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();search.current = { text: now - search.current.time < 700 ? search.current.text + event.key : event.key, time: now };
      const index = options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase()));
      if (index >= 0) {event.preventDefault();setOpen(true);setActive(index);}
    }
  };
  return <div className="hosting-field"><span id={`${id}-label`}>{label}</span><div ref={root} className="hosting-select">
    <button ref={trigger} type="button" className="hosting-select-trigger" role="combobox" aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-activedescendant={open ? `${id}-option-${active}` : undefined} disabled={disabled} onKeyDown={keyDown} onClick={() => {if (open) setOpen(false);else show();}}>
      {selected?.icon && <span className="hosting-select-icon" aria-hidden="true">{selected.icon}</span>}
      <span className="hosting-select-copy"><strong id={`${id}-value`}>{selected?.label ?? placeholder}</strong>{selected?.description && <small>{selected.description}</small>}</span>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={open ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
    </button>
    {open && <div ref={list} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className={`hosting-select-list${placement.up ? ' opens-up' : ''}`} style={{ maxHeight: placement.height }}>
      {options.map((option, index) => <button key={option.value} id={`${id}-option-${index}`} type="button" role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined} disabled={option.disabled} tabIndex={-1} data-option-index={index} data-active={index === active} onPointerMove={event => {if(event.pointerType!=='touch'&&!option.disabled)setActive(index);}} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        {option.icon && <span className="hosting-select-icon" aria-hidden="true">{option.icon}</span>}
        <span className="hosting-select-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
        {option.value === value && <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </button>)}
    </div>}
  </div></div>;
}
