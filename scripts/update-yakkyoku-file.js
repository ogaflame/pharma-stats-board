#!/usr/bin/env node
/**
 * 薬局数（衛生行政報告例・年度報）を「Excelファイル」から取得して data.json に追加する。
 *
 * 背景：e-Stat のデータベース版（API で直接読める表）は公表から何年も遅れて追加されるため、
 *       公表直後の最新年度は DB では取れない。先に掲載される Excel ファイルを読む。
 *
 * 流れ：
 *   1. e-Stat API(getDataCatalog) で 衛生行政報告例 のファイル一覧から「薬局数 … 都道府県別」の Excel を探す
 *   2. 最新年度のファイルをダウンロード
 *   3. 表中の「令和◯年度末」から年度を判定し、全国・総数の薬局数を読む
 *   4. 前年度から±5%以内など妥当な値のときだけ、data.json の yakkyoku.series に追加（同じ年は上書き）
 *
 * 実行：   ESTAT_APP_ID=xxx node scripts/update-yakkyoku-file.js
 * 診断：   ESTAT_APP_ID=xxx node scripts/update-yakkyoku-file.js --list   （候補ファイルの一覧を表示）
 * 必要：   npm install xlsx@0.18.5   （ワークフローで実行）
 */
const fs = require('fs');
const path = require('path');

const APP_ID = process.env.ESTAT_APP_ID;
const DATA_JSON_PATH = process.env.DATA_JSON_PATH || path.join(__dirname, '..', 'data.json');
const STATS_CODE = '00450027'; // 衛生行政報告例
const IND_ID = 'yakkyoku';
const MAX_CHANGE_RATIO = 0.05; // 前年度比±5%を超えたら読み違いとみなして取り込まない

if (!APP_ID) { console.error('環境変数 ESTAT_APP_ID が設定されていません。'); process.exit(1); }

