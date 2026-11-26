import { useRef, useState } from 'react';

type ChatType = '' | 'group' | 'p2p';
type ChatOption = { id: string; label: string; chatType?: Exclude<ChatType, ''> };
const ranges = [[1, '24 小时'], [7, '7 天'], [30, '30 天'], [90, '90 天']] as const;
const types = [['', '全部'], ['group', '群聊'], ['p2p', '私聊']] as const;

function ConversationPicker({ chat, options, onSelect }: { chat: string; options: ChatOption[]; onSelect: (id: string) => void }) {
  const dropdown = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const search = query.trim().toLocaleLowerCase();
  const matches = options.filter(item => item.label.toLocaleLowerCase().includes(search) || item.id.toLocaleLowerCase().includes(search));
  const label = options.find(item => item.id === chat)?.label ?? '具体会话';
  function close(restoreFocus: boolean) {
    if (dropdown.current) dropdown.current.open = false;
    if (restoreFocus) trigger.current?.focus();
  }
  function choose(id: string) {
    if (id !== chat) onSelect(id);
    close(true);
  }
  return <details className="feishu-chat-picker" ref={dropdown}
    onToggle={event => { if (event.currentTarget.open) input.current?.focus(); else setQuery(''); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(false); }}
    onKeyDown={event => { if (event.key === 'Escape' && dropdown.current?.open) { event.preventDefault(); close(true); } }}>
    <summary ref={trigger} title={label}>{label}</summary>
    <div className="feishu-chat-picker-menu">
      <input ref={input} type="search" aria-label="搜索群聊或私聊" placeholder="搜索群聊或私聊"
        value={query} onChange={event => setQuery(event.target.value)} />
      <button type="button" aria-pressed={!chat} onClick={() => choose('')}>全部会话</button>
      {matches.length ? <ul>{matches.map(item => <li key={item.id}>
        <button type="button" aria-pressed={chat === item.id} onClick={() => choose(item.id)}>
          <span>{item.label}</span>{item.chatType && <small>{item.chatType === 'group' ? '群聊' : '私聊'}</small>}
        </button>
      </li>)}</ul> : <p role="status">{search ? '没有匹配的会话' : '暂无会话'}</p>}
    </div>
  </details>;
}

export default function FeishuStatsFilters({ days, fixedRange, chatType, chat, options, onRange, onType, onChat }: {
  days: number; fixedRange?: string; chatType: ChatType; chat: string; options: ChatOption[] | null;
  onRange: (days: number) => void; onType: (type: ChatType) => void; onChat: (id: string) => void;
}) {
  return <>
    <div className="feishu-filter-segments" role="group" aria-label="时间范围">
      {ranges.map(([value, label]) => <button key={value} type="button" aria-pressed={!fixedRange && days === value}
        onClick={() => { if (fixedRange || days !== value) onRange(value); }}>{label}</button>)}
    </div>
    {fixedRange && <small>{fixedRange}</small>}
    <div className="feishu-filter-segments" role="group" aria-label="会话类型">
      {types.map(([value, label]) => <button key={value} type="button" aria-pressed={chatType === value}
        onClick={() => { if (chatType !== value) onType(value); }}>{label}</button>)}
    </div>
    {options && <ConversationPicker chat={chat} options={options} onSelect={onChat} />}
  </>;
}
