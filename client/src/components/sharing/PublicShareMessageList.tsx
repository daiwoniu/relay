import type { ShareSnapshotV1 } from '../../generated/relay-contracts';
import { useMemo } from 'react';
import { buildShareFlows } from './share-process-flow';
import AssistantMessage from '../messages/AssistantMessage';
import UserMessage from '../messages/UserMessage';

export default function PublicShareMessageList({ snapshot, wideLayout = false, full }: { snapshot: ShareSnapshotV1; wideLayout?: boolean; full?: boolean }) {
  const flows = useMemo(() => buildShareFlows(snapshot), [snapshot]);
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
          modelInfo={message.modelInfo}
          flowContext={flows.get(message.id)}
          items={message.processItems}
          processContent={message.processContent}
          processTimeline={flows.get(message.id)?.timeline || message.processTimeline}
          changedFiles={message.changedFiles}
          changedFilesIncomplete={message.changedFilesIncomplete}
          readOnly
          full={full}
        />
      ))}
    </div>
  );
}
