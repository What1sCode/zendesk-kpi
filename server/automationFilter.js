// Unified automation subject detection — used by both the Efficiency and Productivity streams.
// Case-insensitive substring match so capitalization variants are all caught.
const AUTOMATION_SUBJECTS = [
  'customer signup summary notification',
  'customer signup notification',
  'customer cancelled subscription',
  'customer subscription expired',
  'call could not be transcribed or summarized',
];

export function isAutomationSubject(subject) {
  if (!subject) return false;
  const lower = subject.toLowerCase();
  if (AUTOMATION_SUBJECTS.some((s) => lower.includes(s))) return true;
  if (lower.startsWith('abandoned call from:')) return true;
  return false;
}
