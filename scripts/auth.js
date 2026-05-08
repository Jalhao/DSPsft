const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin: input, stdout: output } = require("node:process");
const { chromium } = require("playwright");

const ROOT_DIR = path.resolve(__dirname, "..");
const REPORT_URL = "https://adm.adbiding.cn/report/dspReport";
const AUTH_DIR = path.join(ROOT_DIR, ".auth");
const AUTH_STATE_PATH = path.join(AUTH_DIR, "dsp-report-state.json");

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await fs.mkdir(AUTH_DIR, { recursive: true });

  const hasExistingState = await fileExists(AUTH_STATE_PATH);
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
  });
  const context = await browser.newContext({
    storageState: hasExistingState ? AUTH_STATE_PATH : undefined,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  console.log(`Opening ${REPORT_URL}`);
  console.log("Log in manually in the browser window.");
  console.log("After the report page is visible, return here and press Enter.");

  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded" });

  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter after login is complete...");
  rl.close();

  await context.storageState({ path: AUTH_STATE_PATH });
  await browser.close();

  console.log(`Saved browser session to ${path.relative(ROOT_DIR, AUTH_STATE_PATH)}`);
  console.log("No password was saved to the project.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
