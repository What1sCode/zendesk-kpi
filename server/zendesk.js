const BASE_URL = `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`;
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
    const { start, end } = chunks[i];
    if (onChunkStatus) {
      onChunkStatus(`Searching tickets (week ${i + 1}/${chunks.length}: ${start} to ${end})...`);
    }

    const query = `type:ticket group:${groupId} created>=${start} created<=${end}`;
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
  let current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    const chunkEnd = new Date(current);
    chunkEnd.setDate(chunkEnd.getDate() + 6);
    const actualEnd = chunkEnd > end ? end : chunkEnd;

    chunks.push({
      start: current.toISOString().split('T')[0],
      end: actualEnd.toISOString().split('T')[0],
    });

    current = new Date(actualEnd);
    current.setDate(current.getDate() + 1);
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
    for (const { start, end } of chunks) {
      chunkIndex++;
      if (onChunkStatus) {
        onChunkStatus(`Searching tickets for agents (${chunkIndex}/${totalChunks})...`);
      }

      const query = `type:ticket assignee:${userId} created>=${start} created<=${end}`;
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
