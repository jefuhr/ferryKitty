import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { createAisStream, normalizeAisMessage } from "./ais-stream.js";
import { describeHarborVessels, encodeSlips, encodeTripUpdates } from "./harbor-api.js";
import { joinOperatorPositions, operatorFix, proximityBindings } from "./harbor-fusion.js";
import { distanceMetres } from "./harbor-geo.js";
import { createHarborMemory } from "./harbor-memory.js";
import { buildRoster, resolveIdentity } from "./harbor-roster.js";
import { confirmArrival, matchDeparture } from "./harbor-schedule.js";
import { assignSlip, buildSlipIndex, parseSlipCsv } from "./harbor-slips.js";
import { advanceTrack, emptyTrack, refreshTrack } from "./harbor-state.js";
import { normalizeVehiclePositions } from "./realtime.js";

// The harbor tracker's one stateful piece. Everything it decides is decided by a pure module; this
// file only holds the tracks, feeds them fixes from AIS and from the operator's own feed, turns the
// reducer's events into trips, and writes what it knows to disk so a restart does not start blind.

const TICK_MS = 15_000;
const SAMPLE_WINDOW_MS = 10 * 60_000;
const SAMPLE_RADIUS_METRES = 150;
const SAMPLE_MAX_GAP_MS = 30_000;
const SAMPLE_MIN_KNOTS = 5;
const KNOTS_PER_METRE_SECOND = 3600 / 1852;
const UNROSTERED_KEEP_MS = 6 * 60 * 60_000;
const DISCOVERY_LIMIT = 2000;
const DWELL_LIMIT = 5000;
const STATIC_LIMIT = 5000;
const OPERATOR_TRIP_MS = 180_000;
const LEARN_MS = 6 * 60 * 60_000;

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporary, file);
}

// AIS ship types 40-49 are high-speed craft and 60-69 passenger vessels. Crews type these in by
// hand, so this decides only which strangers are worth remembering, never who a known boat is.
function passengerType(track) {
  const type = track.static?.shipType;
  return Number.isFinite(type) && ((type >= 40 && type <= 49) || (type >= 60 && type <= 69));
}

// Where a track was at a given moment, read off its recent fixes. Null when the nearest fix is too
// far away in time to say.
function positionAt(track, at) {
  const fixes = track.recent || [];
  let before = null, after = null;
  for (const fix of fixes) {
    if (fix.at <= at) before = fix;
    else { after = fix; break; }
  }
  if (before && after && after.at - before.at <= 2 * SAMPLE_MAX_GAP_MS) {
    const share = (at - before.at) / (after.at - before.at);
    return { latitude: before.latitude + (after.latitude - before.latitude) * share,
      longitude: before.longitude + (after.longitude - before.longitude) * share, sogKnots: before.sogKnots };
  }
  const nearest = [before, after].filter(Boolean).sort((left, right) => Math.abs(left.at - at) - Math.abs(right.at - at))[0];
  return nearest && Math.abs(nearest.at - at) <= SAMPLE_MAX_GAP_MS ? nearest : null;
}

