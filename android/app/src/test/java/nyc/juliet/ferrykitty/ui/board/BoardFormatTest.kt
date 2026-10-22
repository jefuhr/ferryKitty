package nyc.juliet.ferrykitty.ui.board

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import nyc.juliet.ferrykitty.core.Departure
import nyc.juliet.ferrykitty.core.DeparturePauses
import nyc.juliet.ferrykitty.core.LayoverTiming
import nyc.juliet.ferrykitty.core.ScheduledDeparture
import nyc.juliet.ferrykitty.core.ViaTerminal

class BoardFormatTest {
	private fun departure(
		tripId: String = "nine",
		routeId: String = "ER",
		destination: String = "Pier 11",
		seconds: Double = 32400.0,
		configure: Departure.() -> Departure = { this },
	) = Departure(tripId = tripId, routeId = routeId, serviceId = "weekday", stopId = "pier-11", destination = destination,
		seconds = seconds, departureTime = "09:00:00").configure()

	private fun row(departure: Departure = departure(), delay: Double = 0.0, delta: Double = 600.0, live: Boolean = true, hasLiveTiming: Boolean = false) =
		ScheduledDeparture(departure, "2026-09-04", delay, delta, live, hasLiveTiming)

	@Test fun secondColumnOnlyWhenBothColumnsStayReadable() {
		assertEquals("Phone portrait", 1, BoardFormat.columns(412f, accessibilityText = false))
		assertEquals("Small tablet beside a rail", 1, BoardFormat.columns(554f, accessibilityText = false))
		assertEquals("Phone landscape", 2, BoardFormat.columns(600f, accessibilityText = false))
		assertEquals("Tablet", 2, BoardFormat.columns(1066f, accessibilityText = false))
		assertEquals("Never a third column", 2, BoardFormat.columns(1600f, accessibilityText = false))
		assertEquals("Accessibility text keeps one column", 1, BoardFormat.columns(1600f, accessibilityText = true))
	}

	@Test fun rowsFillLeftToRight() {
		assertEquals(listOf(listOf(1, 2), listOf(3, 4), listOf(5)), BoardFormat.rows((1..5).toList(), 2))
		assertEquals(listOf(listOf(1), listOf(2), listOf(3)), BoardFormat.rows((1..3).toList(), 1))
		assertEquals(emptyList<List<Int>>(), BoardFormat.rows(emptyList<Int>(), 2))
		assertEquals("A zero column count still lays out rows", listOf(listOf(1), listOf(2)), BoardFormat.rows(listOf(1, 2), 0))
	}

	@Test fun compactCountdownFitsTheTimeColumn() {
		assertEquals("Boarding", BoardFormat.countdown(90.0, live = true, dueLabel = "Boarding"))
		assertEquals("Due", BoardFormat.countdown(60.0, live = true, dueLabel = "Due"))
		assertEquals("2 min", BoardFormat.countdown(91.0, live = true, dueLabel = "Boarding"))
		assertEquals("10 min", BoardFormat.countdown(600.0, live = true, dueLabel = "Boarding"))
		assertEquals("59 min", BoardFormat.countdown(3540.0, live = true, dueLabel = "Boarding"))
		assertEquals("1h", BoardFormat.countdown(3599.0, live = true, dueLabel = "Boarding"))
		assertEquals("1h 10m", BoardFormat.countdown(4200.0, live = true, dueLabel = "Boarding"))
		assertEquals("2h", BoardFormat.countdown(7199.0, live = true, dueLabel = "Boarding"))
		assertEquals("Tomorrow", BoardFormat.countdown(86400.0, live = true, dueLabel = "Boarding"))
		assertEquals("Browsed dates have no countdown", "", BoardFormat.countdown(600.0, live = false, dueLabel = "Boarding"))
	}

	@Test fun spokenCountdownUsesWords() {
		assertEquals("Due", BoardFormat.spokenCountdown(60.0, live = true, dueLabel = "Due"))
		assertEquals("in 1 hour 1 minute", BoardFormat.spokenCountdown(61 * 60.0, live = true, dueLabel = "Boarding"))
		assertEquals("in 2 hours", BoardFormat.spokenCountdown(7200.0, live = true, dueLabel = "Boarding"))
		assertEquals("in 5 minutes", BoardFormat.spokenCountdown(300.0, live = true, dueLabel = "Boarding"))
		assertEquals("tomorrow", BoardFormat.spokenCountdown(90000.0, live = true, dueLabel = "Boarding"))
		assertNull(BoardFormat.spokenCountdown(600.0, live = false, dueLabel = "Boarding"))
	}

	@Test fun browsedDateNamesTheWeekday() {
		assertEquals("Sat Sep 5", BoardFormat.dateLabel("2026-09-05"))
		assertEquals("Thu Dec 31", BoardFormat.dateLabel("2026-12-31"))
		assertEquals("not-a-date", BoardFormat.dateLabel("not-a-date"))
		assertEquals("Saturday, September 5, 2026", BoardFormat.spokenDate("2026-09-05"))
	}

	@Test fun statusPrefersMovementThenLiveTiming() {
		assertEquals(BoardFormat.Status("DROP OFF ONLY", BoardFormat.Tone.WARNING), BoardFormat.status(row(departure { copy(arrival = true) })))
		assertEquals(BoardFormat.Status("NO PICKUP", BoardFormat.Tone.WARNING), BoardFormat.status(row(departure { copy(crewShuttle = true) })))
		assertEquals(BoardFormat.Status("NO PICKUP", BoardFormat.Tone.WARNING), BoardFormat.status(row(departure { copy(outOfService = true) })))
		assertEquals(BoardFormat.Status("+3m", BoardFormat.Tone.WARNING), BoardFormat.status(row(delay = 150.0, hasLiveTiming = true)))
		assertEquals(BoardFormat.Status("ON TIME", BoardFormat.Tone.POSITIVE), BoardFormat.status(row(delay = 59.0, hasLiveTiming = true)))
		assertEquals(BoardFormat.Status("SCHED", BoardFormat.Tone.NEUTRAL), BoardFormat.status(row(delay = 300.0, hasLiveTiming = false)))
	}

