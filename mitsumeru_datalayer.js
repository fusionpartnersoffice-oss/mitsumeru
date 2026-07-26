/**
 * mitsumeru_datalayer.js — 保存・複製・テストモード分離の一本化（v10フルモデルチェンジ・2026-07-26）
 *
 * 背景：2026-07-26の一日で、syncToVault・cloudSave・isTestMode・kvPrefixが、Vault連携の
 * 各機能発注のたびに個別に実装・修正され、同じ種類の変更（テストモード対応・エラーの握りつぶし
 * 修正等）を3回作り直す事故が起きた。設計書`ミツメル_フルモデルチェンジ_v10設計_20260726.md`
 * ①DataLayerの統合方針に基づき、保存ロジックをこのファイル1箇所に集約する。
 *
 * 呼び出し元（mitsumeru_private.htmlの朝タブ・随時メモ・夜タブ）は変更しない
 * （開発Bの判断通り、3箇所からの呼び出しは単一障害点解消のための正当な独立トリガー）。
 *
 * 依存（呼び出し時点でグローバルに存在していればよい。このファイルの定義時点では未定義でも可）：
 *   - SYNC_URL（mitsumeru_private.html本体で定義）
 *   - getPrivateToken()（同上）
 *   - targetDate（同上）
 *   - showSyncStatus()（同上・UI表示のため。DataLayerには含めない）
 *   - localDateStr()（mitsumeru_core.js等）
 */

// 原則6（2026-07-26・実装安全原則v2・インシデント再発防止）：
// テストモード時は保存先キーのプレフィックスをprivate_からtest_へ強制的に差し替える。
// 「気をつける」ではなく構造的に本番データへ書き込めなくする。URLパラメータ?testmode=1
// またはlocalStorageフラグで有効化。実機検証時は必ずこれを有効にしてから行うこと。
function isTestMode() {
  try {
    if (new URLSearchParams(location.search).get('testmode') === '1') return true;
  } catch (e) {}
  return localStorage.getItem('mitsumeru_test_mode') === '1';
}
function kvPrefix() { return isTestMode() ? 'test_' : 'private_'; }

if (isTestMode()) {
  console.warn('[テストモード] 保存先はtest_プレフィックスに切り替わっています。本番データへは書き込まれません。');
  window.addEventListener('DOMContentLoaded', () => {
    const banner = document.createElement('div');
    banner.textContent = '🧪 テストモード（test_キーへ書き込み中・本番データは保護されています）';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b8860b;color:#fff;text-align:center;font-size:12px;padding:4px;';
    document.body.prepend(banner);
  });
}

// 安全装置①（2026-07-03）：プライベート版はKV側も'private_'（テストモード時は'test_'）
// プレフィックスの専用キー空間を使う。本番mitsumeru_app.htmlと物理的にキーが分離されているため、
// 安全装置②（isProductionHostガード）はこのファイルでは不要。
async function cloudSave(type, data, date) {
  const key = kvPrefix() + type + '_' + (date || targetDate);
  showSyncStatus('saving');
  try {
    const res = await fetch(`${SYNC_URL}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(getPrivateToken())}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({...data, _ts: Date.now()})
    });
    if (res.ok) { showSyncStatus('synced'); }
    else { showSyncStatus('failed'); }
  } catch(e) {
    showSyncStatus(navigator.onLine ? 'failed' : 'offline');
  }
}

// 朝夜タブの自由記述欄は1文字入力ごとにcloudSaveが発火しKV書き込みが過多になるため、
// 入力停止後1.5秒待ってから最後の内容のみ書き込む（localStorageは即時保存のまま変更なし）
const _cloudSaveDebounceTimers = {};
function cloudSaveDebounced(type, data, date, delay = 1500) {
  const key = type + '_' + (date || targetDate);
  clearTimeout(_cloudSaveDebounceTimers[key]);
  _cloudSaveDebounceTimers[key] = setTimeout(() => cloudSave(type, data, date), delay);
}

async function cloudSaveGlobal(type, data) {
  try {
    await fetch(`${SYNC_URL}?key=${encodeURIComponent(kvPrefix() + type + '_global')}&token=${encodeURIComponent(getPrivateToken())}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({...data, _ts: Date.now()})
    });
  } catch(e) {}
}

