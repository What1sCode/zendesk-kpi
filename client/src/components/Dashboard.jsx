import { useState, useEffect, useRef } from 'react';
import GroupSelector from './GroupSelector';
import DateRangePicker from './DateRangePicker';
import MetricsTable from './MetricsTable';

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function Toggle({ left, right, active, onToggle, hint }) {
  const isRight = active === 'right';
  return (
    <div className="flex items-center gap-3">
      <span className={`text-sm font-medium ${!isRight ? 'text-gray-900' : 'text-gray-400'}`}>
        {left}
      </span>
      <button
        onClick={onToggle}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          isRight ? 'bg-blue-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            isRight ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
      <span className={`text-sm font-medium ${isRight ? 'text-gray-900' : 'text-gray-400'}`}>
        {right}
      </span>
      {hint && <span className="text-xs text-gray-500">{hint}</span>}
    </div>
  );
}

export default function Dashboard() {
  const [groupId, setGroupId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [useBizHours, setUseBizHours] = useState(true);
  const [useMedian, setUseMedian] = useState(false);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
  }, []);

  function handleGenerate() {
    if (!groupId || !startDate || !endDate) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setLoading(true);
    setProgress(null);
    setStatusMessage('Connecting...');
    setData(null);
    setError('');

    const params = new URLSearchParams({ group_id: groupId, start: startDate, end: endDate });
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
      } else if (msg.type === 'error') {
        setError(msg.message);
        setLoading(false);
        es.close();
      }
    };

    es.onerror = () => {
      setError('Connection lost. Please try again.');
      setLoading(false);
      es.close();
    };
  }

  const t = data?.totals;
  const biz = useBizHours ? 'Biz' : '';
  const am = useMedian ? 'med' : 'avg';
  const label = useMedian ? 'Median' : 'Avg';

  return (
    <div className="space-y-6">
      {/* Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <GroupSelector value={groupId} onChange={setGroupId} />
          <DateRangePicker
            startDate={startDate}
            endDate={endDate}
            onStartChange={setStartDate}
            onEndChange={setEndDate}
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !groupId}
            className="px-5 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Loading...' : 'Generate Report'}
          </button>
        </div>

        {loading && (
          <div className="mt-4">
            <p className="text-sm text-gray-600 mb-1">{statusMessage}</p>
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
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Toggles */}
          <div className="flex flex-wrap items-center gap-6">
            <Toggle
              left="Calendar Time"
              right="Business Hours"
              active={useBizHours ? 'right' : 'left'}
              onToggle={() => setUseBizHours(!useBizHours)}
              hint={useBizHours ? '(Mon-Fri, 8am-5pm ET)' : null}
            />
            <Toggle
              left="Average"
              right="Median"
              active={useMedian ? 'right' : 'left'}
              onToggle={() => setUseMedian(!useMedian)}
            />
          </div>

          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <SummaryCard
              label={`${label} Pickup Time`}
              value={formatDuration(useMedian ? t.medPickupTime : t.avgPickupTime)}
              subtitle="biz hours only"
              color="green"
            />
            <SummaryCard
              label={`${label} Time to Close`}
              value={formatDuration(t[`${am}${biz}TimeToClose`])}
              color="teal"
            />
            <SummaryCard
              label={`${label} Time in New`}
              value={formatDuration(t[`${am}${biz}TimeInNew`])}
              color="blue"
            />
            <SummaryCard
              label={`${label} Time in Open`}
              value={formatDuration(t[`${am}${biz}TimeInOpen`])}
              color="red"
            />
            <SummaryCard
              label={`${label} Time in Pending`}
              value={formatDuration(t[`${am}${biz}TimeInPending`])}
              color="yellow"
            />
            <SummaryCard
              label={`${label} Flapping`}
              value={useMedian ? t.medFlapping : t.avgFlapping.toFixed(1)}
              subtitle={`${t.totalFlapping} total across ${data.ticketCount} tickets`}
              color="purple"
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

function SummaryCard({ label, value, subtitle, color }) {
  const colorMap = {
    green: 'border-green-400 bg-green-50',
    teal: 'border-teal-400 bg-teal-50',
    blue: 'border-blue-400 bg-blue-50',
    red: 'border-red-400 bg-red-50',
    yellow: 'border-yellow-400 bg-yellow-50',
    purple: 'border-purple-400 bg-purple-50',
  };

  return (
    <div className={`rounded-lg border-l-4 p-4 ${colorMap[color] || 'border-gray-400 bg-gray-50'}`}>
      <p className="text-sm text-gray-600">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}
