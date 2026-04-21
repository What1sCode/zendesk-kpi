import { useState, useEffect, useRef } from 'react';
import GroupSelector from './GroupSelector';
import DateRangePicker from './DateRangePicker';
import MetricsTable from './MetricsTable';
import SummaryCard, { DeltaBadge } from './SummaryCard';
import SlaSettings from './SlaSettings';
import { useSlaTargets } from '../hooks/useSlaTargets';

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

// Returns 'good' | 'warn' | 'bad' | null based on how seconds compares to a target in hours.
function durStatus(seconds, targetHours) {
  if (seconds == null || !targetHours) return null;
  const r = seconds / (targetHours * 3600);
  if (r <= 1)   return 'good';
  if (r <= 1.5) return 'warn';
  return 'bad';
}

function flappingStatus(value, max) {
  if (value == null || !max) return null;
  if (value <= max)       return 'good';
  if (value <= max * 1.5) return 'warn';
  return 'bad';
}

// Calculates the prior period: same duration ending the day before `start`.
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

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

function Toggle({ left, right, active, onToggle, hint, disabled }) {
  const isRight = active === 'right';
  return (
    <div className={`flex items-center gap-2 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <span className={`text-sm font-medium ${!isRight ? 'text-gray-900' : 'text-gray-400'}`}>{left}</span>
      <button
        onClick={onToggle}
        className={`relative inline-flex h-5 w-10 items-center rounded-full transition-colors ${
          isRight ? 'bg-blue-600' : 'bg-gray-300'
        }`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          isRight ? 'translate-x-5' : 'translate-x-1'
        }`} />
      </button>
      <span className={`text-sm font-medium ${isRight ? 'text-gray-900' : 'text-gray-400'}`}>{right}</span>
      {hint && <span className="text-xs text-gray-400">{hint}</span>}
    </div>
  );
}

