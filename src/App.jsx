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
const recommendKey = (pageId) => `slot-recommend-${pageId}`;
const EVENT_NAMES_KEY = "slot-event-names-v1";
const STRONG_EVENTS_KEY = "slot-strong-events-v1";
const CLOSED_DAYS_KEY = "slot-closed-days-v1";
const DATE_EVENT_MAP_KEY = "slot-date-event-map-v1";

// a single date can now have MULTIPLE event tags (e.g. "2のつく日" AND "新台
//入れ替え" on the same day) — stored as one delimited string so every
// existing piece of code that treats dateEventMap[date] / h.event as a plain
// string (display, propagation to page histories, etc.) keeps working as-is
const EVENT_DELIMITER = "、";
function splitEventNames(compositeStr) {
  return (compositeStr || "")
    .split(EVENT_DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean);
}
function joinEventNames(names) {
  return names.filter(Boolean).join(EVENT_DELIMITER);
}
const OVERALL_SUMMARY_KEY = "slot-overall-summary-v1";
const UNDO_HISTORY_KEY = "slot-undo-history-v1";
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
const APP_VERSION = "4.5";

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
// some sources render negative numbers with a different Unicode character
// than a plain ASCII hyphen (e.g. U+2212 MINUS SIGN, U+FF0D FULLWIDTH
// HYPHEN-MINUS) — parseInt/parseFloat don't recognize those, so normalize first
function toAsciiMinus(text) {
  return String(text).replace(/[\u2212\uFF0D\u2010\u2011\u2013\u2014]/g, "-");
}

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

    const sada = parseInt(toAsciiMinus(sadaStr).replace(/,/g, ""), 10);
    const gsu = parseInt(toAsciiMinus(gsuStr).replace(/,/g, ""), 10);
    const shutsu = parseFloat(String(shutsuStr).replace("%", ""));
    const bb = bbStr === "-" || bbStr === undefined ? null : parseInt(toAsciiMinus(bbStr), 10);
    const rb = rbStr === "-" || rbStr === undefined ? null : parseInt(toAsciiMinus(rbStr), 10);
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

// parse a store-wide summary table: 機種名(or 末尾)\t平均差枚\t平均G数\t勝率(x/y)\t出率
// handles "-" as null, and labels that wrap onto their own line (e.g. "ゾロ目"
// then "(下二桁)\t231\t...") by carrying the orphan text forward as a prefix
function parseSummaryTable(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows = [];
  let pendingLabel = "";
  for (const line of lines) {
    if (line.includes("機種") && line.includes("平均差枚")) continue; // header
    if (line.includes("末尾") && line.includes("平均差枚")) continue; // digit-table header
    if (line === "末尾別データ") continue; // section title

    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 5) {
      pendingLabel += line;
      continue;
    }
    const name = (pendingLabel + cols[0]).trim();
    pendingLabel = "";
    const col1 = toAsciiMinus(cols[1]);
    // min-repo shows a bare "-" for 平均差枚 specifically when the average
    // was NEGATIVE (not when data is missing) — so treat it as "a loss of
    // unknown size" rather than silently dropping the day from the series.
    // Using a near-zero negative sentinel correctly counts it as a losing
    // day for win-rate/streak purposes without meaningfully distorting
    // magnitude-based averages (since we have no real number to use).
    const avgSada = col1 === "" ? null : col1 === "-" ? -0.01 : parseInt(col1.replace(/,/g, ""), 10);
    const avgGsu = cols[2] === "-" || cols[2] === "" ? null : parseInt(cols[2].replace(/,/g, ""), 10);
    const winMatch = cols[3] ? cols[3].match(/(\d+)\s*\/\s*(\d+)/) : null;
    const wins = winMatch ? parseInt(winMatch[1], 10) : null;
    const total = winMatch ? parseInt(winMatch[2], 10) : null;
    const shutsu = cols[4] === "-" ? 99.9 : cols[4] === "" ? null : parseFloat(cols[4].replace("%", ""));
    if (!name) continue;
    rows.push({
      name,
      avgSada: Number.isNaN(avgSada) ? null : avgSada,
      avgGsu: Number.isNaN(avgGsu) ? null : avgGsu,
      wins,
      total,
      shutsu: Number.isNaN(shutsu) ? null : shutsu,
    });
  }
  return rows;
}

// splits a combined paste (機種別サマリー + 末尾別データ) at the "末尾別データ" divider
function parseOverallSummary(text) {
  const idx = text.indexOf("末尾別データ");
  const modelText = idx === -1 ? text : text.slice(0, idx);
  const digitText = idx === -1 ? "" : text.slice(idx);
  return { modelRows: parseSummaryTable(modelText), digitRows: parseSummaryTable(digitText) };
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
function findBestThresholds(pairs, minSample = 5, baseRate = 0.5) {
  if (pairs.length < minSample) return null;
  const thresholds = Array.from(new Set(pairs.map((p) => p.trailingSum))).sort((a, b) => a - b);

  let bestAbove = null;
  let bestBelow = null;
  thresholds.forEach((T) => {
    const above = pairs.filter((p) => p.trailingSum >= T);
    if (above.length >= minSample) {
      const wins = above.filter((p) => p.nextSada > 0).length;
      const winRate = wins / above.length;
      const avgNext = above.reduce((a, p) => a + p.nextSada, 0) / above.length;
      // only accept as "favorable" if it beats this machine's OWN overall
      // base rate — not a fixed 50%, since a machine's unconditional odds
      // of a positive day may themselves sit above or below half
      if (winRate > baseRate && (!bestAbove || winRate > bestAbove.winRate || (winRate === bestAbove.winRate && above.length > bestAbove.sampleSize))) {
        bestAbove = { threshold: T, winRate, sampleSize: above.length, avgNext };
      }
    }
    const below = pairs.filter((p) => p.trailingSum <= T);
    if (below.length >= minSample) {
      const wins = below.filter((p) => p.nextSada > 0).length;
      const winRate = wins / below.length;
      const avgNext = below.reduce((a, p) => a + p.nextSada, 0) / below.length;
      if (winRate > baseRate && (!bestBelow || winRate > bestBelow.winRate || (winRate === bestBelow.winRate && below.length > bestBelow.sampleSize))) {
        bestBelow = { threshold: T, winRate, sampleSize: below.length, avgNext };
      }
    }
  });

  return { totalPairs: pairs.length, bestAbove, bestBelow };
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function weekdayOf(dateStr) {
  return new Date(dateStr + "T00:00:00").getDay();
}

// this machine's own unconditional odds of a positive day — the correct
// baseline to compare conditional patterns against (not a fixed 50%)
function computeBaseRate(series) {
  if (series.length === 0) return 0.5;
  const wins = series.filter((s) => s.sada > 0).length;
  return wins / series.length;
}

// rough letter-grade banding for the overall score, for at-a-glance ranking.
// these cutoffs are just for readability, not a statistically rigorous scale.
const GRADE_BANDS = [
  { min: 0.8, grade: "S" },
  { min: 0.7, grade: "A" },
  { min: 0.62, grade: "B" },
  { min: 0.56, grade: "C" },
  { min: 0.52, grade: "D" },
  { min: 0.48, grade: "E" },
  { min: 0.42, grade: "F" },
  { min: -Infinity, grade: "G" },
];
function scoreToGrade(score) {
  if (score === null || score === undefined) return null;
  return GRADE_BANDS.find((b) => score >= b.min).grade;
}

// point-based grading for the new additive/subtractive scoring system: each
// signal contributes (its winRate - its own baseline) in percentage points,
// discounted by sample-size confidence, and all signals (pro AND caution)
// are summed together — so a total can go negative.
const POINT_GRADE_BANDS = [
  { min: 35, grade: "S" },
  { min: 20, grade: "A" },
  { min: 10, grade: "B" },
  { min: 3, grade: "C" },
  { min: -3, grade: "D" },
  { min: -10, grade: "E" },
  { min: -20, grade: "F" },
  { min: -Infinity, grade: "G" },
];
function pointsToGrade(points) {
  if (points === null || points === undefined) return null;
  return POINT_GRADE_BANDS.find((b) => points >= b.min).grade;
}

// how much weight to give one signal's diff, based on how many historical
// samples it's built on — a 5-sample "100%" streak shouldn't count nearly as
// much as a 30-sample 60% edge. sqrt curve: 5 samples ≈ half weight, 20+ ≈ full.
function sampleWeight(sampleSize) {
  if (!sampleSize || sampleSize <= 0) return 0;
  return Math.min(1, Math.sqrt(sampleSize / 20));
}

// core building block for the new scoring system: (winRate - baseline) in
// percentage points, scaled down when the sample size is small
function computePoints(winRate, baseline, sampleSize) {
  if (winRate === null || winRate === undefined || baseline === null || baseline === undefined) return 0;
  return (winRate - baseline) * 100 * sampleWeight(sampleSize);
}

// expected-value component: how much better/worse is the AVERAGE payout
// under this signal, compared to the machine's own typical day? expressed
// relative to the machine's own typical daily swing so it's comparable
// across machines with very different scales, then capped so one huge
// outlier day can't dominate the score
function computeEvPoints(signalAvg, baselineAvg, typicalMagnitude, sampleSize) {
  if (signalAvg === null || signalAvg === undefined || !typicalMagnitude) return 0;
  const diff = signalAvg - (baselineAvg || 0);
  const normalized = diff / typicalMagnitude;
  const capped = Math.max(-1, Math.min(1, normalized));
  return capped * 15 * sampleWeight(sampleSize);
}

// per-signal weight multipliers, calibrated from a walk-forward backtest on
// real hall data (see conversation history) — signals that turned out to
// have little/no real predictive edge are dialed down rather than removed
// outright, in case future data tells a different story
const SIGNAL_WEIGHTS = {
  streak: 0.3, // 連続日数 — backtested near/below baseline
  weekday: 0.3, // 曜日傾向 — backtested near baseline
  strongFollow: 1,
  plannedEvent: 1.5, // イベント登録連動 — backtested clearly above baseline
  recommend: 1,
  settingGood: 1.5, // 相対ローテーション（設定良さそう）— backtested clearly above baseline
  settingLow: 1,
  volumeMismatch: 0.3, // 大量回転・低調 — backtested ~no edge
  digitDay: 1, // any 日付末尾, generalized (not just 2/7) — backtested strong for "2", strong AGAINST for "0"
  interEventTrend: 0.7, // new: modest but consistent edge in backtest
};

// consecutive same-sign run lengths, day by day, for a {date,sada} series
function computeStreaks(series) {
  const streaks = [];
  series.forEach((pt, i) => {
    const dir = pt.sada > 0 ? "plus" : pt.sada < 0 ? "minus" : "flat";
    if (i === 0 || streaks[i - 1].dir !== dir) {
      streaks.push({ dir, len: 1 });
    } else {
      streaks.push({ dir, len: streaks[i - 1].len + 1 });
    }
  });
  return streaks;
}

// does a long enough plus/minus streak predict next-day-positive (relative
// to this machine's own base rate)?
function evaluateStreakPattern(series, baseRate = 0.5) {
  const streaks = computeStreaks(series);
  const pairs = [];
  for (let i = 0; i < series.length - 1; i++) {
    pairs.push({ dir: streaks[i].dir, len: streaks[i].len, nextSada: series[i + 1].sada });
  }
  function bestForDir(dir) {
    const subset = pairs.filter((p) => p.dir === dir);
    if (subset.length < 8) return null;
    const lens = Array.from(new Set(subset.map((p) => p.len))).sort((a, b) => a - b);
    let best = null;
    lens.forEach((L) => {
      const matched = subset.filter((p) => p.len >= L);
      if (matched.length < 5) return;
      const wins = matched.filter((p) => p.nextSada > 0).length;
      const winRate = wins / matched.length;
      if (winRate > baseRate && (!best || winRate > best.winRate || (winRate === best.winRate && matched.length > best.sampleSize))) {
        best = { minLen: L, winRate, sampleSize: matched.length, avgNext: matched.reduce((a, p) => a + p.nextSada, 0) / matched.length };
      }
    });
    return best;
  }
  // stat for EXACTLY this streak length (not "N or more"), which is what
  // actually applies to the day right after the current streak — only
  // returned if it actually beats this machine's base rate
  function exactForDir(dir, length) {
    const subset = pairs.filter((p) => p.dir === dir && p.len === length);
    if (subset.length < 4) return null;
    const wins = subset.filter((p) => p.nextSada > 0).length;
    const winRate = wins / subset.length;
    if (winRate <= baseRate) return null;
    return {
      len: length,
      winRate,
      sampleSize: subset.length,
      avgNext: subset.reduce((a, p) => a + p.nextSada, 0) / subset.length,
    };
  }
  // ungated variant: returns the stat for this exact streak length regardless
  // of whether it beats base rate — needed for the additive/subtractive
  // scoring system, which wants the SIGNED difference, not just "does it win"
  function exactForDirRaw(dir, length) {
    const subset = pairs.filter((p) => p.dir === dir && p.len === length);
    if (subset.length < 4) return null;
    const wins = subset.filter((p) => p.nextSada > 0).length;
    const winRate = wins / subset.length;
    return {
      len: length,
      winRate,
      sampleSize: subset.length,
      avgNext: subset.reduce((a, p) => a + p.nextSada, 0) / subset.length,
    };
  }
  return { plus: bestForDir("plus"), minus: bestForDir("minus"), currentStreak: streaks[streaks.length - 1] || null, exactForDir, exactForDirRaw };
}

// per-weekday average 差枚 for a {date,sada} series
function computeWeekdayStats(series) {
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0, wins: 0 }));
  series.forEach((pt) => {
    const wd = weekdayOf(pt.date);
    buckets[wd].sum += pt.sada;
    buckets[wd].count += 1;
    if (pt.sada > 0) buckets[wd].wins += 1;
  });
  return buckets.map((b) => ({
    avg: b.count ? b.sum / b.count : null,
    count: b.count,
    winRate: b.count ? b.wins / b.count : null,
  }));
}

