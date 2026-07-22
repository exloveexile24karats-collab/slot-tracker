// Fetches プラザ本店II daily reports from min-repo.com and fills in any
// missing dates (both the store-wide 機種別/末尾別 summary, and the per-page
// per-machine data for pages that have a "minRepoName" registered).
//
// IMPORTANT: this NEVER overwrites a date that's already saved (whether it
// was entered by hand or by a previous run of this script). It only adds
// dates that are missing.

import * as cheerio from "cheerio";
import admin from "firebase-admin";

// ---- config ----
const TAG_LIST_URL = "https://min-repo.com/tag/%e3%83%97%e3%83%a9%e3%82%b6%e6%9c%ac%e5%ba%97ii/";
const STOP_DATE = "2026-05-15"; // never fetch/backfill earlier than this
const MAX_DAYS_PER_RUN = 400; // safety guard against infinite loops
const REQUEST_DELAY_MS = 1200; // be gentle with the target site

const PAGES_KEY = "slot-pages-v1";
const historyKey = (pageId) => `slot-history-${pageId}`;
const DATE_EVENT_MAP_KEY = "slot-date-event-map-v1";
const OVERALL_SUMMARY_KEY = "slot-overall-summary-v1";

// ---- Firebase Admin setup (service account JSON comes from a GitHub secret) ----
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function kvGet(key) {
  const snap = await db.collection("kv").doc(key).get();
  if (!snap.exists) return null;
  const raw = snap.data().value;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value) {
  await db.collection("kv").doc(key).set({ value: JSON.stringify(value), updatedAt: Date.now() });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (personal-use data collector; contact via site owner if needed)" },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status} for ${url}`);
  return await res.text();
}

