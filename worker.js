/**
 * Mitsumeru Sync Worker — Cloudflare Workers KV proxy ＋ Google連携（カレンダー・Vault）
 * デプロイ方法: Cloudflare Dashboard > Workers & Pages > mitsumeru-sync > Quick Edit
 * または wrangler deploy
 *
 * KV namespace binding 変数名: MITSUMERU_KV または KV（どちらでも動く。getKV参照）
 *
 * Cron Triggerは使用していない（2026-07-14・柴山さんご本人の判断により、朝の編成・週次ログ
 * エクスポートの両方を撤去。Cloudflare側のCron Trigger登録もあわせて削除すること）。
 *
 * 【必要なもの】
 *   - Secret: GOOGLE_SERVICE_ACCOUNT_KEY（サービスアカウントの秘密鍵JSON。カレンダー・Vault
 *     両方で共通利用。同じサービスアカウントにCalendar API・Drive API両方を有効化し、対象の
 *     カレンダー・Vaultフォルダをこのサービスアカウントのメールアドレスと共有しておくこと）
 *   - Secret: GOOGLE_CALENDAR_ID（Googleカレンダー連携用）
 *   - Secret: GOOGLE_VAULT_FOLDER_ID（Vault自動書き出し用。書き出し先フォルダのGoogle Drive
 *     フォルダID。フォルダURL末尾の文字列）
 *     ↑いずれもSecret未設定時は該当機能のみ無音でスキップ（他機能に影響しない）
 *   - Secret: MOBILE_ACCESS_KEY（GET /me用の簡易共有キー。柴山さんご本人のみが知る文字列。
 *     未設定時は/meが常に401を返す＝安全側に倒れる）
 *   - Secret: PRIVATE_ACCESS_TOKEN（2026-07-19緊急封じ込め・private_プレフィックスの
 *     全キーへのGET/PUTに必須の共有トークン。mitsumeru_private.htmlが?token=として送信する。
 *     未設定時はprivate_キーへのアクセスが常に401＝安全側に倒れる）
 */

