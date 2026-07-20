/**
 * security-watchdog
 *
 * QA再発防止策C-1（07_QA\再発防止策_読み取り系防御の欠落_20260720.md）に基づく
 * 「無認証外形監視」の月次自動実行。
 *
 * 何をするか：各Workerの保護されているべきエンドポイントへ"わざと無認証で"アクセスし、
 * 期待どおり拒否（401/400等）されるかだけを見る。個人データ・PIIは一切読まない
 * （レスポンス本文は長さ/エラーコードのみ記録し、値は保存しない）。
 *
 * 結果はKV（WATCHDOG_KV, キー: watchdog_result_YYYY-MM）に保存する。
 * このWorkerにはVault/指示キューへの書き込み手段が無いため、アラートは自動送信されない。
 * 月次でインフラ担当が結果キーを目視確認する運用が前提（申し送り事項）。
 */

// 【重要】公開URL（*.workers.dev）宛のfetch()は、全workers.devが単一zone扱いのため
// 同一アカウント内Worker間でCloudflareのエラー1042（同一zoneループ防止）で拒否される。
// そのためService Bindings（wrangler.tomlの[[services]]）経由でリクエストする。
// 目的（無認証で叩いて拒否されるか）は、Service Binding経由でも同じHTTPリクエストとして
// 各Worker側のfetch(request, env)へ到達するため変わらない。

const CHECKS = [
  {
    name: 'mitsumeru-sync: profile_global 無認証GET',
    binding: 'SYNC_WORKER',
    path: '/?key=profile_global',
    method: 'GET',
    expect: [401],
  },
  {
    name: 'mitsumeru-sync: lv_global 無認証GET',
    binding: 'SYNC_WORKER',
    path: '/?key=lv_global',
    method: 'GET',
    expect: [401],
  },
  {
    name: 'fusionos-x-poster: profile_global 無認証GET',
    binding: 'XPOSTER_WORKER',
    path: '/?key=profile_global',
    method: 'GET',
    expect: [401],
  },
  {
    name: 'fusionos-x-poster: lv_global 無認証GET',
    binding: 'XPOSTER_WORKER',
    path: '/?key=lv_global',
    method: 'GET',
    expect: [401],
  },
  {
    name: 'hibiki-worker: /kanade-analyze 無認証POST',
    binding: 'HIBIKI_WORKER',
    path: '/kanade-analyze',
    method: 'POST',
    body: JSON.stringify({ promptText: 'watchdog-check' }),
    expect: [401],
  },
  {
    name: 'hibiki-worker: /stripe/verify にemailが含まれないこと',
    binding: 'HIBIKI_WORKER',
    path: '/stripe/verify?token=watchdog-nonexistent-token',
    method: 'GET',
    expectNoField: 'email',
  },
  {
    name: 'shindan-saiken-worker: /leads 無認証GET',
    binding: 'SHINDAN_WORKER',
    path: '/leads',
    method: 'GET',
    expect: [401],
  },
  {
    name: 'shindan-saiken-worker: /consults 無認証GET',
    binding: 'SHINDAN_WORKER',
    path: '/consults',
    method: 'GET',
    expect: [401],
  },
  {
    name: 'mitsumeru-compass-worker: /aggregate 無認証GET',
    binding: 'COMPASS_WORKER',
    path: '/aggregate',
    method: 'GET',
    expect: [401],
  },
];

async function runChecks(env) {
  const results = [];
  for (const check of CHECKS) {
    let pass = false;
    let actual = null;
    let detail = '';
    try {
      const service = env[check.binding];
      if (!service) throw new Error(`binding ${check.binding} が未設定`);
      const req = new Request('https://internal' + check.path, {
        method: check.method,
        headers: check.body ? { 'Content-Type': 'application/json' } : undefined,
        body: check.body,
      });
      const res = await service.fetch(req);
      actual = res.status;
      if (check.expect) {
        pass = check.expect.includes(res.status);
      } else if (check.expectNoField) {
        const text = await res.text();
        pass = !text.includes(check.expectNoField);
        detail = pass ? '' : `フィールド"${check.expectNoField}"がレスポンスに含まれている`;
      }
    } catch (e) {
      detail = `呼び出し失敗: ${String(e)}`;
    }
    results.push({ name: check.name, actual, pass, detail });
  }
  return results;
}

// 【アラート方式・2026-07-20追加】QA検証で「検知しても誰にも届かない」と指摘され追加。
// このWorker自身はVault・指示キューへの書き込み手段を持たないため、
// 「本部の定期巡回が毎回このキーの有無をチェックする」運用（本部へ申し送り済み）を前提に、
// 失敗時だけ存在する状態フラグキーとして実装する（ポーリング前提・push通知ではない）。
//
// キー：watchdog_alert_pending（WATCHDOG_KV内）
// 読み方：
//   - キーが存在する（GET結果がnullでない）→ 直近の実行で1件以上のチェックが失敗している＝要対応
//   - キーが存在しない（null）→ 直近の実行は全件pass、または一度も実行されていない
//   - 値はJSON： { ts: ISO時刻, failing: [{name, actual, detail}, ...] }
// 対応後の消し方：次回の全件pass実行で自動的にこのWorkerがdeleteする（手動削除は不要）。
const ALERT_KEY = 'watchdog_alert_pending';

async function runAndPersist(env) {
  const results = await runChecks(env);
  const allPass = results.every(r => r.pass);
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const record = { allPass, results, ts: now.toISOString() };
  if (env.WATCHDOG_KV) {
    await env.WATCHDOG_KV.put('watchdog_result_' + yyyymm, JSON.stringify(record));
    if (allPass) {
      await env.WATCHDOG_KV.delete(ALERT_KEY);
    } else {
      await env.WATCHDOG_KV.put(ALERT_KEY, JSON.stringify({
        ts: record.ts,
        failing: results.filter(r => !r.pass).map(r => ({ name: r.name, actual: r.actual, detail: r.detail })),
      }));
    }
  }
  return record;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run' && request.method === 'GET') {
      const record = await runAndPersist(env);
      return new Response(JSON.stringify(record, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('security-watchdog: use /run for manual check, or wait for monthly cron.', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAndPersist(env));
  },
};
