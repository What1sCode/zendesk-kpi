import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { getGroups, getGroupMembers, searchTickets, getTicketAudits } from './zendesk.js';
import { calculateTicketMetrics, aggregateByAssignee, median } from './metrics.js';

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
    // Filter out automated/notification tickets
    const EXCLUDED_SUBJECTS = [
      'Customer signup notification',
      'Customer cancelled subscription',
      'Customer subscription expired',
    ];
    const filtered = tickets.filter(
      (t) => !EXCLUDED_SUBJECTS.some((s) => t.subject === s)
    );
    send({ type: 'status', message: `Found ${tickets.length} tickets (${filtered.length} after filtering). Fetching audits...` });
    const ticketsToProcess = filtered;

    if (ticketsToProcess.length === 0) {
      send({ type: 'complete', data: { assignees: [], totals: {}, ticketCount: 0 } });
      res.end();
      return;
    }

    // Step 2: Fetch group members for name resolution
    const members = await getGroupMembers(group_id);
    const usersMap = new Map(members.map((u) => [u.id, u]));

    // Also collect any assignee IDs not in the group (edge case)
    const extraIds = new Set();
    for (const t of ticketsToProcess) {
      if (t.assignee_id && !usersMap.has(t.assignee_id)) {
        extraIds.add(t.assignee_id);
      }
    }

    // Step 3: Fetch audits with concurrency limit
    const CONCURRENCY = 10;
    const ticketMetrics = [];
    let completed = 0;

    for (let i = 0; i < ticketsToProcess.length; i += CONCURRENCY) {
      const batch = ticketsToProcess.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (ticket) => {
          const audits = await getTicketAudits(ticket.id);
          return calculateTicketMetrics(ticket, audits);
        })
      );
      ticketMetrics.push(...results);
      completed += batch.length;
      send({ type: 'progress', current: completed, total: ticketsToProcess.length });
    }

    // Step 4: Aggregate
    send({ type: 'status', message: 'Calculating metrics...' });
    const assignees = aggregateByAssignee(ticketMetrics, usersMap);

    // Group-level totals
    const totalTickets = ticketMetrics.length;
    const n = totalTickets;
    const totals = {
      ticketCount: n,
      avgTimeInNew: n ? ticketMetrics.reduce((s, t) => s + t.timeInNew, 0) / n : 0,
      avgTimeInOpen: n ? ticketMetrics.reduce((s, t) => s + t.timeInOpen, 0) / n : 0,
      avgTimeInPending: n ? ticketMetrics.reduce((s, t) => s + t.timeInPending, 0) / n : 0,
      avgFlapping: n ? ticketMetrics.reduce((s, t) => s + t.flapping, 0) / n : 0,
      totalFlapping: ticketMetrics.reduce((s, t) => s + t.flapping, 0),
      medTimeInNew: median(ticketMetrics.map((t) => t.timeInNew)),
      medTimeInOpen: median(ticketMetrics.map((t) => t.timeInOpen)),
      medTimeInPending: median(ticketMetrics.map((t) => t.timeInPending)),
      medFlapping: median(ticketMetrics.map((t) => t.flapping)),
      avgBizTimeInNew: n ? ticketMetrics.reduce((s, t) => s + t.bizTimeInNew, 0) / n : 0,
      avgBizTimeInOpen: n ? ticketMetrics.reduce((s, t) => s + t.bizTimeInOpen, 0) / n : 0,
      avgBizTimeInPending: n ? ticketMetrics.reduce((s, t) => s + t.bizTimeInPending, 0) / n : 0,
      medBizTimeInNew: median(ticketMetrics.map((t) => t.bizTimeInNew)),
      medBizTimeInOpen: median(ticketMetrics.map((t) => t.bizTimeInOpen)),
      medBizTimeInPending: median(ticketMetrics.map((t) => t.bizTimeInPending)),
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
