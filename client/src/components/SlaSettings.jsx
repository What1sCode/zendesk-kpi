import { SLA_DEFAULTS } from '../hooks/useSlaTargets';

const FIELDS = {
  efficiency: [
    { key: 'pickupTimeHours',    label: 'Pickup (hrs)' },
    { key: 'timeToCloseHours',   label: 'Time to Close (hrs)' },
    { key: 'timeInNewHours',     label: 'Time in New (hrs)' },
    { key: 'timeInOpenHours',    label: 'Time in Open (hrs)' },
    { key: 'timeInPendingHours', label: 'Time in Pending (hrs)' },
    { key: 'maxFlapping',        label: 'Max Flapping' },
  ],
  productivity: [
    { key: 'firstReplyHours',  label: 'First Reply (hrs)' },
    { key: 'resolutionHours',  label: 'Resolution (hrs)' },
    { key: 'oneTouchPct',      label: 'One-touch Target (%)' },
  ],
};

export default function SlaSettings({ targets, setTargets, resetTargets, tab }) {
  const fields = FIELDS[tab] ?? [];
  return (
    <div className="mt-3 pt-3 border-t border-gray-200">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
          SLA Targets — cards turn green / yellow / red based on these thresholds
        </span>
        <button
          onClick={resetTargets}
          className="text-xs text-gray-400 hover:text-gray-600 underline"
        >
          Reset to defaults
        </button>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {fields.map(({ key, label }) => (
          <div key={key}>
            <label className="block text-xs text-gray-500 mb-1">{label}</label>
            <input
              type="number"
              min="0"
              step={key === 'oneTouchPct' || key === 'maxFlapping' ? 1 : 0.5}
              value={targets[key]}
              onChange={(e) =>
                setTargets({ ...targets, [key]: parseFloat(e.target.value) || 0 })
              }
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400 mt-0.5">
              default: {SLA_DEFAULTS[key]}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
