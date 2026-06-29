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
    if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }
    if (url.pathname === '/stripe/verify' && request.method === 'GET') {
      return handleStripeVerify(request, env);
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
    await getKV(env).put(
      'stripe_token_' + token,
      JSON.stringify({
        plan: session.metadata?.plan || 'monthly',
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

  const data = JSON.parse(record);
  return jsonRes({ valid: true, plan: data.plan, email: data.email });
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
