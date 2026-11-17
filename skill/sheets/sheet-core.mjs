// Agents' SHEET: blocks -> Univer workbook snapshot -> .xlsx (ExcelJS). Shared by make-sheet.mjs and the live view.
// Open-source Univer cannot write .xlsx itself (that needs Univer Pro and its server), so ExcelJS writes the file
// and Univer only previews and edits the snapshot in the browser.
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { HUB } from '../scripts/team.mjs';

export const FILES = path.join(HUB, 'files');
const MAX_SHEETS = 50, MAX_CELLS = 200000, MAX_TEXT = 32767, PX_PER_CHAR = 7, MAX_ROWS = 1048576, MAX_COLS = 16384;
// Excel's own limits; a huge row index would make ExcelJS spin for minutes and freeze the live view.
const idx = (k, max, what) => { const n = Number(k); if (!Number.isInteger(n) || n < 0 || n >= max) throw new Error(`bad ${what} index: ${String(k).slice(0, 20)}`); return n; };

// Agent output is untrusted: block formulas that reach outside the workbook or run code when Excel opens the file.
const BAD_FORMULA = /\b(WEBSERVICE|FILTERXML|HYPERLINK|IMPORT\w*|CALL|REGISTER(\.ID)?|EXEC|RTD|DDE\w*|INFO|CELL|SQL\.REQUEST|CUBE\w*|EUROCONVERT|STOCKHISTORY)\s*\(|\||\[[^\]]*\.(xls\w*|csv)\]/i;
export function checkFormula(f) {
  if (BAD_FORMULA.test(f)) throw new Error(`formula not allowed (external link or code): ${f.slice(0, 80)}`);
  return f;
}

const sheetName = (s, i) => (String(s || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, '-').trim().slice(0, 31) || `Sheet${i + 1}`);
export const fileName = (s) => {
  const base = path.basename(String(s || 'sheet.xlsx')).replace(/[^\w .()-]/g, '-').trim();
  return (base.toLowerCase().endsWith('.xlsx') ? base : `${base || 'sheet'}.xlsx`).slice(0, 120);
};

// Spec (what agents write): { "sheets": [ { "name", "header": [..], "rows": [[..]], "widths": [chars] } ] }
// A cell is a string, number, boolean or null; a string starting with "=" is a formula.
export function specToSnapshot(spec, name = 'sheet.xlsx') {
  if (!spec || !Array.isArray(spec.sheets) || !spec.sheets.length) throw new Error('spec needs a non-empty "sheets" list');
  if (spec.sheets.length > MAX_SHEETS) throw new Error(`too many sheets (max ${MAX_SHEETS})`);
  const snap = { id: `wb-${Date.now()}`, name, locale: 'enUS', styles: { h: { bl: 1 } }, sheetOrder: [], sheets: {} };
  let cells = 0;
  const used = new Set();
  spec.sheets.forEach((sh, i) => {
    let title = sheetName(sh.name, i);
    while (used.has(title.toLowerCase())) title = `${title.slice(0, 28)}-${i + 1}`;
    used.add(title.toLowerCase());
    const id = `s${i + 1}`, cellData = {};
    const rows = [...(Array.isArray(sh.header) ? [sh.header] : []), ...(Array.isArray(sh.rows) ? sh.rows : [])];
    let cols = 0;
    rows.forEach((row, r) => {
      if (!Array.isArray(row)) throw new Error(`sheet "${title}" row ${r + 1} is not a list`);
      cols = Math.max(cols, row.length);
      row.forEach((v, c) => {
        if (v === null || v === undefined || v === '') return;
        if (++cells > MAX_CELLS) throw new Error(`too many cells (max ${MAX_CELLS})`);
        const cell = typeof v === 'string' && v.startsWith('=') ? { f: checkFormula(v) }
          : typeof v === 'number' ? (Number.isFinite(v) ? { v, t: 2 } : { v: String(v), t: 1 })
          : typeof v === 'boolean' ? { v: v ? 1 : 0, t: 3 }
          : { v: String(v).slice(0, MAX_TEXT), t: 1 };
        if (r === 0 && Array.isArray(sh.header)) cell.s = 'h';
        (cellData[r] ||= {})[c] = cell;
      });
    });
    const columnData = {};
    (Array.isArray(sh.widths) ? sh.widths : []).forEach((w, c) => { if (Number(w) > 0) columnData[c] = { w: Math.min(255, Number(w)) * PX_PER_CHAR + 5 }; });
    snap.sheetOrder.push(id);
    snap.sheets[id] = { id, name: title, rowCount: Math.max(100, rows.length + 20), columnCount: Math.max(20, cols + 5), cellData, columnData, freeze: Array.isArray(sh.header) ? { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 } : undefined };
  });
  return snap;
}

const isBold = (snap, s) => !!(typeof s === 'string' ? snap.styles?.[s]?.bl : s?.bl);

