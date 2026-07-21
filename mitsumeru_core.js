// ============================================================
// mitsumeru_core.js — ミツメル共通コア（柱A・2026-07-21）
// mitsumeru_app.html / mitsumeru_private.html / mitsumeru_lite.html
// 共通のAPIキー管理・Claude API呼び出し・案内文言をここに集約する。
// 設計：06_イノベーション\ミツメル_共通コア化_柱A設計書_v1_20260721.md
//
// 呼び出し元は自分のlocalStorageキー名（storageKey）を渡す。
// キー名自体は統一しない（app/lite='mitsumeru_api_key'、
// private='mitsumeru_private_api_key'）——既存キー名を変えると
// 柴山さんの既存キーが「消えた」ように見えるため、現状維持。
// ============================================================

const MITSUMERU_MSG = {
  apiKeyInvalidFormat: 'キーの形式が正しくないようです（sk- で始まる文字列のはずです）',
  apiKeyNotSet: 'まだ設定されていません。上の手順でキーを入力してください。',
  apiKeySaved: (preview) => `保存しました（${preview}...）`,
  apiKeySavedShort: (preview) => `✅ 保存しました（${preview}...）`,
  apiKeyConfiguredShort: (preview) => `✅ 設定済みです（${preview}...）`,
  apiKeyPromptBody: 'AnthropicのAPIキーを入力してください：\n\n取得方法：console.anthropic.com → API Keys → Create Key',
  apiKeyNotConfigured: 'APIキーが設定されていません。設定タブ → APIキー欄で設定してください。',
};

// localStorageから既存キーを取得する（未設定ならnull）
function mitsumeruGetApiKey(storageKey) {
  return localStorage.getItem(storageKey) || null;
}

// キーを保存する（設定画面のフォーム保存等から呼ぶ）
function mitsumeruSetApiKey(storageKey, key) {
  const trimmed = (key || '').trim();
  if (!trimmed) return { ok: false, message: MITSUMERU_MSG.apiKeyNotSet };
  if (!trimmed.startsWith('sk-')) return { ok: false, message: MITSUMERU_MSG.apiKeyInvalidFormat };
  localStorage.setItem(storageKey, trimmed);
  return { ok: true, key: trimmed };
}

// prompt()での取得（app/lite等、モーダルを持たない旧UI向けの互換関数）。
// 平易な文言に統一済み（技術用語露出の是正を兼ねる）。
function mitsumeruPromptApiKey(storageKey) {
  const key = prompt(MITSUMERU_MSG.apiKeyPromptBody);
  if (!key) return null;
  const result = mitsumeruSetApiKey(storageKey, key);
  if (!result.ok) { alert(result.message); return null; }
  return result.key;
}

// Claude API呼び出し。
// proxyUrlを渡すとWorkerプロキシ（{proxyUrl}/analyze-proxy）経由になる（app.htmlが2026-07-19に
// 移行済みの安全な方式。ブラウザから直接api.anthropic.comを叩かないため、
// CORS回避のためのブラウザセキュリティ無効化案内が不要）。
// 省略時は直接fetch（旧方式・過渡的に残す。3ファイル全てプロキシ統一後は
// このオプション自体を撤去する想定。設計：06_イノベーション\ミツメル_共通コア化_柱A設計書_v1_20260721.md）
function mitsumeruCallClaude(storageKey, promptText, onSuccess, onError, maxTokens, proxyUrl) {
  maxTokens = maxTokens || 4000;
  const key = mitsumeruGetApiKey(storageKey);
  if (!key) { onError(MITSUMERU_MSG.apiKeyNotConfigured); return; }

  const request = proxyUrl
    ? fetch(`${proxyUrl}/analyze-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: key, promptText, maxTokens })
      })
    : fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: promptText }]
        })
      });

  request.then(r => r.json()).then(data => {
    if (data.error) { onError(typeof data.error === 'string' ? data.error : data.error.message); return; }
    const text = data.content?.map(c => c.text || '').join('') || 'エラーが発生しました';
    onSuccess(text);
  }).catch(e => onError(e.message));
}
