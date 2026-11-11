// Pick the best seats for a hub job: spread across providers, idle first, never cooling or broken seats.
// Drafted by OmniRoute (hub job "team pickSeats", round 2, 16/16 on Claude's checks); see verify_pickseats in the task note.
export function pickSeats(seats, state, opts) {
  const optsObj = opts ?? {};
  const stateObj = state ?? {};
  const n = optsObj.n ?? 3;
  const localOnly = optsObj.localOnly ?? false;
  const wantLocal = optsObj.wantLocal ?? false;
  const exclude = optsObj.exclude ?? [];
  const busy = optsObj.busy ?? new Set();
  const avoidProviders = optsObj.avoidProviders ?? [];
  const now = optsObj.now ?? Date.now();

  const excludeSet = new Set(exclude);
  const busySet = new Set(busy);
  const avoidSet = new Set(avoidProviders);

  const eligible = [];
  for (const seat of seats ?? []) {
    if (seat.ok !== true) continue;
    if (excludeSet.has(seat.id)) continue;
    const st = stateObj?.[seat.id];
    if (st?.downUntil > now) continue;
    if (localOnly && seat.local !== true) continue;
    eligible.push(seat);
  }

  const compareSeats = (a, b) => {
    const stateA = stateObj?.[a.id] ?? {};
    const stateB = stateObj?.[b.id] ?? {};
    const scoreA = (stateA.fails ?? 0) - (stateA.wins ?? 0);
    const scoreB = (stateB.fails ?? 0) - (stateB.wins ?? 0);
    if (scoreA !== scoreB) return scoreA - scoreB;

    const msA = a.ms ?? Number.POSITIVE_INFINITY;
    const msB = b.ms ?? Number.POSITIVE_INFINITY;
    if (msA !== msB) return msA - msB;

    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };

  const getProviderEntries = (list) => {
    const byProvider = new Map();
    for (const seat of list) {
      const provider = seat.provider ?? "unknown";
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(seat);
    }

    const entries = [];
    for (const [provider, providerSeats] of byProvider) {
      providerSeats.sort(compareSeats);
      entries.push({ provider, seats: providerSeats });
    }

    entries.sort((a, b) => {
      const aAvoid = avoidSet.has(a.provider) ? 1 : 0;
      const bAvoid = avoidSet.has(b.provider) ? 1 : 0;
      if (aAvoid !== bAvoid) return aAvoid - bAvoid;

      const cmp = compareSeats(a.seats[0], b.seats[0]);
      if (cmp !== 0) return cmp;
      if (a.provider < b.provider) return -1;
      if (a.provider > b.provider) return 1;
      return 0;
    });

    return entries;
  };

  const generateOrdered = (entries) => {
    const ordered = [];
    const maxLen = entries.reduce((m, e) => Math.max(m, e.seats.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const e of entries) {
        const seat = e.seats[i];
        if (seat) ordered.push(seat);
      }
    }
    return ordered;
  };

  const getOrdered = (list) => generateOrdered(getProviderEntries(list));

  const idleNormal = getOrdered(
    eligible.filter((s) => !busySet.has(s.id) && !avoidSet.has(s.provider ?? "unknown"))
  );
  const busyNormal = getOrdered(
    eligible.filter((s) => busySet.has(s.id) && !avoidSet.has(s.provider ?? "unknown"))
  );
  const idleAvoid = getOrdered(
    eligible.filter((s) => !busySet.has(s.id) && avoidSet.has(s.provider ?? "unknown"))
  );
  const busyAvoid = getOrdered(
    eligible.filter((s) => busySet.has(s.id) && avoidSet.has(s.provider ?? "unknown"))
  );

  const ordered = [...idleNormal, ...busyNormal, ...idleAvoid, ...busyAvoid];

  const selected = [];
  const usedIds = new Set();
  for (const seat of ordered) {
    if (selected.length >= n) break;
    if (usedIds.has(seat.id)) continue;
    usedIds.add(seat.id);
    selected.push(seat);
  }

  if (wantLocal) {
    const hasLocalEligible = eligible.some((s) => s.local === true);
    const hasLocalPicked = selected.some((s) => s.local === true);

    if (hasLocalEligible && !hasLocalPicked) {
      const localCandidates = eligible
        .filter((s) => s.local === true)
        .sort(compareSeats);
      const local = localCandidates[0];

      if (local) {
        let lastIndex = -1;
        for (let i = selected.length - 1; i >= 0; i--) {
          if (selected[i].local !== true) {
            lastIndex = i;
            break;
          }
        }

        if (lastIndex !== -1) {
          selected[lastIndex] = local;
        } else if (selected.length < n) {
          selected.push(local);
        }
      }
    }
  }

  return selected;
}