// "7/21(火)" + a nearby ISO datetime (from the page's <time> tag, used to
// infer the year) -> "2026-07-21"
function resolveDate(monthDayStr, referenceIso) {
  const m = monthDayStr.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  const ref = new Date(referenceIso);
  let year = ref.getFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  // the report always covers a date at or before its publish timestamp;
  // if our guess lands in the future relative to the reference, it must
  // actually be the previous year (handles the Dec->Jan boundary)
  if (candidate.getTime() > ref.getTime() + 24 * 3600 * 1000) {
    year -= 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  const yyyy = year;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// some sites render negative numbers with a different Unicode character than
// a plain ASCII hyphen (e.g. U+2212 MINUS SIGN, U+FF0D FULLWIDTH HYPHEN-MINUS)
// — parseInt/parseFloat don't recognize those, so normalize them first
function toAsciiMinus(text) {
  return text.replace(/[\u2212\uFF0D\u2010\u2011\u2013\u2014]/g, "-");
}

function parseMachineTable($, root) {
  const machines = [];
  root.find("table tr").each((_, tr) => {
    const $tr = $(tr);
    if ($tr.find("th").length > 0) return; // header row
    const tds = $tr.find("td");
    if (tds.length < 9) return;
    const noText = $(tds[0]).text().trim();
    if (noText === "平均") return; // average row
    const no = parseInt(noText.replace(/,/g, ""), 10);
    if (Number.isNaN(no)) return;
    const sadaText = toAsciiMinus($(tds[1]).text().trim());
    const gsuText = toAsciiMinus($(tds[2]).text().trim());
    const shutsuText = $(tds[3]).text().trim();
    const bbText = toAsciiMinus($(tds[4]).text().trim());
    const rbText = toAsciiMinus($(tds[5]).text().trim());
    const gouseiText = $(tds[6]).text().trim();
    const bbRateStr = $(tds[7]).text().trim() || "-";
    const rbRateStr = $(tds[8]).text().trim() || "-";
    const sada = parseInt(sadaText.replace(/,/g, ""), 10);
    const gsu = parseInt(gsuText.replace(/,/g, ""), 10);
    const shutsu = parseFloat(shutsuText.replace("%", ""));
    const bb = bbText === "-" ? null : parseInt(bbText, 10);
    const rb = rbText === "-" ? null : parseInt(rbText, 10);
    const gouseiMatch = gouseiText.match(/1\s*\/\s*(\d+)/);
    const gousei = gouseiMatch ? parseInt(gouseiMatch[1], 10) : null;
    machines.push({
      no,
      sada: Number.isNaN(sada) ? null : sada,
      gsu: Number.isNaN(gsu) ? null : gsu,
      shutsu: Number.isNaN(shutsu) ? null : shutsu,
      bb,
      rb,
      gousei,
      bbRateStr,
      rbRateStr,
    });
  });
  return machines;
}

function parseSummaryRows($, table) {
  const rows = [];
  $(table)
    .find("tr")
    .each((_, tr) => {
      const $tr = $(tr);
      if ($tr.find("th").length > 0) return; // header/section-divider row
      const tds = $tr.find("td");
      if (tds.length < 5) return;
      const name = $(tds[0]).text().trim().replace(/\s+/g, " ");
      const avgSadaText = toAsciiMinus($(tds[1]).text().trim());
      const avgGsuText = toAsciiMinus($(tds[2]).text().trim());
      const winText = $(tds[3]).text().trim();
      const shutsuText = $(tds[4]).text().trim();
      const avgSada = avgSadaText === "-" || avgSadaText === "" ? null : parseInt(avgSadaText.replace(/,/g, ""), 10);
      const avgGsu = avgGsuText === "-" || avgGsuText === "" ? null : parseInt(avgGsuText.replace(/,/g, ""), 10);
      const winMatch = winText.match(/(\d+)\s*\/\s*(\d+)/);
      const wins = winMatch ? parseInt(winMatch[1], 10) : null;
      const total = winMatch ? parseInt(winMatch[2], 10) : null;
      const shutsu = shutsuText === "-" || shutsuText === "" ? null : parseFloat(shutsuText.replace("%", ""));
      if (!name) return;
      rows.push({
        name,
        avgSada: Number.isNaN(avgSada) ? null : avgSada,
        avgGsu: Number.isNaN(avgGsu) ? null : avgGsu,
        wins,
        total,
        shutsu: Number.isNaN(shutsu) ? null : shutsu,
      });
    });
  return rows;
}

async function main() {
  console.log("Loading current app data from Firestore...");
  const pages = (await kvGet(PAGES_KEY)) || [];
  const dateEventMap = (await kvGet(DATE_EVENT_MAP_KEY)) || {};
  let overallSummaries = (await kvGet(OVERALL_SUMMARY_KEY)) || [];
  const overallDates = new Set(overallSummaries.map((s) => s.date));

  const trackedPages = pages.filter((p) => p.minRepoName && p.minRepoName.trim());
  console.log(`Tracked pages with a min-repo name: ${trackedPages.map((p) => p.name || p.id).join(", ") || "(none)"}`);

  const pageHistories = {};
  const pageDateSets = {};
  for (const p of trackedPages) {
    const hist = (await kvGet(historyKey(p.id))) || [];
    pageHistories[p.id] = hist;
    pageDateSets[p.id] = new Set(hist.map((h) => h.date));
  }

  // ---- collect {date, url} for every report, straight from the listing
  //      page(s) — this is far more reliable than following "前日" links one
  //      by one, since some days have no report at all and break that chain ----
  console.log("Collecting report links...");
  const reportLinks = [];
  const nowIso = new Date().toISOString();
  let listUrl = TAG_LIST_URL;
  let pageCount = 0;
  while (listUrl && pageCount < 15) {
    pageCount += 1;
    let listHtml;
    try {
      listHtml = await fetchHtml(listUrl);
    } catch (e) {
      console.log(`Failed to fetch listing page ${listUrl}: ${e.message}`);
      break;
    }
    const $list = cheerio.load(listHtml);
    let foundAnyOnThisPage = false;
    let oldestDateOnThisPage = null;
    $list("table").each((_, table) => {
      const $table = $list(table);
      const headerText = $table.find("tr").first().text();
      if (!headerText.includes("日付") || !headerText.includes("総差枚")) return;
      $table.find("tr").each((i, tr) => {
        if (i === 0) return; // header row
        const a = $list(tr).find("td").first().find("a").first();
        const href = a.attr("href");
        const text = a.text().trim();
        if (!href || !/^https:\/\/min-repo\.com\/\d+\/$/.test(href)) return;
        const date = resolveDate(text, nowIso);
        if (!date) return;
        reportLinks.push({ date, url: href });
        foundAnyOnThisPage = true;
        if (!oldestDateOnThisPage || date < oldestDateOnThisPage) oldestDateOnThisPage = date;
      });
    });
    if (!foundAnyOnThisPage) break;
    if (oldestDateOnThisPage && oldestDateOnThisPage < STOP_DATE) break; // gone far enough back

    // follow the site's own "next page" link rather than guessing the URL
    // pattern — wp-pagenavi typically renders one of these
    let nextHref =
      $list(".wp-pagenavi a.nextpostslink").attr("href") ||
      $list('a[rel="next"]').attr("href") ||
      $list("a.next").attr("href") ||
      null;
    if (!nextHref) {
      // last resort: any link whose text looks like "next"
      $list("a").each((_, a) => {
        if (nextHref) return;
        const t = $list(a).text().trim();
        if (t === "次のページ" || t === "次へ" || t === "»" || t === "Next" || t.includes("次")) {
          nextHref = $list(a).attr("href") || null;
        }
      });
    }
    if (!nextHref) {
      console.log("No next-page link found on the listing page. Stopping pagination.");
      break;
    }
    listUrl = new URL(nextHref, listUrl).toString();
    await sleep(REQUEST_DELAY_MS);
  }
  if (reportLinks.length === 0) {
    console.error("Could not find any report links on the tag page. Aborting.");
    process.exit(1);
  }
  const relevantLinks = reportLinks
    .filter((l) => l.date >= STOP_DATE)
    .sort((a, b) => b.date.localeCompare(a.date));
  console.log(`Found ${relevantLinks.length} reports from ${STOP_DATE} onward.`);

  let overallChanged = false;
  const changedPageIds = new Set();
  let stepCount = 0;

  for (const { date, url: currentUrl } of relevantLinks) {
    stepCount += 1;
    if (stepCount > MAX_DAYS_PER_RUN) {
      console.log(`Hit the ${MAX_DAYS_PER_RUN}-day safety limit for this run. Stopping early.`);
      break;
    }
    await sleep(REQUEST_DELAY_MS);

    let html;
    try {
      html = await fetchHtml(currentUrl);
    } catch (e) {
      console.error("Failed to fetch", currentUrl, e.message);
      continue;
    }
    const $ = cheerio.load(html);
    console.log(`Processing ${date} (${currentUrl})`);

    // ---- overall summary (機種別 + 末尾別) ----
    if (!overallDates.has(date)) {
      const modelTable = $(".kishu._2dai");
      const modelRows = modelTable.length ? parseSummaryRows($, modelTable) : [];
      // digit table: the only other plain <table> inside a .tab_content that isn't the model table
      let digitRows = [];
      $(".tab_content").each((_, el) => {
        const $el = $(el);
        if ($el.find(".kishu._2dai").length > 0) return; // this is the model tab
        const t = $el.find("table").first();
        if (t.length && $el.find("h2").text().includes("末尾")) {
          digitRows = parseSummaryRows($, t);
        }
      });
      if (modelRows.length > 0 || digitRows.length > 0) {
        overallSummaries.push({ date, event: dateEventMap[date] || "", modelRows, digitRows });
        overallDates.add(date);
        overallChanged = true;
        console.log(`  + overall summary: ${modelRows.length} models, ${digitRows.length} digits`);
      }
    }

    // ---- per-page machine data (only for pages missing this date) ----
    for (const p of trackedPages) {
      if (pageDateSets[p.id].has(date)) continue;
      await sleep(REQUEST_DELAY_MS);
      const kishuUrl = `${currentUrl}?kishu=${encodeURIComponent(p.minRepoName)}`;
      let kishuHtml;
      try {
        kishuHtml = await fetchHtml(kishuUrl);
      } catch (e) {
        console.error(`  ! failed to fetch machine data for ${p.name} on ${date}:`, e.message);
        continue;
      }
      const $k = cheerio.load(kishuHtml);
      const dataSection = $k(".table_wrap").first();
      const machines = dataSection.length ? parseMachineTable($k, dataSection) : [];
      if (machines.length > 0) {
        pageHistories[p.id].push({ date, event: dateEventMap[date] || "", machines });
        pageDateSets[p.id].add(date);
        changedPageIds.add(p.id);
        console.log(`  + ${p.name || p.id}: ${machines.length} machines`);
      }
    }
  }

  // ---- persist whatever changed ----
  if (overallChanged) {
    overallSummaries.sort((a, b) => a.date.localeCompare(b.date));
    await kvSet(OVERALL_SUMMARY_KEY, overallSummaries);
    console.log(`Saved overall summaries (${overallSummaries.length} total dates).`);
  }
  for (const pageId of changedPageIds) {
    const hist = pageHistories[pageId].sort((a, b) => a.date.localeCompare(b.date));
    await kvSet(historyKey(pageId), hist);
    console.log(`Saved history for page ${pageId} (${hist.length} total dates).`);
  }

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
