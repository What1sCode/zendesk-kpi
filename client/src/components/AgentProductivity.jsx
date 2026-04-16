import { useState, useEffect, useRef } from 'react';
import GroupSelector from './GroupSelector';
import DateRangePicker from './DateRangePicker';

function formatDuration(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function SummaryCard({ label, value, subtitle, color }) {
  const colorMap = {
    blue: 'border-blue-400 bg-blue-50',
    green: 'border-green-400 bg-green-50',
    red: 'border-red-400 bg-red-50',
    yellow: 'border-yellow-400 bg-yellow-50',
    purple: 'border-purple-400 bg-purple-50',
    teal: 'border-teal-400 bg-teal-50',
  };
  return (
    <div className={`rounded-lg border-l-4 p-4 ${colorMap[color] || 'border-gray-400 bg-gray-50'}`}>
      <p className="text-sm text-gray-600">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

export default function AgentProductivity() {
  const [groupId, setGroupId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
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
    if (eventSourceRef.current) eventSourceRef.current.close();

    setLoading(true);
    setProgress(null);
    setStatusMessage('Connecting...');
    setData(null);
    setError('');

    const params = new URLSearchParams({ group_id: groupId, start: startDate, end: endDate });
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

      {!data && !loading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-gray-400">
          Select a group and date range, then click Generate Report.
        </div>
      )}

      {data && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <SummaryCard label="Created" value={t.created} color="blue" />
            <SummaryCard label="Solved" value={t.solved} color="green" />
            <SummaryCard label="Unsolved" value={t.unsolved} color="red" />
            <SummaryCard
              label="% One-touch"
              value={`${t.oneTouchPct.toFixed(1)}%`}
              subtitle="solved in 1 reply"
              color="purple"
            />
            <SummaryCard
              label="Med First Reply"
              value={formatDuration(t.medFirstReplyBizSeconds)}
              subtitle="business hours"
              color="teal"
            />
            <SummaryCard
              label="Med Resolution"
              value={formatDuration(t.medResolutionBizSeconds)}
              subtitle="business hours"
              color="yellow"
            />
          </div>

          {/* Agent Table */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Assignee</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Phone</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Chat</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Email</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Eloview</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Total Taken</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Unsolved</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Solved</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Replies</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">% One-touch</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Med First Reply</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Med Resolution</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-700 whitespace-nowrap">Reopens</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.map((agent, i) => (
                  <tr
                    key={agent.assigneeId}
                    className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                  >
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{agent.assigneeName}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{agent.phone}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{agent.chat}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{agent.email}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{agent.eloview}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">{agent.totalTaken}</td>
                    <td className={`px-4 py-3 text-right font-medium ${agent.unsolved > 0 ? 'text-red-600' : 'text-gray-700'}`}>
                      {agent.unsolved}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{agent.solved}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{agent.agentReplies}</td>
                    <td className={`px-4 py-3 text-right font-medium ${
                      agent.oneTouchPct >= 80 ? 'text-green-600' :
                      agent.oneTouchPct >= 60 ? 'text-yellow-600' : 'text-red-600'
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
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
