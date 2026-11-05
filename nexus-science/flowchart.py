"""Diagrama de selecao (caixas e setas) a partir de dados simples.

O mesmo desenho serve ao SVG do documento web e ao PDF: `layout()` calcula caixas e setas em unidades fixas e cada saida
as pinta do seu jeito. As etapas vem de `report_insights.selection_flow`: cada uma tem etapa, rotulo, n, notas e, opcionalmente,
uma caixa de saida (os excluidos) ao lado.
"""

from __future__ import annotations

import textwrap
from dataclasses import dataclass, field
from html import escape
from typing import Any

MAIN_W = 250
SIDE_W = 220
GAP = 56
ARROW = 30
PAD = 12
CHAR_W = 6.4  # largura media de um caractere a 11 px, com folga
ROW_H = {"tag": 13, "title": 16, "big": 24, "note": 14}
WIDTH = MAIN_W + GAP + SIDE_W
ACCENT = "#ea580c"


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float
    rows: tuple[tuple[str, str], ...]  # (estilo, texto) ja quebrado em linhas
    accent: bool = False


@dataclass(frozen=True)
class Arrow:
    x1: float
    y1: float
    x2: float
    y2: float


@dataclass
class Layout:
    width: float = WIDTH
    height: float = 0
    boxes: list[Box] = field(default_factory=list)
    arrows: list[Arrow] = field(default_factory=list)


def _rows(stage: str, label: str, n: int, notes: list[str], width: float) -> tuple[tuple[str, str], ...]:
    chars = max(10, int((width - 2 * PAD) / CHAR_W))
    rows: list[tuple[str, str]] = []
    if stage:
        rows.append(("tag", stage.upper()))
    rows += [("title", line) for line in textwrap.wrap(label, chars)]
    rows.append(("big", f"n = {n}"))
    for note in notes:
        rows += [("note", line) for line in textwrap.wrap(note, chars - 2)]
    return tuple(rows)


def _height(rows: tuple[tuple[str, str], ...]) -> float:
    return sum(ROW_H[style] for style, _ in rows) + 2 * PAD


def layout(flow: dict[str, Any]) -> Layout:
    result = Layout()
    y = 0.0
    previous: Box | None = None
    for index, stage in enumerate(flow["stages"]):
        rows = _rows(stage["stage"], stage["label"], stage["n"], stage["notes"], MAIN_W)
        main = Box(0, y, MAIN_W, _height(rows), rows, accent=index == len(flow["stages"]) - 1)
        result.boxes.append(main)
        if previous is not None:
            result.arrows.append(Arrow(MAIN_W / 2, previous.y + previous.h, MAIN_W / 2, main.y))
        out = stage.get("out")
        if out:
            out_rows = _rows("", out["label"], out["n"], out["notes"], SIDE_W)
            side_h = _height(out_rows)
            side = Box(MAIN_W + GAP, y + max(0.0, (main.h - side_h) / 2), SIDE_W, side_h, out_rows)
            result.boxes.append(side)
            middle = side.y + side.h / 2
            result.arrows.append(Arrow(MAIN_W, middle, side.x, middle))
        previous = main
        y = main.y + main.h + ARROW
    result.height = max((box.y + box.h for box in result.boxes), default=0.0)
    return result


# ------------------------------------------------------------------ SVG (documento web)
_STYLE = {
    "tag": ('font-size="9" font-weight="600" fill="#777" letter-spacing=".08em"', 10),
    "title": ('font-size="12" font-weight="600" fill="#111"', 12),
    "big": ('font-size="18" font-weight="700" fill="#111"', 18),
    "note": ('font-size="10.5" fill="#444"', 10),
}


def to_svg(flow: dict[str, Any]) -> str:
    lay = layout(flow)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {lay.width:g} {lay.height + 2:g}" role="img" '
        f'aria-label="{escape(flow["title"], quote=True)}" style="max-width:100%;height:auto;font-family:system-ui,Arial,sans-serif">',
        '<defs><marker id="seta" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">'
        '<path d="M0 0 10 5 0 10z" fill="#666"/></marker></defs>',
    ]
    for arrow in lay.arrows:
        parts.append(f'<line x1="{arrow.x1:g}" y1="{arrow.y1:g}" x2="{arrow.x2:g}" y2="{arrow.y2:g}" stroke="#666" stroke-width="1.5" marker-end="url(#seta)"/>')
    for box in lay.boxes:
        stroke, width = (ACCENT, 2) if box.accent else ("#999", 1)
        parts.append(f'<rect x="{box.x:g}" y="{box.y + 1:g}" width="{box.w:g}" height="{box.h:g}" rx="8" fill="#fff" stroke="{stroke}" stroke-width="{width}"/>')
        y = box.y + 1 + PAD
        for style, text in box.rows:
            attrs, base = _STYLE[style]
            parts.append(f'<text x="{box.x + PAD:g}" y="{y + base:g}" {attrs}>{escape(text)}</text>')
            y += ROW_H[style]
    parts.append("</svg>")
    return "".join(parts)
