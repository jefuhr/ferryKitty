import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { describedServiceTrip, serviceFrame } from "./fleet-map.js";
import { matchFleetVessel } from "./realtime.js";

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
const STATUS = { docked: "stopped", "laid-up": "stopped", arriving: "incoming", departing: "in-transit", underway: "in-transit" };
const round = value => Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : null;
const trackList = tracks => [...(tracks instanceof Map ? tracks.values() : tracks || [])];

function rosterVessels(roster) {
  return roster.byId ? [...roster.byId.values()] : roster.vessels;
}

function vesselForTrack(track, roster) {
  const id = track.vesselId ?? roster.byMmsi?.get(track.mmsi)?.vesselId;
  return roster.byId?.get(id) || roster.vessels.find(vessel => vessel.id === id) || null;
}

/** Public vessel metadata is projected explicitly so the index's berth points stay private. */
export function describeHarborVessels({ tracks, roster, slipIndex, routes = new Map(), serviceTrips = null, sources, now, includeUnrostered = false }) {
  const byVessel = new Map();
  const unrostered = [];
  for (const track of trackList(tracks)) {
    const vessel = vesselForTrack(track, roster);
    if (!vessel) {
      if (includeUnrostered) unrostered.push({ vessel: null, track });
      continue;
    }
    // A new operator fix can coexist briefly with the AIS track it has just been bound to.
    // The freshest fix supplies one public row for that hull.
    const previous = byVessel.get(vessel.id);
    if (!previous || (track.fix?.at ?? -Infinity) > (previous.fix?.at ?? -Infinity)) byVessel.set(vessel.id, track);
  }
  const entries = rosterVessels(roster).flatMap(vessel => {
    const track = byVessel.get(vessel.id);
    return vessel.active || track?.fix && track.state !== "unknown" ? [{ vessel, track }] : [];
  });
  const frame = serviceTrips ? serviceFrame(serviceTrips, now) : null;
  const vessels = [...entries, ...unrostered].map(({ vessel, track }) => {
    const fix = track?.fix;
    const tripId = track?.trip?.tripId ?? null;
    const trip = tripId && serviceTrips ? describedServiceTrip(serviceTrips, tripId, track.trip.nextSequence, frame) : null;
    const route = trip ? routes.get(trip.routeId) : null;
    const stop = trip?.stops.find(candidate => candidate.sequence === track.trip.nextSequence);
    const dock = track?.dock;
    const landing = dock ? slipIndex.landings.find(candidate => candidate.landingStopId === dock.landingStopId) : null;
    const slip = dock?.slipId ? slipIndex.byId.get(dock.slipId) : null;
    const bearing = fix?.headingDegrees ?? (fix?.sogKnots > 1 ? fix.cogDegrees : null);
    return {
      id: vessel?.id ?? `mmsi:${track.mmsi}`,
      name: vessel?.name ?? track?.static?.name ?? null,
      number: vessel?.number ?? null,
      tripId,
      latitude: round(fix?.latitude),
      longitude: round(fix?.longitude),
      bearing: bearing == null ? null : Math.round(bearing),
      speedKnots: fix?.sogKnots == null ? null : Math.round(fix.sogKnots * 10) / 10,
      ageSeconds: fix ? Math.max(0, Math.floor((now - fix.at) / 1000)) : null,
      routeId: route?.id ?? null,
      route: route?.shortName ?? null,
      routeName: route?.name ?? null,
      color: route?.color ?? null,
      status: STATUS[track?.state] ?? null,
      stop: stop ? { id: stop.stopId, name: stop.name, latitude: round(stop.latitude), longitude: round(stop.longitude) } : null,
      reportedAt: fix ? new Date(fix.at).toISOString() : null,
      destination: trip?.destination ?? null,
      mode: route?.mode ?? "ferry",
      vesselId: vessel?.id ?? null,
      operatorId: vessel?.operatorId ?? null,
      mmsi: track?.mmsi ?? vessel?.mmsi ?? null,
      state: track?.state ?? "unknown",
      stateSince: track?.stateSince ?? null,
      stale: track?.stale ?? false,
      moving: track?.moving ?? false,
      positionSource: fix?.source ?? null,
      identitySource: track?.identitySource ?? null,
      rostered: Boolean(vessel),
      landing: dock ? { id: dock.landingId ?? landing?.landingId ?? null, stopId: dock.landingStopId, name: landing?.name ?? null } : null,
      slip: slip ? { id: slip.id, name: slip.name, confidence: dock.confidence } : null,
      slipCandidates: (dock?.candidates || []).map(candidate => ({ id: candidate.slipId, name: slipIndex.byId.get(candidate.slipId)?.name ?? null, p: candidate.p })),
      slipAmbiguous: dock?.ambiguous ?? false,
      tripSource: track?.trip?.source ?? null,
      tripConfidence: track?.trip?.confidence ?? null
    };
  });
  vessels.sort((left, right) => (left.operatorId || "").localeCompare(right.operatorId || "") || (left.name || left.id).localeCompare(right.name || right.id));
  const ais = sources?.ais;
  const nycFerry = sources?.nycFerry;
  return {
    available: true,
    stale: ais?.state !== "open" || ais.lastMessageAt == null || now - ais.lastMessageAt >= 120000,
    fetchedAt: new Date(now).toISOString(),
    error: null,
    sources: {
      ais: { state: ais?.state ?? "disabled", connected: ais?.connected ?? false, lastMessageAt: ais?.lastMessageAt ?? null, reconnects: ais?.reconnects ?? 0 },
      nycFerry: { available: nycFerry?.available ?? false, stale: nycFerry?.stale ?? true, fetchedAt: nycFerry?.fetchedAt ?? null }
    },
    vessels
  };
}