async function getCatalogPages() {
  // 1回の上限は100件。NEXT_KEY があれば続きを取得（最大10ページ）
  const pages = [];
  let start = 1;
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({
      appId: APP_ID, statsCode: STATS_CODE, searchWord: '薬局数', limit: '100', startPosition: String(start),
    });
    const res = await fetch(`https://api.e-stat.go.jp/rest/3.0/app/json/getDataCatalog?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const result = (json.GET_DATA_CATALOG || {}).RESULT;
    if (result && Number(result.STATUS) !== 0) throw new Error(`e-Stat エラー ${result.STATUS}: ${result.ERROR_MSG}`);
    pages.push(json);
    const inf = ((json.GET_DATA_CATALOG || {}).DATA_CATALOG_LIST_INF) || {};
    const next = inf.NEXT_KEY || ((json.GET_DATA_CATALOG || {}).PARAMETER || {}).NEXT_KEY;
    if (!next) break;
    start = Number(next);
  }
  return pages;
}

// 応答の構造に依存しすぎないよう、JSON全体を走査して「URLを持つ要素」を集める
function collectResources(node, out, ctx) {
  if (Array.isArray(node)) { node.forEach((n) => collectResources(n, out, ctx)); return; }
  if (!node || typeof node !== 'object') return;
  const url = node.URL && (typeof node.URL === 'object' ? node.URL.$ : node.URL);
  if (typeof url === 'string' && /file-download|dl\.e-stat|\.xls/i.test(url)) {
    out.push({ url, text: JSON.stringify(node), ctx: ctx.slice() });
  }
  Object.entries(node).forEach(([k, v]) => {
    if (typeof v === 'object') collectResources(v, out, ctx.concat(k));
  });
}

function statInfId(url) {
  const m = String(url).match(/statInfId=(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function findCandidates() {
  const pages = await getCatalogPages();
  const found = [];
  collectResources(pages, found, []);
  // 「薬局数」と「都道府県」を含み、Excel形式のもの
  const cands = found.filter((r) => r.text.includes('薬局数') && r.text.includes('都道府県') && !/PDF|CSV/i.test(r.text.slice(0, 0)));
  const uniq = new Map();
  cands.forEach((c) => uniq.set(c.url, c));
  return Array.from(uniq.values()).sort((a, b) => statInfId(b.url) - statInfId(a.url));
}

const toHalf = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

const findYearIn = (text) => {
  const t = toHalf(text).replace(/\s/g, '');
  const ym = t.match(/(令和|平成)(元|\d+)年度/);
  if (ym) return (ym[1] === '令和' ? 2018 : 1988) + (ym[2] === '元' ? 1 : Number(ym[2]));
  const m2 = t.match(/(20\d\d)年度/);
  return m2 ? Number(m2[1]) : null;
};

/**
 * Excel の構造（確認済み）：
 *   - 見出し行（4行目付近）に「薬局数」と書かれた列がある（B4）
 *   - 全国の値はその列の中にある（令和7年度版=B7、令和6年度版以前=B8 と行がずれる）
 * → 行番号に頼らず、「薬局数」見出しの列を探し、その列の中の最大値（＝全国）を採用する。
 *   都道府県の値は全国より必ず小さいため、最大値が全国になる。
 */
function parseWorkbook(buf, debug, hintText) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheets = wb.SheetNames.map((name) => ({
    name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }),
  }));
  const allText = sheets.map((sh) => sh.name + ' ' + sh.rows.slice(0, 30).map((r) => r.join(' ')).join(' ')).join(' ');
  const year = findYearIn(allText) || findYearIn(hintText || '');
  const num = (c) => (typeof c === 'number' ? c : Number(toHalf(String(c)).replace(/[,\s]/g, '')));

  for (const sh of sheets) {
    // 見出しセル：先頭12行の中で「薬局数」を含み「無薬局」を含まないもの
    let hdr = null;
    for (let i = 0; i < Math.min(12, sh.rows.length) && !hdr; i++) {
      for (let j = 0; j < sh.rows[i].length; j++) {
        const t = toHalf(String(sh.rows[i][j])).replace(/\s/g, '');
        if (t.includes('薬局数') && !t.includes('無薬局')) { hdr = { i, j }; break; }
      }
    }
    if (!hdr) continue;
    let best = null;
    for (let i = hdr.i + 1; i < sh.rows.length; i++) {
      const v = num(sh.rows[i][hdr.j]);
      if (Number.isFinite(v) && v >= 10000 && (!best || v > best.v)) best = { v, row: i + 1 };
    }
    if (best && year) {
      const col = String.fromCharCode(65 + hdr.j);
      return { year, value: best.v, sheet: sh.name, cell: `${col}${best.row}` };
    }
    if (best && !year) console.log(`  年度が判定できませんでした（値は ${best.v}）`);
  }
  if (debug) {
    console.log(`  [診断] シート: ${wb.SheetNames.join(' / ')}  / 年度判定=${year}`);
    sheets.slice(0, 3).forEach((sh) => {
      console.log(`  [診断] シート「${sh.name}」の先頭15行:`);
      sh.rows.slice(0, 15).forEach((r, i) => console.log(`    ${i + 1}: ${r.slice(0, 8).map((c) => String(c).slice(0, 20)).join(' | ')}`));
    });
  }
  return null;
}

// 過去分の検証・一括取り込み： --backfill で一覧表示、--backfill --write で data.json に反映
async function backfill(cands) {
  const write = process.argv.includes('--write');
  const byYear = new Map();
  for (const c of cands.slice(0, 30)) {
    try {
      const res = await fetch(c.url);
      if (!res.ok) { console.log(`  取得失敗 HTTP ${res.status}: ${c.url}`); continue; }
      const p = parseWorkbook(Buffer.from(await res.arrayBuffer()), c === cands[0], c.text);
      if (!p) { console.log(`  読み取れず: ${c.url}`); continue; }
      if (!byYear.has(p.year)) byYear.set(p.year, { value: p.value, url: c.url });
    } catch (e) { console.log(`  エラー ${e.message}: ${c.url}`); }
  }
  const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
  const target = data.indicators.find((i) => i.id === IND_ID);
  const cur = new Map(target.series);
  console.log('\n年度 | ファイルの値 | data.jsonの値 | 判定');
  Array.from(byYear.keys()).sort().forEach((y) => {
    const v = byYear.get(y).value;
    const c = cur.get(y);
    console.log(`${y} | ${v} | ${c === undefined ? '(なし)' : c} | ${c === undefined ? '新規' : c === v ? '一致' : '★不一致'}`);
  });
  if (write) {
    byYear.forEach((o, y) => cur.set(y, o.value));
    target.series = Array.from(cur.entries()).sort((a, b) => a[0] - b[0]);
    target.publishedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log('\n→ data.json に反映しました');
  } else {
    console.log('\n（確認のみ。反映するには --backfill --write）');
  }
}

async function main() {
  const cands = await findCandidates();
  if (process.argv.includes('--backfill')) { await backfill(cands); return; }
  if (process.argv.includes('--list')) {
    console.log(`候補ファイル: ${cands.length}件`);
    cands.slice(0, 20).forEach((c) => console.log(`- ${c.url}\n  ${c.text.slice(0, 200)}`));
    return;
  }
  if (!cands.length) { console.error('✗ 薬局数のExcelファイルが見つかりませんでした（--list で確認してください）'); process.exit(1); }

  const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
  const target = data.indicators.find((i) => i.id === IND_ID);
  if (!target) { console.error(`✗ data.json に ${IND_ID} がありません`); process.exit(1); }
  const lastYear = target.series[target.series.length - 1];

  // 新しい順に試し、最初に読めたものを使う
  let parsed = null;
  for (const c of cands.slice(0, 5)) {
    try {
      const res = await fetch(c.url);
      if (!res.ok) { console.log(`  取得失敗 HTTP ${res.status}: ${c.url}`); continue; }
      const p = parseWorkbook(Buffer.from(await res.arrayBuffer()), c === cands[0], c.text);
      if (p) { parsed = { ...p, url: c.url }; break; }
      console.log(`  読み取れず: ${c.url}`);
    } catch (e) { console.log(`  エラー ${e.message}: ${c.url}`); }
  }
  if (!parsed) { console.error('✗ どのファイルからも薬局数を読み取れませんでした'); process.exit(1); }
  console.log(`→ 読み取り: ${parsed.year}年度 = ${parsed.value}（セル ${parsed.cell}、${parsed.url}）`);

  const prev = target.series.find(([y]) => y === parsed.year - 1);
  if (prev && Math.abs(parsed.value / prev[1] - 1) > MAX_CHANGE_RATIO) {
    console.error(`✗ 前年度(${prev[1]})との差が大きすぎます。読み違いの可能性があるため取り込みません。`);
    process.exit(1);
  }
  const existing = target.series.find(([y]) => y === parsed.year);
  if (existing && existing[1] === parsed.value) { console.log('→ 変更なし（既に同じ値が入っています）'); return; }

  const m = new Map(target.series);
  m.set(parsed.year, parsed.value);
  target.series = Array.from(m.entries()).sort((a, b) => a[0] - b[0]);
  target.publishedAt = new Date().toISOString().slice(0, 10);
  data.generatedAt = target.publishedAt;
  fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`→ 更新: ${lastYear.join('=')} → ${parsed.year}=${parsed.value}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
