package nyc.juliet.ferrykitty.core

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class ScheduleParityTest {
	private fun nine(rows: List<ScheduledDeparture>) = rows.first { it.departure.tripId == "nine" }
	private fun dataWithNine(transform: (Departure) -> Departure): DisplayData {
		val data = scheduleFixture()
		return data.copy(departures = data.departures.map { if (it.tripId == "nine") transform(it) else it })
	}
	private data class PauseFixture(val data: DisplayData, val row: ScheduledDeparture, val realtime: Realtime)
	private fun pauses(): PauseFixture {
		val schedule = scheduleFixture()
		val data = schedule.copy(meta = schedule.meta.copy(showDwellTimes = true, showLayoverTimes = true), tripSchedules = schedule.tripSchedules + ("nine" to TripSchedule(
			listOf(TripCall("1", 1, arrivalSeconds = 32280.0, departureSeconds = 32400.0), TripCall("2", 2, arrivalSeconds = 33300.0, departureSeconds = 33300.0)),
			turnaround = Turnaround("2", "return", scheduledLayoverSeconds = 300.0))))
		val realtime = Realtime(stale = false, updates = listOf(TripUpdate("nine", "1", delaySeconds = 60.0), TripUpdate("nine", "2", delaySeconds = 480.0), TripUpdate("return", "2", delaySeconds = 120.0)))
		return PauseFixture(data, nine(ScheduleEngine.timeline(data, realtime, now = fixtureNow)), realtime)
	}

	@Test fun unmappedScheduleOnlyNeverBorrowsLiveTimingCancellationOrBoat() {
		val data = dataWithNine { it.copy(scheduleOnly = true) }
		val realtime = Realtime(stale = false, updates = listOf(TripUpdate("nine", "1", 600.0, canceled = true)), vehicles = listOf(VehicleAssignment("nine", "ER1", "Wrong boat")))
		val row = nine(ScheduleEngine.timeline(data, realtime, now = fixtureNow))
		assertEquals(0.0, row.delay, 0.0)
		assertFalse(row.hasLiveTiming)
		assertNull(row.boatName)
		assertNull(row.predictedBoatName)
	}

	@Test fun verifiedHolidayAliasOwnsLiveTimingBoatAndCancellation() {
		val data = dataWithNine { it.copy(scheduleOnly = true, liveTripId = "live-nine") }
		val realtime = Realtime(stale = false, updates = listOf(TripUpdate("nine", "1", 999.0, canceled = true), TripUpdate("live-nine", "1", 180.0)), vehicles = listOf(VehicleAssignment("live-nine", "ER1", "Verified vessel")))
		val row = nine(ScheduleEngine.timeline(data, realtime, now = fixtureNow))
		assertEquals(180.0, row.delay, 0.0)
		assertTrue(row.hasLiveTiming)
		assertEquals("Verified vessel", row.boatName)
		assertNull(row.predictedBoatName)
		val canceled = realtime.copy(updates = realtime.updates.orEmpty().map { it.copy(canceled = true) })
		assertFalse(ScheduleEngine.timeline(data, canceled, now = fixtureNow).any { it.departure.tripId == "nine" })
	}

	@Test fun dateSpecificAliasesIgnoreOtherServiceDaysAndKeepFallbacks() {
		val data = dataWithNine { it.copy(liveTripId = "nyc:unmapped:nine", liveTripIdsByDate = mapOf("2026-09-04" to "friday-nine", "2026-09-07" to "monday-nine"), predictTripIdsByDate = mapOf("2026-09-04" to "friday-prediction")) }
		val realtime = Realtime(stale = false, updates = listOf(TripUpdate("monday-nine", "1", 999.0), TripUpdate("friday-nine", "1", 180.0)), vehicles = listOf(VehicleAssignment("friday-nine", boatName = "Friday vessel")))
		val row = nine(ScheduleEngine.timeline(data, realtime, now = fixtureNow))
		assertEquals("friday-nine", row.departure.liveTripId)
		assertEquals("friday-prediction", row.departure.predictTripId)
		assertEquals(180.0, row.delay, 0.0)
		assertEquals("Friday vessel", row.boatName)
	}

	@Test fun crewCoverageHonorsSeasonsWeekendsExclusionsAndHolidayOverride() {
		val status = CrewStatus(confirmedWeekdays = CrewCoverage("2026-09-14", "2026-11-01", listOf("2026-09-28", "2026-09-29")),
			confirmedWeekends = CrewCoverage("2026-09-19", "2026-11-01"), confirmedHolidays = HolidayCrewCoverage(listOf("2026-09-28")))
		val data = dataWithNine { it.copy(endsShift = "confirmed") }.let { it.copy(meta = it.meta.copy(crewScheduleStatus = status)) }
		for ((date, confirmed) in listOf("2026-09-13" to false, "2026-09-14" to true, "2026-09-19" to true, "2026-09-28" to true, "2026-09-29" to false, "2026-11-02" to false)) {
			assertEquals(date, confirmed, ScheduleEngine.crewCoverage(data, date) != null)
			val row = nine(ScheduleEngine.timeline(data, now = Instant.parse(date + "T12:50:00Z")))
			assertEquals(date, if (confirmed) "confirmed" else null, row.departure.endsShift)
		}
	}

	@Test fun reviewedNovemberWeekdaysDoNotConfirmWeekendsOrHolidays() {
		val status = CrewStatus(reviewedWeekdays = CrewCoverage("2026-11-02", "2027-12-31", listOf("2026-11-26"), "6 boundaries unconfirmed"))
		val data = scheduleFixture().let { it.copy(meta = it.meta.copy(crewScheduleStatus = status)) }
		assertEquals("6 boundaries unconfirmed", ScheduleEngine.crewCoverage(data, "2026-11-02")?.message)
		assertNull(ScheduleEngine.crewCoverage(data, "2026-11-07"))
		assertNull(ScheduleEngine.crewCoverage(data, "2026-11-26"))
	}

	@Test fun exceptionsEstablishRangeAndAfterMidnightClocksWrapBothWays() {
		assertEquals("2026-09-07".."2026-09-07", ScheduleEngine.range(scheduleFixture().copy(calendars = emptyList())))
		assertNull(ScheduleEngine.range(scheduleFixture().copy(calendars = emptyList(), exceptions = emptyList())))
		assertEquals("01:10", ServiceClock.time(90600.0))
		assertEquals("1:10 AM", ServiceClock.time(90600.0, true))
		assertEquals("23:59", ServiceClock.time(-60.0))
		assertEquals("2026-10-01", ServiceClock.addDays("2026-09-30", 1))
		assertEquals("2026-02-28", ServiceClock.addDays("2026-03-01", -1))
	}

	@Test fun invalidSchemaIdentityTimezoneCalendarAndNumbersAreRejected() {
		val data = scheduleFixture()
		data.validate(16)
		assertThrows(FerryError.WrongIdentity::class.java) { data.validate(2) }
		assertThrows(FerryError.UnsupportedSchedule::class.java) { data.copy(meta = data.meta.copy(schemaVersion = 12)).validate() }
		for (invalid in listOf(data.copy(meta = data.meta.copy(timezone = "bad/timezone")), data.copy(meta = data.meta.copy(departuresShown = 6)),
			data.copy(meta = data.meta.copy(departureWindowMinutes = 0)), data.copy(calendars = data.calendars.map { it.copy(weekdays = emptyList()) }),
			dataWithNine { it.copy(seconds = -1.0) }, dataWithNine { it.copy(seconds = Double.NaN) }, dataWithNine { it.copy(seconds = Double.POSITIVE_INFINITY) }))
			assertThrows(FerryError.InvalidResponse::class.java) { invalid.validate() }
	}

	@Test fun savedRideInstantsRemoveSeparateArrivalAndDepartureOffsetsInMilliseconds() {
		val stop: RideStop = decode("""{"stopId":"87","sequence":2,"name":"Pier 11","arrivalSeconds":36000,"departureSeconds":36600,"estimatedArrivalSeconds":36300,"estimatedDepartureSeconds":37200,"arrivalAt":1000000,"departureAt":1900000,"skipped":false,"current":true,"past":false}""")
		assertEquals(Instant.ofEpochSecond(1000), stop.instant(true, false))
		assertEquals(Instant.ofEpochSecond(700), stop.instant(true, true))
		assertEquals(Instant.ofEpochSecond(1300), stop.instant(false, true))
		assertNull(stop.copy(arrivalAt = null).instant(true, true))
	}

	@Test fun dwellAndTurnSettingsAreIndependentAndNegativeDwellIsSuppressed() {
		val (original, row, realtime) = pauses()
		for (dwell in listOf(false, true)) for (layover in listOf(false, true)) {
			val data = original.copy(meta = original.meta.copy(showDwellTimes = dwell, showLayoverTimes = layover))
			val result = ScheduleEngine.departurePauses(data, row, realtime)
			assertEquals(if (dwell) 120.0 else null, result.dwellSeconds)
			assertEquals(if (layover) 300.0 else null, result.layover?.scheduledSeconds)
			assertEquals(if (layover) 300.0 else null, ScheduleEngine.tripLayover(data, "nine", data.tripSchedules.getValue("nine").stops.last())?.seconds)
		}
		val defaults = ScheduleEngine.departurePauses(original.copy(meta = original.meta.copy(showDwellTimes = null, showLayoverTimes = null)), row, realtime)
		assertNull(defaults.dwellSeconds)
		assertEquals(300.0, defaults.layover?.scheduledSeconds)
		val trip = original.tripSchedules.getValue("nine")
		val invalid = original.copy(tripSchedules = original.tripSchedules + ("nine" to trip.copy(stops = trip.stops.map { it.copy(arrivalSeconds = 32500.0) })))
		assertNull(ScheduleEngine.departurePauses(invalid, row, realtime).dwellSeconds)
	}

	@Test fun terminalUsesBothTripsAndPreservesOverrunsAndJSNegativeHalfRounding() {
		val (data, row, realtime) = pauses()
		val initial = ScheduleEngine.departurePauses(data, row, realtime)
		assertEquals(2, initial.dwellMinutes)
		assertEquals(-60.0, initial.layover?.seconds)
		assertEquals(-1, initial.layover?.minutes)
		assertTrue(initial.layover?.hasLiveTiming == true)
		fun turn(arrival: Double?, leaving: Double?): LayoverTiming? = ScheduleEngine.departurePauses(data, row,
			realtime.copy(updates = listOf(TripUpdate("nine", "2", arrival), TripUpdate("return", "2", leaving)))).layover
		assertEquals(-180.0, turn(480.0, null)?.seconds)
		assertEquals(420.0, turn(null, 120.0)?.seconds)
		assertEquals(300.0, turn(-60.0, -120.0)?.seconds)
		assertEquals(0, turn(330.0, null)?.minutes)
		assertEquals(300.0, turn(Double.NaN, Double.POSITIVE_INFINITY)?.seconds)
	}

	@Test fun terminalArrivalDelayIsIndependentOfDepartureDelay() {
		val (data, row, _) = pauses()
		val realtime = Realtime(stale = false, updates = listOf(TripUpdate("nine", "2", 0.0, 480.0), TripUpdate("return", "2", 120.0, 900.0)))
		assertEquals(-60.0, ScheduleEngine.departurePauses(data, row, realtime).layover?.seconds)
		assertEquals(0.0, realtime.updates?.first()?.delaySeconds)
	}

	@Test fun canceledStaleBrowsedOrUnmappedTurnsUseScheduledTiming() {
		val (data, row, realtime) = pauses()
		for (index in 1..2) {
			val canceled = realtime.copy(updates = realtime.updates.orEmpty().mapIndexed { i, update -> update.copy(canceled = i == index) })
			assertEquals(300.0, ScheduleEngine.departurePauses(data, row, canceled).layover?.seconds)
			assertFalse(ScheduleEngine.departurePauses(data, row, canceled).layover?.hasLiveTiming == true)
		}
		assertNull(ScheduleEngine.departurePauses(data, row, realtime.copy(stale = true)).layover?.estimatedSeconds)
		assertNull(ScheduleEngine.departurePauses(data, row.copy(live = false), realtime).layover?.estimatedSeconds)
		assertNull(ScheduleEngine.departurePauses(data, row.copy(departure = row.departure.copy(scheduleOnly = true)), realtime).layover?.estimatedSeconds)
	}

	@Test fun nonPassengerAndFinalShiftRowsHideAllPauses() {
		val (data, row, realtime) = pauses()
		for (departure in listOf(row.departure.copy(outOfService = true), row.departure.copy(crewShuttle = true), row.departure.copy(endsShift = "certain")))
			assertEquals(DeparturePauses(), ScheduleEngine.departurePauses(data, row.copy(departure = departure), realtime))
	}

	@Test fun tripTurnRequiresMatchingTerminalAndOnlyFreshConnectionEnrichment() {
		val (data, _, _) = pauses()
		val trip = data.tripSchedules.getValue("nine")
		val origin = trip.stops.first()
		val terminal = trip.stops.last()
		assertNull(ScheduleEngine.tripLayover(data, "nine", origin))
		assertEquals(300.0, ScheduleEngine.tripLayover(data, "nine", terminal)?.seconds)
		val wrongStop = data.copy(tripSchedules = data.tripSchedules + ("nine" to trip.copy(turnaround = trip.turnaround?.copy(stopId = "1"))))
		assertNull(ScheduleEngine.tripLayover(wrongStop, "nine", terminal))
		assertNull(ScheduleEngine.tripLayover(wrongStop, "nine", origin))
		val enriched = Turnaround(scheduledSeconds = 300.0, estimatedSeconds = -180.0, hasLiveTiming = true)
		assertEquals(-3, ScheduleEngine.tripLayover(data, "nine", terminal, enriched, true)?.estimatedMinutes)
		assertEquals(5, ScheduleEngine.tripLayover(data, "nine", terminal, enriched)?.minutes)
		assertNull(ScheduleEngine.tripLayover(data.copy(meta = data.meta.copy(showLayoverTimes = false)), "nine", terminal, enriched, true))
	}

	@Test fun displayTripOwnsDwellWhileMappedLiveTripsOwnDelaysOnBothSides() {
		val (original, originalRow, _) = pauses()
		val trip = original.tripSchedules.getValue("nine")
		val data = original.copy(tripSchedules = original.tripSchedules + mapOf("nine" to trip.copy(liveTripId = "live-nine", turnaround = trip.turnaround?.copy(nextTripId = "nyc:sukkot:trip:return", nextLiveTripId = "live-return")),
			"live-nine" to TripSchedule(listOf(TripCall("1", 1, arrivalSeconds = 30000.0, departureSeconds = 32400.0)))))
		val row = originalRow.copy(departure = originalRow.departure.copy(liveTripId = "live-nine", scheduleOnly = true))
		val realtime = Realtime(stale = false, updates = listOf(TripUpdate("live-nine", "2", 480.0), TripUpdate("live-return", "2", 120.0)))
		val result = ScheduleEngine.departurePauses(data, row, realtime)
		assertEquals(120.0, result.dwellSeconds)
		assertEquals(-60.0, result.layover?.seconds)
		assertTrue(result.layover?.hasLiveTiming == true)
	}

	@Test fun datedNextTripAndScheduleAliasesSupplyTurnTiming() {
		val (original, row, _) = pauses()
		val trip = original.tripSchedules.getValue("nine")
		val data = original.copy(tripSchedules = original.tripSchedules + mapOf("nine" to trip.copy(turnaround = trip.turnaround?.copy(nextLiveTripIdsByDate = mapOf(row.serviceDate to "dated-return"))),
			"return" to TripSchedule(emptyList(), liveTripId = "fallback-return")))
		val feed = Realtime(stale = false, updates = listOf(TripUpdate("nine", "2", 480.0), TripUpdate("dated-return", "2", 120.0), TripUpdate("fallback-return", "2", 999.0)))
		assertEquals(-60.0, ScheduleEngine.departurePauses(data, row, feed).layover?.seconds)
	}
}
