import express from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter, { requireAuth } from './auth.js';
import { initDb } from './db.js';
import { getGroups, getGroupMembers, searchTickets, searchTicketsByAssignees, getUsersByIds, getTicketAudits } from './zendesk.js';
import { calculateTicketMetrics, aggregateByAssignee, median } from './metrics.js';
import { calculateProductivityMetrics, aggregateProductivityByAssignee } from './productivityMetrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Starting Zendesk KPI server...');
console.log(`Node version: ${process.version}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`PORT: ${process.env.PORT || 3001}`);

// Validate required environment variables on startup
const requiredEnvVars = [
  'ZENDESK_SUBDOMAIN',
  'ZENDESK_EMAIL',
  'ZENDESK_API_TOKEN',
  'JWT_SECRET',
  'DATABASE_URL',
  'RESEND_API_KEY',
];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error('FATAL: Missing required environment variables:');
  missingVars.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
}
console.log('Environment variables: OK');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Serve static React build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
}

// Health check (public)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (public — no requireAuth)
app.use('/api/auth', authRouter);

// Rate limit the SSE endpoint — each request triggers many Zendesk API calls
const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please wait before generating another report.' },
});

// --- Protected API Routes ---

app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const groups = await getGroups();
    res.json({ groups });
  } catch (err) {
    console.error('Error fetching groups:', err.message);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

app.get('/api/metrics/stream', requireAuth, metricsLimiter, async (req, res) => {
  const { group_id, start, end } = req.query;

  if (!group_id || !start || !end) {
    return res.status(400).json({ error: 'group_id, start, and end are required' });
  }

  if (!/^\d+$/.test(group_id)) {
    return res.status(400).json({ error: 'Invalid group_id' });
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date values' });
  }

  if (startDate > endDate) {
    return res.status(400).json({ error: 'start must be before end' });
  }

  if (endDate - startDate > 365 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Date range cannot exceed 1 year' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const timeout = setTimeout(() => {
    send({ type: 'error', message: 'Request timed out' });
    res.end();
  }, 10 * 60 * 1000);

  try {
    send({ type: 'status', message: 'Fetching group members...' });
    const members = await getGroupMembers(group_id);
    const userIds = members.map((u) => u.id);

    send({ type: 'status', message: 'Searching tickets...' });
    const [groupTickets, assigneeTickets] = await Promise.all([
      searchTickets(group_id, start, end, (msg) => send({ type: 'status', message: msg })),
      searchTicketsByAssignees(userIds, start, end),
    ]);

    const seenIds = new Set();
    const merged = [];
    for (const t of [...groupTickets, ...assigneeTickets]) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        merged.push(t);
      }
    }

    const EXCLUDED_SUBJECTS = [
      'Customer signup notification',
      'Customer cancelled subscription',
      'Customer subscription expired',
    ];
    const filtered = merged.filter(
      (t) => !EXCLUDED_SUBJECTS.some((s) => t.subject === s)
    );
    send({
      type: 'status',
      message: `Found ${filtered.length} tickets. Fetching audits...`,
    });
    const ticketsToProcess = filtered;

    if (ticketsToProcess.length === 0) {
      send({ type: 'complete', data: { assignees: [], totals: {}, ticketCount: 0 } });
      clearTimeout(timeout);
      res.end();
      return;
    }

    const usersMap = new Map(members.map((u) => [u.id, u]));
    const unknownIds = [...new Set(
      filtered.map((t) => t.assignee_id).filter((id) => id != null && !usersMap.has(id))
    )];
    if (unknownIds.length > 0) {
      const unknownUsers = await getUsersByIds(unknownIds);
      for (const u of unknownUsers) usersMap.set(u.id, u);
    }

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

    send({ type: 'status', message: 'Calculating metrics...' });
    const assignees = aggregateByAssignee(ticketMetrics, usersMap);

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
      avgPickupTime: (() => {
        const p = ticketMetrics.filter((t) => t.pickupTime != null);
        return p.length ? p.reduce((s, t) => s + t.pickupTime, 0) / p.length : null;
      })(),
      medPickupTime: (() => {
        const p = ticketMetrics.filter((t) => t.pickupTime != null).map((t) => t.pickupTime);
        return p.length ? median(p) : null;
      })(),
      avgTimeToClose: (() => {
        const c = ticketMetrics.filter((t) => t.timeToClose != null);
        return c.length ? c.reduce((s, t) => s + t.timeToClose, 0) / c.length : null;
      })(),
      medTimeToClose: (() => {
        const c = ticketMetrics.filter((t) => t.timeToClose != null).map((t) => t.timeToClose);
        return c.length ? median(c) : null;
      })(),
      avgBizTimeToClose: (() => {
        const c = ticketMetrics.filter((t) => t.bizTimeToClose != null);
        return c.length ? c.reduce((s, t) => s + t.bizTimeToClose, 0) / c.length : null;
      })(),
      medBizTimeToClose: (() => {
        const c = ticketMetrics.filter((t) => t.bizTimeToClose != null).map((t) => t.bizTimeToClose);
        return c.length ? median(c) : null;
      })(),
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
    console.error('Error processing metrics stream:', err.message);
    send({ type: 'error', message: 'Failed to generate report' });
  }

  clearTimeout(timeout);
  res.end();
});

// Agent Productivity SSE stream
app.get('/api/productivity/stream', requireAuth, metricsLimiter, async (req, res) => {
  const { group_id, start, end } = req.query;

  if (!group_id || !start || !end) {
    return res.status(400).json({ error: 'group_id, start, and end are required' });
  }
  if (!/^\d+$/.test(group_id)) {
    return res.status(400).json({ error: 'Invalid group_id' });
  }
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });
  }
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate > endDate) {
    return res.status(400).json({ error: 'Invalid date range' });
  }
  if (endDate - startDate > 365 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Date range cannot exceed 1 year' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const timeout = setTimeout(() => {
    send({ type: 'error', message: 'Request timed out' });
    res.end();
  }, 10 * 60 * 1000);

  try {
    send({ type: 'status', message: 'Fetching group members...' });
    const members = await getGroupMembers(group_id);
    const userIds = members.map((u) => u.id);

    if (userIds.length === 0) {
      send({ type: 'complete', data: { agents: [], totals: {} } });
      clearTimeout(timeout);
      res.end();
      return;
    }

    // Run group search and assignee search in parallel
    // Group search: catches unassigned + automation tickets in the group
    // Assignee search: catches cross-group tickets assigned to group members
    send({ type: 'status', message: 'Searching tickets...' });
    const [groupTickets, assigneeTickets] = await Promise.all([
      searchTickets(group_id, start, end),
      searchTicketsByAssignees(userIds, start, end),
    ]);

    // Merge and deduplicate
    const seenIds = new Set();
    const merged = [];
    for (const t of [...groupTickets, ...assigneeTickets]) {
      if (!seenIds.has(t.id)) {
        seenIds.add(t.id);
        merged.push(t);
      }
    }

    const EXCLUDED_SUBJECTS = [
      'Customer signup notification',
      'Customer cancelled subscription',
      'Customer subscription expired',
    ];
    const filtered = merged.filter(
      (t) => !EXCLUDED_SUBJECTS.some((s) => t.subject === s)
    );

    send({
      type: 'status',
      message: `Found ${filtered.length} tickets. Fetching audits...`,
    });

    if (filtered.length === 0) {
      send({ type: 'complete', data: { agents: [], totals: {} } });
      clearTimeout(timeout);
      res.end();
      return;
    }

    // Build users map — start with group members, then fill in unknown assignees
    const usersMap = new Map(members.map((u) => [u.id, u]));
    const unknownIds = [...new Set(
      filtered
        .map((t) => t.assignee_id)
        .filter((id) => id != null && !usersMap.has(id))
    )];
    if (unknownIds.length > 0) {
      const unknownUsers = await getUsersByIds(unknownIds);
      for (const u of unknownUsers) usersMap.set(u.id, u);
    }

    const CONCURRENCY = 10;
    const ticketMetrics = [];
    let completed = 0;

    for (let i = 0; i < filtered.length; i += CONCURRENCY) {
      const batch = filtered.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (ticket) => {
          const audits = await getTicketAudits(ticket.id);
          return calculateProductivityMetrics(ticket, audits);
        })
      );
      ticketMetrics.push(...results);
      completed += batch.length;
      send({ type: 'progress', current: completed, total: filtered.length });
    }

    send({ type: 'status', message: 'Calculating metrics...' });
    const agents = aggregateProductivityByAssignee(ticketMetrics, usersMap);

    const solved = ticketMetrics.filter((t) => t.isSolved);
    const oneTouchCount = ticketMetrics.filter((t) => t.oneTouch).length;
    const allFirstReply = ticketMetrics.filter((t) => t.firstReplyBizSeconds != null).map((t) => t.firstReplyBizSeconds);
    const allResolution = ticketMetrics.filter((t) => t.resolutionBizSeconds != null).map((t) => t.resolutionBizSeconds);

    const totals = {
      created: filtered.length,
      solved: solved.length,
      unsolved: filtered.length - solved.length,
      oneTouchPct: solved.length > 0 ? (oneTouchCount / solved.length) * 100 : 0,
      medFirstReplyBizSeconds: allFirstReply.length ? median(allFirstReply) : null,
      medResolutionBizSeconds: allResolution.length ? median(allResolution) : null,
    };

    send({
      type: 'complete',
      data: {
        agents: agents.sort((a, b) => b.totalTaken - a.totalTaken),
        totals,
      },
    });
  } catch (err) {
    console.error('Error processing productivity stream:', err.message);
    send({ type: 'error', message: 'Failed to generate report' });
  }

  clearTimeout(timeout);
  res.end();
});

// SPA fallback in production
if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
  });
}

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Health check: http://0.0.0.0:${PORT}/health`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
