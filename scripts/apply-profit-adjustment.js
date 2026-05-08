const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT_DIR = path.resolve(__dirname, "..");
const REPORT_URL = "https://adm.adbiding.cn/report/dspReport";
const AUTH_STATE_PATH = path.join(ROOT_DIR, ".auth", "dsp-report-state.json");
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

function basisPointsToPercent(value) {
  return Number((Number(value || 0) / 100).toFixed(4));
}

function percentToBasisPoints(value) {
  return Math.round(Number(value) * 100);
}

function formatPercentFromBasisPoints(value) {
  if (value == null) return "-";
  return `${basisPointsToPercent(value)}%`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

async function findLatestDraftFile() {
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^dsp-profit-adjustment-draft-.*\.json$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(SAMPLES_DIR, entry.name);
    const stat = await fs.stat(filePath);
    candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) {
    throw new Error("No profit adjustment draft found. Run `npm run draft:profit` first.");
  }
  return candidates[0].filePath;
}

async function isLoginLikePage(page) {
  if (/login|signin|auth/i.test(page.url())) return true;
  return page.evaluate(() => {
    const hasPasswordInput = Boolean(document.querySelector("input[type='password']"));
    const text = document.body?.innerText || "";
    return hasPasswordInput || /login|sign in|password/i.test(text);
  });
}

async function apiRequest(page, method, url, body) {
  return page.evaluate(
    async ({ method: requestMethod, url: requestUrl, body: requestBody }) => {
      const token = localStorage.getItem("token");
      if (!token) {
        return {
          status: 401,
          ok: false,
          data: { code: 401, message: "missing token in localStorage" },
        };
      }

      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: requestBody == null ? undefined : JSON.stringify(requestBody),
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
    },
    { method, url, body }
  );
}

function redactDetailForOutput(detail) {
  return {
    ad_id: detail.ad_id,
    name: detail.name,
    dsp_id: detail.dsp_id,
    dsp_slot_id: detail.dsp_slot_id,
    status: detail.status,
    qps_limit: detail.qps_limit,
    traffic_strategy: Array.isArray(detail.traffic_strategy)
      ? detail.traffic_strategy.map((strategy) => ({
          id: strategy.id,
          strategy_type: strategy.strategy_type,
          charge_strategy_type: strategy.charge_strategy_type,
          profit_ratio: strategy.profit_ratio,
          status: strategy.status,
        }))
      : [],
  };
}

async function queryAdInfoFallback(page, adId) {
  const result = await apiRequest(page, "POST", "/api/queryAdInfo", {
    current: 1,
    pageSize: 5,
    sorter: { ad_id: "descend" },
    name_search: "",
    filter: {
      ad_id: [Number(adId)],
      test: [0, 1],
    },
  });
  const item = result.data?.data?.item;
  return Array.isArray(item) ? item.find((row) => Number(row.ad_id) === Number(adId)) : null;
}

function applyProfitRatioIncrease(detail, increaseBasisPoints, minBasisPoints, maxBasisPoints) {
  const next = JSON.parse(JSON.stringify(detail));
  const strategies = Array.isArray(next.traffic_strategy) ? next.traffic_strategy : [];
  const changes = [];

  for (const strategy of strategies) {
    if (!Number.isFinite(Number(strategy.profit_ratio))) continue;
    const currentProfitRatio = Number(strategy.profit_ratio);
    const unclampedTarget = currentProfitRatio + increaseBasisPoints;
    const targetProfitRatio = Math.min(
      Math.max(unclampedTarget, minBasisPoints),
      maxBasisPoints
    );
    strategy.profit_ratio = targetProfitRatio;
    changes.push({
      strategy_id: strategy.id,
      strategy_type: strategy.strategy_type,
      charge_strategy_type: strategy.charge_strategy_type,
      current_profit_ratio: currentProfitRatio,
      target_profit_ratio: targetProfitRatio,
      delta_profit_ratio: targetProfitRatio - currentProfitRatio,
      requested_delta_profit_ratio: increaseBasisPoints,
    });
  }

  return { next, changes };
}

