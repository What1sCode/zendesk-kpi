import { useState, useEffect, useRef } from 'react';
import GroupSelector from './GroupSelector';
import DateRangePicker from './DateRangePicker';
import MetricsTable from './MetricsTable';
import StatusBadge from './StatusBadge';

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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
  const eventSourceRef = useRef(null);

  // Default dates: last 30 days
  useEffect(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    setStartDate(start.toISOString().split('T')[0]);
    setEndDate(end.toISOString().split('T')[0]);
  }, []);

  function handleGenerate() {
    if (!groupId || !startDate || !endDate) return;

    // Close any existing connection
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

        {/* Progress Bar */}
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

      {/* Summary Cards */}
      {data && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard
              label="Avg Time in New"
              value={formatDuration(data.totals.avgTimeInNew)}
              color="blue"
            />
            <SummaryCard
              label="Avg Time in Open"
              value={formatDuration(data.totals.avgTimeInOpen)}
              color="red"
            />
            <SummaryCard
              label="Avg Time in Pending"
              value={formatDuration(data.totals.avgTimeInPending)}
              color="yellow"
            />
            <SummaryCard
              label="Avg Flapping"
              value={data.totals.avgFlapping.toFixed(1)}
              subtitle={`${data.totals.totalFlapping} total across ${data.ticketCount} tickets`}
              color="purple"
            />
          </div>

          <MetricsTable assignees={data.assignees} formatDuration={formatDuration} />
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, subtitle, color }) {
  const colorMap = {
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
