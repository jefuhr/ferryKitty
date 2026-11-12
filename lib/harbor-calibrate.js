import { distanceMetres } from "./harbor-geo.js";
import { assignSlip, SLIP_MODEL } from "./harbor-slips.js";
import { THRESHOLDS } from "./harbor-state.js";

function stoppingLanding(fix, index) {
  if (!Number.isFinite(fix.sogKnots) || fix.sogKnots > THRESHOLDS.dockMaxSpeedKnots) return null;
  const nearby = index.slipsNear(fix, THRESHOLDS.dockRadiusMetres).map(({ slip, distanceMetres: distance }) => ({
    landingStopId: slip.landingStopId, distance
  }));
  for (const landing of index.landings) {
    if (landing.slipIds.length) continue;
    const distance = distanceMetres(fix, landing);
    if (distance !== null && distance <= (landing.radiusMetres ?? THRESHOLDS.landingRadiusMetres)) {
      nearby.push({ landingStopId: landing.landingStopId, distance });
    }
  }
  nearby.sort((left, right) => left.distance - right.distance);
  return nearby[0]?.landingStopId ?? null;
}

/** Extract contiguous measured stops, including ones still in progress at capture end. */
export function dwellSamples({ records, slipIndex }) {
  const names = new Map(), staticNames = new Set(), pending = new Map(), samples = [];
  function finish(mmsi) {
    const sample = pending.get(mmsi);
    if (!sample) return;
    if (sample.points.length >= THRESHOLDS.dockMinFixes && sample.until - sample.since >= THRESHOLDS.dockMinSpanMs) {
      samples.push(sample);
    }
    pending.delete(mmsi);
  }
  for (const record of records) {
    const fix = record?.kind === "fix" ? record.fix : null;
    const data = record?.kind === "static" ? record.static : fix;
    if (!data?.mmsi) continue;
    // Metadata supplies a name while waiting for static data, but never supersedes it.
    const name = record.kind === "static" ? data.name : (staticNames.has(data.mmsi) ? null : record.name);
    if (record.kind === "static" && name) staticNames.add(data.mmsi);
    if (name) names.set(data.mmsi, name);
    if (pending.has(data.mmsi) && name) pending.get(data.mmsi).name = name;
    if (!fix) continue;
    const landingStopId = stoppingLanding(fix, slipIndex);
    const current = pending.get(fix.mmsi);
    // Twenty minutes without a fix loses the track. Joining fixes across that hole would
    // claim a continuous dwell that the capture cannot demonstrate.
    if (current && (current.landingStopId !== landingStopId || fix.at - current.until > THRESHOLDS.lostMs)) {
      finish(fix.mmsi);
    }
    if (landingStopId === null) continue;
    if (!pending.has(fix.mmsi)) {
      pending.set(fix.mmsi, {
        mmsi: fix.mmsi, name: names.get(fix.mmsi) ?? null, landingStopId,
        points: [], since: fix.at, until: fix.at
      });
    }
    const sample = pending.get(fix.mmsi);
    sample.points.push({ ...fix });
    sample.until = fix.at;
  }
  for (const mmsi of pending.keys()) finish(mmsi);
  return samples.sort((left, right) => left.since - right.since || left.mmsi.localeCompare(right.mmsi));
}

function totals() {
  return { dwells: 0, named: 0, namedShare: 0, ambiguous: 0, flips: 0, meanConfidence: 0 };
}

function add(total, assignment, flipped) {
  total.dwells += 1;
  total.named += Number(assignment.slipId !== null);
  total.ambiguous += Number(assignment.ambiguous);
  total.flips += Number(flipped);
  total.meanConfidence += assignment.confidence;
}

function average(total) {
  if (total.dwells) {
    total.namedShare = total.named / total.dwells;
    total.meanConfidence /= total.dwells;
  }
  return total;
}

/** Compare final naming and within-dwell stability without changing the live reducer. */
export function evaluate({ samples, slipIndex, model = SLIP_MODEL }) {
  const total = totals(), byLanding = new Map();
  for (const sample of samples) {
    let previousSlipId = null, flipped = false;
    let assignment = { slipId: null, confidence: 0, ambiguous: false };
    for (let length = 1; length <= sample.points.length; length += 1) {
      const point = sample.points[length - 1];
      // Retain every point's time so storage becomes eligible at the same prefix as in
      // the tracker, rather than applying the final dwell age to every earlier fix.
      const at = point.at ?? (length === sample.points.length ? sample.until : sample.since);
      assignment = assignSlip(sample.points.slice(Math.max(0, length - THRESHOLDS.dockMaxPoints), length), slipIndex, {
        landingStopId: sample.landingStopId, model,
        storage: at - sample.since >= THRESHOLDS.passengerLayupMs
      });
      if (assignment.slipId !== null) {
        if (previousSlipId !== null && previousSlipId !== assignment.slipId) flipped = true;
        // A null between named assignments is uncertainty, not evidence that a flip vanished.
        previousSlipId = assignment.slipId;
      }
    }
    if (!byLanding.has(sample.landingStopId)) byLanding.set(sample.landingStopId, totals());
    add(total, assignment, flipped);
    add(byLanding.get(sample.landingStopId), assignment, flipped);
  }
  return {
    ...average(total),
    byLanding: Object.fromEntries([...byLanding].sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => [id, average(value)]))
  };
}

/** Favor more named dwells only when none of those dwells switched between slips. */
export function sweep({ samples, slipIndex, models }) {
  const rows = models.map((model) => ({ model, ...evaluate({ samples, slipIndex, model }) }));
  const best = rows.filter((row) => row.flips === 0).sort((left, right) => (
    right.namedShare - left.namedShare || right.model.sigmaMetres - left.model.sigmaMetres
  ))[0];
  return { rows, recommended: best?.model ?? null };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  function percentile(p) {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  }
  return { count: sorted.length, median: percentile(0.5), p75: percentile(0.75), p90: percentile(0.9), p95: percentile(0.95) };
}

/** The earlier fix's speed describes the gap that followed it; unknown speed is unclassified. */
export function reportGaps(records) {
  const previous = new Map(), moving = [], stopped = [];
  for (const record of records) {
    if (record?.kind !== "fix" || !record.fix.mmsi) continue;
    const fix = record.fix, last = previous.get(fix.mmsi);
    if (last && fix.at >= last.at && Number.isFinite(last.sogKnots)) {
      (last.sogKnots >= THRESHOLDS.movingMinSpeedKnots ? moving : stopped).push((fix.at - last.at) / 1000);
    }
    previous.set(fix.mmsi, fix);
  }
  return { moving: distribution(moving), stopped: distribution(stopped) };
}
