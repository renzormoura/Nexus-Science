"""Laboratorio ligado ao navegador: analises salvas por artigo, exportacao e cartao do artigo."""

import io
import zipfile
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import downloads
from catalog import Work
from citations import Author
from config import Settings
from db import Database
from discovery import DiscoveryService
from domain import LimitReachedError, NotFoundError
from library_store import MAX_ANALYSES, MAX_ANALYSIS_CHARS, LibraryStore
from ratelimit import SlidingWindowLimiter
from web import create_app
from workflow import AnalysisService, ArticleRepository

MARKDOWN = """## Resumo clínico

**Contexto:** a [diretriz](https://example.org/x) recomenda `dose` fixa.

- Primeiro ponto com **negrito**
- Segundo ponto

> Aviso: não substitui julgamento clínico.

---

Texto final em duas
linhas contínuas.
"""


def make_work(ref="1", **kw):
    base = {"ref": ref, "title": 'Estudo <b>"A"</b> & B', "authors": (Author("Weber", "Anika"),), "journal": "Rev", "year": 2023,
            "abstract": "Background: x. Methods: y. Results: RR 0.9 (95% CI 0.8-1.0).", "source": "Europe PMC", "doi": "10.0000/a"}
    base.update(kw)
    return Work(**base)


# ------------------------------------------------------------------ markdown -> blocos
def test_markdown_blocks_cover_headings_lists_quotes_and_strip_inline_markup():
    blocks = downloads.markdown_to_blocks(MARKDOWN)
    assert ("h2", "Resumo clínico") in blocks
    assert ("p", "Contexto: a diretriz recomenda dose fixa.") in blocks  # negrito, crase e link viram texto
    assert [b for b in blocks if b[0] == "li"] == [("li", "Primeiro ponto com negrito"), ("li", "Segundo ponto")]
    assert ("quote", "Aviso: não substitui julgamento clínico.") in blocks
    assert blocks[-1] == ("p", "Texto final em duas linhas contínuas.")
    assert not any("http" in text or "**" in text for _, text in blocks)


def test_analysis_document_has_title_article_and_ai_warning_in_every_format():
    blocks = downloads.analysis_blocks("Meu artigo", "Resumo Clínico", MARKDOWN)
    assert blocks[0] == ("title", "Resumo Clínico") and blocks[1] == ("meta", "Artigo: Meu artigo")
    for fmt in downloads.TEXT_FORMATS:
        content, _ = downloads.render(blocks, fmt)
        if fmt == "docx":
            assert content[:2] == b"PK" and zipfile.ZipFile(io.BytesIO(content)).testzip() is None
        elif fmt == "pdf":
            assert content.startswith(b"%PDF")
        else:
            text = content.decode("utf-8")
            assert "resumo clínico" in text.lower() and "confira sempre com o artigo original" in text
    assert downloads.analysis_filename("Título Ñ/../x", "Resumo Clínico", "md") == "resumo-clinico-titulo-n-x.md"
    assert downloads.analysis_filename("", "", "md") == "analise.md"


# ------------------------------------------------------------------ armazenamento
@pytest.fixture
def store(tmp_path):
    library = LibraryStore(Database(database_url="", sqlite_path=str(tmp_path / "a.sqlite3")))
    library.initialize()
    return library


def test_store_saves_lists_gets_and_deletes_analyses_per_user(store):
    work = make_work()
    saved = store.save_analysis("ana@x.com", work, "medicina", "Resumo Clínico", "  Conteúdo  ")
    store.save_analysis("ana@x.com", make_work("2"), "geral", "", "Outro")
    store.save_analysis("bia@x.com", work, "geral", "Da Bia", "Privado")
    assert saved.markdown == "Conteúdo" and saved.ref == "1" and saved.label == "Resumo Clínico"
    assert [a.markdown for a in store.analyses("ana@x.com", "1")] == ["Conteúdo"]
    assert {a.label for a in store.analyses("ana@x.com")} == {"Resumo Clínico", "Análise"}  # rotulo vazio vira "Análise"
    assert store.get_analysis("ana@x.com", saved.id).title.startswith("Estudo")
    with pytest.raises(NotFoundError):
        store.get_analysis("bia@x.com", saved.id)  # cada conta so ve as suas
    with pytest.raises(NotFoundError):
        store.delete_analysis("bia@x.com", saved.id)
    store.delete_analysis("ana@x.com", saved.id)
    assert [a.markdown for a in store.analyses("ana@x.com")] == ["Outro"]


def test_store_limits_size_emptiness_and_count(store, monkeypatch):
    work = make_work()
    with pytest.raises(NotFoundError):
        store.save_analysis("a@x.com", work, "geral", "x", "   ")
    with pytest.raises(LimitReachedError, match="grande demais"):
        store.save_analysis("a@x.com", work, "geral", "x", "y" * (MAX_ANALYSIS_CHARS + 1))
    monkeypatch.setattr("library_store.MAX_ANALYSES", 2)
    store.save_analysis("a@x.com", work, "geral", "1", "um")
    store.save_analysis("a@x.com", work, "geral", "2", "dois")
    with pytest.raises(LimitReachedError, match="limite"):
        store.save_analysis("a@x.com", work, "geral", "3", "tres")
    store.save_analysis("b@x.com", work, "geral", "1", "outra conta nao conta")
    assert MAX_ANALYSES == 200