export async function snapshotToXlsx(snap, outFile) {
  if (!snap || typeof snap.sheets !== 'object' || !snap.sheets) throw new Error('not a workbook snapshot');
  const wb = new ExcelJS.Workbook();
  const order = Array.isArray(snap.sheetOrder) && snap.sheetOrder.length ? snap.sheetOrder : Object.keys(snap.sheets);
  if (order.length > MAX_SHEETS) throw new Error(`too many sheets (max ${MAX_SHEETS})`);
  let cells = 0;
  const used = new Set();
  order.forEach((id, i) => {
    const sh = snap.sheets[id];
    if (!sh) return;
    let title = sheetName(sh.name, i);
    while (used.has(title.toLowerCase())) title = `${title.slice(0, 28)}-${i + 1}`;
    used.add(title.toLowerCase());
    const ws = wb.addWorksheet(title);
    for (const [r, row] of Object.entries(sh.cellData || {})) for (const [c, cell] of Object.entries(row || {})) {
      if (!cell || (cell.v === undefined && !cell.f)) continue;
      if (++cells > MAX_CELLS) throw new Error(`too many cells (max ${MAX_CELLS})`);
      const x = ws.getCell(idx(r, MAX_ROWS, 'row') + 1, idx(c, MAX_COLS, 'column') + 1);
      if (cell.f) x.value = { formula: checkFormula(String(cell.f)).replace(/^=/, ''), ...(cell.v !== undefined && cell.v !== null ? { result: cell.v } : {}) };
      else if (cell.t === 3 || typeof cell.v === 'boolean') x.value = cell.v === true || cell.v === 1 || String(cell.v).toUpperCase() === 'TRUE';
      else if (cell.t === 2 || typeof cell.v === 'number') x.value = Number(cell.v);
      else x.value = String(cell.v).slice(0, MAX_TEXT);
      if (isBold(snap, cell.s)) x.font = { bold: true };
    }
    for (const [c, col] of Object.entries(sh.columnData || {})) if (col?.w) ws.getColumn(idx(c, MAX_COLS, 'column') + 1).width = Math.max(1, Math.round((col.w - 5) / PX_PER_CHAR));
    if (sh.freeze?.ySplit) ws.views = [{ state: 'frozen', ySplit: sh.freeze.ySplit, xSplit: sh.freeze.xSplit || 0 }];
  });
  if (!wb.worksheets.length) throw new Error('workbook has no sheets');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await wb.xlsx.writeFile(outFile);
  return outFile;
}

// SHEET: <file.xlsx> followed by one fenced JSON block. In a task note only the reply is read, so a format
// example in the brief is never mistaken for output.
export function extractSheets(text) {
  const t = String(text), reply = t.search(/^## Reply\b/m);
  const body = reply >= 0 ? t.slice(reply) : t;
  const out = [], re = /^SHEET:\s*([^\r\n]+?)\s*\r?\n```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/gm;
  for (let m; (m = re.exec(body));) {
    let spec;
    try { spec = JSON.parse(m[2]); } catch (e) { out.push({ file: fileName(m[1]), error: `bad JSON: ${e.message}` }); continue; }
    out.push({ file: fileName(m[1]), spec });
  }
  return out;
}

// Paths from the browser are relative to FILES; anything that leaves it, or isn't ours, is refused.
export function safePath(rel, ext) {
  const p = path.resolve(FILES, String(rel || ''));
  const r = path.relative(FILES, p);
  if (!r || r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r) || !p.toLowerCase().endsWith(ext)) throw new Error('bad file path');
  return p;
}

const slug = (s) => String(s || 'job').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'job';

// Writes <FILES>/<job>/<name>.xlsx and its .univer.json snapshot; returns both paths relative to FILES.
export async function writeSheet(job, file, specOrSnap, { isSnapshot = false } = {}) {
  const name = fileName(file);
  const dir = path.join(FILES, slug(job));
  const snap = isSnapshot ? specOrSnap : specToSnapshot(specOrSnap, name);
  const xlsx = path.join(dir, name);
  await snapshotToXlsx(snap, xlsx);
  fs.writeFileSync(xlsx.replace(/\.xlsx$/i, '.univer.json'), JSON.stringify(snap));
  return { xlsx, rel: path.relative(FILES, xlsx).split(path.sep).join('/') };
}

export function listSheets() {
  if (!fs.existsSync(FILES)) return [];
  const out = [];
  for (const d of fs.readdirSync(FILES, { withFileTypes: true })) if (d.isDirectory())
    for (const f of fs.readdirSync(path.join(FILES, d.name))) if (f.toLowerCase().endsWith('.xlsx'))
      out.push({ rel: `${d.name}/${f}`, mtime: fs.statSync(path.join(FILES, d.name, f)).mtimeMs });
  return out.sort((a, b) => b.mtime - a.mtime);
}
