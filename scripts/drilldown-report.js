const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT_DIR = path.resolve(__dirname, "..");
const REPORT_URL = "https://adm.adbiding.cn/report/dspReport";
const AUTH_STATE_PATH = path.join(ROOT_DIR, ".auth", "dsp-report-state.json");
const DSP_CONFIG_PATH = path.join(ROOT_DIR, "config", "dsps.json");
const RULES_PATH = path.join(ROOT_DIR, "config", "report-rules.json");
const SAMPLES_DIR = path.join(ROOT_DIR, "samples");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const nextValue = argv[index + 1];
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      args[key] = nextValue;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function localDateString(date = new Date()) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function timestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function parseNumberList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function parseNumber(value) {
  if (value == null || value === "" || value === "-") return 0;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePercent(value) {
  if (value == null || value === "" || value === "-") return null;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

function formatPercent(value) {
  return value == null ? "-" : `${Number(value.toFixed(2))}%`;
}

function pickDsps(configuredDsps, requestedIds) {
  const requestedSet = new Set(requestedIds);
  const selected = requestedIds.length
    ? configuredDsps.filter((dsp) => requestedSet.has(Number(dsp.id)))
    : configuredDsps;

  return selected.map((dsp) => ({
    id: Number(dsp.id),
    name: dsp.name,
  }));
}

function buildRequestBody({ dspIds, dspSlotIds, startDate, endDate, groupBy, pageSize }) {
  return {
    current: 1,
    pageSize,
    sorter: { day: "descend" },
    group_by: groupBy,
    filter: {
      day: [startDate, endDate],
      hour: [],
      minute: [],
      mid: [],
      slot: [],
      adg: [],
      ad: [],
      dsp_id: dspIds,
      dsp_slot_id: dspSlotIds,
      os_type: [],
      dsp_slot_type: [],
      media_slot_type: [],
      media_slot_group_id: [],
      real_app_bundle: [],
      app_bundle: [],
      deeplink_url: [],
      real_app_bundle_like: true,
    },
  };
}

async function isLoginLikePage(page) {
  if (/login|signin|auth/i.test(page.url())) return true;
  return page.evaluate(() => {
    const hasPasswordInput = Boolean(document.querySelector("input[type='password']"));
    const text = document.body?.innerText || "";
    return hasPasswordInput || /login|sign in|password/i.test(text);
  });
}

async function queryReport(page, requestBody) {
  return page.evaluate(async (payload) => {
    const token = localStorage.getItem("token");
    if (!token) {
      return {
        status: 401,
        ok: false,
        data: { code: 401, message: "missing token in localStorage" },
      };
    }

    const response = await fetch("/api/queryDspReport", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { code: response.status, message: text.slice(0, 500) };
    }

    return {
      status: response.status,
      ok: response.ok,
      data,
    };
  }, requestBody);
}

function toSummaryRow(row) {
  return {
    day: row.day,
    dsp_id: row.dsp_id,
    dsp_name: row.dsp_name,
    dsp_slot_id: row.dsp_slot_id,
    dsp_slot_name: row.dsp_slot_name,
    ad: row.ad,
    ad_name: row.ad_name,
    ad_group_name: row.ad_group_name,
    req_avalible: row.req_avalible,
    req_send: row.req_send,
    bid_rate: row.bid_rate,
    resp_rate: row.resp_rate,
    imp: row.imp,
    win_rate: row.win_rate,
    click: row.click,
    cost: row.cost,
    charge: row.charge,
    profit_rate: row.profit_rate,
    thousand_req_charge: row.thousand_req_charge,
    thousand_send_charge: row.thousand_send_charge,
    conversion_rate: row.conversion_rate,
  };
}

function classify(metrics, rules) {
  if (
    metrics.profit_rate != null &&
    metrics.profit_rate >= rules.profitRate.goodAtOrAbove &&
    metrics.profit_amount > 0 &&
    metrics.req_send >= rules.volume.lowReqSendBelow
  ) {
    return "uplifter";
  }

  if (
    metrics.profit_amount < 0 ||
    (metrics.profit_rate != null && metrics.profit_rate < rules.profitRate.warningBelow)
  ) {
    return "dragger";
  }

  return "neutral";
}

function analyzeRow(row, rules) {
  const reqAvailable = parseNumber(row.req_avalible);
  const reqSend = parseNumber(row.req_send);
  const charge = parseNumber(row.charge);
  const cost = parseNumber(row.cost);
  const profitRate = parsePercent(row.profit_rate);
  const sendRate = reqAvailable > 0 ? (reqSend / reqAvailable) * 100 : null;
  const metrics = {
    req_avalible: reqAvailable,
    req_send: reqSend,
    send_rate: sendRate == null ? null : Number(sendRate.toFixed(4)),
    bid_rate: parsePercent(row.bid_rate),
    resp_rate: parsePercent(row.resp_rate),
    win_rate: parsePercent(row.win_rate),
    conversion_rate: parsePercent(row.conversion_rate),
    cost,
    charge,
    profit_amount: Number((charge - cost).toFixed(4)),
    profit_rate: profitRate,
    thousand_req_charge: parseNumber(row.thousand_req_charge),
    thousand_send_charge: parseNumber(row.thousand_send_charge),
  };

  return {
    day: row.day,
    dsp_id: row.dsp_id,
    dsp_name: row.dsp_name,
    dsp_slot_id: row.dsp_slot_id,
    dsp_slot_name: row.dsp_slot_name,
    ad: row.ad,
    ad_name: row.ad_name,
    ad_group_name: row.ad_group_name,
    classification: classify(metrics, rules),
    metrics,
  };
}

function sortForScaleOpportunity(items) {
  const rank = { uplifter: 0, neutral: 1, dragger: 2 };
  return [...items].sort((left, right) => {
    const rankDiff = rank[left.classification] - rank[right.classification];
    if (rankDiff !== 0) return rankDiff;
    const profitRateDiff = (right.metrics.profit_rate ?? -Infinity) - (left.metrics.profit_rate ?? -Infinity);
    if (profitRateDiff !== 0) return profitRateDiff;
    const profitAmountDiff = right.metrics.profit_amount - left.metrics.profit_amount;
    if (profitAmountDiff !== 0) return profitAmountDiff;
    return right.metrics.req_send - left.metrics.req_send;
  });
}

function makeQueryResult(groupBy, request, result) {
  const responseData = result.data || {};
  const reportData = responseData.data || {};
  const rows = Array.isArray(reportData.item) ? reportData.item : [];
  return {
    groupBy,
    request,
    response: {
      httpStatus: result.status,
      ok: result.ok,
      code: responseData.code,
      message: responseData.message || responseData.msg,
      current: reportData.current,
      pageSize: reportData.pageSize,
      total: reportData.total,
    },
    summaryRows: rows.map(toSummaryRow),
    rows,
  };
}

function assertQueryOk(name, queryResult) {
  if (!queryResult.response.ok || queryResult.response.code !== 0) {
    throw new Error(
      `${name} query failed: HTTP ${queryResult.response.httpStatus}, code ${queryResult.response.code}, ${queryResult.response.message || ""}`.trim()
    );
  }
}

function buildMarkdown(payload) {
  const lines = [];
  const adItems = payload.analysis.adDetails;
  const slotItems = payload.analysis.slotSummary;
  const uplifters = adItems.filter((item) => item.classification === "uplifter");
  const draggers = adItems.filter((item) => item.classification === "dragger");

  lines.push("# DSP Slot Drilldown");
  lines.push("");
  lines.push(`Date range: ${payload.dateRange.start} to ${payload.dateRange.end}`);
  lines.push(`DSPs: ${payload.dsps.map((dsp) => `${dsp.id} ${dsp.name}`).join(", ")}`);
  lines.push(`DSP slots: ${payload.filters.dsp_slot_id.join(", ")}`);
  lines.push("Mode: read-only queryDspReport");
  lines.push("");

  lines.push("## Slot Summary");
  lines.push("");
  lines.push("| DSP | Slot | Profit | Profit Amount | Send Rate | Req Send | Charge | Cost | Class |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const item of slotItems) {
    lines.push(formatMarkdownRow(item, "slot"));
  }
  lines.push("");

  lines.push("## Scale Candidates");
  lines.push("");
  if (uplifters.length) {
    lines.push("| DSP | Slot | Ad | Profit | Profit Amount | Send Rate | Req Send | Charge | Cost | Class |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const item of uplifters) {
      lines.push(formatMarkdownRow(item, "ad"));
    }
  } else {
    lines.push("No uplifter rows found for the selected DSP slots.");
  }
  lines.push("");

  lines.push("## Draggers");
  lines.push("");
  if (draggers.length) {
    lines.push("| DSP | Slot | Ad | Profit | Profit Amount | Send Rate | Req Send | Charge | Cost | Class |");
    lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const item of draggers) {
      lines.push(formatMarkdownRow(item, "ad"));
    }
  } else {
    lines.push("No dragger rows found for the selected DSP slots.");
  }
  lines.push("");

  lines.push("## All Ad Details");
  lines.push("");
  lines.push("| DSP | Slot | Ad | Profit | Profit Amount | Send Rate | Req Send | Charge | Cost | Class |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const item of adItems) {
    lines.push(formatMarkdownRow(item, "ad"));
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function cleanCell(value) {
  return String(value ?? "-").replace(/\|/g, "/").replace(/\r?\n/g, " ");
}

function formatMarkdownRow(item, type) {
  const slot = `${cleanCell(item.dsp_slot_id)} ${cleanCell(item.dsp_slot_name)}`;
  const base = [
    `${cleanCell(item.dsp_id)} ${cleanCell(item.dsp_name)}`,
    slot,
  ];
  if (type === "ad") {
    base.push(`${cleanCell(item.ad)} ${cleanCell(item.ad_name || item.ad_group_name)}`);
  }
  base.push(
    formatPercent(item.metrics.profit_rate),
    formatNumber(item.metrics.profit_amount),
    formatPercent(item.metrics.send_rate),
    formatNumber(item.metrics.req_send),
    formatNumber(item.metrics.charge),
    formatNumber(item.metrics.cost),
    item.classification
  );
  return base.join(" | ");
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  if (!(await fileExists(AUTH_STATE_PATH))) {
    throw new Error("Missing .auth/dsp-report-state.json. Run `npm run auth` first.");
  }

  const args = parseArgs(process.argv.slice(2));
  const dspSlotIds = parseNumberList(args.dspSlot || args.dspSlots || process.env.DSP_SLOT_IDS);
  if (!dspSlotIds.length) {
    throw new Error(
      "Missing --dsp-slot. Pass one or more DSP slot IDs, for example: npm run drilldown -- --dsp 200001,200021 --dsp-slot 220013,222686 --date 2026-05-08"
    );
  }

  const configuredDsps = JSON.parse(await fs.readFile(DSP_CONFIG_PATH, "utf8"));
  const requestedDspIds = parseNumberList(args.dsp || args.dsps || process.env.DSP_IDS);
  const selectedDsps = pickDsps(configuredDsps, requestedDspIds);
  if (!selectedDsps.length) {
    throw new Error("No matching DSPs found. Check --dsp or config/dsps.json.");
  }

  const today = localDateString();
  const startDate = args.start || args.date || today;
  const endDate = args.end || args.date || startDate;
  const pageSize = Number(args.pageSize || 1000);
  const dspIds = selectedDsps.map((dsp) => dsp.id);
  const rules = JSON.parse(await fs.readFile(RULES_PATH, "utf8"));

  const slotSummaryRequest = buildRequestBody({
    dspIds,
    dspSlotIds,
    startDate,
    endDate,
    groupBy: "dat,dsp_id,dsp_slot_id",
    pageSize,
  });
  const adDetailsRequest = buildRequestBody({
    dspIds,
    dspSlotIds,
    startDate,
    endDate,
    groupBy: "dat,dsp_id,dsp_slot_id,ad_id",
    pageSize,
  });

  await fs.mkdir(SAMPLES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();

  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  if (await isLoginLikePage(page)) {
    await browser.close();
    throw new Error("The saved session looks expired. Run `npm run auth` again.");
  }

  const slotSummaryResult = makeQueryResult(
    "dat,dsp_id,dsp_slot_id",
    slotSummaryRequest,
    await queryReport(page, slotSummaryRequest)
  );
  const adDetailsResult = makeQueryResult(
    "dat,dsp_id,dsp_slot_id,ad_id",
    adDetailsRequest,
    await queryReport(page, adDetailsRequest)
  );
  await browser.close();

  assertQueryOk("Slot summary", slotSummaryResult);
  assertQueryOk("Ad details", adDetailsResult);

  const slotSummary = sortForScaleOpportunity(
    slotSummaryResult.summaryRows.map((row) => analyzeRow(row, rules))
  );
  const adDetails = sortForScaleOpportunity(
    adDetailsResult.summaryRows.map((row) => analyzeRow(row, rules))
  );
  const payload = {
    capturedAt: new Date().toISOString(),
    endpoint: "/api/queryDspReport",
    mode: "dsp-slot-ad-drilldown",
    dateRange: { start: startDate, end: endDate },
    dsps: selectedDsps,
    filters: {
      dsp_slot_id: dspSlotIds,
    },
    sort: "scale-opportunity: classification, profit_rate, profit_amount, req_send",
    queries: {
      slotSummary: slotSummaryResult,
      adDetails: adDetailsResult,
    },
    analysis: {
      slotSummary,
      adDetails,
    },
  };

  const stamp = timestamp();
  const jsonPath = path.join(
    SAMPLES_DIR,
    `dsp-report-drilldown-${startDate}-${endDate}-${stamp}.json`
  );
  const mdPath = path.join(
    SAMPLES_DIR,
    `dsp-report-drilldown-${startDate}-${endDate}-${stamp}.md`
  );
  await writeJson(jsonPath, payload);
  await fs.writeFile(mdPath, buildMarkdown(payload), "utf8");

  const uplifters = adDetails.filter((item) => item.classification === "uplifter");
  const draggers = adDetails.filter((item) => item.classification === "dragger");
  console.log(`DSPs: ${selectedDsps.map((dsp) => `${dsp.id} ${dsp.name}`).join(", ")}`);
  console.log(`DSP slots: ${dspSlotIds.join(", ")}`);
  console.log(`Date range: ${startDate} to ${endDate}`);
  console.log(`Slot rows: ${slotSummary.length}`);
  console.log(`Ad rows: ${adDetails.length}`);
  console.log(`Uplifters: ${uplifters.length}`);
  console.log(`Draggers: ${draggers.length}`);
  for (const item of uplifters.slice(0, 5)) {
    console.log(
      `UP ${item.dsp_id}/${item.dsp_slot_id}/${item.ad}: profit ${formatPercent(
        item.metrics.profit_rate
      )}, amount ${formatNumber(item.metrics.profit_amount)}, send ${formatNumber(
        item.metrics.req_send
      )}`
    );
  }
  for (const item of draggers.slice(0, 5)) {
    console.log(
      `DOWN ${item.dsp_id}/${item.dsp_slot_id}/${item.ad}: profit ${formatPercent(
        item.metrics.profit_rate
      )}, amount ${formatNumber(item.metrics.profit_amount)}, send ${formatNumber(
        item.metrics.req_send
      )}`
    );
  }
  console.log(`Wrote ${path.relative(ROOT_DIR, jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, mdPath)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
