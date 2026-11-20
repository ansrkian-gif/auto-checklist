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
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (const frame of await frames(page)) {
      const handle = await frame
        .evaluateHandle((wanted) => {
          const labelOf = (node) => {
            const title = (node.getAttribute("title") || "").replace(/\s+/g, " ").trim().toLowerCase();
            const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            return { title, text };
          };
          const wantedLower = wanted.toLowerCase();
          const matchesLabel = (node) => {
            const { title, text } = labelOf(node);
            return title === wantedLower || text === wantedLower;
          };
          const dropdown = [...document.querySelectorAll(".el-select-dropdown__item, .el-select-dropdown__item span")];
          const nodes = dropdown.length ? dropdown : [...document.querySelectorAll("li, span, div, a, label")];
          const matches = nodes.filter((node) => {
            if (!matchesLabel(node)) return false;
            const box = node.getBoundingClientRect();
            return box.width >= 8 && box.height >= 8 && box.height < 80 && box.width < 800;
          });
          matches.sort((a, b) => {
            const rank = (node) => (node.classList && node.classList.contains("el-select-dropdown__item") ? 0 : 1);
            if (rank(a) !== rank(b)) return rank(a) - rank(b);
            return a.getBoundingClientRect().width - b.getBoundingClientRect().width;
          });
          return matches[0] || null;
        }, label)
        .catch(() => null);
      const element = handle && handle.asElement ? handle.asElement() : null;
      if (!element) continue;
      await element.scrollIntoViewIfNeeded().catch(() => {});
      await element.click({ force: true, timeout: 5000 }).catch((error) => console.log("option click error", error.message));
      console.log("option", label);
      return true;
    }
    await page.waitForTimeout(400);
  }
  const seen = [];
  for (const frame of await frames(page)) {
    const rows = await frame
      .evaluate(() => [...document.querySelectorAll(".el-select-dropdown__item")]
        .slice(0, 40)
        .map((node) => {
          const box = node.getBoundingClientRect();
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          return `${node.getAttribute("title") || ""} | ${text} | ${Math.round(box.width)}x${Math.round(box.height)}`;
        }))
      .catch(() => []);
    seen.push(...rows);
  }
  fs.writeFileSync(path.join(__dirname, "options.txt"), seen.join("\n"));
  console.log("visible options", seen.slice(0, 30).join(" | "));
  return false;
}

async function labelVisible(page, label) {
  for (const frame of await frames(page)) {
    const found = await frame
      .evaluate((wanted) => [...document.querySelectorAll("body *")].some((node) => {
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        if (text !== wanted && text !== `${wanted}:`) return false;
        const box = node.getBoundingClientRect();
        return box.width >= 8 && box.height >= 8 && box.height <= 48 && box.width <= 800;
      }), label)
      .catch(() => false);
    if (found) return true;
  }
  return false;
}

async function openDropdownByLabel(page, label) {
  for (const frame of await frames(page)) {
    const handle = await frame
      .evaluateHandle((wanted) => {
        const textOf = (node) => (node.innerText || "").replace(/\s+/g, " ").trim();
        const labels = [...document.querySelectorAll("label, span, div, td")].filter((node) => {
          const text = textOf(node);
          if (text !== wanted && text !== `${wanted}:`) return false;
          const box = node.getBoundingClientRect();
          return box.width >= 20 && box.width <= 320 && box.height >= 10 && box.height <= 40 && node.childElementCount <= 3;
        });
        labels.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
        const lab = labels[0];
        if (!lab) return null;
        const band = lab.getBoundingClientRect();
        const mid = band.top + band.height / 2;
        const candidates = [...document.querySelectorAll("div, span, input, select")].filter((node) => {
          const box = node.getBoundingClientRect();
          if (box.width < 80 || box.width > 460 || box.height < 18 || box.height > 42) return false;
          const cy = box.top + box.height / 2;
          if (Math.abs(cy - mid) > 16) return false;
          if (box.left < band.right - 8) return false;
          const style = getComputedStyle(node);
          return style.visibility !== "hidden" && style.display !== "none";
        });
        candidates.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
        return candidates[0] || null;
      }, label)
      .catch(() => null);
    const element = handle && handle.asElement ? handle.asElement() : null;
    if (!element) continue;
    const box = await element.boundingBox();
    if (!box) continue;
    const position = { x: Math.max(8, box.width - 16), y: Math.max(8, box.height / 2) };
    try {
      await element.click({ position, timeout: 5000 });
    } catch (error) {
      console.log("dropdown covered, retrying", label);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await element.click({ position, timeout: 5000, force: true });
    }
    console.log("opened", label, Math.round(box.x), Math.round(box.y), Math.round(box.width));
    return true;
  }
  return false;
}

