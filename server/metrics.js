// Business hours: Monday-Friday, 8am-5pm America/New_York
const BIZ_START_HOUR = 8;
const BIZ_END_HOUR = 17;
const TZ = 'America/New_York';

// Convert a UTC Date to Eastern time components
function toEastern(utcDate) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  for (const { type, value } of fmt.formatToParts(utcDate)) {
    parts[type] = value;
  }
  return {
    year: +parts.year,
    month: +parts.month,
    day: +parts.day,
    hours: +parts.hour === 24 ? 0 : +parts.hour,
    minutes: +parts.minute,
    seconds: +parts.second,
    weekday: parts.weekday,
    isWeekday: !['Sat', 'Sun'].includes(parts.weekday),
  };
}

// Get UTC timestamp for a specific ET date/time
// dateStr: "YYYY-MM-DD", hour: 0-23
function etToUtc(year, month, day, hour, minute = 0, second = 0) {
  // Create a date string that Intl can resolve with the correct offset
  // Build an approximate UTC date, then adjust
  const approx = new Date(Date.UTC(year, month - 1, day, hour + 5, minute, second)); // rough EST guess
  const et = toEastern(approx);
  const diffMs =
    (hour - et.hours) * 3600000 +
    (minute - et.minutes) * 60000 +
    (second - et.seconds) * 1000;
  return new Date(approx.getTime() + diffMs);
}

// Calculate business seconds between two UTC Date objects
// Uses a day-by-day approach to avoid cursor-jumping bugs
function businessSeconds(startUtc, endUtc) {
  if (endUtc <= startUtc) return 0;

  let total = 0;

  // Get the ET date range
  const startET = toEastern(startUtc);
  const endET = toEastern(endUtc);

  // Iterate from start date to end date (ET calendar days)
  // Max reasonable span: ~365 days
  let currentYear = startET.year;
  let currentMonth = startET.month;
  let currentDay = startET.day;

  for (let i = 0; i < 400; i++) {
    const dayStartUtc = etToUtc(currentYear, currentMonth, currentDay, BIZ_START_HOUR);
    const dayEndUtc = etToUtc(currentYear, currentMonth, currentDay, BIZ_END_HOUR);
    const dayET = toEastern(dayStartUtc);

    if (dayStartUtc >= endUtc) break; // Past the end

    if (dayET.isWeekday) {
      // Calculate overlap between [startUtc, endUtc] and [dayStartUtc, dayEndUtc]
      const overlapStart = startUtc > dayStartUtc ? startUtc : dayStartUtc;
      const overlapEnd = endUtc < dayEndUtc ? endUtc : dayEndUtc;

      if (overlapEnd > overlapStart) {
        total += (overlapEnd - overlapStart) / 1000;
      }
    }

    // Move to next day
    const next = new Date(dayStartUtc);
    next.setUTCDate(next.getUTCDate() + 1);
    // Re-resolve to avoid DST drift
    const nextET = toEastern(next);
    currentYear = nextET.year;
    currentMonth = nextET.month;
    currentDay = nextET.day;
  }

  return total;
}

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

  // Calculate calendar duration and business hours duration in each status
  const durations = { new: 0, open: 0, pending: 0 };
  const bizDurations = { new: 0, open: 0, pending: 0 };

  for (let i = 0; i < timeline.length; i++) {
    const start = new Date(timeline[i].timestamp);
    const end = i + 1 < timeline.length ? new Date(timeline[i + 1].timestamp) : now;
    const status = timeline[i].status;

    if (status in durations) {
      durations[status] += (end - start) / 1000;
      bizDurations[status] += businessSeconds(start, end);
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
    bizTimeInNew: bizDurations.new,
    bizTimeInOpen: bizDurations.open,
    bizTimeInPending: bizDurations.pending,
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
        totalBizTimeInNew: 0,
        totalBizTimeInOpen: 0,
        totalBizTimeInPending: 0,
        totalFlapping: 0,
      };
    }
    const agg = byAssignee[id];
    agg.tickets.push(tm);
    agg.totalTimeInNew += tm.timeInNew;
    agg.totalTimeInOpen += tm.timeInOpen;
    agg.totalTimeInPending += tm.timeInPending;
    agg.totalBizTimeInNew += tm.bizTimeInNew;
    agg.totalBizTimeInOpen += tm.bizTimeInOpen;
    agg.totalBizTimeInPending += tm.bizTimeInPending;
    agg.totalFlapping += tm.flapping;
  }

  // Calculate averages and medians
  return Object.values(byAssignee).map((agg) => {
    const n = agg.tickets.length;
    return {
      ...agg,
      ticketCount: n,
      avgTimeInNew: n ? agg.totalTimeInNew / n : 0,
      avgTimeInOpen: n ? agg.totalTimeInOpen / n : 0,
      avgTimeInPending: n ? agg.totalTimeInPending / n : 0,
      avgFlapping: n ? agg.totalFlapping / n : 0,
      medTimeInNew: median(agg.tickets.map((t) => t.timeInNew)),
      medTimeInOpen: median(agg.tickets.map((t) => t.timeInOpen)),
      medTimeInPending: median(agg.tickets.map((t) => t.timeInPending)),
      medFlapping: median(agg.tickets.map((t) => t.flapping)),
      avgBizTimeInNew: n ? agg.totalBizTimeInNew / n : 0,
      avgBizTimeInOpen: n ? agg.totalBizTimeInOpen / n : 0,
      avgBizTimeInPending: n ? agg.totalBizTimeInPending / n : 0,
      medBizTimeInNew: median(agg.tickets.map((t) => t.bizTimeInNew)),
      medBizTimeInOpen: median(agg.tickets.map((t) => t.bizTimeInOpen)),
      medBizTimeInPending: median(agg.tickets.map((t) => t.bizTimeInPending)),
    };
  });
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export { median };

export function formatDuration(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
