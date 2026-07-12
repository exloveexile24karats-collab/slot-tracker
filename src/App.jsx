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
} from "lucide-react";
import { storage } from "./storage";

const PAGES_KEY = "slot-pages-v1";
const historyKey = (pageId) => `slot-history-${pageId}`;
const EVENT_NAMES_KEY = "slot-event-names-v1";
const STRONG_EVENTS_KEY = "slot-strong-events-v1";
const CLOSED_DAYS_KEY = "slot-closed-days-v1";
const DATALIST_ID = "slot-event-name-options";

const PALETTE = [
  "#e8b34c", "#4fd1c5", "#e5697a", "#7aa2f7", "#9ece6a",
  "#bb9af7", "#f6a04d", "#5fd3bc", "#e0af68", "#7dcfff",
];

const STRONG_COLORS = ["#e5484d", "#f2a541", "#4fd1c5", "#7aa2f7", "#bb9af7", "#9ece6a"];

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
  const [strongEvents, setStrongEvents] = useState([]); // [{date,name,color}]
  const [strongDate, setStrongDate] = useState(todayStr());
  const [strongName, setStrongName] = useState("");
  const [strongColor, setStrongColor] = useState(STRONG_COLORS[0]);
  const [strongStatus, setStrongStatus] = useState(null);

  // ---- closed days (global, shared across all pages) ----
  const [closedDays, setClosedDays] = useState([]); // [{date}]
  const [closedDate, setClosedDate] = useState(todayStr());
  const [closedStatus, setClosedStatus] = useState(null);

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

  // ---- backup / multi-device transfer ----
  const [exportText, setExportText] = useState("");
  const [importText, setImportText] = useState("");
  const [backupStatus, setBackupStatus] = useState(null);
  const [confirmImport, setConfirmImport] = useState(false);

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
        if (r3 && r3.value) setStrongEvents(JSON.parse(r3.value));
      } catch (e) {
        // none yet
      }
      try {
        const r4 = await storage.get(CLOSED_DAYS_KEY, false);
        if (r4 && r4.value) setClosedDays(JSON.parse(r4.value));
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
  useEffect(() => {
    setSelectedMachines([]);
    setPasteText("");
    setEntryEvent("");
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
    if (range === "all" || timelineDates.length === 0) return timelineDates;
    return timelineDates.slice(-range);
  }, [timelineDates, range]);

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

  // dates flagged as "strong" / "closed" that actually fall within the visible chart
  const strongDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return strongEvents.filter((se) => visibleDates.has(se.date));
  }, [strongEvents, visibleTimelineDates]);

  const closedDatesInView = useMemo(() => {
    const visibleDates = new Set(visibleTimelineDates);
    return closedDays.filter((c) => visibleDates.has(c.date));
  }, [closedDays, visibleTimelineDates]);

  const strongDateSet = useMemo(() => new Set(strongEvents.map((s) => s.date)), [strongEvents]);

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
      let totalSada = 0;
      let dataCount = 0;
      const series = [];
      visibleTimelineDates.forEach((date) => {
        const entry = historyByDate[date];
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        if (m && m.sada !== null) {
          totalSada += m.sada;
          dataCount += 1;
        }
        series.push({ date, value: m ? m.sada : null });
      });
      const seriesDates = new Set(series.map((s) => s.date));
      const strongInSeries = strongEvents.filter((se) => seriesDates.has(se.date));
      const closedInSeries = closedDays.filter((c) => seriesDates.has(c.date));
      return { no, totalSada, dataCount, series, strongInSeries, closedInSeries };
    });
  }, [selectedMachines, visibleTimelineDates, historyByDate, strongEvents, closedDays]);

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
    const next = [
      ...currentHistory.filter((h) => h.date !== entryDate),
      { date: entryDate, event: entryEvent.trim(), machines: parsedMachines },
    ];
    persistPageHistory(activePageId, next);
    rememberEventName(entryEvent);
    setStatus({
      type: "ok",
      msg: `${entryDate} のデータを保存しました（${parsedMachines.length}台分）。`,
    });
    setPasteText("");
    setEntryEvent("");
    setEntryDate(addDays(entryDate, 1));
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
    if (!strongDate) {
      setStrongStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    const name = strongName.trim() || "重要日";
    const next = [
      ...strongEvents.filter((s) => s.date !== strongDate),
      { date: strongDate, name, color: strongColor },
    ];
    persistStrongEvents(next);
    rememberEventName(name);
    setStrongStatus({ type: "ok", msg: `${strongDate} を強いイベントとして登録しました。` });
    setStrongName("");
    setStrongDate(addDays(strongDate, 1));
  }

  function handleRemoveStrongEvent(date) {
    persistStrongEvents(strongEvents.filter((s) => s.date !== date));
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

  async function handleExport() {
    try {
      const allHistories = {};
      for (const p of pages) {
        let hist = pageHistories[p.id];
        if (hist === undefined) {
          try {
            const res = await storage.get(historyKey(p.id), false);
            hist = res && res.value ? JSON.parse(res.value) : [];
          } catch (e) {
            hist = [];
          }
        }
        allHistories[p.id] = hist;
      }
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        pages,
        histories: allHistories,
        eventNames,
        strongEvents,
        closedDays,
      };
      setExportText(JSON.stringify(payload));
      setBackupStatus({ type: "ok", msg: "エクスポートしました。下のテキストをコピーして他の端末に貼り付けてください。" });
    } catch (e) {
      setBackupStatus({ type: "error", msg: "エクスポートに失敗しました。" });
    }
  }

  async function handleCopyExport() {
    try {
      await navigator.clipboard.writeText(exportText);
      setBackupStatus({ type: "ok", msg: "コピーしました。" });
    } catch (e) {
      setBackupStatus({ type: "error", msg: "コピーできませんでした。テキストを長押しして選択・コピーしてください。" });
    }
  }

  async function handleImport() {
    if (!importText.trim()) {
      setBackupStatus({ type: "error", msg: "貼り付けるデータがありません。" });
      return;
    }
    if (!confirmImport) {
      setConfirmImport(true);
      setBackupStatus({ type: "error", msg: "現在のデータは上書きされます。もう一度「インポート実行」を押すと確定します。" });
      return;
    }
    try {
      const payload = JSON.parse(importText);
      if (!payload || !Array.isArray(payload.pages)) throw new Error("invalid payload");

      await persistPages(payload.pages);
      const newHistories = {};
      for (const p of payload.pages) {
        const hist = (payload.histories && payload.histories[p.id]) || [];
        await storage.set(historyKey(p.id), JSON.stringify(hist), false);
        loadedHistoryRef.current.add(p.id);
        newHistories[p.id] = hist;
      }
      setPageHistories(newHistories);
      if (Array.isArray(payload.eventNames)) await persistEventNames(payload.eventNames);
      if (Array.isArray(payload.strongEvents)) await persistStrongEvents(payload.strongEvents);
      if (Array.isArray(payload.closedDays)) await persistClosedDays(payload.closedDays);
      setActivePageId(payload.pages[0] ? payload.pages[0].id : null);
      setImportText("");
      setConfirmImport(false);
      setBackupStatus({ type: "ok", msg: "インポートが完了しました。" });
    } catch (e) {
      setConfirmImport(false);
      setBackupStatus({ type: "error", msg: "データの読み込みに失敗しました。正しいバックアップデータか確認してください。" });
    }
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
        <h1 style={{ fontSize: "22px", fontWeight: 700, margin: "4px 0 2px" }}>
          台データ推移トラッカー
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
                  onChange={(e) => setEntryDate(e.target.value)}
                  style={{
                    width: "100%", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f",
                    borderRadius: "6px", padding: "7px 8px", color: "#e7e9ee", fontSize: "13px", boxSizing: "border-box",
                  }}
                />
              </div>
            </div>
            {entryDateHasExisting && (
              <div style={{ fontSize: "11px", color: "#e8b34c", marginBottom: "10px", marginTop: "-4px" }}>
                この日付はすでにデータがあります。保存すると上書きされます。
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
                        <span style={{ marginLeft: "6px", color: "#e5697a" }}>
                          <Star size={10} style={{ display: "inline", marginRight: "2px" }} fill="#e5697a" />
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
              チェックした日付は、全ページのグラフに赤い帯で表示されます
            </div>

            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="date"
                value={strongDate}
                onChange={(e) => setStrongDate(e.target.value)}
                style={{
                  flex: "0 0 130px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <input
                type="text"
                list={DATALIST_ID}
                value={strongName}
                onChange={(e) => setStrongName(e.target.value)}
                placeholder="イベント名（任意）"
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
              {[...strongEvents].sort((a, b) => b.date.localeCompare(a.date)).map((s) => (
                <div key={s.date} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #2a2229", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: s.color || "#e5484d", display: "inline-block" }} />
                    <span className="mono" style={{ color: s.color || "#e5697a" }}>{s.date}</span>
                    <span style={{ color: "#c7cbd4" }}>{s.name}</span>
                  </span>
                  <button onClick={() => handleRemoveStrongEvent(s.date)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
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

          {/* backup / multi-device transfer */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              データのバックアップ（他の端末に移す）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              全ページ分のデータをテキストとして書き出し、別の端末でこの画面に貼り付ければ同じデータを見られます
            </div>

            <button
              onClick={handleExport}
              style={{
                width: "100%", background: "#3a4150", color: "#e7e9ee", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer", marginBottom: "8px",
              }}
            >
              エクスポート（書き出す）
            </button>
            {exportText && (
              <>
                <textarea
                  readOnly
                  value={exportText}
                  onFocus={(e) => e.target.select()}
                  rows={4}
                  className="mono scrollbar"
                  style={{
                    width: "100%", background: "#0e1218", border: "1px solid #2a323f", borderRadius: "6px",
                    padding: "8px", color: "#8b93a3", fontSize: "10px", boxSizing: "border-box", marginBottom: "6px",
                  }}
                />
                <button
                  onClick={handleCopyExport}
                  style={{
                    width: "100%", background: "transparent", color: "#4fd1c5", border: "1px solid #2a323f", borderRadius: "8px",
                    padding: "7px", fontWeight: 700, fontSize: "12px", cursor: "pointer", marginBottom: "6px",
                  }}
                >
                  コピー
                </button>
              </>
            )}

            <div style={{ borderTop: "1px solid #2a323f", marginTop: "10px", paddingTop: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>他の端末で書き出したデータを貼り付け</label>
              <textarea
                value={importText}
                onChange={(e) => { setImportText(e.target.value); setConfirmImport(false); }}
                rows={4}
                className="mono scrollbar"
                placeholder="ここにエクスポートしたテキストを貼り付け"
                style={{
                  width: "100%", marginTop: "4px", background: "#0e1218", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "8px", color: "#d7dae0", fontSize: "10px", boxSizing: "border-box", marginBottom: "6px",
                }}
              />
              <button
                onClick={handleImport}
                style={{
                  width: "100%", background: confirmImport ? "#e5697a" : "#3a4150", color: confirmImport ? "#2b0d12" : "#e7e9ee",
                  border: "none", borderRadius: "8px", padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
                }}
              >
                {confirmImport ? "インポート実行（現在のデータを上書き）" : "インポート"}
              </button>
            </div>

            {backupStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: backupStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {backupStatus.msg}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: chart + summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", justifyContent: "flex-end", alignItems: "center", marginBottom: "14px" }}>
              <div style={{ display: "flex", gap: "6px" }}>
                {RANGE_OPTIONS.map((r) => (
                  <button key={r.key} onClick={() => setRange(r.key)} className="chip" style={{
                    fontSize: "12px", padding: "6px 10px", borderRadius: "6px",
                    border: "1px solid " + (range === r.key ? "#4fd1c5" : "#2a323f"),
                    background: range === r.key ? "rgba(79,209,197,0.12)" : "transparent",
                    color: range === r.key ? "#4fd1c5" : "#c7cbd4",
                  }}>
                    {r.label}
                  </button>
                ))}
              </div>
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
                  <defs>
                    {strongDatesInView.map((se) => (
                      <pattern key={"pat-" + se.date} id={"strongHatch-" + se.date} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                        <rect width="6" height="6" fill="transparent" />
                        <line x1="0" y1="0" x2="0" y2="6" stroke={se.color || "#e5484d"} strokeWidth="2" />
                      </pattern>
                    ))}
                  </defs>
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
                  {strongDatesInView.map((se) => {
                    const dateList = chartData.map((d) => d.date);
                    const band = getBandRange(dateList, se.date);
                    if (!band) return null;
                    return (
                      <React.Fragment key={"strong-" + se.date}>
                        <ReferenceArea x1={band.x1} x2={band.x2} fill={"url(#strongHatch-" + se.date + ")"} stroke="none" />
                        <ReferenceLine x={se.date} stroke={se.color || "#e5484d"} strokeWidth={2}
                          label={{ value: se.name, position: "top", fill: se.color || "#e5697a", fontSize: 10 }} />
                      </React.Fragment>
                    );
                  })}
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
              単位：枚　★ = 通常イベント　斜線帯 = 強いイベント　グレー帯 = 店休日
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
                          <defs>
                            {s.strongInSeries.map((se) => (
                              <pattern key={"pm-" + se.date} id={"strongHatchMini-" + s.no + "-" + se.date} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
                                <rect width="5" height="5" fill="transparent" />
                                <line x1="0" y1="0" x2="0" y2="5" stroke={se.color || "#e5484d"} strokeWidth="1.5" />
                              </pattern>
                            ))}
                          </defs>
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
                          {s.strongInSeries.map((se) => {
                            const dateList = s.series.map((d) => d.date);
                            const band = getBandRange(dateList, se.date);
                            if (!band) return null;
                            return (
                              <React.Fragment key={"m-strong-" + se.date}>
                                <ReferenceArea x1={band.x1} x2={band.x2} fill={"url(#strongHatchMini-" + s.no + "-" + se.date + ")"} stroke="none" />
                                <ReferenceLine x={se.date} stroke={se.color || "#e5484d"} strokeWidth={1.5} />
                              </React.Fragment>
                            );
                          })}
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