function pearsonCorrelation(xs, ys) {
  const n = xs.length;
  if (n < 8) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

// does the day AFTER a registered strong-event day tend to be better than usual?
function evaluateStrongFollow(series, strongDateSet) {
  const pairs = [];
  for (let i = 0; i < series.length - 1; i++) {
    pairs.push({ isStrong: strongDateSet.has(series[i].date), nextSada: series[i + 1].sada });
  }
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((p) => p.nextSada > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avgNext: arr.reduce((a, p) => a + p.nextSada, 0) / arr.length };
  }
  return { strong: summarize(pairs.filter((p) => p.isStrong)), normal: summarize(pairs.filter((p) => !p.isStrong)) };
}

// does the 差枚 trend BETWEEN the last registered event and today predict
// whether an UPCOMING event day (tomorrow) will itself be a good day? this
// only returns a result when tomorrow is actually a registered event —
// otherwise there's nothing to predict
function evaluateInterEventTrend(seriesFullWithEvent, isTomorrowEvent) {
  if (!isTomorrowEvent) return null;
  const eventIdx = [];
  seriesFullWithEvent.forEach((s, i) => {
    if (s.event && s.event.trim()) eventIdx.push(i);
  });
  if (eventIdx.length < 2) return null;

  // historical calibration: for every past pair of consecutive event days,
  // bucket the LATER event day's own result by whether the days strictly
  // between them trended up or down
  const upOutcomes = [];
  const downOutcomes = [];
  for (let k = 1; k < eventIdx.length; k++) {
    const i1 = eventIdx[k - 1];
    const i2 = eventIdx[k];
    if (i2 - i1 < 2) continue; // no gap days between them
    const between = seriesFullWithEvent.slice(i1 + 1, i2);
    if (between.length === 0) continue;
    const betweenSum = between.reduce((a, s) => a + s.sada, 0);
    (betweenSum > 0 ? upOutcomes : downOutcomes).push(seriesFullWithEvent[i2].sada);
  }

  // current trend: from the most recent past event through today (inclusive)
  const lastEventIdx = eventIdx[eventIdx.length - 1];
  const todayIdx = seriesFullWithEvent.length - 1;
  if (todayIdx - lastEventIdx < 1) return null; // today itself IS that last event; no gap to measure yet
  const currentBetween = seriesFullWithEvent.slice(lastEventIdx + 1, todayIdx + 1);
  if (currentBetween.length === 0) return null;
  const currentSum = currentBetween.reduce((a, s) => a + s.sada, 0);
  const isUp = currentSum > 0;

  const relevant = isUp ? upOutcomes : downOutcomes;
  if (relevant.length < 5) return null;
  const wins = relevant.filter((v) => v > 0).length;
  return {
    direction: isUp ? "上昇" : "下降",
    winRate: wins / relevant.length,
    avg: relevant.reduce((a, v) => a + v, 0) / relevant.length,
    sampleSize: relevant.length,
  };
}

// how has this machine historically done the day AFTER any occurrence of a
// specific named event (not limited to the curated "strong" list)?
function evaluateEventNamePerformance(series, historyByDate, eventName) {
  const pairs = [];
  for (let i = 0; i < series.length - 1; i++) {
    const entry = historyByDate[series[i].date];
    if (entry && entry.event && splitEventNames(entry.event).includes(eventName)) {
      pairs.push({ nextSada: series[i + 1].sada });
    }
  }
  if (pairs.length < 3) return null;
  const wins = pairs.filter((p) => p.nextSada > 0).length;
  return { sampleSize: pairs.length, winRate: wins / pairs.length, avgNext: pairs.reduce((a, p) => a + p.nextSada, 0) / pairs.length };
}

// every calendar date from start to end, inclusive (used for recommend periods)
function enumerateDateRange(start, end) {
  const dates = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < 400) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

// how has this machine performed ON days that fall inside a given date set
// (e.g. a hall-declared "recommended" period), vs its usual base rate?
function evaluateMembershipPerformance(series, dateSet) {
  const memberDays = series.filter((s) => dateSet.has(s.date));
  if (memberDays.length < 3) return null;
  const wins = memberDays.filter((s) => s.sada > 0).length;
  return {
    sampleSize: memberDays.length,
    winRate: wins / memberDays.length,
    avg: memberDays.reduce((a, s) => a + s.sada, 0) / memberDays.length,
  };
}

// heavy play (high G数) without a proportional payout — a caution flag, not a "buy" signal
function evaluateVolumeMismatch(seriesWithGsu) {
  const gsuVals = seriesWithGsu.map((s) => s.gsu).filter((v) => v !== null && v !== undefined);
  if (gsuVals.length < 5) return null;
  const avgGsu = gsuVals.reduce((a, b) => a + b, 0) / gsuVals.length;

  function isMismatch(pt) {
    return pt.gsu !== null && pt.gsu !== undefined && pt.gsu >= avgGsu * 1.15 && pt.sada !== null && pt.sada <= 0;
  }

  const last = seriesWithGsu[seriesWithGsu.length - 1];
  if (!isMismatch(last)) return null;

  // past occurrences of this same pattern (never includes "last" itself,
  // since we're looking at what happened AFTER earlier instances)
  const nextDayVals = [];
  const twoDayVals = [];
  for (let i = 0; i < seriesWithGsu.length - 1; i++) {
    if (!isMismatch(seriesWithGsu[i])) continue;
    if (seriesWithGsu[i + 1].sada !== null) nextDayVals.push(seriesWithGsu[i + 1].sada);
    if (i + 2 < seriesWithGsu.length && seriesWithGsu[i + 2].sada !== null) twoDayVals.push(seriesWithGsu[i + 2].sada);
  }
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((v) => v > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avg: arr.reduce((a, b) => a + b, 0) / arr.length };
  }

  return {
    lastDate: last.date,
    lastGsu: last.gsu,
    avgGsu,
    lastSada: last.sada,
    nextDayStats: summarize(nextDayVals),
    twoDayStats: summarize(twoDayVals),
  };
}

// per-day, per-machine "suspected setting" flag based on how this machine's
// G数 ranks against every OTHER machine on the same page that same day (not
// against its own historical average) — this way, hall-wide rotation being
// boosted on event days doesn't get mistaken for one machine being popular.
// 'good': played a lot relative to peers, and didn't lose much (people kept feeding it)
// 'low': played little relative to peers despite being ahead (people gave up early)
function computeDailySettingFlags(pageSortedHistory) {
  const perDateFlags = {};
  pageSortedHistory.forEach((h) => {
    const gsuVals = h.machines.map((m) => m.gsu).filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    const dayFlags = {};
    if (gsuVals.length >= 5) {
      const pctOf = (v) => {
        if (v === null || v === undefined) return null;
        let count = 0;
        for (const x of gsuVals) if (x <= v) count += 1;
        return count / gsuVals.length;
      };
      h.machines.forEach((m) => {
        const pct = pctOf(m.gsu);
        if (pct === null || m.sada === null) {
          dayFlags[m.no] = null;
        } else if (pct >= 0.75 && m.sada >= -1000) {
          dayFlags[m.no] = "good";
        } else if (pct <= 0.25 && m.sada > 0) {
          dayFlags[m.no] = "low";
        } else {
          dayFlags[m.no] = null;
        }
      });
    }
    perDateFlags[h.date] = dayFlags;
  });
  return perDateFlags;
}

