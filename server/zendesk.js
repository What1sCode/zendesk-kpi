const BASE_URL = `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;

// Returns the UTC ISO string for midnight America/New_York on a given YYYY-MM-DD date.
// Handles DST correctly by sampling the ET offset at noon UTC on that date.
function etMidnightUtc(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const etNoonHour = +([...new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(noonUtc)].find((p) => p.type === 'hour').value);
  const offsetHours = 12 - (etNoonHour === 24 ? 0 : etNoonHour);
  return new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0)).toISOString();
}
const AUTH = Buffer.from(
  `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`
).toString('base64');

async function request(path) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '10', 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return request(path);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Zendesk API ${res.status}: ${text}`);
  }

  return res.json();
}

export async function getGroups() {
  const data = await request('/groups.json');
  return data.groups;
}

export async function getGroupMembers(groupId) {
  let members = [];
  let url = `/groups/${groupId}/memberships.json?per_page=100`;
  while (url) {
    const data = await request(url);
    members = members.concat(data.group_memberships);
    url = data.next_page || null;
  }

  // Fetch user details
  const userIds = [...new Set(members.map((m) => m.user_id))];
  if (userIds.length === 0) return [];

  const users = [];
  for (let i = 0; i < userIds.length; i += 100) {
    const batch = userIds.slice(i, i + 100);
    const data = await request(`/users/show_many.json?ids=${batch.join(',')}`);
    users.push(...data.users);
  }
  return users;
}

export async function searchTickets(groupId, startDate, endDate, onChunkStatus) {
  // Break date range into weekly chunks to stay under Zendesk's 1000-result search limit
  const chunks = buildWeeklyChunks(startDate, endDate);
  let allTickets = [];
  const seenIds = new Set();

  for (let i = 0; i < chunks.length; i++) {
    const { start, end, startUtc, endExclusiveUtc } = chunks[i];
    if (onChunkStatus) {
      onChunkStatus(`Searching tickets (week ${i + 1}/${chunks.length}: ${start} to ${end})...`);
    }

    const query = `type:ticket group:${groupId} created>=${startUtc} created<${endExclusiveUtc}`;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const data = await request(
        `/search.json?query=${encodeURIComponent(query)}&page=${page}&per_page=100&sort_by=created_at&sort_order=asc`
      );
      for (const ticket of data.results) {
        if (!seenIds.has(ticket.id)) {
          seenIds.add(ticket.id);
          allTickets.push(ticket);
        }
      }
      hasMore = data.results.length === 100 && page * 100 < data.count;
      page++;
    }
  }

  return allTickets;
}

function buildWeeklyChunks(startDate, endDate) {
  const chunks = [];
  // Use noon UTC to avoid any date-boundary shifts when parsing bare date strings
  let current = new Date(startDate + 'T12:00:00Z');
  const end = new Date(endDate + 'T12:00:00Z');

  while (current <= end) {
    const chunkEnd = new Date(current);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 6);
    const actualEnd = chunkEnd > end ? end : chunkEnd;

    const startStr = current.toISOString().split('T')[0];
    const endStr = actualEnd.toISOString().split('T')[0];

    // Next calendar day after end — used as exclusive upper bound in the query
    const nextDay = new Date(actualEnd);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDayStr = nextDay.toISOString().split('T')[0];

    chunks.push({
      start: startStr,
      end: endStr,
      // ET-midnight UTC timestamps align the query with Explore's account-timezone date picker
      startUtc: etMidnightUtc(startStr),
      endExclusiveUtc: etMidnightUtc(nextDayStr),
    });

    current = new Date(nextDay);
  }

  return chunks;
}

// Search tickets by assignee IDs — used for Agent Productivity so tickets
// assigned to group members in other groups are not missed
export async function searchTicketsByAssignees(userIds, startDate, endDate, onChunkStatus) {
  const chunks = buildWeeklyChunks(startDate, endDate);
  const allTickets = [];
  const seenIds = new Set();
  let chunkIndex = 0;
  const totalChunks = chunks.length * userIds.length;

  for (const userId of userIds) {
    for (const { start, end, startUtc, endExclusiveUtc } of chunks) {
      chunkIndex++;
      if (onChunkStatus) {
        onChunkStatus(`Searching tickets for agents (${chunkIndex}/${totalChunks})...`);
      }

      const query = `type:ticket assignee:${userId} created>=${startUtc} created<${endExclusiveUtc}`;
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const data = await request(
          `/search.json?query=${encodeURIComponent(query)}&page=${page}&per_page=100&sort_by=created_at&sort_order=asc`
        );
        for (const ticket of data.results) {
          if (!seenIds.has(ticket.id)) {
            seenIds.add(ticket.id);
            allTickets.push(ticket);
          }
        }
        hasMore = data.results.length === 100 && page * 100 < data.count;
        page++;
      }
    }
  }

  return allTickets;
}

export async function getUsersByIds(ids) {
  if (ids.length === 0) return [];
  const users = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const data = await request(`/users/show_many.json?ids=${batch.join(',')}`);
    users.push(...data.users);
  }
  return users;
}

export async function getTicketAudits(ticketId) {
  let audits = [];
  let url = `/tickets/${ticketId}/audits.json?per_page=100`;
  while (url) {
    const data = await request(url);
    audits = audits.concat(data.audits);
    url = data.next_page || null;
  }
  return audits;
}
