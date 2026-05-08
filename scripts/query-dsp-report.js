const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT_DIR = path.resolve(__dirname, "..");
const REPORT_URL = "https://adm.adbiding.cn/report/dspReport";
const AUTH_STATE_PATH = path.join(ROOT_DIR, ".auth", "dsp-report-state.json");
const DSP_CONFIG_PATH = path.join(ROOT_DIR, "config", "dsps.json");
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

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  if (!(await fileExists(AUTH_STATE_PATH))) {
    throw new Error("Missing .auth/dsp-report-state.json. Run `npm run auth` first.");
  }

  const args = parseArgs(process.argv.slice(2));
  const configuredDsps = JSON.parse(await fs.readFile(DSP_CONFIG_PATH, "utf8"));
  const requestedDspIds = parseNumberList(args.dsp || args.dsps || process.env.DSP_IDS);
  const dspSlotIds = parseNumberList(
    args.dspSlot || args.dspSlots || process.env.DSP_SLOT_IDS
  );
  const selectedDsps = pickDsps(configuredDsps, requestedDspIds);

  if (!selectedDsps.length) {
    throw new Error("No matching DSPs found. Check --dsp or config/dsps.json.");
  }

  const today = localDateString();
  const startDate = args.start || args.date || today;
  const endDate = args.end || args.date || startDate;
  const groupBy = args.groupBy || "dat,dsp_id";
  const pageSize = Number(args.pageSize || 200);
  const dspIds = selectedDsps.map((dsp) => dsp.id);
  const requestBody = buildRequestBody({
    dspIds,
    dspSlotIds,
    startDate,
    endDate,
    groupBy,
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

  const result = await queryReport(page, requestBody);
  await browser.close();

  const responseData = result.data || {};
  const reportData = responseData.data || {};
  const rows = Array.isArray(reportData.item) ? reportData.item : [];
  const payload = {
    capturedAt: new Date().toISOString(),
    endpoint: "/api/queryDspReport",
    dateRange: { start: startDate, end: endDate },
    groupBy,
    dsps: selectedDsps,
    filters: {
      dsp_slot_id: dspSlotIds,
    },
    request: requestBody,
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

  const outputPath =
    args.out ||
    path.join(
      SAMPLES_DIR,
      `dsp-report-query-${startDate}-${endDate}-${timestamp()}.json`
    );
  const resolvedOutputPath = path.resolve(ROOT_DIR, outputPath);
  await writeJson(resolvedOutputPath, payload);

  console.log(`DSPs: ${selectedDsps.map((dsp) => `${dsp.id} ${dsp.name}`).join(", ")}`);
  console.log(`Date range: ${startDate} to ${endDate}`);
  if (dspSlotIds.length) {
    console.log(`DSP slots: ${dspSlotIds.join(", ")}`);
  }
  console.log(`Rows: ${rows.length} / total ${reportData.total || 0}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, resolvedOutputPath)}`);

  if (responseData.code !== 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
