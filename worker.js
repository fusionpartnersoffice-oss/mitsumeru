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

  // ===== Cron Trigger（毎朝7:00 JST = 22:00 UTC）=====
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateDispatch(env));
  },
};

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

// 朝の編成を生成してKVへ保存
async function generateDispatch(env) {
  const date = jstDateStr();
  const projects = await readKnowledge(env, 'knowledge_projects');
  const judgment = await readKnowledge(env, 'knowledge_judgment');

  const prompt = `あなたは柴山靖章さんの「朝の編成」担当の参謀です。以下の2つの資料をもとに、今日(${date})の戦闘配置を組んでください。

# プロジェクト進捗（projects.md）
${projects || '（資料未登録）'}

# 判断軸（judgment.md）
${judgment || '（資料未登録）'}

# 指示
- projects.mdの「次のアクション」をアイゼンハワーマトリクス（①急×重要→今すぐ ②重要×急でない→計画 ③急×重要でない→委任 ④それ以外→先送り/損切り）で4象限に分類する
- 最優先1件をD-Block（朝の聖域直後の最優先枠）に固定し、2分間ルールで「最初の物理動作」に分解する
- ポモ割を提案する。1ポモ=30分、1日上限10ポモ(300分)。各タスクに必要ポモ数を割り当て、合計が10ポモを超える分は損切り候補として提示する
- judgment.mdのNEVER（就活地雷N-1〜N-8・行動のNEVER）に触れそうな項目があれば警告する
- 文体は「です・ます」調。精神論を排し、エレガントに毒を吐く知的な語り口

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
