#!/usr/bin/env node
/**
 * ============================================================
 *  医療統計ボード ― e-Stat 自動更新スクリプト（Node.js版）
 * ------------------------------------------------------------
 *  GitHub Actions から実行する前提のスクリプトです。
 *  data.json 内の8指標（薬局数／届出薬剤師数／薬局従事薬剤師数／
 *  総人口／出生数／合計特殊出生率／社会保障給付費／国民医療費）を
 *  e-Stat API から取得し直し、data.json を上書きします。
 *
 *  実行方法（ローカルで試す場合）：
 *    ESTAT_APP_ID=xxxxxxxx node scripts/update-estat.js
 *
 *  GitHub Actions では Secrets の ESTAT_APP_ID を環境変数として渡します。
 *  （.github/workflows/update-data.yml 参照）
 *
 *  Node 18以降が必要です（組み込みの fetch を使用）。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const APP_ID = process.env.ESTAT_APP_ID;
const DATA_JSON_PATH = process.env.DATA_JSON_PATH || path.join(__dirname, '..', 'data.json');
const API_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json/';

if (!APP_ID) {
  console.error('環境変数 ESTAT_APP_ID が設定されていません。');
  process.exit(1);
}

/**
 * 指標ごとの取得条件。
 * mode: 'total'               → 単純な年次推移
 * mode: 'total_and_breakdown' → 内訳（財源別・部門別）も取得
 */
const INDICATORS = [
  {
    id: 'yakkyoku',
    label: '薬局数',
    statsCode: '00450027',
    searchWord: '薬局数',
    statisticsNameFilter: '年度報',
    titleMustInclude: ['薬局数', '都道府県'],
    mode: 'total',
  },
  {
    id: 'yakuzaishi',
    label: '届出薬剤師数',
    statsCode: '00450026',
    searchWord: '薬剤師数',
    titleMustInclude: ['薬剤師数', '業務の種別'],
    titleMustExclude: ['薬局', '医療施設従事'],
    mode: 'total',
  },
  {
    id: 'yakkyoku_juji',
    label: '薬局従事薬剤師数',
    statsCode: '00450026',
    searchWord: '薬局 薬剤師数',
    titleMustInclude: ['薬局', '医療施設従事薬剤師数', '年次推移'],
    mode: 'total',
  },
  {
    id: 'jinko',
    label: '総人口',
    statsCode: '00200524',
    searchWord: '人口推計 総人口',
    titleMustInclude: ['総人口'],
    mode: 'total',
    unitDivide: 1000, // 人 → 千人
    preferMonth: '10月', // 各年10月1日現在の値を優先（未公表月の空欄行を拾わないため）
    dropZero: true,
  },
  {
    id: 'shussho',
    label: '出生数',
    statsCode: '00450011',
    searchWord: '出生数',
    titleMustInclude: ['出生数'],
    titleMustExclude: ['都道府県', '週数'],
    mode: 'total',
  },
  {
    id: 'tfr',
    label: '合計特殊出生率',
    statsCode: '00450011',
    searchWord: '合計特殊出生率',
    titleMustInclude: ['合計特殊出生率'],
    titleMustExclude: ['都道府県'],
    mode: 'total',
  },
  {
    id: 'shakai_hoshou',
    label: '社会保障給付費',
    statsCode: '00450437',
    searchWord: '社会保障給付費 部門別推移',
    titleMustInclude: ['部門別', '推移'],
    mode: 'total_and_breakdown',
    breakdownAxisNames: ['部門', '費用項目'],
    totalScale: 'oku_to_cho', // 億円 → 兆円（小数1桁）
    truncateYears: 10, // 直近10年分のみ保持
  },
  {
    id: 'iryohi',
    label: '国民医療費',
    statsCode: '00450032',
    searchWord: '国民医療費 財源 年次',
    titleMustInclude: ['財源', '年次'],
    mode: 'total_and_breakdown',
    breakdownAxisNames: ['財源'],
    totalScale: 'oku_to_cho',
    truncateYears: 10, // 直近10年分のみ保持
  },
];

const COLOR_PALETTE = ['#1d5e86', '#6fa3c2', '#3b7a57', '#8fbf9c', '#a6472c'];

