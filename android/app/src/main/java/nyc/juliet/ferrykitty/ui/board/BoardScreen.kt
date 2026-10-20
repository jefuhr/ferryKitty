@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)

package nyc.juliet.ferrykitty.ui.board

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material.icons.filled.DirectionsBoat
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.FilterAlt
import androidx.compose.material.icons.filled.FilterList
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.NearMe
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material.icons.filled.EventBusy
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import nyc.juliet.ferrykitty.contract.FerryAction
import nyc.juliet.ferrykitty.contract.FerrySheet
import nyc.juliet.ferrykitty.contract.FerryUiState
import nyc.juliet.ferrykitty.core.DepartureGroup
import nyc.juliet.ferrykitty.core.DeparturePauses
import nyc.juliet.ferrykitty.core.ScheduledDeparture
import nyc.juliet.ferrykitty.core.ScheduleEngine
import nyc.juliet.ferrykitty.ui.FerryUi
import nyc.juliet.ferrykitty.ui.components.MessageCard
import nyc.juliet.ferrykitty.ui.components.Notice
import nyc.juliet.ferrykitty.ui.components.TouchTarget
import nyc.juliet.ferrykitty.ui.sheets.FilterLogic
import nyc.juliet.ferrykitty.ui.theme.FerryText
import nyc.juliet.ferrykitty.ui.theme.TextScale
import nyc.juliet.ferrykitty.ui.theme.ferryColors
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * The departure board: the landing and its clock in the top bar, shortcuts, a pinned date and sort bar, notices, then
 * every visible sailing. Phones show one column; a board at least 600 dp wide reads left to right in two.
 */
@Composable
fun BoardScreen(state: FerryUiState, ui: FerryUi, showLandingButton: Boolean, contentPadding: PaddingValues, modifier: Modifier = Modifier) {
	val snackbar = remember { SnackbarHostState() }
	LocationResults(state, snackbar)
	Scaffold(
		modifier = modifier,
		containerColor = ferryColors.background,
		contentWindowInsets = WindowInsets(0),
		topBar = { BoardTopBar(state, ui, showLandingButton, statusInTitle = !TextScale.isAccessibilityText(LocalDensity.current.fontScale)) },
		snackbarHost = { SnackbarHost(snackbar) },
	) { padding ->
		PullToRefreshBox(
			isRefreshing = state.refreshing,
			onRefresh = { ui.send(FerryAction.Refresh) },
			modifier = Modifier.padding(padding).fillMaxSize(),
		) {
			BoxWithConstraints(Modifier.fillMaxSize()) {
				val accessibilityText = TextScale.isAccessibilityText(LocalDensity.current.fontScale)
				val columns = BoardFormat.columns(maxWidth.value, accessibilityText)
				val context = rememberBoardContext(state, accessibilityText)
				LazyColumn(
					contentPadding = contentPadding,
					modifier = Modifier
						.align(Alignment.TopCenter)
						.widthIn(max = if (columns > 1) BoardFormat.WIDE_MAX_WIDTH.dp else BoardFormat.NARROW_MAX_WIDTH.dp)
						.fillMaxSize()
						.testTag("board"),
				) {
					if (columns == 1) item(key = "shortcuts") { QuickActions(state, ui, Modifier.padding(vertical = 4.dp)) }
					stickyHeader(key = "controls") { BoardControls(state, ui, wide = columns > 1) }
					item(key = "notices") { BoardNotices(state, ui) }
					boardItems(state, ui, context, columns)
				}
			}
		}
	}
}

@Composable
private fun BoardTopBar(state: FerryUiState, ui: FerryUi, showLandingButton: Boolean, statusInTitle: Boolean) {
	val filtersActive = state.preferences.filters.isActive
	TopAppBar(
		colors = TopAppBarDefaults.topAppBarColors(containerColor = ferryColors.background, scrolledContainerColor = ferryColors.card),
		navigationIcon = {
			if (showLandingButton) {
				IconButton(onClick = { ui.open(FerrySheet.LANDINGS) }, modifier = Modifier.testTag("chooseLanding")) {
					Icon(Icons.AutoMirrored.Filled.List, contentDescription = "Choose landing")
				}
			}
		},
		title = { LandingTitle(state, ui, statusInTitle) },
		actions = {
			IconButton(
				onClick = { ui.open(FerrySheet.FILTERS) },
				modifier = Modifier.testTag("operatorFilter").semantics { stateDescription = if (filtersActive) "Filters on" else "Showing all" },
			) {
				Icon(if (filtersActive) Icons.Filled.FilterAlt else Icons.Filled.FilterList, contentDescription = "Filter operators and routes",
					tint = if (filtersActive) ferryColors.accent else ferryColors.ink)
			}
			IconButton(onClick = { ui.open(FerrySheet.SETTINGS) }, modifier = Modifier.testTag("settings")) {
				Icon(Icons.Filled.Settings, contentDescription = "Settings")
			}
		},
	)
}

