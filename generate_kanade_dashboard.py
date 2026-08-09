# -*- coding: utf-8 -*-
# FP-0120: 00_代表ダッシュボード.md（読み取り専用データソース）から、
# ミツメルのタブ用HTML（kanade_dashboard.html）を全面生成する。
# 元データは作り直さない（設計書3.1節）。00_代表ダッシュボード.mdは1バイトも書き込まない。
import re
import os
import glob
import json
import html as html_module
from datetime import datetime

DASHBOARD_MD = r"H:\マイドライブ\Obsidian_Vault\🏢 01_代表デスク\01_今日のデスク\00_代表ダッシュボード.md"
ISSUES_DIR = r"H:\マイドライブ\Obsidian_Vault\🏢 01_代表デスク\00_正典\_案件台帳\issues"
OUTPUT_HTML = r"C:\Users\fanta\Claude\mitsumeru\kanade_dashboard.html"
GEN_TIME = None  # set by caller via --stamp or defaults to now (real run passes fixed date実測 string)

STATE_LABELS = {
    "todo": "未着手（todo）", "in_progress": "作業中（in_progress）",
    "in_review": "確認待ち（in_review）", "accepted": "確認済み（accepted）",
    "blocked": "止まっている（blocked）", "done": "完了（done）",
    "cancelled": "取り下げ（cancelled）", "failed": "失敗（failed）",
}
# 設計２確定（2026-08-09 09:55・FP-0131の実害を根拠に）：未完了＝done/cancelled/failed以外。
# acceptedは「検収者が合格させただけ」で「筆頭が報告先へ渡すまでは完了ではない」（FP-0032）。
# 除外すると、FP-0131発覚前にaccepted 55件が42時間出口を失っていた事実が画面に一切出ない。
FINISHED_STATES = {"done", "cancelled", "failed"}
UNFINISHED_STATES = {"todo", "in_progress", "in_review", "blocked", "accepted"}


def last_transition_ts(issue):
    """FP-0044の定義どおり：historyのうちtype付き（note/set_scope_kind/change-assignee等の
    管理操作）を除いた、状態遷移エントリの最後のtsを返す（無ければNone）。"""
    last = None
    for h in issue.get("history", []):
        if h.get("type"):
            continue
        ts = h.get("ts")
        if ts and (last is None or ts > last):
            last = ts
    return last


def hours_since(ts_str, now):
    """now・tsとも tz-aware（+09:00付き）を想定。issues/*.jsonのtsは全てtz付きで書かれている。"""
    try:
        ts = datetime.fromisoformat(ts_str)
    except Exception:
        return None
    return (now - ts).total_seconds() / 3600.0


def load_issues():
    """設計２指示（2026-08-09・FP-0120差し戻し）：④・④-2はissues/*.jsonを直接読む。
    00_代表ダッシュボード.mdの写し（07:09時点／昨夜19:42時点）は古くなるため使わない。
    設計２指摘（09:53・将来壊れる箇所）：*.jsonのうちFP-で始まらないものは黙って落とさず、
    件数を数えて呼び出し元へ返す（母数が黙って減るのを防ぐ）。"""
    all_json = glob.glob(os.path.join(ISSUES_DIR, "*.json"))
    fp_json = [p for p in all_json if os.path.basename(p).startswith("FP-")]
    excluded_count = len(all_json) - len(fp_json)
    records = []
    load_errors = 0
    for path in fp_json:
        try:
            with open(path, "r", encoding="utf-8") as f:
                records.append(json.load(f))
        except Exception:
            load_errors += 1
            continue
    return records, excluded_count, load_errors


def esc(s):
    return html_module.escape(s or "", quote=True)


def read_md():
    with open(DASHBOARD_MD, "r", encoding="utf-8") as f:
        return f.read()


def extract_section(md, start_heading, end_heading_pattern):
    """start_headingで始まり、次に end_heading_pattern にマッチする見出しの手前までを返す。"""
    start_idx = md.index(start_heading)
    rest = md[start_idx + len(start_heading):]
    m = re.search(end_heading_pattern, rest)
    body = rest[: m.start()] if m else rest
    return body.strip()


