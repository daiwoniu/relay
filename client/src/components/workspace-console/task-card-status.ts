import type {CardLedger,CardRelation,CardStatus} from './task-card-model.ts';

const normalize=(state:string|null)=>({active:'doing',in_progress:'doing',review:'review_pending',completed:'done',canceled:'cancelled'}[state??'']??state);
const terminal=new Set(['done','closed','cancelled']);
const acceptance=(status:string)=>/^(已修复[，,]\s*)?待验收$/.test(status.trim());

/** Summarize registered work; neither list placement nor ownership proves execution. */
export function summarizeTaskCardStatus(input:{
  ledgers:CardLedger[];relations:CardRelation[];sources:CardStatus[];
  parentCurrent:boolean;parentExplicit:boolean;parentEnded:boolean;hasFeishu:boolean;completed:boolean;
  uncertain:boolean;stale:boolean;nodeLines:string[];
  personalCompleted?:boolean;
}):CardStatus{
  const {ledgers,relations}=input;
  const active=ledgers.filter(row=>!terminal.has(normalize(row.task.status)??''));
  const states=active.map(row=>normalize(row.task.status));
  const current=relations.filter(row=>row.current&&!row.completed);
  const uncovered=current.filter(row=>!active.some(ledger=>ledger.task.feishuWorkItemIds.includes(row.id)||row.ledgers?.some(item=>item.task.id===ledger.task.id)));
  const root=input.sources.find(row=>row.source==='飞书');
  const finish=(label:string,tone:CardStatus['tone'],reason:string):CardStatus=>{
    const preview=(rows:string[],limit=3)=>[...rows.slice(0,limit),...(rows.length>limit?[`另有 ${rows.length-limit} 项，详见卡片及详情。`]:[])];
    return {source:'汇总',label,tone,description:[`汇总：${label}`,reason,
      ...(root?[`飞书父项：${root.label}`]:[]),
      ...(input.nodeLines.length&&input.hasFeishu?[`父项节点／状态：${input.nodeLines.join('；')}`]:[]),
      ...preview(current.map(row=>`${row.label} ${row.id}：${row.status}`)),
      ...preview(ledgers.map(row=>`本地「${row.task.title||row.task.id}」：${row.status}${row.task.waitingOn?`；等待：${row.task.waitingOn}`:''}`)),
      ...(input.uncertain?['部分关联或责任尚未核实，未显示的事项不能视为不存在。']:[]),
      ...(input.stale?['飞书快照已过期，请刷新后核对；此汇总依据上次读取的数据。']:[]),
    ].join('\n')};
  };
  if(states.includes('failed'))return finish('失败','attention','存在登记失败的本地工作，请先核对失败原因。');
  if(states.includes('blocked'))return finish('受阻','attention','存在明确登记为阻塞的本地工作，尚未完成。');
  if(states.includes('doing'))return finish('处理中','doing','存在明确登记为处理中的本地工作；不代表已核实远端进程正在运行。');
  if(states.some(state=>!['todo','waiting','paused','review_pending'].includes(state??'')))return finish('待核实','unknown','本地存在未登记或无法识别的状态，不能推断为完成。');
  if(states.includes('todo'))return finish('待处理','waiting','存在本地明确登记的待处理工作。');
  if(current.some(row=>/^(新建|重新打开)$/.test(row.status)))return finish('待处理','waiting','存在新建或重新打开的本人未完成事项，既有交付不能覆盖这次新增工作。');
  if(input.personalCompleted&&!active.length&&!current.length&&!input.uncertain&&!input.stale&&!input.parentEnded)return finish('本轮已完成','completed','本人本轮交付已完成，飞书仍待验收；保留的经办身份不视为新的待办。');
  const rootAction=input.parentCurrent&&!input.parentEnded;
  const sourceAcceptance=!!root&&acceptance(root.label);
  if((current.length>0||sourceAcceptance)&&(!rootAction||sourceAcceptance)&&current.every(row=>acceptance(row.status))
    &&states.every(state=>state==='waiting'||state==='review_pending'))return finish('待验收','waiting','当前未完成的飞书事项均处于待验收阶段；不据此推断验收操作者是你。');
  const actionable=(row:CardRelation)=>row.target?.kind==='subtask'||row.target?.kind==='parent'||row.target?.kind==='project'&&(row.target.item.actionability==='current'||/^(新建|待处理|重新打开|处理中)$/.test(row.status));
  if(uncovered.some(actionable))return finish('待处理','waiting','存在本人当前未完成的子任务或明确待办，需要继续处理。');
  if(states.includes('review_pending'))return finish('待确认','waiting','本地登记为待复核，需要确认交付或复核结果。');
  if(states.includes('waiting'))return finish('等待中','waiting','本地工作登记为等待中；等待原因见下方，不自动判定为待你操作。');
  if(states.includes('paused'))return finish('已暂停','unknown','尚未完成的本地工作均已暂停；不能当作正在执行或已完成。');
  if(current.length||rootAction){
    if(ledgers.length)return finish('待确认','waiting','本地交付已结束，但飞书仍有本人当前责任；需核对是否已有新的可执行工作，不自动重开台账。');
    const explicitRoot=rootAction&&(input.parentExplicit||!!root&&/^(新建|待处理|重新打开|处理中)$/.test(root.label));
    return current.some(actionable)||explicitRoot
      ?finish('待处理','waiting','飞书本人当前节点或明确的新建／待处理事项尚未完成。')
      :finish('待确认','waiting','飞书仍有未完成责任；仅状态责任或归属不能证明当前需要执行具体操作。');
  }
  if(input.uncertain||input.stale||root?.tone==='unknown')return finish('待核实','unknown','关联、责任或状态证据不足，不将未核实事项自动归为完成。');
  if(ledgers.length&&ledgers.every(row=>normalize(row.task.status)==='cancelled'))return finish('已取消','completed','本地工作均已取消；取消不代表交付完成。');
  if(input.completed){
    if(input.hasFeishu&&input.parentEnded)return finish('已结束','completed','已读取的飞书父项已结束，且本人纳入此卡片的工作均已结束。');
    return finish('本轮已完成','completed','本人当前登记范围已完成；不代表整个父流程关闭或后续责任已完成。');
  }
  return finish('待确认','waiting','目前未取得足以判断具体执行动作的证据，请核对责任节点与任务范围。');
}