export async function createHarborService({
  stateDir, roster: rosterSource = { operators: [], vessels: [] }, fleet = [],
  slipsCsvPath = null, slipAliasesPath = null, stops = [], landings = [], stopIdsOfLanding = (id) => [id],
  schedule = null, routes = new Map(), serviceTrips = null, store = null, terminals = [],
  apiKey = null, streamUrl = undefined, replayPath = null,
  createStream = createAisStream, WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  onEvent = () => {}, warn = () => {}
} = {}) {
  const files = {
    tracks: path.join(stateDir, "harbor-tracks.json"),
    identities: path.join(stateDir, "harbor-identities.json"),
    discovery: path.join(stateDir, "harbor-discovery.json"),
    dwells: path.join(stateDir, "harbor-dwells.json")
  };

  // The berth survey is private and optional. Without it the tracker still knows which landing a
  // boat is at, from the public stop coordinates; it just cannot say which slip.
  let slips = [];
  if (slipsCsvPath) {
    const text = await readFile(slipsCsvPath, "utf8").catch(() => null);
    if (text == null) warn("No slip survey found; docking is reported by landing only.");
    else {
      const aliases = slipAliasesPath ? await readJson(slipAliasesPath, {}) : {};
      slips = parseSlipCsv(text, { stops, aliases, warn });
    }
  }
  const slipIndex = buildSlipIndex(slips, { stops, landings });

  // With a database behind it the tracker keeps a long record (who was seen, where they sat, which
  // trips they were matched to) and can say which run a boat is on. Without one it works as before.
  const landingOf = new Map();
  for (const landing of slipIndex.landings) for (const id of [landing.landingStopId, ...stopIdsOfLanding(landing.landingStopId)]) landingOf.set(String(id), landing.landingStopId);
  const sameLanding = (left, right) => (landingOf.get(String(left)) ?? String(left)) === (landingOf.get(String(right)) ?? String(right));
  const memory = store ? createHarborMemory({ store, schedule, sameLanding, now, warn }) : null;
  if (store) {
    const extra = new Map(terminals.map((terminal) => [String(terminal.stopIds?.[0]), terminal]));
    try {
      store.syncTerminals(slipIndex.landings.map((landing) => {
        const terminal = extra.get(landing.landingStopId);
        return { id: landing.landingStopId, name: landing.name ?? terminal?.name ?? landing.landingStopId, town: terminal?.town ?? null,
          state: terminal?.state ?? null, latitude: landing.latitude, longitude: landing.longitude, radiusMetres: landing.radiusMetres,
          landingId: landing.landingId == null ? null : String(landing.landingId), stopIds: stopIdsOfLanding(landing.landingStopId) };
      }), slipIndex.slips.map((slip) => ({ id: slip.id, terminalId: slip.landingStopId, name: slip.name, kind: slip.kind,
        platformCode: slip.platformCode, points: slip.points.map(({ latitude, longitude }) => ({ latitude, longitude })) })));
    } catch (error) { warn(`Harbor tracker could not record its terminals: ${error.message}`); }
  }

  // Saved state is a convenience. A file that is missing, half written or the wrong shape costs
  // the tracker its memory and nothing else, so every envelope and every record is checked here.
  const read = async (file) => { const value = await readJson(file, null); return isRecord(value) ? value : {}; };
  const saved = await read(files.identities);
  let learned = list(saved.learned).filter((item) => isRecord(item) && typeof item.mmsi === "string" && typeof item.vesselId === "string");
  const staticByMmsi = new Map(Object.entries(isRecord(saved.static) ? saved.static : {}).filter(([, record]) => isRecord(record)));
  let roster = buildRoster(rosterSource, learned);
  const tracks = new Map();
  for (const track of list((await read(files.tracks)).tracks)) {
    if (!isRecord(track) || typeof track.key !== "string" || !track.key) continue;
    const fix = isRecord(track.fix) && Number.isFinite(track.fix.at) && Number.isFinite(track.fix.latitude) && Number.isFinite(track.fix.longitude) ? track.fix : null;
    // A track whose position cannot be trusted starts again from nothing but its identity.
    tracks.set(track.key, fix
      ? { ...emptyTrack(track.key), ...track, fix, recent: list(track.recent).filter(isRecord), dock: isRecord(track.dock) ? { ...track.dock, points: list(track.dock.points), candidates: list(track.dock.candidates) } : null,
        lastDock: isRecord(track.lastDock) ? track.lastDock : null, pending: null, trip: isRecord(track.trip) ? track.trip : null, static: isRecord(track.static) ? track.static : null }
      : { ...emptyTrack(track.key), vesselId: typeof track.vesselId === "string" ? track.vesselId : null, identitySource: track.identitySource ?? null });
  }
  const discovery = new Map(list((await read(files.discovery)).vessels).filter((entry) => isRecord(entry) && typeof entry.mmsi === "string")
    .map((entry) => [entry.mmsi, { fixes: 0, maxSogKnots: 0, ...entry, landings: list(entry.landings) }]));
  const dwells = list((await read(files.dwells)).dwells).filter(isRecord);
  let operator = { available: false, stale: true, fetchedAt: null, feed: null };
  let samples = [];
  let dirty = false, timer = null, writing = Promise.resolve(), learnedAt = 0;

  // The schedule names operators after their feeds and the roster after the companies. The id
  // prefix the two share is what ties them together.
  function scheduleOperator(vessel) {
    if (!schedule || !vessel) return null;
    const prefix = roster.operators.find((item) => item.id === vessel.operatorId)?.feedPrefix ?? null;
    if (prefix == null) return null;
    for (const [id, entry] of schedule.operators) if (entry.prefix === prefix) return id;
    return null;
  }

  // One trip, one hull. The operator's feed names a trip without a service date, so a trip it has
  // given to a boat is taken on whatever date the timetable would file it under.
  function matchFreeTrip(track, operatorId, event) {
    const others = [...tracks.values()].filter((other) => other.key !== track.key && other.trip?.tripId);
    const taken = new Set(others.filter((other) => other.trip.serviceDate).map((other) => `${other.trip.serviceDate}|${other.trip.tripId}`));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const match = matchDeparture({ schedule, operatorId, landingStopId: stopIdsOfLanding(event.landingStopId), departedAt: event.departedAt, taken });
      if (!match || !others.some((other) => !other.trip.serviceDate && String(other.trip.tripId) === String(match.tripId))) return match;
      taken.add(`${match.serviceDate}|${match.tripId}`);
    }
    return null;
  }

  // The operator saying which hull runs a trip settles it: a timetable guess that gave the same
  // trip to another boat is withdrawn.
  function withdrawGuesses(tripId, exceptKey) {
    for (const [key, other] of tracks) {
      if (key !== exceptKey && other.trip?.source === "schedule" && String(other.trip.tripId) === String(tripId)) tracks.set(key, { ...other, trip: null });
    }
  }

  // A trip the operator vouched for is only good for as long as the operator keeps saying so.
  function expireOperatorTrips(clock) {
    for (const [key, track] of tracks) {
      if (track.trip?.source === "operator-rt" && !(clock - track.trip.observedAt < OPERATOR_TRIP_MS)) {
        tracks.set(key, { ...track, trip: null });
        dirty = true;
      }
    }
  }

  function identify(track) {
    if (track.vesselId || !track.mmsi) return track;
    const found = resolveIdentity({ mmsi: track.mmsi, staticData: track.static }, roster);
    if (!found) { memory?.nameCollision(track, roster); return track; }
    // A name match is remembered as a binding, so the hull stays claimed after a restart and a
    // second transponder broadcasting the same name cannot take it.
    if (found.source === "ais-name" && !bind({ mmsi: track.mmsi, vesselId: found.vesselId, source: "ais-name", at: now() }, track)) return track;
    return adopt({ ...track, vesselId: found.vesselId, identitySource: found.source });
  }

  // The database is the authority on which transponder is which hull. A link it refuses (the
  // roster already settles that transponder or that hull) is not adopted here either, so the live
  // picture and the record cannot disagree. Without a database the tracker decides alone.
  function bind(binding, track = tracks.get(binding.mmsi)) {
    if (memory && !memory.link(binding, track)) return false;
    learned = [...learned.filter((item) => item.mmsi !== binding.mmsi && item.vesselId !== binding.vesselId), binding];
    roster = buildRoster(rosterSource, learned);
    dirty = true;
    return true;
  }

  // An operator-only track and an AIS track for the same hull become one. The AIS track is the
  // lasting one; it inherits whatever trip the operator's feed had already named.
  function adopt(track) {
    const operatorKey = `vessel:${track.vesselId}`;
    const operatorTrack = tracks.get(operatorKey);
    if (!operatorTrack || track.key === operatorKey) return track;
    tracks.delete(operatorKey);
    return { ...track, trip: track.trip ?? operatorTrack.trip };
  }

  function remember(track) {
    // The database keeps every hull that is or could be a ferry, known ones included: a known
    // boat's sightings are how its transponder link is checked later.
    if (memory && track.fix?.source === "ais" && (track.vesselId || passengerType(track))) memory.sighting(track, track.dock?.landingStopId ?? null);
    if (memory || track.vesselId || !passengerType(track) || !track.fix) return;
    const entry = discovery.get(track.mmsi) || { mmsi: track.mmsi, firstSeen: track.fix.at, fixes: 0, maxSogKnots: 0, landings: [] };
    entry.name = track.static?.name ?? entry.name ?? null;
    entry.callSign = track.static?.callSign ?? entry.callSign ?? null;
    entry.shipType = track.static?.shipType ?? null;
    entry.dims = track.static?.dims ?? entry.dims ?? null;
    entry.aisClass = track.static?.aisClass ?? track.fix.aisClass ?? null;
    entry.lastSeen = track.fix.at;
    entry.fixes += 1;
    entry.maxSogKnots = Math.max(entry.maxSogKnots, track.fix.sogKnots ?? 0);
    if (track.dock && !entry.landings.includes(track.dock.landingStopId)) entry.landings.push(track.dock.landingStopId);
    discovery.set(track.mmsi, entry);
    if (discovery.size > DISCOVERY_LIMIT) {
      const oldest = [...discovery.values()].sort((left, right) => left.lastSeen - right.lastSeen)[0];
      discovery.delete(oldest.mmsi);
    }
  }

  // The reducer says what happened; this says what it means for the trip a boat is running.
  function settle(track, events) {
    let next = track;
    for (const event of events) {
      onEvent(event.type);
      if (event.type === "docked" && next.trip?.source === "schedule" && schedule) {
        const before = next.trip;
        next = { ...next, trip: confirmArrival({ schedule, trip: before, landingStopId: stopIdsOfLanding(event.landingStopId) }) };
        // Reaching the next call is what turns a timetable guess into something worth learning from.
        if (memory && next.trip && next.trip.confidence > before.confidence) {
          const operatorId = scheduleOperator(roster.byId.get(next.vesselId));
          memory.observe(next, operatorId, next.trip, { arrivedTerminalId: event.landingStopId, arrivedAt: event.at });
          next = { ...next, run: memory.runFor(operatorId, next.trip) ?? next.run ?? null };
        } else if (!next.trip) {
          // The boat went somewhere the trip does not go. Whatever run was inferred with it goes too.
          next = { ...next, run: null };
        }
      } else if (event.type === "laid-up" && next.trip?.source === "schedule") {
        next = { ...next, trip: null };
      } else if (event.type === "departed") {
        const dock = next.lastDock;
        const centre = dock?.points?.length ? {
          latitude: dock.points.reduce((sum, point) => sum + point.latitude, 0) / dock.points.length,
          longitude: dock.points.reduce((sum, point) => sum + point.longitude, 0) / dock.points.length
        } : null;
        // Kept so the survey's reference point (bow, antenna or slip centre) can be worked out
        // later from where boats actually sat. These are the boat's own public AIS positions.
        const dwell = { key: next.key, vesselId: next.vesselId, landingStopId: event.landingStopId, slipId: event.slipId,
          confidence: dock?.confidence ?? null, ambiguous: dock?.ambiguous ?? false, since: event.dockedAt, until: event.departedAt,
          latitude: centre?.latitude ?? null, longitude: centre?.longitude ?? null,
          headingDegrees: dock?.points?.at(-1)?.headingDegrees ?? null, dims: next.static?.dims ?? null };
        if (memory) memory.dwell({ ...dwell, trackKey: next.key, mmsi: next.mmsi ?? null, terminalId: event.landingStopId });
        else {
          dwells.push(dwell);
          if (dwells.length > DWELL_LIMIT) dwells.splice(0, dwells.length - DWELL_LIMIT);
        }
        if (next.trip?.source === "operator-rt") continue;
        // A trip confirmed at this landing with calls still to make carries on. Anything else is
        // matched afresh against the timetable from where and when the boat left.
        const carrying = next.trip?.source === "schedule" && next.trip.confidence >= 0.9 && next.trip.nextSequence != null;
        if (carrying) continue;
        const vessel = next.vesselId ? roster.byId.get(next.vesselId) : null;
        const operatorId = scheduleOperator(vessel);
        next = { ...next, trip: operatorId ? matchFreeTrip(next, operatorId, event) : null };
        // A departure match is a guess: it is written down, but only a confirmed trip sets the run.
        if (memory && next.trip) memory.observe(next, operatorId, next.trip, { terminalId: event.landingStopId, departedAt: event.departedAt });
      }
    }
    return next;
  }

  function advance(track, fix, clock) {
    const result = advanceTrack(track, fix, { slipIndex, assignSlip, now: clock });
    if (result.track === track) return track;
    const next = settle(result.track, result.events);
    tracks.set(next.key, next);
    remember(next);
    dirty = true;
    return next;
  }

  function ingestFix(fix, clock = now()) {
    let track = tracks.get(fix.mmsi) || { ...emptyTrack(fix.mmsi), static: staticByMmsi.get(fix.mmsi) ?? null };
    track = identify(track);
    advance(track, fix, clock);
  }

  function ingestStatic(record) {
    // The stream's own cache starts empty with every process, so what arrives may know less than
    // what was saved. A field it does not carry is not a field that changed.
    const merged = { ...(staticByMmsi.get(record.mmsi) || {}) };
    // A name from a position report stands in only until the ship has named itself. The stream
    // forgets what it knew with every restart; this record does not, so the rule is applied here.
    if (record.nameSource === "position" && merged.name && merged.nameSource !== "position") record = { ...record, name: null, nameSource: null };
    for (const [key, value] of Object.entries(record)) if (value !== null || key === "aisClass" || key === "at" || !(key in merged)) merged[key] = value;
    staticByMmsi.delete(record.mmsi);
    staticByMmsi.set(record.mmsi, merged);
    if (staticByMmsi.size > STATIC_LIMIT) pruneStatic(now());
    const track = tracks.get(record.mmsi);
    if (track) tracks.set(track.key, identify({ ...track, static: merged }));
    dirty = true;
  }

  // Static data is kept for ships the tracker still has a reason to know: a live track, a roster
  // binding, or a place in the discovery log. Everything else is a ship that passed through.
  function pruneStatic(clock) {
    for (const [mmsi, record] of staticByMmsi) {
      const wanted = tracks.has(mmsi) || roster.byMmsi.has(mmsi) || discovery.has(mmsi);
      if (!wanted && !(clock - record.at < UNROSTERED_KEEP_MS)) staticByMmsi.delete(mmsi);
    }
    while (staticByMmsi.size > STATIC_LIMIT) staticByMmsi.delete(staticByMmsi.keys().next().value);
  }

  /** Called with every refresh of the operator's own feeds. Never throws: the board must not care. */
  function observeOperatorFeed({ feed = null, vehicleFeed = null, now: at = now() } = {}) {
    try {
      operator = { available: true, stale: false, fetchedAt: at, feed };
      const positions = normalizeVehiclePositions(vehicleFeed, fleet);
      for (const joined of joinOperatorPositions({ tracks, positions, roster, now: at })) {
        let track = tracks.get(joined.key) || { ...emptyTrack(joined.key), vesselId: joined.vesselId, identitySource: "roster" };
        if (joined.authoritative && joined.tripId != null) {
          const observedAt = joined.position.updatedAtEpochSeconds * 1000;
          const changed = track.trip?.source !== "operator-rt" || String(track.trip.tripId) !== String(joined.tripId);
          track = { ...track, trip: { tripId: String(joined.tripId), routeId: null, serviceDate: null, source: "operator-rt",
            confidence: 1, nextSequence: joined.stopSequence, observedAt } };
          withdrawGuesses(joined.tripId, track.key);
          // The operator's word is the best evidence there is of who works which run, so it is
          // written down once per trip, under the service day the timetable files that trip on.
          if (memory && changed) {
            const operatorId = scheduleOperator(roster.byId.get(joined.vesselId));
            const serviceDate = memory.serviceDateOf(operatorId, String(joined.tripId), observedAt);
            if (serviceDate) {
              const dated = { ...track.trip, serviceDate };
              memory.observe(track, operatorId, dated, {});
              track = { ...track, run: memory.runFor(operatorId, dated) ?? track.run ?? null };
            }
          }
        } else if (track.trip?.source === "operator-rt") {
          track = { ...track, trip: null };
        }
        tracks.set(track.key, track);
        dirty = true;
        // AIS is the position of record. The operator's fix stands in only while AIS has nothing
        // fresh to say about this hull.
        const aisFresh = track.fix?.source === "ais" && !refreshTrack(track, { now: at }).track.stale;
        const fix = !aisFresh && joined.authoritative ? operatorFix(joined.position) : null;
        if (fix) track = advance(track, fix, at);
        sample(joined, at);
      }
      // A boat the operator has stopped reporting keeps its trip only until the last report ages out.
      expireOperatorTrips(at);
      const boundVesselIds = new Set([...roster.byId.values()].filter((vessel) => vessel.mmsi).map((vessel) => vessel.id));
      for (const binding of proximityBindings({ samples, now: at, boundMmsis: new Set(roster.byMmsi.keys()), boundVesselIds })) {
        samples = samples.filter((item) => item.vesselId !== binding.vesselId);
        if (!bind(binding)) continue;
        const track = tracks.get(binding.mmsi);
        if (track) tracks.set(track.key, adopt({ ...track, vesselId: binding.vesselId, identitySource: "proximity" }));
        onEvent("identity-learned");
      }
    } catch (error) {
      warn(`Harbor tracker could not read the operator feed: ${error.message}`);
    }
  }

  // One observation towards working out which transponder a boat in the operator's feed carries:
  // the unclaimed AIS tracks that were beside it at the moment it reported.
  function sample(joined, at) {
    const position = joined.position;
    if (roster.byId.get(joined.vesselId)?.mmsi || !joined.authoritative) return;
    if (!Number.isFinite(position.speed) || position.speed * KNOTS_PER_METRE_SECOND < SAMPLE_MIN_KNOTS) return;
    const measuredAt = position.updatedAtEpochSeconds * 1000;
    if (samples.some((item) => item.vesselId === joined.vesselId && item.operator.at === measuredAt)) return;
    const candidates = [];
    for (const track of tracks.values()) {
      if (!track.mmsi || track.vesselId || roster.byMmsi.has(track.mmsi) || track.fix?.source !== "ais") continue;
      const where = positionAt(track, measuredAt);
      if (!where || distanceMetres(position, where) > SAMPLE_RADIUS_METRES) continue;
      candidates.push({ mmsi: track.mmsi, latitude: where.latitude, longitude: where.longitude, sogKnots: where.sogKnots, docked: track.dock !== null });
    }
    samples = samples.filter((item) => at - item.at <= SAMPLE_WINDOW_MS);
    if (candidates.length) samples.push({ at, vesselId: joined.vesselId,
      operator: { latitude: position.latitude, longitude: position.longitude, at: measuredAt }, candidates });
  }

  function tick() {
    const clock = now();
    for (const [key, track] of tracks) {
      const result = refreshTrack(track, { now: clock });
      if (result.track !== track || result.events.length) {
        const changed = result.track.state !== track.state || result.track.stale !== track.stale || result.events.length > 0;
        tracks.set(key, settle(result.track, result.events));
        if (changed) dirty = true;
      }
      const current = tracks.get(key);
      if (!current.vesselId && current.fix && clock - current.fix.at > UNROSTERED_KEEP_MS) { tracks.delete(key); dirty = true; }
    }
    expireOperatorTrips(clock);
    pruneStatic(clock);
    if (memory && clock - learnedAt >= LEARN_MS) { learnedAt = clock; memory.learn(); }
    if (operator.fetchedAt && clock - operator.fetchedAt > 60_000) operator = { ...operator, stale: true };
    return persist();
  }

  function persist() {
    if (!dirty) return writing;
    dirty = false;
    const kept = [...tracks.values()].filter((track) => track.vesselId || passengerType(track));
    // With a database, sightings and dwells are already written there as they happen.
    writing = writing.then(() => Promise.all([
      writeJson(files.tracks, { savedAt: now(), tracks: kept }),
      writeJson(files.identities, { learned, static: Object.fromEntries(staticByMmsi) }),
      ...(memory ? [] : [writeJson(files.discovery, { vessels: [...discovery.values()] }), writeJson(files.dwells, { dwells })])
    ])).catch((error) => warn(`Harbor tracker could not save its state: ${error.message}`));
    return writing;
  }

  const stream = createStream({ ...(streamUrl ? { url: streamUrl } : {}), apiKey, WebSocketImpl, now,
    onFix: (fix) => ingestFix(fix), onStatic: ingestStatic,
    onStatus: (status) => { if (status.state === "waiting") onEvent("ais-reconnect"); } });

  // The name carried on a position report, used only until a static report supplies one.
  function nameFromFix(record, shift = 0) {
    if (!record.name || staticByMmsi.get(record.fix.mmsi)?.name) return;
    ingestStatic({ mmsi: record.fix.mmsi, name: record.name, nameSource: "position", aisClass: record.fix.aisClass, at: record.fix.at + shift });
  }

  // A recorded capture played straight through, shifted so its last message is "now". For working
  // on the tracker without a key; a live key takes precedence.
  async function replay() {
    const lines = (await readFile(replayPath, "utf8")).split("\n").filter(Boolean);
    // A capture's timestamps are its own past, to be shifted to the present below. The normalizer
    // distrusts a timestamp later than the receive time, so the receive time here is "never too late".
    const records = lines.map((line) => { try { return normalizeAisMessage(JSON.parse(line), Number.MAX_SAFE_INTEGER); } catch { return null; } })
      .filter((record) => record && (record.fix?.at ?? record.static?.at) !== Number.MAX_SAFE_INTEGER);
    // A loop, not a spread: a long capture has more records than a call can take as arguments.
    let last = 0;
    for (const record of records) last = Math.max(last, record.fix?.at ?? record.static?.at ?? 0);
    const shift = now() - last;
    for (const record of records) {
      if (record.kind === "static") ingestStatic({ ...record.static, at: record.static.at + shift });
      else if (record.kind === "fix") {
        nameFromFix(record, shift);
        ingestFix({ ...record.fix, at: record.fix.at + shift }, record.fix.at + shift);
      }
    }
    return records.length;
  }

  let replayed = false;
  async function start() {
    if (timer) return;
    if (replayPath && !apiKey) {
      try { await replay(); replayed = true; } catch (error) { warn(`Harbor tracker could not replay ${path.basename(replayPath)}: ${error.message}`); }
    }
    stream.start();
    timer = setIntervalImpl(() => { void tick(); }, TICK_MS);
    timer?.unref?.();
  }

  async function stop() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
    stream.stop();
    dirty = true;
    await persist();
  }

  function visibleTracks() {
    return [...tracks.values()].filter((track) => track.vesselId || passengerType(track));
  }

  // The freshest track for a hull, the same choice the public row makes.
  function trackOf(vesselId) {
    let best = null;
    for (const track of tracks.values()) {
      if (track.vesselId === vesselId && (!best || (track.fix?.at ?? -Infinity) > (best.fix?.at ?? -Infinity))) best = track;
    }
    return best;
  }

  function getCurrent({ includeUnrostered = false, operatorId = null, state = null } = {}) {
    const clock = now();
    const ais = stream.status();
    const list = visibleTracks();
    const body = describeHarborVessels({ tracks: list, roster, slipIndex, routes, serviceTrips,
      sources: { ais, nycFerry: { available: operator.available, stale: operator.stale,
        fetchedAt: operator.fetchedAt ? new Date(operator.fetchedAt).toISOString() : null } },
      now: clock, includeUnrostered });
    const operatorNames = new Map(roster.operators.map((item) => [item.id, item.name]));
    // Assignments are decided for the whole fleet at once, before any filter, so one run is never
    // given to two boats and a filtered list shows the same answer as the full one.
    const assignments = memory ? memory.allocate(body.vessels.filter((vessel) => vessel.vesselId).map((vessel) => {
      const known = roster.byId.get(vessel.vesselId);
      return { vesselId: known.id, operatorId: scheduleOperator(known), track: trackOf(known.id) };
    }), clock) : new Map();
    body.vessels = body.vessels.filter((vessel) => (!operatorId || vessel.operatorId === operatorId) && (!state || vessel.state === state))
      .map((vessel) => {
        const assignment = assignments.get(vessel.vesselId) ?? null;
        return { ...vessel, routeId: vessel.routeId ?? assignment?.routeId ?? null,
          operatorName: operatorNames.get(vessel.operatorId) ?? null, assignment };
      });
    // With no key, no capture and no operator feed there is nothing behind this answer at all.
    const available = ais.state !== "disabled" || replayed || operator.available || list.some((track) => track.fix);
    return { ...body, available, error: available ? null : "AIS is not configured and no vessel has been seen." };
  }

  /** Everything known about one hull, for the page a rider or a reviewer opens on it. */
  function vesselDetail(id) {
    const clock = now();
    const current = getCurrent({ includeUnrostered: true }).vessels.find((vessel) => vessel.id === id) ?? null;
    const detail = store?.vesselDetail(id) ?? null;
    if (!current && !detail) return null;
    const mmsi = current?.mmsi ?? null;
    const date = memory?.today(clock) ?? null;
    return {
      vessel: detail?.vessel ?? null, links: detail?.links ?? [], references: detail?.references ?? [], conflicts: detail?.conflicts ?? [],
      track: current, assignment: current?.assignment ?? null,
      estimates: store && detail && date ? store.listEstimates({ serviceDate: date, vesselId: id }) : [],
      dwells: store ? (detail ? store.listDwells({ vesselId: id, limit: 50 }) : mmsi ? store.listDwells({ mmsi, limit: 50 }) : []) : [],
      trips: store && detail ? store.listTripObservations({ vesselId: id, limit: 50 }) : []
    };
  }

  return {
    start, stop, tick, getCurrent, observeOperatorFeed, vesselDetail,
    operators: () => ({ operators: roster.operators.map((item) => ({ id: item.id, name: item.name, feedPrefix: item.feedPrefix ?? "",
      website: item.website ?? null, vessels: [...roster.byId.values()].filter((vessel) => vessel.operatorId === item.id && vessel.active !== false).length })) }),
    terminals: () => ({ terminals: store ? store.listTerminals() : [] }),
    learn: () => memory?.learn() ?? { operators: 0, patterns: 0 },
    slips: (options) => encodeSlips(slipIndex, options),
    tripUpdates: () => encodeTripUpdates({ feed: operator.feed, tracks: visibleTracks(), slipIndex, roster, fleet, now: now() }),
    status: () => ({ ais: stream.status(), tracks: tracks.size, slips: slipIndex.slips.length, landings: slipIndex.landings.length,
      learned: learned.length, discovered: discovery.size, database: Boolean(store) }),
    // For tests and the recorder: the same path a live message takes.
    ingest: (raw, receivedAt = now()) => {
      const record = normalizeAisMessage(raw, receivedAt);
      if (record?.kind === "fix") { nameFromFix(record); ingestFix(record.fix); }
      else if (record?.kind === "static") ingestStatic(record.static);
      return record?.kind ?? null;
    }
  };
}
