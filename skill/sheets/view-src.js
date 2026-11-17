// Univer preview for one .xlsx the hub made. Bundled by `npm run build` into dist/view.js and dist/view.css.
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import enUS from '@univerjs/preset-sheets-core/locales/en-US';
import '@univerjs/preset-sheets-core/lib/index.css';

const $ = (id) => document.getElementById(id);
const f = new URLSearchParams(location.search).get('f');
const say = (t) => { $('msg').textContent = t; };

async function list() {
  const files = await fetch('/sheets/list').then((r) => r.json());
  $('app').innerHTML = '<ul id="files"></ul>';
  if (!files.length) return say('No sheets yet. Run make-sheet.mjs on an agent reply.');
  for (const x of files) {
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = `/sheets/view?f=${encodeURIComponent(x.rel)}`;
    a.textContent = `${x.rel}  (${new Date(x.mtime).toLocaleString()})`;
    li.append(a); $('files').append(li);
  }
}

async function open() {
  $('name').textContent = f;
  $('dl').href = `/sheets/download?f=${encodeURIComponent(f)}`;
  $('dl').hidden = false;
  const r = await fetch(`/sheets/data?f=${encodeURIComponent(f)}`);
  if (!r.ok) return say(`Could not load: ${await r.text()}`);
  const snap = await r.json();
  const { univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(enUS) },
    presets: [UniverSheetsCorePreset({ container: 'app' })],
  });
  univerAPI.createWorkbook(snap);
  $('save').hidden = false;
  $('save').onclick = async () => {
    say('Saving...');
    const res = await fetch(`/sheets/save?f=${encodeURIComponent(f)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(univerAPI.getActiveWorkbook().save()),
    });
    say(res.ok ? `Saved ${new Date().toLocaleTimeString()}` : `Not saved: ${await res.text()}`);
  };
}

(f ? open() : list()).catch((e) => say(String(e)));
