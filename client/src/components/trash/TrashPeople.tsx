import type { TrashSessionDto } from '../../generated/relay-contracts';
import Tooltip from '../ui/Tooltip';
import { formatResourcePerson as name } from '../../utils/resource-person';

export default function TrashPeople({ creator, deletedBy }: Pick<TrashSessionDto, 'creator' | 'deletedBy'>) {
  return <div className="trash-dialog__people">
    <span>创建人：{name(creator)}</span>
    <Tooltip content={!deletedBy ? '历史未记录或无法可靠确认本次删除操作者' : null} asChild><span tabIndex={!deletedBy ? 0 : undefined}>删除人：{name(deletedBy)}</span></Tooltip>
  </div>;
}
