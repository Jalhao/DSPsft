const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT_DIR = path.resolve(__dirname, "..");
const REPORT_URL = "https://adm.adbiding.cn/report/dspReport";
const AUTH_STATE_PATH = path.join(ROOT_DIR, ".auth", "dsp-report-state.json");
const DSP_CONFIG_PATH = path.join(ROOT_DIR, "config", "dsps.json");
const SAMPLES_DIR = path.join(ROOT_DIR, "samples");
const MAX_TEXT = 180;
const MAX_BODY = 12000;
const MAX_ROWS_PER_TABLE = 80;
const MAX_VISIBLE_TEXT = 350;
const SENSITIVE_KEY = /cookie|authorization|token|secret|password|passwd|session|csrf/i;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
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

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = MAX_TEXT) {
  const text = normalize(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function redactText(value) {
  return String(value || "")
    .replace(
      /(["']?(?:token|secret|password|passwd|authorization|cookie|session|csrf)["']?\s*[:=]\s*)["']?[^"',&\s}]+["']?/gi,
      "$1[REDACTED]"
    )
    .replace(
      /([?&](?:token|secret|password|passwd|authorization|cookie|session|csrf)=)[^&#\s"']+/gi,
      "$1[REDACTED]"
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactObject(item),
    ])
  );
}

function redactHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : truncate(redactText(value), 500),
    ])
  );
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeBody(body) {
  if (!body) return null;

  const parsed = tryParseJson(body);
  if (parsed) {
    return {
      type: "json",
      value: redactObject(parsed),
    };
  }

  try {
    const params = new URLSearchParams(body);
    const entries = [...params.entries()];
    if (entries.length) {
      return {
        type: "URLSearchParams",
        fields: entries.map(([key, value]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : truncate(value, 1000),
        ]),
      };
    }
  } catch {
    // Keep the text preview below.
  }

  return {
    type: "text",
    value: truncate(redactText(body), MAX_BODY),
  };
}

function isInterestingRequest(request) {
  const url = request.url();
  const type = request.resourceType();
  return (
    ["xhr", "fetch", "document"].includes(type) ||
    /\/api\/|\/report\/|\/dsp|\/admin|\/adm|graphql|ajax/i.test(url)
  );
}

async function responsePreview(response) {
  const headers = await response.allHeaders().catch(() => ({}));
  const contentType = headers["content-type"] || "";
  if (!/json|text|javascript|xml|plain/i.test(contentType)) {
    return { skipped: `content-type ${contentType || "unknown"}` };
  }

  try {
    const text = await response.text();
    const parsed = tryParseJson(text);
    if (parsed) {
      return {
        type: "json",
        value: redactObject(parsed),
      };
    }
    return {
      type: "text",
      value: truncate(redactText(text), MAX_BODY),
    };
  } catch (error) {
    return { error: String(error) };
  }
}

function startNetworkRecorder(page) {
  const records = [];
  const requestToRecord = new Map();

  page.on("request", (request) => {
    if (!isInterestingRequest(request)) return;

    const record = {
      startedAt: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      request: {
        headers: redactHeaders(request.headers()),
        body: sanitizeBody(request.postData()),
      },
    };

    requestToRecord.set(request, record);
    records.push(record);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const record = requestToRecord.get(request);
    if (!record) return;

    record.status = response.status();
    record.ok = response.ok();
    record.responseHeaders = redactHeaders(await response.allHeaders().catch(() => ({})));
    record.response = await responsePreview(response);
  });

  page.on("requestfailed", (request) => {
    const record = requestToRecord.get(request);
    if (!record) return;
    record.failure = request.failure();
  });

  return records;
}

async function isLoginLikePage(page) {
  const url = page.url();
  if (/login|signin|auth/i.test(url)) return true;

  return page.evaluate(() => {
    const fields = [...document.querySelectorAll("input")].map((input) => ({
      type: input.type,
      name: input.name,
      placeholder: input.placeholder,
    }));
    const hasPassword = fields.some((field) => field.type === "password");
    const pageText = document.body?.innerText || "";
    return hasPassword || /登录|登陆|密码|验证码|sign in|login/i.test(pageText);
  });
}

async function trySelectDefaultDsps(page, dsps) {
  const result = await page.evaluate((items) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const matches = (value) => {
      const text = normalize(value).toLowerCase();
      return items.some(
        (item) =>
          text.includes(String(item.id).toLowerCase()) ||
          text.includes(String(item.name).toLowerCase())
      );
    };
    const eventOptions = { bubbles: true };

    const selectCandidates = [...document.querySelectorAll("select")].filter(visible);
    for (const select of selectCandidates) {
      const options = [...select.options];
      const matchingOptions = options.filter(
        (option) => matches(option.value) || matches(option.textContent)
      );

      if (!matchingOptions.length) continue;

      if (!select.multiple && matchingOptions.length > 1) {
        return {
          status: "partial",
          method: "native-select",
          reason: "matched select is single-choice",
          selected: [],
          matchedOptions: matchingOptions.map((option) => ({
            value: option.value,
            text: normalize(option.textContent),
          })),
        };
      }

      for (const option of matchingOptions) {
        option.selected = true;
      }
      select.dispatchEvent(new Event("input", eventOptions));
      select.dispatchEvent(new Event("change", eventOptions));

      return {
        status: "selected",
        method: "native-select",
        selected: matchingOptions.map((option) => ({
          value: option.value,
          text: normalize(option.textContent),
        })),
      };
    }

    return {
      status: "not-selected",
      method: "none",
      reason: "no visible native select matched the configured DSP list",
      selected: [],
    };
  }, dsps);

  if (result.status === "selected") {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  }

  return result;
}

