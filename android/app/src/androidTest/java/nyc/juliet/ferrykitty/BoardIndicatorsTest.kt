package nyc.juliet.ferrykitty

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.toSize
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import nyc.juliet.ferrykitty.contract.AppPreferences
import nyc.juliet.ferrykitty.contract.FerryAction
import nyc.juliet.ferrykitty.contract.FerryUiState
import nyc.juliet.ferrykitty.core.Departure
import nyc.juliet.ferrykitty.core.DepartureGroup
import nyc.juliet.ferrykitty.core.DeparturePauses
import nyc.juliet.ferrykitty.core.LayoverTiming
import nyc.juliet.ferrykitty.core.ScheduledDeparture
import nyc.juliet.ferrykitty.platform.AndroidRuntime
import nyc.juliet.ferrykitty.platform.FerryStateStore
import nyc.juliet.ferrykitty.platform.TestLaunchPolicy
import nyc.juliet.ferrykitty.ui.FerryUi
import nyc.juliet.ferrykitty.ui.board.BoardScreen
import nyc.juliet.ferrykitty.ui.board.DepartureLine
import nyc.juliet.ferrykitty.ui.board.GroupLine
import nyc.juliet.ferrykitty.ui.board.BoardFormat
import nyc.juliet.ferrykitty.ui.board.BoardModel
import nyc.juliet.ferrykitty.ui.board.rememberBoardContext
import nyc.juliet.ferrykitty.ui.components.TouchTarget
import nyc.juliet.ferrykitty.ui.rememberFerryUi
import nyc.juliet.ferrykitty.ui.theme.FerryTheme
import nyc.juliet.ferrykitty.ui.theme.TextScale
import nyc.juliet.ferrykitty.ui.theme.ferryColors
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

/**
 * The compact scheduled indicators on the departure board: a clock for a plain timetable departure and for a scheduled
 * layover, at narrow phone widths, large text, both sorts and the tablet's two columns.
 *
 * Failure modes checked, per row:
 *  - the clock replaces SCHED only when nothing outranks it (live timing, delay, service status stay in words);
 *  - an estimated layover keeps its own wording and no clock; a scheduled layover's clock never starts a line;
 *  - no unused vertical space: content fills the row evenly and a detail line is never taller than its text;
 *  - legitimate wrapping stays: long vessel and destination names wrap between words rather than truncating;
 *  - the row keeps its 48 dp touch target, stays inside the frame, and the time and status edges align on tablets.
 */
@RunWith(AndroidJUnit4::class)
class BoardIndicatorsTest {
	@get:Rule val compose = createComposeRule()
	private val context get() = ApplicationProvider.getApplicationContext<Context>()
	private val screenDensity get() = context.resources.displayMetrics.density
	private val width = mutableStateOf(360.dp)
	private val fontScale = mutableStateOf(1f)
	private val problems = mutableListOf<String>()
	private var scope: CoroutineScope? = null
	private var store: FerryStateStore? = null

	/** Narrow phones (320 and 360 dp) at default, large, threshold-edge and accessibility text. */
	private val phoneCases = listOf(320.dp, 360.dp).flatMap { w -> listOf(1f, 1.3f, 1.49f, 1.8f, 2f).map { w to it } }

	@After fun stop() {
		store?.let { s -> InstrumentationRegistry.getInstrumentation().runOnMainSync { s.close() } }
		scope?.cancel()
	}

	private fun use(w: Dp, scale: Float) {
		compose.runOnIdle {
			width.value = w
			fontScale.value = scale
		}
		compose.waitForIdle()
	}

	private fun name(w: Dp, scale: Float, mode: String) = "${w.value.toInt()}dp-$scale-$mode"

	private fun frame(): Rect = compose.onNodeWithTag("indicatorFrame").fetchSemanticsNode().boundsInRoot

	private fun bounds(node: SemanticsNode) = Rect(node.positionInRoot, node.size.toSize())