async function closeOpenList(page) {
  for (const frame of await frames(page)) {
    const handle = await frame
      .evaluateHandle(() => {
        const lab = [...document.querySelectorAll("label, span, div")].find((node) => {
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          if (text !== "Title" && text !== "Title:") return false;
          const box = node.getBoundingClientRect();
          return box.width >= 8 && box.height >= 8 && box.height <= 40 && node.childElementCount <= 2;
        });
        return lab || null;
      })
      .catch(() => null);
    const element = handle && handle.asElement ? handle.asElement() : null;
    if (!element) continue;
    await element.click({ force: true, timeout: 3000 }).catch(() => {});
    console.log("closed dropdown");
    return true;
  }
  return false;
}

async function fillRow(page, label, value) {
  for (const frame of await frames(page)) {
    const handle = await frame
      .evaluateHandle((wanted) => {
        const textOf = (node) => (node.innerText || "").replace(/\s+/g, " ").trim();
        const labels = [...document.querySelectorAll("label, span, div, td")].filter((node) => {
          const text = textOf(node);
          if (text !== wanted && text !== `${wanted}:`) return false;
          const box = node.getBoundingClientRect();
          return box.width >= 8 && box.width <= 220 && box.height >= 8 && box.height <= 40 && node.childElementCount <= 2;
        });
        labels.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
        const lab = labels[0];
        if (!lab) return null;
        const band = lab.getBoundingClientRect();
        const mid = band.top + band.height / 2;
        const inputs = [...document.querySelectorAll("input, textarea")].filter((node) => {
          const box = node.getBoundingClientRect();
          if (box.width < 40 || box.height < 12 || box.height > 80) return false;
          const cy = box.top + box.height / 2;
          if (Math.abs(cy - mid) > 20) return false;
          if (box.left < band.right - 10) return false;
          return true;
        });
        inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return inputs[0] || null;
      }, label)
      .catch(() => null);
    const element = handle && handle.asElement ? handle.asElement() : null;
    if (!element) continue;
    await element.fill(value);
    console.log("filled", label);
    return true;
  }
  const placeholders = [];
  for (const frame of await frames(page)) {
    const rows = await frame
      .evaluate(() => [...document.querySelectorAll("input, textarea")].slice(0, 20).map((node) => node.getAttribute("placeholder") || node.type || node.tagName))
      .catch(() => []);
    placeholders.push(...rows);
  }
  console.log("fields", placeholders.join(" | "));
  return false;
}

async function openSelect(page, label) {
  for (const frame of await frames(page)) {
    const opened = await frame
      .evaluate((wanted) => {
        const labels = [...document.querySelectorAll("label, .el-form-item__label, .ant-form-item-label, span, div")];
        const lab = labels.find((node) => (node.innerText || "").trim().replace(/\s+/g, " ") === wanted);
        if (!lab) return "";
        const item = lab.closest(".el-form-item, .ant-form-item, .el-col, td, tr") || lab.parentElement;
        const opener = item && item.querySelector(".el-select, .ant-select, [role='combobox'], select, input, .x-form-trigger");
        if (!opener) return "";
        opener.click();
        return "ok";
      }, label)
      .catch(() => "");
    if (opened) return true;
  }
  return false;
}