async function collectPageSnapshot(page, dsps, dspSelection) {
  return page.evaluate(
    ({ dsps: configuredDsps, dspSelection: selection, maxText, maxRows, maxVisible }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const truncate = (value, max = maxText) => {
        const text = normalize(value);
        return text.length > max ? `${text.slice(0, max)}...` : text;
      };
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const cssPath = (el) => {
        if (!el || !(el instanceof Element)) return "";
        const parts = [];
        let node = el;
        while (node && node.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
          let part = node.nodeName.toLowerCase();
          if (node.id) {
            part += `#${CSS.escape(node.id)}`;
            parts.unshift(part);
            break;
          }
          const classes = [...node.classList].slice(0, 3);
          if (classes.length) {
            part += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
          }
          const parent = node.parentElement;
          if (parent) {
            const same = [...parent.children].filter(
              (child) => child.nodeName === node.nodeName
            );
            if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(" > ");
      };
      const nearbyLabel = (el) => {
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          const label = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.innerText)
            .filter(Boolean)
            .join(" ");
          if (label) return truncate(label);
        }
        const id = el.getAttribute("id");
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (label) return truncate(label.innerText);
        }
        const wrappingLabel = el.closest("label");
        if (wrappingLabel) return truncate(wrappingLabel.innerText);
        return "";
      };
      const elementInfo = (el) => ({
        tag: el.tagName.toLowerCase(),
        selector: cssPath(el),
        text: truncate(el.innerText || el.textContent || ""),
        label: nearbyLabel(el),
        name: el.getAttribute("name") || "",
        type: el.getAttribute("type") || "",
        role: el.getAttribute("role") || "",
        placeholder: truncate(el.getAttribute("placeholder") || ""),
        ariaLabel: truncate(el.getAttribute("aria-label") || ""),
        title: truncate(el.getAttribute("title") || ""),
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      });

      const tables = [...document.querySelectorAll("table")]
        .filter(isVisible)
        .map((table, index) => {
          const headers = [...table.querySelectorAll("thead th")]
            .map((cell) => truncate(cell.innerText))
            .filter(Boolean);
          const fallbackHeaders = [
            ...table.querySelectorAll("tr:first-child th, tr:first-child td"),
          ]
            .map((cell) => truncate(cell.innerText))
            .filter(Boolean);
          const rows = [...table.querySelectorAll("tbody tr, tr")]
            .slice(0, maxRows)
            .map((row) =>
              [...row.querySelectorAll("th,td")]
                .map((cell) => truncate(cell.innerText))
                .filter((cell) => cell !== "")
            )
            .filter((row) => row.length);
          return {
            index,
            selector: cssPath(table),
            headers: headers.length ? headers : fallbackHeaders,
            rowCountInDom: table.querySelectorAll("tbody tr, tr").length,
            rows,
          };
        });

      const controls = [
        ...document.querySelectorAll(
          "input, textarea, select, button, [role='button'], [role='combobox'], [role='switch'], [role='checkbox'], a[href]"
        ),
      ]
        .filter(isVisible)
        .map(elementInfo);

      const visibleText = [...document.body.querySelectorAll("body *")]
        .filter(isVisible)
        .map((el) => truncate(el.innerText || el.textContent || "", 120))
        .filter(Boolean)
        .filter((text, index, arr) => arr.indexOf(text) === index)
        .slice(0, maxVisible);

      const storageKeys = {
        localStorage: Object.keys(window.localStorage || {}),
        sessionStorage: Object.keys(window.sessionStorage || {}),
      };

      return {
        capturedAt: new Date().toISOString(),
        page: {
          url: location.href,
          title: document.title,
          userAgent: navigator.userAgent,
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
          },
        },
        configuredDsps,
        dspSelection: selection,
        storageKeys,
        tables,
        controls,
        visibleText,
      };
    },
    {
      dsps,
      dspSelection,
      maxText: MAX_TEXT,
      maxRows: MAX_ROWS_PER_TABLE,
      maxVisible: MAX_VISIBLE_TEXT,
    }
  );
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  if (!(await fileExists(AUTH_STATE_PATH))) {
    throw new Error("Missing .auth/dsp-report-state.json. Run `npm run auth` first.");
  }

  const dsps = JSON.parse(await fs.readFile(DSP_CONFIG_PATH, "utf8"));
  await fs.mkdir(SAMPLES_DIR, { recursive: true });

  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const networkRecords = startNetworkRecorder(page);

  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  if (await isLoginLikePage(page)) {
    await browser.close();
    throw new Error("The saved session looks expired. Run `npm run auth` again.");
  }

  const dspSelection = await trySelectDefaultDsps(page, dsps);
  const snapshot = await collectPageSnapshot(page, dsps, dspSelection);

  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await browser.close();

  const stamp = timestamp();
  const pagePath = path.join(SAMPLES_DIR, `dsp-report-page-${stamp}.json`);
  const networkPath = path.join(SAMPLES_DIR, `dsp-report-network-${stamp}.json`);

  await writeJson(pagePath, snapshot);
  await writeJson(networkPath, {
    capturedAt: new Date().toISOString(),
    page: snapshot.page,
    configuredDsps: dsps,
    dspSelection,
    records: networkRecords,
  });

  console.log(`Wrote ${path.relative(ROOT_DIR, pagePath)}`);
  console.log(`Wrote ${path.relative(ROOT_DIR, networkPath)}`);
  console.log(`DSP selection status: ${dspSelection.status}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
