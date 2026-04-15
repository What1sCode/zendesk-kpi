import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGroups, getGroupMembers, searchTickets, getTicketAudits } from './zendesk.js';
import { calculateTicketMetrics, aggregateByAssignee } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static React build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
}

// --- API Routes ---

app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getGroups();
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE streaming endpoint for metrics
app.get('/api/metrics/stream', async (req, res) => {
  const { group_id, start, end } = req.query;
  if (!group_id || !start || !end) {
    return res.status(400).json({ error: 'group_id, start, and end are required' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Step 1: Search tickets (chunked by week to avoid Zendesk 1000-result limit)
    send({ type: 'status', message: 'Searching tickets...' });
    const tickets = await searchTickets(group_id, start, end, (msg) => {
      send({ type: 'status', message: msg });
    });
    send({ type: 'status', message: `Found ${tickets.length} tickets. Fetching audits...` });

    if (tickets.length === 0) {
      send({ type: 'complete', data: { assignees: [], totals: {}, ticketCount: 0 } });
      res.end();
      return;
    }

    // Step 2: Fetch group members for name resolution
    const members = await getGroupMembers(group_id);
    const usersMap = new Map(members.map((u) => [u.id, u]));

    // Also collect any assignee IDs not in the group (edge case)
    const extraIds = new Set();
    for (const t of tickets) {
      if (t.assignee_id && !usersMap.has(t.assignee_id)) {
        extraIds.add(t.assignee_id);
      }
    }

    // Step 3: Fetch audits with concurrency limit
    const CONCURRENCY = 10;
    const ticketMetrics = [];
    let completed = 0;

    for (let i = 0; i < tickets.length; i += CONCURRENCY) {
      const batch = tickets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (ticket) => {
          const audits = await getTicketAudits(ticket.id);
          return calculateTicketMetrics(ticket, audits);
        })
      );
      ticketMetrics.push(...results);
      completed += batch.length;
      send({ type: 'progress', current: completed, total: tickets.length });
    }

    // Step 4: Aggregate
    send({ type: 'status', message: 'Calculating metrics...' });
    const assignees = aggregateByAssignee(ticketMetrics, usersMap);

    // Group-level totals
    const totalTickets = ticketMetrics.length;
    const totals = {
      ticketCount: totalTickets,
      avgTimeInNew: totalTickets ? ticketMetrics.reduce((s, t) => s + t.timeInNew, 0) / totalTickets : 0,
      avgTimeInOpen: totalTickets ? ticketMetrics.reduce((s, t) => s + t.timeInOpen, 0) / totalTickets : 0,
      avgTimeInPending: totalTickets ? ticketMetrics.reduce((s, t) => s + t.timeInPending, 0) / totalTickets : 0,
      avgFlapping: totalTickets ? ticketMetrics.reduce((s, t) => s + t.flapping, 0) / totalTickets : 0,
      totalFlapping: ticketMetrics.reduce((s, t) => s + t.flapping, 0),
    };

    send({
      type: 'complete',
      data: {
        assignees: assignees.sort((a, b) => b.ticketCount - a.ticketCount),
        totals,
        ticketCount: totalTickets,
      },
    });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
});

// SPA fallback in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
