import ConfirmDialog from '../ui/ConfirmDialog';

interface Props {
  open: boolean;
  sourceTitle?: string;
  fromReply: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export default function CreateSessionFromContextDialog({ open, sourceTitle, fromReply, onCancel, onConfirm }: Props) {
  return (
    <ConfirmDialog
      open={open}
      eyebrow="创建独立会话"
      title={fromReply ? '从此处创建新会话？' : '基于当前会话创建新会话？'}
      tone="neutral"
      description={fromReply
        ? '将复制从会话开始到这条回复（含）为止的全部消息与上下文，并创建一个可独立继续的新会话。'
        : '将复制当前完整的对话上下文，并创建一个可独立继续的新会话。'}
      subject={sourceTitle ? { label: '来源会话', value: sourceTitle } : undefined}
      impacts={[
        '原会话及其消息不会改变',
        '相关 Relay 托管附件会复制到新会话',
        '创建成功后将自动进入新会话',
      ]}
      confirmLabel="创建新会话"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
