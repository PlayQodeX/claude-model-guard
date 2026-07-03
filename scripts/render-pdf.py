#!/usr/bin/env python
"""claude-model-guard — lightweight md -> pdf renderer.

Uses fpdf2 (pure Python, no headless browser) so it is safe to run unattended
from a hook or the daily scheduler without any risk of hanging. Core
Helvetica/Courier fonts are latin-1 only, so emoji and fancy punctuation are
down-converted to ASCII tags; the .md keeps the originals.

Requires: pip install fpdf2
Usage:    python render-pdf.py <input.md> <output.pdf>
"""
import sys, re
try:
    from fpdf import FPDF
except ImportError:
    sys.stderr.write("fpdf2 not installed (pip install fpdf2); PDF skipped.\n")
    sys.exit(1)

MD, PDF = sys.argv[1], sys.argv[2]

REPS = {
    "🔁": "[FABLE<->OPUS] ", "🛑": "[BLOCK] ", "🔀": "[SWITCH] ",
    "↔": "<->", "→": "->", "…": "...", "—": "-", "–": "-",
    "“": '"', "”": '"', "‘": "'", "’": "'", "•": "-", " ": " ",
}
def clean(s: str) -> str:
    for k, v in REPS.items():
        s = s.replace(k, v)
    s = s.replace("**", "").replace("`", "")
    return s.encode("latin-1", "replace").decode("latin-1")

pdf = FPDF(format="A4")
pdf.set_auto_page_break(True, margin=15)
pdf.set_margins(15, 15, 15)
pdf.add_page()
W = pdf.w - 30

for raw in open(MD, encoding="utf-8").read().splitlines():
    line = clean(raw.rstrip())
    if not line.strip():
        pdf.ln(2); continue
    if line.startswith("# "):
        pdf.set_font("Helvetica", "B", 16); pdf.multi_cell(W, 8, line[2:]); pdf.ln(1)
    elif line.startswith("## "):
        pdf.ln(2); pdf.set_font("Helvetica", "B", 13); pdf.multi_cell(W, 7, line[3:])
    elif line.startswith("|"):
        pdf.set_font("Courier", "", 9); pdf.multi_cell(W, 5, line)
    elif re.match(r"^\s*-\s", line):
        indent = (len(line) - len(line.lstrip())) // 2
        off = 3 * indent
        pdf.set_font("Helvetica", "", 10)
        pdf.set_x(15 + off)
        pdf.multi_cell(W - off, 5, line.strip())
    else:
        pdf.set_font("Helvetica", "", 10); pdf.multi_cell(W, 5, line)

pdf.output(PDF)
print("PDF OK", PDF)