// KV名前空間バインディング。変数名は MITSUMERU_KV / KV のどちらでも動くようにする。
function getKV(env) {
  return env.MITSUMERU_KV || env.KV;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

// 版数確認用（2026-08-04・設計発注）。デプロイのたびに手で更新する（自動生成の仕組みは
// 作らない・完璧さより外から見えることを優先、という発注時の指示に従う）。
const BUILD_VERSION = '2026-08-05T08:50 FP-0018-ai-narrative-to-vault';

export default {
  async fetch(request, env) {
    // OPTIONSプリフライトリクエスト（モバイルブラウザのCORS対応）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ===== 版数確認（2026-08-04・設計発注・QA2指摘対応）=====
    // デプロイ確認が「開発Bの自己申告」に依存していた（外から検証する手段が無かった）ため新設。
    // 認証不要（秘密情報を含まないため）。デプロイ時にBUILD定数を手で更新する運用。
    if (url.pathname === '/version' && request.method === 'GET') {
      return new Response(JSON.stringify({ ok: true, build: BUILD_VERSION }), { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // ===== G連携基盤：ミツメルの記録をGoogleカレンダーへ自動書き出し（Phase1・私専用） =====
    if (url.pathname === '/sync-calendar' && request.method === 'POST') {
      return handleSyncCalendar(request, env);
    }

    // ===== G連携基盤：ミツメルの記録をVault（Google Drive）へ自動書き出し（Phase2・私専用） =====
    if (url.pathname === '/sync-vault' && request.method === 'POST') {
      return handleSyncVault(request, env);
    }

    // ===== Vault用OAuth2初回セットアップ（案B・2026-07-25・柴山さん厳命） =====
    if (url.pathname === '/vault-oauth-setup' && request.method === 'POST') {
      return handleVaultOAuthSetup(request, env);
    }

    // ===== ダッシュボード自動反映：ファイル選択の保存（2026-07-26・設計発注） =====
    if (url.pathname === '/vault-dashboard-setup' && request.method === 'POST') {
      return handleVaultDashboardSetup(request, env);
    }

    // ===== ダッシュボード自動反映：本文書き込み（2026-07-26・設計発注） =====
    if (url.pathname === '/vault-dashboard-write' && request.method === 'POST') {
      return handleVaultDashboardWrite(request, env);
    }

    // ===== ダッシュボード自動反映：本文読み込み（2026-07-28・設計発注・柴山さん実害報告） =====
    if (url.pathname === '/vault-dashboard-read' && request.method === 'POST') {
      return handleVaultDashboardRead(request, env);
    }

    // ===== 読書メモ（口述記録の拡張・2026-07-21・柴山さん指示）：本ごとにVaultへ音声メモを蓄積 =====
    if (url.pathname === '/sync-vault-note' && request.method === 'POST') {
      return handleSyncVaultNote(request, env);
    }
    if (url.pathname === '/sync-vault-note' && request.method === 'GET') {
      const t = url.searchParams.get('token');
      if (!env.PRIVATE_ACCESS_TOKEN || t !== env.PRIVATE_ACCESS_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      return handleGetVaultNote(request, env);
    }

    // ===== 入力箱（ミツメルv9・2026-07-24・設計発注）：マルチデバイス投入 =====
    if (url.pathname === '/inbox-drop' && request.method === 'POST') {
      return handleInboxDrop(request, env);
    }

    // ===== 朝プロンプトVault連携（2026-07-26・設計発注・柴山さん承認） =====
    if (url.pathname === '/vault-morning-context' && request.method === 'POST') {
      return handleVaultMorningContext(request, env);
    }

    // ===== 「育つ仕組み」：サルベージ週次学習ログの読み込み（2026-07-26・設計発注） =====
    if (url.pathname === '/vault-learning-log' && request.method === 'POST') {
      return handleVaultLearningLog(request, env);
    }

    // ===== ダンプボックス：種類を問わずファイルをVaultへ放り込む（2026-07-28・設計発注・柴山さん承認） =====
    if (url.pathname === '/vault-inbox-upload' && request.method === 'POST') {
      return handleVaultInboxUpload(request, env);
    }

    // ===== 朝刊反応：見出し一覧の読み込み（2026-07-30・柴山さん直命・生成⇔検証ループ） =====
    if (url.pathname === '/vault-asakan-read' && request.method === 'POST') {
      return handleVaultAsakanRead(request, env);
    }

    // ===== 【廃止済み・2026-08-01】朝刊反応：3択タップ式の反応保存 =====
    // 柴山さん・設計との壁打ちにより、タップ式反応（👍/🤷/👎）自体が蒸留の役に立たないと判断され
    // 廃止。コメントは既存の随時メモ（#思考タグ）としてそのまま保存する方式へ変更したため、
    // 専用の書き込みエンドポイント・handleVaultAsakanWrite()関数は不要になった（削除済み）。

    // ===== 【一時】ダッシュボード自動反映のOAuth許可範囲確認用（2026-07-26・確認後に撤去予定） =====
    // 読み取り専用。書き込みは一切行わない。00_代表ダッシュボード.mdが現在のOAuth許可範囲内で
    // 見えるか（drive.fileスコープでアクセス可能か）だけを確認する。
    if (url.pathname === '/debug-dashboard-lookup' && request.method === 'POST') {
      return handleDebugDashboardLookup(request, env);
    }

    // ===== アクセス解析（簡易・自前実装）：案件0の原因切り分け用（2026-07-14） =====
    // 個人情報・IPアドレス等は一切記録しない。ページ名＋日付ごとの匿名カウントのみ。
    if (url.pathname === '/pv' && request.method === 'GET') {
      return handlePageview(request, env);
    }

    // ===== AI呼び出しの中継（2026-07-19・ブラウザCORS回避）=====
    // 利用者自身のAnthropic APIキーをそのまま中継するだけで、キー自体はどこにも保存・記録しない。
    // ブラウザから api.anthropic.com を直接叩くとCORSでブロックされるため、これまで利用者に
    // ブラウザのセキュリティ機能を無効化させる案内をしていた（重大な設計ミス）。本エンドポイントは
    // それに代わり、Worker側で中継するだけでCORSを解消する（キーの持ち主・課金主体は利用者のまま）。
    if (url.pathname === '/analyze-proxy' && request.method === 'POST') {
      return handleAnalyzeProxy(request, env);
    }

    // ===== モバイルセッション向け・柴山さんご本人の記録閲覧（読み取り専用・2026-07-15） =====
    // GET /me?key=<MOBILE_ACCESS_KEY>&date=YYYY-MM-DD
    // 柴山さんご本人がモバイル（wrangler CLI無し）からmitsumeru_private.htmlの
    // 当日/直近の記録を見るためのもの。書き込み・削除は一切なし。
    if (url.pathname === '/me' && request.method === 'GET') {
      return handleMe(request, env);
    }

    // ===== 安全装置①：プライベート版データのKV分離移行（2026-07-03・一度きりの手動トリガー） =====
    // ドライラン：対象キーの一覧のみ返す（書き込みなし）
    if (url.searchParams.get('action') === 'migrate_private_dryrun') {
      return handleMigratePrivate(env, { commit: false });
    }
    // 本実行：バックアップ→private_プレフィックスへコピー（既存の本番キーは無変更・削除しない）
    if (url.searchParams.get('action') === 'migrate_private_commit') {
      return handleMigratePrivate(env, { commit: true });
    }

    const key = url.searchParams.get('key');

    if (!key) {
      return new Response(JSON.stringify({ error: 'key is required' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // KVキー長チェック（Cloudflare KVの上限512バイト）
    if (key.length > 512) {
      return new Response(JSON.stringify({ error: 'key too long' }), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // 安全装置④（2026-07-19・緊急封じ込め）：private_ プレフィックスのキー、
    // profile_global / lv_global、および安全装置⑤導入前の「日付のみキー」
    // （例：morning_2026-07-19。柴山さんご本人の実データ）は、GET/PUTともに
    // 有効な ?token=（PRIVATE_ACCESS_TOKEN Secretと一致）が無ければ一律拒否する。
    // 「呼び出し側が送らないから安全」ではなく、Worker自身がキー名で構造的に拒否する設計。
    const LEGACY_DATE_KEY_TYPES = ['morning', 'evening', 'memos', 'dispatch', 'output', 'calendar', 'delay', 'fusionos_status'];
    // 安全装置⑤（2026-07-19）：公開のお試し版は type_訪問者ID_日付 という新形式のキーのみを使う。
    // 新形式は訪問者ごとに完全分離されているため、引き続き無認証でよい。
    const isVisitorScopedKey = LEGACY_DATE_KEY_TYPES.some(
      t => key.startsWith(t + '_v') && /^v[a-z0-9]+_/.test(key.slice(t.length + 1))
    );
    const isLegacyBareDateKey = !isVisitorScopedKey && LEGACY_DATE_KEY_TYPES.some(t => key.startsWith(t + '_'));
    // 原則6（2026-07-26・実装安全原則v2）：test_ プレフィックスは意図的にこのガード対象外。
    // テストモード時、フロントは保存先をprivate_からtest_へ強制的に差し替えるため、
    // 本物のトークンでテストしても書き込み先が物理的に本番データ領域に到達しない設計。
    if (key.startsWith('private_') || key === 'profile_global' || key === 'lv_global' || isLegacyBareDateKey) {
      const token = url.searchParams.get('token');
      if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
        return new Response(JSON.stringify({ error: 'private data requires a valid token' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    // 安全装置⑥（2026-08-28・FUS-337緊急対応）：scan_ プレフィックス（mitsumeru_scan.html・
    // mitsumeru_tekisei_check.html・ta_scan.html・pm_scan.htmlの受検者ロスター＝採用候補者の
    // 適性検査結果を含む）は、GET（一覧の閲覧＝管理者操作）のみtoken必須にする。
    // PUT（受検者本人による診断結果の保存）はtoken無しの受検者が行う操作のため、
    // 引き続き無認証で許可する（保護対象は「誰でも読める」であり「誰でも保存できる」ではない）。
    if (key.startsWith('scan_') && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
        return new Response(JSON.stringify({ error: 'reading scan_ rosters requires a valid token' }), {
          status: 401,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    if (request.method === 'PUT') {
      let body;
      try {
        body = await request.text();
        // JSON妥当性チェック
        JSON.parse(body);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      // KV保存（TTL: 90日 = 7776000秒）
      await getKV(env).put(key, body, { expirationTtl: 7776000 });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET') {
      const value = await getKV(env).get(key);

      return new Response(JSON.stringify({ value: value ?? null }), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          // モバイル回線でのキャッシュを防ぐ
          'Cache-Control': 'no-store',
        },
      });
    }

    return new Response(JSON.stringify({ error: 'method not allowed' }), {
      status: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};

// ===== 安全装置①：プライベート版データのKV分離移行（2026-07-03） =====
// mitsumeru_private.html は元々 mitsumeru_app.html と同一のKVキー（例：evening_2026-07-03）を
// 共有していた。既存データを private_ プレフィックス配下へ一括コピーし、以後は物理的に分離する。
// 対象プレフィックス（プライベート版が実際に書き込んでいた種別のみ。dispatch_・knowledge_* 等の
// 他システム共有キーは対象外）。
const MIGRATE_TARGET_PREFIXES = [
  'evening_', 'morning_', 'memos_', 'output_', 'calendar_', 'delay_',
  'profile_global', 'lv_global', 'fusionos_status_',
];
const MIGRATE_DONE_KEY = 'private_migration_done';
const MIGRATE_BACKUP_KEY = 'mitsumeru_migration_backup_20260703';

async function listAllKeys(kv) {
  let keys = [];
  let cursor;
  do {
    const res = await kv.list(cursor ? { cursor } : {});
    keys = keys.concat(res.keys.map(k => k.name));
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return keys;
}

async function handleMigratePrivate(env, { commit }) {
  const kv = getKV(env);
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  const already = await kv.get(MIGRATE_DONE_KEY);
  if (commit && already) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'already migrated', doneInfo: JSON.parse(already) }), { status: 200, headers });
  }

  const allKeys = await listAllKeys(kv);
  const toMigrate = allKeys.filter(k =>
    MIGRATE_TARGET_PREFIXES.some(p => k.startsWith(p)) && !k.startsWith('private_')
  );

  if (!commit) {
    // ドライラン：対象キーの一覧のみ返す（KVへの書き込みは一切行わない）
    return new Response(JSON.stringify({ ok: true, commit: false, targetCount: toMigrate.length, keys: toMigrate }), { status: 200, headers });
  }

  // 本実行：①バックアップ→②private_プレフィックスへコピー（元キーは削除しない＝本番側は無変更）
  const backup = {};
  for (const k of toMigrate) {
    backup[k] = await kv.get(k);
  }
  await kv.put(MIGRATE_BACKUP_KEY, JSON.stringify(backup), { expirationTtl: 7776000 });

  let copiedCount = 0;
  for (const k of toMigrate) {
    if (backup[k] === null || backup[k] === undefined) continue;
    await kv.put('private_' + k, backup[k], { expirationTtl: 7776000 });
    copiedCount++;
  }

  const doneInfo = { _ts: Date.now(), targetCount: toMigrate.length, copiedCount };
  await kv.put(MIGRATE_DONE_KEY, JSON.stringify(doneInfo), { expirationTtl: 7776000 });

  return new Response(JSON.stringify({ ok: true, commit: true, ...doneInfo, keys: toMigrate }), { status: 200, headers });
}

// JSTの今日の日付 YYYY-MM-DD を返す（Cronは22:00 UTCに発火＝JST翌日7:00）
function jstDateStr() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

// ===== AI呼び出しの中継（利用者自身のAPIキーをそのまま中継・保存しない） =====
async function handleAnalyzeProxy(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400, headers }); }

  const { apikey, promptText, maxTokens = 4000, temperature } = body;
  if (!apikey || !String(apikey).startsWith('sk-ant-')) {
    return new Response(JSON.stringify({ error: '有効なAnthropic APIキー（sk-ant-...）が必要です' }), { status: 401, headers });
  }
  if (!promptText || typeof promptText !== 'string') {
    return new Response(JSON.stringify({ error: 'promptText（文字列）が必要です' }), { status: 400, headers });
  }

  // 2026-07-26設計指摘：出力の揺れを抑えるためtemperatureを転送可能にする（省略時はAnthropic既定値）
  const claudeBody = { model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: promptText }] };
  if (temperature !== undefined && temperature !== null) claudeBody.temperature = temperature;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': String(apikey).substring(0, 200),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(claudeBody),
  });

  const data = await claudeRes.json().catch(() => ({}));
  if (!claudeRes.ok || data.error) {
    return new Response(JSON.stringify({ error: data.error?.message || 'Claude API error' }), { status: 502, headers });
  }
  return new Response(JSON.stringify({ content: data.content || [] }), { status: 200, headers });
}

// ===== アクセス解析（簡易・自前実装） =====
// ?page=<英数字・アンダースコアのみ> を受け取り、pv_<page>_<JST日付> のカウントを1増やす。
// IPアドレス・User-Agent・個人情報は一切記録しない。GETのみ（<img>ビーコンとしても使える形）。
async function handlePageview(request, env) {
  const url = new URL(request.url);
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  const page = (url.searchParams.get('page') || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 60);
  if (!page) {
    return new Response(JSON.stringify({ error: 'page is required' }), { status: 400, headers });
  }
  const kv = getKV(env);
  const key = 'pv_' + page + '_' + jstDateStr();
  const current = parseInt((await kv.get(key)) || '0', 10);
  await kv.put(key, String(current + 1), { expirationTtl: 7776000 }); // 90日
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// ===== モバイルセッション向け・柴山さんご本人の記録閲覧（読み取り専用） =====
// private_morning_{date}／private_evening_{date}／private_memos_{date}のみ返す。
// private_profile_globalには一切アクセスしない（G2と同じ制約）。書き込み・削除は一切なし。
async function handleMe(request, env) {
  const url = new URL(request.url);
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (!env.MOBILE_ACCESS_KEY || url.searchParams.get('key') !== env.MOBILE_ACCESS_KEY) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers });
  }

  const date = (url.searchParams.get('date') || jstDateStr()).replace(/[^0-9-]/g, '').substring(0, 10);
  const record = await getPrivateDailyRecord(env, date);
  return new Response(JSON.stringify({ date, ...record }), { status: 200, headers });
}

// ═══════════════════════════════════════════════
//  G連携基盤：ミツメルの記録をGoogleカレンダーへ自動書き出し（Phase1・柴山さんご本人専用）
//  設計：06_イノベーション/Google連携基盤_統合実装設計_20260711.md §3
//  G1：認証（サービスアカウントJWT）／G2：KV読み取り／G3-カレンダー：書き込み
// ═══════════════════════════════════════════════

async function handleSyncCalendar(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  // Secret未設定時は無音でスキップする（エラーにしない）
  if (!env.GOOGLE_SERVICE_ACCOUNT_KEY || !env.GOOGLE_CALENDAR_ID) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'Google連携が未設定です（Secret未登録）' }), { status: 200, headers });
  }

  let date;
  try {
    const body = await request.json();
    date = body.date || jstDateStr();
  } catch (e) {
    date = jstDateStr();
  }

  try {
    const record = await getPrivateDailyRecord(env, date);          // G2
    const accessToken = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/calendar'); // G1
    const event = await writeCalendarEvent(env, accessToken, date, record); // G3-カレンダー
    return new Response(JSON.stringify({ ok: true, date, eventId: event.id }), { status: 200, headers });
  } catch (e) {
    // 2026-08-04是正（FP-0006・QA2指摘）：本エンドポイントは柴山さんご本人専用のベストエフォート
    // 連携で、呼び出し元（syncToGoogleCalendar）も結果を無視するfire-and-forgetになっている
    // （既存コメント「失敗しても既存機能には一切影響させない」参照）。実測でGOOGLE_CALENDAR_ID
    // 側の404（notFound）を確認済み＝外部設定側の問題で、コード修正だけでは解消しない。
    // 500（サーバ側の想定外エラー）として返すと監視・QAが「実装が壊れている」と誤検知するため、
    // 他の任意連携（sync-vault等のvaultResult）と同じ「200でok:falseを返す」形に統一する。
    console.error('[sync-calendar] 失敗（外部Google Calendar API起因の可能性）:', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 200, headers });
  }
}

// ── G2：KVデータ読み取りブロック ──
// mitsumeru_private.html の cloudSave() は private_{type}_{date} 形式でKVへ保存している。
// プロファイルキー（private_profile_global）には設計上の制約により一切アクセスしない。
async function getPrivateDailyRecord(env, date) {
  const kv = getKV(env);
  // FP-0018（2026-08-05・設計発注）：夜のAI生成ナラティブ（翌日戦略の全文）は既存の
  // private_output_{date} KV（generateEvening()がcloudSave('output', ...)で書いている）に
  // 既に保存されていたが、ここで読んでいなかったためVaultへ反映されていなかった。新しい
  // KV名前空間・エンドポイントは作らず、既存のoutputキーを読み先に加えるだけで足りる。
  const [morningRaw, eveningRaw, memosRaw, outputRaw] = await Promise.all([
    kv.get('private_morning_' + date),
    kv.get('private_evening_' + date),
    kv.get('private_memos_' + date),
    kv.get('private_output_' + date),
  ]);
  const parseJson = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };
  return {
    morning: parseJson(morningRaw),
    evening: parseJson(eveningRaw),
    memos: parseJson(memosRaw),
    output: parseJson(outputRaw),
  };
}

// ── G1：Google認証ブロック（サービスアカウント方式・JWT Bearer） ──
function base64url(input) {
  const bytes = typeof input === 'string'
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getGoogleAccessToken(env, scope) {
  const keyJson = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: keyJson.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claims));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(keyJson.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + base64url(signature);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Googleアクセストークン取得失敗: ' + (data.error_description || data.error || JSON.stringify(data)));
  }
  return data.access_token;
}

// ── G1-Vault：柴山さんご本人のOAuth2（案B・2026-07-25・設計指示）──
// サービスアカウントは個人Driveに書き込み容量を持たない（storageQuotaExceeded・実測確認済み）
// ため、Vault書き込みだけは柴山さんご本人のOAuth2 refresh_tokenで行う。
// カレンダー用のgetGoogleAccessToken（サービスアカウントJWT）は一切変更しない
// （設計書§4：回帰リスクの封じ込め）。
// API呼び出し削減①（2026-07-26・設計発注）：アクセストークンはGoogle側で通常1時間有効なのに
// 呼び出しのたびに毎回リフレッシュしていた（calcMorning()1回の押下で最大3回重複）。
// KVに55分（3300秒）TTLでキャッシュし、有効期限内は再リフレッシュしない。
// キャッシュミス・TTL切れ時は従来どおりリフレッシュするため、フォールバック動作は変えていない。
async function getVaultAccessToken(env) {
  const kv = getKV(env);
  const cached = await kv.get('vault_access_token_cache');
  if (cached) return cached;

  const refreshToken = await kv.get('vault_oauth_refresh');
  if (!refreshToken) {
    throw new Error('Vault用OAuth2が未設定です（初回セットアップが必要）');
  }
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRETが未設定です');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Vaultアクセストークン更新失敗: ' + (data.error_description || data.error || JSON.stringify(data)));
  }
  await kv.put('vault_access_token_cache', data.access_token, { expirationTtl: 3300 });
  return data.access_token;
}

