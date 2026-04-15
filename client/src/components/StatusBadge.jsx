const COLORS = {
  new: 'bg-blue-100 text-blue-800',
  open: 'bg-red-100 text-red-800',
  pending: 'bg-yellow-100 text-yellow-800',
  hold: 'bg-gray-100 text-gray-800',
  solved: 'bg-green-100 text-green-800',
  closed: 'bg-gray-200 text-gray-600',
};

export default function StatusBadge({ status }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${COLORS[status] || COLORS.closed}`}
    >
      {status}
    </span>
  );
}
