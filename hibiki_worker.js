/**
 * hibiki_worker.js — 響（Hibiki）Cloudflare Worker
 * ============================================================
 * デプロイ方法: Cloudflare Dashboard > Workers & Pages > 新規Worker > Quick Edit
 * Worker名: hibiki-worker
 *
 * 【必要なSecrets（Dashboard > Settings > Variables and Secrets）】
 *   ANTHROPIC_API_KEY     … 柴山さんのAnthropicキー (sk-ant-...)
 *   STRIPE_SECRET_KEY     … Stripe Secret Key（本稼働時に設定）
 *   STRIPE_WEBHOOK_SECRET … Stripe Webhook署名Secret（本稼働時に設定）
 *   PRIVATE_ACCESS_TOKEN  … 2026-07-20追加。/kanade-analyzeの認証トークン
 *     （mitsumeru-sync Workerの同名Secretと同じ値を使う想定・実装安全原則v1原則1準拠。
 *     未設定時は/kanade-analyzeが常に401を返す＝安全側に倒れる）
 *
 * 【KV namespace binding】
 *   バインディング変数名: HIBIKI_KV
 *   （Dashboard > Settings > Variables > KV Namespace Bindings）
 *   KV namespace は新規作成: "hibiki-kv"
 *
 * 【エンドポイント】
 *   POST /analyze          … Claude APIプロキシ（デモ or Stripe認証）
 *   POST /stripe/webhook   … Stripe決済完了Webhook → アクセストークン発行
 *   GET  /stripe/verify    … トークン有効性確認
 *   POST /kanade-analyze   … 奏（Kanade）専用・内部利用限定のClaude APIプロキシ
 *                            （社内利用のみ・外部公開の意図なし。ANTHROPIC_API_KEYを直接使用）
 *
 * 【デモモード仕様】
 *   端末固有ID（fingerprint）をキーにKVでカウント管理。
 *   DEMO_MAX回を超えたらHTTP 403 + demo_exceeded:true を返す。
 *
 * 【Stripeモード仕様】
 *   checkout.session.completed Webhook受信 → KVにUUIDトークン保存（30日TTL）。
 *   HTMLはトークンをlocalStorageに保持し、毎リクエストで送信する。
 */

const MODEL = 'claude-sonnet-4-6';
const DEMO_MAX = 20;
const TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30日
const DEMO_TTL_SEC  = 60 * 60 * 24 * 90; // 90日
const KANADE_DAILY_MAX = 500; // 柴山さん一人の利用が前提の乱用防止・多めに設定

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
  'Access-Control-Max-Age': '86400',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function getKV(env) {
  return env.HIBIKI_KV || env.KV;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/analyze' && request.method === 'POST') {
      return handleAnalyze(request, env);
    }
    if (url.pathname === '/kanade-analyze' && request.method === 'POST') {
      return handleKanadeAnalyze(request, env);
    }
    if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === '/stripe/verify' && request.method === 'GET') {
      return handleStripeVerify(request, env);
    }
    if (url.pathname === '/lite-usage-check' && request.method === 'POST') {
      return handleLiteUsageCheck(request, env);
    }

    return jsonRes({ error: 'not found' }, 404);
  },
};

