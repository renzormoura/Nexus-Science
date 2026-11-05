"""Resumo executivo, tabela comparativa e diagrama de selecao do relatorio de tema.

Tudo e calculado por codigo a partir do que o relatorio ja guarda (os registros dos estudos, a escolha do autor e a nota de
confiabilidade). Nada e gerado por IA e nada conclui ou recomenda: sao contagens, o que o registro diz e o que o autor decidiu.
Os resultados sao dicionarios simples (JSON) que a tela, o PDF, o Word e o HTML desenham cada um do seu jeito.
"""

from __future__ import annotations

import statistics
from collections import Counter
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from catalog import Work
    from extraction import Finding
    from reports import Report, StudyAssessment

BAND_ORDER = ("Alta", "Moderada", "Baixa", "Indeterminada", "Retratado")
TOP_STUDIES = 3
MIN_COVERAGE = 80  # so entra no "maior nota" quem teve ao menos 80% dos criterios verificados
TOP_TYPES = 4
MAX_TITLE_CELL = 110
MAX_FINDING_CELL = 170
SUMMARY_NOTE = (
    "Este resumo é montado automaticamente a partir dos registros dos estudos e das suas escolhas: são contagens e dados do "
    "registro, sem interpretação. Ele não conclui nem recomenda conduta."
)
FLOW_NOTE = (
    "Diagrama adaptado do PRISMA 2020: ele mostra apenas o que o relatório registra. A busca que originou a lista de leitura "
    "não é guardada; por isso não há contagem de registros duplicados ou removidos antes da lista."
)


