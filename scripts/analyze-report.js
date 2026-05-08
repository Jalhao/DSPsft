const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SAMPLES_DIR = path.join(ROOT_DIR, "samples");
const RULES_PATH = path.join(ROOT_DIR, "config", "report-rules.json");

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

function parseNumber(value) {
  if (value == null || value === "" || value === "-") return 0;
  if (typeof value === "number") return value;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value) {
  return value == null ? "-" : `${Number(value.toFixed(2))}%`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

async function findLatestQueryFile() {
  const entries = await fs.readdir(SAMPLES_DIR, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^dsp-report-query-.*\.json$/.test(entry.name)) continue;
    const filePath = path.join(SAMPLES_DIR, entry.name);
    const stat = await fs.stat(filePath);
    candidates.push({ filePath, mtimeMs: stat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) {
    throw new Error("No query report found. Run `npm run report` first.");
  }
  return candidates[0].filePath;
}

function addFinding(findings, severity, type, message, suggestion) {
  findings.push({ severity, type, message, suggestion });
}

function analyzeRow(row, rules) {
  const reqAvailable = parseNumber(row.req_avalible);
  const reqSend = parseNumber(row.req_send);
  const sendRate = reqAvailable > 0 ? (reqSend / reqAvailable) * 100 : null;
  const profitRate = parsePercent(row.profit_rate);
  const bidRate = parsePercent(row.bid_rate);
  const conversionRate = parsePercent(row.conversion_rate);
  const charge = parseNumber(row.charge);
  const cost = parseNumber(row.cost);
  const findings = [];

  if (profitRate != null && profitRate < rules.profitRate.criticalBelow) {
    addFinding(
      findings,
      "critical",
      "profit_rate",
      `Profit rate is ${formatPercent(profitRate)}, below ${rules.profitRate.criticalBelow}%.`,
      `Consider reducing QPS by ${rules.suggestedAdjustment.qpsDecreasePercent}% or raising margin.`
    );
  } else if (profitRate != null && profitRate < rules.profitRate.warningBelow) {
    addFinding(
      findings,
      "warning",
      "profit_rate",
      `Profit rate is ${formatPercent(profitRate)}, below ${rules.profitRate.warningBelow}%.`,
      "Watch closely before increasing traffic."
    );
  } else if (
    profitRate != null &&
    profitRate >= rules.profitRate.goodAtOrAbove &&
    reqSend >= rules.volume.activeReqSendAtOrAbove
  ) {
    addFinding(
      findings,
      "positive",
      "profit_rate",
      `Profit rate is ${formatPercent(profitRate)} with active volume.`,
      `Candidate for a cautious QPS increase of ${rules.suggestedAdjustment.qpsIncreasePercent}%.`
    );
  }

  if (sendRate != null && sendRate < rules.sendRate.warningBelow) {
    addFinding(
      findings,
      "warning",
      "send_rate",
      `Send rate is ${formatPercent(sendRate)}, below ${rules.sendRate.warningBelow}%.`,
      "Check traffic forwarding constraints, DSP slot limits, or filtering."
    );
  }

  if (bidRate != null && bidRate < rules.bidRate.warningBelow) {
    addFinding(
      findings,
      "warning",
      "bid_rate",
      `Bid rate is ${formatPercent(bidRate)}, below ${rules.bidRate.warningBelow}%.`,
      "Check whether DSP demand is weak or targeting is too narrow."
    );
  }

  if (conversionRate != null && conversionRate < rules.conversionRate.warningBelow) {
    addFinding(
      findings,
      "warning",
      "conversion_rate",
      `Conversion rate is ${formatPercent(conversionRate)}, below ${rules.conversionRate.warningBelow}%.`,
      "Avoid increasing traffic until downstream quality is checked."
    );
  }

  if (reqSend > 0 && reqSend < rules.volume.lowReqSendBelow) {
    addFinding(
      findings,
      "info",
      "volume",
      `Req send is ${formatNumber(reqSend)}, below ${formatNumber(rules.volume.lowReqSendBelow)}.`,
      "Volume is low; treat rate metrics as less stable."
    );
  }

  if (!findings.length) {
    addFinding(
      findings,
      "normal",
      "baseline",
      "No rule-based risk detected.",
      "Keep current settings."
    );
  }

  const severityRank = { critical: 4, warning: 3, info: 2, positive: 1, normal: 0 };
  const topSeverity = findings.reduce(
    (top, finding) =>
      severityRank[finding.severity] > severityRank[top] ? finding.severity : top,
    "normal"
  );

  return {
    day: row.day,
    dsp_id: row.dsp_id,
    dsp_name: row.dsp_name,
    metrics: {
      req_avalible: reqAvailable,
      req_send: reqSend,
      send_rate: sendRate == null ? null : Number(sendRate.toFixed(4)),
      bid_rate: bidRate,
      resp_rate: parsePercent(row.resp_rate),
      win_rate: parsePercent(row.win_rate),
      conversion_rate: conversionRate,
      cost,
      charge,
      profit_rate: profitRate,
      thousand_req_charge: parseNumber(row.thousand_req_charge),
      thousand_send_charge: parseNumber(row.thousand_send_charge),
    },
    severity: topSeverity,
    findings,
  };
}

function buildMarkdown(payload, analysis, sourcePath) {
  const lines = [];
  lines.push("# DSP Report Analysis");
  lines.push("");
  lines.push(`Source: ${path.relative(ROOT_DIR, sourcePath)}`);
  lines.push(`Date range: ${payload.dateRange?.start || "-"} to ${payload.dateRange?.end || "-"}`);
  lines.push(`Group by: ${payload.groupBy || "-"}`);
  lines.push("");
  lines.push("| DSP | Profit | Send Rate | Req Send | Charge | Cost | Severity | Suggestion |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |");
  for (const item of analysis.items) {
    const suggestion = item.findings[0]?.suggestion || "";
    lines.push(
      [
        `${item.dsp_id} ${item.dsp_name}`,
        formatPercent(item.metrics.profit_rate),
        formatPercent(item.metrics.send_rate),
        formatNumber(item.metrics.req_send),
        formatNumber(item.metrics.charge),
        formatNumber(item.metrics.cost),
        item.severity,
        suggestion,
      ].join(" | ")
    );
  }
  lines.push("");
  lines.push("## Details");
  for (const item of analysis.items) {
    lines.push("");
    lines.push(`### ${item.dsp_id} ${item.dsp_name}`);
    for (const finding of item.findings) {
      lines.push(`- [${finding.severity}] ${finding.message} ${finding.suggestion}`);
    }
  }
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
    : await findLatestQueryFile();
  const rules = JSON.parse(await fs.readFile(RULES_PATH, "utf8"));
  const payload = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const rows = Array.isArray(payload.summaryRows) ? payload.summaryRows : payload.rows || [];

  if (!rows.length) {
    throw new Error("No rows found in the report file.");
  }

  const analysis = {
    capturedAt: new Date().toISOString(),
    source: path.relative(ROOT_DIR, sourcePath),
    dateRange: payload.dateRange,
    groupBy: payload.groupBy,
    rules,
    items: rows.map((row) => analyzeRow(row, rules)),
  };

  const stamp = timestamp();
  const jsonPath = path.join(SAMPLES_DIR, `dsp-report-analysis-${stamp}.json`);
  const mdPath = path.join(SAMPLES_DIR, `dsp-report-analysis-${stamp}.md`);
  await writeJson(jsonPath, analysis);
  await fs.writeFile(mdPath, buildMarkdown(payload, analysis, sourcePath), "utf8");

  console.log(`Analyzed ${rows.length} rows from ${path.relative(ROOT_DIR, sourcePath)}`);
  for (const item of analysis.items) {
    const first = item.findings[0];
    console.log(
      `${item.dsp_id} ${item.dsp_name}: ${item.severity} | profit ${formatPercent(
        item.metrics.profit_rate
      )} | send rate ${formatPercent(item.metrics.send_rate)} | ${first.suggestion}`
    );
  }
  console.log(`Wrote ${path.relative(ROOT_DIR, jsonPath)}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, mdPath)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