async function cloudSaveFusionOSStatus(data) {
  const date = targetDate || localDateStr(new Date());
  try {
    await fetch(`${SYNC_URL}?key=${encodeURIComponent(kvPrefix() + 'fusionos_status_' + date)}&token=${encodeURIComponent(getPrivateToken())}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({...data, source: 'mitsumeru_private', date, _ts: Date.now()})
    });
  } catch(e) {}
}

async function cloudLoadGlobal(type) {
  try {
    const res = await fetch(`${SYNC_URL}?key=${encodeURIComponent(kvPrefix() + type + '_global')}&token=${encodeURIComponent(getPrivateToken())}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.value) return null;
    return typeof json.value === 'string' ? JSON.parse(json.value) : json.value;
  } catch(e) { return null; }
}

async function cloudLoad(type, date) {
  const key = kvPrefix() + type + '_' + (date || targetDate);
  try {
    const res = await fetch(`${SYNC_URL}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(getPrivateToken())}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.value) return null;
    return typeof json.value === 'string' ? JSON.parse(json.value) : json.value;
  } catch(e) { return null; }
}

// 設計指摘（2026-07-20）：cloudLoad()は「401等の失敗」と「200だがデータが無いだけ」を
// どちらもnullで返すため区別できない。既存のcloudLoad()呼び出し箇所はこの区別を必要としない
// ため契約を変えず、区別が要るforceSyncFromCloud()専用にauthFailedを持つ新関数を用意している。
async function cloudLoadStatus(type, date) {
  const key = kvPrefix() + type + '_' + (date || targetDate);
  try {
    const res = await fetch(`${SYNC_URL}?key=${encodeURIComponent(key)}&token=${encodeURIComponent(getPrivateToken())}`);
    if (res.status === 401) return { ok: false, authFailed: true, value: null };
    if (!res.ok) return { ok: false, authFailed: false, value: null };
    const json = await res.json();
    if (!json.value) return { ok: true, authFailed: false, value: null };
    return { ok: true, authFailed: false, value: typeof json.value === 'string' ? JSON.parse(json.value) : json.value };
  } catch(e) { return { ok: false, authFailed: false, value: null }; }
}

// G連携基盤・G3-Vault：Vault（Google Drive）への複製書き込み。
// 2026-07-26是正：呼び出し元は夜の締め(closeDayHPMP)だけでなく、朝(calcMorning)・
// 随時メモ(saveMemos)からも呼ばれる（単一障害点の解消のため3箇所化。呼び出し元は各関数の
// コメント参照。3箇所とも明示的な完了アクションからの即時呼び出しであり、デバウンスはしない
// ——デバウンスをsaveMorning()側に仕込んだ結果、タブを即座に閉じると発火しない事故が
// 実際に発生したため、単一障害点解消の設計自体をここで確定させている）。
// Secret未設定・OAuth2未セットアップ時はWorker側で無音スキップされる。失敗しても既存機能には一切影響させない。
function syncToVault() {
  // 原則6（2026-07-26・実装安全原則v2）：テストモード中はVaultへの複製も必ずスキップする。
  // KVはtest_プレフィックスで分離済みだが、Vault（Google Drive）は分離の仕組みが無いため、
  // ここで止めない限りテストデータが本物のVaultファイルを上書きしてしまう。
  if (isTestMode()) { console.warn('[テストモード] Vaultへの複製をスキップしました'); return; }
  const date = targetDate || localDateStr(new Date());
  fetch(`${SYNC_URL}/sync-vault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, token: getPrivateToken() }),
  }).then(async res => {
    // 設計指摘（2026-07-26）：黙って失敗させない。HTTPエラー・レスポンス内のok:false も
    // console.errorへ残す（.catchはネットワーク層の失敗しか捕捉できず、401等のHTTPエラーや
    // {ok:false}レスポンスは今まで完全に握りつぶされていた）。
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok || (body && body.ok === false)) {
      console.error('[syncToVault] Vaultへの複製に失敗しました:', res.status, body);
    }
  }).catch(e => {
    console.error('[syncToVault] Vaultへの複製で通信エラー:', e.message);
  });
}
