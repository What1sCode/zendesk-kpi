import { useState } from 'react';

export const SLA_DEFAULTS = {
  firstReplyHours:    1,
  resolutionHours:    8,
  oneTouchPct:        80,
  pickupTimeHours:    0.5,
  timeToCloseHours:   8,
  timeInNewHours:     1,
  timeInOpenHours:    4,
  timeInPendingHours: 24,
  maxFlapping:        3,
};

const STORAGE_KEY = 'zkpi_sla_targets';

export function useSlaTargets() {
  const [targets, setTargetsRaw] = useState(() => {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s ? { ...SLA_DEFAULTS, ...JSON.parse(s) } : { ...SLA_DEFAULTS };
    } catch {
      return { ...SLA_DEFAULTS };
    }
  });

  function setTargets(next) {
    setTargetsRaw(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
  }

  return {
    targets,
    setTargets,
    resetTargets: () => setTargets({ ...SLA_DEFAULTS }),
  };
}