def md_table_to_rows(body):
    """パイプ区切りのmarkdownテーブルを [[cell,...], ...] へ（ヘッダ行・区切り行を除く）。"""
    rows = []
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        if re.match(r"^\|[\s:-]+\|$", line.replace("---", "-")):
            # 区切り行（|---|---|等）はスキップ
            if set(line.replace("|", "").replace(":", "").strip()) <= {"-", " "}:
                continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows.append(cells)
    return rows


def strip_md_links(text):
    # [表示](url) -> 表示、**強調** -> 強調
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    return text


def build():
    md = read_md()

    sec1 = extract_section(md, "## 🔴 ① あなたが決めること", r"\n## ")
    sec2 = extract_section(md, "## 📅 ② スケジュール", r"\n## ")
    sec3 = extract_section(md, "## 🗞 ③ 朝刊", r"\n## ")
    sec5 = extract_section(md, "## 🎮 ⑤ ミツメル", r"\n## ")

    rows1 = md_table_to_rows(sec1)
    rows2 = md_table_to_rows(sec2)

    # ④・④-2：issues/*.jsonを直接読む（.mdの写しは使わない・設計２差し戻し対応）
    issues, excluded_count, load_errors = load_issues()
    total_issue_count = len(issues)
    state_counts = {}
    for rec in issues:
        st = rec.get("state", "")
        state_counts[st] = state_counts.get(st, 0) + 1
    # 表示順は正典の一般的な並びに揃える
    state_order = ["todo", "in_progress", "in_review", "accepted", "blocked", "done", "cancelled", "failed"]
    rows4 = [["状態", "件数"]]
    for st in state_order:
        if st in state_counts:
            rows4.append([STATE_LABELS.get(st, st), str(state_counts[st])])
    for st, c in state_counts.items():
        if st not in state_order:
            rows4.append([STATE_LABELS.get(st, st), str(c)])

    # scope×kind 4区分（未完了のみ。FP-0135で設計２が固定した数え方）
    unfinished = [r for r in issues if r.get("state") in UNFINISHED_STATES]
    combo_counts = {}
    unclassified = 0
    for rec in unfinished:
        scope, kind = rec.get("scope"), rec.get("kind")
        if not scope or not kind:
            unclassified += 1
            continue
        combo_counts[(scope, kind)] = combo_counts.get((scope, kind), 0) + 1
    combos = [("全体", "イシュー"), ("全体", "デバッグ"), ("個別", "イシュー"), ("個別", "デバッグ")]
    scopekind_rows = [["scope", "kind", "未完了件数"]]
    for scope, kind in combos:
        scopekind_rows.append([scope, kind, f"{combo_counts.get((scope, kind), 0)}件"])
    scopekind_rows.append(["未分類", "—", f"{unclassified}件（scope/kind未設定のレコード）"])
    unfinished_total = len(unfinished)

    # 誰も動かしていないもの（編集長指摘・2026-08-09 09:51）：
    # 「起票されているが、次へ渡されていない」ものを、最後の状態遷移から24時間以上、上位3件で出す。
    now_jst = datetime.now().astimezone()
    stalled = []
    for rec in unfinished:
        ts = last_transition_ts(rec)
        if not ts:
            continue
        hrs = hours_since(ts, now_jst)
        if hrs is not None and hrs >= 24:
            stalled.append((hrs, rec))
    stalled.sort(key=lambda x: -x[0])
    stalled_rows = [["案件（件名）", "何時間止まっているか"]]
    for hrs, rec in stalled[:3]:
        title = rec.get("title") or rec.get("id") or "（件名不明）"
        stalled_rows.append([title, f"{hrs:.1f}時間"])
    stalled_count = len(stalled)

    # 朝刊：見出し（H1タイトル）＋日付＋区分見出し一覧を、リンク先ファイルから軽く抽出する。
    news_link_m = re.search(r"\[今日の朝刊\]\(<([^>]+)>\)", sec3)
    news_headlines = []
    news_title = None
    news_kind = "no-data"
    if news_link_m:
        rel_path = news_link_m.group(1)
        import os

        news_path = os.path.join(
            r"H:\マイドライブ\Obsidian_Vault\🏢 01_代表デスク", rel_path
        )
        if os.path.isfile(news_path):
            with open(news_path, "r", encoding="utf-8") as f:
                news_md = f.read()
            t = re.search(r"^# (.+)$", news_md, re.M)
            news_title = t.group(1).strip() if t else None
            news_headlines = re.findall(r"^## (.+)$", news_md, re.M)
            news_kind = "found" if news_headlines else "none-found"
        else:
            news_kind = "no-data"

    generated_at = GEN_TIME or datetime.now().strftime("%Y-%m-%d %H:%M")

    def table_html(rows, header=True):
        if not rows:
            return '<div class="empty-state">データがありません（該当セクションが見つかりませんでした）。</div>'
        out = ['<table class="dash-table">']
        for i, r in enumerate(rows):
            tag = "th" if (header and i == 0) else "td"
            out.append(
                "<tr>" + "".join(f"<{tag}>{esc(strip_md_links(c))}</{tag}>" for c in r) + "</tr>"
            )
        out.append("</table>")
        return "".join(out)

    sec1_html = table_html(rows1) if rows1 else '<div class="empty-state">現在、あなたが決めることはありません（該当なし）。</div>'
    sec2_html = table_html(rows2)

    if news_kind == "no-data":
        sec3_html = '<div class="empty-state">データがありません（朝刊ファイルが見つかりません）。</div>'
    elif news_kind == "none-found":
        sec3_html = f'<div class="n">{esc(news_title or "")}</div><div class="base-note">該当なし（見出しが0件でした）</div>'
    else:
        items = "".join(f"<li>{esc(h)}</li>" for h in news_headlines)
        sec3_html = f'<div class="n">{esc(news_title or "")}</div><ul class="news-list">{items}</ul>'

    sec4_html = table_html(rows4)
    exclude_note = ""
    if excluded_count:
        exclude_note += f"（対象外：FPで始まらないファイル {excluded_count}件・数えていません）"
    if load_errors:
        exclude_note += f"（読み込みエラー {load_errors}件・数えていません）"
    def4 = f"1件＝issues/*.json のレコード1つ。対象＝全{total_issue_count}件{exclude_note}。実測 {generated_at}"
    stalled_html = table_html(stalled_rows) if len(stalled_rows) > 1 else '<div class="empty-state">該当なし（24時間以上動いていないものは0件でした）。</div>'
    scopekind_html = table_html(scopekind_rows)
    scopekind_def = (
        "未完了＝state が todo/in_progress/in_review/blocked/accepted のいずれか（accepted を含む。"
        "done/cancelled/failed のみ含めない）。accepted は検収者が合格させただけで、筆頭が報告先へ"
        "渡すまでは完了ではないため（FP-0032・FP-0131の実害を根拠に設計２確定）。"
        "scope＝全体/個別、kind＝イシュー/デバッグ（柴山さん2026-08-08 19:34指定・軸の定義はFP-0135で設計２が固定）。"
        f"未分類＝scope/kindが設定されていない未完了レコード。未完了総数 {unfinished_total}件。実測 {generated_at}"
    )
    # ⑤ミツメルはテーブルではなくテキスト（HP/MP/LV行＋補足）。空行を除いた各行をそのまま出す。
    sec5_lines = [strip_md_links(l).strip("`") for l in sec5.splitlines() if l.strip() and l.strip() != "```"]
    if sec5_lines:
        sec5_html = "".join(f'<div class="base-note">{esc(l)}</div>' for l in sec5_lines)
    else:
        sec5_html = '<div class="empty-state">データがありません（該当セクションが見つかりませんでした）。</div>'

    html_out = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>代表ダッシュボード（BI） | Fusion Partners</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>">