	@Test fun finalNeedsAPassengerShiftEnd() {
		assertEquals("FINAL", BoardFormat.finalLabel(departure { copy(endsShift = "yes") }))
		assertEquals("FINAL?", BoardFormat.finalLabel(departure { copy(endsShift = "unsure") }))
		assertNull(BoardFormat.finalLabel(departure { copy(endsShift = "") }))
		assertNull(BoardFormat.finalLabel(departure { copy(endsShift = "yes", outOfService = true) }))
		assertNull(BoardFormat.finalLabel(departure { copy(endsShift = "yes", crewShuttle = true) }))
	}

	@Test fun timeShowsDelayAndApproximation() {
		assertEquals("09:02", BoardFormat.timeLabel(row(delay = 120.0, hasLiveTiming = true), twelveHour = false))
		assertEquals("9:00 AM*", BoardFormat.timeLabel(row(departure { copy(approximate = true) }), twelveHour = true))
	}

	@Test fun workingNumberUsesTheRouteShortName() {
		assertEquals("ER1", BoardFormat.working(departure { copy(boatAssignment = 1) }, shortName = null))
		assertEquals("SB4", BoardFormat.working(departure { copy(routeId = "SB", boatAssignment = 4) }, shortName = "SB"))
		assertNull(BoardFormat.working(departure(), shortName = "ER"))
	}

	@Test fun partnerOperatorsHaveTheirOwnMarks() {
		assertEquals(BoardFormat.Partner.WATERWAY, BoardFormat.partner("wtr:10225"))
		assertEquals(BoardFormat.Partner.WATERWAY, BoardFormat.partner("wbf:1"))
		assertEquals(BoardFormat.Partner.SEASTREAK, BoardFormat.partner("sea:1"))
		assertEquals(BoardFormat.Partner.NYU, BoardFormat.partner("nyu:shuttle"))
		assertEquals(BoardFormat.Partner.CITY_FERRY, BoardFormat.partner("lib:1"))
		assertEquals(BoardFormat.Partner.GOVERNORS_ISLAND, BoardFormat.partner("gi:1"))
		assertNull(BoardFormat.partner("ER"))
	}

	@Test fun otherOperatorIsNamedOnlyWithoutAMark() {
		assertNull(BoardFormat.otherOperator("ER", "NYC Ferry"))
		assertNull(BoardFormat.otherOperator("nyc:ER", "NYC Ferry Partner"))
		assertNull(BoardFormat.otherOperator("sea:1", "Seastreak"))
		assertEquals("Staten Island Ferry", BoardFormat.otherOperator("sif:1", "Staten Island Ferry"))
	}

	@Test fun detailsListEveryPublishedFact() {
		val pauses = DeparturePauses(dwellSeconds = 240.0, layover = LayoverTiming(scheduledSeconds = 600.0, estimatedSeconds = 720.0))
		val shuttle = departure { copy(crewShuttle = true, secondsEnd = 34200.0, viaTerminals = listOf(ViaTerminal("WFC"), ViaTerminal("P11"))) }
		assertEquals(listOf("Crew shuttle until 09:30", "VIA WFC · VIA P11"),
			BoardFormat.details(row(shuttle), pauses = null, twelveHour = false, otherOperator = null))
		val home = departure { copy(approximate = true, fromHomePort = true, via = listOf("Pier 11", "DUMBO")) }
		assertEquals(listOf("via Pier 11, DUMBO", "Dwell 4m", "Layover 12m est", "Approx. · first pickup at destination"),
			BoardFormat.details(row(home), pauses = pauses, twelveHour = false, otherOperator = null))
		assertEquals("A zero dwell says nothing", listOf("Layover 10m sched"),
			BoardFormat.details(row(), DeparturePauses(dwellSeconds = 0.0, layover = LayoverTiming(600.0)), twelveHour = false, otherOperator = null))
		assertEquals("Movements say what they are, not who runs them", listOf("Out of service"),
			BoardFormat.details(row(departure { copy(outOfService = true) }), null, false, "Seastreak"))
		assertEquals(listOf("Seastreak"), BoardFormat.details(row(), null, false, "Seastreak"))
	}

	@Test fun spokenRowReadsAsOneSentence() {
		val working = row(departure { copy(boatAssignment = 1) }, delta = 600.0).copy(boatName = "Opportunity")
		val spoken = BoardFormat.spoken(working, pauses = DeparturePauses(dwellSeconds = 300.0), twelveHour = false,
			showRoute = true, shortName = "ER", operator = null)
		assertEquals("09:00, in 10 minutes, ER to Pier 11, scheduled, working ER1, vessel Opportunity, dwell 5 minutes", spoken)
		val predicted = row(departure { copy(endsShift = "unsure") }).copy(predictedBoatName = "Bay Hopper", isLastOfDay = true)
		val text = BoardFormat.spoken(predicted, pauses = null, twelveHour = false, showRoute = false, shortName = "ER", operator = null)
		assertTrue(text, text.contains("last departure"))
		assertTrue(text, text.contains("final, return trip unconfirmed"))
		assertTrue(text, text.contains("predicted vessel Bay Hopper, unconfirmed"))
		assertFalse("By route the group names the destination", text.contains("to Pier 11"))
	}
}