// ============================================================
// e-Stat API 呼び出し
// ============================================================
async function estatGet(endpoint, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await fetch(`${API_BASE}${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = (json.GET_STATS_LIST || json.GET_STATS_DATA || {}).RESULT;
  if (result && Number(result.STATUS) !== 0) {
    throw new Error(`e-Stat エラー ${result.STATUS}: ${result.ERROR_MSG}`);
  }
  return json;
}

function toArray(x) {
  if (x === null || x === undefined) return [];
  return Array.isArray(x) ? x : [x];
}

function plain(x) {
  if (x === null || x === undefined) return '';
  if (typeof x === 'object') return String(x['$'] || '');
  return String(x);
}

function parseNum(s) {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(String(s).replace(/[,\s]/g, ''));
  return Number.isNaN(n) ? null : n;
}

// ============================================================
// 統計表の検索・絞り込み（公開日が最新のものを採用）
// ============================================================
async function findBestTable(ind) {
  let json;
  try {
    json = await estatGet('getStatsList', {
      appId: APP_ID,
      statsCode: ind.statsCode,
      searchWord: ind.searchWord,
      limit: 1000,
    });
  } catch (e) {
    console.warn(`  ⚠ 検索結果が0件（searchWord="${ind.searchWord}"）: ${e.message}`);
    return null;
  }
  const list = json.GET_STATS_LIST;
  if (!list || !list.DATALIST_INF) return null;

  let tables = toArray(list.DATALIST_INF.TABLE_INF)
    .filter((t) => {
      const statName = plain(t.STATISTICS_NAME);
      const title = plain(t.TITLE);
      if (ind.statisticsNameFilter && !statName.includes(ind.statisticsNameFilter)) return false;
      const includeOk = (ind.titleMustInclude || []).every((k) => title.includes(k));
      if (!includeOk) return false;
      return !(ind.titleMustExclude || []).some((k) => title.includes(k));
    })
    .map((t) => ({
      id: t['@id'],
      title: plain(t.TITLE),
      openDate: String(t.OPEN_DATE || '').slice(0, 10),
    }));

  if (!tables.length) return null;
  tables.sort((a, b) => (a.openDate < b.openDate ? 1 : -1));
  return tables[0];
}

// ============================================================
// 年次推移（時間軸×全国×総数）の抽出
// ind を渡すと、月次表の月指定（preferMonth）やゼロ値除外（dropZero）を適用する
// ============================================================
async function extractSeries(statsDataId, ind) {
  ind = ind || {};
  const json = await estatGet('getStatsData', { appId: APP_ID, statsDataId, limit: 100000 });
  const sd = json.GET_STATS_DATA.STATISTICAL_DATA;
  const classObjs = toArray(sd.CLASS_INF.CLASS_OBJ);
  const values = toArray(sd.DATA_INF.VALUE);

  const wanted = {};
  const timeName = {};
  classObjs.forEach((obj) => {
    const id = obj['@id'];
    const items = toArray(obj.CLASS);
    if (id === 'time') {
      items.forEach((i) => { timeName[i['@code']] = i['@name']; });
      return;
    }
    let pick;
    if (id === 'area') pick = items.find((i) => i['@name'] === '全国');
    else pick = items.find((i) => i['@name'] === '総数');
    if (!pick) [pick] = items;
    wanted[`@${id}`] = pick['@code'];
  });

  const keys = Object.keys(wanted);
  // 年ごとに1点だけ残す（月次表対策）。preferMonth があればその月を優先、
  // 無ければその年で最後に見つかった有効値を採用する
  const byYear = new Map();
  values.forEach((v) => {
    const hit = keys.every((k) => v[k] === wanted[k]);
    if (!hit) return;
    const label = timeName[v['@time']] || '';
    const m = label.match(/(\d{4})/);
    if (!m) return;
    const year = Number(m[1]);
    const num = parseNum(v['$']);
    if (num === null) return;
    if (ind.dropZero && num === 0) return;

    const isPreferredMonth = Boolean(ind.preferMonth && label.includes(ind.preferMonth));
    const existing = byYear.get(year);
    if (!existing) {
      byYear.set(year, { value: num, isPreferredMonth });
    } else if (isPreferredMonth && !existing.isPreferredMonth) {
      // 優先月のデータが見つかったら、そちらに差し替える
      byYear.set(year, { value: num, isPreferredMonth });
    } else if (!existing.isPreferredMonth && !isPreferredMonth) {
      // どちらも優先月ではない場合は、後に見つかった方（＝新しい改定値）を採用
      byYear.set(year, { value: num, isPreferredMonth });
    }
    // 既存が優先月・今回が優先月でない場合は既存を維持
  });

  const out = Array.from(byYear.entries()).map(([year, o]) => [year, o.value]);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// ============================================================
// 内訳（財源別・部門別など）の抽出：最新年の各カテゴリ値
// ============================================================
async function extractBreakdown(statsDataId, ind) {
  const json = await estatGet('getStatsData', { appId: APP_ID, statsDataId, limit: 100000 });
  const sd = json.GET_STATS_DATA.STATISTICAL_DATA;
  const classObjs = toArray(sd.CLASS_INF.CLASS_OBJ);
  const values = toArray(sd.DATA_INF.VALUE);

  let breakdownAxisId = null;
  let breakdownItems = null;
  classObjs.forEach((obj) => {
    const objName = plain(obj['@name'] || '');
    if ((ind.breakdownAxisNames || []).some((n) => objName.includes(n))) {
      breakdownAxisId = obj['@id'];
      breakdownItems = toArray(obj.CLASS);
    }
  });
  if (!breakdownAxisId) {
    console.warn(`  ⚠ 内訳軸が見つかりませんでした（${ind.label}）`);
    return null;
  }

  const timeObj = classObjs.find((o) => o['@id'] === 'time');
  const timeItems = toArray(timeObj.CLASS);
  let latestTimeCode = null;
  let latestYear = -1;
  timeItems.forEach((i) => {
    const m = String(i['@name']).match(/(\d{4})/);
    if (m && Number(m[1]) > latestYear) { latestYear = Number(m[1]); latestTimeCode = i['@code']; }
  });

  const fixed = {};
  classObjs.forEach((obj) => {
    const id = obj['@id'];
    if (id === 'time' || id === breakdownAxisId) return;
    const items = toArray(obj.CLASS);
    let pick;
    if (id === 'area') pick = items.find((i) => i['@name'] === '全国');
    else pick = items.find((i) => i['@name'] === '総数');
    if (!pick) [pick] = items;
    fixed[`@${id}`] = pick['@code'];
  });

  const out = [];
  breakdownItems.forEach((catItem) => {
    const target = { ...fixed, [`@${breakdownAxisId}`]: catItem['@code'], '@time': latestTimeCode };
    const hit = values.find((v) => Object.keys(target).every((k) => v[k] === target[k]));
    if (!hit) return;
    const num = parseNum(hit['$']);
    if (num === null) return;
    out.push({ label: plain(catItem['@name']), value: num });
  });

  return { year: latestYear, items: out };
}

// ============================================================
// 診断モード： node scripts/update-estat.js --list <指標id>
// titleMustInclude/Exclude の絞り込み前の「候補表」を一覧表示する
// ============================================================
async function listCandidates(indicatorId) {
  const ind = INDICATORS.find((i) => i.id === indicatorId);
  if (!ind) {
    console.error(`指標IDが見つかりません: ${indicatorId}`);
    console.error(`使える指標ID: ${INDICATORS.map((i) => i.id).join(', ')}`);
    process.exit(1);
  }
  console.log(`=== ${ind.label}（searchWord="${ind.searchWord}"）の候補表 ===\n`);

  let json;
  try {
    json = await estatGet('getStatsList', {
      appId: APP_ID, statsCode: ind.statsCode, searchWord: ind.searchWord, limit: 1000,
    });
  } catch (e) {
    console.log(`検索結果が0件でした（searchWord="${ind.searchWord}"）。`);
    console.log(`e-Statからの応答: ${e.message}`);
    console.log('→ searchWord を単純な単語1つに減らして再実行してみてください。');
    return;
  }
  const list = json.GET_STATS_LIST;
  if (!list || !list.DATALIST_INF) {
    console.log('(該当なし)');
    return;
  }
  const tables = toArray(list.DATALIST_INF.TABLE_INF).map((t) => ({
    id: t['@id'],
    statName: plain(t.STATISTICS_NAME),
    title: plain(t.TITLE),
    openDate: String(t.OPEN_DATE || '').slice(0, 10),
  }));
  tables.sort((a, b) => (a.openDate < b.openDate ? 1 : -1));

  tables.slice(0, 40).forEach((t) => {
    const passInclude = (ind.titleMustInclude || []).every((k) => t.title.includes(k));
    const passExclude = !(ind.titleMustExclude || []).some((k) => t.title.includes(k));
    const currentFilterResult = passInclude && passExclude ? '✓現在の条件に合致' : '  (条件に非該当)';
    console.log(`[${t.id}] ${t.openDate} ${currentFilterResult}`);
    console.log(`  統計名: ${t.statName}`);
    console.log(`  表題　: ${t.title}\n`);
  });
  console.log(`(全${tables.length}件中、上位40件を表示)`);
}

// ============================================================
// メイン処理
// ============================================================
async function main() {
  const listIdx = process.argv.indexOf('--list');
  if (listIdx !== -1) {
    const indicatorId = process.argv[listIdx + 1];
    await listCandidates(indicatorId);
    return;
  }

  if (!fs.existsSync(DATA_JSON_PATH)) {
    console.error(`data.json が見つかりません: ${DATA_JSON_PATH}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));

  const summary = [];

  for (const ind of INDICATORS) {
    console.log(`\n=== ${ind.label} ===`);
    try {
      const table = await findBestTable(ind);
      if (!table) {
        console.warn('  → 該当表が見つかりませんでした。スキップします。');
        summary.push({ id: ind.id, status: 'not_found' });
        continue;
      }
      console.log(`  → 採用: ${table.title}（statsDataId=${table.id}, 公開日=${table.openDate}）`);

      const rawSeries = await extractSeries(table.id, ind);
      if (!rawSeries.length) {
        console.warn('  → データが空でした。スキップします。');
        summary.push({ id: ind.id, status: 'empty' });
        continue;
      }

      let series = rawSeries;
      if (ind.unitDivide && ind.unitDivide !== 1) {
        series = series.map(([y, v]) => [y, Math.round((v / ind.unitDivide) * 10) / 10]);
      }
      if (ind.totalScale === 'oku_to_cho') {
        series = rawSeries.map(([y, v]) => [y, Math.round((v / 10000) * 10) / 10]);
      }

      const target = (data.indicators || []).find((i) => i.id === ind.id);
      if (!target) {
        console.warn(`  ⚠ data.json 内に id=${ind.id} が見つかりません。スキップします。`);
        summary.push({ id: ind.id, status: 'no_target_in_json' });
        continue;
      }

      const prevLast = target.series[target.series.length - 1];
      const prevCount = target.series.length;

      // 「取得できた分だけ既存の推移に追加（同じ年は上書き）」を全指標共通の既定動作にする。
      // e-Statから取得できる範囲が表によって違っても（単年スナップショットでも全期間でも）、
      // 既存の履歴が消えることがないようにするため。
      const merged = new Map(target.series.map(([y, v]) => [y, v]));
      series.forEach(([y, v]) => {
        if (v === 0 || v === null) return; // 0値・null値はどの指標でもあり得ないため取り込まない
        merged.set(y, v);
      });
      // 既存データの中に紛れ込んだ0値（未公表期間の空欄取得等による過去の不具合）も、
      // ここで一緒に取り除く（自己修復）
      Array.from(merged.entries()).forEach(([y, v]) => {
        if (v === 0 || v === null) merged.delete(y);
      });
      series = Array.from(merged.entries()).sort((a, b) => a[0] - b[0]);

      if (ind.truncateYears) {
        series = series.slice(-ind.truncateYears);
      }

      target.series = series;
      target.publishedAt = table.openDate;
      const newLast = series[series.length - 1];
      const added = series.length - prevCount;
      console.log(`  → 更新: ${prevLast ? prevLast.join('=') : '(なし)'} → ${newLast.join('=')}　（保持年数: ${series.length}、新規追加: ${Math.max(added, 0)}件）`);

      let breakdownInfo = null;
      if (ind.mode === 'total_and_breakdown') {
        const breakdown = await extractBreakdown(table.id, ind);
        if (breakdown && target.financing) {
          const yearKey = String(breakdown.year);
          target.financing.years[yearKey] = breakdown.items.map((it, i) => ({
            label: it.label,
            value: it.value,
            color: COLOR_PALETTE[i % COLOR_PALETTE.length],
          }));
          breakdownInfo = `${yearKey}年: ${breakdown.items.length}区分`;
          console.log(`  → 内訳更新: ${breakdownInfo}`);
        }
      }

      summary.push({ id: ind.id, status: 'updated', latest: newLast, breakdown: breakdownInfo });
    } catch (e) {
      console.error(`  ✗ エラー: ${e.message}`);
      summary.push({ id: ind.id, status: 'error', message: e.message });
    }
    // API に優しく
    await new Promise((r) => { setTimeout(r, 400); });
  }

  data.generatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(DATA_JSON_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');

  console.log('\n=== まとめ ===');
  summary.forEach((s) => console.log(JSON.stringify(s)));

  const failed = summary.filter((s) => s.status === 'error' || s.status === 'not_found');
  if (failed.length) {
    console.warn(`\n⚠ ${failed.length}件、取得できなかった指標があります。ログを確認してください。`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