// 初回セットアップ：フロントが取得した認可コードをrefresh_tokenへ交換しKVへ保存する。
// POST { code, folderId, token }（tokenはPRIVATE_ACCESS_TOKEN）
async function handleVaultOAuthSetup(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers }); }

  const { code, folderId, token } = body;
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  if (!code || !folderId) {
    return new Response(JSON.stringify({ ok: false, error: 'codeとfolderIdは必須です' }), { status: 400, headers });
  }
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return new Response(JSON.stringify({ ok: false, error: 'GOOGLE_OAUTH_CLIENT_ID/SECRETが未設定です' }), { status: 500, headers });
  }

  try {
    // 技術判断②（設計書§2）：Web applicationクライアント（confidential client）のため
    // client_secretを含めた4パラメータでの交換が必須。省略するとinvalid_clientになる。
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: 'postmessage',
        grant_type: 'authorization_code',
      }).toString(),
    });
    const data = await res.json();
    if (!data.refresh_token) {
      return new Response(JSON.stringify({ ok: false, error: 'refresh_token取得失敗: ' + (data.error_description || data.error || JSON.stringify(data)) }), { status: 502, headers });
    }
    const kv = getKV(env);
    await kv.put('vault_oauth_refresh', data.refresh_token);
    await kv.put('vault_oauth_folder', folderId);
    // 2026-07-31発見（朝刊反応の実データ最終確認中）：ダッシュボード設定側（handleVaultDashboardSetup）
    // は再認可後に古いキャッシュ済みアクセストークンを無効化しているが、こちら（初回/再セットアップ側）
    // には同じ処理が漏れていた。スコープを拡張して再認可しても、TTL内（最大55分）は旧スコープの
    // キャッシュ済みトークンが使われ続け、新しい権限がすぐに反映されない不具合だったため是正。
    await kv.delete('vault_access_token_cache');
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// ダッシュボード自動反映：Pickerでファイル自体を選んでもらった結果（fileId）をKVへ保存する
// だけの単純なエンドポイント（2026-07-26・設計発注）。drive.fileスコープはフォルダ選択だけでは
// 既存ファイルへアクセスできない（WebSearchで裏取り済み）ため、ファイル単位で権限を得る。
async function handleVaultDashboardSetup(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers }); }

  const { fileId, code, token } = body;
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  if (!fileId) {
    return new Response(JSON.stringify({ ok: false, error: 'fileIdは必須です' }), { status: 400, headers });
  }

  try {
    const kv = getKV(env);

    // 2026-07-26是正：Pickerでのファイル選択だけではrefresh_tokenに許可が反映されない
    // （実機で404を確認・原因特定済み）。handleVaultOAuthSetup()と同じcode交換を行い、
    // 今回選んだファイルへの許可を含む新しいrefresh_tokenへ更新する。
    if (code) {
      if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
        return new Response(JSON.stringify({ ok: false, error: 'GOOGLE_OAUTH_CLIENT_ID/SECRETが未設定です' }), { status: 500, headers });
      }
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirect_uri: 'postmessage',
          grant_type: 'authorization_code',
        }).toString(),
      });
      const tokenData = await tokenRes.json();
      console.log('[dashboard-setup] token交換レスポンス keys=', Object.keys(tokenData).join(','), ' has_refresh_token=', !!tokenData.refresh_token);
      if (!tokenData.refresh_token) {
        console.error('[dashboard-setup] refresh_token取得失敗の詳細:', JSON.stringify(tokenData));
        return new Response(JSON.stringify({ ok: false, error: 'refresh_token取得失敗: ' + (tokenData.error_description || tokenData.error || 'レスポンスにrefresh_tokenが含まれていません（既に許可済みのスコープへの再認可のため、Google側がrefresh_tokenを省略した可能性があります）') }), { status: 502, headers });
      }
      await kv.put('vault_oauth_refresh', tokenData.refresh_token);
      await kv.delete('vault_access_token_cache'); // 古いキャッシュ済みアクセストークンを無効化し、次回は新しいrefresh_tokenで取り直させる
      console.log('[dashboard-setup] refresh_token更新完了');
    }

    await kv.put('vault_dashboard_file_id', fileId);
    return new Response(JSON.stringify({ ok: true, fileId, refreshTokenUpdated: !!code }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// ダッシュボード自動反映：本文書き込み（2026-07-26・設計発注）。
// vault_dashboard_file_id（Pickerでファイル自体を選んでもらった結果）が未設定なら、
// 設定前の利用者に影響を与えないよう静かにスキップする。マーカー間だけを差し替える方式で、
// 「次の面接の準備」「判断待ち」等の既存セクションには一切触れない。
const DASHBOARD_BLOCK_START = '<!-- MITSUMERU_TODAY_START -->';
const DASHBOARD_BLOCK_END = '<!-- MITSUMERU_TODAY_END -->';
const DASHBOARD_INSERT_ANCHOR = '## 🗂 入口';

// ダンプボックス：種類を問わずファイルをVaultの00_inboxフォルダへアップロードする（2026-07-28・設計発注）。
// 「放り込むだけで完結する」がゴール。整理は別作業（対象外）。
const DUMPBOX_MAX_FILE_BYTES = 12 * 1024 * 1024; // 生ファイルの目安上限（12MB・柴山さんのスマホ写真事情を踏まえ5MBから引き上げ）

async function handleVaultInboxUpload(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers }); }

  const { fileName, mimeType, fileData, token } = body;
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  if (!fileName || !fileData) {
    return new Response(JSON.stringify({ ok: false, error: 'fileNameとfileDataは必須です' }), { status: 400, headers });
  }
  // base64はおよそ4/3に膨らむため、余裕を見て1.4倍で判定（既存の/inbox-dropと同じ考え方）
  if (fileData.length > DUMPBOX_MAX_FILE_BYTES * 1.4) {
    return new Response(JSON.stringify({ ok: false, error: 'ファイルサイズが大きすぎます（12MBまで）' }), { status: 400, headers });
  }

  try {
    const kv = getKV(env);
    const oauthFolderId = await kv.get('vault_oauth_folder');
    if (!oauthFolderId) {
      return new Response(JSON.stringify({ ok: false, error: 'Vaultの書き出し先フォルダが未設定です（設定タブでフォルダを選んでください）' }), { status: 400, headers });
    }

    const accessToken = await getVaultAccessToken(env);
    const inboxFolder = await findOrCreateFolder(accessToken, oauthFolderId, '00_inbox');

    // 衝突を構造的に回避するため、ファイル名の先頭にタイムスタンプを付与する
    // （同名ファイルでもDriveは別ファイルとして共存するため上書き判定は行わない＝ダンプボックスの性質上、都度別ファイルとして残すのが自然）
    const now = new Date();
    const jstMs = now.getTime() + 9 * 60 * 60 * 1000;
    const jst = new Date(jstMs);
    const stamp = `${jst.getUTCFullYear()}${String(jst.getUTCMonth() + 1).padStart(2, '0')}${String(jst.getUTCDate()).padStart(2, '0')}_${String(jst.getUTCHours()).padStart(2, '0')}${String(jst.getUTCMinutes()).padStart(2, '0')}${String(jst.getUTCSeconds()).padStart(2, '0')}`;
    const safeName = String(fileName).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = `${stamp}_${safeName}`;

    const binary = atob(fileData);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const result = await createVaultBinaryFile(accessToken, inboxFolder.id, finalName, mimeType, bytes);
    console.log('[inbox-upload] 作成成功 fileId=', result.id, ' name=', finalName);
    return new Response(JSON.stringify({ ok: true, fileId: result.id, fileName: finalName }), { status: 200, headers });
  } catch (e) {
    console.error('[inbox-upload] 例外:', e.message, e.stack);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

async function handleVaultDashboardWrite(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers }); }

  const { ichigon, top1, token } = body;
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }

  try {
    const kv = getKV(env);
    const fileId = await kv.get('vault_dashboard_file_id');
    console.log('[dashboard-write] fileId=', fileId);
    if (!fileId) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'ダッシュボードファイル未設定' }), { status: 200, headers });
    }

    const accessToken = await getVaultAccessToken(env);
    console.log('[dashboard-write] accessToken取得OK・長さ=', accessToken ? accessToken.length : 0);
    const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log('[dashboard-write] GET status=', getRes.status);
    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error('[dashboard-write] GET失敗:', errText);
      throw new Error('ダッシュボード読み込み失敗(' + getRes.status + '): ' + errText);
    }
    let content = await getRes.text();
    console.log('[dashboard-write] 読み込んだ本文の長さ=', content.length);

    const today = jstDateStr();
    const lines = [`## 🎯 今日の一手（ミツメルより・${today}更新）`];
    if (ichigon) lines.push(`- 明日への一言：${ichigon}`);
    if (top1) lines.push(`- 最優先：${top1}`);
    const block = `${DASHBOARD_BLOCK_START}\n${lines.join('\n')}\n${DASHBOARD_BLOCK_END}`;

    const markerRe = new RegExp(DASHBOARD_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + DASHBOARD_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (markerRe.test(content)) {
      content = content.replace(markerRe, block);
    } else if (content.includes(DASHBOARD_INSERT_ANCHOR)) {
      content = content.replace(DASHBOARD_INSERT_ANCHOR, `${block}\n\n${DASHBOARD_INSERT_ANCHOR}`);
    } else {
      content = content.trimEnd() + '\n\n' + block + '\n';
    }

    const writeResult = await overwriteVaultFile(accessToken, fileId, content);
    console.log('[dashboard-write] 書き込み成功 fileId=', writeResult.id);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  } catch (e) {
    console.error('[dashboard-write] 例外:', e.message, e.stack);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// ダッシュボード自動反映：本文読み込み（2026-07-28・設計発注）。
// 経緯：ダッシュボードへの「書き込み」だけを作り、朝・夜プロンプトがダッシュボードの
// 「🚨次の面接」「🧭今の物差し」を「読みに行く」配線が存在しなかった（データの鮮度の
// 問題ではなく配線漏れ）。全文を渡すとプロンプトが長くなりすぎるため、この2セクションだけを
// 見出し単位で切り出して返す。読み取り専用。ダッシュボードファイル未設定時は静かにnoneを返す。
async function handleVaultDashboardRead(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let token;
  try { token = (await request.json()).token; } catch (e) { token = null; }
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  try {
    const kv = getKV(env);
    const fileId = await kv.get('vault_dashboard_file_id');
    if (!fileId) {
      return new Response(JSON.stringify({ ok: true, none: true, reason: 'ダッシュボードファイル未設定' }), { status: 200, headers });
    }
    const accessToken = await getVaultAccessToken(env);
    const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!getRes.ok) {
      const errText = await getRes.text();
      throw new Error('ダッシュボード読み込み失敗(' + getRes.status + '): ' + errText);
    }
    const content = await getRes.text();

    // 見出し（## で始まる行）単位でセクションを切り出す。次の「## 」または文末までを本文とする。
    const extractSection = (headingSubstring) => {
      const lines = content.split('\n');
      const startIdx = lines.findIndex(l => l.startsWith('## ') && l.includes(headingSubstring));
      if (startIdx === -1) return null;
      const rest = lines.slice(startIdx + 1);
      const endIdx = rest.findIndex(l => l.startsWith('## '));
      const body = (endIdx === -1 ? rest : rest.slice(0, endIdx)).join('\n').trim();
      return { heading: lines[startIdx].replace(/^##\s*/, ''), body };
    };

    const interviews = extractSection('次の面接');
    const yardstick = extractSection('今の物差し');

    return new Response(JSON.stringify({
      ok: true, none: false,
      interviews: interviews ? interviews.body : null,
      yardstick: yardstick ? yardstick.body : null,
    }), { status: 200, headers });
  } catch (e) {
    // 設計書の方針（学習ログ・前回記録と同じ）：読み込み失敗時もプロンプト生成自体は
    // 止めない。ok:trueのままnoneで返し、呼び出し元は「取得できなかった」として無視できるようにする。
    return new Response(JSON.stringify({ ok: true, none: true, error: e.message }), { status: 200, headers });
  }
}

// 朝刊反応：本部が毎朝生成する朝刊（H:...\01_今日のデスク\朝刊_医療福祉_YYYYMMDD.md）の
// 見出し一覧を読み取る（2026-07-30・柴山さん直命・生成⇔検証ループ）。読み取り専用。
// 朝刊ファイル自体は他Code（本部）が管理するため、Worker側からは一切書き込まない。
async function handleVaultAsakanRead(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let token;
  try { token = (await request.json()).token; } catch (e) { token = null; }
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  try {
    const kv = getKV(env);
    const oauthFolderId = await kv.get('vault_oauth_folder');
    if (!oauthFolderId) {
      return new Response(JSON.stringify({ ok: true, none: true, reason: 'Vault連携が未設定です' }), { status: 200, headers });
    }
    const accessToken = await getVaultAccessToken(env);
    const deskFolderId = await getCachedDailyFolderId(env, accessToken, oauthFolderId, '01_今日のデスク');
    // FUS-395是正（2026-09-04・設計）：朝刊の実際の生成先は`01_今日のデスク\朝刊\`サブフォルダ
    // （morning-news-fukushi SKILL.md参照）だが、本関数はトップ直下しか検索しておらず、
    // 常に「本日の朝刊はまだ生成されていません」を返す長期バグになっていた。サブフォルダを検索対象にする。
    const asakanFolderId = await getCachedDailyFolderId(env, accessToken, deskFolderId, '朝刊');
    const today = jstDateStr().replace(/-/g, '');
    const filename = `朝刊_医療福祉_${today}.md`;
    const found = await findVaultFile(accessToken, asakanFolderId, filename);
    if (!found) {
      // 前提が崩れた時（06:06前・生成失敗）は無理に埋めず、正直に「まだ無い」と返す
      return new Response(JSON.stringify({ ok: true, none: true, reason: '本日の朝刊はまだ生成されていません' }), { status: 200, headers });
    }
    const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${found.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!contentRes.ok) throw new Error('朝刊読み込み失敗(' + contentRes.status + ')');
    const content = await contentRes.text();

    // 見出し抽出パターン（2026-08-01是正・柴山さん実害報告）：本部が2026-07-31 17:18に
    // 朝刊を「2本柱化」した際、フォーマットが「### N. 見出し」という番号付きから
    // 「### [記事タイトル](url)〔タグ〕（出典）」というリンク形式へ変わっていたため、
    // 旧パターンが1件もマッチせず見出し0件になっていた（`### N.`ではなく`### [`で始まる）。
    // 番号は本文中に無くなったため、出現順に連番を振る。
    // 2026-08-01再設計（柴山さん・設計壁打ち）：タップ式反応を廃止し「見出し＋要約を読んで
    // コメントを書く」形に変更したため、見出し行の直後（次の見出し・区切り線・見出しレベル
    // 変化の直前まで）にある要約段落もあわせて抽出する。
    // 2026-08-22是正（柴山さん実害報告・2回目の同種事故）：朝刊フォーマットが再度変化し、
    // 「### [タイトル](url)」から「**N. [タイトル](url)**」（太字箇条書き・##は区分見出しのみに使用）
    // へドリフトしていたため、再び見出し0件になっていた。SKILL.md側がMarkdown構文レベルを
    // 明示的に固定していないことが根本原因（別途SKILL.md是正を依頼済み）。ここでは同種の再発に
    // 備え、正規表現を単一パターンへの依存から複数パターン許容へ変更し、多少の表記ゆれでは
    // 壊れない設計にする。
    const HEADING_PATTERNS = [
      /^#{2,4}\s*\[([^\]]+)\]/,       // ### [タイトル] / ## [タイトル]（##は通常区分見出しのため[が無く該当しない想定）
      /^\*\*\d+\.\s*\[([^\]]+)\]/,    // **1. [タイトル]**（2026-08-22〜の太字箇条書き形式）
    ];
    const lines = content.split('\n');
    const headings = [];
    let idx = 0;
    for (let i = 0; i < lines.length; i++) {
      let headingMatch = null;
      for (const pattern of HEADING_PATTERNS) {
        headingMatch = lines[i].match(pattern);
        if (headingMatch) break;
      }
      if (!headingMatch) continue;
      idx += 1;
      const summaryLines = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j];
        if (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line)) break;
        if (HEADING_PATTERNS.some(p => p.test(line))) break; // 次の項目に到達したら打ち切る
        if (line.trim()) summaryLines.push(line.trim());
      }
      headings.push({ index: idx, heading: headingMatch[1].trim(), summary: summaryLines.join(' ') });
    }
    if (!headings.length) {
      // 配線完全性チェック（設計指摘・2026-08-01）：ファイルは見つかったのに見出しが0件の場合、
      // 「ファイルが無い」場合と同じ文言（none:true）を返すと、今回のような本部側フォーマット
      // 変更による抽出漏れが「まだ生成されていない」と誤認され、原因特定が遅れる。
      // ファイルは存在した事実を区別できるよう、専用の理由文言を返す。
      return new Response(JSON.stringify({ ok: true, none: true, reason: '見出しの抽出に失敗しました（本部側のフォーマット変更の可能性）' }), { status: 200, headers });
    }
    return new Response(JSON.stringify({ ok: true, none: false, date: jstDateStr(), headings }), { status: 200, headers });
  } catch (e) {
    console.error('[asakan-read] 例外発生:', e.message, e.stack);
    // 学習ログ・前回記録と同じ方針：読み込み失敗時もok:trueのままnoneで返し、呼び出し元は無視できるようにする
    return new Response(JSON.stringify({ ok: true, none: true, error: e.message }), { status: 200, headers });
  }
}

