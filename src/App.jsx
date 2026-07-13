import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import {
  Save,
  Trash2,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Flag,
  ListChecks,
  Plus,
  Pencil,
  Star,
  ChevronDown,
  ChevronRight,
  Lock,
} from "lucide-react";
import { storage } from "./storage";

const PAGES_KEY = "slot-pages-v1";
const historyKey = (pageId) => `slot-history-${pageId}`;
const EVENT_NAMES_KEY = "slot-event-names-v1";
const STRONG_EVENTS_KEY = "slot-strong-events-v1";
const CLOSED_DAYS_KEY = "slot-closed-days-v1";
const DATE_EVENT_MAP_KEY = "slot-date-event-map-v1";
const DATALIST_ID = "slot-event-name-options";

const PALETTE = [
  "#e8b34c", "#4fd1c5", "#e5697a", "#7aa2f7", "#9ece6a",
  "#bb9af7", "#f6a04d", "#5fd3bc", "#e0af68", "#7dcfff",
];

const STRONG_COLORS = ["#e5484d", "#f2a541", "#4fd1c5", "#7aa2f7", "#bb9af7", "#9ece6a"];
const DIGIT2_COLOR = "#7dcfff";
const DIGIT7_COLOR = "#f6a04d";

// bump this on every change shipped, so the person can glance at the header
// and confirm whether a deploy actually took effect
const APP_VERSION = "1.6";

const RANGE_OPTIONS = [
  { key: 10, label: "10日足" },
  { key: 20, label: "20日足" },
  { key: 30, label: "30日足" },
  { key: 60, label: "60日足" },
  { key: "all", label: "全期間" },
];

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Parse pasted hall-data table text into an array of machine records.
function parseTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const machines = [];
  for (const line of lines) {
    if (line.startsWith("台番")) continue; // header row
    if (line.startsWith("平均")) continue; // average row

    let cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 7) {
      cols = line.split(/\s{2,}/).map((c) => c.trim());
    }
    if (cols.length < 7) continue;

    const [noStr, sadaStr, gsuStr, shutsuStr, bbStr, rbStr, gouseiStr, bbRateStr, rbRateStr] = cols;

    const no = parseInt(String(noStr).replace(/,/g, ""), 10);
    if (Number.isNaN(no)) continue;

    const sada = parseInt(String(sadaStr).replace(/,/g, ""), 10);
    const gsu = parseInt(String(gsuStr).replace(/,/g, ""), 10);
    const shutsu = parseFloat(String(shutsuStr).replace("%", ""));
    const bb = bbStr === "-" || bbStr === undefined ? null : parseInt(bbStr, 10);
    const rb = rbStr === "-" || rbStr === undefined ? null : parseInt(rbStr, 10);
    const gouseiMatch = gouseiStr ? gouseiStr.match(/1\s*\/\s*(\d+)/) : null;
    const gousei = gouseiMatch ? parseInt(gouseiMatch[1], 10) : null;

    machines.push({
      no,
      sada: Number.isNaN(sada) ? null : sada,
      gsu: Number.isNaN(gsu) ? null : gsu,
      shutsu: Number.isNaN(shutsu) ? null : shutsu,
      bb,
      rb,
      gousei,
      bbRateStr: bbRateStr ?? "-",
      rbRateStr: rbRateStr ?? "-",
    });
  }
  return machines;
}

function fmtNum(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "―";
  return v.toLocaleString();
}

// Build (trailing N-day total, next day's differential) pairs from a
// chronological series of {date, sada} for one machine.
function buildTrailingPairs(series, windowSize) {
  const pairs = [];
  for (let k = windowSize - 1; k < series.length - 1; k++) {
    let sum = 0;
    for (let j = k - windowSize + 1; j <= k; j++) sum += series[j].sada;
    const next = series[k + 1];
    pairs.push({ trailingSum: sum, nextSada: next.sada, nextDate: next.date });
  }
  return pairs;
}

// Search candidate thresholds and find the "total >= T" and "total <= T"
// splits that give the best next-day-positive win rate (with a minimum
// sample size so it isn't just picking a fluke single data point).
function findBestThresholds(pairs, minSample = 5) {
  if (pairs.length < 8) return null;
  const thresholds = Array.from(new Set(pairs.map((p) => p.trailingSum))).sort((a, b) => a - b);

  let bestAbove = null;
  let bestBelow = null;
  thresholds.forEach((T) => {
    const above = pairs.filter((p) => p.trailingSum >= T);
    if (above.length >= minSample) {
      const wins = above.filter((p) => p.nextSada > 0).length;
      const winRate = wins / above.length;
      const avgNext = above.reduce((a, p) => a + p.nextSada, 0) / above.length;
      if (!bestAbove || winRate > bestAbove.winRate || (winRate === bestAbove.winRate && above.length > bestAbove.sampleSize)) {
        bestAbove = { threshold: T, winRate, sampleSize: above.length, avgNext };
      }
    }
    const below = pairs.filter((p) => p.trailingSum <= T);
    if (below.length >= minSample) {
      const wins = below.filter((p) => p.nextSada > 0).length;
      const winRate = wins / below.length;
      const avgNext = below.reduce((a, p) => a + p.nextSada, 0) / below.length;
      if (!bestBelow || winRate > bestBelow.winRate || (winRate === bestBelow.winRate && below.length > bestBelow.sampleSize)) {
        bestBelow = { threshold: T, winRate, sampleSize: below.length, avgNext };
      }
    }
  });

  return { totalPairs: pairs.length, bestAbove, bestBelow };
}

// On a categorical date axis, a single day has zero width, so widen it by
// one neighboring day so the hatched band is actually visible.
function getBandRange(dateList, date) {
  const idx = dateList.indexOf(date);
  if (idx === -1) return null;
  if (idx < dateList.length - 1) return { x1: date, x2: dateList[idx + 1] };
  if (idx > 0) return { x1: dateList[idx - 1], x2: date };
  return { x1: date, x2: date };
}

