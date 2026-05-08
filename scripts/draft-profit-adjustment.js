const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
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

function parsePercent(value) {
  if (value == null || value === "" || value === "-") return null;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPercent(value) {
  return value == null ? "-" : `${Number(value.toFixed(2))}%`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

function parseNumberList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

async function findLatestDrilldownFile() {
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^dsp-report-drilldown-.*\.json$/.test(entry.name)) continue;
    const filePath = path.join(SAMPLES_DIR, entry.name);
    const stat = await fs.stat(filePath);
    candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) {
    throw new Error("No drilldown report found. Run `npm run drilldown` first.");
  }
  return candidates[0].filePath;
}

function buildDraftItems(rows, dspSlotIds, increase, mode) {
  const selectedSlots = new Set(dspSlotIds);
  return rows
    .filter((row) => !selectedSlots.size || selectedSlots.has(Number(row.dsp_slot_id)))
    .map((row) => {
      const currentProfitRate = parsePercent(row.metrics?.profit_rate ?? row.profit_rate);
      const targetProfitRate =
        currentProfitRate == null
          ? null
          : mode === "relative"
            ? currentProfitRate * (1 + increase / 100)
            : currentProfitRate + increase;

      return {
        day: row.day,
        dsp_id: row.dsp_id,
        dsp_name: row.dsp_name,
        dsp_slot_id: row.dsp_slot_id,
        dsp_slot_name: row.dsp_slot_name,
        ad: row.ad,
        ad_name: row.ad_name,
        ad_group_name: row.ad_group_name,
        current_profit_rate: currentProfitRate,
        target_profit_rate: targetProfitRate == null ? null : Number(targetProfitRate.toFixed(4)),
        increase,
        increase_mode: mode,
        req_send: row.metrics?.req_send,
        charge: row.metrics?.charge,
        cost: row.metrics?.cost,
        profit_amount: row.metrics?.profit_amount,
        status: currentProfitRate == null ? "needs-current-profit-rate" : "draft",
      };
    })
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "draft" ? -1 : 1;
      return (right.req_send || 0) - (left.req_send || 0);
    });
}

function cleanCell(value) {
  return String(value ?? "-").replace(/\|/g, "/").replace(/\r?\n/g, " ");
}

function buildMarkdown(payload) {
  const lines = [];
  lines.push("# DSP Profit Adjustment Draft");
  lines.push("");
  lines.push("Status: draft only, no change submitted");
  lines.push(`Source: ${payload.source}`);
  lines.push(`DSP slots: ${payload.filters.dsp_slot_id.join(", ")}`);
  lines.push(`Increase: ${payload.increase}${payload.increase_mode === "relative" ? "% relative" : " percentage points"}`);
  lines.push("");
  lines.push("| DSP | Slot | Ad | Current Profit | Target Profit | Req Send | Profit Amount | Status |");
  lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const item of payload.items) {
    lines.push(
      [
        `${cleanCell(item.dsp_id)} ${cleanCell(item.dsp_name)}`,
        `${cleanCell(item.dsp_slot_id)} ${cleanCell(item.dsp_slot_name)}`,
        `${cleanCell(item.ad)} ${cleanCell(item.ad_name || item.ad_group_name)}`,
        formatPercent(item.current_profit_rate),
        formatPercent(item.target_profit_rate),
        formatNumber(item.req_send),
        formatNumber(item.profit_amount),
        item.status,
      ].join(" | ")
    );
  }
  lines.push("");
  lines.push("This file is a confirmation draft. It does not contain cookies, tokens, passwords, or a write request payload.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourcePath = args.file
    ? path.resolve(ROOT_DIR, args.file)
    : await findLatestDrilldownFile();
  const dspSlotIds = parseNumberList(args.dspSlot || args.dspSlots || process.env.DSP_SLOT_IDS);
  const increase = Number(args.increase || 10);
  const mode = args.mode === "relative" ? "relative" : "points";

  if (!Number.isFinite(increase)) {
    throw new Error("Invalid --increase value.");
  }

  const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const rows = source.analysis?.adDetails || source.queries?.adDetails?.summaryRows || [];
  if (!rows.length) {
    throw new Error("No ad detail rows found in the drilldown file.");
  }

  const inferredSlots = source.filters?.dsp_slot_id || [];
  const selectedSlotIds = dspSlotIds.length ? dspSlotIds : inferredSlots;
  if (!selectedSlotIds.length) {
    throw new Error("Missing --dsp-slot and no dsp_slot_id found in the drilldown file.");
  }

  const items = buildDraftItems(rows, selectedSlotIds, increase, mode);
  if (!items.length) {
    throw new Error("No matching ad rows found for the selected dsp_slot_id.");
  }

  const payload = {
    capturedAt: new Date().toISOString(),
    mode: "profit-rate-adjustment-draft",
    source: path.relative(ROOT_DIR, sourcePath),
    note: "Draft only. profit_rate is a report metric; confirm the writable business field and endpoint before applying.",
    filters: {
      dsp_slot_id: selectedSlotIds,
    },
    increase,
    increase_mode: mode,
    calculation:
      mode === "relative"
        ? "target_profit_rate = current_profit_rate * (1 + increase / 100)"
        : "target_profit_rate = current_profit_rate + increase",
    items,
  };

  const stamp = timestamp();
  const jsonPath = path.join(SAMPLES_DIR, `dsp-profit-adjustment-draft-${stamp}.json`);
  const mdPath = path.join(SAMPLES_DIR, `dsp-profit-adjustment-draft-${stamp}.md`);
  await writeJson(jsonPath, payload);
  await fs.writeFile(mdPath, buildMarkdown(payload), "utf8");

  const ready = items.filter((item) => item.status === "draft").length;
  const missing = items.length - ready;
  console.log(`Source: ${path.relative(ROOT_DIR, sourcePath)}`);
  console.log(`DSP slots: ${selectedSlotIds.join(", ")}`);
  console.log(`Draft rows: ${ready}`);
  console.log(`Rows without current profit_rate: ${missing}`);
  for (const item of items.slice(0, 8)) {
    console.log(
      `${item.ad}: ${formatPercent(item.current_profit_rate)} -> ${formatPercent(
        item.target_profit_rate
      )} | send ${formatNumber(item.req_send)} | ${item.status}`
    );
  }
  console.log(`Wrote ${path.relative(ROOT_DIR, jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, mdPath)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