// does yesterday's "suspected good/low setting" flag predict today's result?
function evaluateSuspectedSettingFollow(seriesFull, flagByDate) {
  const goodVals = [];
  const lowVals = [];
  for (let i = 0; i < seriesFull.length - 1; i++) {
    const flag = flagByDate.get(seriesFull[i].date);
    const next = seriesFull[i + 1].sada;
    if (next === null || next === undefined) continue;
    if (flag === "good") goodVals.push(next);
    if (flag === "low") lowVals.push(next);
  }
  function summarize(arr) {
    if (arr.length < 3) return null;
    const wins = arr.filter((v) => v > 0).length;
    return { sampleSize: arr.length, winRate: wins / arr.length, avg: arr.reduce((a, b) => a + b, 0) / arr.length };
  }
  return { good: summarize(goodVals), low: summarize(lowVals) };
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

  // ---- top-level tab: a normal 機種 page, or the shared "共通設定" tab ----
  const [viewMode, setViewMode] = useState("page"); // "page" | "common"

  // ---- recommended-model periods (page-scoped, since a page = one 機種) ----
  // managed from the 共通設定 tab via a dropdown, so pages don't need their
  // own copy of this UI — but the data itself still lives per page
  const [pageRecommends, setPageRecommends] = useState({});
  const loadedRecommendRef = useRef(new Set());
  const [recommendTargetPageId, setRecommendTargetPageId] = useState(null);
  const [recommendStart, setRecommendStart] = useState(todayStr());
  const [recommendEnd, setRecommendEnd] = useState(todayStr());
  const [recommendLabel, setRecommendLabel] = useState("");
  const [recommendStatus, setRecommendStatus] = useState(null);

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

  // ---- future events (pre-register a date's event before that day's data exists) ----
  const [futureEventDate, setFutureEventDate] = useState(addDays(todayStr(), 1));
  const [futureEventName, setFutureEventName] = useState("");
  const [futureEventStatus, setFutureEventStatus] = useState(null);

  // ---- store-wide overall summary (機種別サマリー + 末尾別データ), global,
  //      irregular entries, one snapshot per date ----
  const [overallSummaries, setOverallSummaries] = useState([]); // [{date,event,modelRows,digitRows}]
  const [overallSummariesLoaded, setOverallSummariesLoaded] = useState(false);
  const [overallDate, setOverallDate] = useState(todayStr());
  const [overallPasteText, setOverallPasteText] = useState("");
  const [overallStatus, setOverallStatus] = useState(null);
  const [confirmDeleteOverall, setConfirmDeleteOverall] = useState(null);
  const [confirmDeleteAllOverall, setConfirmDeleteAllOverall] = useState(false);

  // ---- undo history: snapshots taken right before a destructive action,
  //      so any reset/delete can be reversed with one click. shown as a
  //      fixed panel regardless of which tab/page is currently open ----
  const [undoHistory, setUndoHistory] = useState([]);
  const [undoHistoryLoaded, setUndoHistoryLoaded] = useState(false);
  const [undoPanelOpen, setUndoPanelOpen] = useState(false);

  // ---- per-page form / view state ----
  const [pasteText, setPasteText] = useState("");
  const [entryDate, setEntryDate] = useState(todayStr());
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
  const [viewWindow, setViewWindow] = useState(7);

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
        if (r5 && r5.value) setDateEventMap(JSON.parse(r5.value));
      } catch (e) {
        // none yet
      }
      try {
        const r6 = await storage.get(OVERALL_SUMMARY_KEY, false);
        if (r6 && r6.value) {
          const val = JSON.parse(r6.value);
          if (Array.isArray(val)) setOverallSummaries(val);
        }
      } catch (e) {
        // none yet
      } finally {
        setOverallSummariesLoaded(true);
      }
      try {
        const r7 = await storage.get(UNDO_HISTORY_KEY, false);
        if (r7 && r7.value) {
          const val = JSON.parse(r7.value);
          if (Array.isArray(val)) setUndoHistory(val);
        }
      } catch (e) {
        // none yet
      } finally {
        setUndoHistoryLoaded(true);
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

  // ---- also eagerly load every OTHER page's history in the background, so
  //      the hall-wide combined ranking works even for tabs you haven't
  //      visited yet this session ----
  useEffect(() => {
    pages.forEach((p) => {
      if (loadedHistoryRef.current.has(p.id)) return;
      loadedHistoryRef.current.add(p.id);
      (async () => {
        try {
          const res = await storage.get(historyKey(p.id), false);
          const val = res && res.value ? JSON.parse(res.value) : [];
          setPageHistories((prev) => ({ ...prev, [p.id]: Array.isArray(val) ? val : [] }));
        } catch (e) {
          setPageHistories((prev) => ({ ...prev, [p.id]: [] }));
        }
      })();
    });
  }, [pages]);

  // ---- lazy-load recommended-model periods for every page, so the shared
  //      共通設定 tab's machine dropdown works regardless of which 機種 tab
  //      is currently active ----
  useEffect(() => {
    pages.forEach((p) => {
      if (loadedRecommendRef.current.has(p.id)) return;
      loadedRecommendRef.current.add(p.id);
      (async () => {
        try {
          const res = await storage.get(recommendKey(p.id), false);
          const val = res && res.value ? JSON.parse(res.value) : [];
          setPageRecommends((prev) => ({ ...prev, [p.id]: Array.isArray(val) ? val : [] }));
        } catch (e) {
          setPageRecommends((prev) => ({ ...prev, [p.id]: [] }));
        }
      })();
    });
    if (!recommendTargetPageId && pages.length > 0) {
      setRecommendTargetPageId(pages[0].id);
    }
  }, [pages, recommendTargetPageId]);

  // ---- reset ephemeral per-page UI state when switching pages ----
  // note: event text is no longer part of this per-page form state at all —
  // it's pulled live from the shared dateEventMap registry at save time.
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

  const persistPageRecommends = useCallback(async (pageId, next) => {
    setPageRecommends((prev) => ({ ...prev, [pageId]: next }));
    try {
      await storage.set(recommendKey(pageId), JSON.stringify(next), false);
    } catch (e) {
      // ignore
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

  const persistOverallSummaries = useCallback(async (next) => {
    setOverallSummaries(next);
    try {
      await storage.set(OVERALL_SUMMARY_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  // ---- undo history: call this with the CURRENT (about-to-be-overwritten)
  //      value right before any destructive write, so it can be restored
  //      with one click later. Shown in a fixed panel regardless of tab. ----
  const persistUndoHistory = useCallback(async (next) => {
    setUndoHistory(next);
    try {
      await storage.set(UNDO_HISTORY_KEY, JSON.stringify(next), false);
    } catch (e) {
      // ignore
    }
  }, []);

  function pushUndoEntry(label, storageKey, previousValue) {
    const entry = { id: `undo-${Date.now()}`, timestamp: Date.now(), label, storageKey, previousValue };
    const next = [entry, ...undoHistory].slice(0, 10);
    persistUndoHistory(next);
  }

  // maps a storage key back to the React state setter that mirrors it, so a
  // restored value shows up immediately without needing a page reload
  function applyRestoredValue(storageKey, value) {
    if (storageKey === PAGES_KEY) {
      setPages(value || []);
    } else if (storageKey === OVERALL_SUMMARY_KEY) {
      setOverallSummaries(value || []);
    } else if (storageKey === CLOSED_DAYS_KEY) {
      setClosedDays(value || []);
    } else if (storageKey === STRONG_EVENTS_KEY) {
      setStrongEvents(value || []);
    } else if (storageKey === DATE_EVENT_MAP_KEY) {
      setDateEventMap(value || {});
    } else if (storageKey.startsWith("slot-history-")) {
      const pageId = storageKey.slice("slot-history-".length);
      setPageHistories((prev) => ({ ...prev, [pageId]: value || [] }));
    } else if (storageKey.startsWith("slot-recommend-")) {
      const pageId = storageKey.slice("slot-recommend-".length);
      setPageRecommends((prev) => ({ ...prev, [pageId]: value || [] }));
    }
  }

  async function handleRestoreUndo(entry) {
    try {
      await storage.set(entry.storageKey, JSON.stringify(entry.previousValue), false);
    } catch (e) {
      // ignore, still update local state below so the user sees the restore
    }
    applyRestoredValue(entry.storageKey, entry.previousValue);
    persistUndoHistory(undoHistory.filter((h) => h.id !== entry.id));
  }

  function handleDismissUndoEntry(id) {
    persistUndoHistory(undoHistory.filter((h) => h.id !== id));
  }

  function handleSaveOverall() {
    if (!overallDate) {
      setOverallStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    const { modelRows, digitRows } = parseOverallSummary(overallPasteText);
    if (modelRows.length === 0 && digitRows.length === 0) {
      setOverallStatus({ type: "error", msg: "データを読み取れませんでした。表をそのまま貼り付けてください。" });
      return;
    }
    const eventForDate = (dateEventMap[overallDate] || "").trim();
    const next = [
      ...overallSummaries.filter((s) => s.date !== overallDate),
      { date: overallDate, event: eventForDate, modelRows, digitRows },
    ];
    persistOverallSummaries(next);
    setOverallStatus({
      type: "ok",
      msg: `${overallDate} のデータを保存しました（機種${modelRows.length}件・末尾${digitRows.length}件）。`,
    });
    setOverallPasteText("");
  }

  function handleDeleteOverall(date) {
    pushUndoEntry(`全体データ ${date} を削除`, OVERALL_SUMMARY_KEY, overallSummaries);
    persistOverallSummaries(overallSummaries.filter((s) => s.date !== date));
    setConfirmDeleteOverall(null);
  }

  function handleDeleteAllOverall() {
    pushUndoEntry("全体データを全部削除", OVERALL_SUMMARY_KEY, overallSummaries);
    persistOverallSummaries([]);
    setConfirmDeleteAllOverall(false);
  }

  // export every piece of stored data as one JSON file — used for offline
  // analysis / backtesting of the pickup scoring rules
  function handleExportData() {
    const exportObj = {
      exportedAt: new Date().toISOString(),
      pages,
      pageHistories,
      pageRecommends,
      dateEventMap,
      strongEvents,
      closedDays,
      overallSummaries,
      eventNames,
    };
    const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `slot-tracker-export-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // race-safe upsert: merges against the LATEST state (via the functional
  // setState form) instead of a value captured in a stale closure, so
  // saving several dates back-to-back can't silently drop earlier entries
  const upsertDateEvent = useCallback(
    async (date, name) => {
      setDateEventMap((prev) => {
        const next = { ...prev, [date]: name };
        storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false).catch(() => {});
        return next;
      });
      // retroactively patch every OTHER page's already-saved record for this
      // date too, so registering an event once is truly the only step needed
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
        const idx = hist.findIndex((h) => h.date === date);
        if (idx === -1 || hist[idx].event === name) continue;
        const nextHist = hist.map((h, i) => (i === idx ? { ...h, event: name } : h));
        loadedHistoryRef.current.add(p.id);
        setPageHistories((prev) => ({ ...prev, [p.id]: nextHist }));
        storage.set(historyKey(p.id), JSON.stringify(nextHist), false).catch(() => {});
      }
    },
    [pages, pageHistories]
  );

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
    setViewMode("page");
  }

  function handleRenamePage(pageId, name) {
    persistPages(pages.map((p) => (p.id === pageId ? { ...p, name } : p)));
  }

  function handleDeletePage(pageId) {
    const deletedPage = pages.find((p) => p.id === pageId);
    const next = pages.filter((p) => p.id !== pageId);
    pushUndoEntry(`ページ「${deletedPage && deletedPage.name ? deletedPage.name : "無題"}」を削除`, PAGES_KEY, pages);
    persistPages(next);
    setConfirmDeletePage(null);
    if (activePageId === pageId && next.length > 0) {
      setActivePageId(next[0].id);
    }
  }

  const currentHistory = pageHistories[activePageId] || [];
  const historyLoading = activePageId && pageHistories[activePageId] === undefined;
  const currentPage = pages.find((p) => p.id === activePageId);
  // this page's own recommend periods (used for this page's own predictions)
  const activePageRecommends = pageRecommends[activePageId] || [];
  // whichever page is selected in the 共通設定 tab's dropdown (used for that UI)
  const recommendTargetList = pageRecommends[recommendTargetPageId] || [];

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

  // this PAGE's own recommend periods, for its own machines' predictions
  const recommendDateSet = useMemo(() => {
    const set = new Set();
    activePageRecommends.forEach((p) => {
      enumerateDateRange(p.startDate, p.endDate).forEach((d) => set.add(d));
    });
    return set;
  }, [activePageRecommends]);

  // whichever page the 共通設定 dropdown has selected, for the registration UI

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
    const result = [];
    sortedHistory.forEach((h) => {
      if (!h.event) return;
      const matched = splitEventNames(h.event).find((n) => strongEventColorByName[n]);
      if (matched) result.push({ date: h.date, name: matched, color: strongEventColorByName[matched] });
    });
    return result;
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
      let lastSeenDate = null;
      const rawSeries = [];
      visibleTimelineDates.forEach((date) => {
        const entry = historyByDate[date];
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        if (m && m.sada !== null) {
          cum += m.sada;
          started = true;
          dataCount += 1;
          lastSeenDate = date;
        }
        // carry the running total forward on days with no data, instead of
        // breaking the line, so it always ends exactly at the total shown
        rawSeries.push({ date, value: started ? cum : null });
      });
      // once the machine stops appearing for good (e.g. 新台入れ替え), cut the
      // line off there instead of flat-lining all the way to the end —
      // a temporary one-off gap in the middle still just bridges through
      const series = rawSeries.map((pt) =>
        lastSeenDate && pt.date > lastSeenDate ? { ...pt, value: null } : pt
      );
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

      const baseRate = computeBaseRate(series);
      const allPairs = buildTrailingPairs(series, analysisWindow);
      const overall = findBestThresholds(allPairs, 5, baseRate);
      const digit2Pairs = allPairs.filter((p) => parseInt(p.nextDate.slice(-2), 10) % 10 === 2);
      const digit7Pairs = allPairs.filter((p) => parseInt(p.nextDate.slice(-2), 10) % 10 === 7);
      const digit2 = findBestThresholds(digit2Pairs, 3, baseRate);
      const digit7 = findBestThresholds(digit7Pairs, 3, baseRate);

      return {
        no,
        overall,
        digit2,
        digit7,
        baseRate,
        validDays: series.length,
        overallPairsCount: allPairs.length,
        digit2PairsCount: digit2Pairs.length,
        digit7PairsCount: digit7Pairs.length,
      };
    });
  }, [selectedMachines, sortedHistory, analysisWindow]);

  // evaluate one window size for one machine's series: does the CURRENT
  // trailing total already meet a historically favorable threshold?
  function evaluateWindow(series, windowSize, baseRate) {
    if (series.length < windowSize + 1) return null;
    const pairs = buildTrailingPairs(series, windowSize);
    const result = findBestThresholds(pairs, 5, baseRate);
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
  // with a combined "総合判断" verdict, plus several other pickup signals
  // (computed across all machines this page has ever seen)
  // core per-machine signal computation, parameterized so it can run for the
  // active page (pickList) AND for every page at once (allPagesPickList)
  function computeSignalsForPage(machineNumbers, pageSortedHistory, pageHistoryByDate, pageRecommendsList) {
    const results = [];
    const pageRecommendDateSet = new Set();
    pageRecommendsList.forEach((r) => enumerateDateRange(r.startDate, r.endDate).forEach((d) => pageRecommendDateSet.add(d)));
    const dailySettingFlags = computeDailySettingFlags(pageSortedHistory);
    // "tomorrow" must mean the same date for every machine/model/digit on this
    // page — anchored to the page's own most recent entered date, NOT each
    // item's own last non-"-" date (otherwise an item that happened to show
    // "-" on the latest date would predict for the wrong, already-past day)
    const referenceDate = pageSortedHistory.length > 0 ? pageSortedHistory[pageSortedHistory.length - 1].date : null;

    machineNumbers.forEach((no) => {
      const seriesFull = pageSortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          return m && m.sada !== null ? { date: h.date, sada: m.sada, gsu: m.gsu, event: h.event } : null;
        })
        .filter(Boolean);
      if (seriesFull.length === 0) return;
      const series = seriesFull.map((s) => ({ date: s.date, sada: s.sada }));
      const lastDate = series[series.length - 1].date;
      const baseRate = computeBaseRate(series);
      // this machine's own typical scale, used to make the expected-value
      // (average payout) component comparable across machines of very
      // different sizes/volatility
      const machineAvgSada = series.reduce((a, s) => a + s.sada, 0) / series.length;
      const machineTypicalMagnitude = series.reduce((a, s) => a + Math.abs(s.sada), 0) / series.length || 1;

      const windows = [10, 20, 30].map((w) => ({ windowSize: w, result: evaluateWindow(series, w, baseRate) }));
      const matchedWindows = windows.filter((w) => w.result && w.result.reasons.length > 0);

      const evaluableCount = windows.filter((w) => w.result).length;
      const avgWinRate = matchedWindows.length
        ? matchedWindows.reduce((a, w) => a + Math.max(...w.result.reasons.map((r) => r.winRate)), 0) / matchedWindows.length
        : null;

      // streak-based signal — prefer the EXACT streak-length stat (signed,
      // whichever direction it points), falling back to the "N-or-more"
      // grouped stat (positive-only) when the exact length has too few samples
      const streakEval = series.length >= 9 ? evaluateStreakPattern(series, baseRate) : null;
      let streakMatch = null;
      if (streakEval && streakEval.currentStreak && streakEval.currentStreak.dir !== "flat") {
        const dir = streakEval.currentStreak.dir;
        const len = streakEval.currentStreak.len;
        const exactRaw = streakEval.exactForDirRaw(dir, len);
        const best = dir === "plus" ? streakEval.plus : streakEval.minus; // positive-only fallback
        if (exactRaw) {
          streakMatch = { dir, len, ...exactRaw, exact: exactRaw };
        } else if (best && len >= best.minLen) {
          streakMatch = { dir, len, ...best, exact: null };
        }
      }

      // weekday-based signal (how does tomorrow's weekday historically do?)
      const weekdayStats = computeWeekdayStats(series);
      const tomorrowDate = addDays(referenceDate || lastDate, 1);
      const tomorrowWeekday = weekdayOf(tomorrowDate);
      const weekdayBucket = weekdayStats[tomorrowWeekday];
      const weekdayMatch = weekdayBucket && weekdayBucket.count >= 3 && weekdayBucket.winRate !== null ? weekdayBucket : null;

      // if tomorrow is ALSO a "2のつく日" or "7のつく日", check that intersection specifically
      const tomorrowDigit = parseInt(tomorrowDate.slice(-2), 10) % 10;
      let combinedWeekdayDigit = null;
      if (tomorrowDigit === 2 || tomorrowDigit === 7) {
        const combinedDates = series.filter(
          (pt) => weekdayOf(pt.date) === tomorrowWeekday && parseInt(pt.date.slice(-2), 10) % 10 === tomorrowDigit
        );
        if (combinedDates.length > 0) {
          const avg = combinedDates.reduce((a, p) => a + p.sada, 0) / combinedDates.length;
          combinedWeekdayDigit = { digit: tomorrowDigit, avg, count: combinedDates.length };
        } else {
          combinedWeekdayDigit = { digit: tomorrowDigit, avg: null, count: 0 };
        }
      }

      // generalized "日付末尾" signal for ANY digit 0-9 (not just a hand-picked
      // 2/7 combo) — backtesting on real data showed "2のつく日" is a strong
      // positive and "0のつく日" a strong negative, so this is scored like any
      // other signal rather than assumed
      const digitDates = series.filter((pt) => parseInt(pt.date.slice(-2), 10) % 10 === tomorrowDigit);
      let digitDayMatch = null;
      if (digitDates.length >= 5) {
        const wins = digitDates.filter((pt) => pt.sada > 0).length;
        digitDayMatch = {
          digit: tomorrowDigit,
          winRate: wins / digitDates.length,
          avg: digitDates.reduce((a, p) => a + p.sada, 0) / digitDates.length,
          sampleSize: digitDates.length,
        };
      }

      // did today follow a registered strong-event day, and how did that
      // pattern historically do (compared to non-event-day follow-throughs)?
      const strongFollowEval = series.length >= 6 ? evaluateStrongFollow(series, strongDateSet) : null;
      let strongFollowMatch = null;
      if (strongFollowEval && strongFollowEval.strong && strongDateSet.has(lastDate)) {
        const normalRate = strongFollowEval.normal ? strongFollowEval.normal.winRate : 0.5;
        strongFollowMatch = { ...strongFollowEval.strong, normalRate };
      }

      // is tomorrow pre-registered (via イベント登録) as one or more named
      // events? tomorrow may have several tags at once (e.g. "2のつく日、新
      // 台入れ替え") — check each individually and use whichever has the
      // best historical track record for THIS machine
      const plannedEventName = dateEventMap[tomorrowDate];
      const plannedEventNameList = splitEventNames(plannedEventName);
      let plannedEventMatch = null;
      plannedEventNameList.forEach((name) => {
        const perf = evaluateEventNamePerformance(series, pageHistoryByDate, name);
        if (perf && (!plannedEventMatch || perf.winRate > plannedEventMatch.winRate)) {
          plannedEventMatch = { name, favorable: perf.winRate > baseRate, ...perf };
        }
      });

      // is tomorrow within a hall-declared "おすすめ機種" period for this page (機種)?
      let recommendMatch = null;
      if (pageRecommendDateSet.has(tomorrowDate)) {
        const perf = evaluateMembershipPerformance(series, pageRecommendDateSet);
        if (perf) {
          const activePeriod = pageRecommendsList.find((r) => tomorrowDate >= r.startDate && tomorrowDate <= r.endDate);
          recommendMatch = { label: activePeriod ? activePeriod.label : "おすすめ期間", ...perf };
        }
      }

      // does the 差枚 trend since the last event predict tomorrow's event (if any)?
      const interEventTrendMatch = evaluateInterEventTrend(seriesFull, !!plannedEventName);

      // relative-to-peers rotation signal: was TODAY flagged "good" (heavily
      // played, not badly losing) or "low" (little played despite being
      // ahead) compared to other machines on this page that same day — and
      // does that pattern historically predict tomorrow?
      const flagByDate = new Map();
      pageSortedHistory.forEach((h) => flagByDate.set(h.date, (dailySettingFlags[h.date] || {})[no] ?? null));
      const settingFollow = seriesFull.length >= 6 ? evaluateSuspectedSettingFollow(seriesFull, flagByDate) : null;
      const todayFlag = flagByDate.get(lastDate) || null;
      let settingMatch = null;
      if (todayFlag === "good" && settingFollow && settingFollow.good) {
        settingMatch = { flag: "good", ...settingFollow.good };
      }
      let settingCaution = null;
      if (todayFlag === "low" && settingFollow && settingFollow.low) {
        settingCaution = { flag: "low", ...settingFollow.low };
      }

      // heavy play without a proportional payout — checked against baseRate too now
      const volumeMismatch = evaluateVolumeMismatch(seriesFull);

      const isTomorrowEvent = !!plannedEventName;

      const hasAnySignal =
        matchedWindows.length > 0 ||
        streakMatch ||
        weekdayMatch ||
        strongFollowMatch ||
        plannedEventMatch ||
        recommendMatch ||
        settingMatch ||
        settingCaution ||
        volumeMismatch ||
        digitDayMatch ||
        interEventTrendMatch;
      if (!hasAnySignal) return;

      // ---- additive/subtractive scoring: every signal (favorable OR
      // cautionary) contributes (its winRate − its own baseline) in
      // percentage points PLUS an expected-value component (its average
      // payout vs this machine's own typical day), both scaled down for
      // small samples and by a per-signal weight calibrated from a
      // walk-forward backtest on real hall data — then all of them are
      // summed together, so the total can go negative. ----
      const scoreItems = [];
      // 10/20/30-day thresholds are only trustworthy when they backed a
      // pattern that beats this machine's own base rate — but backtesting
      // showed they're only genuinely reliable when tomorrow is ALSO an
      // event day; on a normal day they were closer to a coin flip (or
      // worse), so they're heavily discounted unless tomorrow is an event
      const windowEventMultiplier = isTomorrowEvent ? 1.3 : 0.35;
      matchedWindows.forEach((w) => {
        const bestReason = w.result.reasons.reduce((a, r) => (!a || r.winRate > a.winRate ? r : a), null);
        const winPts = computePoints(bestReason.winRate, baseRate, bestReason.sampleSize);
        const evPts = computeEvPoints(bestReason.avgNext, machineAvgSada, machineTypicalMagnitude, bestReason.sampleSize);
        scoreItems.push({ label: `${w.windowSize}日足${isTomorrowEvent ? "（イベント日）" : "（通常日）"}`, points: (winPts + evPts) * windowEventMultiplier });
      });
      if (streakMatch) {
        const winPts = computePoints(streakMatch.winRate, baseRate, streakMatch.sampleSize);
        const evPts = computeEvPoints(streakMatch.avgNext, machineAvgSada, machineTypicalMagnitude, streakMatch.sampleSize);
        scoreItems.push({ label: "連続日数", points: (winPts + evPts) * SIGNAL_WEIGHTS.streak });
      }
      if (weekdayMatch) {
        const winPts = computePoints(weekdayMatch.winRate, baseRate, weekdayMatch.count);
        const evPts = computeEvPoints(weekdayMatch.avg, machineAvgSada, machineTypicalMagnitude, weekdayMatch.count);
        scoreItems.push({ label: "曜日傾向", points: (winPts + evPts) * SIGNAL_WEIGHTS.weekday });
      }
      if (digitDayMatch) {
        const winPts = computePoints(digitDayMatch.winRate, baseRate, digitDayMatch.sampleSize);
        const evPts = computeEvPoints(digitDayMatch.avg, machineAvgSada, machineTypicalMagnitude, digitDayMatch.sampleSize);
        scoreItems.push({ label: `日付末尾=${digitDayMatch.digit}`, points: (winPts + evPts) * SIGNAL_WEIGHTS.digitDay });
      }
      if (strongFollowMatch) {
        const winPts = computePoints(strongFollowMatch.winRate, strongFollowMatch.normalRate, strongFollowMatch.sampleSize);
        const evPts = computeEvPoints(strongFollowMatch.avgNext, machineAvgSada, machineTypicalMagnitude, strongFollowMatch.sampleSize);
        scoreItems.push({ label: "強いイベント翌日", points: (winPts + evPts) * SIGNAL_WEIGHTS.strongFollow });
      }
      if (plannedEventMatch) {
        const winPts = computePoints(plannedEventMatch.winRate, baseRate, plannedEventMatch.sampleSize);
        const evPts = computeEvPoints(plannedEventMatch.avgNext, machineAvgSada, machineTypicalMagnitude, plannedEventMatch.sampleSize);
        scoreItems.push({ label: "イベント登録連動", points: (winPts + evPts) * SIGNAL_WEIGHTS.plannedEvent });
      }
      if (interEventTrendMatch) {
        const winPts = computePoints(interEventTrendMatch.winRate, baseRate, interEventTrendMatch.sampleSize);
        const evPts = computeEvPoints(interEventTrendMatch.avg, machineAvgSada, machineTypicalMagnitude, interEventTrendMatch.sampleSize);
        scoreItems.push({ label: `イベント間トレンド（${interEventTrendMatch.direction}）`, points: (winPts + evPts) * SIGNAL_WEIGHTS.interEventTrend });
      }
      if (recommendMatch) {
        const winPts = computePoints(recommendMatch.winRate, baseRate, recommendMatch.sampleSize);
        const evPts = computeEvPoints(recommendMatch.avg, machineAvgSada, machineTypicalMagnitude, recommendMatch.sampleSize);
        scoreItems.push({ label: "おすすめ機種期間", points: (winPts + evPts) * SIGNAL_WEIGHTS.recommend });
      }
      if (settingMatch) {
        const winPts = computePoints(settingMatch.winRate, baseRate, settingMatch.sampleSize);
        const evPts = computeEvPoints(settingMatch.avg, machineAvgSada, machineTypicalMagnitude, settingMatch.sampleSize);
        scoreItems.push({ label: "相対ローテーション（設定良さそう）", points: (winPts + evPts) * SIGNAL_WEIGHTS.settingGood });
      }
      if (settingCaution) {
        const winPts = computePoints(settingCaution.winRate, baseRate, settingCaution.sampleSize);
        const evPts = computeEvPoints(settingCaution.avg, machineAvgSada, machineTypicalMagnitude, settingCaution.sampleSize);
        scoreItems.push({ label: "相対ローテーション（低設定っぽい）", points: (winPts + evPts) * SIGNAL_WEIGHTS.settingLow });
      }
      if (volumeMismatch && volumeMismatch.nextDayStats) {
        const winPts = computePoints(volumeMismatch.nextDayStats.winRate, baseRate, volumeMismatch.nextDayStats.sampleSize);
        const evPts = computeEvPoints(volumeMismatch.nextDayStats.avg, machineAvgSada, machineTypicalMagnitude, volumeMismatch.nextDayStats.sampleSize);
        scoreItems.push({ label: "大量回転・低調", points: (winPts + evPts) * SIGNAL_WEIGHTS.volumeMismatch });
      }

      const totalPoints = scoreItems.reduce((a, s) => a + s.points, 0);
      const signalCount = scoreItems.length;
      const grade = pointsToGrade(totalPoints);

      results.push({
        no,
        lastDate,
        windows,
        matchedCount: matchedWindows.length,
        evaluableCount,
        avgWinRate,
        streakMatch,
        weekdayMatch,
        weekdayTomorrow: WEEKDAY_LABELS[tomorrowWeekday],
        combinedWeekdayDigit,
        digitDayMatch,
        strongFollowMatch,
        plannedEventMatch,
        recommendMatch,
        interEventTrendMatch,
        settingMatch,
        settingCaution,
        volumeMismatch,
        scoreItems,
        totalPoints,
        signalCount,
        grade,
      });
    });
    return results;
  }

  function sortPickResults(results) {
    results.sort((a, b) => {
      const aScore = a.totalPoints ?? -Infinity;
      const bScore = b.totalPoints ?? -Infinity;
      if (bScore !== aScore) return bScore - aScore;
      return b.signalCount - a.signalCount;
    });
    return results;
  }

  const pickList = useMemo(() => {
    return sortPickResults(computeSignalsForPage(allMachineNumbers, sortedHistory, historyByDate, activePageRecommends));
  }, [allMachineNumbers, sortedHistory, strongDateSet, historyByDate, dateEventMap, activePageRecommends]);

  // hall-wide: every page's machines combined into ONE ranked list, no
  // page/機種 boundary — for spotting the single best "aim" machine anywhere
  // in the store, not just within one machine type
  const allPagesPickList = useMemo(() => {
    const combined = [];
    pages.forEach((p, i) => {
      const hist = pageHistories[p.id];
      if (!hist) return; // not loaded yet
      const sorted = [...hist].sort((a, b) => a.date.localeCompare(b.date));
      const hbd = {};
      sorted.forEach((h) => {
        hbd[h.date] = h;
      });
      const machineNos = Array.from(new Set(sorted.flatMap((h) => h.machines.map((m) => m.no)))).sort((a, b) => a - b);
      const recs = pageRecommends[p.id] || [];
      const pageResults = computeSignalsForPage(machineNos, sorted, hbd, recs);
      const pageLabel = p.name && p.name.trim() ? p.name : `機種${i + 1}`;
      pageResults.forEach((r) => combined.push({ ...r, pageId: p.id, pageLabel }));
    });
    return sortPickResults(combined);
  }, [pages, pageHistories, pageRecommends, strongDateSet, dateEventMap]);

  // store-wide 機種別サマリー / 末尾別データ, reusing the exact same signal
  // engine (it doesn't care whether "no" is a machine number, a model name,
  // or a last-digit label — it just needs {date, sada, gsu} per entity)
  const overallSortedSummaries = useMemo(
    () => [...overallSummaries].sort((a, b) => a.date.localeCompare(b.date)),
    [overallSummaries]
  );

  // store-wide 総差枚/平均差枚/平均G数 per date, reconstructed from the
  // 機種別サマリー rows (avgSada × 台数, summed across every model) — this
  // recovers the real negative totals that min-repo's own report list hides
  const dailyStoreTotals = useMemo(() => {
    return [...overallSortedSummaries]
      .map((s) => {
        let totalSamai = 0;
        let totalGsuWeighted = 0;
        let machineCount = 0;
        s.modelRows.forEach((r) => {
          if (r.total && r.avgSada !== null && r.avgSada !== undefined && r.avgGsu !== null && r.avgGsu !== undefined) {
            totalSamai += r.avgSada * r.total;
            totalGsuWeighted += r.avgGsu * r.total;
            machineCount += r.total;
          }
        });
        return {
          date: s.date,
          event: s.event,
          machineCount,
          totalSamai: machineCount > 0 ? Math.round(totalSamai) : null,
          avgSamai: machineCount > 0 ? totalSamai / machineCount : null,
          avgGsu: machineCount > 0 ? totalGsuWeighted / machineCount : null,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date)); // newest first
  }, [overallSortedSummaries]);

  const overallModelPickList = useMemo(() => {
    const sortedH = overallSortedSummaries.map((s) => ({
      date: s.date,
      event: s.event,
      machines: s.modelRows.map((r) => ({ no: r.name, sada: r.avgSada, gsu: r.avgGsu })),
    }));
    const hbd = {};
    sortedH.forEach((h) => {
      hbd[h.date] = h;
    });
    const names = Array.from(new Set(sortedH.flatMap((h) => h.machines.map((m) => m.no)))).sort();
    return sortPickResults(computeSignalsForPage(names, sortedH, hbd, []));
  }, [overallSortedSummaries, strongDateSet, dateEventMap]);

  const overallDigitPickList = useMemo(() => {
    const sortedH = overallSortedSummaries.map((s) => ({
      date: s.date,
      event: s.event,
      machines: s.digitRows.map((r) => ({ no: r.name, sada: r.avgSada, gsu: r.avgGsu })),
    }));
    const hbd = {};
    sortedH.forEach((h) => {
      hbd[h.date] = h;
    });
    const names = Array.from(new Set(sortedH.flatMap((h) => h.machines.map((m) => m.no)))).sort();
    return sortPickResults(computeSignalsForPage(names, sortedH, hbd, []));
  }, [overallSortedSummaries, strongDateSet, dateEventMap]);

  // system-wide reference accuracy: aggregates every 10/20/30-day threshold
  // rule found across every machine on this page, weighted by sample size.
  // NOTE: this is an in-sample measure (the rule was derived from, and is
  // being checked against, the same historical data) — not a true walk-
  // forward backtest — so treat it as a rough reference, not a guarantee.
  const overallBacktestStats = useMemo(() => {
    let totalWins = 0;
    let totalSamples = 0;
    allMachineNumbers.forEach((no) => {
      const series = sortedHistory
        .map((h) => {
          const m = h.machines.find((mm) => mm.no === no);
          return m && m.sada !== null ? { date: h.date, sada: m.sada } : null;
        })
        .filter(Boolean);
      [10, 20, 30].forEach((w) => {
        const pairs = buildTrailingPairs(series, w);
        const baseRate = computeBaseRate(series);
        const result = findBestThresholds(pairs, 5, baseRate);
        if (result?.bestAbove) {
          totalWins += result.bestAbove.winRate * result.bestAbove.sampleSize;
          totalSamples += result.bestAbove.sampleSize;
        }
        if (result?.bestBelow) {
          totalWins += result.bestBelow.winRate * result.bestBelow.sampleSize;
          totalSamples += result.bestBelow.sampleSize;
        }
      });
    });
    return totalSamples > 0 ? { winRate: totalWins / totalSamples, totalSamples } : null;
  }, [allMachineNumbers, sortedHistory]);

  // machine-to-machine correlation: does machine A's daily 差枚 tend to move
  // with machine B's, on days both have data? (Pearson correlation)
  const machineCorrelations = useMemo(() => {
    const seriesByMachine = {};
    allMachineNumbers.forEach((no) => {
      const map = {};
      sortedHistory.forEach((h) => {
        const m = h.machines.find((mm) => mm.no === no);
        if (m && m.sada !== null) map[h.date] = m.sada;
      });
      seriesByMachine[no] = map;
    });

    const results = [];
    for (let i = 0; i < allMachineNumbers.length; i++) {
      for (let j = i + 1; j < allMachineNumbers.length; j++) {
        const noA = allMachineNumbers[i];
        const noB = allMachineNumbers[j];
        const mapA = seriesByMachine[noA];
        const mapB = seriesByMachine[noB];
        const commonDates = Object.keys(mapA).filter((d) => d in mapB);
        if (commonDates.length < 10) continue;
        const xs = commonDates.map((d) => mapA[d]);
        const ys = commonDates.map((d) => mapB[d]);
        const r = pearsonCorrelation(xs, ys);
        if (r === null) continue;
        if (Math.abs(r) >= 0.4) {
          results.push({ noA, noB, r, sampleSize: commonDates.length });
        }
      }
    }
    results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    return results.slice(0, 20);
  }, [allMachineNumbers, sortedHistory]);

  function handleSave() {
    if (!activePageId) return;
    if (closedDateSet.has(entryDate)) {
      setStatus({ type: "error", msg: `${entryDate} は店休日として登録されているため、データを保存できません。` });
      return;
    }
    const parsedMachines = parseTable(pasteText);
    if (parsedMachines.length === 0) {
      setStatus({ type: "error", msg: "データを読み取れませんでした。表をそのまま貼り付けてください。" });
      return;
    }
    if (!entryDate) {
      setStatus({ type: "error", msg: "日付を入力してください。" });
      return;
    }
    // event text is no longer typed here — it's pulled automatically from
    // the shared date→event registry (managed in the "イベント登録" panel),
    // so every page always stays in sync with zero extra steps
    const autoEvent = (dateEventMap[entryDate] || "").trim();
    const next = [
      ...currentHistory.filter((h) => h.date !== entryDate),
      { date: entryDate, event: autoEvent, machines: parsedMachines },
    ];
    persistPageHistory(activePageId, next);
    setStatus({
      type: "ok",
      msg: `${entryDate} のデータを保存しました（${parsedMachines.length}台分）。`,
    });
    setPasteText("");
    setEntryDate(addDays(entryDate, -1));
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
    setStatus({ type: "ok", msg: `${h.date} のデータを編集用に読み込みました。修正して保存すると上書きされます。` });
  }

  function handleResetAll() {
    const pageLabel = currentPage && currentPage.name ? currentPage.name : "このページ";
    pushUndoEntry(`「${pageLabel}」のデータをリセット`, historyKey(activePageId), currentHistory);
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
    pushUndoEntry(`強いイベント「${name}」を削除`, STRONG_EVENTS_KEY, strongEvents);
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
    pushUndoEntry(`店休日 ${date} を削除`, CLOSED_DAYS_KEY, closedDays);
    persistClosedDays(closedDays.filter((c) => c.date !== date));
  }

  function handleAddRecommend() {
    if (!recommendTargetPageId) return;
    if (!recommendStart || !recommendEnd) {
      setRecommendStatus({ type: "error", msg: "開始日と終了日を入力してください。" });
      return;
    }
    if (recommendStart > recommendEnd) {
      setRecommendStatus({ type: "error", msg: "終了日は開始日より後にしてください。" });
      return;
    }
    const label = recommendLabel.trim() || "おすすめ期間";
    const next = [...recommendTargetList, { id: `rec-${Date.now()}`, startDate: recommendStart, endDate: recommendEnd, label }];
    persistPageRecommends(recommendTargetPageId, next);
    setRecommendStatus({ type: "ok", msg: `${recommendStart}〜${recommendEnd} を「${label}」として登録しました。` });
    setRecommendLabel("");
  }

  function handleRemoveRecommend(id) {
    if (!recommendTargetPageId) return;
    pushUndoEntry("おすすめ機種期間を削除", recommendKey(recommendTargetPageId), recommendTargetList);
    persistPageRecommends(recommendTargetPageId, recommendTargetList.filter((r) => r.id !== id));
  }

  async function handleAddFutureEvent() {
    const name = futureEventName.trim();
    if (!futureEventDate || !name) {
      setFutureEventStatus({ type: "error", msg: "日付とイベント名を入力してください。" });
      return;
    }
    const existingNames = splitEventNames(dateEventMap[futureEventDate]);
    if (existingNames.includes(name)) {
      setFutureEventStatus({ type: "error", msg: `${futureEventDate} には既に「${name}」が登録されています。` });
      return;
    }
    const combined = joinEventNames([...existingNames, name]);
    await upsertDateEvent(futureEventDate, combined);
    rememberEventName(name);
    const msg =
      existingNames.length > 0
        ? `${futureEventDate} に「${name}」を追加しました（登録済み：${combined}）。既に保存済みの全ページのデータも更新しました。`
        : `${futureEventDate} に「${name}」を登録しました（既に保存済みの全ページのデータも更新しました）。`;
    setFutureEventStatus({ type: "ok", msg });
    setFutureEventName("");
    setFutureEventDate(addDays(futureEventDate, 1));
  }

  async function handleRemoveDateEvent(date, tagName) {
    const existingNames = splitEventNames(dateEventMap[date]);
    const remainingNames = tagName ? existingNames.filter((n) => n !== tagName) : [];
    const remainingComposite = joinEventNames(remainingNames);
    const label = tagName ? `イベント登録 ${date} の「${tagName}」を削除` : `イベント登録 ${date} を削除`;
    pushUndoEntry(label, DATE_EVENT_MAP_KEY, dateEventMap);
    setDateEventMap((prev) => {
      const next = { ...prev };
      if (remainingComposite) {
        next[date] = remainingComposite;
      } else {
        delete next[date];
      }
      storage.set(DATE_EVENT_MAP_KEY, JSON.stringify(next), false).catch(() => {});
      return next;
    });
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
      const idx = hist.findIndex((h) => h.date === date);
      if (idx === -1 || !hist[idx].event) continue;
      const nextHist = hist.map((h, i) => (i === idx ? { ...h, event: remainingComposite } : h));
      loadedHistoryRef.current.add(p.id);
      setPageHistories((prev) => ({ ...prev, [p.id]: nextHist }));
      storage.set(historyKey(p.id), JSON.stringify(nextHist), false).catch(() => {});
    }
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

  // for each machine present on the picked date, a cumulative 差枚 trend for
  // the trailing `viewWindow` days ending on (and including) that date
  const viewWindowDates = useMemo(() => {
    const datesUpTo = sortedHistory.map((h) => h.date).filter((d) => d <= viewDate);
    return datesUpTo.slice(-viewWindow);
  }, [sortedHistory, viewDate, viewWindow]);

  const viewWindowSeries = useMemo(() => {
    if (!viewDateMachines) return [];
    return viewDateMachines.map((vm) => {
      const no = vm.no;
      let cum = 0;
      let started = false;
      let lastSeenDate = null;
      const raw = [];
      viewWindowDates.forEach((date) => {
        const entry = historyByDate[date];
        const m = entry ? entry.machines.find((mm) => mm.no === no) : null;
        if (m && m.sada !== null) {
          cum += m.sada;
          started = true;
          lastSeenDate = date;
        }
        raw.push({ date, value: started ? cum : null });
      });
      const series = raw.map((pt) => (lastSeenDate && pt.date > lastSeenDate ? { ...pt, value: null } : pt));
      const zeroAnchorDate = viewWindowDates.length > 0 ? addDays(viewWindowDates[0], -1) : null;
      const seriesWithZero = zeroAnchorDate ? [{ date: zeroAnchorDate, value: 0 }, ...series] : series;
      return { no, total: cum, series: seriesWithZero };
    });
  }, [viewDateMachines, viewWindowDates, historyByDate]);

  function renderThresholdResult(result, label, pairsCount, minSample) {
    if (!result) {
      return (
        <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "6px" }}>
          {label}：十分なデータがありません（有効な組み合わせ {pairsCount ?? 0}件、最低{minSample ?? 5}件必要）
        </div>
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
          <div style={{ fontSize: "11px", color: "#5a6272" }}>以上パターン：この台の基準勝率を上回るしきい値は見つかりませんでした（有効な組み合わせ {pairsCount ?? 0}件）</div>
        )}
        {bestBelow ? (
          <div style={{ fontSize: "12px", color: "#c7cbd4" }}>
            総差枚が <span className="mono" style={{ color: "#e8b34c" }}>{bestBelow.threshold >= 0 ? "+" : ""}{fmtNum(Math.round(bestBelow.threshold))}枚</span> 以下 →
            翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(bestBelow.winRate * 100)}%</span>
            （{bestBelow.sampleSize}件中、平均{bestBelow.avgNext >= 0 ? "+" : ""}{fmtNum(Math.round(bestBelow.avgNext))}枚）
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "#5a6272" }}>以下パターン：この台の基準勝率を上回るしきい値は見つかりませんでした（有効な組み合わせ {pairsCount ?? 0}件）</div>
        )}
      </div>
    );
  }

  // shared card renderer for pickList / overallModelPickList / overallDigitPickList
  // so all three show the exact same signal breakdown (windows, streak, weekday,
  // strong-event follow, planned event, recommend period, relative rotation, etc.)
  function renderPickCard(p, labelOverride) {
    return (
      <div key={p.no} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px", padding: "10px 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="mono" style={{ fontSize: "13px", fontWeight: 700, color: "#e8b34c" }}>{labelOverride ? labelOverride(p) : `${p.no}番`}</span>
            {p.grade && (
              <span className="mono" style={{
                fontSize: "13px", fontWeight: 800, width: "22px", height: "22px", lineHeight: "22px",
                textAlign: "center", borderRadius: "50%", color: "#12161d",
                background: { S: "#f2d24b", A: "#9ece6a", B: "#4fd1c5", C: "#7aa2f7", D: "#c7cbd4", E: "#f6a04d", F: "#e5697a", G: "#e5484d" }[p.grade],
              }}>
                {p.grade}
              </span>
            )}
            {p.totalPoints !== null && p.totalPoints !== undefined && (
              <span className="mono" style={{
                fontSize: "11px", fontWeight: 700, color: "#12161d",
                background: p.totalPoints >= 0 ? "#9ece6a" : "#e5697a",
                borderRadius: "4px", padding: "1px 6px",
              }}>
                総合スコア {p.totalPoints >= 0 ? "+" : ""}{Math.round(p.totalPoints)}pt（{p.signalCount}件根拠）
              </span>
            )}
          </span>
          <span style={{ fontSize: "10px", color: "#5a6272" }}>{p.lastDate}時点</span>
        </div>

        {p.matchedCount > 0 && (
          <div style={{ fontSize: "11px", color: "#c7cbd4", marginBottom: "6px", padding: "6px 8px", background: "rgba(79,209,197,0.08)", borderRadius: "6px" }}>
            総合判断：<span style={{ color: "#4fd1c5", fontWeight: 700 }}>{p.evaluableCount}期間中{p.matchedCount}期間</span>でプラス条件に該当
            （平均勝率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(p.avgWinRate * 100)}%</span>）
          </div>
        )}

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

        {p.streakMatch && (
          <div style={{ fontSize: "11px", color: "#8b93a3", marginTop: "6px" }}>
            連続日数：<span className="mono" style={{ color: "#c7cbd4" }}>{p.streakMatch.len}日連続{p.streakMatch.dir === "plus" ? "プラス" : "マイナス"}</span>
            {p.streakMatch.exact ? (
              <>
                （ちょうど{p.streakMatch.exact.len}日連続だった時の翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(p.streakMatch.exact.winRate * 100)}%</span>、{p.streakMatch.exact.sampleSize}件中）
              </>
            ) : (
              <>
                （ちょうど{p.streakMatch.len}日連続の過去データが少ないため、参考として{p.streakMatch.minLen}日以上でまとめた翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(p.streakMatch.winRate * 100)}%</span>、{p.streakMatch.sampleSize}件中）
              </>
            )}
          </div>
        )}

        {p.weekdayMatch && (
          <div style={{ fontSize: "11px", color: "#8b93a3", marginTop: "6px" }}>
            曜日傾向：明日は<span className="mono" style={{ color: "#c7cbd4" }}>{p.weekdayTomorrow}曜日</span>
            （過去平均 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{p.weekdayMatch.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.weekdayMatch.avg))}枚</span>、{p.weekdayMatch.count}件中）
          </div>
        )}

        {p.combinedWeekdayDigit && (
          <div style={{ fontSize: "11px", color: "#5a6272", marginTop: "3px", marginLeft: "12px" }}>
            └ さらに絞って{p.weekdayTomorrow}曜日×{p.combinedWeekdayDigit.digit}のつく日：
            {p.combinedWeekdayDigit.count === 0 ? (
              <span>過去に該当日がまだありません</span>
            ) : (
              <span>
                平均 <span style={{ color: p.combinedWeekdayDigit.avg >= 0 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
                  {p.combinedWeekdayDigit.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.combinedWeekdayDigit.avg))}枚
                </span>（{p.combinedWeekdayDigit.count}件中 — サンプルが少ないので参考程度に）
              </span>
            )}
          </div>
        )}

        {p.digitDayMatch && (
          <div style={{
            fontSize: "11px", marginTop: "3px",
            color: p.digitDayMatch.winRate > 0.5 ? "#8b93a3" : "#e5697a",
          }}>
            日付末尾={p.digitDayMatch.digit}の日：過去
            <span style={{ color: p.digitDayMatch.winRate >= 0.5 ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
              {" "}{Math.round(p.digitDayMatch.winRate * 100)}%
            </span>
            でプラス（{p.digitDayMatch.sampleSize}件中、平均{p.digitDayMatch.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.digitDayMatch.avg))}枚）
          </div>
        )}

        {p.strongFollowMatch && (
          <div style={{ fontSize: "11px", color: "#8b93a3", marginTop: "6px" }}>
            <Star size={10} style={{ display: "inline", marginRight: "2px", color: "#e5697a" }} fill="#e5697a" />
            今日は強いイベント日 → 翌日プラス率 <span style={{ color: "#9ece6a", fontWeight: 700 }}>{Math.round(p.strongFollowMatch.winRate * 100)}%</span>
            （通常{Math.round(p.strongFollowMatch.normalRate * 100)}% ／ {p.strongFollowMatch.sampleSize}件中）
          </div>
        )}

        {p.plannedEventMatch && (
          <div style={{
            fontSize: "11px", marginTop: "6px", padding: "6px 8px", borderRadius: "6px",
            color: p.plannedEventMatch.favorable ? "#8b93a3" : "#e5697a",
            background: p.plannedEventMatch.favorable ? "rgba(232,179,76,0.08)" : "rgba(229,105,122,0.06)",
          }}>
            📅 明日は予定イベント「{p.plannedEventMatch.name}」 → このイベントの翌日は過去
            <span style={{ color: p.plannedEventMatch.favorable ? "#9ece6a" : "#e5697a", fontWeight: 700 }}>
              {" "}{Math.round(p.plannedEventMatch.winRate * 100)}%
            </span>
            でプラス（{p.plannedEventMatch.sampleSize}件中、平均{p.plannedEventMatch.avgNext >= 0 ? "+" : ""}{fmtNum(Math.round(p.plannedEventMatch.avgNext))}枚）
          </div>
        )}

        {p.interEventTrendMatch && (
          <div style={{ fontSize: "11px", color: "#8b93a3", marginTop: "6px", padding: "6px 8px", background: "rgba(122,162,247,0.08)", borderRadius: "6px" }}>
            📈 前回のイベントからの差枚が{p.interEventTrendMatch.direction}傾向 → 明日のイベント当日は過去
            <span style={{ color: "#9ece6a", fontWeight: 700 }}> {Math.round(p.interEventTrendMatch.winRate * 100)}%</span>
            でプラス（{p.interEventTrendMatch.sampleSize}件中、平均{p.interEventTrendMatch.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.interEventTrendMatch.avg))}枚）
          </div>
        )}

        {p.recommendMatch && (
          <div style={{ fontSize: "11px", color: "#8b93a3", marginTop: "6px", padding: "6px 8px", background: "rgba(191,161,247,0.08)", borderRadius: "6px" }}>
            🏆 明日は「{p.recommendMatch.label}」期間中 → この期間の実績は勝率
            <span style={{ color: "#9ece6a", fontWeight: 700 }}> {Math.round(p.recommendMatch.winRate * 100)}%</span>
            ・平均{p.recommendMatch.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.recommendMatch.avg))}枚（{p.recommendMatch.sampleSize}件中）
          </div>
        )}

        {p.settingMatch && (
          <div style={{ fontSize: "11px", color: "#8b93a3", marginTop: "6px", padding: "6px 8px", background: "rgba(158,206,106,0.08)", borderRadius: "6px" }}>
            🎯 今日は他と比べて回転数が多いのに大きく負けていない（設定良さそう）→ 過去このパターンの翌日は勝率
            <span style={{ color: "#9ece6a", fontWeight: 700 }}> {Math.round(p.settingMatch.winRate * 100)}%</span>
            ・平均{p.settingMatch.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.settingMatch.avg))}枚（{p.settingMatch.sampleSize}件中）
          </div>
        )}

        {p.settingCaution && (
          <div style={{ fontSize: "11px", color: "#e5697a", marginTop: "6px", padding: "6px 8px", background: "rgba(229,105,122,0.08)", borderRadius: "6px" }}>
            ⚠ 今日は他と比べて回転数が少ないのにプラス（早めに見切られた・低設定っぽい）→ 過去このパターンの翌日は勝率
            <span style={{ fontWeight: 700 }}> {Math.round(p.settingCaution.winRate * 100)}%</span>
            ・平均{p.settingCaution.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.settingCaution.avg))}枚（{p.settingCaution.sampleSize}件中）
          </div>
        )}

        {p.volumeMismatch && (
          <div style={{ fontSize: "11px", color: "#e5697a", marginTop: "6px", padding: "6px 8px", background: "rgba(229,105,122,0.08)", borderRadius: "6px" }}>
            <div>
              ⚠ 大量回転・低調：直近G数 <span className="mono">{fmtNum(p.volumeMismatch.lastGsu)}G</span>
              （平均{fmtNum(Math.round(p.volumeMismatch.avgGsu))}G）に対し、差枚
              <span className="mono"> {p.volumeMismatch.lastSada >= 0 ? "+" : ""}{fmtNum(p.volumeMismatch.lastSada)}枚</span>
            </div>
            {p.volumeMismatch.nextDayStats ? (
              <div style={{ marginTop: "4px" }}>
                過去、同じパターンの翌日：勝率 <span style={{ fontWeight: 700 }}>{Math.round(p.volumeMismatch.nextDayStats.winRate * 100)}%</span>
                ・平均{p.volumeMismatch.nextDayStats.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.volumeMismatch.nextDayStats.avg))}枚
                （{p.volumeMismatch.nextDayStats.sampleSize}件中）
              </div>
            ) : (
              <div style={{ marginTop: "4px", color: "#8b6b6f" }}>過去の同パターンのデータがまだ十分ではありません（翌日）</div>
            )}
            {p.volumeMismatch.twoDayStats ? (
              <div>
                2日後：勝率 <span style={{ fontWeight: 700 }}>{Math.round(p.volumeMismatch.twoDayStats.winRate * 100)}%</span>
                ・平均{p.volumeMismatch.twoDayStats.avg >= 0 ? "+" : ""}{fmtNum(Math.round(p.volumeMismatch.twoDayStats.avg))}枚
                （{p.volumeMismatch.twoDayStats.sampleSize}件中）
              </div>
            ) : (
              <div style={{ color: "#8b6b6f" }}>過去の同パターンのデータがまだ十分ではありません（2日後）</div>
            )}
          </div>
        )}

        {p.scoreItems && p.scoreItems.length > 0 && (
          <div style={{ marginTop: "8px", paddingTop: "6px", borderTop: "1px dashed #232b37", display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {p.scoreItems.map((s, i) => (
              <span key={i} className="mono" style={{
                fontSize: "10px", padding: "1px 6px", borderRadius: "4px",
                color: s.points >= 0 ? "#9ece6a" : "#e5697a",
                background: s.points >= 0 ? "rgba(158,206,106,0.1)" : "rgba(229,105,122,0.1)",
              }}>
                {s.label} {s.points >= 0 ? "+" : ""}{s.points.toFixed(1)}pt
              </span>
            ))}
          </div>
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
        <div
          className={"page-tab" + (viewMode === "ranking" ? " active" : "")}
          onClick={() => setViewMode("ranking")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <span>🏅 全体ランキング</span>
        </div>
        <div
          className={"page-tab" + (viewMode === "common" ? " active" : "")}
          onClick={() => setViewMode("common")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <span>🔧 共通設定</span>
        </div>
        <div
          className={"page-tab" + (viewMode === "overall" ? " active" : "")}
          onClick={() => setViewMode("overall")}
          style={{ display: "flex", alignItems: "center", gap: "6px" }}
        >
          <span>📊 全体データ</span>
        </div>
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={"page-tab" + (viewMode === "page" && p.id === activePageId ? " active" : "")}
            onClick={() => { setActivePageId(p.id); setViewMode("page"); }}
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

      {viewMode === "ranking" ? (
        <div style={{ maxWidth: "760px" }}>
          {/* hall-wide combined ranking: every page's machines together, no 機種 boundary */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🏅 全機種合算ランキング（機種の隔たり無し）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              全ての機種ページの台をひとまとめにして、総合スコアが高い順にランク付けします。狙い台を機種を問わず探したいときはこちらを見てください。
            </div>
            {allPagesPickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>現時点で条件に当てはまる台はありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px" }}>
                {allPagesPickList.map((p) => (
                  <div key={p.pageId + "-" + p.no} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px", padding: "9px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      {p.grade && (
                        <span className="mono" style={{
                          fontSize: "12px", fontWeight: 800, width: "20px", height: "20px", lineHeight: "20px",
                          textAlign: "center", borderRadius: "50%", color: "#12161d",
                          background: { S: "#f2d24b", A: "#9ece6a", B: "#4fd1c5", C: "#7aa2f7", D: "#c7cbd4", E: "#f6a04d", F: "#e5697a", G: "#e5484d" }[p.grade],
                        }}>
                          {p.grade}
                        </span>
                      )}
                      <span className="mono" style={{ fontSize: "13px", fontWeight: 700, color: "#e8b34c" }}>{p.no}番</span>
                      <span style={{ fontSize: "11px", color: "#8b93a3" }}>{p.pageLabel}</span>
                    </span>
                    {p.totalPoints !== null && p.totalPoints !== undefined && (
                      <span className="mono" style={{ fontSize: "11px", fontWeight: 700, color: "#12161d", background: p.totalPoints >= 0 ? "#9ece6a" : "#e5697a", borderRadius: "4px", padding: "1px 6px" }}>
                        {p.totalPoints >= 0 ? "+" : ""}{Math.round(p.totalPoints)}pt（{p.signalCount}件根拠）
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : viewMode === "common" ? (
        <div style={{ maxWidth: "760px" }}>
          {unlocked ? (
            <>
          {/* export everything for offline analysis / backtesting */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📤 データをエクスポート
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              全機種のデータ（日付・イベント名・台番号ごとの差枚/G数/出率/BB/RB/合成）、共通のイベント登録、強いイベント、店休日、おすすめ機種期間、全体データを、まとめて1つのJSONファイルとして書き出します。
            </div>
            <button
              onClick={handleExportData}
              style={{
                width: "100%", background: "#7aa2f7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "10px", fontWeight: 700, fontSize: "13px", cursor: "pointer",
              }}
            >
              ダウンロード
            </button>
          </div>

          {/* recommended-model periods — one shared panel, target machine chosen via dropdown */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🏆 おすすめ機種期間
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              このお店の「月のおすすめ」「期間限定のおすすめ」など、機種が対象になっている期間を自由な日付範囲で登録できます（月曜〜金曜や7日間である必要はありません）。対象の機種を選んでから登録してください。「本日のピックアップ」で、その機種のこの期間中の実績も見ます。
            </div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ fontSize: "11px", color: "#8b93a3" }}>対象の機種</label>
              <select
                value={recommendTargetPageId || ""}
                onChange={(e) => setRecommendTargetPageId(e.target.value)}
                style={{
                  width: "100%", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", boxSizing: "border-box",
                }}
              >
                {pages.map((p, i) => (
                  <option key={p.id} value={p.id}>{p.name && p.name.trim() ? p.name : `機種${i + 1}`}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
              <input
                type="date"
                value={recommendStart}
                onChange={(e) => setRecommendStart(e.target.value)}
                style={{
                  flex: "1 1 120px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <span style={{ color: "#5a6272", alignSelf: "center" }}>〜</span>
              <input
                type="date"
                value={recommendEnd}
                onChange={(e) => setRecommendEnd(e.target.value)}
                style={{
                  flex: "1 1 120px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
            </div>
            <input
              type="text"
              value={recommendLabel}
              onChange={(e) => setRecommendLabel(e.target.value)}
              placeholder="ラベル（例：7月のおすすめ、今週のイチ押し など）"
              style={{
                width: "100%", marginBottom: "8px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", boxSizing: "border-box",
              }}
            />
            <button
              onClick={handleAddRecommend}
              style={{
                width: "100%", background: "#bb9af7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              おすすめ期間として登録
            </button>
            {recommendStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: recommendStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {recommendStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "160px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {[...recommendTargetList].sort((a, b) => b.startDate.localeCompare(a.startDate)).map((r) => (
                <div key={r.id} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                  background: "#12161d", border: "1px solid #2a2540", borderRadius: "6px", padding: "5px 8px",
                }}>
                  <span>
                    <span className="mono" style={{ color: "#bb9af7" }}>{r.startDate}〜{r.endDate}</span>
                    <span style={{ marginLeft: "6px", color: "#c7cbd4" }}>{r.label}</span>
                  </span>
                  <button onClick={() => handleRemoveRecommend(r.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {recommendTargetList.length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録されたおすすめ期間はまだありません。</div>
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

          {/* the ONE place to register an event for any date — past, today, or future.
              Saving any page automatically pulls the event from here, and registering
              here retroactively patches every page's already-saved data too. */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📅 イベント登録（全ページ共通）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              過去・今日・未来、どの日付でもここでイベント名を登録できます。同じ日に複数のイベント（例：「2のつく日」＋「新台入れ替え」）を追加登録することもできます。各ページの「データ入力」にはイベント欄はもう無く、保存するときにここの登録内容を自動で読み込みます。ここで登録・削除すると、既に保存済みの全ページのデータも自動で書き換わります（再保存は不要です）。
            </div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
              <input
                type="date"
                value={futureEventDate}
                onChange={(e) => setFutureEventDate(e.target.value)}
                style={{
                  flex: "0 0 130px", background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 6px", color: "#e7e9ee", fontSize: "12px",
                }}
              />
              <input
                type="text"
                list={DATALIST_ID}
                value={futureEventName}
                onChange={(e) => setFutureEventName(e.target.value)}
                placeholder="イベント名（例：末尾7の日）"
                style={{
                  flex: 1, background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "7px 8px", color: "#e7e9ee", fontSize: "12px", minWidth: 0,
                }}
              />
            </div>
            <button
              onClick={handleAddFutureEvent}
              style={{
                width: "100%", background: "#7aa2f7", color: "#12161d", border: "none", borderRadius: "8px",
                padding: "8px", fontWeight: 700, fontSize: "12px", cursor: "pointer",
              }}
            >
              イベントとして登録
            </button>
            {futureEventStatus && (
              <div style={{ marginTop: "8px", fontSize: "11px", color: futureEventStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                {futureEventStatus.msg}
              </div>
            )}

            <div className="scrollbar" style={{ marginTop: "12px", maxHeight: "200px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
              {Object.entries(dateEventMap)
                .sort((a, b) => b[0].localeCompare(a[0]))
                .map(([d, composite]) => (
                  <div key={d} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                    background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "5px 8px", gap: "8px",
                  }}>
                    <span className="mono" style={{ color: "#7aa2f7", flexShrink: 0 }}>{d}</span>
                    <span style={{ display: "flex", flexWrap: "wrap", gap: "4px", flex: 1 }}>
                      {splitEventNames(composite).map((tag) => (
                        <span key={tag} style={{
                          display: "inline-flex", alignItems: "center", gap: "4px",
                          background: "#1b212b", borderRadius: "4px", padding: "2px 6px", color: "#c7cbd4",
                        }}>
                          {tag}
                          <button
                            onClick={() => handleRemoveDateEvent(d, tag)}
                            style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272", padding: 0, display: "flex" }}
                            title={`「${tag}」だけ削除`}
                          >
                            <Trash2 size={10} />
                          </button>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              {Object.keys(dateEventMap).length === 0 && (
                <div style={{ fontSize: "11px", color: "#5a6272" }}>登録されたイベントはまだありません。</div>
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
                <Lock size={12} /> 共通設定をロックする
              </button>
            </>
          ) : (
            <div className="card" style={{ padding: "18px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
                <Lock size={14} /> 共通設定はロック中です
              </div>
              <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
                暗証番号を入力すると、イベント登録・強いイベント・店休日・おすすめ機種期間を編集できます。この解除状態は今開いているこの画面だけのもので、他の端末や再読み込み後には引き継がれません。
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
      ) : viewMode === "overall" ? (
        <div style={{ maxWidth: "760px" }}>
          {/* store-wide daily totals, reconstructed from 機種別サマリー — shows
              the real signed 総差枚/平均差枚, even on days min-repo itself hides
              the negative total */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              📈 店全体の推移（総差枚・平均差枚・平均G数）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              「機種別サマリー」の平均差枚×台数を全機種分足し合わせて算出しています。マイナスも隠さずそのまま表示します。
            </div>
            {dailyStoreTotals.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>まだデータがありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "320px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ position: "sticky", top: 0, background: "#12161d" }}>
                      <th style={{ textAlign: "left", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>日付</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>総差枚</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>平均差枚</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>平均G数</th>
                      <th style={{ textAlign: "right", padding: "6px 8px", color: "#8b93a3", borderBottom: "1px solid #2a323f" }}>台数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyStoreTotals.map((d) => (
                      <tr key={d.date}>
                        <td className="mono" style={{ padding: "5px 8px", color: "#c7cbd4", borderBottom: "1px solid #1c2129" }}>
                          {d.date}
                          {d.event && <span style={{ marginLeft: "6px", color: "#e8b34c", fontSize: "10px" }}>★{d.event}</span>}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: d.totalSamai >= 0 ? "#9ece6a" : "#e5697a", borderBottom: "1px solid #1c2129" }}>
                          {d.totalSamai === null ? "―" : `${d.totalSamai >= 0 ? "+" : ""}${fmtNum(d.totalSamai)}`}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: d.avgSamai >= 0 ? "#9ece6a" : "#e5697a", borderBottom: "1px solid #1c2129" }}>
                          {d.avgSamai === null ? "―" : `${d.avgSamai >= 0 ? "+" : ""}${fmtNum(Math.round(d.avgSamai))}`}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#c7cbd4", borderBottom: "1px solid #1c2129" }}>
                          {d.avgGsu === null ? "―" : fmtNum(Math.round(d.avgGsu))}
                        </td>
                        <td className="mono" style={{ padding: "5px 8px", textAlign: "right", color: "#5a6272", borderBottom: "1px solid #1c2129" }}>
                          {d.machineCount || "―"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* public: today's recommendations from the store-wide summaries, no lock needed */}
          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🎯 本日のおすすめ機種（未追跡の機種も含む）
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              下で貼り付けた「機種別サマリー」から、台ごとの分析と同じ仕組みで判定します。
            </div>
            {overallModelPickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>現時点で条件に当てはまる機種はありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {overallModelPickList.map((p) => renderPickCard(p, (pp) => pp.no))}
              </div>
            )}
          </div>

          <div className="card" style={{ padding: "18px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              🎯 末尾別のおすすめ
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              下で貼り付けた「末尾別データ」から、同じ仕組みで判定します。
            </div>
            {overallDigitPickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>現時点で条件に当てはまる末尾はありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {overallDigitPickList.map((p) => renderPickCard(p, (pp) => `末尾${pp.no}`))}
              </div>
            )}
          </div>

          {/* data entry, locked behind the same PIN as everything else */}
          {unlocked ? (
            <div className="card" style={{ padding: "18px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
                データ入力（機種別サマリー＋末尾別データ）
              </div>
              <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
                両方の表をそのまま1つに貼り付けてください（「末尾別データ」の行で自動的に区切ります）。日付にはイベント登録の内容が自動で反映されます。
              </div>
              <div style={{ marginBottom: "10px" }}>
                <label style={{ fontSize: "11px", color: "#8b93a3" }}>日付</label>
                <input
                  type="date"
                  value={overallDate}
                  onChange={(e) => setOverallDate(e.target.value)}
                  style={{
                    display: "block", marginTop: "4px", background: "#12161d", border: "1px solid #2a323f",
                    borderRadius: "6px", padding: "7px 8px", color: "#e7e9ee", fontSize: "13px",
                  }}
                />
              </div>
              {dateEventMap[overallDate] && (
                <div style={{
                  fontSize: "12px", color: "#e8b34c", marginBottom: "10px", padding: "7px 8px",
                  background: "rgba(232,179,76,0.08)", border: "1px solid #2a323f", borderRadius: "6px",
                  display: "flex", alignItems: "center", gap: "6px",
                }}>
                  <Flag size={12} />
                  この日のイベント：{dateEventMap[overallDate]}
                </div>
              )}
              <textarea
                className="mono scrollbar"
                value={overallPasteText}
                onChange={(e) => setOverallPasteText(e.target.value)}
                placeholder={"機種\t平均差枚\t平均G数\t勝率\t出率\nLアズールレーン THE ANIMATION\t3,500\t3,596\t2/4\t132.4%\n...\n末尾別データ\n末尾\t平均差枚\t平均G数\t勝率\t出率\n0\t868\t5,513\t24/56\t105.2%\n..."}
                rows={12}
                style={{
                  width: "100%", background: "#0e1218", border: "1px solid #2a323f", borderRadius: "6px",
                  padding: "8px", color: "#d7dae0", fontSize: "11.5px", lineHeight: 1.5, resize: "vertical",
                  boxSizing: "border-box", marginBottom: "10px",
                }}
              />
              <button
                onClick={handleSaveOverall}
                style={{
                  width: "100%", background: "#e8b34c", color: "#1b1508", border: "none", borderRadius: "8px",
                  padding: "10px", fontWeight: 700, fontSize: "13px", cursor: "pointer",
                }}
              >
                この日のデータを保存
              </button>
              {overallStatus && (
                <div style={{ marginTop: "8px", fontSize: "11px", color: overallStatus.type === "ok" ? "#9ece6a" : "#e5697a" }}>
                  {overallStatus.msg}
                </div>
              )}

              <div style={{ marginTop: "16px", borderTop: "1px solid #2a323f", paddingTop: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4" }}>
                    登録済みの日付（{overallSummaries.length}件）
                  </div>
                  {overallSummaries.length > 0 && (
                    confirmDeleteAllOverall ? (
                      <span style={{ display: "flex", gap: "6px" }}>
                        <span style={{ fontSize: "11px", color: "#e5697a" }}>本当に全部削除しますか？</span>
                        <button onClick={handleDeleteAllOverall} style={{ fontSize: "11px", color: "#e5697a", background: "none", border: "none", cursor: "pointer", fontWeight: 700 }}>
                          削除する
                        </button>
                        <button onClick={() => setConfirmDeleteAllOverall(false)} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <button onClick={() => setConfirmDeleteAllOverall(true)} style={{ fontSize: "11px", color: "#5a6272", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
                        <Trash2 size={11} />
                        全部削除
                      </button>
                    )
                  )}
                </div>
                <div className="scrollbar" style={{ maxHeight: "180px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {!overallSummariesLoaded && <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>}
                  {overallSummariesLoaded && overallSortedSummaries.length === 0 && (
                    <div style={{ fontSize: "12px", color: "#5a6272" }}>まだデータがありません。</div>
                  )}
                  {[...overallSortedSummaries].reverse().map((s) => (
                    <div key={s.date} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12px",
                      background: "#12161d", border: "1px solid #232b37", borderRadius: "6px", padding: "6px 8px",
                    }}>
                      <div>
                        <span className="mono">{s.date}</span>
                        {s.event && (
                          <span style={{ marginLeft: "6px", color: "#e8b34c" }}>
                            <Flag size={10} style={{ display: "inline", marginRight: "2px" }} />
                            {s.event}
                          </span>
                        )}
                        <span style={{ marginLeft: "6px", color: "#5a6272" }}>機種{s.modelRows.length}・末尾{s.digitRows.length}</span>
                      </div>
                      {confirmDeleteOverall === s.date ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button onClick={() => handleDeleteOverall(s.date)} style={{ fontSize: "11px", color: "#e5697a", background: "none", border: "none", cursor: "pointer" }}>削除する</button>
                          <button onClick={() => setConfirmDeleteOverall(null)} style={{ fontSize: "11px", color: "#8b93a3", background: "none", border: "none", cursor: "pointer" }}>取消</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteOverall(s.date)} style={{ background: "none", border: "none", cursor: "pointer", color: "#5a6272" }}>
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="card" style={{ padding: "18px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "8px", color: "#c7cbd4", display: "flex", alignItems: "center", gap: "6px" }}>
                <Lock size={14} /> データ入力はロック中です
              </div>
              <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
                暗証番号を入力すると、機種別サマリー・末尾別データを入力できます。上のおすすめ表示は鍵なしで見られます。
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
      ) : (
        <>
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
                  onChange={(e) => setEntryDate(e.target.value)}
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
                ⚠ この日付は店休日として登録されているため、データは保存できません。
              </div>
            )}
            {dateGapWarning && (
              <div style={{ fontSize: "11px", color: "#e5697a", marginBottom: "8px" }}>
                ⚠ 前回の記録（{dateGapWarning.lastDate}）からこの日付までに、{dateGapWarning.missing.length}日分データがありません（
                {dateGapWarning.missing.join("、")}）。店休日であれば登録しておくとこの警告は出なくなります。
              </div>
            )}

            {dateEventMap[entryDate] && (
              <div style={{
                fontSize: "12px", color: "#e8b34c", marginBottom: "10px", padding: "7px 8px",
                background: "rgba(232,179,76,0.08)", border: "1px solid #2a323f", borderRadius: "6px",
                display: "flex", alignItems: "center", gap: "6px",
              }}>
                <Flag size={12} />
                この日のイベント：{dateEventMap[entryDate]}（「📅 イベント登録」で変更できます）
              </div>
            )}

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
              disabled={entryDateIsClosed}
              style={{
                width: "100%",
                background: entryDateIsClosed ? "#3a3f4a" : "#e8b34c",
                color: entryDateIsClosed ? "#8b93a3" : "#1b1508",
                border: "none", borderRadius: "8px",
                padding: "10px", fontWeight: 700, fontSize: "13px",
                cursor: entryDateIsClosed ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              }}
            >
              <Save size={15} />
              {entryDateIsClosed ? "店休日のため保存できません" : "この日のデータを保存"}
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
              <>
                <div className="scrollbar" style={{ maxHeight: "300px", overflowY: "auto", marginBottom: "16px" }}>
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

                <div style={{ borderTop: "1px solid #2a323f", paddingTop: "14px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#c7cbd4" }}>
                      この日までの差枚推移
                    </div>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {[7, 10, 20].map((w) => (
                        <button key={w} onClick={() => setViewWindow(w)} className="chip" style={{
                          fontSize: "12px", padding: "5px 9px", borderRadius: "6px",
                          border: "1px solid " + (viewWindow === w ? "#4fd1c5" : "#2a323f"),
                          background: viewWindow === w ? "rgba(79,209,197,0.12)" : "transparent",
                          color: viewWindow === w ? "#4fd1c5" : "#c7cbd4",
                        }}>
                          {w}日間
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "10px" }}>
                    {viewWindowSeries.map((s) => (
                      <div key={s.no} style={{ background: "#0e1218", border: "1px solid #232b37", borderRadius: "10px", overflow: "hidden" }}>
                        <div style={{ background: "#e7e9ee", color: "#12161d", fontWeight: 700, fontSize: "12px", textAlign: "center", padding: "3px 0" }}>
                          [{s.no}]
                        </div>
                        <div style={{ position: "relative", height: "100px" }}>
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={s.series} margin={{ top: 8, right: 6, left: 0, bottom: 0 }}>
                              <CartesianGrid vertical={false} stroke="#232b37" strokeDasharray="2 3" />
                              <YAxis hide width={0} />
                              <XAxis dataKey="date" hide />
                              <Tooltip contentStyle={{ background: "#1b212b", border: "1px solid #2a323f", borderRadius: "6px", fontSize: "11px" }} />
                              <Line type="monotone" dataKey="value" stroke="#3ecf8e" strokeWidth={1.5} dot={false} connectNulls />
                            </LineChart>
                          </ResponsiveContainer>
                          <div className="mono" style={{
                            position: "absolute", right: "6px", bottom: "4px", fontSize: "13px", fontWeight: 800,
                            color: "#f2d24b", textShadow: "0 0 8px rgba(242,210,75,0.35)",
                          }}>
                            {s.total >= 0 ? "+" : ""}{fmtNum(s.total)}枚
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
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
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "10px" }}>
              直近の総差枚（10/20/30日足）に加えて、連続日数・曜日傾向・強いイベント翌日・回転数と差枚のズレも見て、当てはまる台を「総合スコア」が高い順（同スコアなら根拠の件数が多い順）にリストアップします（このページの全ての台が対象）。丸いバッジはスコアをS〜Gのランクにしたものです。
            </div>
            {overallBacktestStats && (
              <div style={{
                fontSize: "11px", color: "#8b93a3", marginBottom: "12px", padding: "8px 10px",
                background: "#12161d", border: "1px solid #2a323f", borderRadius: "6px",
              }}>
                参考：総差枚しきい値ルールの過去的中率（全台・10/20/30日足 合算） 約
                <span style={{ color: "#9ece6a", fontWeight: 700 }}> {Math.round(overallBacktestStats.winRate * 100)}%</span>
                （{overallBacktestStats.totalSamples}件） ※ルールを作った同じ過去データで検証した参考値です。将来を保証するものではありません。
              </div>
            )}
            {pickList.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>現時点で条件に当てはまる台はありません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "460px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
                {pickList.map((p) => renderPickCard(p))}
              </div>
            )}
          </div>

          {/* machine-to-machine correlation */}
          <div className="card" style={{ padding: "18px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, marginBottom: "4px", color: "#c7cbd4" }}>
              台同士の相関
            </div>
            <div style={{ fontSize: "11px", color: "#5a6272", marginBottom: "12px" }}>
              日ごとの差枚が似た動きをする台の組み合わせを探します（相関係数の絶対値が0.4以上、同時データ10日分以上のペアのみ表示）。相関は因果関係を示すものではなく、偶然による見かけ上の一致も含まれる点にご注意ください。
            </div>
            {machineCorrelations.length === 0 ? (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>目立った相関の組み合わせはまだ見つかっていません。</div>
            ) : (
              <div className="scrollbar" style={{ maxHeight: "300px", overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ color: "#5a6272", textAlign: "left" }}>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番A</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>台番B</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>相関係数</th>
                      <th style={{ padding: "4px 8px", fontWeight: 600 }}>同時日数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {machineCorrelations.map((c) => (
                      <tr key={c.noA + "-" + c.noB} style={{ borderTop: "1px solid #232b37" }}>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{c.noA}</td>
                        <td className="mono" style={{ padding: "6px 8px", color: "#c7cbd4" }}>{c.noB}</td>
                        <td className="mono" style={{ padding: "6px 8px", fontWeight: 700, color: c.r >= 0 ? "#9ece6a" : "#e5697a" }}>
                          {c.r >= 0 ? "+" : ""}{c.r.toFixed(2)}
                        </td>
                        <td className="mono" style={{ padding: "6px 8px", color: "#5a6272" }}>{c.sampleSize}日</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                      <span style={{ fontSize: "10px", color: "#5a6272", fontWeight: 400 }}>（有効データ {a.validDays}日分・基準勝率{Math.round(a.baseRate * 100)}%）</span>
                    </div>
                    {renderThresholdResult(a.overall, "全日", a.overallPairsCount, 5)}
                    {renderThresholdResult(a.digit2, "翌日が2のつく日のみ", a.digit2PairsCount, 3)}
                    {renderThresholdResult(a.digit7, "翌日が7のつく日のみ", a.digit7PairsCount, 3)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
        </>
      )}

      <style>{`
        @media (max-width: 860px) {
          .tracker-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* fixed undo-history button, shown regardless of which tab/page is open */}
      <div style={{ position: "fixed", right: "20px", bottom: "20px", zIndex: 50 }}>
        {undoPanelOpen && (
          <div className="card" style={{
            width: "320px", maxHeight: "400px", overflowY: "auto", padding: "14px",
            marginBottom: "10px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#c7cbd4" }}>🕐 操作履歴</div>
              <button onClick={() => setUndoPanelOpen(false)} style={{ background: "none", border: "none", color: "#5a6272", cursor: "pointer" }}>✕</button>
            </div>
            {!undoHistoryLoaded && <div style={{ fontSize: "12px", color: "#5a6272" }}>読み込み中...</div>}
            {undoHistoryLoaded && undoHistory.length === 0 && (
              <div style={{ fontSize: "12px", color: "#5a6272" }}>取り消せる操作の履歴はまだありません。</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {undoHistory.map((entry) => (
                <div key={entry.id} style={{ background: "#12161d", border: "1px solid #2a323f", borderRadius: "8px", padding: "8px 10px" }}>
                  <div style={{ fontSize: "12px", color: "#e7e9ee", marginBottom: "4px" }}>{entry.label}</div>
                  <div style={{ fontSize: "10px", color: "#5a6272", marginBottom: "6px" }}>
                    {new Date(entry.timestamp).toLocaleString("ja-JP")}
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      onClick={() => handleRestoreUndo(entry)}
                      style={{ fontSize: "11px", fontWeight: 700, color: "#12161d", background: "#9ece6a", border: "none", borderRadius: "6px", padding: "4px 10px", cursor: "pointer" }}
                    >
                      元に戻す
                    </button>
                    <button
                      onClick={() => handleDismissUndoEntry(entry.id)}
                      style={{ fontSize: "11px", color: "#5a6272", background: "none", border: "none", cursor: "pointer" }}
                    >
                      閉じる
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <button
          onClick={() => setUndoPanelOpen((v) => !v)}
          style={{
            display: "flex", alignItems: "center", gap: "6px", background: "#1b212b", color: "#c7cbd4",
            border: "1px solid #2a323f", borderRadius: "999px", padding: "10px 16px", fontSize: "12px",
            fontWeight: 700, cursor: "pointer", boxShadow: "0 4px 12px rgba(0,0,0,0.3)", float: "right",
          }}
        >
          🕐 操作履歴{undoHistory.length > 0 ? `（${undoHistory.length}）` : ""}
        </button>
      </div>
    </div>
  );
}