// ===== /analyze =====
async function handleAnalyze(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'invalid JSON' }, 400); }

  const { mode, fingerprint, token, messages, system, maxTokens = 1024 } = body;

  if (!messages || !Array.isArray(messages) || !system) {
    return jsonRes({ error: 'messages（配列）と system が必要です' }, 400);
  }

  const { apikey } = body;

  // ── 認証 ──
  let useApiKey = env.ANTHROPIC_API_KEY;

  if (mode === 'apikey') {
    // ユーザー自身のAPIキーを使用（sk-ant- で始まる場合のみ許可）
    if (!apikey || !String(apikey).startsWith('sk-ant-')) {
      return jsonRes({ error: '有効なAnthropicAPIキー（sk-ant-...）が必要です' }, 401);
    }
    useApiKey = String(apikey).substring(0, 200);
  } else if (mode === 'stripe') {
    if (!token) return jsonRes({ error: 'token が必要です' }, 401);
    const record = await getKV(env).get('stripe_token_' + String(token).substring(0, 64));
    if (!record) return jsonRes({ error: 'トークンが無効または期限切れです' }, 403);
  } else {
    // デモモード
    if (!fingerprint) return jsonRes({ error: 'fingerprint が必要です' }, 400);
    const fp = String(fingerprint).substring(0, 64);
    const countKey = 'hibiki_demo_' + fp;
    const current = parseInt(await getKV(env).get(countKey) || '0');
    if (current >= DEMO_MAX) {
      return jsonRes({
        error: 'お試しの上限（20回）に達しました。続きをご希望の方はご連絡ください。',
        demo_exceeded: true,
      }, 403);
    }
    // 楽観的カウントアップ（Claude呼び出し前）
    await getKV(env).put(countKey, String(current + 1), { expirationTtl: DEMO_TTL_SEC });
  }

  // ── Claude API（SSEストリーミング） ──
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': useApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      stream: true,
      system,
      messages,
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.json().catch(() => ({}));
    return jsonRes({ error: err.error?.message || 'Claude API error' }, 502);
  }

  // SSEをそのままクライアントに転送
  return new Response(claudeRes.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ===== /kanade-analyze（奏専用・内部利用限定） =====
async function handleKanadeAnalyze(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'invalid JSON' }, 400); }

  // 実装安全原則v1・原則1（フロント/対象限定を防御とみなさない）：内部専用ツールであっても
  // 公開URLを知っていれば誰でも叩けるため、サーバー側でトークン必須化する（2026-07-20追加）。
  // mitsumeru-syncのPRIVATE_ACCESS_TOKENと同じパターン。個人データ漏洩リスクは無いが、
  // 認証を怠るとAPIコストの空撃ちを許してしまう。
  const { token } = body;
  if (!env.PRIVATE_ACCESS_TOKEN || token !== env.PRIVATE_ACCESS_TOKEN) {
    return jsonRes({ error: 'valid token required' }, 401);
  }

  const { promptText } = body;
  if (!promptText || typeof promptText !== 'string') {
    return jsonRes({ error: 'promptText（文字列）が必要です' }, 400);
  }

  if (!env.ANTHROPIC_API_KEY) {
    return jsonRes({ error: 'サーバー側のAI設定が未完了です（ANTHROPIC_API_KEY未設定）' }, 500);
  }

  // 乱用防止：1日あたりの総呼び出し数（柴山さん一人の利用が前提・多めの上限）
  const today = new Date().toISOString().slice(0, 10);
  const countKey = 'kanade_daily_' + today;
  const current = parseInt(await getKV(env).get(countKey) || '0');
  if (current >= KANADE_DAILY_MAX) {
    return jsonRes({ error: '本日の利用上限に達しました。明日また試してください。' }, 429);
  }
  await getKV(env).put(countKey, String(current + 1), { expirationTtl: 60 * 60 * 24 * 2 });

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      messages: [{ role: 'user', content: promptText }],
    }),
  });

  const data = await claudeRes.json().catch(() => ({}));
  if (!claudeRes.ok || data.error) {
    return jsonRes({ error: data.error?.message || 'Claude API error' }, 502);
  }

  return jsonRes({ content: data.content || [] });
}

// ===== /stripe/webhook =====
async function handleStripeWebhook(request, env) {
  const sig = request.headers.get('stripe-signature');
  const rawBody = await request.text();

  if (!sig || !env.STRIPE_WEBHOOK_SECRET) {
    return jsonRes({ error: 'webhook secret が未設定です' }, 500);
  }

  const isValid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) return jsonRes({ error: '署名が不正です' }, 400);

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return jsonRes({ error: 'invalid JSON' }, 400); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const token = crypto.randomUUID();
    // 2026-07-20：ミツメルLiteのPayment LinkはStripe APIで作成済みのためダッシュボードから
    // metadataを編集できない（「編集」がAPI専用ロックされている）。現時点でこのWebhookが受ける
    // 決済はミツメルLiteのみのため、metadata未設定時のデフォルトを'mitsumeru_lite'にする。
    // 将来別商品を追加する際は、このデフォルトに頼らずPayment Link作成時にmetadataを指定すること。
    await getKV(env).put(
      'stripe_token_' + token,
      JSON.stringify({
        plan: session.metadata?.plan || 'mitsumeru_lite',
        customer: session.customer || '',
        email: session.customer_details?.email || '',
        created: Date.now(),
      }),
      { expirationTtl: TOKEN_TTL_SEC }
    );
    // 発行トークンをKVに記録（柴山さんが手動でメール送付する用）
    await getKV(env).put(
      'pending_token_' + Date.now(),
      JSON.stringify({ token, email: session.customer_details?.email || '' }),
      { expirationTtl: TOKEN_TTL_SEC }
    );
  }

  return jsonRes({ received: true });
}