<style>
:root {{
  --bg:#0f1923; --surface:#1a2634; --card:#223044;
  --accent:#4fc3f7; --accent2:#81c784; --accent3:#ffb74d;
  --text:#e8eaf0; --sub:#8fa3b8; --border:#2e4460; --radius:12px;
}}
*{{box-sizing:border-box;margin:0;padding:0;}}
body{{background:var(--bg);color:var(--text);font-family:'Hiragino Kaku Gothic Pro','Meiryo',sans-serif;min-height:100vh;}}
header{{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 20px;}}
header h1{{font-size:0.95rem;font-weight:700;color:var(--accent);}}
header p{{font-size:0.72rem;color:var(--sub);margin-top:2px;}}
main{{max-width:720px;margin:0 auto;padding:20px 16px 80px;}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:14px;overflow-x:auto;}}
.card h2{{font-size:0.85rem;color:var(--accent);margin-bottom:8px;}}
.dash-table{{width:100%;border-collapse:collapse;font-size:0.78rem;}}
.dash-table th,.dash-table td{{border:1px solid var(--border);padding:6px 8px;text-align:left;vertical-align:top;}}
.dash-table th{{background:var(--surface);color:var(--accent);}}
.empty-state{{font-size:0.8rem;color:var(--sub);padding:8px 0;}}
.base-note{{font-size:0.72rem;color:var(--sub);margin-top:6px;}}
.n{{font-size:1.0rem;font-weight:700;}}
.news-list{{margin-top:6px;padding-left:18px;font-size:0.78rem;}}
.news-list li{{margin-bottom:4px;}}
.note{{font-size:0.72rem;color:var(--sub);margin-top:8px;line-height:1.6;}}
.gen-time{{font-size:0.72rem;color:var(--accent3);margin-top:2px;}}
</style>
</head>
<body>
<header>
  <h1>代表ダッシュボード（BI）</h1>
  <p class="gen-time">この画面は generate_kanade_dashboard.py を実行した時点のものです。最終生成：{esc(generated_at)}（自動更新はまだ設定していません。開くたびには更新されません）</p>