/**
 * The landing, whether its times are live, and the clock: one button that opens the landing list. With very large text
 * the app bar keeps only the landing; the clock line moves to the board's notices so nothing is clipped.
 */
@Composable
private fun LandingTitle(state: FerryUiState, ui: FerryUi, showStatus: Boolean) {
	val live = BoardModel.isLive(state)
	Column(
		modifier = Modifier
			.testTag("landingTitle")
			.clip(RoundedCornerShape(8.dp))
			.clickable(role = Role.Button, onClickLabel = "Choose landing") { ui.open(FerrySheet.LANDINGS) }
			.heightIn(min = TouchTarget)
			.padding(horizontal = 6.dp, vertical = 2.dp),
		verticalArrangement = Arrangement.Center,
	) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Text(state.landingTitle, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), color = ferryColors.heading,
				maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
			Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = ferryColors.muted, modifier = Modifier.size(18.dp))
		}
		if (showStatus) BoardStatusLine(state, live)
	}
}

@Composable
private fun BoardStatusLine(state: FerryUiState, live: Boolean, modifier: Modifier = Modifier) {
	Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp), modifier = modifier) {
		Box(Modifier.size(7.dp).background(if (live) ferryColors.positive else ferryColors.muted, CircleShape))
		Text("${BoardModel.clock(state)} · ${BoardModel.freshness(state)}", style = FerryText.caption.copy(fontFeatureSettings = "tnum"),
			color = ferryColors.muted)
	}
}

/** Shortcuts: your boat, the nearest landing and favorites. Scrolls sideways; a cut-off chip reads as more to come. */
@Composable
internal fun QuickActions(state: FerryUiState, ui: FerryUi, modifier: Modifier = Modifier) {
	val favorites = remember(state.roster, state.preferences.favorites) {
		FilterLogic.alphabetical(state.roster?.landings.orEmpty().filter { it.id in state.preferences.favorites })
	}
	val scroll = rememberScrollState()
	Row(
		horizontalArrangement = Arrangement.spacedBy(6.dp),
		verticalAlignment = Alignment.CenterVertically,
		modifier = modifier.fadingEnd(scroll.canScrollForward).horizontalScroll(scroll).padding(horizontal = 12.dp),
	) {
		FilterChip(
			selected = state.rideSession != null,
			onClick = { ui.yourBoat(state) },
			label = { Text(state.rideSession?.vessel?.name ?: "Your boat", maxLines = 1) },
			leadingIcon = { Icon(Icons.Filled.DirectionsBoat, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
			modifier = Modifier.testTag("boardChooseBoat"),
		)
		FilterChip(
			selected = false,
			enabled = !state.locating,
			onClick = { ui.send(FerryAction.FindNearest) },
			label = { Text(if (state.locating) "Locating…" else "Nearest", maxLines = 1) },
			leadingIcon = {
				if (state.locating) CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(FilterChipDefaults.IconSize))
				else Icon(Icons.Filled.NearMe, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize))
			},
			modifier = Modifier.testTag("nearestLanding"),
		)
		for (landing in favorites) {
			val current = state.preferences.landingId == landing.id
			FilterChip(
				selected = current,
				onClick = { ui.send(FerryAction.SelectLanding(landing.id)) },
				label = { Text(landing.displayName, maxLines = 1, fontWeight = FontWeight.SemiBold) },
				leadingIcon = { Icon(Icons.Filled.Star, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
				modifier = Modifier.testTag("quickLanding-${landing.id}").semantics { contentDescription = "Favorite landing ${landing.displayName}" },
			)
		}
	}
}

/** Fades the trailing edge while more content scrolls beyond it, so a cut-off chip reads as "scroll for more". */
private fun Modifier.fadingEnd(active: Boolean, width: Dp = 28.dp): Modifier = if (!active) this else this
	.graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
	.drawWithContent {
		drawContent()
		val fade = width.toPx().coerceAtMost(size.width)
		val ltr = layoutDirection == LayoutDirection.Ltr
		val start = if (ltr) size.width - fade else 0f
		drawRect(
			brush = Brush.horizontalGradient(
				colors = if (ltr) listOf(Color.Black, Color.Transparent) else listOf(Color.Transparent, Color.Black),
				startX = start,
				endX = start + fade,
			),
			topLeft = Offset(start, 0f),
			size = Size(fade, size.height),
			blendMode = BlendMode.DstIn,
		)
	}

/** Pinned under the top bar. A wide board keeps the shortcuts here too, in one row; large text stacks the controls. */
@Composable
private fun BoardControls(state: FerryUiState, ui: FerryUi, wide: Boolean) {
	val accessibilityText = TextScale.isAccessibilityText(LocalDensity.current.fontScale)
	Surface(color = ferryColors.background.copy(alpha = 0.97f)) {
		Column {
			if (accessibilityText) {
				DateControls(state, ui, Modifier.fillMaxWidth())
				SortControl(state, ui, Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 6.dp))
			} else {
				Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(end = 12.dp)) {
					if (wide) {
						QuickActions(state, ui, Modifier.weight(1f))
						DateControls(state, ui)
					} else {
						DateControls(state, ui, Modifier.weight(1f))
					}
					SortControl(state, ui, Modifier.width(148.dp).padding(start = 8.dp))
				}
			}
			HorizontalDivider(thickness = 0.5.dp, color = ferryColors.line)
		}
	}
}

