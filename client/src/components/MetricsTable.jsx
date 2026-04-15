import { useState } from 'react';
import StatusBadge from './StatusBadge';

export default function MetricsTable({ assignees, formatDuration, useBizHours }) {
  const [expandedUser, setExpandedUser] = useState(null);
  const [sortField, setSortField] = useState('ticketCount');
  const [sortDir, setSortDir] = useState('desc');

  const pre = useBizHours ? 'Biz' : '';

  function handleSort(field) {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  const sorted = [...assignees].sort((a, b) => {
    const mult = sortDir === 'asc' ? 1 : -1;
    return ((a[sortField] ?? 0) - (b[sortField] ?? 0)) * mult;
  });

  const SortHeader = ({ field, children }) => (
    <th
      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:text-gray-700 select-none"
      onClick={() => handleSort(field)}
    >
      <span className="flex items-center gap-1">
        {children}
        {sortField === field && (
          <span className="text-blue-600">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        )}
      </span>
    </th>
  );

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Assignee
            </th>
            <SortHeader field="ticketCount">Tickets</SortHeader>
            <SortHeader field="pickupCount">Pickups</SortHeader>
            <SortHeader field="avgPickupTime">Avg Pickup</SortHeader>
            <SortHeader field="medPickupTime">Med Pickup</SortHeader>
            <SortHeader field={`avg${useBizHours ? 'Biz' : ''}TimeToClose`}>Avg Close</SortHeader>
            <SortHeader field={`med${useBizHours ? 'Biz' : ''}TimeToClose`}>Med Close</SortHeader>
            <SortHeader field={`avg${pre}TimeInNew`}>Avg New</SortHeader>
            <SortHeader field={`med${pre}TimeInNew`}>Med New</SortHeader>
            <SortHeader field={`avg${pre}TimeInOpen`}>Avg Open</SortHeader>
            <SortHeader field={`med${pre}TimeInOpen`}>Med Open</SortHeader>
            <SortHeader field={`avg${pre}TimeInPending`}>Avg Pending</SortHeader>
            <SortHeader field={`med${pre}TimeInPending`}>Med Pending</SortHeader>
            <SortHeader field="avgFlapping">Avg Flap</SortHeader>
            <SortHeader field="medFlapping">Med Flap</SortHeader>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {sorted.map((agg) => (
            <UserRow
              key={agg.assigneeId}
              agg={agg}
              pre={pre}
              expanded={expandedUser === agg.assigneeId}
              onToggle={() =>
                setExpandedUser(expandedUser === agg.assigneeId ? null : agg.assigneeId)
              }
              formatDuration={formatDuration}
              useBizHours={useBizHours}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserRow({ agg, pre, expanded, onToggle, formatDuration, useBizHours }) {
  return (
    <>
      <tr
        className="hover:bg-gray-50 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-sm font-medium text-gray-900">
          <span className="flex items-center gap-2">
            <span className="text-gray-400 text-xs">{expanded ? '\u25BC' : '\u25B6'}</span>
            {agg.assigneeName}
          </span>
        </td>
        <td className="px-4 py-3 text-sm text-gray-700">{agg.ticketCount}</td>
        <td className="px-4 py-3 text-sm text-gray-700">{agg.pickupCount}</td>
        <td className="px-4 py-3 text-sm text-green-700 font-mono">
          {formatDuration(agg.avgPickupTime)}
        </td>
        <td className="px-4 py-3 text-sm text-green-500 font-mono">
          {formatDuration(agg.medPickupTime)}
        </td>
        <td className="px-4 py-3 text-sm text-teal-700 font-mono">
          {formatDuration(useBizHours ? agg.avgBizTimeToClose : agg.avgTimeToClose)}
        </td>
        <td className="px-4 py-3 text-sm text-teal-500 font-mono">
          {formatDuration(useBizHours ? agg.medBizTimeToClose : agg.medTimeToClose)}
        </td>
        <td className="px-4 py-3 text-sm text-blue-700 font-mono">
          {formatDuration(agg[`avg${pre}TimeInNew`])}
        </td>
        <td className="px-4 py-3 text-sm text-blue-500 font-mono">
          {formatDuration(agg[`med${pre}TimeInNew`])}
        </td>
        <td className="px-4 py-3 text-sm text-red-700 font-mono">
          {formatDuration(agg[`avg${pre}TimeInOpen`])}
        </td>
        <td className="px-4 py-3 text-sm text-red-500 font-mono">
          {formatDuration(agg[`med${pre}TimeInOpen`])}
        </td>
        <td className="px-4 py-3 text-sm text-yellow-700 font-mono">
          {formatDuration(agg[`avg${pre}TimeInPending`])}
        </td>
        <td className="px-4 py-3 text-sm text-yellow-500 font-mono">
          {formatDuration(agg[`med${pre}TimeInPending`])}
        </td>
        <td className="px-4 py-3 text-sm text-purple-700 font-mono">
          {agg.avgFlapping.toFixed(1)}
        </td>
        <td className="px-4 py-3 text-sm text-purple-500 font-mono">
          {agg.medFlapping}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={15} className="px-0 py-0">
            <TicketDrillDown
              tickets={agg.tickets}
              formatDuration={formatDuration}
              useBizHours={useBizHours}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function TicketDrillDown({ tickets, formatDuration, useBizHours }) {
  const subdomain = 'elotouchcare';

  return (
    <div className="bg-gray-50 border-t border-b border-gray-200">
      <table className="min-w-full">
        <thead>
          <tr className="text-xs text-gray-500 uppercase">
            <th className="px-6 py-2 text-left">Ticket</th>
            <th className="px-4 py-2 text-left">Subject</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-left">Pickup</th>
            <th className="px-4 py-2 text-left">Time to Close</th>
            <th className="px-4 py-2 text-left">Time in New</th>
            <th className="px-4 py-2 text-left">Time in Open</th>
            <th className="px-4 py-2 text-left">Time in Pending</th>
            <th className="px-4 py-2 text-left">Flapping</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {tickets.map((t) => (
            <tr key={t.ticketId} className="hover:bg-gray-100 text-sm">
              <td className="px-6 py-2">
                <a
                  href={`https://${subdomain}.zendesk.com/agent/tickets/${t.ticketId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline font-mono"
                >
                  #{t.ticketId}
                </a>
              </td>
              <td className="px-4 py-2 text-gray-700 max-w-xs truncate">{t.subject}</td>
              <td className="px-4 py-2">
                <StatusBadge status={t.status} />
              </td>
              <td className="px-4 py-2 text-green-700 font-mono">
                {t.pickupTime != null ? formatDuration(t.pickupTime) : '—'}
              </td>
              <td className="px-4 py-2 text-teal-700 font-mono">
                {t.timeToClose != null
                  ? formatDuration(useBizHours ? t.bizTimeToClose : t.timeToClose)
                  : '—'}
              </td>
              <td className="px-4 py-2 text-blue-700 font-mono">
                {formatDuration(useBizHours ? t.bizTimeInNew : t.timeInNew)}
              </td>
              <td className="px-4 py-2 text-red-700 font-mono">
                {formatDuration(useBizHours ? t.bizTimeInOpen : t.timeInOpen)}
              </td>
              <td className="px-4 py-2 text-yellow-700 font-mono">
                {formatDuration(useBizHours ? t.bizTimeInPending : t.timeInPending)}
              </td>
              <td className="px-4 py-2 text-purple-700 font-mono">{t.flapping}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
