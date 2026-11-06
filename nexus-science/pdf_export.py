"""PDF dos documentos (relatorio de tema) a partir da mesma lista de blocos dos outros formatos.

Usa o reportlab com as fontes padrao do PDF (Helvetica), que cobrem o portugues; letras de outros alfabetos (grego, cirilico, CJK) nao
existem nessas fontes e viram "?" no PDF. A marca aparece no cabecalho (quadrado laranja e nome) e no rodape (data e pagina).
"""

from __future__ import annotations

import io
import json
import unicodedata
from datetime import date
from typing import Any
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

import downloads
import flowchart

ACCENT = colors.HexColor("#ea580c")
GRAY = colors.HexColor("#555555")
LIGHT = colors.HexColor("#faf5f0")
MARGIN = 2 * cm
TEXT_WIDTH = A4[0] - 2 * MARGIN
COLUMN_SHARE = {7: (4, 26, 14, 14, 15, 8, 19)}
_REPLACEMENTS = {"≥": ">=", "≤": "<=", "→": "->", "←": "<-", "−": "-", "‑": "-", "≈": "~", " ": " "}


def plain(text: str) -> str:
    """Texto que as fontes padrao do PDF desenham: o que nao cabe no cp1252 vira o equivalente simples ou "?"."""
    out: list[str] = []
    for char in str(text):
        if char in "\n\t" or char.isprintable():
            try:
                char.encode("cp1252")
                out.append(char)
                continue
            except UnicodeEncodeError:
                pass
            out.append(_REPLACEMENTS.get(char) or unicodedata.normalize("NFKD", char).encode("ascii", "ignore").decode() or "?")
        else:
            out.append(" ")
    return "".join(out)


def _markup(text: str) -> str:
    return escape(plain(text)).replace("\n", "<br/>")


def _style(name: str, **kwargs: Any) -> ParagraphStyle:
    base: dict[str, Any] = {"fontName": "Helvetica", "fontSize": 9.5, "leading": 13.5, "textColor": colors.HexColor("#111111"), "spaceAfter": 5}
    base.update(kwargs)
    return ParagraphStyle(name, **base)


STYLES = {
    "title": _style("title", fontName="Helvetica-Bold", fontSize=21, leading=25, spaceAfter=6),
    "meta": _style("meta", fontSize=8.5, leading=11.5, textColor=GRAY, spaceAfter=2),
    "h1": _style("h1", fontName="Helvetica-Bold", fontSize=14, leading=18, spaceBefore=14, spaceAfter=3, keepWithNext=1),
    "h2": _style("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=15, spaceBefore=9, spaceAfter=3, keepWithNext=1),
    "h3": _style("h3", fontName="Helvetica-BoldOblique", fontSize=10, leading=13, spaceBefore=6, spaceAfter=2, keepWithNext=1),
    "p": _style("p"),
    "quote": _style("quote", fontName="Helvetica-Oblique", spaceAfter=0),
    "li": _style("li", leftIndent=14, bulletIndent=4, spaceAfter=3),
    "cell": _style("cell", fontSize=7.5, leading=9.5, spaceAfter=0),
    "cellhead": _style("cellhead", fontName="Helvetica-Bold", fontSize=7.5, leading=9.5, spaceAfter=0, textColor=colors.white),
}


class FlowChart(Flowable):
    """O diagrama de selecao desenhado com caixas e setas, reduzido para caber na largura da pagina."""

    def __init__(self, flow: dict[str, Any], available: float) -> None:
        super().__init__()
        self.layout = flowchart.layout(flow)
        self.scale = min(1.0, available / self.layout.width)
        self.width = self.layout.width * self.scale
        self.height = (self.layout.height + 2) * self.scale

    def wrap(self, avail_width: float, avail_height: float) -> tuple[float, float]:
        return self.width, self.height

    def draw(self) -> None:
        canvas: Canvas = self.canv
        canvas.saveState()
        canvas.translate(0, self.height)  # a origem do PDF e embaixo; o desenho conta de cima para baixo
        canvas.scale(self.scale, self.scale)
        fonts = {"tag": ("Helvetica-Bold", 7, 9, GRAY), "title": ("Helvetica-Bold", 10.5, 11, colors.black),
                 "big": ("Helvetica-Bold", 16, 17, colors.black), "note": ("Helvetica", 8.5, 9.5, colors.HexColor("#444444"))}
        canvas.setLineWidth(1.4)
        canvas.setStrokeColor(GRAY)
        canvas.setFillColor(GRAY)
        for arrow in self.layout.arrows:
            canvas.line(arrow.x1, -arrow.y1, arrow.x2, -arrow.y2)
            self._head(canvas, arrow)
        for box in self.layout.boxes:
            canvas.setStrokeColor(ACCENT if box.accent else colors.HexColor("#999999"))
            canvas.setLineWidth(2 if box.accent else 1)
            canvas.setFillColor(colors.white)
            canvas.roundRect(box.x, -(box.y + 1 + box.h), box.w, box.h, 7, stroke=1, fill=1)
            y = box.y + 1 + flowchart.PAD
            for style, text in box.rows:
                font, size, base, color = fonts[style]
                canvas.setFont(font, size)
                canvas.setFillColor(color)
                canvas.drawString(box.x + flowchart.PAD, -(y + base), plain(text))
                y += flowchart.ROW_H[style]
        canvas.restoreState()

    @staticmethod
    def _head(canvas: Canvas, arrow: flowchart.Arrow) -> None:
        canvas.setFillColor(GRAY)
        path = canvas.beginPath()
        if arrow.y1 == arrow.y2:  # seta para a direita
            path.moveTo(arrow.x2, -arrow.y2)
            path.lineTo(arrow.x2 - 8, -arrow.y2 + 4)
            path.lineTo(arrow.x2 - 8, -arrow.y2 - 4)
        else:  # seta para baixo
            path.moveTo(arrow.x2, -arrow.y2)
            path.lineTo(arrow.x2 - 4, -arrow.y2 + 8)
            path.lineTo(arrow.x2 + 4, -arrow.y2 + 8)
        path.close()
        canvas.drawPath(path, stroke=0, fill=1)


def _table(text: str) -> Table:
    data = json.loads(text)
    head, rows = data["head"], data["rows"]
    share = COLUMN_SHARE.get(len(head), tuple([1] * len(head)))
    widths = [TEXT_WIDTH * s / sum(share) for s in share]
    cells = [[Paragraph(_markup(c), STYLES["cellhead"]) for c in head]] + [[Paragraph(_markup(c), STYLES["cell"]) for c in row] for row in rows]
    table = Table(cells, colWidths=widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), ACCENT), ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    style += [("BACKGROUND", (0, i), (-1, i), LIGHT) for i in range(2, len(cells), 2)]
    table.setStyle(TableStyle(style))
    return table