async function clickFilterFunnel(page) {
  for (const frame of await frames(page)) {
    const handle = await frame
      .evaluateHandle(() => {
        const textOf = (node) => (node.innerText || "").replace(/\s+/g, " ").trim();
        const boxOf = (node) => node.getBoundingClientRect();
        const shown = (node) => {
          const box = boxOf(node);
          if (box.width < 8 || box.height < 8) return false;
          const style = getComputedStyle(node);
          return style.visibility !== "hidden" && style.display !== "none";
        };
        const templates = [...document.querySelectorAll("body *")].filter((node) => {
          if (textOf(node) !== "Template") return false;
          const box = boxOf(node);
          return box.width >= 8 && box.width <= 220 && box.height >= 8 && box.height <= 64;
        });
        templates.sort((a, b) => boxOf(a).width - boxOf(b).width);
        const template = templates[0];
        if (!template) return null;
        const band = boxOf(template);
        const marked = [...document.querySelectorAll("body *")].filter((node) => {
          if (!shown(node)) return false;
          const box = boxOf(node);
          if (box.top > 220 || box.width > 72 || box.height > 72) return false;
          const mark = `${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""} ${node.className || ""} ${node.id || ""}`;
          if (!/filter|funnel/i.test(String(mark))) return false;
          if (/^filter$/i.test(textOf(node))) return false;
          return true;
        });
        marked.sort((a, b) => boxOf(a).width - boxOf(b).width);
        const icons = [...document.querySelectorAll("i, svg, img, button, a, span, div")].filter((node) => {
          if (node === template || template.contains(node) || node.contains(template)) return false;
          if (!shown(node)) return false;
          const box = boxOf(node);
          if (box.width < 10 || box.width > 56 || box.height < 10 || box.height > 56) return false;
          const cy = box.top + box.height / 2;
          if (cy < band.top - 8 || cy > band.bottom + 8) return false;
          if (box.right > band.left + 4) return false;
          if (band.left - box.right > 40) return false;
          return true;
        });
        icons.sort((a, b) => {
          const gapA = band.left - boxOf(a).right;
          const gapB = band.left - boxOf(b).right;
          if (Math.abs(gapA - gapB) > 3) return gapA - gapB;
          return boxOf(b).width - boxOf(a).width;
        });
        const chosen = marked[0] || icons[0];
        if (!chosen) return null;
        const box = boxOf(chosen);
        chosen.setAttribute("data-ows-funnel", "1");
        chosen.setAttribute("data-ows-funnel-info", JSON.stringify({
          tag: chosen.tagName,
          cls: String(chosen.className && chosen.className.baseVal ? chosen.className.baseVal : chosen.className).slice(0, 120),
          title: chosen.getAttribute("title") || "",
          x: Math.round(box.left),
          y: Math.round(box.top),
          w: Math.round(box.width),
          h: Math.round(box.height),
        }));
        return chosen;
      })
      .catch(() => null);
    const element = handle && handle.asElement ? handle.asElement() : null;
    if (!element) continue;
    const info = await element.getAttribute("data-ows-funnel-info").catch(() => "");
    await element.click({ timeout: 5000 }).catch((error) => console.log("funnel click error", error.message));
    console.log("clicked filter funnel", info || "element");
    return true;
  }
  return false;
}

async function clickApplyFilter(page) {
  for (const frame of await frames(page)) {
    const clicked = await frame
      .evaluate(() => {
        const nodes = [...document.querySelectorAll("button, .el-button, .ant-btn, a, span, div")];
        const hits = nodes.filter((node) => {
          const text = (node.innerText || "").replace(/\s+/g, " ").trim();
          if (text !== "Filter") return false;
          const box = node.getBoundingClientRect();
          if (box.width < 8 || box.height < 8 || box.width > 220) return false;
          const parentText = node.parentElement ? (node.parentElement.innerText || "").slice(0, 120) : "";
          if (/Filter Options/i.test(parentText)) return false;
          return true;
        });
        const buttons = hits.filter((node) => /button/i.test(node.tagName) || /btn|button/i.test(String(node.className)));
        const pool = buttons.length ? buttons : hits;
        pool.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
        const el = pool[0];
        if (!el) return "";
        el.click();
        const box = el.getBoundingClientRect();
        return `Filter ${Math.round(box.left)},${Math.round(box.top)}`;
      })
      .catch(() => "");
    if (clicked) {
      console.log("clicked", clicked);
      return true;
    }
  }
  return false;
}