</header>
<main>
  <div class="card">
    <h2>🔴 ① あなたが決めること</h2>
    {sec1_html}
  </div>
  <div class="card">
    <h2>📅 ② スケジュール</h2>
    {sec2_html}
  </div>
  <div class="card">
    <h2>🗞 ③ 朝刊</h2>
    {sec3_html}
  </div>
  <div class="card">
    <h2>📊 ④ 案件進捗（{esc(generated_at)}時点）</h2>
    {sec4_html}
    <div class="base-note">{esc(def4)}</div>
  </div>
  <div class="card">
    <h2>⏸ 誰も動かしていないもの（最後の状態遷移から24時間以上・上位3件）</h2>
    {stalled_html}
    <div class="base-note">対象 {stalled_count}件（母数：未完了{unfinished_total}件のうち24時間以上）。「最後の状態遷移」＝history中のnote/set_scope_kind等（type付きの管理操作）を除いた、state変更エントリの最新ts（FP-0044の定義）。実測 {esc(generated_at)}</div>
  </div>
  <div class="card">
    <h2>📊 ④-2 案件進捗（4区分・scope×kind）</h2>
    {scopekind_html}
    <div class="base-note">{esc(scopekind_def)}</div>
  </div>
  <div class="card">
    <h2>🎮 ⑤ ミツメル</h2>
    {sec5_html}
  </div>
  <div class="note">
    <p>この画面は、台帳に起票されたものだけを映します。起票されていない仕事は、ここには出ません。</p>
    <p>「誰かが読んだか」は測っていません。出しているのは「最後に状態が動いてから何時間経ったか」だけです。</p>
    <p>このページは00_代表ダッシュボード.md（H:\\マイドライブ\\Obsidian_Vault\\🏢 01_代表デスク\\01_今日のデスク\\）とissues/*.json（H:\\...\\00_正典\\_案件台帳\\issues\\）を読み取り専用で参照し、生成しています。このページ自体からVault・台帳への書き込みは一切行いません。手で書く欄はありません。</p>
  </div>
</main>
</body>
</html>
"""
    with open(OUTPUT_HTML, "w", encoding="utf-8") as f:
        f.write(html_out)
    return OUTPUT_HTML


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--stamp":
        GEN_TIME = sys.argv[2]
    path = build()
    print("generated:", path)
