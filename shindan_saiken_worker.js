/**
 * shindan_saiken_worker.js — 無料ミニ診断ツール「再建フェーズ診断」リード保存 Worker
 * ============================================================
 * Worker名: shindan-saiken-worker
 * デプロイ: `npx wrangler deploy --config shindan_saiken_wrangler.toml`
 *
 * 【必要なSecrets】
 *   ADMIN_KEY … リード一覧取得（/leads）を保護する共有シークレット
 *
 * 【KV namespace binding】
 *   バインディング変数名: SHINDAN_KV
 *
 * 【エンドポイント】
 *   POST /lead   … 診断結果＋メールアドレスをKVに永続保存（フォームからの送信専用）
 *   GET  /leads  … 保存済みリード一覧をJSONで返す（?key=ADMIN_KEYが必須）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    if (url.pathname === '/lead' && request.method === 'POST') {
      return handleCreateLead(request, env);
    }
    if (url.pathname === '/leads' && request.method === 'GET') {
      return handleListLeads(request, env);
    }
    return jsonRes({ error: 'not found' }, 404);
  },
};

// ===== POST /lead =====
async function handleCreateLead(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'invalid JSON' }, 400); }

  const email = String(body.email || '').trim().substring(0, 200);
  const phase = String(body.phase || '').substring(0, 50);
  const badge = String(body.badge || '').substring(0, 100);
  const answers = Array.isArray(body.answers) ? body.answers.slice(0, 20) : [];

  if (!EMAIL_RE.test(email)) {
    return jsonRes({ error: '有効なメールアドレスが必要です' }, 400);
  }

  const now = Date.now();
  const key = 'lead_' + now + '_' + crypto.randomUUID().substring(0, 8);
  const record = { email, phase, badge, answers, createdAt: new Date(now).toISOString() };

  await env.SHINDAN_KV.put(key, JSON.stringify(record));

  return jsonRes({ ok: true });
}

// ===== GET /leads =====
async function handleListLeads(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonRes({ error: 'unauthorized' }, 401);
  }

  const leads = [];
  let cursor;
  do {
    const list = await env.SHINDAN_KV.list({ prefix: 'lead_', cursor });
    for (const k of list.keys) {
      const raw = await env.SHINDAN_KV.get(k.name);
      if (raw) leads.push(JSON.parse(raw));
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return jsonRes({ count: leads.length, leads });
}