// ── G3-カレンダー：カレンダー書き込みアダプタ ──
// 同じ日に複数回実行されても重複作成しないよう、拡張プロパティ(mitsumeru_date)で既存イベントを検索し、
// あれば更新（PATCH）、なければ新規作成（POST）する。
function buildCalendarEventContent(date, record) {
  const morning = record.morning || {};
  const evening = record.evening || {};
  const want = morning['m-want'] || '';
  const hp = morning['hp-val'] || '—';
  const mp = morning['mp-val'] || '—';
  const supplement = evening['e-supplement'] || '';

  const summary = `ミツメル：${date}の記録（HP${hp}／MP${mp}）`;
  const descriptionLines = [];
  if (want) descriptionLines.push(`今日の一言：${want}`);
  descriptionLines.push(`HP：${hp}　MP：${mp}`);
  if (supplement) descriptionLines.push(`補足：${supplement}`);
  return { summary, description: descriptionLines.join('\n') };
}

async function writeCalendarEvent(env, accessToken, date, record) {
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
  const apiBase = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`;
  const { summary, description } = buildCalendarEventContent(date, record);

  const searchUrl = `${apiBase}?privateExtendedProperty=${encodeURIComponent('mitsumeru_date=' + date)}`;
  const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const searchData = await searchRes.json();
  if (!searchRes.ok) {
    throw new Error('カレンダー検索失敗: ' + JSON.stringify(searchData));
  }
  const existing = (searchData.items || [])[0];

  const eventBody = {
    summary,
    description,
    start: { date },
    end: { date },
    extendedProperties: { private: { mitsumeru_date: date } },
  };

  const url = existing ? `${apiBase}/${existing.id}` : apiBase;
  const method = existing ? 'PATCH' : 'POST';
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(eventBody),
  });
  const data = await res.json();
  if (!res.ok || !data.id) {
    throw new Error('カレンダー書き込み失敗: ' + JSON.stringify(data));
  }
  return data;
}

// 【一時】ダッシュボード自動反映（2026-07-26・設計発注）のOAuth許可範囲確認用。
// 読み取り専用（Drive files.list・検索のみ）。確認完了後、この関数と上のルーティングは撤去する。
async function handleDebugDashboardLookup(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let token;
  try { token = (await request.json()).token; } catch (e) { token = null; }
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  try {
    const kv = getKV(env);
    const oauthFolderId = await kv.get('vault_oauth_folder');
    if (!oauthFolderId) {
      return new Response(JSON.stringify({ ok: true, oauthSetup: false, reason: 'OAuth2未セットアップ' }), { status: 200, headers });
    }
    const accessToken = await getVaultAccessToken(env);
    // フォルダ範囲を限定せず名前だけで検索。drive.fileスコープでアクセス可能なファイルのみ返る。
    const query = encodeURIComponent(`name='00_代表ダッシュボード.md' and trashed=false`);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,parents)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Drive検索失敗: ' + JSON.stringify(data));

    // 追加診断（2026-07-26・404原因調査）：このリフレッシュトークン経由のアクセストークンが
    // 実際に何を見えているか（全件・件数のみ）を確認する。読み取り専用。
    const allRes = await fetch(`https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const allData = await allRes.json();

    // このアクセストークンがどのGoogleアカウントのものかも確認（アカウント取り違えの切り分け用）
    let tokenOwnerEmail = null;
    try {
      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
      const infoData = await infoRes.json();
      tokenOwnerEmail = infoData.email || infoData.error || null;
    } catch (e) { tokenOwnerEmail = 'tokeninfo取得失敗: ' + e.message; }

    // 保存済みの目的のfileIdへ、直接GETできるかも合わせて確認
    const dashboardFileId = await kv.get('vault_dashboard_file_id');
    let directGetStatus = null;
    if (dashboardFileId) {
      const directRes = await fetch(`https://www.googleapis.com/drive/v3/files/${dashboardFileId}?fields=id,name,parents`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      directGetStatus = { status: directRes.status, body: await directRes.json() };
    }

    return new Response(JSON.stringify({
      ok: true, oauthSetup: true, grantedRootFolderId: oauthFolderId,
      found: (data.files || []).length > 0, files: data.files || [],
      tokenOwnerEmail,
      visibleFileCount: (allData.files || []).length,
      visibleFileSample: (allData.files || []).slice(0, 20),
      dashboardFileId, directGetStatus,
    }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// ═══════════════════════════════════════════════
//  G連携基盤：ミツメルの記録をVault（Google Drive）へ自動書き出し（Phase2・柴山さんご本人専用）
//  設計：06_イノベーション/_検討書/ミツメル_Vault自動書き出し_実現可能性検討_20260711.md
//  G1（認証）・G2（KV読み取り）はカレンダー連携と共通。G3-Vaultのみ新規（変換先：Markdown／書き込み先：Google Drive）
// ═══════════════════════════════════════════════

async function handleSyncVault(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  let date, token;
  try {
    const body = await request.json();
    date = body.date || jstDateStr();
    token = body.token;
  } catch (e) {
    date = jstDateStr();
  }

  // 2026-07-24是正（実装安全原則v1原則③）：private_プレフィックスのKVデータ
  // （private_morning_/private_evening_/private_memos_）を読み取ってDriveへ書き出す処理なのに
  // トークン確認が抜けていた。他のprivate_系エンドポイント（/sync-vault-note等）と同じ基準にする。
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }

  // 案B（2026-07-25・設計指示）：柴山さんご本人のOAuth2 refresh_tokenを優先する
  // （サービスアカウントは個人Driveに書き込み容量を持たないため・実測確認済み）。
  // OAuth2初回セットアップが済んでいなければ、旧サービスアカウント方式へフォールバックする
  // （設計書§5：GOOGLE_VAULT_FOLDER_IDは当面残す）。
  const kv = getKV(env);
  const oauthFolderId = await kv.get('vault_oauth_folder');
  const useOAuth = !!oauthFolderId;

  if (!useOAuth && (!env.GOOGLE_SERVICE_ACCOUNT_KEY || !env.GOOGLE_VAULT_FOLDER_ID)) {
    return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'Vault書き出しが未設定です（OAuth2未セットアップ・Secret未登録）' }), { status: 200, headers });
  }

  try {
    const record = await getPrivateDailyRecord(env, date);          // G2（カレンダー連携と共通）
    const accessToken = useOAuth
      ? await getVaultAccessToken(env)                                                  // G1-Vault（柴山さんOAuth2）
      : await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/drive.file');   // 旧方式フォールバック
    const folderId = useOAuth ? oauthFolderId : env.GOOGLE_VAULT_FOLDER_ID;
    const file = await writeVaultMarkdown(env, accessToken, date, record, folderId); // G3-Vault
    return new Response(JSON.stringify({ ok: true, date, fileId: file.id, method: useOAuth ? 'oauth2' : 'service_account' }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// ═══════════════════════════════════════════════
//  読書メモ（2026-07-21・柴山さん指示・設計優先度①）：読書中の口述記録をVaultへ蓄積する。
//  Kindleの内容を複製するのではなく、柴山さんご自身の気づき・要点を音声で話したものを、
//  本のタイトルごとにMarkdownとして追記していく（既存の口述記録の仕組みの拡張）。
// ═══════════════════════════════════════════════

// ファイル名に使えない文字を除去する（Google Driveのファイル名制約対応）
function sanitizeFilename(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 100) || '無題';
}

// 2026-07-21実測：Google Driveへの書き込みはサービスアカウントの既知の制約
// （storageQuotaExceeded・個人Driveへ新規ファイル作成不可）で失敗するため、
// 既存の/sync-vault（日次記録）と同じ問題を踏襲しないよう、KV保存方式にした。
// Drive直接書き込みへの移行は、OAuth2/Picker方式（別途進行中）の完成後に検討する。
async function handleSyncVaultNote(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  let bookTitle, noteText, token;
  try {
    const body = await request.json();
    bookTitle = body.bookTitle;
    noteText = body.noteText;
    token = body.token;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers });
  }
  // private_ プレフィックスキーを使うため、安全装置④（2026-07-19）と同じ基準でトークン必須にする
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  if (!bookTitle || !noteText) {
    return new Response(JSON.stringify({ ok: false, error: 'bookTitleとnoteTextは必須です' }), { status: 400, headers });
  }

  try {
    const kv = getKV(env);
    const key = 'private_dokusho_memo_' + sanitizeFilename(bookTitle);
    const timestamp = new Date().toISOString();
    const entry = { text: noteText, ts: timestamp };

    const existingRaw = await kv.get(key);
    const record = existingRaw ? JSON.parse(existingRaw) : { bookTitle, entries: [] };
    record.entries.push(entry);
    await kv.put(key, JSON.stringify(record));

    return new Response(JSON.stringify({ ok: true, bookTitle, mode: existingRaw ? 'append' : 'created', count: record.entries.length }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// 読書メモ一覧・全文取得（?title=で1冊分、省略で全冊のタイトル一覧のみ）
async function handleGetVaultNote(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  const url = new URL(request.url);
  const title = url.searchParams.get('title');
  const kv = getKV(env);

  if (title) {
    const raw = await kv.get('private_dokusho_memo_' + sanitizeFilename(title));
    if (!raw) return new Response(JSON.stringify({ ok: true, found: false }), { status: 200, headers });
    return new Response(JSON.stringify({ ok: true, found: true, record: JSON.parse(raw) }), { status: 200, headers });
  }

  const list = await kv.list({ prefix: 'private_dokusho_memo_' });
  return new Response(JSON.stringify({ ok: true, keys: list.keys.map(k => k.name) }), { status: 200, headers });
}

// ═══════════════════════════════════════════════
//  入力箱（ミツメルv9・2026-07-24・設計発注）：マルチデバイスからの投入を1本の窓口で受ける。
//  2026-07-24時点：Google Drive直接アップロード（OAuth2/drive.file方式）は認証情報は
//  取得済みだがトークン交換エンドポイント未実装のため、暫定でKV保存にする
//  （読書メモ機能と同じ判断・理由）。OAuth2実装完了後、Drive書き込みへ移行予定。
// ═══════════════════════════════════════════════
const INBOX_MAX_FILE_BYTES = 5 * 1024 * 1024; // base64換算前のおおよその上限（5MB）

async function handleInboxDrop(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers }); }

  const { token, text, fileName, fileType, fileData } = body;

  // private_ プレフィックスキーを使うため、安全装置④（2026-07-19）と同じ基準でトークン必須にする
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }
  if (!text && !fileData) {
    return new Response(JSON.stringify({ ok: false, error: 'textかfileDataのいずれかが必要です' }), { status: 400, headers });
  }
  if (fileData && fileData.length > INBOX_MAX_FILE_BYTES * 1.4) {
    // base64はおよそ4/3に膨らむため、余裕を見て1.4倍で判定
    return new Response(JSON.stringify({ ok: false, error: 'ファイルサイズが大きすぎます（5MBまで）' }), { status: 400, headers });
  }

  let key;
  try {
    const kv = getKV(env);
    const now = Date.now();
    key = 'private_inbox_' + now + '_' + Math.random().toString(36).slice(2, 8);
    const record = {
      text: text || '',
      fileName: fileName || null,
      fileType: fileType || null,
      fileData: fileData || null, // base64。Drive移行後はここにfileIdのみ持つ設計に変える想定
      ts: new Date(now).toISOString(),
    };
    await kv.put(key, JSON.stringify(record));
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }

  // ミツメル3役構想（2026-07-25・設計発注）：KV保存に加え、外出時記録をVaultへも反映する。
  // KVは既に成功しているため、Vault書き込みが失敗してもリクエスト全体は失敗にしない
  // （柴山さんの投入操作自体は必ず成功させる。Vault反映は「できれば」の位置づけ）。
  // 案B（2026-07-25）：OAuth2セットアップ済みならそちらを優先、未セットアップなら旧方式へフォールバック。
  let vaultResult = { attempted: false };
  const kvForVault = getKV(env);
  const oauthFolderIdForInbox = await kvForVault.get('vault_oauth_folder');
  const canUseOAuthForInbox = !!oauthFolderIdForInbox;
  const canUseServiceAccountForInbox = !!(env.GOOGLE_SERVICE_ACCOUNT_KEY && env.GOOGLE_VAULT_FOLDER_ID);
  if (text && (canUseOAuthForInbox || canUseServiceAccountForInbox)) {
    vaultResult.attempted = true;
    try {
      const accessToken = canUseOAuthForInbox
        ? await getVaultAccessToken(env)
        : await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/drive.file');
      const rootId = canUseOAuthForInbox ? oauthFolderIdForInbox : env.GOOGLE_VAULT_FOLDER_ID;
      const date = jstDateStr();
      await appendVaultRaw(accessToken, rootId, date, text);
      vaultResult.ok = true;
      vaultResult.method = canUseOAuthForInbox ? 'oauth2' : 'service_account';
    } catch (e) {
      vaultResult.ok = false;
      vaultResult.error = e.message;
    }
  }

  return new Response(JSON.stringify({ ok: true, key, vault: vaultResult }), { status: 200, headers });
}

// 専用受信フォルダへの追記専用書き込み（ミツメル3役構想・2026-07-25・設計指示）。
// 既存の共有ファイル（date.md・ダッシュボード等）には一切触れず、
// 06_ミツメル記録/_受信/<date>_raw.md へ追記するだけの構造にすることで、
// 同時書き込み競合を構造的に回避する（指示キューの追記パターンと同じ思想）。
async function appendVaultRaw(accessToken, rootId, date, text) {
  const recordFolder = await findOrCreateFolder(accessToken, rootId, '06_ミツメル記録');
  const inboxFolder = await findOrCreateFolder(accessToken, recordFolder.id, '_受信');
  const filename = `${date}_raw.md`;

  const timestamp = new Date().toISOString();
  const entry = `\n\n---\n\n**${timestamp}**\n\n${text}\n`;

  const existing = await findVaultFile(accessToken, inboxFolder.id, filename);
  if (existing) {
    const getRes = await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const prevContent = getRes.ok ? await getRes.text() : '';
    return overwriteVaultFile(accessToken, existing.id, prevContent + entry);
  }

  // frontmatterは最小構成で固定（設計指示）
  const frontmatter = `---\ndate: ${date}\nsource: mitsumeru\ntype: raw\n---`;
  return createVaultFile(accessToken, inboxFolder.id, filename, frontmatter + entry);
}

// 日次記録をMarkdownに変換する（プロファイルキーには一切触れない。G2の戻り値のみを使用）
// YAMLの値として安全な形にする（コロン・引用符等を含む場合はダブルクォートで囲む）
// QA指摘（2026-07-24・ラット実測）：旧実装は`"`のみエスケープし、改行・バックスラッシュを
// 放置していたため、それらを含む値でYAMLパース不能になっていた（deficient indentation／
// unknown escape sequence）。JSON.stringify()はYAML1.2の厳密なサブセットである
// JSON文字列リテラルを生成するため、js-yaml等のYAML1.2パーサで確実に読める。
function yamlSafe(v) {
  if (v === null || v === undefined || v === '') return 'null';
  const s = String(v);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s; // 数値はそのまま
  return JSON.stringify(s);
}

function buildVaultMarkdown(date, record) {
  const morning = record.morning || {};
  const evening = record.evening || {};
  const want = morning['m-want'] || '（記載なし）';
  // 2026-08-04是正（開発B・柴山さん実害報告）：夜の締め(closeDayHPMP)の値が保存されるようになった
  // （mitsumeru_private.html側の対応と対）ため、evening側にhp-close-val/mp-close-valがあれば
  // そちらを優先する。無ければ従来通り朝の値にフォールバックする（後方互換）。
  const hp = (evening['hp-close-val'] !== undefined && evening['hp-close-val'] !== null && evening['hp-close-val'] !== '')
    ? evening['hp-close-val'] : (morning['hp-val'] || '');
  const mp = (evening['mp-close-val'] !== undefined && evening['mp-close-val'] !== null && evening['mp-close-val'] !== '')
    ? evening['mp-close-val'] : (morning['mp-val'] || '');
  const lvBase = morning['lv-base'] !== undefined ? morning['lv-base'] : '';
  const supplement = evening['e-supplement'] || '（記載なし）';
  // 2026-07-25設計指示（B案）：夜タブの生テキストも書き出す（AI生成ナラティブ自体は
  // 現状KV未保存のため対象外・A案として別途検討中） → 2026-08-05・FP-0018で設計２が実装。
  // 朝の「参謀からの一言」はmorning['morning-advice']（saveMorning()が既に保存していた）、
  // 夜の「翌日戦略」全文はrecord.output.text（generateEvening()が既にcloudSave('output',...)で
  // 保存していた）を、それぞれ読んで書き出す。どちらも新規保存経路は作らず、既存KVを読むだけ。
  const morningAdvice = morning['morning-advice'] || null;
  const tomorrowPlanFull = (record.output && record.output.text) ? record.output.text : null;
  const tomorrow = evening['e-tomorrow'] || '（記載なし）';
  const delay = evening['e-delay'] || '（記載なし）';
  const try100 = evening['e-try100'] || '（記載なし）';
  const feedback = evening['e-feedback'] || '（記載なし）';
  const notebooklm = evening['e-notebooklm'] || '（記載なし）';

  // 2026-07-26設計指示：随時メモ（日中の記録）もVaultへ反映する
  const memoTagLabel = { HP: '体調', P: '実績', V: 'ノイズ', G: '思考' };
  const memoList = (record.memos && Array.isArray(record.memos.data)) ? record.memos.data : [];
  const memosText = memoList.length
    ? memoList.map(m => {
        const label = memoTagLabel[m.tag] || m.tag || '';
        const time = m.time ? `${m.time.slice(0,2)}:${m.time.slice(2,4)}` : '';
        const pomo = m.pomos ? `（P${m.pomos}）` : '';
        return `- [${time}] #${label}${pomo} ${m.content || ''}`;
      }).join('\n')
    : '（記載なし）';

  // frontmatter（ミツメルv9・2026-07-24・Dataview対応。設計書§1-3準拠）：
  // hp/mp/lvを数値のままYAMLへ入れることで、Obsidian側で「今月のHP推移」等を
  // Dataviewクエリで即座に集計できるようにする。値が無い項目はnullにし、集計側で除外可能にする。
  const frontmatter = `---
date: ${date}
hp: ${yamlSafe(hp)}
mp: ${yamlSafe(mp)}
lv: ${yamlSafe(lvBase)}
type: mitsumeru-daily
---`;

  // FUS-20是正（2026-09-05・柴山さん実機フィードバック）：AI生成ナラティブ（翌日戦略・
  // 参謀からの一言）は反映自体はできていたが、セクション順が下の方すぎてスクロールしないと
  // 見えなかった。ステータス直後、他の生入力項目より先に表示する順序へ変更する。
  return `${frontmatter}

# ミツメル日次記録 ${date}

- 作成者：mitsumeru-sync Worker（自動書き出し）／作成日時：${date}
- ステータス：日次ログ（自動生成・上書きなし）

## ステータス
HP：${hp || '—'}／MP：${mp || '—'}

## 翌日戦略（AI生成・全文）
${tomorrowPlanFull || '（記載なし）'}

## 参謀からの一言（AI生成）
${morningAdvice || '（記載なし）'}

## 今日の一言
${want}

## 随時メモ
${memosText}

## 補足
${supplement}

## 明日の設計
${tomorrow}

## 先送りタスク
${delay}

## Try100
${try100}

## SuccessOSへのフィードバック
${feedback}

## NotebookLMのまとめコメント
${notebooklm}
`;
}

// フォルダを名前+親IDで検索する。無ければ新規作成を試みる。
// 注意（ミツメル3役構想・2026-07-25）：サービスアカウントは個人Drive（非共有ドライブ）に
// 新規アイテムを作成できない（storageQuotaExceeded）。GOOGLE_VAULT_FOLDER_IDの実体が
// 共有ドライブでない限り、ここでの新規作成は失敗する。失敗時はエラーメッセージに
// 「柴山さんご本人が該当フォルダをDrive UIで一度だけ手動作成する」対処法を含める。
async function findOrCreateFolder(accessToken, parentId, folderName) {
  const query = encodeURIComponent(
    `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const searchData = await searchRes.json();
  if (!searchRes.ok) throw new Error('フォルダ検索失敗: ' + JSON.stringify(searchData));
  const matches = searchData.files || [];
  if (matches.length) {
    // 2026-07-31発見（朝刊反応の実データ確認中）：drive.fileスコープ時代に本物フォルダが
    // 見えなかったことが原因で、同名の空フォルダを誤って新規作成していた実例が見つかった
    // （01_今日のデスク）。同名が複数見つかった場合は、作成日時が最も古いものを「本物」として
    // 優先する（後から誤って作られた重複は必ず新しいはずという前提）。1件のみなら従来通り。
    if (matches.length > 1) {
      matches.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
      console.warn(`[findOrCreateFolder] 「${folderName}」が${matches.length}件重複しています。最古のもの(id=${matches[0].id}, createdTime=${matches[0].createdTime})を使用します。`);
    }
    return matches[0];
  }

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const createData = await createRes.json();
  if (!createRes.ok || !createData.id) {
    const isQuota = JSON.stringify(createData).includes('storageQuotaExceeded');
    const hint = isQuota
      ? `（サービスアカウントは個人Driveに新規フォルダを作成できません。柴山さんご本人がDrive上で「${folderName}」フォルダを一度だけ手動作成してください）`
      : '';
    throw new Error(`フォルダ作成失敗: ${JSON.stringify(createData)}${hint}`);
  }
  return createData;
}

// API呼び出し削減②（2026-07-26・設計発注）：「ミツメル日次記録」フォルダは一度作られたら
// 基本的に変わらないのに、/sync-vault・/vault-morning-context・/vault-learning-logの
// 3ハンドラがそれぞれ個別にfindOrCreateFolder()を呼び、calcMorning()1回の押下で
// 同じフォルダ検索が最大3回重複していた。KVに6時間TTLでフォルダIDをキャッシュする
// （フォルダが手動で作り直された場合は最大6時間で自然に検出・再解決される）。
// 既知の限界：キャッシュ有効期間中にフォルダが削除・作り直された場合は追従できない
// （手動でのフォルダ再作成は稀な運用操作のため許容し、複雑な404検知・再試行は入れていない）。
async function getCachedDailyFolderId(env, accessToken, parentId, folderName) {
  const kv = getKV(env);
  const cacheKey = 'vault_folder_id_cache_' + parentId + '_' + folderName;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;
  const folder = await findOrCreateFolder(accessToken, parentId, folderName);
  await kv.put(cacheKey, folder.id, { expirationTtl: 21600 });
  return folder.id;
}

// Google Drive API v3。指定フォルダ内から同名ファイルを検索する（読書メモの追記判定と共用）。
async function findVaultFile(accessToken, folderId, filename) {
  const query = encodeURIComponent(`name='${filename}' and '${folderId}' in parents and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const searchData = await searchRes.json();
  if (!searchRes.ok) throw new Error('Vault検索失敗: ' + JSON.stringify(searchData));
  return (searchData.files || [])[0] || null;
}

// 指定フォルダに新規ファイルを作成する（multipart POST）。
async function createVaultFile(accessToken, folderId, filename, content) {
  const boundary = 'mitsumeru_vault_boundary';
  const metadata = { name: filename, parents: [folderId], mimeType: 'text/markdown' };
  const multipartBody =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody,
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error('Vault新規作成失敗: ' + JSON.stringify(data));
  return data;
}

// ダンプボックス用：任意のmimeType・バイナリ内容で新規ファイルを作成する（multipart POST）。
// createVaultFile()はテキスト（mimeType固定・文字列content前提）専用のため、
// 画像・PDF・音声等のバイナリを扱うために汎用化した別関数として新設（2026-07-28）。
async function createVaultBinaryFile(accessToken, folderId, filename, mimeType, bytes) {
  const boundary = 'mitsumeru_vault_boundary_bin';
  const metadata = { name: filename, parents: [folderId], mimeType: mimeType || 'application/octet-stream' };
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error('Vaultバイナリ新規作成失敗: ' + JSON.stringify(data));
  return data;
}

// 既存ファイルの内容を丸ごと置き換える（PATCH）。
async function overwriteVaultFile(accessToken, fileId, content) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/markdown' },
    body: content,
  });
  const data = await res.json();
  if (!res.ok || !data.id) throw new Error('Vault更新失敗: ' + JSON.stringify(data));
  return data;
}

