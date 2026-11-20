import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(__dirname, "checklist.zip");
const base = (process.env.OWS_URL || "https://106d-sg.teleows.com/").replace(/\/$/, "");
const homeUrl = `${base}/portal-web/portal/homepage.html`;
const user = process.env.OWS_USER;
const pass = process.env.OWS_PASS;

function kuwaitDay(offset) {
  const stamp = Date.now() + offset * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuwait",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(stamp));
}

const from = process.env.OWS_FROM || `${kuwaitDay(-1)} 00:00:00`;
const to = process.env.OWS_TO || `${kuwaitDay(0)} 00:00:00`;
const criteria = `"Project" = 'Kuwait Ooredoo FMO' and "Complete Time" >= '${from}' and "Complete Time" <= '${to}'`;

if (!user || !pass) {
  console.error("OWS_USER and OWS_PASS must be set as cloud secrets.");
  process.exit(1);
}

console.log("window", from, to);

async function shot(page, name) {
  await page.screenshot({ path: path.join(__dirname, name), fullPage: true }).catch(() => {});
}

async function frames(page) {
  return page.frames();
}

async function clickText(page, pattern) {
  for (const frame of await frames(page)) {
    const clicked = await frame
      .evaluate((source) => {
        const wanted = new RegExp(source, "i");
        const nodes = [...document.querySelectorAll("button, a, span, div, li, label")];
        const el = nodes.find((node) => {
          const text = (node.innerText || "").trim().replace(/\s+/g, " ");
          if (!text || text.length > 80 || !wanted.test(text)) return false;
          const box = node.getBoundingClientRect();
          return box.width >= 8 && box.height >= 8;
        });
        if (!el) return "";
        el.click();
        return (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80);
      }, pattern.source)
      .catch(() => "");
    if (clicked) {
      console.log("clicked", clicked);
      return true;
    }
  }
  return false;
}