export default function SlotDataTracker() {
  // ---- pages (機種) ----
  const [pages, setPages] = useState([]);
  const [pagesLoaded, setPagesLoaded] = useState(false);
  const [activePageId, setActivePageId] = useState(null);
  const [pageHistories, setPageHistories] = useState({});
  const [confirmDeletePage, setConfirmDeletePage] = useState(null);
  const loadedHistoryRef = useRef(new Set());

  // ---- global event registries ----
  const [eventNames, setEventNames] = useState([]);
  const [strongEvents, setStrongEvents] = useState([]); // [{name,color}] - matched by event NAME, not a specific date
  const [strongName, setStrongName] = useState("");
  const [strongColor, setStrongColor] = useState(STRONG_COLORS[0]);
  const [strongStatus, setStrongStatus] = useState(null);

  // ---- closed days (global, shared across all pages) ----
  const [closedDays, setClosedDays] = useState([]); // [{date}]
  const [closedDate, setClosedDate] = useState(todayStr());
  const [closedStatus, setClosedStatus] = useState(null);

  // ---- date -> event name (global, shared across all pages, so an event
  // typed while entering one page's data auto-fills for the same date on
  // every other page, even after a reload / on another device) ----
  const [dateEventMap, setDateEventMap] = useState({});

  // ---- per-page form / view state ----
  const [pasteText, setPasteText] = useState("");
  const [entryDate, setEntryDate] = useState(todayStr());
  const [entryEvent, setEntryEvent] = useState("");
  const [status, setStatus] = useState(null);
  const [selectedMachines, setSelectedMachines] = useState([]);
  const [range, setRange] = useState(30);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDeleteDate, setConfirmDeleteDate] = useState(null);
  const [dateListOpen, setDateListOpen] = useState(true);
  const [useCustomRange, setUseCustomRange] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [luckyDigit, setLuckyDigit] = useState(null);
  const [analysisWindow, setAnalysisWindow] = useState(10);

  // ---- PIN lock for the data-entry panels (session-only, never persisted) ----
  const UNLOCK_PIN = "5246";
  const [unlocked, setUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState(false);

  // ---- day-detail viewer ----
  const [viewDate, setViewDate] = useState(todayStr());

  // ---- load pages + global registries on mount ----
  useEffect(() => {
    (async () => {
      let loadedPages = null;
      try {
        const res = await storage.get(PAGES_KEY, false);
        if (res && res.value) loadedPages = JSON.parse(res.value);
      } catch (e) {
        // no pages saved yet
      }
      if (!Array.isArray(loadedPages) || loadedPages.length === 0) {
        loadedPages = Array.from({ length: 4 }).map((_, i) => ({
          id: `page-${i + 1}`,
          name: "",
        }));
        try {
          await storage.set(PAGES_KEY, JSON.stringify(loadedPages), false);
        } catch (e) {
          // ignore
        }
      }
      setPages(loadedPages);
      setActivePageId(loadedPages[0].id);
      setPagesLoaded(true);

      try {
        const r2 = await storage.get(EVENT_NAMES_KEY, false);
        if (r2 && r2.value) setEventNames(JSON.parse(r2.value));
      } catch (e) {
        // none yet
      }
      try {
        const r3 = await storage.get(STRONG_EVENTS_KEY, false);
        if (r3 && r3.value) {
          const raw = JSON.parse(r3.value);
          if (Array.isArray(raw)) {
            // migrate old {date,name,color} records -> unique-by-name {name,color}
            const byName = {};
            raw.forEach((item) => {
              const name = (item.name || "").trim();
              if (!name) return;
              if (!byName[name]) byName[name] = { name, color: item.color || STRONG_COLORS[0] };
            });
            setStrongEvents(Object.values(byName));
          }
        }
      } catch (e) {
        // none yet
      }
      try {
        const r4 = await storage.get(CLOSED_DAYS_KEY, false);
        if (r4 && r4.value) setClosedDays(JSON.parse(r4.value));
      } catch (e) {
        // none yet
      }
      try {
        const r5 = await storage.get(DATE_EVENT_MAP_KEY, false);
        if (r5 && r5.value) {
          const parsedMap = JSON.parse(r5.value);
          setDateEventMap(parsedMap);
          setEntryEvent((prev) => (prev ? prev : parsedMap[entryDate] || prev));
        }
      } catch (e) {
        // none yet
      }
    })();
  }, []);

  // ---- lazy-load history for whichever page becomes active ----
  useEffect(() => {
    if (!activePageId) return;
    if (loadedHistoryRef.current.has(activePageId)) return;
    loadedHistoryRef.current.add(activePageId);
    (async () => {
      try {
        const res = await storage.get(historyKey(activePageId), false);
        const val = res && res.value ? JSON.parse(res.value) : [];
        setPageHistories((prev) => ({ ...prev, [activePageId]: Array.isArray(val) ? val : [] }));
      } catch (e) {
        setPageHistories((prev) => ({ ...prev, [activePageId]: [] }));
      }
    })();
  }, [activePageId]);

  // ---- reset ephemeral per-page UI state when switching pages ----
  // note: entryEvent is intentionally NOT cleared here, so an event typed
  // while entering one page's data carries over to other pages for the
  // same date (see the entryDate-based reset effect below).
  useEffect(() => {
    setSelectedMachines([]);
    setPasteText("");
    setStatus(null);
    setConfirmDeleteDate(null);
  }, [activePageId]);

  const persistPages = useCallback(async (next) => {
    setPages(next);
    try {
      await storage.set(PAGES_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistPageHistory = useCallback(async (pageId, next) => {
    setPageHistories((prev) => ({ ...prev, [pageId]: next }));
    try {
      const res = await storage.set(historyKey(pageId), JSON.stringify(next), false);
      if (!res) setStatus({ type: "error", msg: "保存に失敗しました。もう一度お試しください。" });
    } catch (e) {
      setStatus({ type: "error", msg: "保存中にエラーが発生しました。" });
    }
  }, []);

  const persistEventNames = useCallback(async (next) => {
    setEventNames(next);
    try {
      await storage.set(EVENT_NAMES_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistStrongEvents = useCallback(async (next) => {
    setStrongEvents(next);
    try {
      await storage.set(STRONG_EVENTS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistClosedDays = useCallback(async (next) => {
    setClosedDays(next);
    try {
      await storage.set(CLOSED_DAYS_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  const persistDateEventMap = useCallback(async (next) => {
    setDateEventMap(next);
    try {
      await storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  // race-safe upsert: merges against the LATEST state (via the functional
  // setState form) instead of a value captured in a stale closure, so
  // saving several dates back-to-back can't silently drop earlier entries
  const upsertDateEvent = useCallback((date, name) => {
    setDateEventMap((prev) => {
      const next = { ...prev, [date]: name };
      storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false).catch(() => {});
      return next;
    });
  }, []);

  function rememberEventName(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return;
    if (!eventNames.includes(trimmed)) {
      persistEventNames([...eventNames, trimmed]);
    }
  }

  // ---- page management ----
  function handleAddPage() {
    const next = [...pages, { id: `page-${Date.now()}`, name: "" }];
    persistPages(next);
    setActivePageId(next[next.length - 1].id);
  }

  function handleRenamePage(pageId, name) {
    persistPages(pages.map((p) => (p.id === pageId ? { ...p, name } : p)));
  }

  function handleDeletePage(pageId) {
    const next = pages.filter((p) => p.id !== pageId);
    persistPages(next);
    setConfirmDeletePage(null);
    if (activePageId === pageId && next.length > 0) {
      setActivePageId(next[0].id);
    }
  }

  const currentHistory = pageHistories[activePageId] || [];
  const historyLoading = activePageId && pageHistories[activePageId] === undefined;
  const currentPage = pages.find((p) => p.id === activePageId);

  const allMachineNumbers = useMemo(() => {
    const set = new Set();
    currentHistory.forEach((h) => h.machines.forEach((m) => set.add(m.no)));
    return Array.from(set).sort((a, b) => a - b);
  }, [currentHistory]);

  useEffect(() => {
    if (!historyLoading && selectedMachines.length === 0 && allMachineNumbers.length > 0) {
      setSelectedMachines(allMachineNumbers.slice(0, Math.min(6, allMachineNumbers.length)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoading, allMachineNumbers]);

  const sortedHistory = useMemo(
    () => [...currentHistory].sort((a, b) => a.date.localeCompare(b.date)),
    [currentHistory]
  );

  const historyByDate = useMemo(() => {
    const map = {};
    currentHistory.forEach((h) => {
      map[h.date] = h;
    });
    return map;
  }, [currentHistory]);

  const entryDateHasExisting = !!historyByDate[entryDate];

  const closedDateSet = useMemo(() => new Set(closedDays.map((c) => c.date)), [closedDays]);

  // warn if the date being entered was already registered as a closed (店休日) day
  const entryDateIsClosed = closedDateSet.has(entryDate);

  // warn if there's a gap between the last recorded date (for this page) and
  // the date being entered, with days in between that are neither recorded
  // nor registered as closed
  const dateGapWarning = useMemo(() => {
    if (!entryDate || sortedHistory.length === 0) return null;
    const priorDates = sortedHistory.map((h) => h.date).filter((d) => d < entryDate);
    if (priorDates.length === 0) return null;
    const lastDate = priorDates[priorDates.length - 1];
    const missing = [];
    let cursor = addDays(lastDate, 1);
    let guard = 0;
    while (cursor < entryDate && guard < 400) {
      if (!historyByDate[cursor] && !closedDateSet.has(cursor)) missing.push(cursor);
      cursor = addDays(cursor, 1);
      guard += 1;
    }
    if (missing.length === 0) return null;
    return { lastDate, missing };
  }, [entryDate, sortedHistory, historyByDate, closedDateSet]);

  // merge in closed days (within the recorded date range) so they appear on the axis
  const timelineDates = useMemo(() => {
    if (sortedHistory.length === 0) return [];
    const historyDates = sortedHistory.map((h) => h.date);
    const minDate = historyDates[0];
    const maxDate = historyDates[historyDates.length - 1];
    const closedInRange = closedDays.map((c) => c.date).filter((d) => d >= minDate && d <= maxDate);
    return Array.from(new Set([...historyDates, ...closedInRange])).sort((a, b) => a.localeCompare(b));
  }, [sortedHistory, closedDays]);

  const visibleTimelineDates = useMemo(() => {
    if (useCustomRange && customStart && customEnd) {
      return timelineDates.filter((d) => d >= customStart && d <= customEnd);
    }
    if (range === "all" || timelineDates.length === 0) return timelineDates;
    return timelineDates.slice(-range);
  }, [timelineDates, range, useCustomRange, customStart, customEnd]);

  const chartData = useMemo(() => {
    return visibleTimelineDates.map((date) => {
      const entry = historyByDate[date];
      const closed = closedDateSet.has(date);
      const row = { date, event: entry ? entry.event || "" : "", closed };
      selectedMachines.forEach((no) => {
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        row[String(no)] = m ? m.sada : null;
      });
      return row;
    });
  }, [visibleTimelineDates, historyByDate, closedDateSet, selectedMachines]);

  const strongEventColorByName = useMemo(() => {
    const map = {};
    strongEvents.forEach((s) => {
      map[s.name] = s.color;
    });
    return map;
  }, [strongEvents]);

  // every date in THIS page's history whose event name matches a registered
  // strong-event name — so registering a name once flags every occurrence,
  // past or future, without re-registering each date
  const strongDatesInHistory = useMemo(() => {
    return sortedHistory
      .filter((h) => h.event && strongEventColorByName[h.event.trim()])
      .map((h) => ({ date: h.date, name: h.event.trim(), color: strongEventColorByName[h.event.trim()] }));
  }, [sortedHistory, strongEventColorByName]);

  // dates flagged as "strong" / "closed" that actually fall within the visible chart
  const strongDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return strongDatesInHistory.filter((se) => visibleDates.has(se.date));
  }, [strongDatesInHistory, visibleTimelineDates]);

  const closedDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return closedDays.filter((c) => visibleDates.has(c.date));
  }, [closedDays, visibleTimelineDates]);

  // "2のつく日" (2nd/12th/22nd) and "7のつく日" (7th/17th/27th) — auto-detected, no registration needed
  const digit2DatesInView = useMemo(
    () => visibleTimelineDates.filter((d) => parseInt(d.slice(-2), 10) % 10 === 2),
    [visibleTimelineDates]
  );
  const digit7DatesInView = useMemo(
    () => visibleTimelineDates.filter((d) => parseInt(d.slice(-2), 10) % 10 === 7),
    [visibleTimelineDates]
  );

  const strongDateSet = useMemo(() => new Set(strongDatesInHistory.map((s) => s.date)), [strongDatesInHistory]);
  const strongColorByDate = useMemo(() => {
    const map = {};
    strongDatesInHistory.forEach((s) => {
      map[s.date] = s.color;
    });
    return map;
  }, [strongDatesInHistory]);

  // ordinary (non-strong) events, shown as a gold star marker
  const eventDates = useMemo(
    () =>
      visibleTimelineDates
        .map((d) => historyByDate[d])
        .filter((e) => e && e.event && e.event.trim().length > 0 && !strongDateSet.has(e.date)),
    [visibleTimelineDates, historyByDate, strongDateSet]
  );

  const machineSummaries = useMemo(() => {
    return selectedMachines.map((no) => {
      let dataCount = 0;
      let cum = 0;
      let started = false;
      const series = [];
      visibleTimelineDates.forEach((date) => {
        const entry = historyByDate[date];
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        if (m && m.sada !== null) {
          cum += m.sada;
          started = true;
          dataCount += 1;
        }
        // carry the running total forward on days with no data, instead of
        // breaking the line, so it always ends exactly at the total shown
        series.push({ date, value: started ? cum : null });
      });
      const totalSada = cum;
      const seriesDates = new Set(series.map((s) => s.date));
      const strongInSeries = strongDatesInHistory.filter((se) => seriesDates.has(se.date));
      const closedInSeries = closedDays.filter((c) => seriesDates.has(c.date));
      const digit2InSeries = series.map((s) => s.date).filter((d) => parseInt(d.slice(-2), 10) % 10 === 2);
      const digit7InSeries = series.map((s) => s.date).filter((d) => parseInt(d.slice(-2), 10) % 10 === 7);
      return { no, totalSada, dataCount, series, strongInSeries, closedInSeries, digit2InSeries, digit7InSeries };
    });
  }, [selectedMachines, visibleTimelineDates, historyByDate, strongDatesInHistory, closedDays]);

  // "○のつく日" (e.g. digit 2 → the 2nd/12th/22nd) average 差枚 per machine,
  // computed across this page's entire recorded history (not limited by range)
  const luckyDayStats = useMemo(() => {
    if (luckyDigit === null) return [];
    const matchingEntries = sortedHistory.filter((h) => {
      const day = parseInt(h.date.slice(-2), 10);
      return day % 10 === luckyDigit;
    });
    const map = {};
    matchingEntries.forEach((h) => {
      h.machines.forEach((m) => {
        if (m.sada === null) return;
        if (!map[m.no]) map[m.no] = { sum: 0, count: 0 };
        map[m.no].sum += m.sada;
        map[m.no].count += 1;
      });
    });
    return Object.entries(map)
      .map(([no, v]) => ({ no: parseInt(no, 10), avg: v.sum / v.count, count: v.count }))
      .sort((a, b) => b.avg - a.avg);
  }, [luckyDigit, sortedHistory]);

  // "○のつく日" overall total: for each matching date, sum every machine's
  // 差枚 that day, then average that daily total across all matching dates
  const luckyDayOverall = useMemo(() => {
    if (luckyDigit === null) return null;
    const matchingEntries = sortedHistory.filter((h) => parseInt(h.date.slice(-2), 10) % 10 === luckyDigit);
    if (matchingEntries.length === 0) return null;
    const dailyTotals = matchingEntries.map((h) =>
      h.machines.reduce((sum, m) => sum + (m.sada ?? 0), 0)
    );
    const avgTotal = dailyTotals.reduce((a, b) => a + b, 0) / dailyTotals.length;
    return { avgTotal, dayCount: matchingEntries.length };
  }, [luckyDigit, sortedHistory]);

  // for each selected machine: does a big trailing-N-day total tend to predict
  // whether the next day is positive? (both "total is high" and "total is low" directions)
  const thresholdAnalyses = useMemo(() => {
    return selectedMachines.map((no) => {
      const series = sortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          return m && m.sada !== null ? { date: h.date, sada: m.sada } : null;
        })
        .filter(Boolean);

      const allPairs = buildTrailingPairs(series, analysisWindow);
      const overall = findBestThresholds(allPairs);
      const digit2Pairs = allPairs.filter((p) => parseInt(p.nextDate.slice(-2), 10) % 10 === 2);
      const digit7Pairs = allPairs.filter((p) => parseInt(p.nextDate.slice(-2), 10) % 10 === 7);
      const digit2 = findBestThresholds(digit2Pairs, 3);
      const digit7 = findBestThresholds(digit7Pairs, 3);

      return { no, overall, digit2, digit7 };
    });
  }, [selectedMachines, sortedHistory, analysisWindow]);

  // evaluate one window size for one machine's series: does the CURRENT
  // trailing total already meet a historically favorable threshold?
  function evaluateWindow(series, windowSize) {
    if (series.length < windowSize + 1) return null;
    const pairs = buildTrailingPairs(series, windowSize);
    const result = findBestThresholds(pairs);
    if (!result) return null;
    const currentWindow = series.slice(-windowSize);
    if (currentWindow.length < windowSize) return null;
    const currentTrailing = currentWindow.reduce((a, s) => a + s.sada, 0);
    const reasons = [];
    if (result.bestAbove && currentTrailing >= result.bestAbove.threshold) {
      reasons.push({ direction: "above", ...result.bestAbove });
    }
    if (result.bestBelow && currentTrailing <= result.bestBelow.threshold) {
      reasons.push({ direction: "below", ...result.bestBelow });
    }
    return { currentTrailing, reasons };
  }

  // machines whose CURRENT trailing total already meets a historically
  // favorable threshold, checked across the 10/20/30-day windows together,
  // with a combined "総合判断" verdict (computed across all machines this
  // page has ever seen)
  const pickList = useMemo(() => {
    const results = [];
    allMachineNumbers.forEach((no) => {
      const series = sortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          return m && m.sada !== null ? { date: h.date, sada: m.sada } : null;
        })
        .filter(Boolean);
      if (series.length === 0) return;
      const lastDate = series[series.length - 1].date;

      const windows = [10, 20, 30].map((w) => ({ windowSize: w, result: evaluateWindow(series, w) }));
      const matchedWindows = windows.filter((w) => w.result && w.result.reasons.length > 0);
      if (matchedWindows.length === 0) return;

      const evaluableCount = windows.filter((w) => w.result).length;
      const avgWinRate =
        matchedWindows.reduce((a, w) => a + Math.max(...w.result.reasons.map((r) => r.winRate)), 0) /
        matchedWindows.length;

      results.push({
        no,
        lastDate,
        windows,
        matchedCount: matchedWindows.length,
        evaluableCount,
        avgWinRate,
      });
    });
    results.sort((a, b) => {
      if (b.matchedCount !== a.matchedCount) return b.matchedCount - a.matchedCount;
      return b.avgWinRate - a.avgWinRate;
    });
    return results;
  }, [allMachineNumbers, sortedHistory]);

  function handleSave() {
    if (!activePageId) return;
    const parsedMachines = parseTable(pasteText);
    if (parsedMachines.length === 0) {
      setStatus({ type: "error", msg: "データを読み取れませんでした。表をそのまま貼り付けてください。" });
      return;
    }
    if (!entryDate) {
      setStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    const trimmedEvent = entryEvent.trim();
    const next = [
      ...currentHistory.filter((h) => h.date !== entryDate),
      { date: entryDate, event: trimmedEvent, machines: parsedMachines },
    ];
    persistPageHistory(activePageId, next);
    rememberEventName(trimmedEvent);
    if (trimmedEvent) {
      upsertDateEvent(entryDate, trimmedEvent);
    }
    setStatus({
      type: "ok",
      msg: `${entryDate} のデータを保存しました（${parsedMachines.length}台分）。`,
    });
    setPasteText("");
    const nextDate = addDays(entryDate, -1);
    setEntryDate(nextDate);
    setEntryEvent(dateEventMap[nextDate] || "");
  }

  function handleDeleteDate(date) {
    persistPageHistory(activePageId, currentHistory.filter((h) => h.date !== date));
    setConfirmDeleteDate(null);
  }

  // reload an already-saved day's data into the form so a typo can be fixed and re-saved
  function handleEditDate(h) {
    const header = "台番\t差枚\tG数\t出率\tBB\tRB\t合成\tBB率\tRB率";
    const rows = h.machines.map((m) =>
      [
        m.no,
        m.sada === null ? "" : m.sada,
        m.gsu === null ? "" : m.gsu,
        (m.shutsu === null ? "" : m.shutsu.toFixed(1)) + "%",
        m.bb === null ? "-" : m.bb,
        m.rb === null ? "-" : m.rb,
        m.gousei === null ? "-" : "1/" + m.gousei,
        m.bbRateStr || "-",
        m.rbRateStr || "-",
      ].join("\t")
    );
    setPasteText([header, ...rows].join("\n"));
    setEntryDate(h.date);
    setEntryEvent(h.event || "");
    setStatus({ type: "ok", msg: `${h.date} のデータを編集用に読み込みました。修正して保存すると上書きされます。` });
  }

  function handleResetAll() {
    persistPageHistory(activePageId, []);
    setSelectedMachines([]);
    setConfirmReset(false);
    setStatus({ type: "ok", msg: "このページのデータを削除しました。" });
  }

  function toggleMachine(no) {
    setSelectedMachines((prev) =>
      prev.includes(no) ? prev.filter((x) => x !== no) : [...prev, no].sort((a, b) => a - b)
    );
  }

  function handleAddStrongEvent() {
    const name = strongName.trim();
    if (!name) {
      setStrongStatus({ type: "error", msg: "イベント名を入力してください。" });
      return;
    }
    const next = [...strongEvents.filter((s) => s.name !== name), { name, color: strongColor }];
    persistStrongEvents(next);
    rememberEventName(name);
    setStrongStatus({
      type: "ok",
      msg: `「${name}」を強いイベントとして登録しました。このイベント名が付いた日付は、過去・今後を問わず自動で強いイベント扱いになります。`,
    });
    setStrongName("");
  }

  function handleRemoveStrongEvent(name) {
    persistStrongEvents(strongEvents.filter((s) => s.name !== name));
  }

  function handleAddClosedDay() {
    if (!closedDate) {
      setClosedStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    if (closedDays.some((c) => c.date === closedDate)) {
      setClosedStatus({ type: "error", msg: "すでに登録されています。" });
      return;
    }
    const next = [...closedDays, { date: closedDate }];
    persistClosedDays(next);
    setClosedStatus({ type: "ok", msg: `${closedDate} を店休日として登録しました。` });
    setClosedDate(addDays(closedDate, 1));
  }

  function handleRemoveClosedDay(date) {
    persistClosedDays(closedDays.filter((c) => c.date !== date));
  }

  function handleUnlock() {
    if (pinInput.trim() === UNLOCK_PIN) {
      setUnlocked(true);
      setPinInput("");
      setPinError(false);
    } else {
      setPinError(true);
    }
  }

  const viewDateMachines = useMemo(() => {
    const entry = historyByDate[viewDate];
    if (!entry) return null;
    return [...entry.machines].sort((a, b) => (b.sada ?? -Infinity) - (a.sada ?? -Infinity));
  }, [historyByDate, viewDate]);

  function renderThresholdResult(result, label) {
    if (!result) {
      return (
        <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "6px" }}>{label}：十分なデータがありません</div>
      );
    }
    const { bestAbove, bestBelow } = result;
    return (
      <div style={{ marginBottom: "8px" }}>
        <div style={{ fontSize: "11px", color: "#8b93a3", marginBottom: "2px" }}>{label}</div>
        {bestAbove ? (
          <div style={{ fontSize: "12px", color: "#c7cbd4" }}>
            総差枚が <span className="mono" style={{ color: "#e8b34c" }}>{bestAbove.threshold >= 0 ? "+" : ""}{fmtNum(Math.round(bestAbove.threshold))}枚</span> 以上 →
            翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(bestAbove.winRate * 100)}%</span>
            （{bestAbove.sampleSize}件中、平均{bestAbove.avgNext >= 0 ? "+" : ""}{fmtNum(Math.round(bestAbove.avgNext))}枚）
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "#5a6272" }}>以上パターン：データ不足</div>
        )}
        {bestBelow ? (
          <div style={{ fontSize: "12px", color: "#c7cbd4" }}>
            総差枚が <span className="mono" style={{ color: "#e8b34c" }}>{bestBelow.threshold >= 0 ? "+" : ""}{fmtNum(Math.round(bestBelow.threshold))}枚</span> 以下 →
            翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(bestBelow.winRate * 100)}%</span>
            （{bestBelow.sampleSize}件中、平均{bestBelow.avgNext >= 0 ? "+" : ""}{fmtNum(Math.round(bestBelow.avgNext))}枚）
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "#5a6272" }}>以下パターン：データ不足</div>
        )}
      </div>
    );
  }

  if (!pagesLoaded) {
    return (
      <div style={{ padding: "24px", color: "#8b93a3", fontFamily: "sans-serif", fontSize: "13px" }}>
        読み込み中...
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'Inter', 'Hiragino Sans', sans-serif",
        background: "#12161d",
        color: "#e7e9ee",
        minHeight: "100%",
        padding: "24px",
        boxSizing: "border-box",
      }}
    >
      <datalist id={DATALIST_ID}>
        {eventNames.map((n) => (
          <option value={n} key={n} />
        ))}
      </datalist>

      <style>{`
        .mono { font-family: 'JetBrains Mono', 'Menlo', monospace; font-variant-numeric: tabular-nums; }
        .card { background: #1b212b; border: 1px solid #2a323f; border-radius: 10px; }
        .chip { transition: all .15s ease; cursor: pointer; user-select: none; }
        .chip:hover { transform: translateY(-1px); }
        input[type="date"] { color-scheme: dark; }
        textarea::placeholder { color: #5a6272; }
        .scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .scrollbar::-webkit-scrollbar-thumb { background: #333c4a; border-radius: 3px; }
        .page-tab { cursor: pointer; border: 1px solid #2a323f; border-radius: 8px 8px 0 0; padding: 8px 14px; font-size: 12px; font-weight: 700; background: #1b212b; color: #8b93a3; }
        .page-tab.active { background: #12161d; color: #e8b34c; border-bottom: 1px solid #12161d; }
      `}</style>

      <div style={{ marginBottom: "14px" }}>
        <div style={{ fontSize: "12px", letterSpacing: "0.14em", color: "#e8b34c", fontWeight: 600 }}>
          SLOT HALL DATA TERMINAL
        </div>
        <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "4px 0 2px", display: "flex", alignItems: "baseline", gap: "8px" }}>
          台データ推移トラッカー
          <span className="mono" style={{ fontSize: "12px", fontWeight: 600, color: "#5a6272" }}>v{APP_VERSION}</span>
        </h1>
        <div style={{ fontSize: "13px", color: "#8b93a3" }}>
          表を貼り付けるだけで台ごとに自動集計・グラフ化します
        </div>
      </div>

      {/* page tabs */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", marginBottom: "0", flexWrap: "wrap" }}>
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={"page-tab" + (p.id === activePageId ? " active" : "")}
            onClick={() => setActivePageId(p.id)}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <span>{p.name && p.name.trim() ? p.name : `機種${i + 1}`}</span>
            {p.id === activePageId && pages.length > 1 && (
              confirmDeletePage === p.id ? (
                <span style={{ display: "flex", gap: "4px" }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeletePage(p.id); }}
                    style={{ fontSize: "10px", color: "#e5697a", background: "none", border: "none", cursor: "pointer" }}
                  >
                    削除
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeletePage(null); }}
                    style={{ fontSize: "10px", color: "#5a6272", background: "none", border: "none", cursor: "pointer" }}
                  >
                    取消
                  </button>
                </span>
              ) : (
                <Trash2
                  size={11}
                  onClick={(e) => { e.stopPropagation(); setConfirmDeletePage(p.id); }}
                  style={{ opacity: 0.5 }}
                />
              )
            )}
          </div>
        ))}
        <button
          onClick={handleAddPage}
          className="page-tab"
          style={{ display: "flex", alignItems: "center", gap: "4px", color: "#4fd1c5" }}
        >
          <Plus size={12} /> ページ追加
        </button>
      </div>

      <div style={{ borderTop: "1px solid #2a323f", marginBottom: "16px" }} />

      {/* machine model name (manual entry) for current page */}
      <div style={{ marginBottom: "18px", display: "flex", alignItems: "center", gap: "8px" }}>
        <Pencil size={14} color="#5a6272" />
        <input
          type="text"
          value={currentPage ? currentPage.name : ""}
          onChange={(e) => handleRenamePage(activePageId, e.target.value)}
          placeholder="機種名を入力（例：ジャグラーガールズ）"
          style={{
            fontSize: "16px",
            fontWeight: 700,
            background: "transparent",
            border: "none",
            borderBottom: "1px dashed #2a323f",
            color: "#e7e9ee",
            padding: "4px 2px",
            minWidth: "260px",
          }}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "360px 1fr",
          gap: "20px",
          alignItems: "start",
        }}
        className="tracker-grid"
      >
        {/* LEFT: input panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {unlocked ? (
          <>
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "12px", color: "#c7cbd4" }}>
              データ入力
            </div>

            <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: "11px", color: "#8b93a3" }}>日付</label>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => {
                    const newDate = e.target.value;
                    setEntryDate(newDate);
                    setEntryEvent(dateEventMap[newDate] || "");
                  }}
                  style={{
                    width: "100%", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f",
                    borderRadius: "6px", padding: "7px 8px", color: "#e7e9ee", fontSize: "13px", boxSizing: "border-box",
                  }}
                />
              </div>
            </div>
            {entryDateHasExisting && (
              <div style={{ fontSize: "11px", color: "#e8b34c", marginBottom: "8px", marginTop: "-4px" }}>
                この日付はすでにデータがあります。保存すると上書きされます。
              </div>
            )}
            {entryDateIsClosed && (
              <div style={{ fontSize: "11px", color: "#e5697a", marginBottom: "8px" }}>
                ⚠ この日付は店休日として登録されています。本当にデータを入力しますか？
              </div>
            )}
            {dateGapWarning && (
              <div style={{ fontSize: "11px", color: "#e5697a", marginBottom: "8px" }}>
                ⚠ 前回の記録（{dateGapWarning.lastDate}）からこの日付までに、{dateGapWarning.missing.length}日分データがありません（
                {dateGapWarning.missing.join("、")}）。店休日であれば登録しておくとこの警告は出なくなります。
              </div>
            )}

            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>イベント名（任意・過去の入力から選択できます）</label>
              <input
                type="text"
                list={DATALIST_ID}
                value={entryEvent}
                onChange={(e) => setEntryEvent(e.target.value)}
                placeholder="例：末尾7の日、増台イベント など"
                style={{
                  width: "100%", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f",
                  borderRadius: "6px", padding: "7px 8px", color: "#e7e9ee", fontSize: "13px", boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>
                表を貼り付け（台番／差枚／G数／出率／BB／RB／合成／BB率／RB率）
              </label>
              <textarea
                className="mono scrollbar"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={"台番\t差枚\tG数\t出率\tBB\tRB\t合成\tBB率\tRB率\n351\t1,581\t6,432\t108.2%\t0\t16\t1/402\t-\t1/402"}
                rows={10}
                style={{
                  width: "100%", marginTop: "4px", background: "#0e1218", border: "1px solid #2a323f",
                  borderRadius: "6px", padding: "8px", color: "#d7dae0", fontSize: "11.5px", lineHeight: 1.5,
                  resize: "vertical", boxSizing: "border-box",
                }}
              />
            </div>

            <button
              onClick={handleSave}
              style={{
                width: "100%", background: "#e8b34c", color: "#1b1508", border: "none", borderRadius: "8px",
                padding: "10px", fontWeight: 700, fontSize: "13px", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              }}
            >
              <Save size={15} />
              この日のデータを保存
            </button>

            {status && (
              <div style={{
                marginTop: "10px", fontSize: "12px", display: "flex", alignItems: "flex-start", gap: "6px",
                color: status.type === "ok" ? "#9ece6a" : "#e5697a",
              }}>
                {status.type === "ok" ? <CheckCircle2 size={14} style={{ marginTop: 1 }} /> : <AlertCircle size={14} style={{ marginTop: 1 }} />}
                <span>{status.msg}</span>
              </div>
            )}

            <div style={{ marginTop: "18px", borderTop: "1px solid #2a323f", paddingTop: "14px" }}>
              <button
                onClick={() => setDateListOpen((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: "6px", width: "100%",
                  fontSize: "12px", fontWeight: 700, color: "#c7cbd4", marginBottom: dateListOpen ? "8px" : 0,
                  background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left",
                }}
              >
                {dateListOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                登録済みの日付（{currentHistory.length}件）
              </button>
              {dateListOpen && (
              <div className="scrollbar" style={{ maxHeight: "200px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
                {historyLoading && <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>}
                {!historyLoading && sortedHistory.length === 0 && (
                  <div style={{ fontSize: "12px", color: "#5a6272" }}>まだデータがありません。</div>
                )}
                {[...sortedHistory].reverse().map((h) => (
                  <div key={h.date} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                    background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "6px 8px",
                  }}>
                    <div>
                      <span className="mono">{h.date}</span>
                      {strongDateSet.has(h.date) && (
                        <span style={{ marginLeft: "6px", color: strongColorByDate[h.date] || "#e5697a" }}>
                          <Star size={10} style={{ display: "inline", marginRight: "2px" }} fill={strongColorByDate[h.date] || "#e5697a"} />
                        </span>
                      )}
                      {h.event && (
                        <span style={{ marginLeft: "6px", color: "#e8b34c" }}>
                          <Flag size={10} style={{ display: "inline", marginRight: "2px" }} />
                          {h.event}
                        </span>
                      )}
                      <span style={{ marginLeft: "6px", color: "#5a6272" }}>{h.machines.length}台</span>
                    </div>
                    {confirmDeleteDate === h.date ? (
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button onClick={() => handleDeleteDate(h.date)} style={{ fontSize: "11px", color: "#e5697a", background: "none", border: "none", cursor: "pointer" }}>削除する</button>
                        <button onClick={() => setConfirmDeleteDate(null)} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>取消</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: "10px" }}>
                        <button onClick={() => handleEditDate(h)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }} title="この日のデータを編集">
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => setConfirmDeleteDate(h.date)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }} title="この日のデータを削除">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              )}

              {currentHistory.length > 0 && (
                <div style={{ marginTop: "10px" }}>
                  {confirmReset ? (
                    <div style={{ display: "flex", gap: "8px", fontSize: "12px" }}>
                      <span style={{ color: "#e5697a" }}>このページのデータを全て削除しますか？</span>
                      <button onClick={handleResetAll} style={{ color: "#e5697a", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>はい</button>
                      <button onClick={() => setConfirmReset(false)} style={{ color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>いいえ</button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmReset(true)} style={{ fontSize: "11px", color: "#5a6272", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
                      <RotateCcw size={11} />
                      このページのデータをリセット
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* strong event management (global, shared across all pages) */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
              <Star size={13} color="#e5697a" fill="#e5697a" />
              強いイベント（全ページ共通）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              イベント名を1度登録すれば、そのイベント名が付いた日付は過去・今後を問わず全ページのグラフに自動で表示されます（日付ごとの再登録は不要です）
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="text"
                list={DATALIST_ID}
                value={strongName}
                onChange={(e) => setStrongName(e.target.value)}
                placeholder="イベント名（例：末尾7の日）"
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", minWidth: 0,
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
              {STRONG_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setStrongColor(c)}
                  title={c}
                  style={{
                    width: "20px", height: "20px", borderRadius: "50%", background: c, cursor: "pointer",
                    border: strongColor === c ? "2px solid #e7e9ee" : "2px solid transparent",
                    boxShadow: strongColor === c ? "0 0 0 2px " + c : "none",
                  }}
                />
              ))}
            </div>
            <button
              onClick={handleAddStrongEvent}
              style={{
                width: "100%", background: strongColor, color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              強いイベントとして登録
            </button>
            {strongStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: strongStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {strongStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "160px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...strongEvents].sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
                <div key={s.name} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #2a2229", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: s.color || "#e5484d", display: "inline-block" }} />
                    <span style={{ color: "#c7cbd4" }}>{s.name}</span>
                  </span>
                  <button onClick={() => handleRemoveStrongEvent(s.name)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {strongEvents.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録された強いイベントはまだありません。</div>
              )}
            </div>
          </div>

          {/* closed days (global, shared across all pages) */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              店休日（全ページ共通）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              登録した日付は、全ページのグラフにグレーの帯「休」で表示されます
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="date"
                value={closedDate}
                onChange={(e) => setClosedDate(e.target.value)}
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <button
                onClick={handleAddClosedDay}
                style={{
                  background: "#3a4150", color: "#e7e9ee", border: "none", borderRadius: "6px",
                  padding: "0 12px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
                }}
              >
                登録
              </button>
            </div>
            {closedStatus && (
              <div style={{ marginBottom: "8px", fontSize: "11px", color: closedStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {closedStatus.msg}
              </div>
            )}
            <div className="scrollbar" style={{ maxHeight: "140px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...closedDays].sort((a, b) => b.date.localeCompare(a.date)).map((c) => (
                <div key={c.date} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span className="mono" style={{ color: "#c7cbd4" }}>{c.date}　休</span>
                  <button onClick={() => handleRemoveClosedDay(c.date)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {closedDays.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録された店休日はまだありません。</div>
              )}
            </div>
          </div>

          <button
            onClick={() => { setUnlocked(false); setPinInput(""); setPinError(false); }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              width: "100%", background: "transparent", border: "1px solid #2a323f", borderRadius: "8px",
              padding: "8px", color: "#5a6272", fontSize: "12px", cursor: "pointer",
            }}
          >
            <Lock size={12} /> データ入力をロックする
          </button>
          </>
          ) : (
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
              <Lock size={14} /> データ入力はロック中です
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              暗証番号を入力すると、データ入力・強いイベント・店休日を編集できます。この解除状態は今開いているこの画面だけのもので、他の端末や再読み込み後には引き継がれません。
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="password"
                inputMode="numeric"
                value={pinInput}
                onChange={(e) => { setPinInput(e.target.value); setPinError(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleUnlock(); }}
                placeholder="暗証番号"
                style={{
                  flex: 1, background: "#12161d", border: "1px solid " + (pinError ? "#e5697a" : "#2a323f"),
                  borderRadius: "6px", padding: "8px", color: "#e7e9ee", fontSize: "13px",
                }}
              />
              <button
                onClick={handleUnlock}
                style={{
                  background: "#e8b34c", color: "#1b1508", border: "none", borderRadius: "8px",
                  padding: "0 16px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
                }}
              >
                解除
              </button>
            </div>
            {pinError && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: "#e5697a" }}>暗証番号が違います。</div>
            )}
          </div>
          )}
        </div>

        {/* RIGHT: chart + summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "flex-end", alignItems: "center", marginBottom: "10px" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                {RANGE_OPTIONS.map((r) => (
                  <button key={r.key} onClick={() => { setRange(r.key); setUseCustomRange(false); }} className="chip" style={{
                    fontSize: "12px", padding: "6px 10px", borderRadius: "6px",
                    border: "1px solid " + (!useCustomRange && range === r.key ? "#4fd1c5" : "#2a323f"),
                    background: !useCustomRange && range === r.key ? "rgba(79,209,197,0.12)" : "transparent",
                    color: !useCustomRange && range === r.key ? "#4fd1c5" : "#c7cbd4",
                  }}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center", justifyContent: "flex-end", marginBottom: "14px" }}>
              <span style={{ fontSize: "11px", color: "#5a6272" }}>期間を指定：</span>
              <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={{
                background: "#12161d", border: "1px solid " + (useCustomRange ? "#4fd1c5" : "#2a323f"), borderRadius: "6px",
                padding: "5px 6px", color: "#e7e9ee", fontSize: "11px",
              }} />
              <span style={{ fontSize: "11px", color: "#5a6272" }}>〜</span>
              <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{
                background: "#12161d", border: "1px solid " + (useCustomRange ? "#4fd1c5" : "#2a323f"), borderRadius: "6px",
                padding: "5px 6px", color: "#e7e9ee", fontSize: "11px",
              }} />
              <button
                onClick={() => setUseCustomRange(true)}
                disabled={!customStart || !customEnd}
                style={{
                  fontSize: "11px", padding: "5px 10px", borderRadius: "6px", border: "1px solid #4fd1c5",
                  background: useCustomRange ? "rgba(79,209,197,0.12)" : "transparent", color: "#4fd1c5",
                  cursor: customStart && customEnd ? "pointer" : "not-allowed", opacity: customStart && customEnd ? 1 : 0.5,
                }}
              >
                適用
              </button>
              {useCustomRange && (
                <button onClick={() => setUseCustomRange(false)} style={{
                  fontSize: "11px", padding: "5px 10px", borderRadius: "6px", border: "1px solid #2a323f",
                  background: "transparent", color: "#8b93a3", cursor: "pointer",
                }}>
                  解除
                </button>
              )}
            </div>

            {historyLoading ? (
              <div style={{ height: "320px", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a6272", fontSize: "13px" }}>
                読み込み中...
              </div>
            ) : chartData.length === 0 ? (
              <div style={{ height: "320px", display: "flex", alignItems: "center", justifyContent: "center", color: "#5a6272", fontSize: "13px" }}>
                左のフォームからデータを保存すると、ここにグラフが表示されます。
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={chartData} margin={{ top: 6, right: 12, left: 0, bottom: 6 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232b37" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#8b93a3" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#8b93a3" }} width={56} />
                  <Tooltip
                    contentStyle={{ background: "#1b212b", border: "1px solid #2a323f", borderRadius: "8px", fontSize: "12px" }}
                    labelFormatter={(label, payload) => {
                      const ev = payload && payload[0] && payload[0].payload ? payload[0].payload.event : "";
                      return ev ? `${label}（${ev}）` : label;
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: "11px" }} />
                  {closedDatesInView.map((c) => {
                    const dateList = chartData.map((d) => d.date);
                    const band = getBandRange(dateList, c.date);
                    if (!band) return null;
                    return (
                      <ReferenceArea key={"closed-" + c.date} x1={band.x1} x2={band.x2} fill="#5a6272" fillOpacity={0.28} stroke="none"
                        label={{ value: "休", position: "insideTop", fill: "#c7cbd4", fontSize: 10 }} />
                    );
                  })}
                  {digit2DatesInView.map((d) => (
                    <ReferenceLine key={"d2-" + d} x={d} stroke={DIGIT2_COLOR} strokeDasharray="2 2" strokeOpacity={0.55}
                      label={{ value: "2", position: "top", fill: DIGIT2_COLOR, fontSize: 9 }} />
                  ))}
                  {digit7DatesInView.map((d) => (
                    <ReferenceLine key={"d7-" + d} x={d} stroke={DIGIT7_COLOR} strokeDasharray="2 2" strokeOpacity={0.55}
                      label={{ value: "7", position: "top", fill: DIGIT7_COLOR, fontSize: 9 }} />
                  ))}
                  {strongDatesInView.map((se) => (
                    <ReferenceLine key={"strong-" + se.date} x={se.date} stroke={se.color || "#e5484d"} strokeDasharray="5 3" strokeWidth={2}
                      label={{ value: se.name, position: "top", fill: se.color || "#e5697a", fontSize: 10 }} />
                  ))}
                  {eventDates.map((e) => (
                    <ReferenceLine key={"event-" + e.date} x={e.date} stroke="#e8b34c" strokeDasharray="4 3"
                      label={{ value: "★", position: "top", fill: "#e8b34c", fontSize: 11 }} />
                  ))}
                  {selectedMachines.map((no, i) => (
                    <Line key={no} type="monotone" dataKey={String(no)} name={`${no}番`}
                      stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ fontSize: "11px", color: "#5a6272", marginTop: "6px" }}>
              単位：枚　★ = 通常イベント　点線(色付き) = 強いイベント　水色点線 = 2のつく日　オレンジ点線 = 7のつく日　グレー帯 = 店休日
            </div>
          </div>

          {/* machine selector */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
                <ListChecks size={14} />
                表示する台番（{selectedMachines.length}/{allMachineNumbers.length}）
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button onClick={() => setSelectedMachines(allMachineNumbers)} style={{ fontSize: "11px", color: "#4fd1c5", background: "none", border: "none", cursor: "pointer" }}>全選択</button>
                <button onClick={() => setSelectedMachines([])} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>全解除</button>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {allMachineNumbers.length === 0 && (
                <div style={{ fontSize: "12px", color: "#5a6272" }}>データを保存すると台番がここに表示されます。</div>
              )}
              {allMachineNumbers.map((no) => {
                const active = selectedMachines.includes(no);
                const idx = selectedMachines.indexOf(no);
                const color = active ? PALETTE[idx % PALETTE.length] : "#2a323f";
                return (
                  <button key={no} onClick={() => toggleMachine(no)} className="chip mono" style={{
                    fontSize: "12px", padding: "5px 9px", borderRadius: "6px", border: "1px solid " + color,
                    background: active ? color + "22" : "transparent", color: active ? color : "#5a6272",
                  }}>
                    {no}
                  </button>
                );
              })}
            </div>
          </div>

          {/* day-detail viewer: pick one date, see every machine's 差枚 that day */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4", marginBottom: "10px" }}>
              日別データを見る
            </div>
            <input
              type="date"
              value={viewDate}
              onChange={(e) => setViewDate(e.target.value)}
              style={{
                background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "7px 8px", color: "#e7e9ee", fontSize: "13px", marginBottom: "12px",
              }}
            />
            {viewDateMachines === null ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>この日のデータはまだありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "300px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ color: "#5a6272", textAlign: "left" }}>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>差枚</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewDateMachines.map((m) => (
                      <tr key={m.no} style={{ borderTop: "1px solid #232b37" }}>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{m.no}</td>
                        <td className="mono" style={{ padding: "6px 8px", color: m.sada >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
                          {m.sada === null ? "―" : (m.sada >= 0 ? "+" : "") + fmtNum(m.sada) + "枚"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* site777-style mini chart cards, one per machine */}
          {machineSummaries.length > 0 && (
            <div className="card" style={{ padding: "18px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4", marginBottom: "12px" }}>
                台別チャート（{RANGE_OPTIONS.find((r) => r.key === range)?.label}）
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "12px" }}>
                {machineSummaries.map((s) => (
                  <div key={s.no} style={{ background: "#0e1218", border: "1px solid #232b37", borderRadius: "10px", overflow: "hidden" }}>
                    <div style={{ background: "#e7e9ee", color: "#12161d", fontWeight: 700, fontSize: "13px", textAlign: "center", padding: "4px 0" }}>
                      [{s.no}]
                    </div>
                    <div style={{ position: "relative", height: "130px" }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={s.series} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="#232b37" strokeDasharray="2 3" />
                          <YAxis hide={false} width={38} tick={{ fontSize: 9, fill: "#4a5262" }} axisLine={false} tickLine={false} />
                          <XAxis dataKey="date" hide />
                          <Tooltip contentStyle={{ background: "#1b212b", border: "1px solid #2a323f", borderRadius: "6px", fontSize: "11px" }} />
                          {s.closedInSeries.map((c) => {
                            const dateList = s.series.map((d) => d.date);
                            const band = getBandRange(dateList, c.date);
                            if (!band) return null;
                            return <ReferenceArea key={"m-closed-" + c.date} x1={band.x1} x2={band.x2} fill="#5a6272" fillOpacity={0.28} stroke="none" />;
                          })}
                          {s.digit2InSeries.map((d) => (
                            <ReferenceLine key={"m-d2-" + d} x={d} stroke={DIGIT2_COLOR} strokeDasharray="2 2" strokeOpacity={0.5} strokeWidth={1} />
                          ))}
                          {s.digit7InSeries.map((d) => (
                            <ReferenceLine key={"m-d7-" + d} x={d} stroke={DIGIT7_COLOR} strokeDasharray="2 2" strokeOpacity={0.5} strokeWidth={1} />
                          ))}
                          {s.strongInSeries.map((se) => (
                            <ReferenceLine key={"m-strong-" + se.date} x={se.date} stroke={se.color || "#e5484d"} strokeDasharray="4 2" strokeWidth={1.5} />
                          ))}
                          <Line type="monotone" dataKey="value" stroke="#3ecf8e" strokeWidth={1.75} dot={false} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                      <div className="mono" style={{
                        position: "absolute", right: "8px", bottom: "6px", fontSize: "17px", fontWeight: 800,
                        color: "#f2d24b", textShadow: "0 0 8px rgba(242,210,75,0.35)",
                      }}>
                        {s.dataCount === 0 ? "―" : (s.totalSada >= 0 ? "+" : "") + fmtNum(s.totalSada) + "枚"}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* "○のつく日" (digit day) average differential per machine */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              〇のつく日 平均差枚
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              数字を選ぶと、その数字で終わる日付（例：2 なら 2日・12日・22日）の平均差枚を台ごとに計算します（このページの全期間データが対象）
            </div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
                <button key={d} onClick={() => setLuckyDigit(d === luckyDigit ? null : d)} className="mono" style={{
                  width: "32px", height: "32px", borderRadius: "8px", cursor: "pointer",
                  border: "1px solid " + (luckyDigit === d ? "#e8b34c" : "#2a323f"),
                  background: luckyDigit === d ? "rgba(232,179,76,0.15)" : "transparent",
                  color: luckyDigit === d ? "#e8b34c" : "#c7cbd4", fontSize: "13px", fontWeight: 700,
                }}>
                  {d}
                </button>
              ))}
            </div>

            {luckyDigit === null ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>上の数字を選んでください。</div>
            ) : luckyDayStats.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>該当する日付のデータがまだありません。</div>
            ) : (
              <>
                {luckyDayOverall && (
                  <div style={{
                    background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px",
                    padding: "10px 12px", marginBottom: "12px", display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <span style={{ fontSize: "12px", color: "#8b93a3" }}>全体合計差枚の平均（{luckyDayOverall.dayCount}日分）</span>
                    <span className="mono" style={{ fontSize: "16px", fontWeight: 800, color: luckyDayOverall.avgTotal >= 0 ? "#9ece6a" : "#e5697a" }}>
                      {luckyDayOverall.avgTotal >= 0 ? "+" : ""}{fmtNum(Math.round(luckyDayOverall.avgTotal))}枚
                    </span>
                  </div>
                )}
              <div className="scrollbar" style={{ maxHeight: "260px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ color: "#5a6272", textAlign: "left" }}>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>平均差枚</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>該当日数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {luckyDayStats.map((s) => (
                      <tr key={s.no} style={{ borderTop: "1px solid #232b37" }}>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{s.no}</td>
                        <td className="mono" style={{ padding: "6px 8px", color: s.avg >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
                          {s.avg >= 0 ? "+" : ""}{Math.round(s.avg).toLocaleString()}枚
                        </td>
                        <td className="mono" style={{ padding: "6px 8px", color: "#5a6272" }}>{s.count}日</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>

          {/* pick-up: machines currently matching a historically favorable pattern */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              本日のピックアップ（10日足・20日足・30日足）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              10日足・20日足・30日足それぞれの直近総差枚を、過去データで見つかった「翌日プラスになりやすい条件」と照らし合わせ、当てはまる台をリストアップします（このページの全ての台が対象）
            </div>
            {pickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>現時点で条件に当てはまる台はありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "420px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {pickList.map((p) => (
                  <div key={p.no} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px", padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <span className="mono" style={{ fontSize: "13px", fontWeight: 700, color: "#e8b34c" }}>{p.no}番</span>
                      <span style={{ fontSize: "10px", color: "#5a6272" }}>{p.lastDate}時点</span>
                    </div>

                    <div style={{ fontSize: "11px", color: "#c7cbd4", marginBottom: "6px", padding: "6px 8px", background: "rgba(79,209,197,0.08)", borderRadius: "6px" }}>
                      総合判断：<span style={{ color: "#4fd1c5", fontWeight: 700 }}>{p.evaluableCount}期間中{p.matchedCount}期間</span>でプラス条件に該当
                      （平均勝率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(p.avgWinRate * 100)}%</span>）
                    </div>

                    {p.windows.map((w) => (
                      <div key={w.windowSize} style={{ fontSize: "11px", color: "#8b93a3", marginBottom: "3px" }}>
                        <span className="mono" style={{ color: "#c7cbd4" }}>{w.windowSize}日足</span>：
                        {!w.result ? (
                          <span>データ不足</span>
                        ) : w.result.reasons.length === 0 ? (
                          <span>
                            条件非該当（直近合計 {w.result.currentTrailing >= 0 ? "+" : ""}{fmtNum(w.result.currentTrailing)}枚）
                          </span>
                        ) : (
                          w.result.reasons.map((r, i) => (
                            <span key={i}>
                              条件該当（直近合計 {w.result.currentTrailing >= 0 ? "+" : ""}{fmtNum(w.result.currentTrailing)}枚 ／ しきい値
                              <span className="mono" style={{ color: "#c7cbd4" }}>
                                {" "}{r.threshold >= 0 ? "+" : ""}{fmtNum(Math.round(r.threshold))}枚{r.direction === "above" ? "以上" : "以下"}
                              </span>
                              ／ 過去勝率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(r.winRate * 100)}%</span>（{r.sampleSize}件中））
                            </span>
                          ))
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* trailing-window threshold analysis */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              総差枚しきい値分析（翌日プラスになりやすいライン）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              選んでいる台ごとに、直近N日間の総差枚が「いくら以上／以下」だと翌日プラスになりやすいかを、このページの全期間データから探します
            </div>
            <div style={{ display: "flex", gap: "6px", marginBottom: "12px" }}>
              {[10, 20, 30].map((w) => (
                <button key={w} onClick={() => setAnalysisWindow(w)} className="chip" style={{
                  fontSize: "12px", padding: "6px 10px", borderRadius: "6px",
                  border: "1px solid " + (analysisWindow === w ? "#4fd1c5" : "#2a323f"),
                  background: analysisWindow === w ? "rgba(79,209,197,0.12)" : "transparent",
                  color: analysisWindow === w ? "#4fd1c5" : "#c7cbd4",
                }}>
                  {w}日足
                </button>
              ))}
            </div>

            {thresholdAnalyses.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>台を選ぶと、ここに分析結果が表示されます。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "420px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "14px" }}>
                {thresholdAnalyses.map((a) => (
                  <div key={a.no} style={{ borderTop: "1px solid #232b37", paddingTop: "10px" }}>
                    <div className="mono" style={{ fontSize: "13px", fontWeight: 700, color: "#e8b34c", marginBottom: "6px" }}>
                      {a.no}番
                    </div>
                    {renderThresholdResult(a.overall, "全日")}
                    {renderThresholdResult(a.digit2, "翌日が2のつく日のみ")}
                    {renderThresholdResult(a.digit7, "翌日が7のつく日のみ")}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 860px) {
          .tracker-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