async function dumpToolbar(page) {
  const lines = [];
  for (const frame of await frames(page)) {
    const rows = await frame
      .evaluate(() => {
        return [...document.querySelectorAll("body *")]
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.top >= 30 && box.top < 180 && box.height >= 8 && box.height <= 48 && box.width >= 8 && box.width <= 240 && node.childElementCount <= 2;
          })
          .slice(0, 60)
          .map((node) => {
            const box = node.getBoundingClientRect();
            const text = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
            return `${node.tagName} ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)} ${String(node.className).slice(0, 70)} | ${text}`;
          });
      })
      .catch(() => []);
    lines.push(`frame ${frame.url()}`);
    lines.push(...rows);
  }
  fs.writeFileSync(path.join(__dirname, "toolbar.txt"), lines.join("\n"));
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
    const boxes = frame.locator("textarea");
    const count = await boxes.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);
      if (!(await box.isVisible().catch(() => false))) continue;
      await box.fill(text);
      console.log("filled criteria");
      return true;
    }
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
  const downloadPromise = page.waitForEvent("download", { timeout: 300000 }).catch(() => null);
  let sawPending = false;
  let finishedStreak = 0;
  let lastText = "";
  let clicked = false;
  for (let attempt = 0; attempt < 40 && !clicked; attempt += 1) {
    for (const frame of await frames(page)) {
      const text = await frame
        .evaluate(() => {
          const rows = [...document.querySelectorAll("tr")].filter((row) => row.querySelectorAll("td").length > 1);
          const row = rows[0];
          return row ? (row.innerText || "").replace(/\s+/g, " ").trim().slice(0, 180) : "";
        })
        .catch(() => "");
      if (!text || !/Finished|Processing|Exporting|Generating|Waiting/i.test(text)) continue;
      if (!/Finished/i.test(text)) sawPending = true;
      if (text === lastText && /Finished/i.test(text)) finishedStreak += 1;
      else finishedStreak = /Finished/i.test(text) ? 1 : 0;
      lastText = text;
      console.log("export row", text);
      if (!/Finished/i.test(text) || (!sawPending && finishedStreak < 2)) break;
      const handle = await frame
        .evaluateHandle(() => {
          const rows = [...document.querySelectorAll("tr")].filter((row) => row.querySelectorAll("td").length > 1);
          const row = rows[0];
          if (!row || !/Finished/i.test(row.innerText || "")) return null;
          return [...row.querySelectorAll("a, button, i, span, svg")].find((node) => {
            const mark = `${node.className || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("aria-label") || ""}`;
            return /download/i.test(mark);
          }) || null;
        })
        .catch(() => null);
      const element = handle && handle.asElement ? handle.asElement() : null;
      if (!element) break;
      await element.click({ timeout: 5000 }).catch((error) => console.log("download click error", error.message));
      clicked = true;
      break;
    }
    if (!clicked) await page.waitForTimeout(3000);
  }
  if (!clicked) return false;
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

  let openedFilter = await labelVisible(page, "Task Type");
  if (!openedFilter) {
    const clickedFunnel = await clickFilterFunnel(page);
    if (!clickedFunnel) console.log("filter funnel not found");
    for (let attempt = 0; attempt < 8 && !openedFilter; attempt += 1) {
      await page.waitForTimeout(500);
      openedFilter = await labelVisible(page, "Task Type");
    }
  }
  if (!openedFilter) {
    await dumpToolbar(page);
    await shot(page, "02-no-filter.png");
    throw new Error("Task Type dropdown was not found");
  }
  if (!(await openDropdownByLabel(page, "Task Type"))) throw new Error("Task Type dropdown was not found");
  await page.waitForTimeout(600);
  if (!(await chooseOption(page, "PM"))) throw new Error("PM option was not found");
  await closeOpenList(page);
  await page.waitForTimeout(400);

  if (!(await openDropdownByLabel(page, "Task Status"))) throw new Error("Task Status dropdown was not found");
  await page.waitForTimeout(600);
  if (!(await chooseOption(page, "Closed"))) throw new Error("Closed option was not found");
  await page.waitForTimeout(300);
  if (!(await chooseOption(page, "Completed"))) {
    await openDropdownByLabel(page, "Task Status");
    await page.waitForTimeout(600);
    if (!(await chooseOption(page, "Completed"))) throw new Error("Completed option was not found");
  }
  await closeOpenList(page);
  await page.waitForTimeout(300);

  if (!(await fillRow(page, "Title", "OGK Active and Passive"))) throw new Error("Title field was not found");
  if (!(await clickText(page, /^More$/))) throw new Error("More was not found");
  await page.waitForTimeout(500);
  if (!(await fillCriteria(page, criteria))) throw new Error("Extended criteria box was not found");
  console.log("criteria", criteria);
  if (!(await clickApplyFilter(page))) throw new Error("Filter button was not found");
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
