// A small, hand-built Pier 11 board for the scheduled-indicator checks.
//
// The rows are the ones that broke the layout on a phone: long destinations, long boat names and a
// layover on every sailing. Times are fixed relative to NOW so the same rows are on screen whenever
// the check runs, and each trip carries a turnaround so the layover renders without realtime.
export const NOW = "2026-09-20T11:17:00Z"; // 07:17 in New York

const ROUTES = {
  ER: { id: "ER", shortName: "ER", name: "East River", color: "#00839C", textColor: "#FFFFFF", mode: "ferry", operator: "NYC Ferry" },
  RS: { id: "RS", shortName: "RS", name: "Rockaway", color: "#52148A", textColor: "#FFFFFF", mode: "ferry", operator: "NYC Ferry" },
  SG: { id: "SG", shortName: "SG", name: "St. George", color: "#C0287F", textColor: "#FFFFFF", mode: "ferry", operator: "NYC Ferry" },
  AS: { id: "AS", shortName: "AS", name: "Astoria", color: "#EF6F2C", textColor: "#FFFFFF", mode: "ferry", operator: "NYC Ferry" },
  SB: { id: "SB", shortName: "SB", name: "South Brooklyn", color: "#F7C934", textColor: "#1C1C1C", mode: "ferry", operator: "NYC Ferry" }
};

// [id, route, direction, "HH:MM", destination, boat number, boat name, layover minutes]
const ROWS = [
  ["t1", "ER", "1", "07:28", "East 34th Street", 4, "Happy Hauler", 5],
  ["t2", "RS", "1", "07:33", "Ferry Point Park", 6, "City Fishy", 6],
  ["t3", "SG", "1", "07:36", "Midtown West/W 39th St-Pier 79", 4, "Tooth Ferry", 6],
  ["t4", "AS", "1", "07:38", "East 90th St", 2, "Jewel of the Harbor", 5],
  ["t5", "RS", "0", "07:38", "Rockaway", 3, "Signs to Liberty", 10],
  ["t6", "SB", "1", "07:39", "Governors Island", 1, "Starlight", 5],
  ["t7", "ER", "1", "07:41", "East 34th Street", 5, "Time Traveler", 5],
  ["t8", "SB", "1", "07:46", "East 34th Street", 2, "Great Eagle", 6]
];

// Each route-direction runs again this evening, which is what keeps the morning rows from being the
// day's LAST sailing and taking the badge slot the scheduled indicator lives in.
const EVENING = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id, index) => [`${id}-pm`, ROWS[index][1], ROWS[index][2], "19:00", ROWS[index][4], ROWS[index][5], ROWS[index][6], ROWS[index][7]]);

function seconds(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 3600 + minutes * 60;
}

export function scheduledBoardPayload({ layovers = true } = {}) {
  const departures = [];
  const tripSchedules = {};
  for (const [tripId, routeId, directionId, time, destination, boatAssignment, , layover] of [...ROWS, ...EVENING]) {
    departures.push({
      tripId, routeId, serviceId: "ALL", directionId, stopId: "1", departureTime: `${time}:00`,
      seconds: seconds(time), destination, variant: null, nextStop: null, servesGovernorsIsland: false,
      boatAssignment, mode: "ferry", operator: "NYC Ferry", via: [], endsShift: null, outOfService: false,
      crewShuttle: false, crewBoats: null, departureTimeEnd: null, secondsEnd: null, endsDay: false
    });
    tripSchedules[tripId] = {
      stops: [
        { stopId: "1", sequence: 1, arrivalSeconds: seconds(time), departureSeconds: seconds(time) },
        { stopId: "2", sequence: 2, arrivalSeconds: seconds(time) + 1200, departureSeconds: seconds(time) + 1200 }
      ],
      turnaround: {
        stopId: "2", nextTripId: `${tripId}-return`, nextDepartureSeconds: seconds(time) + 1200 + layover * 60,
        scheduledLayoverSeconds: layover * 60
      }
    };
  }
  return {
    meta: {
      timezone: "America/New_York", agencyName: "NYC Ferry", landingNumber: 16,
      departureWindowMinutes: 180, departuresShown: 4, showDwellTimes: false, showLayoverTimes: layovers,
      landing: { name: "Pier 11", displayName: "Wall St / Pier 11", stopIds: ["1"] }
    },
    routes: ROUTES,
    calendars: [{ serviceId: "ALL", weekdays: [true, true, true, true, true, true, true], startDate: "2026-01-01", endDate: "2026-12-31" }],
    exceptions: [],
    departures,
    tripSchedules,
    stops: { 1: { name: "Wall St/Pier 11", landingId: 16 }, 2: { name: "East 34th Street", landingId: 8 } }
  };
}

// What the feed can say about the board. `offline` is a device that has never reached it, `stale` a
// device holding a saved snapshot, `live` a fresh one where only some boats have reported.
export function scheduledBoardRealtime(kind) {
  const vehicles = ROWS.map(([tripId, routeId, , , , boatAssignment, boatName]) =>
    ({ tripId, boat: `${routeId}${boatAssignment}`, boatName, vesselNumber: String(boatAssignment) }));
  if (kind === "offline") return { available: false, stale: true, updates: [], vehicles: [] };
  if (kind === "stale") {
    return { available: true, stale: true, updates: [{ tripId: "t2", stopId: "1", delaySeconds: 240 }], vehicles };
  }
  // Mixed live: one boat late, one on time, the rest still on the published timetable.
  return {
    available: true, stale: false,
    updates: [
      { tripId: "t2", stopId: "1", delaySeconds: 240 },
      { tripId: "t4", stopId: "1", delaySeconds: 0 },
      // The boat reaches the turn two minutes late, so its layover is an estimate, not the timetable.
      { tripId: "t4", stopId: "2", delaySeconds: 120 }
    ],
    vehicles
  };
}

export const ROW_LABELS = ROWS.map(([tripId, , , time, destination, , boatName, layover]) => ({ tripId, time, destination, boatName, layover }));
