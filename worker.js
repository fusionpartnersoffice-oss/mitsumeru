/**
 * Mitsumeru Sync Worker — Cloudflare Workers KV proxy ＋ 朝の編成 Cron
 * デプロイ方法: Cloudflare Dashboard > Workers & Pages > mitsumeru-sync > Quick Edit
 * または wrangler deploy
 *
 * KV namespace binding 変数名: MITSUMERU_KV または KV（どちらでも動く。getKV参照）
 *
 * 【Cron Triggers】毎朝7:00 JST に朝の編成を生成しKVへ書き込む。
 *   wrangler.toml:  [triggers]\n  crons = ["0 22 * * *"]   # 22:00 UTC = 07:00 JST
 *   または Dashboard > Settings > Triggers > Cron Triggers で "0 22 * * *" を追加。
 *
 * 【必要なもの】
 *   - Secret: ANTHROPIC_API_KEY（Dashboard > Settings > Variables and Secrets、または
 *     `wrangler secret put ANTHROPIC_API_KEY`）。ミツメルで使っている sk-ant- キーでOK。
 *   - KVキー: knowledge_projects / knowledge_judgment（projects.md / judgment.md の内容を
 *     {"content":"...md全文..."} の形で保存しておく。内容更新時に入れ直す）。
 */

// 編成生成に使うモデル（Anthropic Messages API）
const DISPATCH_MODEL = 'claude-opus-4-8';

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

  // ===== Cron Trigger =====
  // 毎朝7:00 JST (22:00 UTC)：朝の編成生成
  // 毎週月曜7:05 JST (日曜22:05 UTC)：週次ログをGitHubにエクスポート
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === '5 22 * * 0') {
      ctx.waitUntil(exportWeeklyLog(env));
    } else {
      ctx.waitUntil(generateDispatch(env));
    }
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

// KVに {"content":"..."} で保存された資料を読み出す
async function readKnowledge(env, key) {
  const raw = await getKV(env).get(key);
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    return typeof obj === 'string' ? obj : (obj.content || '');
  } catch (e) {
    return raw; // 万一プレーンテキストで入っていた場合
  }
}

// Anthropic Messages API を呼んで本文を返す
async function callClaude(env, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DISPATCH_MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'anthropic error');
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// 過去7日分のdispatchをKVから読んでGitHubへエクスポートする
async function exportWeeklyLog(env) {
  if (!env.GITHUB_TOKEN) return; // Secret未設定なら無音でスキップ

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
  const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

  // 過去7日分のキーを生成
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    days.push(d.toISOString().split('T')[0]);
  }

  // 各日のdispatchを取得
  const entries = await Promise.all(
    days.map(async (day) => {
      const raw = await getKV(env).get('dispatch_' + day);
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw);
        return { date: day, text: obj.text || '' };
      } catch {
        return null;
      }
    })
  );

  // Markdownに整形
  const lines = [`# ミツメル 週次ログ（${dateStr}時点）\n`];
  for (const entry of entries) {
    if (!entry) continue;
    lines.push(`## ${entry.date}\n`);
    lines.push(entry.text);
    lines.push('\n---\n');
  }
  const content = lines.join('\n');

  // GitHub Contents APIでpush
  const filename = `exports/週次ログ_${dateStr.replace(/-/g, '')}.md`;
  const apiUrl = `https://api.github.com/repos/fusionpartnersoffice-oss/mitsumeru/contents/${encodeURIComponent(filename)}`;

  // 既存ファイルのSHAを取得（更新の場合に必要）
  let sha;
  const existing = await fetch(apiUrl, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      'User-Agent': 'mitsumeru-worker',
    },
  });
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const body = {
    message: `週次ログ自動エクスポート ${dateStr}`,
    content: btoa(unescape(encodeURIComponent(content))), // UTF-8 → base64
    ...(sha ? { sha } : {}),
  };

  await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mitsumeru-worker',
    },
    body: JSON.stringify(body),
  });
}

