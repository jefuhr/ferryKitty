import { parseCsv } from "./schedule-builder.js";
import { angleDifference, distanceMetres, median } from "./harbor-geo.js";

function labelToken(label) {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function slipId(landingToken, label, { aliases = {}, landingStopId = landingToken, yard = false } = {}) {
  const name = label.trim();
  let token = labelToken(name), platformCode = null, kind = "passenger";
  let match;
  if ((match = /^slip[\s_]+(\d+)$/i.exec(name))) {
    token = `SLIP_${match[1]}`;
    platformCode = match[1];
  } else if ((match = /^slip\s+(\d+)\s+(.+)$/i.exec(name))) {
    token = `SLIP_${match[1]}`;
    platformCode = match[1];
    kind = /^fuel\s+tanks$/i.test(match[2]) ? "fuel" : "yard";
  } else if ((match = /^slip\s+([a-z]+\d+)$/i.exec(name))) {
    token = match[1].toUpperCase();
    platformCode = token;
  } else if (/^(north|south|east|west)$/i.test(name)) {
    platformCode = name[0].toUpperCase();
    token = /^(north|east)$/i.test(name) ? "NORTH" : "SOUTH";
  } else if ((match = /^(.+?)\s+#(\d+)$/i.exec(name))) {
    token = `${labelToken(match[1])}_${match[2]}`;
    platformCode = match[2];
  } else if (/^dry\s+dock$/i.test(name)) {
    token = "DRY_DOCK";
    platformCode = "DD";
    kind = "drydock";
  }
  token = aliases[`${landingStopId}|${label}`] ?? token;
  if (yard && kind === "passenger") kind = "yard";
  return { id: `NYCF_${landingToken}_${token}`, token, platformCode, kind };
}

export function parseSlipCsv(text, {
  stops, aliases = {}, yardLandings = { "Pier C": { landingStopId: "home-port", token: "PIERC" } }, warn = () => {}
}) {
  const stopByName = new Map(stops.map((stop) => [stop.name.trim(), stop]));
  const slips = new Map();
  // The shared parser handles quoting and CRLF; trimming the fields also admits padded headers.
  const rows = parseCsv(text).map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.trim(), value.trim()])
  ));
  for (const row of rows) {
    if (Object.values(row).every((value) => !value)) continue;
    const yard = Object.hasOwn(yardLandings, row.landing) ? yardLandings[row.landing] : null;
    const stop = stopByName.get(row.landing);
    if (!yard && !stop) {
      warn(`Unknown slip landing: ${row.landing}`);
      continue;
    }
    const landingStopId = String(yard?.landingStopId ?? stop.stopId);
    const latitude = row.latitude ? Number(row.latitude) : NaN;
    const longitude = row.longitude ? Number(row.longitude) : NaN;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const key = `${landingStopId}|${row.slip}`;
    let slip = slips.get(key);
    if (!slip) {
      const { id, platformCode, kind } = slipId(yard?.token ?? landingStopId, row.slip, {
        aliases, landingStopId, yard: Boolean(yard)
      });
      slip = { id, name: row.slip, platformCode, landingStopId, kind, points: [] };
      slips.set(key, slip);
    }
    slip.points.push({ latitude, longitude });
  }
  return [...slips.values()];
}

function slipDistance(point, slip) {
  const distances = slip.points.map((position) => distanceMetres(point, position)).filter((value) => value !== null);
  return distances.length ? Math.min(...distances) : Infinity;
}

export function buildSlipIndex(slips, { stops, landings = [] }) {
  const stopById = new Map(stops.map((stop) => [String(stop.stopId), stop]));
  const metadata = new Map(landings.map((landing) => [String(landing.landingStopId), landing]));
  const grouped = new Map();
  for (const slip of slips) {
    if (!grouped.has(slip.landingStopId)) grouped.set(slip.landingStopId, []);
    grouped.get(slip.landingStopId).push(slip);
  }
  for (const id of metadata.keys()) if (!grouped.has(id)) grouped.set(id, []);
  const indexedLandings = [...grouped].map(([landingStopId, landingSlips]) => {
    const supplied = metadata.get(landingStopId);
    const stop = stopById.get(landingStopId);
    const points = landingSlips.flatMap((slip) => slip.points);
    const latitude = points.length ? points.reduce((sum, point) => sum + point.latitude, 0) / points.length : (supplied?.latitude ?? stop?.latitude);
    const longitude = points.length ? points.reduce((sum, point) => sum + point.longitude, 0) / points.length : (supplied?.longitude ?? stop?.longitude);
    const centre = { latitude, longitude };
    return {
      landingStopId, landingId: supplied?.landingId ?? stop?.landingId ?? null,
      name: supplied?.name ?? stop?.name ?? (landingStopId === "home-port" ? "Pier C" : landingStopId),
      latitude, longitude,
      radiusMetres: Math.max(120, ...points.map((point) => distanceMetres(centre, point) + 60)),
      slipIds: landingSlips.map((slip) => slip.id),
      yard: landingSlips.length > 0 && landingSlips.every((slip) => slip.kind !== "passenger")
    };
  });
  return {
    slips: [...slips],
    byId: new Map(slips.map((slip) => [slip.id, slip])),
    landings: indexedLandings,
    nearestLanding(point) {
      let nearest = null;
      for (const landing of indexedLandings) {
        const distance = distanceMetres(point, landing);
        if (distance !== null && (!nearest || distance < nearest.distanceMetres)) {
          nearest = { landing, distanceMetres: distance };
        }
      }
      return nearest;
    },
    slipsNear(point, radiusMetres) {
      return slips.map((slip) => ({ slip, distanceMetres: slipDistance(point, slip) }))
        .filter((entry) => entry.distanceMetres <= radiusMetres)
        .sort((left, right) => left.distanceMetres - right.distanceMetres);
    }
  };
}

export function assignSlip(points, index, { landingStopId, headingDegrees = null, slipHeadings = new Map() }) {
  const empty = { slipId: null, confidence: 0, ambiguous: false, candidates: [] };
  const recent = points.slice(-10);
  const point = {
    latitude: median(recent.map((position) => position.latitude)),
    longitude: median(recent.map((position) => position.longitude))
  };
  if (point.latitude === null || point.longitude === null) return empty;
  const nearby = index.slipsNear(point, 60).filter(({ slip }) => (
    slip.landingStopId === landingStopId && !(angleDifference(headingDegrees, slipHeadings.get(slip.id)) > 90)
  ));
  if (!nearby.length) return empty;
  const weights = nearby.map(({ distanceMetres: distance }) => Math.exp(-(distance ** 2) / (2 * 12 ** 2)));
  const total = weights.reduce((sum, weight) => sum + weight, Math.exp(-(45 ** 2) / (2 * 12 ** 2)));
  const candidates = nearby.map(({ slip, distanceMetres: distance }, position) => ({
    slipId: slip.id, p: weights[position] / total, distanceMetres: distance
  })).sort((left, right) => right.p - left.p);
  let ambiguous = false;
  if (candidates.length >= 2) {
    const first = index.byId.get(candidates[0].slipId);
    const second = index.byId.get(candidates[1].slipId);
    ambiguous = first.points.some((position) => slipDistance(position, second) < 25);
  }
  const best = candidates[0];
  return {
    slipId: best.p >= 0.6 ? best.slipId : null,
    confidence: ambiguous ? Math.min(0.6, best.p) : best.p,
    ambiguous, candidates
  };
}
