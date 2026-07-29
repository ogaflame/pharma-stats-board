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
 *  どちらの統計も e-Stat 上「ファイル」のみの登録（データベース登録が
 *  無い）ため、e-Stat APIではなく該当ページを直接スクレイピングして
 *  確認しています。そのためアプリケーションIDは不要です。
 *
 *  実行方法（ローカルで試す場合）：
 *    node scripts/check-updates.js
 *
 *  Node 18以降が必要です（組み込みの fetch を使用）。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const STATUS_PATH = process.env.STATUS_PATH || path.join(__dirname, '..', 'updates-status.json');

/**
 * 今のダッシュボードが「最新」として認識している版。
 * ここを基準に、それより新しいものが公表されていないか確認する。
 * 新しい年度・調査回を実際に取り込んだら、ここも更新してください。
 */
const KNOWN_LATEST = {
  chouzai_kanteiritsu: { year: 2025 },          // 社会医療診療行為別統計（現在ダッシュボードにあるのは2025年）
  iryou_keizai_yakkyoku: { round: 25 },         // 医療経済実態調査（現在ダッシュボードにあるのは第25回）
};

/* ============================================================
   社会医療診療行為別統計：statsCode 00450048 は e-Stat 上「ファイル」
   のみの登録（データベース登録が無い）ため、getStatsList/getStatsData
   では中身を取得できない。そのため、ファイル検索ページの
   「調査年で絞込み」の一覧をスクレイピングして最新年を確認する。
   ============================================================ */
function toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

async function checkChouzaiKanteiritsu() {
  const url = 'https://www.e-stat.go.jp/stat-search/files?toukei=00450048';
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = toHalfWidthDigits(await res.text());
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 「調査年で絞込み」〜次のセクション見出しの間だけを対象にする
  const startIdx = text.indexOf('調査年で絞込み');
  if (startIdx === -1) return { ok: false, error: '「調査年で絞込み」の項目が見つかりませんでした（ページ構成が変わった可能性があります）' };
  const endIdx = text.indexOf('調査月で絞込み', startIdx);
  const section = text.slice(startIdx, endIdx === -1 ? startIdx + 4000 : endIdx);

  const years = [...section.matchAll(/(20\d{2})年/g)].map((m) => Number(m[1]));
  if (!years.length) return { ok: false, error: '年度の一覧を読み取れませんでした' };

  const maxYear = Math.max(...years);
  return {
    ok: true,
    foundLatestYear: maxYear,
    knownLatestYear: KNOWN_LATEST.chouzai_kanteiritsu.year,
    hasUpdate: maxYear > KNOWN_LATEST.chouzai_kanteiritsu.year,
    sourceUrl: url,
  };
}

/* ============================================================
   医療経済実態調査：MHLWのページ本文から「第◯◯回」の最大値を確認
   （全角数字で書かれている場合があるため、半角に正規化してから判定）
   ============================================================ */
async function checkIryouKeizai() {
  const url = 'https://www.mhlw.go.jp/bunya/iryouhoken/database/zenpan/iryoukikan.html';
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = toHalfWidthDigits(await res.text());
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const matches = [...text.matchAll(/第(\d+)\s*回医療経済実態調査/g)];
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
