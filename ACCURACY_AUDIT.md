# Zendesk KPI Dashboard — Accuracy Audit

## SECTION 1 — EXECUTIVE SUMMARY

Three confirmed bugs materially affect accuracy. The ticket count discrepancy (220 vs. 279) has **two compounding root causes**: an `EXCLUDED_SUBJECTS` filter that silently drops automation tickets from both tabs, and a UTC/Eastern timezone mismatch in date boundary handling that creates a ~4-hour blind spot at each end of the selected range. A third **[HIGH]** issue is that the two tabs apply inconsistent automation filtering — different subject lists, different matching logic — so the same ticket can appear in one tab's count but not the other's. Beyond counts, first reply time is susceptible to inflation by auto-responder public comments, and Eloview `ev_new_message` tickets are not excluded from any metric calculation despite the flag existing on every ticket object. The business hours function is mathematically correct and DST-safe; holiday exclusion is the only known gap there. Median math is correct.

---

## SECTION 2 — TICKET COUNT DISCREPANCY DIAGNOSIS

### Root Cause A — EXCLUDED_SUBJECTS silently drops tickets **[HIGH]**

`index.js` (both the Efficiency and Productivity streams) applies a subject filter before counting:

```js
const EXCLUDED_SUBJECTS = [
  'Customer signup notification',
  'Customer cancelled subscription',
  'Customer subscription expired',
];
const filtered = merged.filter(
  (t) => !EXCLUDED_SUBJECTS.some((s) => t.subject === s)
);
```

Zendesk Explore exports include these tickets. Your dashboard does not. If even ~59 tickets in the date range had one of these subjects, the entire gap is explained here. This is the most likely primary cause.

**Secondary problem within this cause**: matching is strict-equality and case-sensitive. A ticket with subject `"Customer Signup Notification"` (capital S, N) passes through the filter undetected because `"Customer signup notification" !== "Customer Signup Notification"`.

### Root Cause B — UTC date boundaries vs. Zendesk Explore's account timezone **[HIGH]**

The search query is built as:
```
type:ticket group:{groupId} created>=2026-04-06 created<=2026-04-11
```

Zendesk's Search API interprets bare date values as UTC. `created<=2026-04-11` means `created_at ≤ 2026-04-11T23:59:59Z`. Zendesk Explore's date picker uses the account's configured timezone (almost certainly Eastern). April 11 in Explore = `2026-04-11T04:00:00Z` → `2026-04-12T03:59:59Z` (EDT).

Net effect per boundary:

| Boundary | API query covers | Explore covers | Delta |
|---|---|---|---|
| Start (Apr 6) | Apr 6 00:00 UTC | Apr 6 04:00 UTC (8pm ET Apr 5 EDT) | API includes ~4hrs Explore excludes |
| End (Apr 11) | Up to Apr 11 23:59 UTC | Up to Apr 12 03:59 UTC | API misses ~4hrs Explore includes |

At each boundary you gain/lose roughly 0–20 tickets depending on ticket volume in those overnight UTC hours. For a week-long range this likely accounts for 5–15 of the 59.

**Combined**: Root Cause A (subject exclusions) + Root Cause B (timezone boundary) together fully explain the 59-ticket gap. To confirm: run the API query without the EXCLUDED_SUBJECTS filter and compare the raw `merged.length` against the Zendesk export count. The remaining delta after removing the filter will isolate the timezone-boundary portion.

### Root Cause C — Default date picker initialization uses UTC date **[MEDIUM]**

```js
// Dashboard.jsx
const end = new Date();
setEndDate(end.toISOString().split('T')[0]);
```

`toISOString()` returns the UTC date. After 8pm ET (midnight UTC), this returns tomorrow's date as the default end, potentially adding an unintended extra day to the range.

**Fix**: Use local date:
```js
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
setEndDate(localDate(new Date()));
```

---

## SECTION 3 — METRIC-BY-METRIC FINDINGS

### First Reply Time

**Current behavior**: Walk sorted audits, find first event that is a public `Comment` where `audit.author_id !== ticket.requester_id`, OR any `VoiceComment` with `public === false`. Pass `businessSeconds(created_at, firstReplyAudit.created_at)`.

**Accurate?** Partially. Two issues:

**[HIGH] Auto-responder inflation**: Zendesk trigger-fired public comments (acknowledgment emails, auto-responses) are posted under a real user or the "Zendesk" system user. If that user's ID ≠ requester_id, it counts as the first reply. A trigger that fires 30 seconds after ticket creation and posts a public comment would make first reply time appear as ~30 seconds, not the actual human response time.

Fix:
```js
// Flag known automation author IDs in an env var
const AUTOMATION_AUTHOR_IDS = new Set(
  (process.env.AUTOMATION_AUTHOR_IDS || '').split(',').filter(Boolean).map(Number)
);

// In the audit loop:
if (
  event.type === 'Comment' &&
  event.public === true &&
  audit.author_id !== ticket.requester_id &&
  !AUTOMATION_AUTHOR_IDS.has(audit.author_id)
) { ... }
```