def _short(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def _first_author(work: Work) -> str:
    if not work.authors:
        return "Autoria não informada"
    first = work.authors[0].family or work.authors[0].given
    return f"{first} et al." if len(work.authors) > 1 else first


RESULT_TAGS = ("medida de efeito", "intervalo de confiança", "valor de p")


def _main_finding(findings: tuple[Finding, ...]) -> Finding | None:
    """A frase do resumo que mais se parece com um resultado (efeito, intervalo, valor de p); sem ela, a primeira."""
    return next((f for f in findings if any(tag in RESULT_TAGS for tag in f.tags)), findings[0] if findings else None)


def _score_text(score: int | None, band: str) -> str:
    return f"{score}/100 ({band})" if score is not None and band != "Retratado" else band


def executive_summary(report: Report, assessments: list[StudyAssessment]) -> dict[str, Any]:
    """Uma pagina: numeros, distribuicao da nota, tipos de estudo, os de maior nota e os avisos. `assessments` segue `report.included`."""
    chosen = report.included
    works = [item.work for item in chosen]
    total, included = len(report.items), len(chosen)
    bands = Counter(a.reliability.band for a in assessments)
    scores = [a.reliability.score for a in assessments
              if a.reliability.score is not None and a.reliability.band != "Retratado" and a.reliability.coverage >= MIN_COVERAGE]
    years = [w.year for w in works if w.year]
    types: Counter[str] = Counter()
    for work in works:
        types.update(work.study_types or ("Tipo de estudo não informado",))
    numbers = [
        {"label": "Estudos incluídos", "value": f"{included} de {total}"},
        {"label": "Com acesso aberto", "value": str(sum(1 for w in works if w.open_access))},
        {"label": "Período publicado", "value": (f"{min(years)}–{max(years)}" if min(years) != max(years) else str(min(years))) if years else "—"},
        {"label": "Nota mediana", "value": f"{round(statistics.median(scores))}/100" if scores else "—"},
    ]
    ranked = sorted(
        ((a.reliability.score, w.year or 0, i) for i, (w, a) in enumerate(zip(works, assessments, strict=True))
         if a.reliability.score is not None and a.reliability.band != "Retratado" and a.reliability.coverage >= MIN_COVERAGE),
        key=lambda t: (-t[0], -t[1], t[2]),
    )
    top = [
        {"ref": works[i].ref, "title": _short(works[i].title, MAX_TITLE_CELL), "year": works[i].year, "journal": works[i].journal,
         "score": assessments[i].reliability.score, "band": assessments[i].reliability.band}
        for _, _, i in ranked[:TOP_STUDIES]
    ]
    alerts: list[str] = []
    retracted = sum(1 for w in works if w.retracted)
    if retracted:
        alerts.append(f"{_plural(retracted, 'estudo retratado', 'estudos retratados')} entre os incluídos: confira antes de citar.")
    low_coverage = sum(1 for a in assessments if a.reliability.score is not None and a.reliability.coverage < MIN_COVERAGE)
    if low_coverage:
        alerts.append(f"{_plural(low_coverage, 'estudo', 'estudos')} com nota calculada com menos de 80% dos critérios verificáveis.")
    no_abstract = sum(1 for w in works if not w.abstract)
    if no_abstract:
        alerts.append(f"{_plural(no_abstract, 'estudo', 'estudos')} sem resumo no registro (sem nota nem dados estatísticos).")
    if included and bands.get("Alta", 0) == 0 and scores:
        alerts.append("Nenhum dos estudos incluídos alcançou confiabilidade alta (75 pontos ou mais).")
    return {
        "question": report.question,
        "numbers": numbers,
        "reliability": [{"band": band, "count": bands[band]} for band in BAND_ORDER if bands.get(band)],
        "types": sorted(types.items(), key=lambda pair: (-pair[1], pair[0]))[:TOP_TYPES],
        "top": top,
        "alerts": alerts,
        "note": SUMMARY_NOTE,
    }


def comparison_table(report: Report, assessments: list[StudyAssessment]) -> dict[str, Any]:
    """Uma linha por estudo incluido, com o essencial para comparar lado a lado."""
    head = ["#", "Estudo", "Tipo de estudo", "Periódico", "Confiabilidade", "Acesso aberto", "Principal dado do resumo"]
    rows: list[list[str]] = []
    for number, (item, assessment) in enumerate(zip(report.included, assessments, strict=True), 1):
        work = item.work
        finding = _main_finding(assessment.findings)
        rows.append([
            str(number),
            f"{_first_author(work)} ({work.year or 's.d.'}). {_short(work.title, MAX_TITLE_CELL)}",
            ", ".join(work.study_types) or "Não informado",
            work.journal or "—",
            _score_text(assessment.reliability.score, assessment.reliability.band),
            "Sim" if work.open_access else "Não",
            _short(finding.sentence, MAX_FINDING_CELL) if finding else "Nenhum dado estatístico no resumo",
        ])
    return {"head": head, "rows": rows}


def selection_flow(report: Report, assessments: list[StudyAssessment]) -> dict[str, Any]:
    """Etapas de selecao (identificacao, triagem, inclusao) so com o que o relatorio registra; cada etapa pode ter uma caixa de saida."""
    total, included = len(report.items), len(report.included)
    excluded_items = [item for item in report.items if not item.included]
    sources = Counter(item.work.source or "Fonte não informada" for item in report.items)
    ranked_sources = sorted(sources.items(), key=lambda pair: (-pair[1], pair[0]))
    notes = [f"{name}: {n}" for name, n in ranked_sources[:4]]
    if len(ranked_sources) > 4:
        notes.append(f"outras fontes: {sum(n for _, n in ranked_sources[4:])}")
    added = sum(1 for entry in report.log if entry.kind == "adicao")
    searches = sum(1 for entry in report.log if entry.kind == "busca")
    if added:
        notes.append(f"{_plural(added, 'estudo adicionado', 'estudos adicionados')} depois da criação")
    if searches:
        notes.append(f"{_plural(searches, 'busca registrada', 'buscas registradas')} depois da criação")
    out_notes: list[str] = []
    with_reason = sum(1 for item in excluded_items if item.note)
    if excluded_items:
        out_notes.append(f"{_plural(with_reason, 'com justificativa', 'com justificativa')} do autor" if with_reason else "sem justificativa registrada")
        retracted = sum(1 for item in excluded_items if item.work.retracted)
        if retracted:
            out_notes.append(f"{_plural(retracted, 'retratado', 'retratados')}")
    scored = sum(1 for a in assessments if a.reliability.score is not None)
    unscored = len(assessments) - scored
    in_notes = [f"{scored} com nota de confiabilidade calculada"]
    if unscored:
        in_notes.append(f"{unscored} sem nota (registro sem dados suficientes)")
    return {
        "title": "Diagrama de seleção dos estudos (adaptado do PRISMA 2020)",
        "stages": [
            {"stage": "Identificação", "label": "Estudos reunidos pelo autor", "n": total, "notes": notes, "out": None},
            {"stage": "Triagem", "label": "Estudos avaliados pelo autor", "n": total,
             "notes": [], "out": {"label": "Excluídos pelo autor", "n": len(excluded_items), "notes": out_notes}},
            {"stage": "Inclusão", "label": "Estudos incluídos no relatório", "n": included, "notes": in_notes, "out": None},
        ],
        "note": FLOW_NOTE,
    }


# ------------------------------------------------------------------ texto para os documentos (blocos)
def summary_lines(summary: dict[str, Any]) -> list[tuple[str, str]]:
    """Resumo executivo em blocos simples (tipo, texto) para TXT, Markdown, HTML, DOCX e PDF."""
    blocks: list[tuple[str, str]] = []
    blocks.append(("p", " · ".join(f"{n['label']}: {n['value']}" for n in summary["numbers"])))
    if summary["reliability"]:
        blocks.append(("li", "Confiabilidade dos incluídos: " + "; ".join(f"{r['band']} ({r['count']})" for r in summary["reliability"])))
    if summary["types"]:
        blocks.append(("li", "Tipos de estudo mais frequentes: " + "; ".join(f"{name} ({n})" for name, n in summary["types"])))
    if summary["top"]:
        blocks.append(("h3", "Estudos com maior nota de confiabilidade"))
        blocks += [("li", f"{t['title']} ({t['year'] or 's.d.'}): {t['score']}/100 ({t['band']})") for t in summary["top"]]
    if summary["alerts"]:
        blocks.append(("h3", "Pontos de atenção"))
        blocks += [("li", alert) for alert in summary["alerts"]]
    blocks.append(("meta", summary["note"]))
    return blocks