@Composable
private fun SortControl(state: FerryUiState, ui: FerryUi, modifier: Modifier = Modifier) {
	val byRoute = state.preferences.sortByRoute
	SingleChoiceSegmentedButtonRow(modifier = modifier.testTag("departureSort")) {
		SegmentedButton(
			selected = !byRoute,
			onClick = { if (byRoute) ui.update(state.preferences.copy(sortByRoute = false)) },
			shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
			icon = {},
			modifier = Modifier.testTag("sortTime"),
		) { Text("Time", maxLines = 1) }
		SegmentedButton(
			selected = byRoute,
			onClick = { if (!byRoute) ui.update(state.preferences.copy(sortByRoute = true)) },
			shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
			icon = {},
			modifier = Modifier.testTag("sortRoute"),
		) { Text("Route", maxLines = 1) }
	}
}

/** Previous/next day within the schedule's range. A browsed date is amber so it cannot pass for today. */
@Composable
private fun DateControls(state: FerryUiState, ui: FerryUi, modifier: Modifier = Modifier) {
	val today = BoardModel.isToday(state)
	val date = BoardModel.currentDate(state)
	var picking by rememberSaveable { mutableStateOf(false) }
	Row(verticalAlignment = Alignment.CenterVertically, modifier = modifier) {
		IconButton(onClick = { ui.send(FerryAction.StepDate(-1)) }, enabled = BoardModel.canStep(state, -1), modifier = Modifier.testTag("previousDay")) {
			Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Previous day")
		}
		TextButton(
			onClick = { if (today) picking = state.schedule != null else ui.send(FerryAction.SelectDate(null)) },
			modifier = Modifier
				.testTag("scheduleDate")
				.heightIn(min = TouchTarget)
				.semantics {
					contentDescription = if (today) "Today, choose a date" else "${BoardFormat.spokenDate(date)}, return to today"
				},
			colors = ButtonDefaults.textButtonColors(
				containerColor = if (today) Color.Transparent else ferryColors.warning.copy(alpha = 0.12f),
				contentColor = if (today) ferryColors.accent else ferryColors.warning,
			),
		) {
			Text(if (today) "Today" else BoardFormat.dateLabel(date), fontWeight = FontWeight.SemiBold, maxLines = 1)
		}
		IconButton(onClick = { ui.send(FerryAction.StepDate(1)) }, enabled = BoardModel.canStep(state, 1), modifier = Modifier.testTag("nextDay")) {
			Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Next day")
		}
		IconButton(onClick = { picking = true }, enabled = state.schedule != null, modifier = Modifier.testTag("pickDate")) {
			Icon(Icons.Filled.CalendarMonth, contentDescription = "Choose a date")
		}
	}
	if (picking && state.schedule != null) SchedulePicker(state, ui) { picking = false }
}

