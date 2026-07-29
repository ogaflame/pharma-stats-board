#!/usr/bin/env node
/**
 * ============================================================
 *  参照データベース ― 更新有無チェックスクリプト
 * ------------------------------------------------------------
 *  「社会医療診療行為別統計」「医療経済実態調査（保険薬局）」について、
 *  新しい年度・調査回が公表されているかどうかだけを確認します。
 *  データの中身は一切書き換えません（手動更新の方針のまま）。
 *
 *  結果は updates-status.json に書き出します。
 *  ダッシュボード側はこのファイルを読み、新しい版があれば
 *  参照データベースのカードにバッジを表示します。
 *
 *  実行方法（ローカルで試す場合）：
 *    ESTAT_APP_ID=xxxxxxxx node scripts/check-updates.js
 *
 *  Node 18以降が必要です（組み込みの fetch を使用）。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const APP_ID = process.env.ESTAT_APP_ID;
const STATUS_PATH = process.env.STATUS_PATH || path.join(__dirname, '..', 'updates-status.json');
const API_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json/';

/**
 * 今のダッシュボードが「最新」として認識している版。
 * ここを基準に、それより新しいものが公表されていないか確認する。
 * 新しい年度・調査回を実際に取り込んだら、ここも更新してください。
 */
const KNOWN_LATEST = {
  chouzai_kanteiritsu: { year: 2025 },          // 社会医療診療行為別統計（現在ダッシュボードにあるのは2025年）
  iryou_keizai_yakkyoku: { round: 25 },         // 医療経済実態調査（現在ダッシュボードにあるのは第25回）
};

async function estatGet(endpoint, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${API_BASE}${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = (json.GET_STATS_LIST || {}).RESULT;
  if (result && Number(result.STATUS) !== 0) {
    throw new Error(`e-Stat エラー ${result.STATUS}: ${result.ERROR_MSG}`);
  }
  return json;
}
function toArray(x) { if (x === null || x === undefined) return []; return Array.isArray(x) ? x : [x]; }
function plain(x) { if (x === null || x === undefined) return ''; if (typeof x === 'object') return String(x['$'] || ''); return String(x); }

/* ============================================================
   社会医療診療行為別統計：statsCode 00450048 の中で、
   表題に含まれる西暦年の最大値を「最新年」とみなす
   ============================================================ */
async function checkChouzaiKanteiritsu() {
  const params = { appId: APP_ID, statsCode: '00450048', limit: 1000 };
  let json;
  try {
    json = await estatGet('getStatsList', params);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const list = json.GET_STATS_LIST;
  if (!list || !list.DATALIST_INF) return { ok: false, error: '候補表が見つかりませんでした' };

  const tables = toArray(list.DATALIST_INF.TABLE_INF);
  let maxYear = 0;
  let sample = null;
  tables.forEach((t) => {
    const title = plain(t.TITLE);
    const statName = plain(t.STATISTICS_NAME);
    const m = (statName + title).match(/(20\d{2})年/);
    if (m) {
      const y = Number(m[1]);
      if (y > maxYear) { maxYear = y; sample = { title, statName, openDate: String(t.OPEN_DATE || '').slice(0, 10) }; }
    }
  });

  if (!maxYear) return { ok: false, error: '年度を特定できませんでした（表題の書式が変わった可能性があります）' };

  return {
    ok: true,
    foundLatestYear: maxYear,
    knownLatestYear: KNOWN_LATEST.chouzai_kanteiritsu.year,
    hasUpdate: maxYear > KNOWN_LATEST.chouzai_kanteiritsu.year,
    sample,
  };
}

/* ============================================================
   医療経済実態調査：MHLWのページ本文から「第◯◯回」の最大値を確認
   ============================================================ */
async function checkIryouKeizai() {
  const url = 'https://www.mhlw.go.jp/bunya/iryouhoken/database/zenpan/iryoukikan.html';
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const matches = [...text.matchAll(/第(\d+)回医療経済実態調査/g)];
  if (!matches.length) return { ok: false, error: '「第◯◯回」の記載が見つかりませんでした（ページ構成が変わった可能性があります）' };

  const rounds = matches.map((m) => Number(m[1]));
  const maxRound = Math.max(...rounds);

  return {
    ok: true,
    foundLatestRound: maxRound,
    knownLatestRound: KNOWN_LATEST.iryou_keizai_yakkyoku.round,
    hasUpdate: maxRound > KNOWN_LATEST.iryou_keizai_yakkyoku.round,
    sourceUrl: url,
  };
}

async function main() {
  if (!APP_ID) {
    console.error('環境変数 ESTAT_APP_ID が設定されていません（社会医療診療行為別統計の確認に必要です）。');
    process.exit(1);
  }

  console.log('=== 社会医療診療行為別統計 ===');
  const chouzai = await checkChouzaiKanteiritsu();
  console.log(JSON.stringify(chouzai, null, 2));

  console.log('\n=== 医療経済実態調査 ===');
  const iryoukeizai = await checkIryouKeizai();
  console.log(JSON.stringify(iryoukeizai, null, 2));

  const status = {
    checkedAt: new Date().toISOString(),
    chouzai_kanteiritsu: chouzai,
    iryou_keizai_yakkyoku: iryoukeizai,
  };

  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n', 'utf8');
  console.log(`\n書き出し完了: ${STATUS_PATH}`);

  if (chouzai.ok && chouzai.hasUpdate) console.log('\n⚠ 社会医療診療行為別統計：新しい年度が公表されている可能性があります。');
  if (iryoukeizai.ok && iryoukeizai.hasUpdate) console.log('⚠ 医療経済実態調査：新しい調査回が公表されている可能性があります。');
}

main().catch((e) => { console.error(e); process.exit(1); });