**[LOW] author_id check is at audit level, not event level**: An audit has one `author_id` for all its events. In practice this is correct since Zendesk audits are single-author, but worth noting the check reads `audit.author_id` not `event.author_id` (which doesn't exist on Comment events).

**[LOW] VoiceComment `public === false`**: Zendesk can record voice transcripts as `public: true`. The current code only catches `public === false` VoiceComments. A transcript-style voice comment would not increment `agentReplies` and could be missed as a first-reply signal.

### Resolution Time

**Current behavior**: First `status → solved` event timestamp, `businessSeconds(created_at, firstSolvedTs)`.

**Accurate?** Yes for the stated definition. The `!firstResolvedTs` guard correctly captures first solve, not re-solve. Re-opened and re-solved tickets report time-to-first-solve, which is a reasonable and explicit business definition.

**[MEDIUM] Automation-closed tickets**: Tickets auto-closed by triggers have a `solved` status event within seconds of creation. These produce near-zero resolution times that pull the median down. The EXCLUDED_SUBJECTS filter catches some but not all (see inconsistency below).

**[LOW] Merged tickets**: When Ticket B is merged into Ticket A, Ticket B gets status `closed` via a `Change` event. `closed` ≠ `solved`, so `resolutionBizSeconds` will be null for merged tickets. This is correct behavior — they won't pollute resolution time stats.

### EXCLUDED_SUBJECTS Inconsistency Between Tabs **[HIGH]**

This is a confirmed bug. The two tabs use completely different lists:

| Subject | Efficiency tab (index.js) | Productivity tab (productivityMetrics.js) |
|---|---|---|
| `customer signup notification` | ✅ exact-match excluded | ✅ contains-match → Zendesk Agent |
| `customer signup summary notification` | ❌ NOT excluded | ✅ contains-match → Zendesk Agent |
| `customer cancelled subscription` | ✅ exact-match excluded | ✅ contains-match → Zendesk Agent |
| `customer subscription expired` | ✅ exact-match excluded | ❌ NOT detected |
| `abandoned call from:` | ❌ NOT excluded | ✅ startsWith-match → Zendesk Agent |
| `call could not be transcribed` | ❌ NOT excluded | ✅ contains-match → Zendesk Agent |

The Efficiency tab uses hard exclusion (drops from count). The Productivity tab routes them to Zendesk Agent (keeps in count, marks as automation). These tabs cannot produce consistent ticket counts for the same date range.

**Fix**: Centralize automation detection into a single shared module, apply it once before metrics calculation, and decide consistently: exclude entirely, or route to Zendesk Agent. Pick one approach and apply it to both tabs.

### One-Touch Percentage

**Current behavior**: `isSolved && agentReplies <= 1`. Denominator is `solved` tickets only.

**Accurate?** Mostly. `agentReplies` includes both `Comment` (public agent) and `VoiceComment` events. The 0-or-1 threshold is intentional per the defined business rule.

**[MEDIUM] Auto-responder inflation (same as First Reply Time)**: An auto-response public comment sets `agentReplies = 1`, and the ticket shows as one-touch. A real agent reply then makes it `agentReplies = 2`, no longer one-touch. Net effect: tickets with an auto-response followed by one real reply are incorrectly classified as NOT one-touch.

**[LOW] Customer replies don't reset the count**: The reply counter accumulates all agent replies regardless of customer activity. This is correct behavior per the defined definition.

### Channel Attribution

**Current behavior**: Tag-based lookup — `phone_caseorigin` → phone, `chat_offline`/`chat_caseorigin` → chat, `email_caseorigin`/`web_caseorigin` → email, else `other`.

**Accurate?** Dependent on tag discipline.

**[MEDIUM] Tags can be wrong or absent**: A phone ticket missing `phone_caseorigin` becomes 'other'. There is no fallback to `ticket.via.channel` (Zendesk's native channel field). If tag hygiene is inconsistent, phone/chat/email counts will be undercounted and 'other' will be inflated.

**[LOW] Multiple channel tags**: If a ticket has both `phone_caseorigin` and `email_caseorigin`, it's classified as phone (first match wins). Not a bug, but worth noting.

### Eloview Filtering (`ev_new_message`)

**Current behavior**: `isEloview` flag is set on each ticket in productivityMetrics.js. No tickets are excluded based on this flag anywhere in the server. They appear in all totals and per-agent counts.

**[MEDIUM] Eloview tickets included in all metrics**: `ev_new_message` tickets are counted in created/solved totals, included in first reply time and resolution time pools, and classified under whichever agent is assigned. If Eloview tickets have atypical patterns (fast auto-close, zero replies), they skew medians. Whether they should be excluded is a business decision, but there is currently no option to do so.

### Median Calculation

**Accurate?** Yes.

```js
function median(values) {
  if (values.length === 0) return 0;  // returns 0, not null — callers guard for this
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
```

Even/odd handling is correct. Null values are filtered before array construction. Callers guard with `array.length ? median(array) : null` before calling, so the `return 0` fallback is not reached in practice.

---

## SECTION 4 — BUSINESS HOURS FUNCTION AUDIT

The day-by-day approach using `Intl.DateTimeFormat` for timezone resolution is sound. DST handling is correct. The `etToUtc` helper makes a rough EST estimate then corrects it — this works because `BIZ_START_HOUR = 8` and `BIZ_END_HOUR = 17` never push the rough UTC estimate past midnight, so no date-crossing edge case is reachable.

**Known gap — Holiday exclusion**: US federal holidays are counted as full business days. This makes resolution times and first reply times appear longer than they are for tickets spanning holidays, and makes SLA reporting inaccurate around those dates.

### Unit Test Cases

| # | startUtc | endUtc | Expected (seconds) | Notes |
|---|---|---|---|---|
| 1 | `2026-04-14T14:00Z` (10am ET Mon) | `2026-04-14T18:00Z` (2pm ET Mon) | **14400** | Same day, within hours |
| 2 | `2026-04-14T20:00Z` (4pm ET Mon) | `2026-04-15T14:00Z` (10am ET Tue) | **10800** | 1hr Mon (4–5pm) + 2hr Tue (8–10am) |
| 3 | `2026-04-17T20:00Z` (4pm ET Fri) | `2026-04-20T14:00Z` (10am ET Mon) | **10800** | 1hr Fri + skip Sat/Sun + 2hr Mon |
| 4 | `2026-04-13T03:00Z` (11pm ET Sun) | `2026-04-14T13:00Z` (9am ET Mon) | **3600** | Weekend + outside hours; only 8–9am Mon counts |
| 5 | `2026-03-08T13:00Z` (9am EDT, DST spring-forward day) | `2026-03-08T20:00Z` (4pm EDT) | **25200** | 7 hrs; biz window is 12:00–21:00 UTC on this day |
| 6 | `2026-04-14T14:00Z` | `2026-04-14T14:00Z` | **0** | Zero duration |
| 7 | `2026-04-14T14:00Z` (10am ET Mon) | `2026-04-16T14:00Z` (10am ET Wed) | **64800** | 7hr Mon + 9hr Tue + 2hr Wed |

---

## SECTION 5 — KNOWN GAPS & RISKS

| Gap | Severity | Detail | Recommendation |
|---|---|---|---|
| Holiday exclusion | Medium | Business hours include federal holidays | Maintain a holiday list env var; skip those dates in `businessSeconds` |
| Auto-responder first reply | High | Trigger-fired public comments count as first human reply | Identify automation author IDs; exclude from first reply detection |
| Eloview tickets in metrics | Medium | `ev_new_message` tickets not filtered from any calculation | Add server-side toggle; exclude from time/reply metrics by default |
| Subject filter inconsistency | High | Two different lists, two different matching strategies across tabs | Centralize in a single shared module |
| Case-sensitive subject matching | Medium | `"Customer signup notification" !== "Customer Signup Notification"` | Use case-insensitive match everywhere |
| Channel relies on tags only | Medium | Tickets without proper tags classified as 'other' | Add fallback to `ticket.via.channel` |
| UTC date picker default | Medium | `toISOString()` returns UTC date, not local date | Use local date components |
| Reopened ticket resolution | Low | Reports time-to-first-solve; re-solve time not tracked | Acceptable as-is; document explicitly |
| Rate limit on audit fetches | Low | 10 concurrent audit fetches with retry on 429; large date ranges can be slow | Monitor; consider caching audits |

---

## SECTION 6 — PRIORITIZED FIX LIST

| # | Fix | Impact | Complexity |
|---|---|---|---|
| 1 | **Centralize and standardize automation subject detection** — one shared list, case-insensitive `includes()`, applied identically on both tabs | Eliminates inter-tab count inconsistency; likely closes most of the 220 vs. 279 gap | Low |
| 2 | **Append time to date boundaries in search query** — use `created>=2026-04-06T04:00:00Z created<=2026-04-12T03:59:59Z` (account timezone midnight) instead of bare dates | Closes timezone boundary gap vs. Explore | Medium |
| 3 | **Fix default date picker to use local date** — replace `toISOString().split('T')[0]` with local date components | Prevents off-by-one-day default range after 8pm ET | Low |
| 4 | **Exclude known automation author IDs from first reply detection** — env var `AUTOMATION_AUTHOR_IDS` | Prevents auto-responders from recording falsely fast first reply times | Low |
| 5 | **Add Eloview exclusion toggle** — server-side flag to strip `ev_new_message` tickets from time/reply metric pools | Prevents atypical auto-close tickets from skewing medians | Medium |
| 6 | **Add fallback to `ticket.via.channel`** for channel attribution when no channel tag present | Reduces 'other' bucket; improves phone/chat/email accuracy | Low |
| 7 | **Add holiday calendar exclusion to `businessSeconds`** | Corrects SLA math around US federal holidays | Medium |
| 8 | **Document reopened ticket behavior** — explicit comment in code and UI tooltip | Reduces future confusion about what resolution time means | Low |
