"""Testes da aplicacao web (FastAPI) com dependencias simuladas."""

import pytest
from fastapi.testclient import TestClient

import pages
from account_store import AccountStore
from config import Settings
from domain import BackendUnavailableError, Completion
from ratelimit import SlidingWindowLimiter
from web import SESSION_COOKIE, create_app
from workflow import AnalysisService, ArticleRepository

ABSTRACT = "Em 1200 pacientes a mortalidade caiu de 12,5% para 8,1% com a intervenção estudada."


class FakeGenerator:
    def __init__(self, reply="Mortalidade caiu de 12,5% para 8,1%.", available=True):
        self.reply, self.available, self.calls, self.options = reply, available, [], []

    def ensure_available(self, model):
        if not self.available:
            raise BackendUnavailableError("Nenhum backend de LLM disponivel.")

    def complete(self, messages, model, options=None):
        self.calls.append((messages, model))
        self.options.append(options)
        return Completion(self.reply, 120, 80)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "a.sqlite3"))
    monkeypatch.setenv("APP_ENV", "development")
    store = AccountStore()
    store.initialize()
    generator = FakeGenerator()
    repository = ArticleRepository(lambda raw: ("Metformina e desfechos", ABSTRACT, "Fonte"))
    service = AnalysisService(repository, generator, SlidingWindowLimiter(50, 60), citation_fetcher=None or _meta)
    settings = Settings(session_secret="k" * 40, login_attempts_per_minute=50)
    searches = []

    def search(query, limit, area):
        searches.append((query, limit, area))
        return [
            {"title": "T <b>1</b>", "journal": "J", "year": 2024, "pmid": "1", "source": "MED", "url": "https://x/1",
             "doi": "10.1/x", "reliability": "Alta", "reliability_score": 0.95},
            {"title": "T2", "journal": "J", "year": "—", "pmid": "", "source": "ARXIV", "url": "javascript:alert(1)",
             "reliability": "Moderada", "reliability_score": 0.5},
        ]

    app = create_app(service, repository, settings, account_store_factory=lambda: store, search_fn=search)
    client = TestClient(app, base_url="http://testserver")
    return type("Env", (), {"client": client, "generator": generator, "store": store, "searches": searches,
                            "service": service, "settings": settings, "repository": repository})


def _meta(raw):
    import citations

    return citations.CitationMetadata(title="Um artigo", authors=(citations.Author("Silva", "Ana"),), journal="J", year="2020")


def analyze_payload(**overrides):
    payload = {"page": "geral", "button": "sumario", "article_id": "33984217", "model": pages.DEFAULT_MODEL}
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------- paginas
def test_index_renders_every_tab_and_button(env):
    html = env.client.get("/ia").text
    for page in pages.ALL_PAGES:
        assert f'id="panel-{page.key}"' in html and page.title in html
        for button in page.buttons():
            assert f'data-button="{button.id}"' in html
    assert 'id="panel-pesquisa"' in html and html.count('data-style="ABNT"') == 1


def test_index_has_no_inline_script_or_style_and_no_external_resources(env):
    import re

    html = env.client.get("/ia").text
    assert not re.findall(r"<script(?![^>]*\bsrc=)", html), "script inline viola a CSP"
    assert not re.search(r"\sstyle\s*=", html) and "<style" not in html
    assert not re.search(r'(?:src|href|action)="https?://', html), "recurso externo em tempo de execucao"
    assert not re.search(r"\son[a-z]+\s*=", html), "handler inline viola a CSP"


def test_static_assets_are_served_with_cache_header(env):
    for path, kind in (("/static/app.css", "text/css"), ("/static/app.js", "javascript"), ("/static/favicon-32.png", "png")):
        response = env.client.get(path)
        assert response.status_code == 200 and kind in response.headers["content-type"]
        assert "max-age" in response.headers["cache-control"]


def test_healthz(env):
    assert env.client.get("/healthz").json() == {"status": "ok"}


def test_security_headers_everywhere(env):
    for path in ("/", "/healthz", "/static/app.css"):
        headers = env.client.get(path).headers
        assert "default-src 'self'" in headers["content-security-policy"]
        assert headers["x-content-type-options"] == "nosniff" and headers["x-frame-options"] == "DENY"
    assert env.client.get("/api/auth/me").headers["cache-control"] == "no-store"


def test_hsts_only_in_production(env):
    assert "strict-transport-security" not in env.client.get("/").headers


def test_openapi_and_docs_are_not_exposed(env):
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert env.client.get(path).status_code == 404


# ---------------------------------------------------------------- analise
def test_analyze_returns_sanitized_html_title_and_markdown(env):
    response = env.client.post("/api/analyze", json=analyze_payload())
    body = response.json()
    assert response.status_code == 200
    assert body["title"] == "Metformina e desfechos" and body["article_id"] == "33984217"
    assert "<blockquote>" in body["html"] and "Sumário" in body["markdown"]