// ===== /stripe/verify =====
async function handleStripeVerify(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return jsonRes({ valid: false, error: 'token required' }, 400);

  const record = await getKV(env).get('stripe_token_' + String(token).substring(0, 64));
  if (!record) return jsonRes({ valid: false });

  // 課金判定にはvalid/planのみで十分（設計・QA指摘・2026-07-20）。emailはトークン漏洩時に
  // 購入者の個人情報まで一緒に漏れてしまうため、レスポンスに含めない。
  const data = JSON.parse(record);
  return jsonRes({ valid: true, plan: data.plan });
}

// ===== /lite-usage-check（ミツメルLite・利用回数のサーバー側管理） =====
// QA差し戻し対応（2026-07-20・案B確定）：Pro判定だけでなく利用回数の判定・カウントアップも
// サーバー側を正とする。クライアントのlocalStorageは表示専用に格下げし、実行可否の判定は
// 必ずこのエンドポイントの応答で決める（実装安全原則v1・原則1準拠）。
const LITE_FREE_MAX = 5;
const LITE_PRO_MONTH_MAX = 30;
const LITE_FREE_TTL_SEC = 60 * 60 * 24 * 365; // 累計カウントのため長め（1年）
const LITE_PRO_TTL_SEC = 60 * 60 * 24 * 35;   // 月次カウントなので月末+αで十分

async function handleLiteUsageCheck(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'invalid JSON' }, 400); }

  const { visitorId, token } = body;
  const kv = getKV(env);
  const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM

  // Proトークンが送られてきた場合：有効かつミツメルLite用トークンであれば月間上限で判定
  if (token) {
    const record = await kv.get('stripe_token_' + String(token).substring(0, 64));
    if (record) {
      const data = JSON.parse(record);
      if (data.plan === 'mitsumeru_lite') {
        const countKey = 'lite_pro_count_' + String(token).substring(0, 64) + '_' + monthKey;
        const current = parseInt(await kv.get(countKey) || '0');
        if (current >= LITE_PRO_MONTH_MAX) {
          return jsonRes({ allowed: false, pro: true, remaining: 0, reason: 'monthly_limit' });
        }
        await kv.put(countKey, String(current + 1), { expirationTtl: LITE_PRO_TTL_SEC });
        return jsonRes({ allowed: true, pro: true, remaining: LITE_PRO_MONTH_MAX - current - 1 });
      }
    }
    // トークンが無効・期限切れ・他商品用の場合は無料枠へフォールスルー（詐称対策・原則2）
  }

  if (!visitorId || typeof visitorId !== 'string') {
    return jsonRes({ error: 'visitorId が必要です' }, 400);
  }
  const fp = visitorId.substring(0, 64);
  const freeKey = 'lite_free_count_' + fp;
  const current = parseInt(await kv.get(freeKey) || '0');
  if (current >= LITE_FREE_MAX) {
    return jsonRes({ allowed: false, pro: false, remaining: 0, reason: 'free_limit' });
  }
  await kv.put(freeKey, String(current + 1), { expirationTtl: LITE_FREE_TTL_SEC });
  return jsonRes({ allowed: true, pro: false, remaining: LITE_FREE_MAX - current - 1 });
}

// ===== Stripe署名検証（Web Crypto API） =====
async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',').reduce((acc, part) => {
      const [k, v] = part.split('=');
      if (k && v) acc[k.trim()] = v.trim();
      return acc;
    }, {});
    const timestamp = parts['t'];
    const v1 = parts['v1'];
    if (!timestamp || !v1) return false;

    const signed = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
    const hex = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return hex === v1;
  } catch {
    return false;
  }
}
