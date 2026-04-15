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

export async function searchTickets(groupId, startDate, endDate) {
  const query = `type:ticket group:${groupId} created>=${startDate} created<=${endDate}`;
  let tickets = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const data = await request(
      `/search.json?query=${encodeURIComponent(query)}&page=${page}&per_page=100&sort_by=created_at&sort_order=asc`
    );
    tickets = tickets.concat(data.results);
    hasMore = data.results.length === 100 && tickets.length < data.count;
    page++;
  }

  return tickets;
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
