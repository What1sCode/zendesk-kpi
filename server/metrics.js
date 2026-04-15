export function calculateTicketMetrics(ticket, audits) {
  const now = new Date();

  // Build status timeline from audit events
  const statusChanges = [];
  for (const audit of audits) {
    for (const event of audit.events) {
      if (event.type === 'Change' && event.field_name === 'status') {
        statusChanges.push({
          timestamp: audit.created_at,
          from: event.previous_value,
          to: event.value,
        });
      }
    }
  }

  // Sort by timestamp
  statusChanges.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Build timeline starting with "new" at ticket creation
  const timeline = [{ timestamp: ticket.created_at, status: 'new' }];
  for (const change of statusChanges) {
    timeline.push({ timestamp: change.timestamp, status: change.to });
  }

  // Calculate duration in each status
  const durations = { new: 0, open: 0, pending: 0 };
  for (let i = 0; i < timeline.length; i++) {
    const start = new Date(timeline[i].timestamp);
    const end = i + 1 < timeline.length ? new Date(timeline[i + 1].timestamp) : now;
    const status = timeline[i].status;

    if (status in durations) {
      durations[status] += (end - start) / 1000; // seconds
    }
  }

  // Count flapping = total number of status transitions
  const flapping = statusChanges.length;

  return {
    ticketId: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    assigneeId: ticket.assignee_id,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
    timeInNew: durations.new,
    timeInOpen: durations.open,
    timeInPending: durations.pending,
    flapping,
  };
}

export function aggregateByAssignee(ticketMetrics, usersMap) {
  const byAssignee = {};

  for (const tm of ticketMetrics) {
    const id = tm.assigneeId || 0;
    if (!byAssignee[id]) {
      const user = usersMap.get(id);
      byAssignee[id] = {
        assigneeId: id,
        assigneeName: user ? user.name : id === 0 ? 'Unassigned' : `User ${id}`,
        tickets: [],
        totalTimeInNew: 0,
        totalTimeInOpen: 0,
        totalTimeInPending: 0,
        totalFlapping: 0,
      };
    }
    const agg = byAssignee[id];
    agg.tickets.push(tm);
    agg.totalTimeInNew += tm.timeInNew;
    agg.totalTimeInOpen += tm.timeInOpen;
    agg.totalTimeInPending += tm.timeInPending;
    agg.totalFlapping += tm.flapping;
  }

  // Calculate averages
  return Object.values(byAssignee).map((agg) => ({
    ...agg,
    ticketCount: agg.tickets.length,
    avgTimeInNew: agg.tickets.length ? agg.totalTimeInNew / agg.tickets.length : 0,
    avgTimeInOpen: agg.tickets.length ? agg.totalTimeInOpen / agg.tickets.length : 0,
    avgTimeInPending: agg.tickets.length ? agg.totalTimeInPending / agg.tickets.length : 0,
    avgFlapping: agg.tickets.length ? agg.totalFlapping / agg.tickets.length : 0,
  }));
}

export function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
