import { useState, useEffect, useRef } from 'react';
import GroupSelector from './GroupSelector';
import DateRangePicker from './DateRangePicker';
import StatusBadge from './StatusBadge';
import SummaryCard, { DeltaBadge } from './SummaryCard';
import SlaSettings from './SlaSettings';
import { useSlaTargets } from '../hooks/useSlaTargets';

const SUBDOMAIN = 'elotouchcare';

const CHANNEL_LABEL = { phone: 'Phone', chat: 'Chat', email: 'Email', other: 'Other' };
const CHANNEL_COLOR = {
  phone: 'bg-blue-100 text-blue-700',
  chat:  'bg-green-100 text-green-700',
  email: 'bg-yellow-100 text-yellow-700',
  other: 'bg-gray-100 text-gray-600',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const days  = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins  = Math.floor((seconds % 3600) / 60);
  if (days > 0)  return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function durStatus(seconds, targetHours) {
  if (seconds == null || !targetHours) return null;
  const r = seconds / (targetHours * 3600);
  if (r <= 1)   return 'good';
  if (r <= 1.5) return 'warn';
  return 'bad';
}

function pctStatus(value, target) {
  if (value == null || !target) return null;
  if (value >= target)          return 'good';
  if (value >= target * 0.75)   return 'warn';
  return 'bad';
}

function calcPriorDates(start, end) {
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const sD   = new Date(start + 'T12:00:00Z');
  const eD   = new Date(end   + 'T12:00:00Z');
  const span = Math.round((eD - sD) / 86400000);
  const priorEnd   = new Date(sD); priorEnd.setUTCDate(priorEnd.getUTCDate() - 1);
  const priorStart = new Date(priorEnd); priorStart.setUTCDate(priorStart.getUTCDate() - span);
  return { priorStart: fmt(priorStart), priorEnd: fmt(priorEnd) };
}

function localMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeTotals(agents) {
  const tickets   = agents.flatMap((a) => a.tickets);
  const solved    = tickets.filter((t) => t.isSolved);
  const oneTouch  = tickets.filter((t) => t.oneTouch).length;
  const frtTimes  = tickets.filter((t) => t.firstReplyBizSeconds != null).map((t) => t.firstReplyBizSeconds);
  const resTimes  = tickets.filter((t) => t.resolutionBizSeconds != null).map((t) => t.resolutionBizSeconds);
  return {
    created:                tickets.length,
    solved:                 solved.length,
    unsolved:               tickets.length - solved.length,
    oneTouchPct:            solved.length > 0 ? (oneTouch / solved.length) * 100 : 0,
    medFirstReplyBizSeconds: localMedian(frtTimes),
    medResolutionBizSeconds: localMedian(resTimes),
  };
}

// ---------------------------------------------------------------------------
// Drill-down table with sortable columns
// ---------------------------------------------------------------------------

function DrillDownTable({ tickets }) {
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir,   setSortDir]   = useState('desc');

  function toggleSort(field) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('desc'); }
  }

  const sorted = [...tickets].sort((a, b) => {
    const av = a[sortField] ?? 0;
    const bv = b[sortField] ?? 0;
    const r = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return sortDir === 'asc' ? r : -r;
  });

  function SortTh({ field, children, align = 'right' }) {
    const active = sortField === field;
    return (
      <th
        className={`px-4 py-2 text-${align} text-xs text-gray-500 uppercase cursor-pointer hover:text-gray-700 select-none whitespace-nowrap`}
        onClick={() => toggleSort(field)}
      >
        {children}
        <span className={`ml-1 ${active ? 'text-blue-500' : 'text-transparent'}`}>
          {sortDir === 'asc' ? '▲' : '▼'}
        </span>
      </th>
    );
  }

  return (
    <div className="bg-gray-50 border-t border-b border-gray-200 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-gray-100">
            <th className="px-6 py-2 text-left text-xs text-gray-500 uppercase whitespace-nowrap">Ticket</th>
            <SortTh field="subject" align="left">Subject</SortTh>
            <th className="px-4 py-2 text-left text-xs text-gray-500 uppercase">Status</th>
            <th className="px-4 py-2 text-left text-xs text-gray-500 uppercase">Channel</th>
            <SortTh field="agentReplies">Replies</SortTh>
            <th className="px-4 py-2 text-center text-xs text-gray-500 uppercase">1-touch</th>
            <SortTh field="firstReplyBizSeconds">First Reply</SortTh>
            <SortTh field="resolutionBizSeconds">Resolution</SortTh>
            <SortTh field="reopens">Reopens</SortTh>
            <SortTh field="createdAt" align="left">Created</SortTh>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {sorted.map((t) => (
            <tr key={t.ticketId} className="hover:bg-gray-100">
              <td className="px-6 py-2">
                <a
                  href={`https://${SUBDOMAIN}.zendesk.com/agent/tickets/${t.ticketId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline font-mono"
                  onClick={(e) => e.stopPropagation()}
                >
                  #{t.ticketId}
                </a>
              </td>
              <td className="px-4 py-2 text-gray-700 max-w-xs truncate">{t.subject}</td>
              <td className="px-4 py-2"><StatusBadge status={t.status} /></td>
              <td className="px-4 py-2">
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${CHANNEL_COLOR[t.channel]}`}>
                  {t.isEloview ? 'Eloview' : CHANNEL_LABEL[t.channel]}
                </span>
              </td>
              <td className="px-4 py-2 text-right text-gray-700">{t.agentReplies}</td>
              <td className="px-4 py-2 text-center">
                {t.oneTouch
                  ? <span className="text-green-600 font-medium">✓</span>
                  : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-4 py-2 text-right text-teal-700 font-mono whitespace-nowrap">
                {formatDuration(t.firstReplyBizSeconds)}
              </td>
              <td className="px-4 py-2 text-right text-blue-700 font-mono whitespace-nowrap">
                {formatDuration(t.resolutionBizSeconds)}
              </td>
              <td className={`px-4 py-2 text-right font-medium ${t.reopens > 0 ? 'text-orange-600' : 'text-gray-400'}`}>
                {t.reopens}
              </td>
              <td className="px-4 py-2 text-left text-gray-400 text-xs whitespace-nowrap">
                {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function AgentProductivity() {
  const [groupId,         setGroupId]         = useState('');
  const [startDate,       setStartDate]       = useState('');
  const [endDate,         setEndDate]         = useState('');
  const [loading,         setLoading]         = useState(false);
  const [progress,        setProgress]        = useState(null);
  const [statusMessage,   setStatusMessage]   = useState('');
  const [data,            setData]            = useState(null);
  const [error,           setError]           = useState('');
  const [expandedAgent,   setExpandedAgent]   = useState(null);
  const [excludeAutomations, setExcludeAutomations] = useState(false);
  const [excludeEloview,  setExcludeEloview]  = useState(false);
  const [comparePrior,    setComparePrior]    = useState(false);
  const [priorTotals,     setPriorTotals]     = useState(null);
  const [priorLoading,    setPriorLoading]    = useState(false);
  const [showSlaSettings, setShowSlaSettings] = useState(false);
  const { targets, setTargets, resetTargets } = useSlaTargets();

  const eventSourceRef = useRef(null);
  const priorSourceRef = useRef(null);

  useEffect(() => {
    const pad = (n) => String(n).padStart(2, '0');
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const end = new Date(); const start = new Date();
    start.setDate(start.getDate() - 30);
    setStartDate(local(start));
    setEndDate(local(end));
  }, []);

  function startPriorPeriod(gId, start, end, exEloview) {
    if (priorSourceRef.current) priorSourceRef.current.close();
    setPriorTotals(null);
    setPriorLoading(true);
    const { priorStart, priorEnd } = calcPriorDates(start, end);
    const params = new URLSearchParams({
      group_id: gId, start: priorStart, end: priorEnd, exclude_eloview: exEloview,
    });
    const es = new EventSource(`/api/productivity/stream?${params}`);
    priorSourceRef.current = es;
    es.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'complete') { setPriorTotals(msg.data.totals); setPriorLoading(false); es.close(); }
      else if (msg.type === 'error') { setPriorLoading(false); es.close(); }
    };
    es.onerror = () => { setPriorLoading(false); es.close(); };
  }

  function handleGenerate() {
    if (!groupId || !startDate || !endDate) return;
    if (eventSourceRef.current) eventSourceRef.current.close();
    if (priorSourceRef.current) priorSourceRef.current.close();

    setLoading(true); setProgress(null); setStatusMessage('Connecting...');
    setData(null); setPriorTotals(null); setError('');

    const gId = groupId, s = startDate, e = endDate, exElo = excludeEloview, cmp = comparePrior;

    const params = new URLSearchParams({ group_id: gId, start: s, end: e, exclude_eloview: exElo });
    const es = new EventSource(`/api/productivity/stream?${params}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        setStatusMessage(msg.message);
      } else if (msg.type === 'progress') {
        setProgress({ current: msg.current, total: msg.total });
        setStatusMessage(`Fetching audits: ${msg.current} / ${msg.total} tickets`);
      } else if (msg.type === 'complete') {
        setData(msg.data);
        setLoading(false);
        setStatusMessage('');
        es.close();
        if (cmp) startPriorPeriod(gId, s, e, exElo);
      } else if (msg.type === 'error') {
        setError(msg.message); setLoading(false); es.close();
      }
    };
    es.onerror = () => { setError('Connection lost. Please try again.'); setLoading(false); es.close(); };
  }

  // ── Derived values ──────────────────────────────────────────────────────
  const visibleAgents = data
    ? (excludeAutomations ? data.agents.filter((a) => !a.isAutomation) : data.agents)
    : [];
  const t = data    ? computeTotals(visibleAgents) : null;
  const p = priorTotals;

  return (
    <div className="space-y-6">
      {/* ── Filter Bar ─────────────────────────────────────────────────── */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <GroupSelector value={groupId} onChange={setGroupId} />
          <DateRangePicker
            startDate={startDate} endDate={endDate}
            onStartChange={setStartDate} onEndChange={setEndDate}
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !groupId}
            className="px-5 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Loading...' : 'Generate Report'}
          </button>

          <div className="w-px h-6 bg-gray-200 hidden sm:block" />

          <label
            className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"
            title="Server-side filter — requires re-generating the report"
          >
            <input
              type="checkbox" checked={excludeEloview}
              onChange={(e) => setExcludeEloview(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Exclude Eloview&nbsp;<span className="text-gray-400 text-xs">↺</span>
          </label>

          <label
            className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer"
            title="Client-side filter — takes effect instantly, no re-run needed"
          >
            <input
              type="checkbox" checked={excludeAutomations}
              onChange={(e) => setExcludeAutomations(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Exclude automations
          </label>

          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox" checked={comparePrior}
              onChange={(e) => setComparePrior(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Compare prior period
          </label>

          <button
            onClick={() => setShowSlaSettings(!showSlaSettings)}
            title="Configure SLA targets"
            className={`ml-auto p-1.5 rounded-md text-lg leading-none transition-colors ${
              showSlaSettings ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
            }`}
          >
            ⚙
          </button>
        </div>

        {showSlaSettings && (
          <SlaSettings targets={targets} setTargets={setTargets} resetTargets={resetTargets} tab="productivity" />
        )}

        {loading && (
          <div className="mt-4">
            <p className="text-sm text-gray-500 mb-1">{statusMessage}</p>
            {progress && (
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        {priorLoading && (
          <p className="mt-2 text-xs text-gray-400">Fetching prior period for comparison…</p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error}</div>
      )}

      {!data && !loading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-gray-400">
          Select a group and date range, then click Generate Report.
        </div>
      )}

      {data && (
        <>
          {/* ── Summary Cards ────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <SummaryCard
              label="Created"
              value={t.created}
              color="blue"
              delta={<DeltaBadge current={t.created} prior={p?.created} neutral />}
            />
            <SummaryCard
              label="Solved"
              value={t.solved}
              color="green"
              delta={<DeltaBadge current={t.solved} prior={p?.solved} lowerIsBetter={false} />}
            />
            <SummaryCard
              label="Unsolved"
              value={t.unsolved}
              color="red"
              delta={<DeltaBadge current={t.unsolved} prior={p?.unsolved} />}
            />
            <SummaryCard
              label="% One-touch"
              value={`${t.oneTouchPct.toFixed(1)}%`}
              subtitle="solved in ≤1 reply"
              color="purple"
              status={pctStatus(t.oneTouchPct, targets.oneTouchPct)}
              delta={<DeltaBadge current={t.oneTouchPct} prior={p?.oneTouchPct} lowerIsBetter={false} />}
            />
            <SummaryCard
              label="Med First Reply"
              value={formatDuration(t.medFirstReplyBizSeconds)}
              subtitle="business hours"
              color="teal"
              status={durStatus(t.medFirstReplyBizSeconds, targets.firstReplyHours)}
              delta={<DeltaBadge current={t.medFirstReplyBizSeconds} prior={p?.medFirstReplyBizSeconds} />}
            />
            <SummaryCard
              label="Med Resolution"
              value={formatDuration(t.medResolutionBizSeconds)}
              subtitle="business hours"
              color="yellow"
              status={durStatus(t.medResolutionBizSeconds, targets.resolutionHours)}
              delta={<DeltaBadge current={t.medResolutionBizSeconds} prior={p?.medResolutionBizSeconds} />}
            />
          </div>

          {/* ── Agent Table ──────────────────────────────────────────────── */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Assignee</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Phone</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Chat</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Email</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Other</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Total</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Unsolved</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Solved</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Replies</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">% 1-touch</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Med First Reply</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Med Resolution</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Reopens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {visibleAgents.map((agent) => (
                  <>
                    <tr
                      key={agent.assigneeId}
                      className="hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => setExpandedAgent(expandedAgent === agent.assigneeId ? null : agent.assigneeId)}
                    >
                      <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <span className="text-gray-400 text-xs">
                            {expandedAgent === agent.assigneeId ? '▼' : '▶'}
                          </span>
                          {agent.assigneeName}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{agent.phone}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{agent.chat}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{agent.email}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{agent.other}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{agent.totalTaken}</td>
                      <td className={`px-4 py-3 text-right font-medium ${agent.unsolved > 0 ? 'text-red-600' : 'text-gray-700'}`}>
                        {agent.unsolved}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{agent.solved}</td>
                      <td className="px-4 py-3 text-right text-gray-700">{agent.agentReplies}</td>
                      <td className={`px-4 py-3 text-right font-medium ${
                        agent.oneTouchPct >= targets.oneTouchPct        ? 'text-green-600' :
                        agent.oneTouchPct >= targets.oneTouchPct * 0.75 ? 'text-yellow-600' :
                        'text-red-600'
                      }`}>
                        {agent.solved > 0 ? `${agent.oneTouchPct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                        {formatDuration(agent.medFirstReplyBizSeconds)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700 whitespace-nowrap">
                        {formatDuration(agent.medResolutionBizSeconds)}
                      </td>
                      <td className={`px-4 py-3 text-right font-medium ${agent.reopens > 0 ? 'text-orange-600' : 'text-gray-700'}`}>
                        {agent.reopens}
                      </td>
                    </tr>

                    {expandedAgent === agent.assigneeId && (
                      <tr key={`${agent.assigneeId}-drill`}>
                        <td colSpan={13} className="px-0 py-0">
                          <DrillDownTable tickets={agent.tickets} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
