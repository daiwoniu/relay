import type { ShareSnapshotV1 } from '../../generated/relay-contracts';
import AssistantMessage from '../messages/AssistantMessage';
import UserMessage from '../messages/UserMessage';

export default function PublicShareMessageList({ snapshot, wideLayout = false, full }: { snapshot: ShareSnapshotV1; wideLayout?: boolean; full?: boolean }) {
  return (
    <div className={`mx-auto w-full ${wideLayout ? 'max-w-none' : 'max-w-3xl'} space-y-6 px-4 py-6`}>
      {snapshot.messages.map((message) => message.role === 'user' ? (
        <UserMessage key={message.id} content={message.content} attachments={message.attachments} createdAt={message.createdAt} readOnly full={full} />
      ) : (
        <AssistantMessage
          key={message.id}
          content={message.content}
          createdAt={message.createdAt}
          duration={message.duration}
          outcome={message.outcome}
          items={message.processItems}
          processContent={message.processContent}
          processTimeline={message.processTimeline}
          changedFiles={message.changedFiles}
          changedFilesIncomplete={message.changedFilesIncomplete}
          readOnly
          full={full}
        />
      ))}
    </div>
  );
}
