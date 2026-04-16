import { businessSeconds, median } from './metrics.js';

const PHONE_TAGS = ['phone_caseorigin'];
const CHAT_TAGS = ['chat_offline', 'chat_caseorigin'];
const EMAIL_TAGS = ['email_caseorigin', 'web_caseorigin'];
const ELOVIEW_TAG = 'ev_new_message';

const AUTOMATION_SUBJECT_CONTAINS = [
  'customer signup summary notification',
  'customer signup notification',
  'customer cancelled subscription',
  'call could not be transcribed or summarized',
];

function isAutomationSubject(subject) {
  if (!subject) return false;
  const lower = subject.toLowerCase();
  if (AUTOMATION_SUBJECT_CONTAINS.some((s) => lower.includes(s))) return true;
  if (lower.startsWith('abandoned call from:')) return true;
  return false;
}

function getChannel(ticket) {
  const tags = ticket.tags || [];
  if (PHONE_TAGS.some((t) => tags.includes(t))) return 'phone';
  if (CHAT_TAGS.some((t) => tags.includes(t))) return 'chat';
  if (EMAIL_TAGS.some((t) => tags.includes(t))) return 'email';
  return 'other';
}

export function calculateProductivityMetrics(ticket, audits) {
  const sorted = [...audits].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let agentReplies = 0;
  let firstReplyTs = null;
  let firstResolvedTs = null;
  let reopens = 0;

  for (const audit of sorted) {
    for (const event of audit.events) {
      // Public agent comment
      if (
        event.type === 'Comment' &&
        event.public === true &&
        audit.author_id !== ticket.requester_id
      ) {
        agentReplies++;
        if (!firstReplyTs) firstReplyTs = new Date(audit.created_at);
      }

      // Voice call interaction — counts as an agent reply
      if (event.type === 'VoiceComment' && event.public === false) {
        agentReplies++;
        if (!firstReplyTs) firstReplyTs = new Date(audit.created_at);
      }

      // Status changes
      if (event.type === 'Change' && event.field_name === 'status') {
        // First time ticket reaches solved
        if (event.value === 'solved' && !firstResolvedTs) {
          firstResolvedTs = new Date(audit.created_at);
        }
        // Reopen: solved → anything except closed
        if (event.previous_value === 'solved' && event.value !== 'closed') {
          reopens++;
        }
      }
    }
  }

  const isSolved = ticket.status === 'solved' || ticket.status === 'closed';
  const oneTouch = isSolved && agentReplies <= 1;

  const created = new Date(ticket.created_at);
  const firstReplyBizSeconds = firstReplyTs ? businessSeconds(created, firstReplyTs) : null;
  const resolutionBizSeconds = firstResolvedTs ? businessSeconds(created, firstResolvedTs) : null;

  return {
    ticketId: ticket.id,
    subject: ticket.subject,
    createdAt: ticket.created_at,
    assigneeId: ticket.assignee_id,
    status: ticket.status,
    channel: getChannel(ticket),
    isEloview: (ticket.tags || []).includes(ELOVIEW_TAG),
    isSubjectAutomation: isAutomationSubject(ticket.subject),
    agentReplies,
    firstReplyBizSeconds,
    resolutionBizSeconds,
    reopens,
    oneTouch,
    isSolved,
  };
}

const AUTOMATION_SENTINEL = '__automation__';

export function aggregateProductivityByAssignee(ticketMetrics, usersMap) {
  const byAssignee = {};

  // Find the Zendesk Agent user ID in usersMap (if present) so subject-automation
  // tickets land in the same row as tickets actually assigned to Zendesk Agent.
  let zenDeskAgentId = null;
  for (const [id, user] of usersMap) {
    if (user.name && user.name.toLowerCase() === 'zendesk agent') {
      zenDeskAgentId = id;
      break;
    }
  }
  const automationBucketId = zenDeskAgentId ?? AUTOMATION_SENTINEL;

  for (const tm of ticketMetrics) {
    const id = tm.isSubjectAutomation ? automationBucketId : (tm.assigneeId || 0);
    if (!byAssignee[id]) {
      const user = usersMap.get(id);
      const assigneeName =
        id === AUTOMATION_SENTINEL
          ? 'Zendesk Agent'
          : user
          ? user.name
          : id === 0
          ? 'Unassigned'
          : `User ${id}`;
      byAssignee[id] = {
        assigneeId: id,
        assigneeName,
        isAutomation: assigneeName.toLowerCase() === 'zendesk agent',
        phone: 0,
        chat: 0,
        email: 0,
        other: 0,
        totalTaken: 0,
        unsolved: 0,
        solved: 0,
        agentReplies: 0,
        oneTouchCount: 0,
        reopens: 0,
        firstReplyTimes: [],
        resolutionTimes: [],
        tickets: [],
      };
    }

    const agg = byAssignee[id];
    agg.totalTaken++;
    if (tm.channel === 'phone') agg.phone++;
    else if (tm.channel === 'chat') agg.chat++;
    else if (tm.channel === 'email') agg.email++;
    if (tm.channel === 'other') agg.other++;
    if (tm.isSolved) agg.solved++;
    else agg.unsolved++;
    agg.agentReplies += tm.agentReplies;
    if (tm.oneTouch) agg.oneTouchCount++;
    agg.reopens += tm.reopens;
    if (tm.firstReplyBizSeconds != null) agg.firstReplyTimes.push(tm.firstReplyBizSeconds);
    if (tm.resolutionBizSeconds != null) agg.resolutionTimes.push(tm.resolutionBizSeconds);
    agg.tickets.push(tm);
  }

  return Object.values(byAssignee).map((agg) => ({
    assigneeId: agg.assigneeId,
    assigneeName: agg.assigneeName,
    phone: agg.phone,
    chat: agg.chat,
    email: agg.email,
    other: agg.other,
    totalTaken: agg.totalTaken,
    unsolved: agg.unsolved,
    solved: agg.solved,
    agentReplies: agg.agentReplies,
    oneTouchPct: agg.solved > 0 ? (agg.oneTouchCount / agg.solved) * 100 : 0,
    reopens: agg.reopens,
    medFirstReplyBizSeconds: agg.firstReplyTimes.length ? median(agg.firstReplyTimes) : null,
    medResolutionBizSeconds: agg.resolutionTimes.length ? median(agg.resolutionTimes) : null,
    tickets: agg.tickets,
    isAutomation: agg.isAutomation,
  }));
}
