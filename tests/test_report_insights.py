"""Resumo executivo, tabela comparativa, diagrama de selecao e os formatos de exportacao do relatorio (PDF, Word, web)."""

import io
import json
import zipfile
from datetime import date
from xml.etree.ElementTree import fromstring

import pytest
from pypdf import PdfReader

import downloads
import flowchart
import pdf_export
import report_insights
from catalog import Work
from citations import Author
from db import Database
from reports import ReportStore, report_blocks, report_insights_for

EMAIL = "ana@exemplo.com"
ABSTRACT = (
    "Background: Hypertension is common. Methods: We randomized 240 patients to exercise or control. "
    "Results: Systolic pressure fell by 8.2 mmHg (95% CI 5.1 to 11.3; p < 0.001). Conclusions: Exercise helps."
)


def make_work(ref, **overrides):
    base = {
        "ref": ref, "title": f"Estudo {ref} sobre exercício", "authors": (Author("Silva", "Ana"), Author("Souza", "Bia")), "journal": "Revista X",
        "year": 2020 + int(ref) % 4, "abstract": ABSTRACT, "study_types": ("Ensaio clínico randomizado",), "language": "pt",
        "source": "Europe PMC", "open_access": int(ref) % 2 == 0,
    }
    base.update(overrides)
    return Work(**base)


@pytest.fixture
def store(tmp_path):
    result = ReportStore(Database(database_url="", sqlite_path=str(tmp_path / "r.sqlite3")))
    result.initialize()
    return result


@pytest.fixture
def report(store):
    works = [make_work("1"), make_work("2"), make_work("3"), make_work("4", abstract="", source="PubMed", title="Sem resumo α"),
             make_work("5", retracted=True), make_work("6")]
    created = store.create(EMAIL, list_name="Hipertensão", works=works, question="Exercício reduz a pressão?")
    return store.update(EMAIL, created.id, title="", question=created.question, method_note="", items=[("6", False, "fora do escopo")])


# ------------------------------------------------------------------ resumo executivo
def test_executive_summary_counts_and_never_concludes(report):
    assessments, executive, _, _ = report_insights_for(report)
    numbers = {n["label"]: n["value"] for n in executive["numbers"]}
    assert numbers["Estudos incluídos"] == "5 de 6" and numbers["Com acesso aberto"] == "2" and numbers["Período publicado"] == "2020–2023"
    assert executive["types"][0] == ("Ensaio clínico randomizado", 5)
    assert sum(r["count"] for r in executive["reliability"]) == len(assessments) == 5
    assert any("retratado" in alert for alert in executive["alerts"]) and any("sem resumo" in alert for alert in executive["alerts"])
    assert "não conclui" in executive["note"].lower()


def test_top_studies_skip_retracted_and_low_coverage_ones(report):
    _, executive, _, _ = report_insights_for(report)
    titles = [t["title"] for t in executive["top"]]
    assert titles and len(titles) <= report_insights.TOP_STUDIES
    assert "Sem resumo α" not in titles and "Estudo 5 sobre exercício" not in titles  # sem resumo e retratado nao entram
    assert all(t["score"] is not None for t in executive["top"])


def test_summary_without_scored_studies_is_still_valid(store):
    created = store.create(EMAIL, list_name="Vazia de resumo", works=[make_work("1", abstract="")])
    _, executive, comparison, flow = report_insights_for(created)
    assert executive["top"] == [] and {n["label"]: n["value"] for n in executive["numbers"]}["Nota mediana"] == "—"
    assert comparison["rows"][0][-1] == "Nenhum dado estatístico no resumo"
    assert flow["stages"][2]["n"] == 1


# ------------------------------------------------------------------ tabela e diagrama
def test_comparison_table_has_one_row_per_included_study(report):
    _, _, comparison, _ = report_insights_for(report)
    assert len(comparison["head"]) == 7 and len(comparison["rows"]) == 5
    first = comparison["rows"][0]
    assert first[0] == "1" and first[1].startswith("Silva et al. (2021).") and first[2] == "Ensaio clínico randomizado" and first[5] == "Não"
    assert "/100" in first[4] and "mmHg" in first[6] and all(len(row) == 7 for row in comparison["rows"])


def test_selection_flow_reports_only_what_the_report_records(report):
    _, _, _, flow = report_insights_for(report)
    identification, screening, inclusion = flow["stages"]
    assert identification["n"] == 6 and "Europe PMC: 5" in identification["notes"] and "PubMed: 1" in identification["notes"]
    assert screening["out"]["n"] == 1 and "1 com justificativa do autor" in screening["out"]["notes"][0]
    assert inclusion["n"] == 5 and "PRISMA" in flow["title"] and "não é guardada" in flow["note"]