// Google Drive API v3。指定フォルダ内に同名ファイルがあれば内容を更新（PATCH）、
// なければ新規作成（multipart POST）。同日再実行しても重複作成しない。
async function writeVaultMarkdown(env, accessToken, date, record, folderId) {
  // 2026-07-25設計指示：Vault直下に散らからないよう専用サブフォルダへ集約する（Picker再選択不要）
  const dailyFolderId = await getCachedDailyFolderId(env, accessToken, folderId, 'ミツメル日次記録');
  const filename = `${date}.md`;
  let content = buildVaultMarkdown(date, record);
  const existing = await findVaultFile(accessToken, dailyFolderId, filename);
  if (existing) {
    // FUS-295（2026-08-21発見）恒久修正：buildVaultMarkdown()は固定セクションのみを再生成するため、
    // note-publish-watch（別タスク）が同日中に追記した「## note公開」節は、この上書きで
    // 消えてしまっていた（8/16・8/21で実際にデータ消失が発生）。上書き前に既存ファイルの
    // note公開節を読み取り、あれば新しい内容へ引き継ぐ。
    try {
      const existingRes = await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?alt=media`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const existingContent = await existingRes.text();
      const notePublish = parseVaultMarkdown(existingContent).notePublish;
      if (notePublish) {
        content = content.trimEnd() + `\n\n## note公開\n${notePublish}\n`;
      }
    } catch (e) {
      // 既存内容の読み取りに失敗しても朝夜の保存自体は止めない（note公開節の引き継ぎのみ諦める）
    }
    return overwriteVaultFile(accessToken, existing.id, content);
  }
  return createVaultFile(accessToken, dailyFolderId, filename, content);
}

