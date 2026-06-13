/**
 * Mitsumeru Sync Worker — Cloudflare Workers KV proxy
 * デプロイ方法: Cloudflare Dashboard > Workers & Pages > mitsumeru-sync > Quick Edit
 * または wrangler deploy
 *
 * KV namespace binding name: KV（Cloudflare設定と一致させること）
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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
      await env.KV.put(key, body, { expirationTtl: 7776000 });

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (request.method === 'GET') {
      const value = await env.KV.get(key);

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
