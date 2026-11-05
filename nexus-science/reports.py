"""Relatorio de tema: uma entrega pronta a partir de uma lista de leitura, sem IA.

O relatorio *congela* os estudos da lista no momento da criacao (como retrato dos metadados), o autor escolhe quais
entram, escreve uma nota por estudo e uma nota livre no metodo. Tudo o mais e calculado por codigo a partir do registro:
nota de confiabilidade com o detalhe, frases estatisticas copiadas do resumo, panorama (tipo de estudo, ano, idioma,
acesso aberto), referencias e o apendice de metodo. O documento nao conclui nem recomenda: nada foi inventado.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date
from functools import lru_cache

import citations
import reliability
import report_insights
from brasil.nomes import normalizar
from catalog import Work
from db import Database, Transaction
from discovery import citation_metadata
from domain import LimitReachedError, NotFoundError
from downloads import Block, flow_block, table_block
from extraction import Finding, extract_findings, split_sections
from report_brasil import BrasilSection
from timeutil import utcnow_iso as _now

MAX_REPORTS = 30
MAX_ITEMS = 200
MAX_TITLE_CHARS = 200
MAX_QUESTION_CHARS = 2000
MAX_ITEM_NOTE_CHARS = 1000
MAX_METHOD_NOTE_CHARS = 3000
MAX_ABSTRACT_CHARS = 4000
MAX_VERSIONS = 50
MAX_LOG = 200
MAX_LOG_TEXT = 400
MAX_SUBSTANCES = 10
MAX_SUBSTANCE_CHARS = 80
FINDINGS_PER_STUDY = 3
REFERENCE_STYLES = ("ABNT", "APA", "Vancouver")
NO_TYPE = "Tipo de estudo não informado"
NO_LANGUAGE = "Idioma não informado"
LIMITS_NOTE = (
    "A nota de confiabilidade é calculada por código somente com o título, o resumo e os metadados do registro. "
    "Ela indica sinais verificáveis no registro e não substitui a leitura crítica do artigo."
)

_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL,
        method_note TEXT NOT NULL, list_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_reports_owner ON reports (owner_email, updated_at)",
    """CREATE TABLE IF NOT EXISTS report_items (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, ref TEXT NOT NULL, data TEXT NOT NULL,
        position INTEGER NOT NULL, included INTEGER NOT NULL, note TEXT NOT NULL, PRIMARY KEY (report_id, ref))""",
    """CREATE TABLE IF NOT EXISTS report_substances (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, term TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (report_id, term))""",
    """CREATE TABLE IF NOT EXISTS report_versions (
        report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, version INTEGER NOT NULL, saved_at TEXT NOT NULL,
        summary TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (report_id, version))""",
    """CREATE TABLE IF NOT EXISTS report_sources (
        report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE, list_id TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS report_log (
        id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, kind TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_report_log ON report_log (report_id, created_at)",
)


@dataclass(frozen=True)
class ReportItem:
    work: Work
    included: bool
    note: str


@dataclass(frozen=True)
class LogEntry:
    kind: str  # "busca" ou "adicao"
    text: str
    created_at: str


@dataclass(frozen=True)
class VersionInfo:
    version: int
    saved_at: str
    summary: str


@dataclass(frozen=True)
class Report:
    id: str
    title: str
    question: str
    method_note: str
    list_name: str
    created_at: str
    updated_at: str
    version: int
    items: tuple[ReportItem, ...]
    substances: tuple[str, ...] = ()  # nomes (normalizados) que o autor confirmou para a secao "Situacao no Brasil"
    log: tuple[LogEntry, ...] = ()  # buscas e adicoes feitas depois da criacao (entram no apendice de metodo)
    source_list_id: str = ""

    @property
    def included(self) -> list[ReportItem]:
        return [item for item in self.items if item.included]


@dataclass(frozen=True)
class ReportSummary:
    id: str
    title: str
    list_name: str
    updated_at: str
    version: int
    included: int
    total: int


@dataclass(frozen=True)
class StudyAssessment:
    reliability: reliability.Reliability
    findings: tuple[Finding, ...]




def _clean(text: str, limit: int) -> str:
    """Quebras de linha e paragrafos ficam; caracteres de controle somem."""
    kept = "".join(ch if ch.isprintable() or ch in "\n\t" else " " for ch in str(text))
    return "\n".join(line.rstrip() for line in kept.strip().splitlines())[:limit]


def _snapshot(work: Work) -> str:
    data = work.to_dict()
    data["abstract"] = str(data["abstract"])[:MAX_ABSTRACT_CHARS]
    return json.dumps(data, ensure_ascii=False)


def _work(raw: str) -> Work:
    try:
        data = json.loads(raw)
    except ValueError:
        data = {}
    return Work.from_dict(data if isinstance(data, dict) else {})


def clean_substances(names: list[str]) -> list[str]:
    """Nomes confirmados: normalizados (sem acento, minusculas), sem repeticao e com tamanho minimo, no maximo MAX_SUBSTANCES."""
    cleaned: list[str] = []
    for name in names:
        term = normalizar(str(name))[:MAX_SUBSTANCE_CHARS]
        if len(term) >= 3 and term not in cleaned:
            cleaned.append(term)
    return cleaned[:MAX_SUBSTANCES]


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def describe_change(previous: dict[str, object] | None, new: dict[str, object]) -> str:
    """Frase curta com o que mudou entre duas versoes (estado editavel: titulo, pergunta, nota, substancias, estudos)."""
    if previous is None:
        return "Versão inicial."
    changes: list[str] = []
    for key, label in (("title", "título alterado"), ("question", "pergunta alterada"), ("method_note", "nota do método alterada")):
        if previous.get(key) != new.get(key):
            changes.append(label)
    old_items = {i["ref"]: i for i in previous.get("items", [])}  # type: ignore[attr-defined]
    new_items = {i["ref"]: i for i in new.get("items", [])}  # type: ignore[attr-defined]
    added = [ref for ref in new_items if ref not in old_items]
    if added:
        changes.append(_plural(len(added), "estudo adicionado", "estudos adicionados"))
    included = sum(1 for r, i in new_items.items() if r in old_items and i["included"] and not old_items[r]["included"])
    excluded = sum(1 for r, i in new_items.items() if r in old_items and not i["included"] and old_items[r]["included"])
    if included:
        changes.append(_plural(included, "estudo incluído", "estudos incluídos"))
    if excluded:
        changes.append(_plural(excluded, "estudo excluído", "estudos excluídos"))
    noted = sum(1 for r, i in new_items.items() if r in old_items and i["note"] != old_items[r]["note"])
    if noted:
        changes.append(f"notas alteradas em {_plural(noted, 'estudo', 'estudos')}")
    if list(previous.get("substances", [])) != list(new.get("substances", [])):  # type: ignore[call-overload]
        changes.append("substâncias do Brasil alteradas")
    return (changes[0].capitalize() + "".join(f"; {c}" for c in changes[1:]) + ".") if changes else "Sem alterações."


class ReportStore:
    def __init__(self, database: Database | None = None) -> None:
        self._db = database or Database()

    def initialize(self) -> None:
        with self._db.transaction() as tx:
            for statement in _SCHEMA:
                tx.execute(statement)

    def _owned(self, tx: Transaction, user: str, report_id: str) -> None:
        if not tx.query("SELECT 1 FROM reports WHERE id = ? AND owner_email = ?", (report_id, user)):
            raise NotFoundError("Relatório não encontrado.")

    def _state(self, tx: Transaction, report_id: str) -> dict[str, object]:
        title, question, method_note = tx.query("SELECT title, question, method_note FROM reports WHERE id = ?", (report_id,))[0]
        items = tx.query("SELECT ref, included, note FROM report_items WHERE report_id = ? ORDER BY position", (report_id,))
        substances = tx.query("SELECT term FROM report_substances WHERE report_id = ? ORDER BY position", (report_id,))
        return {
            "title": title, "question": question, "method_note": method_note, "substances": [t for (t,) in substances],
            "items": [{"ref": ref, "included": bool(included), "note": note} for ref, included, note in items],
        }

    def _record_version(self, tx: Transaction, report_id: str, version: int, summary: str | None = None) -> None:
        state = self._state(tx, report_id)
        if summary is None:
            rows = tx.query("SELECT state FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT 1", (report_id,))
            try:
                previous = json.loads(rows[0][0]) if rows else None
            except ValueError:
                previous = None
            summary = describe_change(previous if isinstance(previous, dict) else None, state)
        tx.execute(
            "INSERT INTO report_versions (report_id, version, saved_at, summary, state) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (report_id, version) DO UPDATE SET saved_at = excluded.saved_at, summary = excluded.summary, state = excluded.state",
            (report_id, version, _now(), summary, json.dumps(state, ensure_ascii=False)),
        )
        tx.execute(
            "DELETE FROM report_versions WHERE report_id = ? AND version NOT IN "
            "(SELECT version FROM report_versions WHERE report_id = ? ORDER BY version DESC LIMIT ?)",
            (report_id, report_id, MAX_VERSIONS),
        )

    def _log(self, tx: Transaction, report_id: str, kind: str, message: str) -> None:
        tx.execute(
            "INSERT INTO report_log (id, report_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)",
            (uuid.uuid4().hex, report_id, kind, _clean(message, MAX_LOG_TEXT).replace("\n", " "), _now()),
        )
        tx.execute(
            "DELETE FROM report_log WHERE report_id = ? AND id NOT IN "
            "(SELECT id FROM report_log WHERE report_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)",
            (report_id, report_id, MAX_LOG),
        )

    def create(
        self, user: str, *, list_name: str, works: list[Work], title: str = "", question: str = "", source_list_id: str = "",
    ) -> Report:
        if not works:
            raise NotFoundError("A lista está vazia: adicione artigos antes de criar o relatório.")
        report_id, now = uuid.uuid4().hex, _now()
        clean_title = _clean(title, MAX_TITLE_CHARS) or f"Relatório: {list_name}"[:MAX_TITLE_CHARS]
        with self._db.transaction() as tx:
            if tx.query("SELECT COUNT(*) FROM reports WHERE owner_email = ?", (user,))[0][0] >= MAX_REPORTS:
                raise LimitReachedError(f"Você chegou ao limite de {MAX_REPORTS} relatórios.")
            tx.execute(
                "INSERT INTO reports (id, owner_email, title, question, method_note, list_name, created_at, updated_at, version) "
                "VALUES (?, ?, ?, ?, '', ?, ?, ?, 1)",
                (report_id, user, clean_title, _clean(question, MAX_QUESTION_CHARS), list_name, now, now),
            )
            for position, work in enumerate(works[:MAX_ITEMS]):
                tx.execute(
                    "INSERT INTO report_items (report_id, ref, data, position, included, note) VALUES (?, ?, ?, ?, 1, '') "
                    "ON CONFLICT (report_id, ref) DO NOTHING",
                    (report_id, work.ref, _snapshot(work), position),
                )
            if source_list_id:
                tx.execute("INSERT INTO report_sources (report_id, list_id) VALUES (?, ?)", (report_id, source_list_id))
            self._record_version(tx, report_id, 1, f"Criado a partir da lista “{list_name}”.")
        return self.get(user, report_id)

    def get(self, user: str, report_id: str) -> Report:
        rows = self._db.query(
            "SELECT id, title, question, method_note, list_name, created_at, updated_at, version FROM reports "
            "WHERE id = ? AND owner_email = ?", (report_id, user),
        )
        if not rows:
            raise NotFoundError("Relatório não encontrado.")
        item_rows = self._db.query(
            "SELECT data, included, note FROM report_items WHERE report_id = ? ORDER BY position", (report_id,)
        )
        items = tuple(ReportItem(_work(data), bool(included), note) for data, included, note in item_rows)
        substances = tuple(
            term for (term,) in self._db.query("SELECT term FROM report_substances WHERE report_id = ? ORDER BY position", (report_id,))
        )
        log = tuple(
            LogEntry(kind, message, created)
            for kind, message, created in self._db.query(
                "SELECT kind, text, created_at FROM report_log WHERE report_id = ? ORDER BY created_at, id", (report_id,)
            )
        )
        source = self._db.query("SELECT list_id FROM report_sources WHERE report_id = ?", (report_id,))
        rid, title, question, method_note, list_name, created, updated, version = rows[0]
        return Report(rid, title, question, method_note, list_name, created, updated, int(version), items, substances, log,
                      str(source[0][0]) if source else "")

    def summaries(self, user: str) -> list[ReportSummary]:
        rows = self._db.query(
            "SELECT r.id, r.title, r.list_name, r.updated_at, r.version, "
            "(SELECT COUNT(*) FROM report_items i WHERE i.report_id = r.id AND i.included = 1), "
            "(SELECT COUNT(*) FROM report_items i WHERE i.report_id = r.id) "
            "FROM reports r WHERE r.owner_email = ? ORDER BY r.updated_at DESC, r.id", (user,),
        )
        return [ReportSummary(*row) for row in rows]

    def update(
        self, user: str, report_id: str, *, title: str, question: str, method_note: str,
        items: list[tuple[str, bool, str]], substances: list[str] | None = None,
    ) -> Report:
        clean_title = _clean(title, MAX_TITLE_CHARS)
        terms = clean_substances(substances) if substances is not None else None
        with self._db.transaction() as tx:
            self._owned(tx, user, report_id)
            current = tx.query("SELECT title FROM reports WHERE id = ?", (report_id,))[0][0]
            before = self._state(tx, report_id)
            tx.execute(
                "UPDATE reports SET title = ?, question = ?, method_note = ? WHERE id = ?",
                (clean_title or current, _clean(question, MAX_QUESTION_CHARS), _clean(method_note, MAX_METHOD_NOTE_CHARS), report_id),
            )
            for ref, included, note in items:
                tx.execute(
                    "UPDATE report_items SET included = ?, note = ? WHERE report_id = ? AND ref = ?",
                    (1 if included else 0, _clean(note, MAX_ITEM_NOTE_CHARS), report_id, ref),
                )
            if terms is not None:
                tx.execute("DELETE FROM report_substances WHERE report_id = ?", (report_id,))
                for position, term in enumerate(terms):
                    tx.execute("INSERT INTO report_substances (report_id, term, position) VALUES (?, ?, ?)", (report_id, term, position))
            if self._state(tx, report_id) != before:  # salvar sem mudar nada nao cria versao (o download tambem salva antes)
                tx.execute("UPDATE reports SET updated_at = ?, version = version + 1 WHERE id = ?", (_now(), report_id))
                self._record_version(tx, report_id, int(tx.query("SELECT version FROM reports WHERE id = ?", (report_id,))[0][0]))
        return self.get(user, report_id)

    def delete(self, user: str, report_id: str) -> None:
        with self._db.transaction() as tx:
            self._owned(tx, user, report_id)
            tx.execute("DELETE FROM report_items WHERE report_id = ?", (report_id,))
            tx.execute("DELETE FROM report_substances WHERE report_id = ?", (report_id,))
            tx.execute("DELETE FROM report_versions WHERE report_id = ?", (report_id,))
            tx.execute("DELETE FROM report_sources WHERE report_id = ?", (report_id,))
            tx.execute("DELETE FROM report_log WHERE report_id = ?", (report_id,))
            tx.execute("DELETE FROM reports WHERE id = ?", (report_id,))

    def watched_works(self, user: str) -> list[tuple[str, Work]]:
        """(onde esta, artigo) para os estudos incluidos nos relatorios da conta."""
        rows = self._db.query(
            "SELECT r.title, i.data FROM reports r JOIN report_items i ON i.report_id = r.id "
            "WHERE r.owner_email = ? AND i.included = 1 ORDER BY r.updated_at DESC, i.position", (user,),
        )
        return [(f"no relatório “{title}”", _work(data)) for title, data in rows]

    def all_watched_refs(self) -> set[str]:
        return {str(row[0]) for row in self._db.query("SELECT DISTINCT ref FROM report_items WHERE included = 1")}

    def substance_terms(self, user: str) -> list[tuple[str, str, str]]:
        """(substancia, id do relatorio, titulo) das substancias confirmadas; cada substancia uma vez, no relatorio mais recente."""
        rows = self._db.query(
            "SELECT s.term, r.id, r.title FROM report_substances s JOIN reports r ON r.id = s.report_id "
            "WHERE r.owner_email = ? ORDER BY r.updated_at DESC, s.position", (user,),
        )
        seen: dict[str, tuple[str, str, str]] = {}
        for term, report_id, title in rows:
            seen.setdefault(str(term), (str(term), str(report_id), str(title)))
        return list(seen.values())

    def sources(self, user: str) -> list[tuple[str, str, str, set[str]]]:
        """(id, titulo, lista de origem, referencias ja no relatorio) dos relatorios que tem lista de origem."""
        rows = self._db.query(
            "SELECT r.id, r.title, s.list_id FROM reports r JOIN report_sources s ON s.report_id = r.id WHERE r.owner_email = ?", (user,)
        )
        if not rows:
            return []
        marks = ", ".join("?" for _ in rows)
        present: dict[str, set[str]] = {}
        for report_id, ref in self._db.query(f"SELECT report_id, ref FROM report_items WHERE report_id IN ({marks})", tuple(r[0] for r in rows)):  # noqa: S608 - so marcadores
            present.setdefault(str(report_id), set()).add(str(ref))
        return [(str(rid), str(title), str(list_id), present.get(str(rid), set())) for rid, title, list_id in rows]

    def delete_user_data(self, user: str) -> None:
        for summary in self.summaries(user):
            self.delete(user, summary.id)

    # ------------------------------------------------------------------ atualizacao e versoes
    def add_works(self, user: str, report_id: str, works: list[Work], *, origin: str) -> tuple[Report, int]:
        """Acrescenta estudos (incluidos) que ainda nao estao no relatorio; devolve o relatorio e quantos entraram."""
        added = 0
        with self._db.transaction() as tx:
            self._owned(tx, user, report_id)
            present = {ref for (ref,) in tx.query("SELECT ref FROM report_items WHERE report_id = ?", (report_id,))}
            position = int(tx.query("SELECT COALESCE(MAX(position), -1) FROM report_items WHERE report_id = ?", (report_id,))[0][0]) + 1
            for work in works:
                if work.ref in present:
                    continue
                if len(present) >= MAX_ITEMS:
                    raise LimitReachedError(f"Este relatório chegou ao limite de {MAX_ITEMS} estudos.")
                tx.execute("INSERT INTO report_items (report_id, ref, data, position, included, note) VALUES (?, ?, ?, ?, 1, '')",
                           (report_id, work.ref, _snapshot(work), position))
                present.add(work.ref)
                position += 1
                added += 1
                self._log(tx, report_id, "adicao", f"Adicionado: {work.title} ({origin}).")
            if added:
                tx.execute("UPDATE reports SET updated_at = ?, version = version + 1 WHERE id = ?", (_now(), report_id))
                self._record_version(tx, report_id, int(tx.query("SELECT version FROM reports WHERE id = ?", (report_id,))[0][0]),
                                     f"{_plural(added, 'estudo adicionado', 'estudos adicionados')} ({origin}).")
        return self.get(user, report_id), added

    def log_search(self, user: str, report_id: str, message: str) -> None:
        with self._db.transaction() as tx:
            self._owned(tx, user, report_id)
            self._log(tx, report_id, "busca", message)

    def versions(self, user: str, report_id: str) -> list[VersionInfo]:
        self.get(user, report_id)
        rows = self._db.query(
            "SELECT version, saved_at, summary FROM report_versions WHERE report_id = ? ORDER BY version DESC", (report_id,)
        )
        return [VersionInfo(int(v), saved, summary) for v, saved, summary in rows]

    def restore(self, user: str, report_id: str, version: int) -> Report:
        """Volta o estado editavel (titulo, pergunta, nota, substancias, inclusao e notas) de uma versao anterior, como nova versao.

        Estudos adicionados depois daquela versao continuam no relatorio, mas ficam excluidos.
        """
        with self._db.transaction() as tx:
            self._owned(tx, user, report_id)
            rows = tx.query("SELECT state FROM report_versions WHERE report_id = ? AND version = ?", (report_id, version))
            if not rows:
                raise NotFoundError("Versão não encontrada.")
            try:
                state = json.loads(rows[0][0])
            except ValueError:
                raise NotFoundError("Versão não encontrada.") from None
            tx.execute(
                "UPDATE reports SET title = ?, question = ?, method_note = ?, updated_at = ?, version = version + 1 WHERE id = ?",
                (state["title"], state["question"], state["method_note"], _now(), report_id),
            )
            saved = {item["ref"]: item for item in state["items"]}
            for (ref,) in tx.query("SELECT ref FROM report_items WHERE report_id = ?", (report_id,)):
                item = saved.get(ref)
                if item is None:  # adicionado depois daquela versao: continua no relatorio, mas excluido
                    tx.execute("UPDATE report_items SET included = 0 WHERE report_id = ? AND ref = ?", (report_id, ref))
                else:
                    tx.execute("UPDATE report_items SET included = ?, note = ? WHERE report_id = ? AND ref = ?",
                               (1 if item["included"] else 0, item["note"], report_id, ref))
            tx.execute("DELETE FROM report_substances WHERE report_id = ?", (report_id,))
            for position, term in enumerate(state["substances"]):
                tx.execute("INSERT INTO report_substances (report_id, term, position) VALUES (?, ?, ?)", (report_id, term, position))
            self._record_version(tx, report_id, int(tx.query("SELECT version FROM reports WHERE id = ?", (report_id,))[0][0]),
                                 f"Restaurada a versão {version}.")
        return self.get(user, report_id)


# ---------------------------------------------------------------------- calculo (puro, sem rede)
def new_in_list(report: Report, list_works: tuple[Work, ...] | list[Work]) -> list[Work]:
    """Artigos que entraram na lista de origem depois da criacao do relatorio (e que ainda nao estao nele)."""
    present = {item.work.ref for item in report.items}
    return [work for work in list_works if work.ref not in present]


def assess_study(work: Work) -> StudyAssessment:
    sections = tuple(split_sections(work.abstract))
    findings = tuple(extract_findings(work.abstract))
    return StudyAssessment(reliability.assess(work, sections, findings), findings)


def _ranked(counter: Counter[str]) -> list[tuple[str, int]]:
    return sorted(counter.items(), key=lambda pair: (-pair[1], pair[0]))


def panorama(works: list[Work]) -> dict[str, object]:
    """Contagens por tipo de estudo, ano, idioma e fonte, e quantos tem acesso aberto ou foram retratados."""
    types: Counter[str] = Counter()
    for work in works:
        if work.study_types:
            types.update(work.study_types)
        else:
            types[NO_TYPE] += 1
    years = Counter(str(w.year) for w in works if w.year)
    languages = Counter((w.language or "").lower() or NO_LANGUAGE for w in works)
    sources = Counter(w.source or "Fonte não informada" for w in works)
    return {
        "total": len(works),
        "types": _ranked(types),
        "years": sorted(years.items(), reverse=True),
        "languages": _ranked(languages),
        "sources": _ranked(sources),
        "openAccess": sum(1 for w in works if w.open_access),
        "retracted": sum(1 for w in works if w.retracted),
        "withoutAbstract": sum(1 for w in works if not w.abstract),
    }


@lru_cache(maxsize=1)
def criteria_description() -> tuple[tuple[str, int, str], ...]:
    """(nome, peso, como e avaliado) dos criterios da nota de confiabilidade."""
    sample = reliability.assess(Work(ref="x", title="x"))
    return tuple((c.name, c.weight, c.how) for c in sample.criteria)


def _br_date(iso: str) -> str:
    try:
        return date.fromisoformat(iso[:10]).strftime("%d/%m/%Y")
    except ValueError:
        return iso[:10]


def method_paragraphs(report: Report, today: date | None = None) -> list[str]:
    """Texto automatico do apendice de metodo: o que foi feito, com contagens e limites, sem adjetivos."""
    today = today or date.today()
    total, included = len(report.items), len(report.included)
    excluded = total - included
    sources = Counter(item.work.source or "fonte não informada" for item in report.items)
    sources_text = ", ".join(f"{name} ({n})" for name, n in sorted(sources.items(), key=lambda pair: (-pair[1], pair[0])))
    created = report.created_at[:10]
    with contextlib.suppress(ValueError):
        created = date.fromisoformat(created).strftime("%d/%m/%Y")
    return [
        f"Os estudos foram reunidos manualmente pelo autor na lista de leitura “{report.list_name}” e congelados neste relatório "
        f"em {created}. " + (
            "As buscas feitas a partir deste relatório estão no histórico de atualizações abaixo; a busca que levou aos estudos "
            "da lista de origem não foi registrada."
            if any(entry.kind == "busca" for entry in report.log)
            else "As buscas usadas para encontrá-los não são registradas nesta versão do relatório."
        ),
        f"Fontes dos registros: {sources_text}." if sources_text else "",
        f"Foram reunidos {total} estudos; {included} foram incluídos e {excluded} excluídos pelo autor, sem critério automático.",
        "Para cada estudo incluído, a nota de confiabilidade (0 a 100) soma os critérios abaixo, cada um com seu peso; "
        "critérios que não puderam ser verificados no registro ficam fora do cálculo e a cobertura é informada.",
        LIMITS_NOTE,
        "Os dados estatísticos são frases copiadas do resumo, escolhidas por palavras-chave. A seleção pode omitir frases e "
        "foi lido apenas o resumo, não o texto completo.",
        f"Relatório na versão {report.version}, gerado em {today:%d/%m/%Y} pelo Nexus Science. "
        "Nenhum texto deste relatório foi gerado por IA.",
    ]


def identity_lines(work: Work) -> list[str]:
    lines = [work.author_line]
    journal = ", ".join(p for p in [work.journal, f"v. {work.volume}" if work.volume else "",
                                    f"n. {work.issue}" if work.issue else "", f"p. {work.pages}" if work.pages else ""] if p)
    lines.append(" · ".join(p for p in [journal, str(work.year or "")] if p))
    ids = [f"DOI: https://doi.org/{work.doi}" if work.doi else "", f"PMID: {work.pmid}" if work.pmid else ""]
    lines.append(" · ".join(i for i in ids if i))
    if work.study_types:
        lines.append("Tipo de estudo: " + ", ".join(work.study_types))
    if work.source:
        lines.append(f"Fonte: {work.source}")
    return [line for line in lines if line]


def reliability_line(result: reliability.Reliability) -> str:
    if result.score is None:
        return f"Confiabilidade: {result.band}. {result.summary}"
    return f"Confiabilidade: {result.score}/100 ({result.band}), cobertura de {result.coverage}% dos critérios."


def report_insights_for(report: Report) -> tuple[list[StudyAssessment], dict[str, object], dict[str, object], dict[str, object]]:
    """Avaliacoes dos incluidos, resumo executivo, tabela comparativa e diagrama de selecao (tudo calculado por codigo)."""
    assessments = [assess_study(item.work) for item in report.included]
    return (assessments, report_insights.executive_summary(report, assessments), report_insights.comparison_table(report, assessments),
            report_insights.selection_flow(report, assessments))


def report_blocks(report: Report, today: date | None = None, brasil: BrasilSection | None = None, author: str = "") -> list[Block]:
    """Documento completo em blocos (vira HTML, DOCX, Markdown, texto ou PDF pelo gerador de downloads)."""
    chosen = report.included
    works = [item.work for item in chosen]
    assessments, executive, comparison, flow = report_insights_for(report)
    blocks: list[Block] = [("title", report.title), ("meta", f"Relatório de tema · versão {report.version} · {len(chosen)} estudos incluídos")]
    if author:
        blocks.append(("meta", f"Preparado por {author}"))
    blocks += [("h1", "Resumo executivo"), *report_insights.summary_lines(executive)]
    if report.question:
        blocks += [("h1", "Pergunta ou tema"), *[("p", line) for line in report.question.splitlines() if line.strip()]]

    summary = panorama(works)
    blocks.append(("h1", "Panorama dos estudos incluídos"))
    blocks.append(("p", f"{summary['total']} estudos; {summary['openAccess']} com acesso aberto; "
                        f"{summary['retracted']} retratados; {summary['withoutAbstract']} sem resumo no registro."))
    for label, key in (("Tipo de estudo", "types"), ("Ano", "years"), ("Idioma", "languages"), ("Fonte", "sources")):
        pairs = summary[key]
        if pairs:
            blocks.append(("li", f"{label}: " + "; ".join(f"{name} ({n})" for name, n in pairs)))  # type: ignore[attr-defined]

    if chosen:
        blocks += [("h1", "Tabela comparativa dos estudos"), table_block(comparison["head"], comparison["rows"])]  # type: ignore[arg-type]
    blocks.append(("h1", "Estudos incluídos"))
    if not chosen:
        blocks.append(("p", "Nenhum estudo foi incluído."))
    for number, (item, assessment) in enumerate(zip(chosen, assessments, strict=True), 1):
        blocks.append(("h2", f"{number}. {item.work.title}"))
        blocks += [("meta", line) for line in identity_lines(item.work)]
        blocks.append(("p", reliability_line(assessment.reliability)))
        blocks += [("meta", warning) for warning in assessment.reliability.warnings]
        blocks += [("quote", f"{' · '.join(f.tags)}: {f.sentence}") for f in assessment.findings[:FINDINGS_PER_STUDY]]
        if item.note:
            blocks.append(("p", f"Nota do autor: {item.note}"))

    if brasil is not None:
        blocks += brasil.blocks

    blocks.append(("h1", "Referências"))
    for style in REFERENCE_STYLES:
        blocks.append(("h2", style))
        blocks += [("li", citations.format_citation(citation_metadata(w), style)) for w in works] or [("p", "Sem estudos incluídos.")]

    blocks.append(("h1", "Apêndice: método"))
    blocks += [("h2", str(flow["title"])), flow_block(flow), ("meta", str(flow["note"]))]
    blocks += [("p", paragraph) for paragraph in method_paragraphs(report, today) if paragraph]
    if brasil is not None:
        blocks.append(("p", brasil.method))
    blocks.append(("h2", "Critérios da nota de confiabilidade"))
    blocks += [("li", f"{name} (peso {weight}): {how}") for name, weight, how in criteria_description()]
    excluded = [item for item in report.items if not item.included]
    if excluded:
        blocks.append(("h2", "Estudos reunidos e excluídos pelo autor"))
        blocks += [("li", f"{item.work.title} ({item.work.year or 's.d.'})" + (f" — {item.note}" if item.note else "")) for item in excluded]
    if report.log:
        blocks.append(("h2", "Histórico de atualizações"))
        blocks += [("li", f"{_br_date(entry.created_at)} — {entry.text}") for entry in report.log]
    if report.method_note:
        blocks += [("h2", "Nota do autor sobre o método"), *[("p", line) for line in report.method_note.splitlines() if line.strip()]]
    return blocks
