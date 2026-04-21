// Business hours: Monday-Friday, 8am-5pm America/New_York (holidays excluded)
const BIZ_START_HOUR = 8;
const BIZ_END_HOUR = 17;
const TZ = 'America/New_York';

// US federal holidays by ET date string. Update annually or extend via HOLIDAY_DATES env var
// (comma-separated YYYY-MM-DD values appended to the built-in list).
const BUILTIN_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13',
  '2025-11-11', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12',
  '2026-11-11', '2026-11-26', '2026-12-25',
]);
const HOLIDAYS = (() => {
  const extra = (process.env.HOLIDAY_DATES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.length === 0) return BUILTIN_HOLIDAYS;
  const set = new Set(BUILTIN_HOLIDAYS);
  for (const d of extra) set.add(d);
  return set;
})();

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
export function businessSeconds(startUtc, endUtc) {
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
      const dateStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
      if (!HOLIDAYS.has(dateStr)) {
        const overlapStart = startUtc > dayStartUtc ? startUtc : dayStartUtc;
        const overlapEnd = endUtc < dayEndUtc ? endUtc : dayEndUtc;
        if (overlapEnd > overlapStart) {
          total += (overlapEnd - overlapStart) / 1000;
        }
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

  // Pickup time: time from creation to first status change out of "new"
  // Attributed to the agent (author_id) who made that change
  // Pickup time: business hours only from creation to first status change out of "new"
  // Attributed to the agent (author_id) who made that change
  let pickupTime = null;
  let pickedUpBy = null;
  const firstPickup = statusChanges.find((sc) => sc.from === 'new');
  if (firstPickup) {
    const created = new Date(ticket.created_at);
    const picked = new Date(firstPickup.timestamp);
    pickupTime = businessSeconds(created, picked);
    // Find the author of this audit
    const pickupAudit = audits.find((a) => a.created_at === firstPickup.timestamp &&
      a.events.some((e) => e.type === 'Change' && e.field_name === 'status' && e.previous_value === 'new'));
    if (pickupAudit) {
      pickedUpBy = pickupAudit.author_id;
    }
  }

  // Time to close: from first pickup out of "new" to first "solved"
  // Calendar and business hours versions
  let timeToClose = null;
  let bizTimeToClose = null;
  if (firstPickup) {
    const pickupTs = new Date(firstPickup.timestamp);
    const firstSolved = statusChanges.find((sc) => sc.to === 'solved');
    if (firstSolved) {
      const solvedTs = new Date(firstSolved.timestamp);
      timeToClose = (solvedTs - pickupTs) / 1000;
      bizTimeToClose = businessSeconds(pickupTs, solvedTs);
    }
  }

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
    pickupTime,
    pickedUpBy,
    timeToClose,
    bizTimeToClose,
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
        pickupTimes: [],
        bizPickupTimes: [],
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

  // Build pickup stats per agent (by who picked it up, not current assignee)
  // Pickup time is always business hours only
  const pickupByAgent = {};
  for (const tm of ticketMetrics) {
    if (tm.pickedUpBy != null && tm.pickupTime != null) {
      if (!pickupByAgent[tm.pickedUpBy]) {
        pickupByAgent[tm.pickedUpBy] = { times: [] };
      }
      pickupByAgent[tm.pickedUpBy].times.push(tm.pickupTime);
    }
  }

  // Calculate averages and medians
  return Object.values(byAssignee).map((agg) => {
    const n = agg.tickets.length;
    const pickup = pickupByAgent[agg.assigneeId] || { times: [] };
    const pn = pickup.times.length;
    return {
      ...agg,
      ticketCount: n,
      avgTimeInNew: n ? agg.totalTimeInNew / n : 0,
      avgTimeInOpen: n ? agg.totalTimeInOpen / n : 0,
      avgTimeInPending: n ? agg.totalTimeInPending / n : 0,
      avgFlapping: n ? agg.totalFlapping / n : 0,
      medTimeInNew: median(agg.tickets.map((t) => t.timeInNew)),
      medTimeInOpen: median(agg.tickets.map((t) => t.timeInOpen)),
      medTimeInPending: (() => { const p = agg.tickets.filter((t) => t.timeInPending > 0).map((t) => t.timeInPending); return p.length ? median(p) : null; })(),
      medFlapping: median(agg.tickets.map((t) => t.flapping)),
      avgBizTimeInNew: n ? agg.totalBizTimeInNew / n : 0,
      avgBizTimeInOpen: n ? agg.totalBizTimeInOpen / n : 0,
      avgBizTimeInPending: (() => { const p = agg.tickets.filter((t) => t.bizTimeInPending > 0); return p.length ? p.reduce((s, t) => s + t.bizTimeInPending, 0) / p.length : null; })(),
      medBizTimeInNew: median(agg.tickets.map((t) => t.bizTimeInNew)),
      medBizTimeInOpen: median(agg.tickets.map((t) => t.bizTimeInOpen)),
      medBizTimeInPending: (() => { const p = agg.tickets.filter((t) => t.bizTimeInPending > 0).map((t) => t.bizTimeInPending); return p.length ? median(p) : null; })(),
      pickupCount: pn,
      avgPickupTime: pn ? pickup.times.reduce((s, v) => s + v, 0) / pn : null,
      medPickupTime: pn ? median(pickup.times) : null,
      // Time to close: pickup → solved, per current assignee
      ...(() => {
        const closed = agg.tickets.filter((t) => t.timeToClose != null);
        const cn = closed.length;
        return {
          closedCount: cn,
          avgTimeToClose: cn ? closed.reduce((s, t) => s + t.timeToClose, 0) / cn : null,
          medTimeToClose: cn ? median(closed.map((t) => t.timeToClose)) : null,
          avgBizTimeToClose: cn ? closed.reduce((s, t) => s + t.bizTimeToClose, 0) / cn : null,
          medBizTimeToClose: cn ? median(closed.map((t) => t.bizTimeToClose)) : null,
        };
      })(),
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
