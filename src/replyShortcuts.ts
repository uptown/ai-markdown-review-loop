import type { ReviewThread } from './types';

export interface ReplyShortcutDescriptor {
  template: string;
  label: string;
  title: string;
}

export function getReplyShortcutDescriptors(thread: ReviewThread): ReplyShortcutDescriptor[] {
  if (!hasReviewerParticipation(thread)) {
    return [];
  }

  if (thread.type === 'question') {
    return [
      { template: 'answer', label: 'Answer', title: 'Draft an answer reply without closing this question.' },
      { template: 'clarify', label: 'Clarify', title: 'Draft a request for a sharper question or missing context.' },
      { template: 'not-applicable', label: 'Not Applicable', title: 'Draft a reply explaining why this question no longer applies.' }
    ];
  }

  if (thread.type === 'risk') {
    return [
      { template: 'acknowledge-risk', label: 'Acknowledge', title: 'Draft a reply acknowledging the risk without closing it.' },
      { template: 'mitigate-risk', label: 'Mitigate', title: 'Draft a mitigation reply for this risk.' },
      { template: 'challenge', label: 'Challenge', title: 'Draft a reply challenging this risk without closing it.' }
    ];
  }

  if (thread.type === 'fix' || thread.type === 'suggestion') {
    return [
      { template: 'agree', label: 'Agree', title: 'Draft an agreement reply without closing this thread.' },
      { template: 'revise', label: thread.suggestedPatch ? 'Revise Patch' : 'Revise', title: 'Draft a request for a sharper comment or patch.' },
      { template: 'disagree', label: 'Disagree', title: 'Draft a disagreement reply without closing this thread.' }
    ];
  }

  return [
    { template: 'acknowledge', label: 'Acknowledge', title: 'Draft an acknowledgement reply without closing this note.' },
    { template: 'revise', label: 'Revise', title: 'Draft a request for a sharper note.' },
    { template: 'disagree', label: 'Disagree', title: 'Draft a disagreement reply without closing this note.' }
  ];
}

function hasReviewerParticipation(thread: ReviewThread): boolean {
  return thread.source !== 'human'
    || thread.thread.some(reply => reply.role === 'assistant');
}