/** A calendar limited to the dates the downloaded schedule covers. */
@Composable
private fun SchedulePicker(state: FerryUiState, ui: FerryUi, dismiss: () -> Unit) {
	val schedule = state.schedule ?: return
	val range = remember(schedule) { ScheduleEngine.range(schedule) }
	fun millis(key: String): Long? = runCatching { LocalDate.parse(key).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() }.getOrNull()
	fun key(millis: Long): String = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate().toString()
	val firstYear = range?.start?.take(4)?.toIntOrNull() ?: LocalDate.now().year
	val lastYear = range?.endInclusive?.take(4)?.toIntOrNull() ?: firstYear
	val picker = rememberDatePickerState(
		initialSelectedDateMillis = millis(BoardModel.currentDate(state)),
		yearRange = firstYear..lastYear,
		selectableDates = object : SelectableDates {
			override fun isSelectableDate(utcTimeMillis: Long): Boolean = range?.contains(key(utcTimeMillis)) == true
			override fun isSelectableYear(year: Int): Boolean = year in firstYear..lastYear
		},
	)
	DatePickerDialog(
		onDismissRequest = dismiss,
		confirmButton = {
			TextButton(onClick = {
				picker.selectedDateMillis?.let { selected ->
					val chosen = key(selected)
					ui.send(FerryAction.SelectDate(if (chosen == BoardModel.today(state)) null else chosen))
				}
				dismiss()
			}) { Text("Show") }
		},
		dismissButton = {
			TextButton(onClick = { ui.send(FerryAction.SelectDate(null)); dismiss() }) { Text("Today") }
		},
	) {
		DatePicker(state = picker, showModeToggle = false)
	}
}

/**
 * Nearest-landing results are transient: the board switches landing on success, so the outcome is announced once in a
 * snackbar rather than left on the board. A new attempt can announce the same message again.
 */
@Composable
private fun LocationResults(state: FerryUiState, snackbar: SnackbarHostState) {
	var announced by rememberSaveable { mutableStateOf<String?>(null) }
	val status = state.locationStatus
	LaunchedEffect(state.locating, status) {
		if (state.locating) {
			announced = null
			return@LaunchedEffect
		}
		if (status != null && status != announced) {
			announced = status
			snackbar.showSnackbar(status, withDismissAction = true)
		}
	}
}

/** Notes and saved-data notices, then alerts. Only active alerts or a failed alert feed take a line. */
@Composable
private fun BoardNotices(state: FerryUiState, ui: FerryUi) {
	Column(Modifier.fillMaxWidth().padding(top = 4.dp)) {
		if (TextScale.isAccessibilityText(LocalDensity.current.fontScale)) {
			BoardStatusLine(state, BoardModel.isLive(state), Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
		}
		state.boardNote?.let { Notice(it, Icons.Filled.ErrorOutline) }
		val error = state.boardError
		if (error != null && state.schedule != null) Notice(error, Icons.Filled.WifiOff)
		state.offlineWarning?.takeIf { it != error }?.let { Notice(it, Icons.Filled.CloudOff) }
		val alerts = state.alerts
		val count = alerts?.alerts?.size ?: 0
		if (count > 0 || alerts?.available == false) {
			val label = when {
				count > 0 -> "${if (alerts?.stale == true) "Saved alerts" else "Alerts"} ($count) · ${alerts?.alerts?.firstOrNull()?.header ?: "Service notices"}"
				else -> "Alerts unavailable"
			}
			Row(
				verticalAlignment = Alignment.CenterVertically,
				horizontalArrangement = Arrangement.spacedBy(8.dp),
				modifier = Modifier
					.padding(top = 6.dp)
					.fillMaxWidth()
					.testTag("serviceAlerts")
					.background(if (count > 0) ferryColors.warning.copy(alpha = 0.1f) else Color.Transparent)
					.clickable(role = Role.Button, onClickLabel = "Show service alerts") { ui.open(FerrySheet.ALERTS) }
					.heightIn(min = TouchTarget)
					.padding(horizontal = 16.dp),
			) {
				Icon(if (count > 0) Icons.Filled.Warning else Icons.Filled.ErrorOutline, contentDescription = null,
					tint = if (count > 0) ferryColors.warning else ferryColors.muted, modifier = Modifier.size(18.dp))
				Text(label, style = MaterialTheme.typography.bodyMedium, color = ferryColors.ink, maxLines = 1, overflow = TextOverflow.Ellipsis,
					modifier = Modifier.weight(1f))
				Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = ferryColors.muted, modifier = Modifier.size(18.dp))
			}
		}
		Spacer(Modifier.size(4.dp))
	}
}