# ------------------------------------------------------------------ rotas
class Catalog:
    id, name = "europepmc", "Europe PMC (x)"

    def __init__(self, works):
        self._works = {w.ref: w for w in works}

    def study_types(self):
        return ()

    def search(self, query):
        raise AssertionError("nao deve buscar")

    def get(self, ref):
        return self._works.get(ref)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "a.sqlite3"))
    library = LibraryStore(Database(database_url="", sqlite_path=str(tmp_path / "a.sqlite3")))
    library.initialize()
    discovery = DiscoveryService([Catalog([make_work(), make_work("2", title="Segundo")])], SlidingWindowLimiter(100, 60), fallback=None)
    repository = ArticleRepository(lambda raw: ("T", "Resumo suficiente para o teste.", "s"))
    service = AnalysisService(repository, MagicMock(), SlidingWindowLimiter(50, 60))
    app = create_app(service, repository, Settings(session_secret="k" * 40), search_fn=lambda *a, **k: [], discovery=discovery, library=library)
    return TestClient(app, base_url="http://testserver")


_EMAILS = iter(range(10_000))


def login(client, email=None):
    email = email or f"ana{next(_EMAILS)}@exemplo.com"  # o cadastro de contas e compartilhado entre os testes do processo
    response = client.post("/api/auth/register", json={"email": email, "password": "senha-de-teste-local-7"})
    assert response.status_code == 200, response.text


def test_brief_returns_the_article_card_with_reliability(client):
    data = client.get("/api/discover/brief", params={"ref": "1"}).json()
    assert data["work"]["ref"] == "1" and data["work"]["title"].startswith("Estudo") and data["work"]["authors"] == "Anika Weber"
    assert set(data["reliability"]) == {"score", "band", "coverage"}
    assert client.get("/api/discover/brief", params={"ref": "999"}).status_code == 404
    assert client.get("/api/discover/brief", params={"ref": ""}).status_code == 422


def test_save_list_view_download_and_delete_analysis_flow(client):
    body = {"article_id": "1", "page": "medicina", "label": "Resumo Clínico", "markdown": MARKDOWN}
    assert client.post("/api/analyses", json=body).status_code == 401  # precisa de conta
    login(client)
    saved = client.post("/api/analyses", json=body)
    assert saved.status_code == 200 and saved.json()["ref"] == "1" and saved.json()["label"] == "Resumo Clínico"
    analysis_id = saved.json()["id"]
    assert [a["id"] for a in client.get("/api/analyses", params={"ref": "1"}).json()["analyses"]] == [analysis_id]
    assert client.get("/api/analyses", params={"ref": "2"}).json()["analyses"] == []
    full = client.get(f"/api/analyses/{analysis_id}").json()
    assert full["markdown"] == MARKDOWN.strip() and "<h" in full["html"] and "<script" not in full["html"].lower()
    for fmt in ("docx", "md", "html", "txt", "pdf"):
        response = client.get(f"/api/analyses/{analysis_id}/download", params={"format": fmt})
        assert response.status_code == 200 and response.headers["content-disposition"].startswith('attachment; filename="resumo-clinico')
        assert response.headers["x-content-type-options"] == "nosniff"
    assert client.get(f"/api/analyses/{analysis_id}/download", params={"format": "rtf"}).status_code == 400
    assert client.delete(f"/api/analyses/{analysis_id}").status_code == 200
    assert client.get(f"/api/analyses/{analysis_id}").status_code == 404 and client.delete(f"/api/analyses/{analysis_id}").status_code == 404


def test_analyses_are_private_and_validated(client):
    login(client)
    analysis_id = client.post("/api/analyses", json={"article_id": "1", "page": "geral", "label": "x", "markdown": "texto"}).json()["id"]
    login(client)
    assert client.get(f"/api/analyses/{analysis_id}").status_code == 404
    assert client.get("/api/analyses").json()["analyses"] == []
    assert client.post("/api/analyses", json={"article_id": "1", "markdown": ""}).status_code == 422
    assert client.post("/api/analyses", json={"article_id": "999", "markdown": "x"}).status_code == 404
    assert client.post("/api/analyses", json={"article_id": "1", "markdown": "x" * (MAX_ANALYSIS_CHARS + 2000)}).status_code == 422


def test_stateless_export_needs_no_account_and_escapes_html(client):
    body = {"title": "Meu <script>artigo</script>", "label": "Análise", "markdown": "## T\n\n<img src=x onerror=alert(1)> texto", "format": "html"}
    response = client.post("/api/export/analysis", json=body)
    assert response.status_code == 200 and "<script>" not in response.text and "<img" not in response.text
    assert "&lt;img" in response.text and response.headers["content-disposition"].startswith("attachment")
    assert client.post("/api/export/analysis", json={**body, "format": "rtf"}).status_code == 400
    assert client.post("/api/export/analysis", json={**body, "markdown": ""}).status_code == 422
    docx = client.post("/api/export/analysis", json={**body, "format": "docx"})
    assert docx.content[:2] == b"PK"
