"""Render the operator guides from Markdown to docs/guides/*.html in the house style.

The .md files at the repo root are the source of truth; run this after editing them:

    python scripts/render-guides.py

Requires the `markdown` package (present in the system Python here).
"""
from __future__ import annotations

import html
import re
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "guides"

GUIDES = [
    ("DB-WALKTHROUGH.md", "db-walkthrough.html", "FreshNow — Database Walkthrough"),
    ("BACKEND-OPERATIONS.md", "backend-operations.html", "FreshNow — Backend Operations"),
    ("FRESH-RUN.md", "fresh-run.html", "FreshNow — Fresh Run (test guide)"),
    ("CHANNELS-GUIDE.md", "channels-guide.html", "FreshNow — Channels (how people are reached)"),
]

STYLE = """
  :root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--acc:#3fb950;--warn:#d29922;--crit:#f85149;
        --card:#161b22;--bd:#30363d;--blue:#88c0f0}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       max-width:940px;padding:40px 22px 80px;margin-inline:auto}
  h1{font-size:1.9rem;margin:0 0 6px}
  h2{margin-top:2.6rem;color:var(--acc);font-size:1.3rem;border-bottom:1px solid var(--bd);padding-bottom:6px}
  h3{margin-top:1.7rem;font-size:1.04rem}
  p.lead{color:var(--mut);font-size:.92rem}
  blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid var(--warn);background:var(--card);border-radius:0 8px 8px 0}
  blockquote p{margin:4px 0}
  code{background:#1f2630;padding:2px 6px;border-radius:4px;font-size:.9em}
  pre{background:#010409;border:1px solid var(--bd);border-radius:8px;padding:14px;
      overflow-x:auto;font-size:.83rem;line-height:1.5}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;margin:14px 0}
  th,td{border:1px solid var(--bd);padding:8px 10px;text-align:left;font-size:.88rem;vertical-align:top}
  th{background:#1f2630}
  hr{border:0;border-top:1px solid var(--bd);margin:2rem 0}
  a{color:var(--blue)}
  .back{color:var(--mut);font-size:.88rem;margin-bottom:1.2rem;display:block}
"""

TEMPLATE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>{style}</style></head><body>
<a class="back" href="index.html">← All guides</a>
{body}
</body></html>
"""


def render(src: Path) -> str:
    text = src.read_text(encoding="utf-8")
    # Cross-links between the guides: point .md references at the rendered pages.
    for md_name, html_name, _ in GUIDES:
        text = text.replace(f"`{md_name}`", f"[`{md_name}`]({html_name})")
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    # First italic paragraph after the title is the "updated" line — style it as a lead.
    body = re.sub(r"<p><em>(Updated [^<]*)</em></p>", r'<p class="lead"><em>\1</em></p>', body, count=1)
    return body


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for md_name, html_name, title in GUIDES:
        body = render(ROOT / md_name)
        (OUT / html_name).write_text(
            TEMPLATE.format(title=html.escape(title), style=STYLE, body=body), encoding="utf-8"
        )
        print("rendered", html_name)


if __name__ == "__main__":
    main()
