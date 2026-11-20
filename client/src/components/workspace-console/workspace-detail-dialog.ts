/** Keyboard and scroll lifecycle shared by all workbench detail drawers. */
export function activateDetailDialog(panel:HTMLElement,body:HTMLElement,viewKey:string,positions:Map<string,number>|undefined,onClose:()=>void) {
  const doc=panel.ownerDocument,previous=doc.activeElement as HTMLElement|null;
  body.scrollTop=positions?.get(viewKey)??0;
  panel.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
  const onKey=(event:KeyboardEvent)=>{
    if(event.defaultPrevented)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key!=='Tab')return;
    const items=[...panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],select:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')].filter(item=>item.getClientRects().length>0);
    const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&(doc.activeElement===first||!panel.contains(doc.activeElement))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&(doc.activeElement===last||!panel.contains(doc.activeElement))){event.preventDefault();first?.focus();}
  };
  doc.addEventListener('keydown',onKey,true);
  return (restoreFocus=true)=>{positions?.set(viewKey,body.scrollTop);doc.removeEventListener('keydown',onKey,true);if(restoreFocus&&previous?.isConnected&&typeof previous.focus==='function')previous.focus();};
}