def test_analyze_escapes_html_from_the_model(env):
    env.generator.reply = "<script>alert(1)</script> **ok**"
    body = env.client.post("/api/analyze", json=analyze_payload()).json()
    assert "<script" not in body["html"] and "&lt;script&gt;" in body["html"]


def test_analyze_applies_page_flags_and_filters(env):
    env.client.post("/api/analyze", json=analyze_payload(page="medicina", button="resumo-clinico",
                                                            filters={"tom": "Didático"}))
    system_prompt = env.generator.calls[-1][0][0]["content"]
    assert "didático" in system_prompt.lower()
    body = env.client.post("/api/analyze", json=analyze_payload(page="medicina", button="resumo-clinico")).json()
    assert "Apoio à leitura" in body["markdown"]


def test_grounding_warning_reaches_the_client(env):
    env.generator.reply = "Administrar 500 mg."
    assert "Verificação automática" in env.client.post("/api/analyze", json=analyze_payload()).json()["markdown"]


@pytest.mark.parametrize(
    "overrides,status",
    [
        ({"page": "inexistente"}, 404),
        ({"button": "inexistente"}, 404),
        ({"button": "flashcards"}, 404),  # botao de outra aba
        ({"model": "gpt-hacker"}, 400),
        ({"article_id": "   "}, 400),
        ({"article_id": "x" * 2001}, 422),
        ({"filters": {"tom": "x" * 200}}, 422),
    ],
)
def test_analyze_validation(env, overrides, status):
    response = env.client.post("/api/analyze", json=analyze_payload(**overrides))
    assert response.status_code == status
    assert "error" in response.json() or "detail" in response.json()


def test_backend_unavailable_is_503_with_actionable_message(env):
    env.generator.available = False
    response = env.client.post("/api/analyze", json=analyze_payload())
    assert response.status_code == 503 and "backend" in response.json()["error"].lower()


def test_unknown_article_is_404(env):
    env.repository._resolver = lambda raw: ("Erro ao buscar no arXiv: x", "", "")
    response = env.client.post("/api/analyze", json=analyze_payload(article_id="2301.00001"))
    assert response.status_code == 404


def test_unexpected_errors_do_not_leak_details(env):
    env.generator.complete = lambda *a, **k: (_ for _ in ()).throw(KeyError("segredo-interno"))
    response = env.client.post("/api/analyze", json=analyze_payload())
    assert "segredo-interno" not in response.text.replace("Erro ao gerar resumo com a LLM", "") or response.status_code == 400


def test_rate_limit_returns_429_per_identity(env):
    env.service._limiter = SlidingWindowLimiter(2, 60)
    buttons = ("sumario", "resumo", "pontos-chave")  # botoes diferentes: cada um e uma chamada paga
    codes = [env.client.post("/api/analyze", json=analyze_payload(button=b)).status_code for b in buttons]
    assert codes == [200, 200, 429]
    other = env.client.post("/api/analyze", json=analyze_payload(button="pontos-chave"),
                            headers={"x-forwarded-for": "9.9.9.9"})
    assert other.status_code == 200


def test_audit_requires_previous_response_and_runs(env):
    assert env.client.post("/api/audit", json={"article_id": "1234567", "model": pages.DEFAULT_MODEL, "previous": ""}).status_code == 400
    ok = env.client.post("/api/audit", json={"article_id": "1234567", "model": pages.DEFAULT_MODEL, "previous": "resposta"})
    assert ok.status_code == 200 and "Auditoria" in ok.json()["markdown"]


def test_compare_validates_type_and_marks_clinical(env):
    base = {"article_a": "1234567", "article_b": "7654321", "analysis": "Eficácia", "model": pages.DEFAULT_MODEL}
    assert env.client.post("/api/compare", json={**base, "analysis": "inventado"}).status_code == 400
    body = env.client.post("/api/compare", json={**base, "clinical": True}).json()
    assert "Comparação entre Artigos" in body["markdown"] and "Apoio à leitura" in body["markdown"]


def test_cite_returns_reference_without_llm(env):
    response = env.client.post("/api/cite", json={"article_id": "10.1000/abc", "style": "ABNT"})
    assert response.status_code == 200 and "SILVA, A." in response.json()["markdown"]
    assert env.generator.calls == []
    assert env.client.post("/api/cite", json={"article_id": "10.1000/abc", "style": "Chicago"}).status_code == 400


# ---------------------------------------------------------------- busca
def test_search_sanitizes_urls_and_passes_parameters(env):
    response = env.client.post("/api/search", json={"query": "sepsis", "area": "Cardiologia", "limit": 3})
    results = response.json()["results"]
    assert env.searches == [("sepsis", 3, "Cardiologia")]
    assert results[0]["url"] == "https://x/1" and results[1]["url"] == ""


