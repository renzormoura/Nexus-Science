"""Rotas: Relatorios de tema."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import FastAPI, Path, Query, Request
from fastapi.responses import Response

import downloads
import report_brasil
from alerts import work_key
from catalog import SearchQuery
from domain import NexusError, NotFoundError
from library_store import ReadingList
from reports import (
    FINDINGS_PER_STUDY,
    Report,
    assess_study,
    criteria_description,
    method_paragraphs,
    new_in_list,
    panorama,
    report_blocks,
    report_insights_for,
)
from routes.context import ApiContext
from routes.payloads import (
    situacao_payload,
    work_card,
)
from routes.schemas import (
    ReportAddIn,
    ReportCreateIn,
    ReportRestoreIn,
    ReportSearchIn,
    ReportUpdateIn,
)


def register_reports_routes(app: FastAPI, ctx: ApiContext) -> None:
    discovery = ctx.discovery
    library = ctx.library
    identity = ctx.identity
    reports = ctx.reports
    require_user = ctx.require_user
    brasil_bases = ctx.brasil_bases
    brasil_meta = ctx.brasil_meta

    # -- relatorios de tema ---------------------------------------------------------
    if reports is not None:
        report_store = reports

        def report_payload(report: Report) -> dict[str, Any]:
            chosen = [item.work for item in report.included]
            items = []
            for item in report.items:
                assessment = assess_study(item.work)
                items.append({
                    "ref": item.work.ref, "included": item.included, "note": item.note, "work": work_card(item.work),
                    "reliability": {"score": assessment.reliability.score, "band": assessment.reliability.band,
                                    "coverage": assessment.reliability.coverage, "warnings": list(assessment.reliability.warnings)},
                    "findings": [{"tags": list(f.tags), "sentence": f.sentence} for f in assessment.findings[:FINDINGS_PER_STUDY]],
                })
            _, executive, comparison, flow = report_insights_for(report)
            return {
                "executive": executive, "comparison": comparison, "flow": flow,
                "id": report.id, "title": report.title, "question": report.question, "methodNote": report.method_note,
                "listName": report.list_name, "createdAt": report.created_at, "updatedAt": report.updated_at, "version": report.version,
                "substances": list(report.substances), "items": items, "panorama": panorama(chosen), "method": [p for p in method_paragraphs(report) if p],
                "criteria": [{"name": n, "weight": w, "how": h} for n, w, h in criteria_description()],
            }

        @app.get("/api/reports")
        def list_reports(request: Request) -> dict[str, Any]:
            return {"reports": [
                {"id": s.id, "title": s.title, "listName": s.list_name, "updatedAt": s.updated_at, "version": s.version,
                 "included": s.included, "total": s.total}
                for s in report_store.summaries(require_user(request))
            ]}

        @app.post("/api/reports")
        def create_report(body: ReportCreateIn, request: Request) -> dict[str, Any]:
            user = require_user(request)
            ctx.check_limit(user, "reports", len(report_store.summaries(user)))
            chosen = next((item for item in library.lists(user) if item.id == body.list_id), None)
            if chosen is None:
                raise NotFoundError("Lista não encontrada.")
            report = report_store.create(
                user, list_name=chosen.name, works=list(chosen.works), title=body.title, question=body.question, source_list_id=chosen.id,
            )
            return report_payload(report)

        @app.get("/api/reports/{report_id}")
        def get_report(report_id: Annotated[str, Path(max_length=64)], request: Request) -> dict[str, Any]:
            return report_payload(report_store.get(require_user(request), report_id))

        @app.put("/api/reports/{report_id}")
        def update_report(report_id: Annotated[str, Path(max_length=64)], body: ReportUpdateIn, request: Request) -> dict[str, Any]:
            report = report_store.update(
                require_user(request), report_id, title=body.title, question=body.question, method_note=body.method_note,
                items=[(item.ref, item.included, item.note) for item in body.items], substances=body.substances,
            )
            return report_payload(report)

        def source_list(user: str, report: Report) -> ReadingList | None:
            return next((item for item in library.lists(user) if item.id == report.source_list_id), None) if report.source_list_id else None

        @app.get("/api/reports/{report_id}/history")
        def report_history(report_id: Annotated[str, Path(max_length=64)], request: Request) -> dict[str, Any]:
            """Versoes, historico de atualizacoes e artigos que entraram na lista de origem depois do relatorio."""
            user = require_user(request)
            report = report_store.get(user, report_id)
            origin = source_list(user, report)
            return {
                "versions": [{"version": v.version, "savedAt": v.saved_at, "summary": v.summary, "current": v.version == report.version}
                             for v in report_store.versions(user, report_id)],
                "log": [{"kind": e.kind, "text": e.text, "createdAt": e.created_at} for e in report.log],
                "listName": origin.name if origin else report.list_name, "listAvailable": origin is not None,
                "newInList": [work_card(w) for w in new_in_list(report, origin.works)] if origin else [],
            }

        @app.post("/api/reports/{report_id}/search")
        def report_search(report_id: Annotated[str, Path(max_length=64)], body: ReportSearchIn, request: Request) -> dict[str, Any]:
            """Procura artigos sobre o tema que ainda nao estao no relatorio; a busca fica registrada no historico."""
            user = require_user(request)
            report = report_store.get(user, report_id)
            year_from = body.year_from or max(1800, int(report.created_at[:4]) - 1)
            query = SearchQuery(q=body.query, year_from=year_from, language=body.language, sort="recent", per_page=20)
            found = discovery.search(query, source=discovery.search_default, client_id=identity(request))
            present = {work_key(item.work) for item in report.items} | {item.work.ref for item in report.items}
            fresh = [w for w in found.works if work_key(w) not in present and w.ref not in present]
            scope = ", ".join(p for p in [f"idioma {body.language}" if body.language else "", f"desde {year_from}"] if p)
            report_store.log_search(user, report_id, f"Busca: “{body.query}” ({scope}; todas as fontes): {len(fresh)} resultados fora do relatório.")
            return {"query": body.query, "yearFrom": year_from, "results": [work_card(w) for w in fresh], "notes": list(found.notes)}

        @app.post("/api/reports/{report_id}/add")
        def report_add(report_id: Annotated[str, Path(max_length=64)], body: ReportAddIn, request: Request) -> dict[str, Any]:
            """Acrescenta estudos ao relatorio: da lista de origem (so os que estao nela) ou de uma busca (metadados vindos da fonte)."""
            user = require_user(request)
            report = report_store.get(user, report_id)
            if body.origin == "lista":
                origin = source_list(user, report)
                if origin is None:
                    raise NotFoundError("A lista de origem não existe mais.")
                wanted = set(body.refs)
                works = [w for w in origin.works if w.ref in wanted]
                label = f"lista “{origin.name}”"
            else:
                works = [discovery.work(ref, client_id=identity(request)) for ref in dict.fromkeys(body.refs)]
                label = f"busca “{body.query}”" if body.query else "busca"
            updated, added = report_store.add_works(user, report_id, works, origin=label)
            return {"added": added, "report": report_payload(updated)}

        @app.post("/api/reports/{report_id}/restore")
        def report_restore(report_id: Annotated[str, Path(max_length=64)], body: ReportRestoreIn, request: Request) -> dict[str, Any]:
            return report_payload(report_store.restore(require_user(request), report_id, body.version))

        @app.get("/api/reports/{report_id}/brasil")
        def report_brasil_data(report_id: Annotated[str, Path(max_length=64)], request: Request) -> dict[str, Any]:
            """Sugestoes de substancias (a confirmar) e a situacao no Brasil das ja confirmadas; carrega depois da tela."""
            user = require_user(request)
            report = report_store.get(user, report_id)
            bases = brasil_bases(request)
            confirmed = []
            for item in report_brasil.situations(report.substances, bases):
                confirmed.append({**situacao_payload(item), "termo": item.termo, "nome": report_brasil.display_name(item)})
            return {
                "suggestions": [
                    {"termo": s.termo, "nome": s.nome, "en": s.en, "metodo": s.metodo, "studies": s.studies}
                    for s in report_brasil.suggest([i.work for i in report.included], bases)
                ],
                "confirmed": confirmed, "meta": brasil_meta(bases),
            }

        @app.delete("/api/reports/{report_id}")
        def delete_report(report_id: Annotated[str, Path(max_length=64)], request: Request) -> dict[str, bool]:
            report_store.delete(require_user(request), report_id)
            return {"ok": True}

        @app.get("/api/reports/{report_id}/download")
        def download_report(
            report_id: Annotated[str, Path(max_length=64)], request: Request,
            format: Annotated[str, Query(max_length=10)] = "html",  # noqa: A002 - nome do parametro HTTP
        ) -> Response:
            if format not in downloads.TEXT_FORMATS:
                raise NexusError("Formato de download inválido.")
            user = require_user(request)
            report = report_store.get(user, report_id)
            section = report_brasil.build(report.substances, brasil_bases(request)) if report.substances else None
            author = ctx.profiles.name(user) if ctx.profiles is not None else ""
            content, media = downloads.render(report_blocks(report, brasil=section, author=author), format, brand="Relatório de tema")
            filename = downloads.analysis_filename(report.title, "relatorio", downloads.TEXT_FORMATS[format][2])
            return Response(content, media_type=media, headers={
                "Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            })
