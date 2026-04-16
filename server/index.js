import express from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import authRouter, { requireAuth } from './auth.js';
import { initDb } from './db.js';
import { getGroups, getGroupMembers, searchTickets, getTicketAudits } from './zendesk.js';
import { calculateTicketMetrics, aggregateByAssignee, median } from './metrics.js';

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

app.use(express.json());
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
    send({ type: 'status', message: 'Searching tickets...' });
    const tickets = await searchTickets(group_id, start, end, (msg) => {
      send({ type: 'status', message: msg });
    });

    const EXCLUDED_SUBJECTS = [
      'Customer signup notification',
      'Customer cancelled subscription',
      'Customer subscription expired',
    ];
    const filtered = tickets.filter(
      (t) => !EXCLUDED_SUBJECTS.some((s) => t.subject === s)
    );
    send({
      type: 'status',
      message: `Found ${tickets.length} tickets (${filtered.length} after filtering). Fetching audits...`,
    });
    const ticketsToProcess = filtered;

    if (ticketsToProcess.length === 0) {
      send({ type: 'complete', data: { assignees: [], totals: {}, ticketCount: 0 } });
      clearTimeout(timeout);
      res.end();
      return;
    }

    const members = await getGroupMembers(group_id);
    const usersMap = new Map(members.map((u) => [u.id, u]));

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