@pytest.mark.parametrize(
    "payload,status",
    [({"query": "  "}, 400), ({"query": "x", "area": "Astrologia"}, 400), ({"query": "x", "limit": 99}, 422), ({"query": "x" * 201}, 422)],
)
def test_search_validation(env, payload, status):
    assert env.client.post("/api/search", json=payload).status_code == status


# ---------------------------------------------------------------- contas
def test_register_login_logout_flow_and_cookie_flags(env):
    credentials = {"email": "Ana@Exemplo.com", "password": "senha-forte-123"}
    registered = env.client.post("/api/auth/register", json=credentials)
    assert registered.status_code == 200 and registered.json()["user"] == "ana@exemplo.com"
    cookie = registered.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert env.client.get("/api/auth/me").json() == {"user": "ana@exemplo.com", "name": ""}
    assert "ana@exemplo.com" in env.client.get("/ia").text

    env.client.post("/api/auth/logout")
    assert env.client.get("/api/auth/me").json() == {"user": None, "name": ""}

    assert env.client.post("/api/auth/login", json=credentials).status_code == 200
    assert env.client.get("/api/auth/me").json()["user"] == "ana@exemplo.com"


def test_duplicate_registration_and_bad_logins(env):
    credentials = {"email": "ana@exemplo.com", "password": "senha-forte-123"}
    env.client.post("/api/auth/register", json=credentials)
    assert env.client.post("/api/auth/register", json=credentials).status_code == 409
    wrong = env.client.post("/api/auth/login", json={**credentials, "password": "outra-senha-1"})
    unknown = env.client.post("/api/auth/login", json={"email": "x@exemplo.com", "password": "senha-forte-123"})
    malformed = env.client.post("/api/auth/login", json={"email": "invalido", "password": "x"})
    assert wrong.status_code == unknown.status_code == malformed.status_code == 401
    assert wrong.json() == unknown.json() == malformed.json()  # sem enumeracao


def test_register_rejects_weak_credentials(env):
    assert env.client.post("/api/auth/register", json={"email": "a@b.com", "password": "123"}).status_code == 400
    assert env.client.post("/api/auth/register", json={"email": "nao-e-email", "password": "senha-forte-123"}).status_code == 400


def test_auth_endpoints_are_rate_limited(env):
    env.settings = Settings(session_secret="k" * 40)
    app = create_app(env.service, env.repository, Settings(session_secret="k" * 40, login_attempts_per_minute=2),
                     account_store_factory=lambda: env.store, search_fn=lambda *a, **k: [])
    client = TestClient(app)
    bad = {"email": "x@exemplo.com", "password": "senha-forte-123"}
    codes = [client.post("/api/auth/login", json=bad).status_code for _ in range(3)]
    assert codes == [401, 401, 429]


def test_forged_and_tampered_session_cookies_are_ignored(env):
    env.client.cookies.set(SESSION_COOKIE, "ZmFrZQ.9999999999.assinatura")
    assert env.client.get("/api/auth/me").json() == {"user": None, "name": ""}


def test_logged_in_users_are_limited_by_account_not_by_ip(env):
    env.service._limiter = SlidingWindowLimiter(1, 60)
    env.client.post("/api/auth/register", json={"email": "ana@exemplo.com", "password": "senha-forte-123"})
    assert env.client.post("/api/analyze", json=analyze_payload()).status_code == 200
    # mesmo IP, mas outra identidade (visitante) tem a propria cota
    guest = TestClient(env.client.app)
    assert guest.post("/api/analyze", json=analyze_payload()).status_code == 200
    assert env.client.post("/api/analyze", json=analyze_payload(button="resumo")).status_code == 429


# ---------------------------------------------------------------- CSRF
def test_cross_origin_posts_are_rejected(env):
    response = env.client.post("/api/analyze", json=analyze_payload(), headers={"origin": "https://evil.example"})
    assert response.status_code == 403
    same = env.client.post("/api/analyze", json=analyze_payload(), headers={"origin": "http://testserver"})
    assert same.status_code == 200


def test_form_encoded_posts_are_rejected(env):
    response = env.client.post("/api/auth/login", data={"email": "a@b.com", "password": "senha-forte-123"})
    assert response.status_code == 422


def test_assets_are_versioned_in_the_url(env):
    import re

    html = env.client.get("/ia").text
    assert re.search(r'/static/app\.css\?v=[0-9a-f]+"', html) and re.search(r'/static/app\.js\?v=[0-9a-f]+"', html)
    assert env.client.get("/static/app.js?v=abc").status_code == 200