private fun LazyListScope.boardItems(state: FerryUiState, ui: FerryUi, context: BoardContext, columns: Int) {
	val schedule = state.schedule
	if (schedule == null) {
		item(key = "unavailable") {
			if (state.loadingLanding) {
				Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp),
					modifier = Modifier.fillMaxWidth().padding(32.dp)) {
					CircularProgressIndicator()
					Text("Loading schedule…", color = ferryColors.muted)
				}
			} else {
				MessageCard("Schedule unavailable", state.boardError ?: "Connect to load your first landing.", Icons.Filled.CloudOff) {
					Button(onClick = { ui.send(FerryAction.Refresh) }) { Text("Try again") }
				}
			}
		}
		return
	}
	val rows = state.boardRows
	val groups = state.boardGroups
	if (rows.isEmpty() || (state.preferences.sortByRoute && groups.isEmpty())) {
		item(key = "empty") { EmptyBoard(state, ui) }
		return
	}
	if (state.preferences.sortByRoute) {
		items(BoardFormat.rows(groups, columns), key = { line -> "group|" + line.first().id }) { line -> GroupLine(line, columns, context, ui) }
	} else {
		items(BoardFormat.rows(rows, columns), key = { line -> "row|" + line.first().id }) { line -> DepartureLine(line, columns, context, ui) }
	}
	item(key = "bottom") { Spacer(Modifier.size(16.dp)) }
}

/** One line of the by-time board: a sailing, or two side by side on a wide board. [pausesOf] lets tests supply pauses. */
@Composable
internal fun DepartureLine(
	line: List<ScheduledDeparture>,
	columns: Int,
	context: BoardContext,
	ui: FerryUi,
	pausesOf: ((ScheduledDeparture) -> DeparturePauses?)? = null,
) {
	Column {
		Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
			for (row in line) {
				val open = { it: ScheduledDeparture -> ui.send(FerryAction.OpenTrip(it)) }
				if (pausesOf == null) DepartureRow(row, context, showRoute = true, onOpen = open, modifier = Modifier.weight(1f).fillMaxHeight())
				else DepartureRow(row, context, showRoute = true, onOpen = open, modifier = Modifier.weight(1f).fillMaxHeight(), pauses = pausesOf(row))
			}
			repeat(columns - line.size) { Spacer(Modifier.weight(1f)) }
		}
		HorizontalDivider(Modifier.padding(horizontal = 12.dp), thickness = 0.5.dp, color = ferryColors.line)
	}
}

/** One line of the by-route board: a route's group, or two side by side on a wide board. */
@Composable
internal fun GroupLine(
	line: List<DepartureGroup>,
	columns: Int,
	context: BoardContext,
	ui: FerryUi,
	pausesOf: ((ScheduledDeparture) -> DeparturePauses?)? = null,
) {
	Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
		for (group in line) RouteGroupCard(group, context, ui, Modifier.weight(1f).fillMaxHeight(), pausesOf)
		repeat(columns - line.size) { Spacer(Modifier.weight(1f)) }
	}
}

@Composable
private fun EmptyBoard(state: FerryUiState, ui: FerryUi) {
	val date = BoardModel.currentDate(state)
	when {
		!BoardModel.covers(state, date) -> MessageCard("Schedule unavailable", "No saved schedule covers this date. Connect to refresh.", Icons.Filled.EventBusy)
		state.preferences.filters.isActive -> MessageCard("No matching departures", "Try showing all departures or another date.", Icons.Filled.FilterList) {
			OutlinedButton(onClick = { ui.send(FerryAction.ResetFilters) }) { Text("Show all departures") }
		}
		else -> MessageCard(
			"No scheduled departures",
			if (BoardModel.isToday(state)) "No more departures are listed for today." else "No boats are scheduled for this date.",
			Icons.Filled.DirectionsBoat,
		)
	}
}