// 朝の編成を生成してKVへ保存
async function generateDispatch(env) {
  const date = jstDateStr();
  const projects = await readKnowledge(env, 'knowledge_projects');
  const judgment = await readKnowledge(env, 'knowledge_judgment');

  const prompt = `あなたは柴山靖章さんの「朝の編成」担当です。毎朝、隣で一緒に今日の動き方を整理する伴走者として書いてください。以下の2つの資料をもとに、今日(${date})やることを整理してください。

# プロジェクト進捗（projects.md）
${projects || '（資料未登録）'}

# 判断軸（judgment.md）
${judgment || '（資料未登録）'}

# 指示
- projects.mdの「次のアクション」をアイゼンハワーマトリクス（①急×重要→今すぐ ②重要×急でない→計画 ③急×重要でない→委任 ④それ以外→先送り/損切り）で4象限に分類する
- 最優先1件をD-Block（朝の聖域直後の最優先枠）に固定し、2分間ルールで「最初の物理動作」に分解する
- ポモ割を提案する。1ポモ=30分、1日上限10ポモ(300分)。各タスクに必要ポモ数を割り当て、合計が10ポモを超える分は損切り候補として提示する
- judgment.mdのNEVER（就活地雷N-1〜N-8・行動のNEVER）に触れそうな項目があれば警告する

# 文体（重要・最優先で守ること）
- 「です・ます」調。精神論を排し、知的だが飾らない語り口
- 「防空レーダー」「戦闘配置」のような軍事・分析レポート的な比喩は使わない。凝った例え話も使わない
- 専門用語（ビジネス用語・カタカナ語）はできるだけ避け、短く分かりやすい言葉で書く
- 分析結果を突きつけるのではなく、隣で一緒に今日の段取りを考えている、という伴走感のある口調にする
- **上記の資料（projects.md・judgment.md）の中に、見出し名・専門用語・心理指標（例：「防空レーダー」という見出し、「エニアグラム」の番号、「A（論理思考：9）」等の指標表記）がそのまま書かれていても、それを引用・転記しないこと。** 資料の中身を理解した上で、必ず自分の言葉に置き換えて話すこと。専門用語をそのまま出力に含めるのは禁止
- 「〜という性質だが」「〜の方向に精密に向かい始める」のような硬い分析口調・断定的な性質診断の言い回しも避け、口語的で柔らかい言い方にする（例：「〜な感じですね」「〜だと思います」等、伴走者が話しかけるような言葉遣い）
- **一指示一動作（介護現場の声かけの原則を応用）**：各セクション（🎯🗓🤝✂️）は、そのセクションの役割1つだけに集中する。1つの文の中に「原因分析＋対策＋複数の問いかけ」を同時に詰め込まない。伝えることは一度に1つずつ、短く区切る
- **言葉選びの変換（スピーチロック回避）**：「〜すべきです」「〜してください」という命令形・断定形は、「〜してみませんか」「〜でどうでしょう」という提案・確認の形に変換する。判断を柴山さんに委ねる言い方にする

# 出力フォーマット（この見出しで簡潔に。前置き不要）
🎯 今日のD-Block
🗓 ポモ割
🤝 委任候補
✂️ 損切り
⚠️ NEVER警告（該当なければ省略）`;

  let text;
  try {
    text = await callClaude(env, prompt);
  } catch (e) {
    text = `朝の編成の自動生成に失敗しました（${date}）。\n理由: ${e.message}\nAPIキー・資料の登録状況をご確認ください。`;
  }

  const body = JSON.stringify({ text, _ts: Date.now() });
  await getKV(env).put('dispatch_' + date, body, { expirationTtl: 7776000 });
}

// ═══════════════════════════════════════════════
//  G連携基盤：ミツメルの記録をGoogleカレンダーへ自動書き出し（Phase1・柴山さんご本人専用）
//  設計：06_イノベーション/Google連携基盤_統合実装設計_20260711.md §3
//  G1：認証（サービスアカウントJWT）／G2：KV読み取り／G3-カレンダー：書き込み
// ═══════════════════════════════════════════════

async function handleSyncCalendar(request, env) {
  const headers = { ...CORS_HEADERS, 'Content-Type': 'application/json' };

  // Secret未設定時は無音でスキップする（既存のGITHUB_TOKEN未設定時と同じパターン。エラーにしない）
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
