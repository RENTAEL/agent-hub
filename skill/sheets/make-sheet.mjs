#!/usr/bin/env node
// Turns agents' SHEET: blocks into .xlsx files, each with a Univer preview in the live view.
// Usage: node make-sheet.mjs --from <task note or reply file> [--job name]
//        node make-sheet.mjs --spec <spec.json> --file <name.xlsx> [--job name]
//        node make-sheet.mjs --test
// Output: %LOCALAPPDATA%\agent-hub\files\<job>\<name>.xlsx  (+ .univer.json), preview at /sheets/view?f=<job>/<name>.xlsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { extractSheets, specToSnapshot, snapshotToXlsx, writeSheet, safePath, checkFormula, FILES } from './sheet-core.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const PORT = Number(process.env.HUB_VIEW_PORT || 4317);

if (process.argv.includes('--test')) {
  const ok = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } };
  const throws = (fn, m) => { try { fn(); ok(false, m); } catch { /* expected */ } };
  const note = 'SHEET: not-this.xlsx\n```json\n{"sheets":[{"rows":[[1]]}]}\n```\n## Reply\nHere you go.\nSHEET: Refunds/../x.xlsx\n```json\n{"sheets":[{"name":"Refunds","header":["Name","Amount","Paid"],"rows":[["A",10.5,true],["B",4,false],["Total","=SUM(B2:B3)",null]],"widths":[20,10]}]}\n```\nSHEET: broken.xlsx\n```json\n{oops}\n```\n';
  const got = extractSheets(note);
  ok(got.length === 2 && got[0].file === 'x.xlsx' && got[1].error, 'extract: reply only, file name cleaned, bad JSON reported');
  throws(() => checkFormula('=WEBSERVICE("http://x")'), 'blocks WEBSERVICE');
  throws(() => checkFormula('=cmd|\' /c calc\'!A1'), 'blocks DDE pipe');
  throws(() => checkFormula("='[other.xlsx]S'!A1"), 'blocks external workbook');
  ok(checkFormula('=SUM(B2:B3)'), 'allows SUM');
  throws(() => checkFormula('=SQL.REQUEST("x")'), 'blocks SQL.REQUEST');
  let hung = false; try { await snapshotToXlsx({ sheets: { a: { name: 'A', cellData: { 4000000000: { 0: { v: 1, t: 2 } } } } } }, path.join(os.tmpdir(), 'never.xlsx')); hung = true; } catch { /* expected */ }
  ok(!hung, 'huge row index refused');
  throws(() => specToSnapshot({ sheets: [] }), 'empty spec refused');
  throws(() => safePath('../../etc/passwd.xlsx', '.xlsx'), 'path traversal refused');
  const snap = specToSnapshot(got[0].spec, 'x.xlsx');
  ok(snap.sheets.s1.cellData[0][0].s === 'h' && snap.sheets.s1.cellData[3][1].f === '=SUM(B2:B3)', 'snapshot: bold header, formula kept');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-')), 'out.xlsx');
  await snapshotToXlsx(snap, tmp);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(tmp);
  const ws = wb.getWorksheet('Refunds');
  ok(ws && ws.getCell('A1').value === 'Name' && ws.getCell('A1').font?.bold, 'xlsx: header text and bold');
  ok(ws.getCell('B2').value === 10.5 && ws.getCell('C2').value === true && ws.getCell('C3').value === false, 'xlsx: number and booleans');
  ok(ws.getCell('B4').value?.formula === 'SUM(B2:B3)', 'xlsx: formula');
  ok(Math.round(ws.getColumn(1).width) === 20, 'xlsx: column width');
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  console.log(process.exitCode ? 'tests failed' : 'all tests passed');
} else {
  const from = arg('from'), specFile = arg('spec');
  if (!from && !specFile) { console.error('usage: make-sheet.mjs --from <note> [--job name] | --spec <spec.json> --file <name.xlsx> [--job name] | --test'); process.exit(2); }
  const job = arg('job') || path.basename(from || specFile).replace(/\.[^.]+$/, '');
  const items = from ? extractSheets(fs.readFileSync(from, 'utf8')) : [{ file: arg('file') || 'sheet.xlsx', spec: JSON.parse(fs.readFileSync(specFile, 'utf8')) }];
  if (!items.length) { console.error('no SHEET: blocks found (only the "## Reply" part of a task note is read)'); process.exit(1); }
  for (const it of items) {
    if (it.error) { console.error(`skip ${it.file}: ${it.error}`); process.exitCode = 1; continue; }
    try {
      const r = await writeSheet(job, it.file, it.spec);
      console.log(`xlsx:    ${r.xlsx}\npreview: http://127.0.0.1:${PORT}/sheets/view?f=${encodeURIComponent(r.rel)}`);
    } catch (e) { console.error(`skip ${it.file}: ${e.message}`); process.exitCode = 1; }
  }
  if (!process.exitCode) console.log(`files in ${FILES}`);
}
