/**
 * Mitsumeru Sync Worker — Cloudflare Workers KV proxy ＋ Googleカレンダー連携
 * デプロイ方法: Cloudflare Dashboard > Workers & Pages > mitsumeru-sync > Quick Edit
 * または wrangler deploy
 *
 * KV namespace binding 変数名: MITSUMERU_KV または KV（どちらでも動く。getKV参照）
 *
 * Cron Triggerは使用していない（2026-07-14・柴山さんご本人の判断により、朝の編成・週次ログ
 * エクスポートの両方を撤去。Cloudflare側のCron Trigger登録もあわせて削除すること）。
 *
 * 【必要なもの】
 *   - Secret: GOOGLE_SERVICE_ACCOUNT_KEY／GOOGLE_CALENDAR_ID（Googleカレンダー連携用、
 *     Secret未設定時は無音でスキップ）
 *   - Secret: MOBILE_ACCESS_KEY（GET /me用の簡易共有キー。柴山さんご本人のみが知る文字列。
 *     未設定時は/meが常に401を返す＝安全側に倒れる）
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

export default {
  async fetch(request, env) {
    // OPTIONSプリフライトリクエスト（モバイルブラウザのCORS対応）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ===== G連携基盤：ミツメルの記録をGoogleカレンダーへ自動書き出し（Phase1・私専用） =====
    if (url.pathname === '/sync-calendar' && request.method === 'POST') {
      return handleSyncCalendar(request, env);
    }

    // ===== アクセス解析（簡易・自前実装）：案件0の原因切り分け用（2026-07-14） =====
    // 個人情報・IPアドレス等は一切記録しない。ページ名＋日付ごとの匿名カウントのみ。
    if (url.pathname === '/pv' && request.method === 'GET') {
      return handlePageview(request, env);
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
    const accessToken = await getGoogleAccessToken(env);             // G1
    const event = await writeCalendarEvent(env, accessToken, date, record); // G3-カレンダー
    return new Response(JSON.stringify({ ok: true, date, eventId: event.id }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
}

// ── G2：KVデータ読み取りブロック ──
// mitsumeru_private.html の cloudSave() は private_{type}_{date} 形式でKVへ保存している。
// プロファイルキー（private_profile_global）には設計上の制約により一切アクセスしない。
async function getPrivateDailyRecord(env, date) {
  const kv = getKV(env);
  const [morningRaw, eveningRaw, memosRaw] = await Promise.all([
    kv.get('private_morning_' + date),
    kv.get('private_evening_' + date),
    kv.get('private_memos_' + date),
  ]);
  const parseJson = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };
  return {
    morning: parseJson(morningRaw),
    evening: parseJson(eveningRaw),
    memos: parseJson(memosRaw),
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

async function getGoogleAccessToken(env) {
  const keyJson = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: keyJson.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
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