function downloadJson(payload, startDate, endDate) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `efficiency-${startDate}-to-${endDate}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [groupId,       setGroupId]       = useState('');
  const [startDate,     setStartDate]     = useState('');
  const [endDate,       setEndDate]       = useState('');
  const [loading,       setLoading]       = useState(false);
  const [progress,      setProgress]      = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [data,          setData]          = useState(null);
  const [error,         setError]         = useState('');
  const [useBizHours,   setUseBizHours]   = useState(true);
  const [useMedian,     setUseMedian]     = useState(false);
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

  function startPriorPeriod(gId, start, end) {
    if (priorSourceRef.current) priorSourceRef.current.close();
    setPriorTotals(null);
    setPriorLoading(true);
    const { priorStart, priorEnd } = calcPriorDates(start, end);
    const params = new URLSearchParams({
      group_id: gId, start: priorStart, end: priorEnd,
    });
    const es = new EventSource(`/api/metrics/stream?${params}`);
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

    const gId = groupId, s = startDate, e = endDate, cmp = comparePrior;

    const params = new URLSearchParams({ group_id: gId, start: s, end: e });
    const es = new EventSource(`/api/metrics/stream?${params}`);
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
        if (cmp) startPriorPeriod(gId, s, e);
      } else if (msg.type === 'error') {
        setError(msg.message); setLoading(false); es.close();
      }
    };
    es.onerror = () => { setError('Connection lost. Please try again.'); setLoading(false); es.close(); };
  }

  // ── Derived values ──────────────────────────────────────────────────────
  const t   = data?.totals;
  const p   = priorTotals;
  const biz = useBizHours ? 'Biz' : '';
  const am  = useMedian   ? 'med' : 'avg';

  const pickupVal  = t ? (useMedian ? t.medPickupTime : t.avgPickupTime) : null;
  const closeVal   = t ? t[`${am}${biz}TimeToClose`]   : null;
  const newVal     = t ? t[`${am}${biz}TimeInNew`]     : null;
  const openVal    = t ? t[`${am}${biz}TimeInOpen`]    : null;
  const pendingVal = t ? t[`${am}${biz}TimeInPending`] : null;
  const flappVal   = t ? (useMedian ? t.medFlapping : t.avgFlapping) : null;

  const pPickup  = p ? (useMedian ? p.medPickupTime : p.avgPickupTime) : null;
  const pClose   = p ? p[`${am}${biz}TimeToClose`]   : null;
  const pNew     = p ? p[`${am}${biz}TimeInNew`]     : null;
  const pOpen    = p ? p[`${am}${biz}TimeInOpen`]    : null;
  const pPending = p ? p[`${am}${biz}TimeInPending`] : null;
  const pFlapp   = p ? (useMedian ? p.medFlapping : p.avgFlapping) : null;

  const metricLabel = useMedian ? 'Med' : 'Avg';

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

          {/* Toggles — always visible, dimmed until data loads */}
          <Toggle
            left="Calendar" right="Biz Hours"
            active={useBizHours ? 'right' : 'left'}
            onToggle={() => setUseBizHours(!useBizHours)}
            hint={useBizHours ? '(Mon–Fri 8–5 ET)' : null}
            disabled={!data}
          />
          <Toggle
            left="Avg" right="Median"
            active={useMedian ? 'right' : 'left'}
            onToggle={() => setUseMedian(!useMedian)}
            disabled={!data}
          />

          <div className="w-px h-6 bg-gray-200 hidden sm:block" />

          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox" checked={comparePrior}
              onChange={(e) => setComparePrior(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Compare prior period
          </label>

          <div className="ml-auto flex items-center gap-1">
            {data && (
              <button
                onClick={() => downloadJson(data, startDate, endDate)}
                title="Download raw JSON for this report"
                className="p-1.5 rounded-md text-sm text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors font-mono"
              >
                ↓ JSON
              </button>
            )}
            <button
              onClick={() => setShowSlaSettings(!showSlaSettings)}
              title="Configure SLA targets"
              className={`p-1.5 rounded-md text-lg leading-none transition-colors ${
                showSlaSettings ? 'bg-gray-100 text-gray-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
              }`}
            >
              ⚙
            </button>
          </div>
        </div>

        {showSlaSettings && (
          <SlaSettings targets={targets} setTargets={setTargets} resetTargets={resetTargets} tab="efficiency" />
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

      {data && (
        <>
          {/* ── Summary Cards ────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <SummaryCard
              label="Tickets"
              value={t.ticketCount}
              color="gray"
              delta={<DeltaBadge current={t.ticketCount} prior={p?.ticketCount} neutral />}
            />
            <SummaryCard
              label={`${metricLabel} Pickup`}
              value={formatDuration(pickupVal)}
              subtitle="biz hours"
              color="green"
              status={durStatus(pickupVal, targets.pickupTimeHours)}
              delta={<DeltaBadge current={pickupVal} prior={pPickup} />}
            />
            <SummaryCard
              label={`${metricLabel} Time to Close`}
              value={formatDuration(closeVal)}
              color="teal"
              status={durStatus(closeVal, targets.timeToCloseHours)}
              delta={<DeltaBadge current={closeVal} prior={pClose} />}
            />
            <SummaryCard
              label={`${metricLabel} Time in New`}
              value={formatDuration(newVal)}
              color="blue"
              status={durStatus(newVal, targets.timeInNewHours)}
              delta={<DeltaBadge current={newVal} prior={pNew} />}
            />
            <SummaryCard
              label={`${metricLabel} Time in Open`}
              value={formatDuration(openVal)}
              color="red"
              status={durStatus(openVal, targets.timeInOpenHours)}
              delta={<DeltaBadge current={openVal} prior={pOpen} />}
            />
            <SummaryCard
              label={`${metricLabel} Time in Pending`}
              value={formatDuration(pendingVal)}
              color="yellow"
              status={durStatus(pendingVal, targets.timeInPendingHours)}
              delta={<DeltaBadge current={pendingVal} prior={pPending} />}
            />
            <SummaryCard
              label={`${metricLabel} Flapping`}
              value={flappVal != null ? flappVal.toFixed(1) : '—'}
              subtitle={`${t.totalFlapping} total`}
              color="purple"
              status={flappingStatus(flappVal, targets.maxFlapping)}
              delta={<DeltaBadge current={flappVal} prior={pFlapp} />}
            />
          </div>

          <MetricsTable
            assignees={data.assignees}
            formatDuration={formatDuration}
            useBizHours={useBizHours}
            useMedian={useMedian}
          />
        </>
      )}
    </div>
  );
}