def _quote(text: str) -> Table:
    box = Table([[Paragraph(_markup(text), STYLES["quote"])]], colWidths=[TEXT_WIDTH])
    box.setStyle(TableStyle([("LINEBEFORE", (0, 0), (0, 0), 2, ACCENT), ("LEFTPADDING", (0, 0), (-1, -1), 8),
                             ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]))
    return box


def _story(blocks: list[tuple[str, str]]) -> list[Flowable]:
    story: list[Flowable] = []
    for kind, text in blocks:
        if kind == "table":
            story += [_table(text), Spacer(1, 8)]
        elif kind == "flow":
            story += [FlowChart(json.loads(text), TEXT_WIDTH), Spacer(1, 8)]
        elif kind == "quote":
            story += [_quote(text), Spacer(1, 4)]
        elif kind == "li":
            story.append(Paragraph(_markup(text), STYLES["li"], bulletText="•"))
        elif kind == "title":
            story += [Paragraph(_markup(text), STYLES["title"]), HRFlowable(width="100%", thickness=2, color=ACCENT, spaceAfter=8)]
        else:
            story.append(Paragraph(_markup(text), STYLES.get(kind, STYLES["p"])))
            if kind == "h1":
                story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#dddddd"), spaceAfter=5))
    return story


def to_pdf(blocks: list[tuple[str, str]], brand: str = "") -> bytes:
    title = next((t for k, t in blocks if k == "title"), "Documento")
    today = date.today().strftime("%d/%m/%Y")

    def decorate(canvas: Canvas, doc: BaseDocTemplate) -> None:
        width, height = A4
        canvas.saveState()
        canvas.drawImage(ImageReader(io.BytesIO(downloads._icon_bytes())), MARGIN, height - 1.5 * cm, 0.6 * cm, 0.6 * cm, mask="auto")
        canvas.setFillColor(colors.black)
        canvas.setFont("Helvetica-Bold", 10)
        canvas.drawString(MARGIN + 0.8 * cm, height - 1.3 * cm, "Nexus Science")
        canvas.setFillColor(GRAY)
        canvas.setFont("Helvetica", 8.5)
        if brand:
            canvas.drawRightString(width - MARGIN, height - 1.3 * cm, plain(brand))
        canvas.setStrokeColor(ACCENT)
        canvas.setLineWidth(1)
        canvas.line(MARGIN, height - 1.65 * cm, width - MARGIN, height - 1.65 * cm)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawString(MARGIN, 1.1 * cm, f"Gerado pelo Nexus Science em {today}")
        canvas.drawRightString(width - MARGIN, 1.1 * cm, f"Página {doc.page}")
        canvas.restoreState()

    buffer = io.BytesIO()
    document = BaseDocTemplate(buffer, pagesize=A4, title=plain(title)[:200], author="Nexus Science", creator="Nexus Science",
                               leftMargin=MARGIN, rightMargin=MARGIN, topMargin=2.3 * cm, bottomMargin=1.9 * cm)
    frame = Frame(MARGIN, 1.9 * cm, TEXT_WIDTH, A4[1] - 2.3 * cm - 1.9 * cm, id="corpo", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    document.addPageTemplates([PageTemplate(id="pagina", frames=[frame], onPage=decorate)])
    document.build(_story(blocks))
    return buffer.getvalue()
