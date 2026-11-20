import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const inputArg = process.argv[2] || path.join(__dirname, "checklist.zip");

const COMMON = ["Task ID", "Site ID", "Operate Time"];
const SHELTER_COLUMNS = ["Shelter Type", "Shelter Size"];

function sheetType(name) {
  if (/Active_Smaacro/i.test(name)) return "Active_Smaacro";
  if (/Passive_General/i.test(name)) return "Passive_General";
  if (/Active_General/i.test(name)) return "Active_General";
  return null;
}

function sheetVersion(name) {
  const match = String(name).match(/_v(\d+)\s*$/i);
  return match ? Number(match[1]) : 0;
}

function headerKey(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function formatValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = value.getUTCMonth() + 1;
    const day = value.getUTCDate();
    const year = value.getUTCFullYear();
    const hour = value.getUTCHours();
    const minute = String(value.getUTCMinutes()).padStart(2, "0");
    return `${month}/${day}/${year} ${hour}:${minute}`;
  }
  if (value == null) return "";
  return String(value).trim();
}

function findWorkbook(start) {
  if (!fs.existsSync(start)) throw new Error(`Checklist file not found: ${start}`);
  if (start.toLowerCase().endsWith(".xlsx")) return start;
  const dir = path.join(path.dirname(start), "_unzipped");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${start.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]);
  } else {
    execFileSync("unzip", ["-o", start, "-d", dir]);
  }
  const found = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith(".xlsx")) found.push(full);
    }
  };
  walk(dir);
  if (!found.length) throw new Error("No workbook inside the checklist download");
  return found[0];
}

function readSheet(workbook, name) {
  const sheet = workbook.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, cellDates: true });
  const headers = rows[0] || [];
  const occurrence = new Map();
  const columns = [];
  headers.forEach((raw, index) => {
    const nameText = formatValue(raw);
    if (!nameText || /photo/i.test(nameText)) return;
    const keyName = headerKey(nameText);
    const seen = (occurrence.get(keyName) || 0) + 1;
    occurrence.set(keyName, seen);
    columns.push({
      key: `${keyName}|#${seen}`,
      name: nameText,
      values: rows.slice(1).map((row) => formatValue(row[index])),
    });
  });
  return { name, version: sheetVersion(name), columns };
}

function mergeGroup(sheets) {
  const ordered = [...sheets].sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
  const order = [];
  const seen = new Set();
  const present = new Map();
  const display = new Map();
  for (const sheet of ordered) {
    const inSheet = new Set();
    for (const column of sheet.columns) {
      inSheet.add(column.key);
      if (!seen.has(column.key)) {
        seen.add(column.key);
        order.push(column.key);
        display.set(column.key, column.name);
      }
    }
    for (const key of inSheet) present.set(key, (present.get(key) || 0) + 1);
  }
  const common = [];
  const different = [];
  for (const key of order) {
    if (present.get(key) === ordered.length) common.push(key);
    else different.push(key);
  }
  const finalKeys = [...common, ...different];
  const data = [];
  for (const sheet of ordered) {
    const byKey = new Map(sheet.columns.map((column) => [column.key, column]));
    const rowCount = sheet.columns[0] ? sheet.columns[0].values.length : 0;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const row = {};
      let any = false;
      for (const key of finalKeys) {
        const value = byKey.has(key) ? byKey.get(key).values[rowIndex] : "";
        row[display.get(key)] = value;
        if (value) any = true;
      }
      if (any) data.push(row);
    }
  }
  return data;
}

function requireColumn(row, name) {
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const wanted = headerKey(name);
  const found = Object.keys(row).find((key) => headerKey(key) === wanted);
  if (!found) throw new Error(`Column '${name}' was not found on Passive_General.`);
  return row[found];
}

const workbookPath = findWorkbook(path.resolve(inputArg));
const workbook = XLSX.readFile(workbookPath, { cellDates: true });
const grouped = new Map();
for (const name of workbook.SheetNames) {
  const type = sheetType(name);
  if (!type) continue;
  const sheet = readSheet(workbook, name);
  if (!grouped.has(type)) grouped.set(type, []);
  grouped.get(type).push(sheet);
  console.log(`${type} ${name} columns=${sheet.columns.length}`);
}

const passive = mergeGroup(grouped.get("Passive_General") || []);
const sites = passive.map((row) => ({
  taskId: requireColumn(row, "Task ID"),
  siteId: requireColumn(row, "Site ID"),
  operateTime: requireColumn(row, "Operate Time"),
  shelterType: requireColumn(row, "Shelter Type"),
  shelterSize: requireColumn(row, "Shelter Size"),
}));

const from = process.env.OWS_FROM || "";
const to = process.env.OWS_TO || "";
const label = from && to
  ? `Completed ${from.slice(0, 10)} to ${to.slice(0, 10)}`
  : `${sites.length} checklist sites`;

const sitesJs = `window.CHECKLIST_LABEL = ${JSON.stringify(label)};\nwindow.SITES = ${JSON.stringify(sites)};\n`;
fs.writeFileSync(path.join(root, "dashboard", "sites.js"), sitesJs);
console.log(`sites=${sites.length}`);