	private fun tagged(tag: String, within: SemanticsNode? = null): List<SemanticsNode> =
		compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true).fetchSemanticsNodes().filter { it.layoutInfo.isPlaced }
			.filter { within == null || generateSequence(it.parent) { p -> p.parent }.any { p -> p.id == within.id } }

	private fun descendants(node: SemanticsNode): List<SemanticsNode> = node.children.flatMap { listOf(it) + descendants(it) }

	private fun layout(node: SemanticsNode): TextLayoutResult? {
		val layouts = mutableListOf<TextLayoutResult>()
		node.config.getOrNull(SemanticsActions.GetTextLayoutResult)?.action?.invoke(layouts)
		return layouts.firstOrNull()
	}

	private fun textOf(node: SemanticsNode): String = node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }.orEmpty()

	private fun spoken(node: SemanticsNode): String = node.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty()

	private fun shot(name: String) {
		compose.waitForIdle()
		InstrumentationRegistry.getInstrumentation().waitForIdleSync()
		val bitmap = settledScreenshot()
		File(screenshotDirectory(), "board-indicators-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
		bitmap.recycle()
	}

	// ---- synthetic rows ----------------------------------------------------------------------------------------

	private class Spec(
		val id: String, val route: String, val destination: String, val minutes: Int, val boat: Int?, val vessel: String?,
		val layoverMinutes: Int? = null, val variant: String? = null,
		val delay: Double = 0.0, val delta: Double = 900.0, val flags: (Departure) -> Departure = { it },
		val lastOfDay: Boolean = false, val finalTrip: Boolean = false,
	)

	/** The long names from the field report, beside short ones, a delayed, a boarding and service-status sailings. */
	private val specs = listOf(
		Spec("er", "ER", "East 34th Street", 448, 4, "Happy Hauler", layoverMinutes = 5, variant = "B"),
		Spec("sg", "SG", "Midtown West/W 39th St-Pier 79", 456, 4, "Tooth Ferry", layoverMinutes = 6),
		Spec("as", "AS", "East 90th St", 458, 2, "Jewel of the Harbor", layoverMinutes = 5),
		Spec("rs", "RS", "Rockaway", 458, 3, "Signs to Liberty", layoverMinutes = 10),
		Spec("late", "ER", "Pier 11", 470, 1, "Opportunity", layoverMinutes = 7, delay = 180.0),
		Spec("board", "SB", "Governors Island", 471, 1, "Starlight", delta = 45.0),
		Spec("drop", "ER", "Wall St", 480, null, null, flags = { it.copy(arrival = true) }),
		Spec("crew", "ER", "Crew pickup", 485, null, null, flags = { it.copy(crewShuttle = true, secondsEnd = 30600.0) }),
		Spec("last", "SG", "Midtown West/W 39th St-Pier 79", 500, 6, "Jewel of the Harbor", layoverMinutes = 6, lastOfDay = true, finalTrip = true),
	)

	/** [timetable] is the offline, stale or browsed-date board: nothing carries live timing. */
	private fun scheduled(spec: Spec, timetable: Boolean): ScheduledDeparture {
		val departure = spec.flags(Departure(tripId = spec.id, routeId = spec.route, serviceId = "daily", stopId = "1", destination = spec.destination,
			seconds = spec.minutes * 60.0, departureTime = "%02d:%02d:00".format(spec.minutes / 60, spec.minutes % 60), variant = spec.variant,
			boatAssignment = spec.boat, endsShift = if (spec.finalTrip) "yes" else null))
		return ScheduledDeparture(departure, "2026-09-04", if (timetable) 0.0 else spec.delay, if (timetable) 0.0 else spec.delta, live = !timetable,
			hasLiveTiming = !timetable, boatName = spec.vessel, isLastOfDay = spec.lastOfDay)
	}

	private fun pauses(spec: Spec, timetable: Boolean): DeparturePauses? = spec.layoverMinutes?.takeIf { spec.flags(dummy).let { d -> d.arrival != true && d.crewShuttle != true } }?.let {
		DeparturePauses(layover = LayoverTiming(it * 60.0, if (timetable) null else it * 60.0 + spec.delay))
	}

	private val dummy = Departure(tripId = "x", routeId = "ER", serviceId = "daily", stopId = "1", destination = "x", seconds = 0.0, departureTime = "00:00:00")

	private fun showSynthetic(byRoute: () -> Boolean, timetable: () -> Boolean) {
		compose.setContent {
			val base = LocalDensity.current
			CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale.value)) {
				FerryTheme(themeId = "nyc-ferry", textSize = "system") {
					Surface(color = ferryColors.card) {
						Box(Modifier.width(width.value).fillMaxHeight().testTag("indicatorFrame")) {
							val accessibility = TextScale.isAccessibilityText(fontScale.value)
							val columns = BoardFormat.columns(width.value.value, accessibility)
							val state = FerryUiState(preferences = AppPreferences(sortByRoute = byRoute()))
							val board = rememberBoardContext(state, accessibility)
							val ui = rememberFerryUi { }
							val rows = specs.map { it to scheduled(it, timetable()) }
							val pausesOf = { row: ScheduledDeparture -> pauses(specs.first { it.id == row.departure.tripId }, timetable()) }
							Column(Modifier.verticalScroll(rememberScrollState())) {
								if (byRoute()) {
									val groups = rows.groupBy { it.first.destination + it.first.route }.map { (key, list) ->
										DepartureGroup(key, list.first().first.route, null, null, list.first().first.destination, list.map { it.second })
									}
									for (line in BoardFormat.rows(groups, columns)) GroupLine(line, columns, board, ui, pausesOf)
								} else {
									for (line in BoardFormat.rows(rows.map { it.second }, columns)) DepartureLine(line, columns, board, ui, pausesOf)
								}
							}
						}
					}
				}
			}
		}
	}

	private fun checkRow(case: String, spec: Spec, timetable: Boolean, row: SemanticsNode, accessibility: Boolean, phone: Boolean) {
		val label = "$case ${spec.id}"
		val rowBounds = bounds(row)
		val frame = frame()
		if (rowBounds.height < TouchTarget.value * screenDensity - 1f) problems += "$label: ${rowBounds.height} px is under the 48 dp touch target"
		if (rowBounds.left < frame.left - 1f || rowBounds.right > frame.right + 1f) problems += "$label: row $rowBounds leaves the frame $frame"

		// Status: the clock only for a plain timetable departure; words for anything that outranks it.
		val plain = spec.flags(dummy).let { it.arrival != true && it.crewShuttle != true && it.outOfService != true }
		val clocks = tagged("scheduledClock", row)
		val status = tagged("departureStatus", row).singleOrNull()
		val statusText = descendants(row).filter { it.config.contains(SemanticsProperties.Text) }.map(::textOf)
		val expectClock = plain && timetable
		if (expectClock && clocks.size != 1) problems += "$label: a scheduled departure shows ${clocks.size} clocks"
		if (!expectClock && clocks.isNotEmpty()) problems += "$label: a departure with live timing or a service status shows the scheduled clock"
		if (statusText.any { it == "SCHED" }) problems += "$label: SCHED text is still drawn"
		if (status == null) problems += "$label: no status badge"
		if (!plain) {
			val word = if (spec.flags(dummy).arrival == true) "DROP OFF ONLY" else "NO PICKUP"
			if (word !in statusText) problems += "$label: service status $word is not shown in words"
		}
		if (!timetable && plain) {
			val word = if (spec.delay >= 60) "+3m" else "ON TIME"
			if (word !in statusText) problems += "$label: live status $word is not shown (saw $statusText)"
			if (spec.delta <= 90 && "Boarding" !in statusText) problems += "$label: Boarding countdown is not shown"
		}
		if (timetable && statusText.any { it.endsWith("min") || it == "Boarding" }) problems += "$label: a timetable row shows a countdown"

		// The spoken sentence keeps the full wording whatever is drawn.
		val sentence = spoken(row)
		if (plain && timetable && !sentence.contains("scheduled")) problems += "$label: spoken row lost \"scheduled\": $sentence"
		if (spec.layoverMinutes != null && plain) {
			val wanted = "layover ${spec.layoverMinutes + if (timetable) 0 else spec.delay.toInt() / 60} minutes ${if (timetable) "scheduled" else "estimated"}"
			if (!sentence.contains(wanted)) problems += "$label: spoken row lacks \"$wanted\": $sentence"
		}

		// Layover: a scheduled one is minutes plus an inline clock; an estimate keeps its word and has no clock.
		val detail = tagged("departureDetail", row).singleOrNull()
		val layoverClock = tagged("layoverClock", row)
		if (spec.layoverMinutes != null && plain) {
			if (detail == null) problems += "$label: no detail line for the layover"
			else {
				val text = textOf(detail)
				if (timetable) {
					if (!text.contains("Layover ${spec.layoverMinutes}m")) problems += "$label: detail lacks Layover ${spec.layoverMinutes}m: $text"
					if (text.contains(" sched") || text.contains(" est")) problems += "$label: scheduled layover still has a word suffix: $text"
					if (layoverClock.size != 1) problems += "$label: ${layoverClock.size} layover clocks"
					else checkClockOnItsLine(label, detail, text)
				} else {
					if (!text.contains(" est")) problems += "$label: estimated layover lost its est marker: $text"
					if (layoverClock.isNotEmpty()) problems += "$label: estimated layover shows a clock"
				}
			}
		} else if (layoverClock.isNotEmpty()) problems += "$label: a clock without a scheduled layover"

		// No unused vertical space.
		if (detail != null) {
			val result = layout(detail)
			if (result != null) {
				val textHeight = result.getLineBottom(result.lineCount - 1)
				if (detail.size.height > textHeight + 1f) problems += "$label: detail is ${detail.size.height} px tall for ${result.lineCount} lines of ${textHeight} px"
				val last = result.lineCount - 1
				if (result.getLineRight(last) - result.getLineLeft(last) <= 1f) problems += "$label: detail ends in a blank line"
			}
		}
		val content = descendants(row).filter { it.size.width > 0 && it.size.height > 0 }.map(::bounds)
		if (content.isNotEmpty() && phone) {
			val top = content.minOf { it.top } - rowBounds.top
			val bottom = rowBounds.bottom - content.maxOf { it.bottom }
			if (abs(top - bottom) > 2f) problems += "$label: content sits ${top} px from the top and ${bottom} px from the bottom of a ${rowBounds.height} px row"
			val padding = 6f * screenDensity
			if (rowBounds.height > TouchTarget.value * screenDensity + 2f && bottom > padding + 2f) problems += "$label: ${bottom - padding} px of blank space under the content"
		}
		// Long names wrap whole; they are never cut short.
		for (destination in tagged("departureDestination", row)) {
			val result = layout(destination) ?: continue
			for (line in 0 until result.lineCount) if (result.isLineEllipsized(line)) problems += "$label: destination is truncated: ${textOf(destination)}"
		}
		if (status != null) {
			val edge = bounds(status).right
			if (edge > rowBounds.right + 1f) problems += "$label: status leaves its row"
		}
	}

	/** The clock sits on the line of the minutes it follows and inside the text. */
	private fun checkClockOnItsLine(label: String, detail: SemanticsNode, text: String) {
		val result = layout(detail) ?: return
		val joiner = text.indexOf('⁠')
		if (joiner < 1) { problems += "$label: no joiner before the clock"; return }
		val minutesLine = result.getLineForOffset(joiner - 1)
		val rect = result.placeholderRects.filterNotNull().singleOrNull()
		if (rect == null) { problems += "$label: no placeholder rect"; return }
		val clockLine = result.getLineForVerticalPosition(rect.center.y)
		if (clockLine != minutesLine) problems += "$label: the clock is on line $clockLine, its minutes on line $minutesLine"
		if (rect.right > result.size.width + 1f) problems += "$label: the clock is clipped at $rect in ${result.size.width} px"
	}

	private fun runSynthetic(byRoute: Boolean, timetable: Boolean, cases: List<Pair<Dp, Float>>) {
		val mode = (if (byRoute) "route" else "time") + (if (timetable) "-sched" else "-live")
		showSynthetic({ byRoute }, { timetable })
		for ((w, scale) in cases) {
			use(w, scale)
			val case = name(w, scale, mode)
			val accessibility = TextScale.isAccessibilityText(scale)
			for (spec in specs) {
				val row = tagged("departure-${spec.id}").singleOrNull()
				if (row == null) { problems += "$case ${spec.id}: not shown"; continue }
				checkRow(case, spec, timetable, row, accessibility, phone = w < 600.dp)
			}
			if (scale == 1f || scale == 1.49f) shot(case)
		}
	}

	@Test fun scheduledIndicatorsByTimeAtNarrowWidths() {
		runSynthetic(byRoute = false, timetable = true, cases = phoneCases)
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}

	@Test fun liveIndicatorsByTimeKeepWordsAndEstimates() {
		runSynthetic(byRoute = false, timetable = false, cases = phoneCases)
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}

	@Test fun scheduledIndicatorsByRoute() {
		runSynthetic(byRoute = true, timetable = true, cases = phoneCases)
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}

	@Test fun liveIndicatorsByRoute() {
		runSynthetic(byRoute = true, timetable = false, cases = phoneCases)
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}

	@Test fun boardSwitchesBetweenLiveAndScheduledWithoutShiftingRows() {
		val timetable = mutableStateOf(false)
		showSynthetic({ false }, { timetable.value })
		for ((w, scale) in listOf(320.dp to 1.3f, 360.dp to 1.49f)) {
			use(w, scale)
			val heights = mutableMapOf<String, Float>()
			for (flag in listOf(false, true, false)) {
				compose.runOnIdle { timetable.value = flag }
				compose.waitForIdle()
				val case = name(w, scale, if (flag) "to-sched" else "to-live")
				for (spec in specs) {
					val row = tagged("departure-${spec.id}").single()
					checkRow(case, spec, flag, row, TextScale.isAccessibilityText(scale), phone = true)
					// A clock replacing SCHED can only make a row shorter or equal, never taller than its live twin.
					if (heights.containsKey(spec.id) && flag && bounds(row).height > heights.getValue(spec.id) + 1f)
						problems += "$case ${spec.id}: the scheduled row is taller (${bounds(row).height}) than its live row (${heights.getValue(spec.id)})"
					if (!flag) heights[spec.id] = bounds(row).height
				}
			}
		}
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}

	private fun checkTabletColumns(timetable: Boolean) {
		showSynthetic({ false }, { timetable })
		use(1066.dp, 1f)
		val case = name(1066.dp, 1f, "tablet-" + if (timetable) "sched" else "live")
		val density = screenDensity
		val rows = specs.mapNotNull { spec -> tagged("departure-${spec.id}").singleOrNull()?.let { spec to it } }
		if (rows.size != specs.size) problems += "$case: ${rows.size} of ${specs.size} rows shown"
		for ((spec, row) in rows) {
			val rowBounds = bounds(row)
			val time = tagged("departureTime", row).singleOrNull()?.let(::bounds)
			val status = tagged("departureStatus", row).singleOrNull()?.let(::bounds)
			if (time != null && abs(time.left - rowBounds.left - 12 * density) > 1.5f) problems += "$case ${spec.id}: time starts ${time.left - rowBounds.left} px in, not 12 dp"
			if (status != null && abs(rowBounds.right - status.right - 12 * density) > 1.5f) problems += "$case ${spec.id}: status ends ${rowBounds.right - status.right} px from the edge, not 12 dp"
			checkRow(case, spec, timetable, row, accessibility = false, phone = false)
		}
		shot(case)
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}

	@Test fun scheduledTabletColumnsAlignTimesAndStatusEdges() {
		checkTabletColumns(timetable = true)
	}

	@Test fun liveTabletColumnsAlignTimesAndStatusEdges() {
		checkTabletColumns(timetable = false)
	}

	// ---- the real board ----------------------------------------------------------------------------------------

	private fun main(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

	private fun showFixtureBoard() {
		val session = AndroidRuntime.session(context, TestLaunchPolicy(fixtures = true, reset = true, offline = false))
		val owner = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
		scope = owner
		main {
			store = FerryStateStore(session.repository, session.settings, owner, session.clock).also { it.setActive(true); it.dispatch(FerryAction.SelectLanding(16)) }
		}
		compose.waitUntil(20_000) { store!!.state.value.boardRows.any { it.departure.tripId == "nine" } }
		compose.setContent {
			val state by store!!.state.collectAsState()
			val base = LocalDensity.current
			CompositionLocalProvider(LocalDensity provides Density(base.density, fontScale.value)) {
				FerryTheme(themeId = state.preferences.theme, textSize = "system") {
					Surface(color = ferryColors.card) {
						Box(Modifier.width(width.value).fillMaxHeight().testTag("indicatorFrame")) {
							BoardScreen(state, rememberFerryUi { store!!.dispatch(it) }, showLandingButton = false, contentPadding = PaddingValues(0.dp))
						}
					}
				}
			}
		}
	}

	/** Every row's drawn indicator agrees with its spoken sentence, on the app's real state, fixtures and sorts. */
	private fun checkBoardAgrees(case: String) {
		val rows = compose.onAllNodes(hasTestTag("board").not() and hasAnyAncestor(hasTestTag("board")), useUnmergedTree = true).fetchSemanticsNodes()
			.filter { it.config.contains(SemanticsProperties.TestTag) && it.config[SemanticsProperties.TestTag].startsWith("departure-") && it.layoutInfo.isPlaced }
		if (rows.isEmpty()) problems += "$case: no departure rows shown"
		for (row in rows) {
			val sentence = spoken(row)
			val clocks = tagged("scheduledClock", row).size
			val texts = descendants(row).filter { it.config.contains(SemanticsProperties.Text) }.map(::textOf)
			val tag = row.config[SemanticsProperties.TestTag]
			if (texts.any { it == "SCHED" }) problems += "$case $tag: SCHED text is drawn"
			val isScheduled = sentence.split(", ").contains("scheduled")
			if (isScheduled != (clocks == 1)) problems += "$case $tag: spoken \"scheduled\"=$isScheduled but $clocks clocks drawn: $sentence"
			if (bounds(row).height < TouchTarget.value * screenDensity - 1f) problems += "$case $tag: under the 48 dp touch target"
			if (row.config.getOrNull(SemanticsActions.OnClick) != null && sentence.isBlank()) problems += "$case $tag: clickable without a spoken sentence"
		}
	}

	@Test fun realBoardAgreesWithItsSpokenRowsBothSortsLiveAndBrowsed() {
		showFixtureBoard()
		for (sortByRoute in listOf(false, true)) {
			main { store!!.dispatch(FerryAction.SetPreferences(store!!.state.value.preferences.copy(sortByRoute = sortByRoute, twelveHour = true))) }
			compose.waitUntil(10_000) { store!!.state.value.preferences.sortByRoute == sortByRoute }
			for ((w, scale) in listOf(320.dp to 1.2f, 360.dp to 1.49f, 360.dp to 1.8f)) {
				use(w, scale)
				checkBoardAgrees("live ${name(w, scale, if (sortByRoute) "route" else "time")}")
			}
			shot("real-live-" + if (sortByRoute) "route" else "time")
		}
		// A browsed date: every ordinary sailing is a timetable sailing, and the header still explains why.
		main { store!!.dispatch(FerryAction.SelectDate("2026-09-05")) }
		compose.waitUntil(10_000) { store!!.state.value.viewDate == "2026-09-05" && store!!.state.value.boardRows.isNotEmpty() }
		for (sortByRoute in listOf(false, true)) {
			main { store!!.dispatch(FerryAction.SetPreferences(store!!.state.value.preferences.copy(sortByRoute = sortByRoute))) }
			compose.waitUntil(10_000) { store!!.state.value.preferences.sortByRoute == sortByRoute }
			for ((w, scale) in listOf(320.dp to 1.2f, 360.dp to 1.49f)) {
				use(w, scale)
				val case = "browsed ${name(w, scale, if (sortByRoute) "route" else "time")}"
				checkBoardAgrees(case)
				val freshness = BoardModel.freshness(store!!.state.value)
				if (freshness != "Published schedule") problems += "$case: header says \"$freshness\""
				if (compose.onAllNodes(hasText(freshness, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
					problems += "$case: the header no longer explains \"$freshness\""
			}
			shot("real-browsed-" + if (sortByRoute) "route" else "time")
		}
		assertTrue(problems.joinToString("\n"), problems.isEmpty())
	}
}