// buildVaultMarkdownが出力するMarkdown本文から、frontmatter数値とセクション本文を読み戻す
// （朝プロンプトVault連携・2026-07-26設計指示）。書き出し側のフォーマットに依存するので
// buildVaultMarkdown側のセクション名を変えたらここも合わせて直すこと。
function parseVaultMarkdown(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (fmMatch) {
    fmMatch[1].split('\n').forEach(line => {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) fm[m[1]] = m[2].replace(/^"|"$/g, '');
    });
  }
  const section = (name) => {
    const re = new RegExp(`## ${name}\\n([\\s\\S]*?)(\\n## |$)`);
    const m = content.match(re);
    return m ? m[1].trim() : '';
  };
  return {
    hp: fm.hp !== undefined && fm.hp !== 'null' ? fm.hp : null,
    mp: fm.mp !== undefined && fm.mp !== 'null' ? fm.mp : null,
    want: section('今日の一言'),
    supplement: section('補足'),
    tomorrow: section('明日の設計'),
    delay: section('先送りタスク'),
    notePublish: section('note公開'),
  };
}

// 朝プロンプトVault連携：「ミツメル日次記録」フォルダ内から最新（今日以外）のファイルを探し、
// HP/MP・前回の記録内容・前回との間隔（日数）を返す。ファイルが1件もない/前回記録がなければnoneを返す。
async function handleVaultMorningContext(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let token, today;
  try {
    const body = await request.json();
    token = body.token;
    today = body.date || jstDateStr();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers });
  }
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }

  const kv = getKV(env);
  const oauthFolderId = await kv.get('vault_oauth_folder');
  if (!oauthFolderId) {
    return new Response(JSON.stringify({ ok: true, none: true, reason: 'Vault連携が未セットアップです' }), { status: 200, headers });
  }

  try {
    const accessToken = await getVaultAccessToken(env);
    const dailyFolderId = await getCachedDailyFolderId(env, accessToken, oauthFolderId, 'ミツメル日次記録');
    const query = encodeURIComponent(`'${dailyFolderId}' in parents and trashed=false and mimeType='text/markdown'`);
    const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=name desc&pageSize=5&fields=files(id,name)`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const listData = await listRes.json();
    if (!listRes.ok) throw new Error('一覧取得失敗: ' + JSON.stringify(listData));

    const todayFilename = `${today}.md`;
    const prev = (listData.files || []).find(f => f.name !== todayFilename && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name));
    if (!prev) {
      return new Response(JSON.stringify({ ok: true, none: true, reason: '前回の記録がまだありません' }), { status: 200, headers });
    }

    const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${prev.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const content = await contentRes.text();
    const parsed = parseVaultMarkdown(content);
    const prevDate = prev.name.replace('.md', '');
    const daysSince = Math.round((new Date(today) - new Date(prevDate)) / 86400000);

    // 夜の評価の配線漏れ是正（2026-08-13・設計発注・FUS-208）：note-publish-watchが
    // 当日のミツメル日次記録へ「## note公開」節を追記する運用に対応するため、
    // 前日ファイルとは別に「今日自身のファイル」も探し、あれば note公開 節だけ読む。
    // 前日ファイル探索と同じリストAPI呼び出し結果（listData）を再利用し、追加のAPI呼び出しは
    // todayファイルが実在する場合の本文取得1回のみに抑える。
    let todayNotePublish = '';
    const todayFile = (listData.files || []).find(f => f.name === todayFilename);
    if (todayFile) {
      try {
        const todayContentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${todayFile.id}?alt=media`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const todayContent = await todayContentRes.text();
        todayNotePublish = parseVaultMarkdown(todayContent).notePublish;
      } catch (e) { todayNotePublish = ''; }
    }

    return new Response(JSON.stringify({
      ok: true, none: false,
      prevDate, daysSince,
      hp: parsed.hp, mp: parsed.mp,
      want: parsed.want, supplement: parsed.supplement,
      tomorrow: parsed.tomorrow, delay: parsed.delay,
      todayNotePublish,
    }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// 「育つ仕組み」（2026-07-26設計指示）：サルベージが週次で更新する学習ログを読み込む。
// ファイルがまだ無い・空の場合はエラーにせずnone:trueで静かにスキップする（設計書の指示通り）。
async function handleVaultLearningLog(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };
  let token;
  try {
    const body = await request.json();
    token = body.token;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'リクエストの形式が不正です' }), { status: 400, headers });
  }
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: 'private data requires a valid token' }), { status: 401, headers });
  }

  const kv = getKV(env);
  const oauthFolderId = await kv.get('vault_oauth_folder');
  if (!oauthFolderId) {
    return new Response(JSON.stringify({ ok: true, none: true }), { status: 200, headers });
  }

  try {
    const accessToken = await getVaultAccessToken(env);
    const dailyFolderId = await getCachedDailyFolderId(env, accessToken, oauthFolderId, 'ミツメル日次記録');
    const filename = '_柴山さんプロファイル_学習ログ.md';
    const found = await findVaultFile(accessToken, dailyFolderId, filename);
    if (!found) {
      return new Response(JSON.stringify({ ok: true, none: true }), { status: 200, headers });
    }
    const contentRes = await fetch(`https://www.googleapis.com/drive/v3/files/${found.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const content = (await contentRes.text()).trim();
    if (!content) {
      return new Response(JSON.stringify({ ok: true, none: true }), { status: 200, headers });
    }
    // 直近5件程度に絞る（サルベージ側の書式に依存しすぎないよう、末尾の一定量だけを渡す）
    const lines = content.split('\n').filter(l => l.trim());
    const recent = lines.slice(-10).join('\n');
    return new Response(JSON.stringify({ ok: true, none: false, text: recent }), { status: 200, headers });
  } catch (e) {
    // 読み込み失敗時も朝プロンプト自体は止めない（設計書：エラーにしない）
    return new Response(JSON.stringify({ ok: true, none: true, error: e.message }), { status: 200, headers });
  }
}