def test_flow_notes_additions_and_searches(store, report):
    store.add_works(EMAIL, report.id, [make_work("9", title="Novo")], origin="busca")
    store.log_search(EMAIL, report.id, "Busca: “x”")
    _, _, _, flow = report_insights_for(store.get(EMAIL, report.id))
    notes = flow["stages"][0]["notes"]
    assert any("1 estudo adicionado" in n for n in notes) and any("1 busca registrada" in n for n in notes)


# ------------------------------------------------------------------ desenho
def test_flowchart_layout_and_svg_escape_text():
    flow = {"title": 'Diagrama "x"', "note": "", "stages": [
        {"stage": "A", "label": "<script>alert(1)</script>", "n": 3, "notes": ["nota " * 20], "out": {"label": "Fora", "n": 1, "notes": []}},
        {"stage": "B", "label": "Fim", "n": 2, "notes": [], "out": None}]}
    lay = flowchart.layout(flow)
    assert len(lay.boxes) == 3 and len(lay.arrows) == 2 and lay.height > 0
    assert all(box.x + box.w <= lay.width for box in lay.boxes)
    svg = flowchart.to_svg(flow)
    assert "<script>" not in svg and "&lt;script&gt;" in svg and svg.startswith("<svg") and "&quot;" in svg


# ------------------------------------------------------------------ formatos
def test_text_and_markdown_and_html_render_tables_and_flows(report):
    blocks = report_blocks(report, date(2026, 11, 5), author="Renzo")
    txt, md, html = downloads.to_txt(blocks), downloads.to_md(blocks), downloads.to_html(blocks, "Relatório de tema")
    assert "RESUMO EXECUTIVO" in txt and "Preparado por Renzo" in txt and "Identificação: Estudos reunidos pelo autor, n = 6" in txt
    assert "| # | Estudo |" in md and "| --- |" in md and "- Triagem: Estudos avaliados pelo autor, n = 6" in md
    assert "<table>" in html and "<svg" in html and 'class="brand"' in html and "Nexus Science" in html


def test_markdown_table_escapes_pipes():
    block = downloads.table_block(["A|B"], [["x|y"]])
    assert "A\\|B" in downloads.to_md([block]) and "x\\|y" in downloads.to_md([block])


def test_docx_with_brand_has_valid_header_footer_tables_and_flow(report):
    data, mime = downloads.render(report_blocks(report, date(2026, 11, 5)), "docx", brand="Relatório de tema")
    assert "wordprocessingml" in mime
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = set(archive.namelist())
        assert {"word/header1.xml", "word/footer1.xml", "word/_rels/document.xml.rels"} <= names
        assert "word/media/icone.png" in names and archive.read("word/media/icone.png").startswith(bytes([137]) + b"PNG")
        for name in names - {"word/media/icone.png"}:
            fromstring(archive.read(name))  # todo XML bem formado
        document = archive.read("word/document.xml").decode("utf-8")
        assert document.count("<w:tbl>") >= 4 and "headerReference" in document and "n = 6" in document
        assert "Nexus Science" in archive.read("word/header1.xml").decode("utf-8") and "PAGE" in archive.read("word/footer1.xml").decode("utf-8")


def test_docx_without_brand_keeps_the_minimal_package():
    data, _ = downloads.render([("title", "T"), ("p", "texto")], "docx")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert set(archive.namelist()) == {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}


def test_pdf_is_valid_branded_and_carries_the_report_text(report):
    content, mime = downloads.render(report_blocks(report, date(2026, 11, 5), author="Renzo"), "pdf", brand="Relatório de tema")
    assert mime == "application/pdf" and content.startswith(b"%PDF")
    reader = PdfReader(io.BytesIO(content))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert len(reader.pages) >= 2 and reader.metadata.author == "Nexus Science"
    for expected in ("Nexus Science", "Relatório de tema", "Resumo executivo", "Tabela comparativa", "Diagrama de seleção", "n = 6", "Página 1"):
        assert expected in text


def test_pdf_handles_characters_outside_the_standard_fonts_and_markup():
    content = pdf_export.to_pdf([("title", "Título <b>& α ≥ 5"), ("p", "x < y & 日本語 \x00"), ("li", "item"), ("quote", "citação")])
    assert content.startswith(b"%PDF")
    assert pdf_export.plain("p ≥ 0,05 α") == "p >= 0,05 ?" or "p >= 0,05" in pdf_export.plain("p ≥ 0,05 α")


def test_pdf_of_an_empty_document_and_a_wide_table():
    assert pdf_export.to_pdf([("title", "Vazio")]).startswith(b"%PDF")
    wide = downloads.table_block([f"c{i}" for i in range(9)], [["texto longo " * 10] * 9 for _ in range(60)])
    assert len(PdfReader(io.BytesIO(pdf_export.to_pdf([("title", "T"), wide]))).pages) > 1  # a tabela quebra em paginas


def test_table_and_flow_blocks_round_trip_as_json():
    kind, text = downloads.table_block(["a"], [["b"]])
    assert kind == "table" and json.loads(text) == {"head": ["a"], "rows": [["b"]]}
