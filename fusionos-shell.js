/*
 * FUS-352②（2026-08-30・柴山さん直接指示）
 * 「各ツールとも左サイドバー（タブレット/スマホでは下部ボタンバー）は常に表示されていて
 *  遷移できるとありがたい」への対応。
 * mitsumeru_private.htmlに実装済みのサイドバー/ボトムナビを、共有ファイル1本として切り出し、
 * 対象5ページ（kanade_hub.html／nagi_hub.html／hibiki_koe.html／index.html／naze_naze.html）
 * から読み込む。1箇所を直せば全ページに反映される構造にする（コピー禁止・Simplicity First）。
 *
 * 使い方：各ページの</body>直前に <script src="fusionos-shell.js"></script> を追加するだけ。
 * ホストページのCSS変数（--bg等）には依存せず、Fusion Partners配色を自前で持つ
 * （ホストページごとにテーマ変数が異なるため）。
 */
(function () {
  var CURRENT = (location.pathname.split('/').pop() || 'mitsumeru_private.html');

  var TOOLS = [
    { label: 'ミツメル', href: 'mitsumeru_private.html', group: 'core' },
    { label: '朝刊', href: 'mitsumeru_private.html', group: 'core' },
    { label: '奏 Kanade', href: 'kanade_hub.html', group: 'tool' },
    { label: '凪 Nagi', href: 'nagi_hub.html', group: 'tool' },
    { label: '響 Hibiki', href: 'hibiki_koe.html', group: 'tool' },
    { label: '3minエマージェンシー', href: 'index.html', group: 'tool' },
    { label: 'なぜなぜ分析', href: 'naze_naze.html', group: 'tool' }
  ];
  var FUTURE = [
    { label: '弦 Yuzuru', tag: '未定' },
    { label: '勤務表', tag: '配属待ち' }
  ];

  var CSS = ''
    + '#fos-shell-sidebar{position:fixed;top:0;left:0;bottom:0;width:220px;background:#2a2620;color:#c9bea5;'
    + 'padding:22px 14px;overflow-y:auto;z-index:9998;display:flex;flex-direction:column;gap:4px;'
    + 'font-family:"Noto Sans JP","Zen Kaku Gothic New",sans-serif;box-sizing:border-box;}'
    + '#fos-shell-sidebar *{box-sizing:border-box;}'
    + '#fos-shell-sidebar .fos-brand{padding:4px 10px 18px;}'
    + '#fos-shell-sidebar .fos-brand img{display:block;width:40px;height:40px;margin-bottom:10px;}'
    + '#fos-shell-sidebar .fos-brand span{display:block;font-family:"Shippori Mincho",serif;font-weight:600;'
    + 'font-size:28px;color:#a8672e;letter-spacing:.03em;line-height:1.1;}'
    + '#fos-shell-sidebar .fos-group-label{font-size:10px;letter-spacing:.14em;color:#8c8570;'
    + 'padding:14px 10px 6px;text-transform:uppercase;}'
    + '#fos-shell-sidebar .fos-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;'
    + 'font-size:13.5px;cursor:pointer;color:#c9bea5;text-decoration:none;}'
    + '#fos-shell-sidebar .fos-item .fos-dot{width:6px;height:6px;border-radius:50%;background:#d3c6a8;flex:none;}'
    + '#fos-shell-sidebar .fos-item.active{background:#7a4a24;color:#ece4d3;font-weight:700;}'
    + '#fos-shell-sidebar .fos-item.active .fos-dot{background:#a8672e;}'
    + '#fos-shell-sidebar .fos-item.future{opacity:.55;pointer-events:none;}'
    + '#fos-shell-sidebar .fos-item.future .fos-tag{margin-left:auto;font-size:9px;border:1px solid #5c5747;'
    + 'padding:1px 5px;border-radius:4px;color:#8c8570;}'
    + '@media(min-width:821px){body{margin-left:220px;}}'
    + '@media(max-width:820px){#fos-shell-sidebar{display:none;}body{padding-bottom:64px;}}'
    + '#fos-shell-bottomnav{display:none;position:fixed;left:0;right:0;bottom:0;z-index:9998;'
    + 'background:#e3d9c2;border-top:1px solid #d3c6a8;padding:6px 4px calc(6px + env(safe-area-inset-bottom));'
    + 'justify-content:space-around;align-items:stretch;font-family:"Noto Sans JP","Zen Kaku Gothic New",sans-serif;}'
    + '#fos-shell-bottomnav *{box-sizing:border-box;}'
    + '#fos-shell-bottomnav a{display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 4px;'
    + 'border-radius:8px;color:#8c8570;flex:1;font-size:10px;text-decoration:none;min-width:0;}'
    + '#fos-shell-bottomnav a .fos-ico{font-size:18px;line-height:1;}'
    + '#fos-shell-bottomnav a.active{color:#5f7a4a;font-weight:700;}'
    + '@media(max-width:820px){#fos-shell-bottomnav{display:flex;}}';

  var brandHtml =
    '<div class="fos-brand"><img src="logo.png" alt="Fusion Partners"><span>FusionOS</span></div>';

  function itemHtml(t) {
    var active = t.href === CURRENT ? ' active' : '';
    return '<a class="fos-item' + active + '" href="' + t.href + '">'
      + '<span class="fos-dot"></span>' + t.label + '</a>';
  }
  function futureHtml(f) {
    return '<div class="fos-item future"><span class="fos-dot"></span>' + f.label
      + ' <span class="fos-tag">' + f.tag + '</span></div>';
  }

  var sidebarHtml = '<aside id="fos-shell-sidebar">' + brandHtml
    + '<div class="fos-group-label">Core</div>'
    + TOOLS.filter(function (t) { return t.group === 'core'; }).map(itemHtml).join('')
    + '<div class="fos-group-label">ツール</div>'
    + TOOLS.filter(function (t) { return t.group === 'tool'; }).map(itemHtml).join('')
    + '<div class="fos-group-label">今後（就職後）</div>'
    + FUTURE.map(futureHtml).join('')
    + '</aside>';

  var bnItems = [
    { label: 'ミツメル', href: 'mitsumeru_private.html', ico: '📓' },
    { label: '朝刊', href: 'mitsumeru_private.html', ico: '📰' },
    { label: '奏', href: 'kanade_hub.html', ico: '🧰' },
    { label: '凪', href: 'nagi_hub.html', ico: '🧭' },
    { label: '響', href: 'hibiki_koe.html', ico: '🎙️' },
    { label: '3min', href: 'index.html', ico: '⚡' },
    { label: 'なぜなぜ', href: 'naze_naze.html', ico: '🔍' }
  ];
  var bottomNavHtml = '<nav id="fos-shell-bottomnav" aria-label="FusionOSナビゲーション">'
    + bnItems.map(function (b) {
      var active = b.href === CURRENT ? ' active' : '';
      return '<a class="' + active.trim() + '" href="' + b.href + '">'
        + '<span class="fos-ico">' + b.ico + '</span><span>' + b.label + '</span></a>';
    }).join('')
    + '</nav>';

  var style = document.createElement('style');
  style.id = 'fos-shell-style';
  style.textContent = CSS;
  document.head.appendChild(style);

  document.body.insertAdjacentHTML('afterbegin', sidebarHtml + bottomNavHtml);
})();
