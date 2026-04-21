const STATUS_CLASSES = {
  good: 'border-green-500 bg-green-50',
  warn: 'border-yellow-500 bg-yellow-50',
  bad:  'border-red-500 bg-red-50',
};

const COLOR_CLASSES = {
  green:  'border-green-400 bg-green-50',
  teal:   'border-teal-400 bg-teal-50',
  blue:   'border-blue-400 bg-blue-50',
  red:    'border-red-400 bg-red-50',
  yellow: 'border-yellow-400 bg-yellow-50',
  purple: 'border-purple-400 bg-purple-50',
  gray:   'border-gray-300 bg-gray-50',
};

// Shows a % change vs prior period. Arrow is green when the change is an improvement.
export function DeltaBadge({ current, prior, lowerIsBetter = true, neutral = false }) {
  if (prior == null || current == null || prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  if (Math.abs(pct) < 2) return null;
  const improved = lowerIsBetter ? pct < 0 : pct > 0;
  const arrow = pct > 0 ? '▲' : '▼';
  const cls = neutral ? 'text-gray-500' : improved ? 'text-green-600' : 'text-red-600';
  return (
    <span className={`text-xs font-medium ${cls}`}>
      {arrow}{Math.abs(pct).toFixed(0)}%
    </span>
  );
}

export default function SummaryCard({ label, value, subtitle, color = 'gray', status, delta }) {
  const cls = status
    ? (STATUS_CLASSES[status] ?? COLOR_CLASSES[color] ?? COLOR_CLASSES.gray)
    : (COLOR_CLASSES[color] ?? COLOR_CLASSES.gray);

  return (
    <div className={`rounded-lg border-l-4 p-4 ${cls}`}>
      <p className="text-sm text-gray-600">{label}</p>
      <div className="flex items-baseline gap-2 mt-1">
        <p className="text-2xl font-bold text-gray-900">{value}</p>
        {delta}
      </div>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}
