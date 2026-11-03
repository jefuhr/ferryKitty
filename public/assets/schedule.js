// Platform-independent schedule rules. All times and snapshots are supplied by the caller.

// Cruise-day IDs can differ between Saturdays even when the published sailing is identical.
// A reviewed mapping's fallback is namespaced so an unverified date cannot hit a reused feed ID.
export function tripIdentityForDate(item, date, field = "liveTripId") {
  return item?.[`${field}sByDate`]?.[date] ?? item?.[field];
}

export function zonedParts(date = new Date(), timeZone = "America/New_York") {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    seconds: (Number(values.hour) % 24) * 3600 + Number(values.minute) * 60 + Number(values.second)
  };
}

export function addDays(dateKey, amount) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + amount));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function activeServices(data, dateKey) {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  const active = new Set();
  for (const item of data.calendars || []) {
    if (dateKey >= item.startDate && dateKey <= item.endDate && item.weekdays[weekday]) active.add(item.serviceId);
  }
  for (const item of data.exceptions || []) {
    if (item.date !== dateKey) continue;
    if (item.added) active.add(item.serviceId); else active.delete(item.serviceId);
  }
  return active;
}

export function scheduleRange(data) {
  const bounded = (data.calendars || []).filter((item) => item.startDate && item.endDate);
  const added = (data.exceptions || []).filter((item) => item.added).map((item) => item.date);
  if (!bounded.length && !added.length) return null;
  return {
    first: [...bounded.map((item) => item.startDate), ...added].sort()[0],
    last: [...bounded.map((item) => item.endDate), ...added].sort().at(-1)
  };
}

export function viewFrame(data, viewDate, now) {
  const current = zonedParts(now, data.meta.timezone);
  if (!viewDate || viewDate === current.dateKey) {
    return { dateKey: current.dateKey, seconds: current.seconds, today: current.dateKey, live: true };
  }
  return { dateKey: viewDate, seconds: 0, today: current.dateKey, live: false };
}

export function confirmedCrewCoverage(data, date) {
  const holiday = data?.meta?.crewScheduleStatus?.confirmedHolidays;
  if (holiday?.dates?.includes(date)) return holiday;
  const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
  const reviewed = data?.meta?.crewScheduleStatus?.reviewedWeekdays;
  if (!weekend && reviewed && date >= reviewed.startDate && date <= reviewed.endDate &&
    !(reviewed.excludedDates || []).includes(date)) return reviewed;
  const coverage = data?.meta?.crewScheduleStatus?.[weekend ? "confirmedWeekends" : "confirmedWeekdays"];
  return coverage && date >= coverage.startDate && date <= coverage.endDate &&
    !(coverage.excludedDates || []).includes(date) ? coverage : null;
}