function buildMarkdown(payload) {
  const lines = [];
  lines.push("# DSP Profit Adjustment Apply Report");
  lines.push("");
  lines.push(`Mode: ${payload.apply ? "apply" : "dry-run"}`);
  lines.push(`Source: ${payload.source}`);
  lines.push(`DSP slots: ${payload.filters.dsp_slot_id.join(", ")}`);
  lines.push(`Increase: ${payload.increase_points} percentage points`);
  lines.push(`Endpoint: POST /api/adInfo/:id`);
  lines.push("");
  lines.push("| Ad | Current Config Profit | Target Config Profit | Delta | Status | Message |");
  lines.push("| --- | ---: | ---: | ---: | --- | --- |");
  for (const item of payload.items) {
    const firstChange = item.changes[0];
    lines.push(
      [
        `${item.ad_id} ${cleanCell(item.name)}`,
        formatPercentFromBasisPoints(firstChange?.current_profit_ratio),
        formatPercentFromBasisPoints(firstChange?.target_profit_ratio),
        formatPercentFromBasisPoints(firstChange?.delta_profit_ratio),
        item.status,
        cleanCell(item.message || ""),
      ].join(" | ")
    );
  }
  lines.push("");
  lines.push("The report stores only redacted config snapshots and responses. It does not store cookies, tokens, passwords, or authorization headers.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function cleanCell(value) {
  return String(value ?? "-").replace(/\|/g, "/").replace(/\r?\n/g, " ");
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function pickDraftItems(draft, dspSlotIds) {
  const selectedSlots = new Set(dspSlotIds);
  return (draft.items || [])
    .filter((item) => item.status === "draft")
    .filter((item) => !selectedSlots.size || selectedSlots.has(Number(item.dsp_slot_id)))
    .map((item) => ({
      ad: Number(item.ad),
      ad_name: item.ad_name,
      dsp_slot_id: Number(item.dsp_slot_id),
      report_current_profit_rate: item.current_profit_rate,
      report_target_profit_rate: item.target_profit_rate,
      req_send: item.req_send,
    }))
    .filter((item) => Number.isFinite(item.ad));
}

async function main() {
  if (!(await fileExists(AUTH_STATE_PATH))) {
    throw new Error("Missing .auth/dsp-report-state.json. Run `npm run auth` first.");
  }

  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args.file
    ? path.resolve(ROOT_DIR, args.file)
    : await findLatestDraftFile();
  const draft = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const dspSlotIds = parseNumberList(args.dspSlot || args.dspSlots || process.env.DSP_SLOT_IDS);
  const selectedSlotIds = dspSlotIds.length ? dspSlotIds : draft.filters?.dsp_slot_id || [];
  if (!selectedSlotIds.length) {
    throw new Error("Missing --dsp-slot and no dsp_slot_id found in the draft file.");
  }

  const increasePoints = Number(args.increase || draft.increase || 10);
  const minProfitPoints = Number(args.minProfit || 0);
  const maxProfitPoints = Number(args.maxProfit || 100);
  if (!Number.isFinite(increasePoints) || increasePoints === 0) {
    throw new Error("Invalid --increase value.");
  }
  if (!Number.isFinite(minProfitPoints)) {
    throw new Error("Invalid --min-profit value.");
  }
  if (!Number.isFinite(maxProfitPoints) || maxProfitPoints <= 0) {
    throw new Error("Invalid --max-profit value.");
  }

  const shouldApply = Boolean(args.apply);
  const confirm = String(args.confirm || "");
  if (shouldApply && confirm !== selectedSlotIds.join(",")) {
    throw new Error(
      `Refusing to apply. Re-run with --apply --confirm ${selectedSlotIds.join(",")}`
    );
  }

  const draftItems = pickDraftItems(draft, selectedSlotIds);
  if (!draftItems.length) {
    throw new Error("No draft rows with current profit_rate found for the selected dsp_slot_id.");
  }

  const increaseBasisPoints = percentToBasisPoints(increasePoints);
  const minBasisPoints = percentToBasisPoints(minProfitPoints);
  const maxBasisPoints = percentToBasisPoints(maxProfitPoints);

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

  const items = [];
  for (const draftItem of draftItems) {
    const getResult = await apiRequest(page, "GET", `/api/adInfo/${draftItem.ad}`);
    const detail = getResult.data?.data;
    if (!getResult.ok || getResult.data?.code !== 0 || !detail) {
      const fallback = await queryAdInfoFallback(page, draftItem.ad).catch(() => null);
      if (fallback?.test) {
        items.push({
          ad_id: draftItem.ad,
          name: fallback.name || draftItem.ad_name,
          dsp_id: fallback.dsp_id,
          dsp_slot_id: fallback.dsp_slot_id || draftItem.dsp_slot_id,
          status: "skipped-test-ad",
          message: "Test ad is not editable through POST /api/adInfo/:id.",
          current: {
            ad_id: fallback.ad_id,
            name: fallback.name,
            dsp_id: fallback.dsp_id,
            dsp_slot_id: fallback.dsp_slot_id,
            test: fallback.test,
            status: fallback.status,
          },
          changes: [],
        });
        continue;
      }

      items.push({
        ad_id: draftItem.ad,
        name: draftItem.ad_name,
        dsp_slot_id: draftItem.dsp_slot_id,
        status: "failed-read",
        message: getResult.data?.message || `HTTP ${getResult.status}`,
        changes: [],
      });
      continue;
    }

    if (Number(detail.dsp_slot_id) !== Number(draftItem.dsp_slot_id)) {
      items.push({
        ad_id: draftItem.ad,
        name: detail.name || draftItem.ad_name,
        dsp_slot_id: detail.dsp_slot_id,
        status: "skipped-slot-mismatch",
        message: `Expected slot ${draftItem.dsp_slot_id}, got ${detail.dsp_slot_id}`,
        current: redactDetailForOutput(detail),
        changes: [],
      });
      continue;
    }

    const { next, changes } = applyProfitRatioIncrease(
      detail,
      increaseBasisPoints,
      minBasisPoints,
      maxBasisPoints
    );
    if (!changes.length) {
      items.push({
        ad_id: draftItem.ad,
        name: detail.name || draftItem.ad_name,
        dsp_slot_id: detail.dsp_slot_id,
        status: "skipped-no-profit-ratio",
        message: "No numeric traffic_strategy[].profit_ratio found.",
        current: redactDetailForOutput(detail),
        changes,
      });
      continue;
    }

    let postResult = null;
    if (shouldApply) {
      postResult = await apiRequest(page, "POST", `/api/adInfo/${draftItem.ad}`, next);
    }

    items.push({
      ad_id: draftItem.ad,
      name: detail.name || draftItem.ad_name,
      dsp_id: detail.dsp_id,
      dsp_slot_id: detail.dsp_slot_id,
      report_current_profit_rate: draftItem.report_current_profit_rate,
      report_target_profit_rate: draftItem.report_target_profit_rate,
      req_send: draftItem.req_send,
      status: shouldApply
        ? postResult?.ok && postResult.data?.code === 0
          ? "applied"
          : "failed-apply"
        : "dry-run",
      message: shouldApply ? postResult?.data?.message || postResult?.data?.msg || "" : "",
      current: redactDetailForOutput(detail),
      next: redactDetailForOutput(next),
      changes,
      response: shouldApply
        ? {
            httpStatus: postResult.status,
            ok: postResult.ok,
            code: postResult.data?.code,
            message: postResult.data?.message || postResult.data?.msg,
          }
        : undefined,
    });
  }

  await browser.close();

  const payload = {
    capturedAt: new Date().toISOString(),
    mode: "profit-ratio-adjustment",
    apply: shouldApply,
    source: path.relative(ROOT_DIR, sourcePath),
    endpoint: "POST /api/adInfo/:id",
    filters: {
      dsp_slot_id: selectedSlotIds,
    },
    increase_points: increasePoints,
    increase_basis_points: increaseBasisPoints,
    min_profit_points: minProfitPoints,
    max_profit_points: maxProfitPoints,
    note: "This script changes traffic_strategy[].profit_ratio, the editable config behind report profit_rate.",
    items,
  };

  const stamp = timestamp();
  const prefix = shouldApply ? "dsp-profit-adjustment-apply" : "dsp-profit-adjustment-dry-run";
  const jsonPath = path.join(SAMPLES_DIR, `${prefix}-${stamp}.json`);
  const mdPath = path.join(SAMPLES_DIR, `${prefix}-${stamp}.md`);
  await writeJson(jsonPath, payload);
  await fs.writeFile(mdPath, buildMarkdown(payload), "utf8");

  const statusCounts = items.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, {});
  console.log(`Mode: ${shouldApply ? "apply" : "dry-run"}`);
  console.log(`DSP slots: ${selectedSlotIds.join(", ")}`);
  console.log(`Rows: ${items.length}`);
  console.log(`Status: ${Object.entries(statusCounts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
  for (const item of items.slice(0, 8)) {
    const change = item.changes[0];
    console.log(
      `${item.ad_id}: ${formatPercentFromBasisPoints(
        change?.current_profit_ratio
      )} -> ${formatPercentFromBasisPoints(change?.target_profit_ratio)} | send ${formatNumber(
        item.req_send
      )} | ${item.status}`
    );
  }
  console.log(`Wrote ${path.relative(ROOT_DIR, jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, mdPath)}`);

  if (items.some((item) => item.status.startsWith("failed"))) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