async function chooseOption(page, label) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (const frame of await frames(page)) {
      const hit = await frame
        .evaluate((wanted) => {
          const nodes = [...document.querySelectorAll(".el-select-dropdown__item, .ant-select-item-option, li, span, div")];
          const el = nodes.find((node) => {
            const text = (node.innerText || "").trim();
            if (text !== wanted) return false;
            const box = node.getBoundingClientRect();
            return box.width >= 8 && box.height >= 8 && box.height < 60;
          });
          if (!el) return "";
          el.click();
          return "ok";
        }, label)
        .catch(() => "");
      if (hit) {
        console.log("option", label);
        return true;
      }
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function openSelect(page, label) {
  for (const frame of await frames(page)) {
    const opened = await frame
      .evaluate((wanted) => {
        const labels = [...document.querySelectorAll("label, .el-form-item__label, .ant-form-item-label, span, div")];
        const lab = labels.find((node) => (node.innerText || "").trim().replace(/\s+/g, " ") === wanted);
        if (!lab) return "";
        const item = lab.closest(".el-form-item, .ant-form-item, .el-col, td, div") || lab.parentElement;
        const opener = item && item.querySelector(".el-select, .ant-select, input");
        if (!opener) return "";
        opener.click();
        return "ok";
      }, label)
      .catch(() => "");
    if (opened) return true;
  }
  return false;
}

async function fillByLabel(page, label, value) {
  for (const frame of await frames(page)) {
    const filled = await frame
      .evaluate(({ wanted, text }) => {
        const labels = [...document.querySelectorAll("label, .el-form-item__label, .ant-form-item-label, span, div")];
        const lab = labels.find((node) => (node.innerText || "").trim().replace(/\s+/g, " ") === wanted);
        if (!lab) return "";
        const item = lab.closest(".el-form-item, .ant-form-item, .el-col, td, div") || lab.parentElement;
        const input = item && item.querySelector("input");
        if (!input) return "";
        input.focus();
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      }, { wanted: label, text: value })
      .catch(() => "");
    if (filled) {
      console.log("filled", label);
      return true;
    }
  }
  return false;
}

async function fillCriteria(page, text) {
  for (const frame of await frames(page)) {
    const filled = await frame
      .evaluate((value) => {
        const box = [...document.querySelectorAll("textarea")].find((node) => {
          const rec = node.getBoundingClientRect();
          return rec.width > 40 && rec.height > 10;
        });
        if (!box) return "";
        box.focus();
        box.value = value;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        box.dispatchEvent(new Event("change", { bubbles: true }));
        return "ok";
      }, text)
      .catch(() => "");
    if (filled) return true;
  }
  return false;
}

async function clickDialogButton(page, names) {
  for (const frame of await frames(page)) {
    const clicked = await frame
      .evaluate((wanted) => {
        const buttons = [...document.querySelectorAll("button, .el-button, .ant-btn")];
        const el = buttons.find((node) => {
          const text = (node.innerText || "").trim();
          if (!wanted.includes(text)) return false;
          const box = node.getBoundingClientRect();
          return box.width >= 8 && box.height >= 8;
        });
        if (!el) return "";
        el.click();
        return (el.innerText || "").trim();
      }, names)
      .catch(() => "");
    if (clicked) {
      console.log("dialog", clicked);
      return clicked;
    }
  }
  return "";
}

async function loginIfNeeded(page) {
  const passBox = page.locator('input[type="password"], #password').first();
  if (!(await passBox.isVisible().catch(() => false))) return false;
  const userBox = page.locator("#username, input[type='text'], input[name*='user' i]").first();
  await userBox.fill(user);
  await passBox.fill(pass);
  const button = page.locator("#loginButton, button[type='submit'], input[type='submit']").first();
  if (await button.isVisible().catch(() => false)) await button.click();
  else await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  console.log("after login", page.url());
  return true;
}

async function downloadFirstExport(page) {
  const downloadPromise = page.waitForEvent("download", { timeout: 180000 }).catch(() => null);
  for (const frame of await frames(page)) {
    const clicked = await frame
      .evaluate(() => {
        const rows = [...document.querySelectorAll("tr")].filter((row) => /Finished/i.test(row.innerText || ""));
        const row = rows[0];
        if (!row) return "";
        const icon = [...row.querySelectorAll("a, button, i, span, svg")].find((node) => {
          const mark = `${node.className || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""}`;
          return /download/i.test(mark);
        });
        if (!icon) return "";
        icon.click();
        return "download";
      })
      .catch(() => "");
    if (clicked) break;
  }
  await clickDialogButton(page, ["Confirm", "OK"]);
  const download = await downloadPromise;
  if (!download) return false;
  await download.saveAs(outFile);
  console.log("saved", outFile);
  return true;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.on("dialog", (dialog) => dialog.accept().catch(() => {}));

try {
  await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2000);
  await loginIfNeeded(page);
  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) {
    throw new Error("TeleOWS login did not complete");
  }
  await shot(page, "01-after-login.png");

  const opened = Date.now();
  let foundTasks = false;
  while (Date.now() - opened < 90000) {
    await clickText(page, /^Console$/);
    if (await clickText(page, /All Tasks/)) {
      foundTasks = true;
      break;
    }
    await page.waitForTimeout(3000);
  }
  if (!foundTasks) {
    const urls = page.frames().map((frame) => frame.url());
    fs.writeFileSync(path.join(__dirname, "frames.txt"), urls.join("\n"));
    console.log("frames", urls.join(" | "));
    throw new Error("All Tasks was not found");
  }
  await page.waitForTimeout(2500);

  let openedFilter = false;
  for (let attempt = 0; attempt < 8 && !openedFilter; attempt += 1) {
    for (const frame of await frames(page)) {
      const hit = await frame
        .evaluate(() => {
          const nodes = [...document.querySelectorAll("button, i, span, a, div, svg")];
          const template = nodes.find((node) => (node.innerText || "").trim() === "Template");
          if (!template) return "";
          const band = template.getBoundingClientRect();
          const funnel = nodes
            .map((node) => ({ node, box: node.getBoundingClientRect() }))
            .filter(({ box }) => box.width >= 10 && box.width <= 48 && box.height >= 10 && box.height <= 48)
            .filter(({ box }) => box.right <= band.left + 4 && Math.abs(box.top - band.top) < 24)
            .sort((a, b) => b.box.right - a.box.right)[0];
          if (!funnel) return "";
          funnel.node.click();
          return "funnel";
        })
        .catch(() => "");
      if (hit) {
        console.log("clicked filter funnel");
        break;
      }
    }
    await page.waitForTimeout(1000);
    openedFilter = await openSelect(page, "Task Type");
  }
  if (!openedFilter) throw new Error("Task Type dropdown was not found");
  if (!(await chooseOption(page, "PM"))) throw new Error("PM option was not found");
  await page.waitForTimeout(400);

  if (!(await openSelect(page, "Task Status"))) throw new Error("Task Status dropdown was not found");
  if (!(await chooseOption(page, "Closed"))) throw new Error("Closed option was not found");
  await page.waitForTimeout(300);
  await openSelect(page, "Task Status");
  if (!(await chooseOption(page, "Completed"))) throw new Error("Completed option was not found");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  if (!(await fillByLabel(page, "Title", "OGK Active and Passive"))) throw new Error("Title field was not found");
  if (!(await clickText(page, /^More$/))) throw new Error("More was not found");
  await page.waitForTimeout(500);
  if (!(await fillCriteria(page, criteria))) throw new Error("Extended criteria box was not found");
  console.log("criteria", criteria);
  if (!(await clickText(page, /^Filter$/))) throw new Error("Filter button was not found");
  await page.waitForTimeout(4000);
  await shot(page, "02-filtered.png");

  if (!(await clickText(page, /Export Checklist as Excel/))) throw new Error("Export Checklist as Excel was not found");
  for (let i = 0; i < 4; i += 1) {
    const button = await clickDialogButton(page, ["OK", "Confirm"]);
    if (!button) break;
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2000);
  await shot(page, "03-export.png");

  const saved = await downloadFirstExport(page);
  if (!saved) throw new Error("Checklist download did not start");
  fs.writeFileSync(path.join(__dirname, "window.txt"), `${from}\n${to}\n`);
} catch (error) {
  await shot(page, "error.png");
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