export function routeDirectionGroups({ data, realtime, viewDate = null, now, limitPerGroup = 5 }) {
  const frame = viewFrame(data, viewDate, now);
  const current = { dateKey: frame.dateKey, seconds: frame.seconds };
  const departureWindowSeconds = (Number(data.meta.departureWindowMinutes) || 180) * 60;
  // Live estimates describe boats that are on the water now. On any other day there are none, and
  // pretending otherwise would put yesterday's delays on tomorrow's sailings.
  const updates = frame.live ? new Map((realtime.updates || []).map((item) => [`${item.tripId}|${item.stopId}`, item])) : new Map();
  const vehicles = frame.live ? new Map((realtime.vehicles || []).map((item) => [String(item.tripId), item])) : new Map();
  // Which vessel is on each boat right now. The feed only names a vessel for a trip it has reached,
  // so a sailing later today has none of its own — but the workbook knows which boat runs it, and
  // that boat is out on the water under a vessel the feed *has* named. Freshest report wins when a
  // boat appears on more than one trip, which happens as it hands over between them.
  const vessels = new Map();
  for (const item of frame.live ? realtime.vehicles || [] : []) {
    if (!item.boat || !item.boatName) continue;
    const seen = vessels.get(item.boat);
    if (!seen || (item.updatedAtEpochSeconds || 0) >= (seen.updatedAtEpochSeconds || 0)) vessels.set(item.boat, item);
  }
  const groups = new Map();
  const lastDepartures = new Map();
  const lastGovernorsIslandDepartures = new Map();

  for (let offset = -1; offset <= 0; offset += 1) {
    const serviceDate = addDays(current.dateKey, offset);
    const active = activeServices(data, serviceDate);
    for (const original of data.departures || []) {
      const departure = { ...original,
        liveTripId: tripIdentityForDate(original, serviceDate),
        predictTripId: tripIdentityForDate(original, serviceDate, "predictTripId") };
      if (!active.has(departure.serviceId)) continue;
      const calendarDate = addDays(serviceDate, Math.floor(departure.seconds / 86400));
      if (calendarDate !== current.dateKey) continue;
      // Usually the row's own trip. A home-port run's id is minted by the build and matches nothing
      // live, so it names the revenue trip it follows out instead — the boat going to Pier C is the
      // boat that just got in, and it ties up as late as that trip ran. Crew shuttles carry no such
      // trip and keep their published times.
      const update = departure.scheduleOnly && !departure.liveTripId
        ? null : updates.get(`${departure.liveTripId || departure.tripId}|${departure.stopId}`);
      if (update?.canceled) continue;
      const liveDelay = Number(update?.delaySeconds);
      const hasLiveTiming = !realtime.stale && update?.delaySeconds != null && Number.isFinite(liveDelay);
      // NYC Ferry boats may arrive ahead of schedule, but never depart early.
      // Keep the published departure as the rider-facing floor even for old cached updates.
      const delay = hasLiveTiming ? Math.max(0, liveDelay) : 0;
      const delta = offset * 86400 + departure.seconds + delay - current.seconds;
      const slotKey = `${departure.routeId}|${departure.variant || ""}|${departure.directionId}`;
      const scheduledMoment = offset * 86400 + departure.seconds;
      // LAST means the last departure a passenger can take. A home-port run or a crew shuttle
      // leaves after it and carries nobody, so neither is allowed to claim the badge.
      const carriesPassengers = !departure.outOfService && !departure.crewShuttle && !departure.arrival;
      const previousLast = carriesPassengers ? lastDepartures.get(slotKey) : null;
      if (carriesPassengers && (!previousLast || scheduledMoment > previousLast.scheduledMoment)) {
        lastDepartures.set(slotKey, { tripId: String(departure.tripId), scheduledMoment });
      }
      if (departure.routeId === "SB" && departure.servesGovernorsIsland) {
        const previousIslandLast = lastGovernorsIslandDepartures.get(slotKey);
        if (!previousIslandLast || scheduledMoment > previousIslandLast.scheduledMoment) {
          lastGovernorsIslandDepartures.set(slotKey, { tripId: String(departure.tripId), scheduledMoment });
        }
      }
      if (delta < -60) continue;
      const via = (departure.via || []).join(" > ");
      const key = `${departure.routeId}|${departure.variant || ""}|${departure.directionId}|${departure.destination}|${via}`;
      const group = groups.get(key) || {
        key, routeId: departure.routeId, directionId: departure.directionId,
        destination: departure.destination, via: departure.via || [], variant: departure.variant || null,
        outOfService: Boolean(departure.outOfService), crewShuttle: Boolean(departure.crewShuttle),
        arrival: Boolean(departure.arrival),
        departures: []
      };
      group.departures.push({
        ...departure,
        endsShift: data.meta.crewScheduleStatus && !confirmedCrewCoverage(data, serviceDate) ? null : departure.endsShift,
        serviceDate,
        delay,
        delta,
        live: frame.live,
        hasLiveTiming,
        boatName: departure.scheduleOnly && !departure.liveTripId ? null
          : vehicles.get(String(departure.liveTripId || departure.tripId))?.boatName || null,
        // Failing a vessel of its own, the one currently working this boat — by way of the trip a
        // home-port row is about to pick up, or simply by the boat the workbook puts on this
        // sailing. A guess either way, and labelled as one: the vessel on a working changes at
        // short notice, which is exactly why the board says "McShane?" rather than "McShane".
        predictedBoatName: (departure.scheduleOnly && !departure.liveTripId)
          || vehicles.get(String(departure.liveTripId || departure.tripId))?.boatName
          ? null
          : (departure.predictTripId ? vehicles.get(String(departure.predictTripId))?.boatName : null)
            || (Number.isInteger(departure.boatAssignment)
              ? vessels.get(`${departure.routeId}${departure.boatAssignment}`)?.boatName || null
              : null)
      });
      groups.set(key, group);
    }
  }

  const result = [...groups.values()]
    .map((group) => ({
      ...group,
      departures: group.departures
        .sort((left, right) => left.delta - right.delta)
        .map((departure) => ({
          ...departure,
          isLastOfDay: lastDepartures.get(`${departure.routeId}|${departure.variant || ""}|${departure.directionId}`)?.tripId === String(departure.tripId),
          isLastGovernorsIsland: departure.servesGovernorsIsland &&
            lastGovernorsIslandDepartures.get(`${departure.routeId}|${departure.variant || ""}|${departure.directionId}`)?.tripId === String(departure.tripId)
        }))
    }))
    // The lookahead window is about what is worth showing someone standing at the dock. Browsing a
    // day is the opposite question — the whole day is the point — so it only bounds the live board.
    .filter((group) => !frame.live || group.departures[0]?.delta <= departureWindowSeconds)
    .map((group) => ({
      ...group,
      departures: group.departures.slice(0, limitPerGroup)
    }))
    .sort(byRoute);
  return result;
}

export function byRoute(left, right) {
  const routeOrder = left.routeId.localeCompare(right.routeId);
  if (routeOrder) return routeOrder;
  const variantOrder = { A: 0, B: 1, LOCAL: 2 };
  const variantDifference = (variantOrder[left.variant] ?? 3) - (variantOrder[right.variant] ?? 3);
  if (variantDifference) return variantDifference;
  const directionOrder = String(left.directionId).localeCompare(String(right.directionId));
  return directionOrder || left.destination.localeCompare(right.destination);
}

export function timelineDepartures({ data, realtime, viewDate = null, now }) {
  const windowSeconds = (Number(data.meta.departureWindowMinutes) || 180) * 60;
  const live = viewFrame(data, viewDate, now).live;
  return routeDirectionGroups({ data, realtime, viewDate, now, limitPerGroup: Infinity })
    .flatMap((group) => group.departures.map((departure) => ({ departure, group })))
    .filter(({ departure }) => !live || departure.delta <= windowSeconds)
    // Ties fall back to route order so two boats leaving the same minute cannot swap places
    // between the 15s re-renders.
    .sort((left, right) => left.departure.delta - right.departure.delta || byRoute(left.group, right.group));
}