/** The catalog matches Ferry RT without exposing any slip or landing geometry. */
export function encodeSlips(slipIndex, { includeYard = false } = {}) {
  return {
    slips: slipIndex.slips.filter(slip => includeYard || slip.kind === "passenger")
      .map(({ id, name, platformCode, landingStopId }) => ({ id, name, platformCode, landingStopId }))
      .sort((left, right) => left.landingStopId.localeCompare(right.landingStopId) || left.id.localeCompare(right.id))
  };
}

/** Re-encode a snapshot, preserving all unrelated entities and optional protobuf fields. */
export function encodeTripUpdates({ feed, tracks, slipIndex, roster, fleet = [], now, minConfidence = 0.8 }) {
  if (!feed) return FeedMessage.encode(FeedMessage.fromObject({ header: { gtfsRealtimeVersion: "2.0", timestamp: Math.floor(now / 1000) }, entity: [] })).finish();
  // A protobuf round trip copies the message without turning absent optional values into zeros.
  const result = FeedMessage.decode(FeedMessage.encode(feed).finish());
  const list = trackList(tracks);
  for (const entity of result.entity) {
    const update = entity.tripUpdate;
    const tripId = update?.trip?.tripId;
    if (!tripId) continue;
    let track = list.find(candidate => candidate.trip?.tripId === tripId);
    if (!track && update.vehicle) {
      // Feeds can retain consecutive trips for one hull; a bound current trip takes precedence.
      const vessel = matchFleetVessel(update.vehicle, rosterVessels(roster)) || matchFleetVessel(update.vehicle, fleet);
      if (vessel) track = list.find(candidate => vesselForTrack(candidate, roster)?.id === vessel.id && (!candidate.trip?.tripId || candidate.trip.tripId === tripId));
    }
    const dock = track?.dock;
    if (!dock || !["docked", "arriving"].includes(track.state) || !(dock.confidence >= minConfidence)) continue;
    const slip = slipIndex.byId.get(dock.slipId);
    if (!slip || slip.landingStopId !== dock.landingStopId) continue;
    for (const stop of update.stopTimeUpdate) {
      const landingStopId = slipIndex.byId.get(stop.stopId)?.landingStopId ?? stop.stopId;
      if (landingStopId !== dock.landingStopId) continue;
      stop.stopId = slip.id;
      stop.stopTimeProperties = { ...stop.stopTimeProperties, assignedStopId: slip.id };
    }
  }
  return FeedMessage.encode(result).finish();
}
