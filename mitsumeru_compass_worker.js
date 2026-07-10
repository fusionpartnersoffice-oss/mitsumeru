/**
 * mitsumeru_compass_worker.js — ミツメル企業向け羅針盤ダッシュボード K-1/K-2 集計Worker
 * ============================================================
 * Worker名: mitsumeru-compass-worker（Cloudflareダッシュボードで柴山さんご本人がデプロイ済み）
 *
 * 【設計原則（最重要）】
 *   個人名・個人ID・日記本文は一切受け取らない・保存しない。
 *   受け取るのは「会社ID・チームID・週・気分カテゴリ」の匿名カウンタ加算のみ。
 *   同一人物が複数回送信しても誰か特定できるデータは一切残らない設計。
 *
 * 【必要なSecrets】
 *   ADMIN_KEY … 集計取得（/aggregate）を保護する共有シークレット
 *
 * 【KV namespace binding】
 *   バインディング変数名: COMPASS_KV（namespace: mitsumeru_compass_data）
 *
 * 【エンドポイント】
 *   POST /checkin    … 匿名の気分カウンタ加算（mitsumeru_lite.html専用）
 *   GET  /aggregate  … 指定チーム・週の集計値取得（?key=ADMIN_KEY必須）
 *
 * 【注記】このファイルはドキュメント・バージョン管理目的のコピーです。
 * 実際の本番コードはCloudflareダッシュボードで直接編集・デプロイされています。
 * このファイルを変更した場合は、ダッシュボード側にも反映してください。
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

const VALID_MOODS = ['hare', 'kumori', 'ame'];

function sanitizeId(v) {
  return String(v || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64);
}

function counterKey(companyId, teamId, week, field) {
  return `cnt_${companyId}_${teamId}_${week}_${field}`;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);

    if (url.pathname === '/checkin' && request.method === 'POST') {
      return handleCheckin(request, env);
    }
    if (url.pathname === '/aggregate' && request.method === 'GET') {
      return handleAggregate(request, env);
    }
    return jsonRes({ error: 'not found' }, 404);
  },
};

// ===== POST /checkin =====
async function handleCheckin(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return jsonRes({ error: 'invalid JSON' }, 400); }

  const companyId = sanitizeId(body.companyId);
  const teamId = sanitizeId(body.teamId);
  const week = sanitizeId(body.week);
  const mood = VALID_MOODS.includes(body.mood) ? body.mood : null;

  if (!companyId || !teamId || !week) {
    return jsonRes({ error: 'companyId・teamId・weekが必要です' }, 400);
  }

  await incrementCounter(env, counterKey(companyId, teamId, week, 'recorded'));
  if (mood) {
    await incrementCounter(env, counterKey(companyId, teamId, week, mood));
  }

  return jsonRes({ ok: true });
}

async function incrementCounter(env, key) {
  const current = parseInt(await env.COMPASS_KV.get(key) || '0', 10);
  await env.COMPASS_KV.put(key, String(current + 1));
}

// ===== GET /aggregate =====
async function handleAggregate(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonRes({ error: 'unauthorized' }, 401);
  }

  const companyId = sanitizeId(url.searchParams.get('companyId'));
  const teamId = sanitizeId(url.searchParams.get('teamId'));
  const week = sanitizeId(url.searchParams.get('week'));
  if (!companyId || !teamId || !week) {
    return jsonRes({ error: 'companyId・teamId・weekが必要です' }, 400);
  }

  const hare = parseInt(await env.COMPASS_KV.get(counterKey(companyId, teamId, week, 'hare')) || '0', 10);
  const kumori = parseInt(await env.COMPASS_KV.get(counterKey(companyId, teamId, week, 'kumori')) || '0', 10);
  const ame = parseInt(await env.COMPASS_KV.get(counterKey(companyId, teamId, week, 'ame')) || '0', 10);
  const recorded = parseInt(await env.COMPASS_KV.get(counterKey(companyId, teamId, week, 'recorded')) || '0', 10);

  return jsonRes({ companyId, teamId, week, hare, kumori, ame, recorded });
}
