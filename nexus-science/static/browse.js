/* Navegador de artigos — telas e interação.
   Tudo é montado com DOM (textContent), nunca com innerHTML de dados externos; links só http(s). */
(() => {
  "use strict";

  const Lib = window.BrowseLib;
  const $app = document.getElementById("app");
  const THEME_KEY = "nexus.theme"; // compartilhado com a página de IA
  const PAGE_SIZE = 10;
  // ------------------------------------------------------------------ DOM
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, value);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function mount(parent, ...kids) {
    parent.replaceChildren(...kids.flat(Infinity)
      .filter((k) => k !== null && k !== undefined && k !== false)
      .map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
  }
  const loading = (text = "Carregando…") => h("div", { class: "loading" }, h("div", { class: "spinner", "aria-hidden": "true" }), h("span", {}, text));
  // Esqueleto: blocos cinza pulsando no formato do que vai chegar (evita o "pulo" de layout e parece mais rapido que um spinner).
  const skeleton = (kind, count = 4, label = "Carregando…") => h("div", { class: `skeleton skeleton-${kind}`, role: "status", "aria-label": label },
    Array.from({ length: count }, () => kind === "card"
      ? h("div", { class: "sk-card", "aria-hidden": "true" }, h("div", { class: "sk-block sk-cover" }), h("div", { class: "sk-body" },
        h("div", { class: "sk-block sk-line sk-short" }), h("div", { class: "sk-block sk-line" }), h("div", { class: "sk-block sk-line" }), h("div", { class: "sk-block sk-line sk-mid" })))
      : h("div", { class: "sk-row", "aria-hidden": "true" },
        h("div", { class: "sk-block sk-line sk-title" }), h("div", { class: "sk-block sk-line sk-short" }), h("div", { class: "sk-block sk-line" }), h("div", { class: "sk-block sk-line sk-mid" }))));
  // Tela vazia: desenho de linha, titulo, explicacao e botoes (a ideia e dizer o que fazer, nao so "nada aqui").
  const emptyState = (art, title, text, ...actions) => h("div", { class: "empty card empty-state" },
    h("div", { class: "empty-art", "aria-hidden": "true" }, icon(`art-${art}`)),
    h("h2", { class: "empty-title" }, title),
    text ? h("p", { class: "muted" }, text) : null,
    actions.flat().filter(Boolean).length ? h("div", { class: "row empty-actions" }, actions) : null);
  const errorBox = (message) => h("div", { class: "error-box", role: "alert" }, h("strong", {}, "Não foi possível concluir. "), message);
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(name, filled = false) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", `icon${filled ? " is-filled" : ""}`);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }
  const setTitle = (text) => { document.title = `${text} — Nexus Science`; };

  let toastTimer;
  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }
  async function copyText(text, ok = "Copiado!") {
    try { await navigator.clipboard.writeText(text); } catch {
      const area = h("textarea", { "aria-hidden": "true" });
      area.value = text; document.body.append(area); area.select();
      try { document.execCommand("copy"); } catch { /* sem suporte */ }
      area.remove();
    }
    toast(ok);
  }

  // ------------------------------------------------------------------ API
  async function api(path, { method = "GET", body, signal, headers = {} } = {}) {
    let response;
    try {
      response = await fetch(path, {
        method, signal, credentials: "same-origin",
        headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error("Sem conexão com o servidor. Verifique a internet e tente novamente.");
    }
    let data = {};
    try { data = await response.json(); } catch { /* corpo vazio */ }
    if (!response.ok) {
      const error = new Error(data.error || (Array.isArray(data.detail) ? "Dados inválidos. Revise os campos." : `Erro ${response.status}.`));
      error.status = response.status;
      throw error;
    }
    return data;
  }

  let optionsPromise;
  const loadOptions = () => {
    optionsPromise ||= api("/api/discover/options").catch((error) => { optionsPromise = undefined; throw error; });
    return optionsPromise;
  };

  // ------------------------------------------------------------------ tema
  const systemTheme = () => (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const readTheme = () => { try { return JSON.parse(localStorage.getItem(THEME_KEY)) || systemTheme(); } catch { return systemTheme(); } };
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const toggle = document.getElementById("theme-toggle");
    toggle.setAttribute("aria-label", theme === "dark" ? "Mudar para o tema claro" : "Mudar para o tema escuro");
    toggle.title = toggle.getAttribute("aria-label");
  }
  applyTheme(readTheme());
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, JSON.stringify(next)); } catch { /* modo privado */ }
  });

  // ------------------------------------------------------------------ conta
  const accountButton = document.getElementById("account-button");
  const dialog = document.getElementById("auth-dialog");
  const authError = document.getElementById("auth-error");
  const logoutButton = document.getElementById("logout-button");
  const profileLink = document.getElementById("profile-link");
  const session = { admin: false, user: accountButton.dataset.user || "", name: accountButton.dataset.name || "", profile: accountButton.dataset.profile || "", healthPack: accountButton.dataset.healthPack !== "0" };

  const nameField = document.getElementById("auth-name-field");
  const nameInput = document.getElementById("auth-name");
  let userHook = null; // o sininho se registra aqui depois de montado
  function setUser(user, name = "") {
    session.user = user || "";
    session.name = user ? name : "";
    document.getElementById("account-label").textContent = user || "Entrar";
    accountButton.setAttribute("aria-label", user ? `Meu perfil (${user})` : "Entrar na conta");
    accountButton.title = user ? "Meu perfil" : "Entrar na conta";
    logoutButton.hidden = !user;
    profileLink.hidden = !user;
    if (!user) paintAdmin(false);
    dialog.querySelectorAll(".field, [data-auth='login'], [data-auth='register']").forEach((el) => { el.hidden = Boolean(user); });
    nameField.hidden = true;
    if (userHook) userHook();
  }
  const adminLink = document.getElementById("admin-link");
  /** Mostra (ou esconde) a aba de Administração no menu e na janela da conta. */
  function paintAdmin(isAdmin) {
    session.admin = isAdmin;
    adminLink.hidden = !isAdmin;
    if (typeof currentView === "string") renderNav(currentView);
  }
  async function syncAdmin() {
    if (!session.user) { paintAdmin(false); return; }
    try { paintAdmin((await api("/api/admin/session")).admin === true); } catch { paintAdmin(false); }
  }
  let currentView = "";
  setUser(session.user, session.name);

  // ------------------------------------------------------------------ avisos (sininho)
  const CHECK_EVERY_MS = 15 * 60 * 1000;
  const bell = { items: [], unread: 0, hasInterests: false, timer: null, busy: false };
  const bellWrap = document.getElementById("bell-wrap");
  const bellButton = document.getElementById("bell-button");
  const bellCount = document.getElementById("bell-count");
  const alertsPanel = document.getElementById("alerts-panel");

  function paintBell() {
    bellCount.hidden = bell.unread === 0;
    bellCount.textContent = bell.unread > 9 ? "9+" : String(bell.unread);
    bellButton.setAttribute("aria-label", bell.unread ? `Avisos de artigos novos: ${bell.unread} não lidos` : "Avisos de artigos novos");
    if (!alertsPanel.hidden) paintPanel();
  }
  function takeBox(data) {
    bell.items = data.alerts || [];
    bell.unread = data.unread || 0;
    paintBell();
  }
  async function alertAction(path, options) {
    try { takeBox(await api(path, options)); } catch (error) { if (error.status !== 401) toast(error.message); }
  }
  const KIND_BADGES = { retratacao: "Retratado", regulatorio: "Regulatório", "relatorio-lista": "Relatório" };
  function paintPanel() {
    const rows = bell.items.map((item) => h("li", { class: `alert-row${item.read ? "" : " is-unread"}${item.priority >= 2 ? " is-important" : ""}` },
      KIND_BADGES[item.kind] ? h("span", { class: "alert-kind" }, KIND_BADGES[item.kind]) : null,
      h("a", {
        href: item.href,
        onclick: () => { closePanel(); if (!item.read) alertAction("/api/alerts/read", { method: "POST", body: { id: item.id } }); },
      }, item.title),
      h("small", { class: "muted alert-body" }, item.work ? [metaLine(item.work), item.topic].filter(Boolean).join(" · ") : item.body),
      h("button", { type: "button", class: "alert-dismiss", "aria-label": `Dispensar aviso: ${item.title}`, onclick: () => alertAction(`/api/alerts?id=${encodeURIComponent(item.id)}`, { method: "DELETE" }) }, icon("x"))));
    mount(alertsPanel,
      h("div", { class: "alerts-head" }, h("strong", {}, "Avisos"),
        bell.unread ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => alertAction("/api/alerts/read", { method: "POST", body: {} }) }, "Marcar como lidos") : null),
      rows.length ? h("ul", { class: "plain-list alert-list" }, rows)
        : h("p", { class: "muted alerts-empty" }, "Nenhum aviso por enquanto. Avisamos de artigos retratados que você guarda, de mudanças regulatórias nas substâncias dos seus relatórios, de novidades nas listas dos relatórios e de artigos novos nos seus interesses."),
      h("div", { class: "alerts-foot" },
        h("a", { class: "btn btn-secondary btn-sm", href: "#/perfil/notificacoes", onclick: closePanel }, "Notificações"),
        h("a", { class: "btn btn-ghost btn-sm", href: "#/perfil/interesses", onclick: closePanel }, bell.hasInterests ? "Interesses" : "Escolher interesses"),
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => runCheck(true) }, "Verificar agora")));
  }
  function openPanel() { paintPanel(); alertsPanel.hidden = false; bellButton.setAttribute("aria-expanded", "true"); }
  function closePanel() { alertsPanel.hidden = true; bellButton.setAttribute("aria-expanded", "false"); }
  bellButton.addEventListener("click", () => (alertsPanel.hidden ? openPanel() : closePanel()));
  document.addEventListener("click", (event) => { if (!alertsPanel.hidden && !bellWrap.contains(event.target)) closePanel(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !alertsPanel.hidden) { closePanel(); bellButton.focus(); } });

  /** Procura artigos novos (o servidor respeita o intervalo mínimo) e avisa só quando há novidade. */
  async function runCheck(force = false) {
    if (!session.user || bell.busy) return;
    bell.busy = true;
    try {
      const result = await api("/api/alerts/check", { method: "POST", body: { force } });
      takeBox(result);
      if (result.new > 0) toast(result.new === 1 ? "1 aviso novo no sininho." : `${result.new} avisos novos no sininho.`);
      else if (force && result.ran) toast(result.baseline ? "Pronto: guardamos os artigos de hoje. Você será avisado dos próximos." : "Nenhum aviso novo por enquanto.");
      else if (force && result.reason === "intervalo") toast("Você verificou há pouco. Tente novamente em alguns minutos.");
      else if (force && result.reason === "fontes") toast("As fontes não responderam agora. Tente mais tarde.");
    } catch (error) {
      if (error.status === 401) { setUser(""); } else if (force) toast(error.message);
    } finally { bell.busy = false; }
  }
  async function syncBell() {
    clearInterval(bell.timer);
    bellWrap.hidden = !session.user;
    closePanel();
    if (!session.user) { bell.items = []; bell.unread = 0; bell.hasInterests = false; paintBell(); return; }
    try {
      const [box, prefs] = await Promise.all([api("/api/alerts"), api("/api/interests")]);
      bell.hasInterests = prefs.topics.length > 0 || prefs.terms.length > 0;
      takeBox(box);
    } catch { return; }
    runCheck(false);
    bell.timer = setInterval(() => { if (!document.hidden) runCheck(false); }, CHECK_EVERY_MS);
  }
  userHook = () => { syncBell(); syncProfile(); syncAdmin(); };
  syncBell();
  syncAdmin();


  function openAuth(hint) {
    authError.hidden = true;
    document.getElementById("auth-note").hidden = true;
    document.getElementById("auth-hint").textContent = hint || "Entre para salvar artigos, criar listas e exportar. Buscar e ler não exige conta.";
    if (!dialog.open) dialog.showModal();
  }
  /** Garante conta para ações que a exigem; abre o diálogo se faltar. */
  function requireUser(message) {
    if (session.user) return true;
    openAuth(message);
    return false;
  }
  // com conta, o botao com o nome do usuario abre o Perfil (o "Sair da conta" fica la); sem conta, abre a entrada
  accountButton.addEventListener("click", () => { if (session.user) location.hash = "#/perfil"; else openAuth(); });

  dialog.querySelectorAll("[data-close-auth]").forEach((link) => link.addEventListener("click", () => dialog.close()));

  async function authenticate(kind) {
    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;
    if (!email || !password) { authError.textContent = "Informe e-mail e senha."; authError.hidden = false; return; }
    const acceptTerms = document.getElementById("auth-terms").checked;
    const name = nameInput.value.trim();
    if (kind === "register" && !name) { authError.textContent = "Diga como podemos te chamar."; authError.hidden = false; nameInput.focus(); return; }
    if (kind === "register" && !acceptTerms) { authError.textContent = "Para criar a conta, aceite os Termos de Uso e a Política de Privacidade."; authError.hidden = false; return; }
    try {
      const data = await api(`/api/auth/${kind}`, { method: "POST", body: kind === "register" ? { email, password, acceptTerms, name } : { email, password } });
      document.getElementById("auth-password").value = "";
      setUser(data.user, data.name);
      dialog.close();
      toast(kind === "register" ? "Conta criada!" : "Login realizado!");
      render(); // reabre a tela atual já com os dados da conta
    } catch (error) {
      authError.textContent = error.message;
      authError.hidden = false;
    }
  }
  dialog.querySelector("[data-auth='login']").addEventListener("click", () => { nameField.hidden = true; authenticate("login"); });
  // o nome so e pedido ao criar conta: o primeiro clique mostra o campo, o segundo envia
  dialog.querySelector("[data-auth='register']").addEventListener("click", () => {
    if (nameField.hidden) { nameField.hidden = false; authError.hidden = true; nameInput.focus(); return; }
    authenticate("register");
  });
  dialog.querySelector("[data-auth='forgot']").addEventListener("click", async () => {
    const note = document.getElementById("auth-note");
    const email = document.getElementById("auth-email").value.trim();
    authError.hidden = true;
    note.hidden = true;
    if (!email) { authError.textContent = "Digite o seu e-mail acima e clique em “Esqueci a senha”."; authError.hidden = false; return; }
    try {
      const data = await api("/api/auth/forgot", { method: "POST", body: { email } });
      note.textContent = data.message;
      note.hidden = false;
    } catch (error) { authError.textContent = error.message; authError.hidden = false; }
  });
  dialog.querySelector("[data-auth='cancel']").addEventListener("click", () => dialog.close());
  profileLink.addEventListener("click", () => dialog.close());
  adminLink.addEventListener("click", () => dialog.close());
  logoutButton.addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch { /* sessão já inválida */ }
    setUser("");
    dialog.close();
    toast("Você saiu da conta.");
    render();
  });

  /** Executa uma ação da conta tratando sessão expirada e erros comuns. */
  async function guarded(action, failure = "Não foi possível concluir a ação.") {
    try {
      return await action();
    } catch (error) {
      if (error.status === 401) { setUser(""); openAuth("Sua sessão expirou. Entre novamente."); }
      else toast(error.message || failure);
      return undefined;
    }
  }

  // ------------------------------------------------------------------ navegação
  function renderBottomNav(view) {
    const items = [["#/", "Início", "", "home"], ["#/feed", "Feed", "feed", "feed"], ["#/busca", "Busca", "busca", "search"], ["#/biblioteca", "Biblioteca", "biblioteca", "bookmark"], ["/ia", "Laboratório", "lab", "spark"]];
    if (session.admin) items.push(["#/admin", "Admin", "admin", "shield"]);
    const nav = document.getElementById("bottomnav");
    nav.classList.toggle("has-admin", session.admin);
    mount(nav, items.map(([href, label, key, name]) => h("a", {
      href, "aria-current": key === view || (key === "busca" && view === "artigo") ? "page" : null,
    }, icon(name), h("span", {}, label))));
  }

  function renderNav(view) {
    renderBottomNav(view);
    if (view === "perfil") accountButton.setAttribute("aria-current", "page"); else accountButton.removeAttribute("aria-current");
    const items = [["#/", "Início", ""], ["#/feed", "Feed", "feed"], ["#/busca", "Busca", "busca"], ["#/biblioteca", "Biblioteca", "biblioteca"]];
    mount(document.getElementById("mainnav"),
      items.map(([href, label, key]) => h("a", { href, "aria-current": key === view || (key === "busca" && view === "artigo") ? "page" : null }, label)),
      h("a", { href: "/ia", title: "Resumos e análises com IA (opcional)" }, "Laboratório de IA"),
      session.admin ? h("a", { href: "#/admin", "aria-current": view === "admin" ? "page" : null }, "Administração") : null);
  }

  // ------------------------------------------------------------------ componentes
  function highlighted(text, query) {
    const words = [...new Set(String(query || "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))];
    if (!words.length) return text;
    const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
    return String(text).split(pattern).map((part, index) => (index % 2 ? h("mark", {}, part) : part));
  }

  function badges(work) {
    return h("div", { class: "badges" },
      (work.studyTypes || []).map((t) => h("span", { class: "badge type" }, t)),
      work.openAccess ? h("span", { class: "badge oa" }, "Acesso aberto") : h("span", { class: "badge" }, "Acesso restrito"),
      work.citedBy > 0 ? h("span", { class: "badge" }, `${Lib.formatCount(work.citedBy)} citações`) : null,
      work.language ? h("span", { class: "badge" }, work.language.toUpperCase()) : null,
      work.source ? h("span", { class: "badge" }, work.source) : null);
  }
  // metadados no padrão do Google Scholar (citation_*): o conector do Zotero e o do Mendeley leem estas tags da página do artigo
  function setCitationMeta(work) {
    clearCitationMeta();
    const tags = [["citation_title", work.title], ["citation_journal_title", work.journal], ["citation_volume", work.volume],
      ["citation_issue", work.issue], ["citation_doi", work.doi], ["citation_pmid", work.pmid], ["citation_language", work.language],
      ["citation_publication_date", (work.published || "").replace(/-/g, "/") || (work.year ? String(work.year) : "")]];
    const [first, last] = String(work.pages || "").split(/\s*[-–—]\s*/);
    tags.push(["citation_firstpage", first], ["citation_lastpage", last]);
    for (const a of work.authorList || []) tags.push(["citation_author", [a.family, a.given].filter(Boolean).join(", ")]);
    for (const k of work.keywords || []) tags.push(["citation_keywords", k]);
    for (const [name, content] of tags) {
      if (!content) continue;
      document.head.append(h("meta", { name, content, "data-citation": "" }));
    }
  }
  const clearCitationMeta = () => document.querySelectorAll("meta[data-citation]").forEach((el) => el.remove());

  const metaLine = (work) => [work.authors, work.journal, work.year].filter(Boolean).join(" · ");
  const articleHref = (work) => Lib.buildHash("/artigo", { ref: work.ref });

  // um unico ouvinte fecha qualquer seletor de lista ou painel de download aberto quando o clique cai fora dele
  document.addEventListener("click", (event) => {
    document.querySelectorAll(".save-picker:not([hidden])").forEach((picker) => {
      if (!picker.parentElement.contains(event.target)) {
        picker.hidden = true; picker.replaceChildren();
        picker.parentElement.querySelector("button")?.setAttribute("aria-expanded", "false");
      }
    });
    document.querySelectorAll(".download-panel:not([hidden])").forEach((panel) => {
      if (!panel.parentElement.contains(event.target)) { panel.hidden = true; panel.parentElement.querySelector("button")?.setAttribute("aria-expanded", "false"); }
    });
  });

  // botão "Exportar" da biblioteca e das listas: um só botão, com todas as opções agrupadas dentro
  const EXPORT_GROUPS = [
    ["Gerenciadores de referências", "Importe no Zotero, Mendeley ou EndNote.",
      [["RIS (Zotero, Mendeley, EndNote)", "ris"], ["EndNote (.enw)", "endnote"], ["CSL JSON (Zotero)", "csljson"], ["BibTeX", "bibtex"]]],
    ["Citações prontas", "Uma referência por linha, para colar no seu trabalho.",
      [["ABNT", "abnt"], ["APA", "apa"], ["Vancouver", "vancouver"], ["IEEE", "ieee"], ["Harvard", "harvard"], ["MLA", "mla"]]],
    ["Planilha e dados", "Para analisar ou guardar.", [["Planilha (CSV)", "csv"], ["Dados (JSON)", "json"], ["Resumos (MD)", "resumos"]]],
  ];
  function exportMenu(listId) {
    const panel = h("div", { class: "download-panel", hidden: "", role: "region", "aria-label": "Opções de exportação" });
    const button = h("button", { type: "button", class: "btn btn-secondary btn-sm", "aria-expanded": "false", "aria-haspopup": "true" }, icon("download"), "Exportar");
    const close = () => { panel.hidden = true; button.setAttribute("aria-expanded", "false"); };
    const href = (format) => `/api/library/export?${new URLSearchParams({ format, ...(listId ? { list_id: listId } : {}) })}`;
    mount(panel, EXPORT_GROUPS.map(([title, hint, formats]) => h("section", { class: "download-option" },
      h("h4", {}, title), h("p", { class: "hint" }, hint),
      h("div", { class: "row" }, formats.map(([label, format]) => h("a", { class: "btn btn-sm btn-secondary", href: href(format), download: "", onclick: close }, label))))));
    button.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
    });
    return h("span", { class: "download-wrap" }, button, panel);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".download-panel:not([hidden])").forEach((panel) => {
      panel.hidden = true;
      const button = panel.parentElement.querySelector("button");
      button?.setAttribute("aria-expanded", "false");
      button?.focus();
    });
  });

  // analise salva do Laboratorio: ver (HTML sanitizado no servidor), baixar em 4 formatos e excluir
  function analysisRow(item, { showTitle = false, onChange } = {}) {
    const body = h("div", { class: "analysis-body prose", hidden: "" });
    const toggle = h("button", { type: "button", class: "btn btn-sm btn-secondary", "aria-expanded": "false" }, "Ver");
    let loaded = false;
    toggle.addEventListener("click", async () => {
      const open = body.hidden;
      if (open && !loaded) {
        const full = await guarded(() => api(`/api/analyses/${encodeURIComponent(item.id)}`));
        if (!full) return;
        body.innerHTML = full.html; // markdown_lite sanitiza no servidor (escapa o texto e so admite links http/https)
        loaded = true;
      }
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Ocultar" : "Ver";
    });
    const remove = h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Excluir a análise ${item.label}` }, "Excluir");
    remove.addEventListener("click", async () => {
      if (await guarded(() => api(`/api/analyses/${encodeURIComponent(item.id)}`, { method: "DELETE" }))) { toast("Análise excluída"); if (onChange) onChange(); }
    });
    const date = new Date(item.createdAt);
    return h("li", { class: "analysis-item" },
      h("div", { class: "analysis-head" },
        h("strong", {}, item.label),
        h("span", { class: "muted" }, ` · ${item.page || "laboratório"} · ${Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("pt-BR")}`)),
      showTitle ? h("a", { href: Lib.buildHash("/artigo", { ref: item.ref }), class: "analysis-article" }, item.title) : null,
      h("div", { class: "row" }, toggle,
        ["pdf", "docx", "md", "html", "txt"].map((f) => h("a", { class: "btn btn-sm btn-secondary", href: `/api/analyses/${encodeURIComponent(item.id)}/download?format=${f}`, download: "" }, f.toUpperCase())),
        remove),
      body);
  }

  // menu "Baixar": resumo, ficha, referencia e texto completo aberto; links abertos da fonte; impressao
  function downloadMenu(work) {
    const panel = h("div", { class: "download-panel", hidden: "", role: "region", "aria-label": "Opções de download" });
    const button = h("button", { type: "button", class: "btn btn-secondary", "aria-expanded": "false" }, icon("download"), "Baixar");
    const wrap = h("span", { class: "download-wrap" }, button, panel);
    let loaded = false;
    const fileHref = (kind, format) => `/api/discover/download?${new URLSearchParams({ ref: work.ref, kind, format })}`;
    async function load() {
      mount(panel, loading("Verificando o que há para baixar…"));
      let data;
      try { data = await api(`/api/discover/downloads?ref=${encodeURIComponent(work.ref)}`); } catch (error) {
        mount(panel, errorBox(error.message));
        return;
      }
      loaded = true;
      mount(panel,
        data.options.map((option) => h("section", { class: `download-option${option.available ? "" : " is-off"}` },
          h("h4", {}, option.label), h("p", { class: "hint" }, option.description),
          option.available
            ? h("div", { class: "row" }, option.formats.map((f) => h("a", { class: "btn btn-sm btn-secondary", href: fileHref(option.kind, f.id), download: "" }, f.label)))
            : null)),
        data.links.length ? h("section", { class: "download-option" }, h("h4", {}, "PDF e páginas abertas"),
          h("div", { class: "row" }, data.links.map((l) => {
            const safe = Lib.safeHttpUrl(l.url);
            return safe ? h("a", { class: "btn btn-sm btn-secondary", href: safe, target: "_blank", rel: "noopener noreferrer" }, [icon("external"), l.label]) : null;
          }))) : null,
        h("section", { class: "download-option" }, h("h4", {}, "Imprimir ou salvar como PDF"),
          h("p", { class: "hint" }, "Abre a impressão do navegador com o layout limpo desta página."),
          h("button", { type: "button", class: "btn btn-sm btn-secondary", onclick: () => window.print() }, "Imprimir esta página")),
        h("p", { class: "note" }, data.note));
    }
    button.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open && !loaded) load();
    });
    panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { panel.hidden = true; button.setAttribute("aria-expanded", "false"); button.focus(); } });
    return wrap;
  }

  // avisos da busca: um so aviso aparece direto; varios ficam recolhidos para nao empurrar os resultados
  function notesBlock(notes) {
    if (!notes.length) return null;
    if (notes.length === 1) return h("p", { class: "note" }, notes[0]);
    return h("details", { class: "notes" }, h("summary", {}, `${notes.length} avisos sobre esta busca`),
      h("ul", {}, notes.map((note) => h("li", {}, note))));
  }

  // Botao unico "Salvar": salva na biblioteca (padrao) e abre o menu para escolher listas ou criar uma nova.
  // Com o artigo ja salvo, o clique abre o mesmo menu (nao remove): remover fica dentro do menu.
  function saveButton(work, { small = true, onChange } = {}) {
    const button = h("button", { type: "button", class: `btn ${small ? "btn-sm " : ""}btn-secondary save-button`, "aria-haspopup": "dialog", "aria-expanded": "false" });
    const picker = h("div", { class: "save-picker", role: "dialog", "aria-label": "Salvar artigo", hidden: "" });
    const wrap = h("span", { class: "save-wrap" }, button, picker);
    const refresh = () => {
      button.setAttribute("aria-pressed", String(Boolean(work.saved)));
      button.replaceChildren(icon("bookmark", work.saved), h("span", { class: "save-label" }, work.saved ? "Salvo" : "Salvar"), icon("chevron"));
      if (work.saved && popNext) button.firstChild.classList.add("pop");
      popNext = false;
    };
    let popNext = false;
    const closePicker = () => { picker.hidden = true; picker.replaceChildren(); button.setAttribute("aria-expanded", "false"); };

    async function renderMenu() {
      mount(picker, loading("Carregando suas listas…"));
      picker.hidden = false;
      button.setAttribute("aria-expanded", "true");
      const data = await guarded(() => api("/api/lists"));
      if (!data) { closePicker(); return; }

      const status = h("div", { class: "save-status" },
        h("span", {}, icon("check"), work.saved ? " Salvo na biblioteca" : " Não está na biblioteca"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: toggleLibrary }, work.saved ? "Remover" : "Salvar"));

      const rows = data.lists.map((list) => {
        const box = h("input", { type: "checkbox", checked: list.works.some((w) => w.ref === work.ref) });
        box.addEventListener("change", async () => {
          box.disabled = true;
          const path = `/api/lists/${encodeURIComponent(list.id)}/items`;
          const ok = await guarded(() => (box.checked
            ? api(path, { method: "POST", body: { ref: work.ref } })
            : api(`${path}?ref=${encodeURIComponent(work.ref)}`, { method: "DELETE" })));
          box.disabled = false;
          if (ok === undefined) { box.checked = !box.checked; return; }
          toast(box.checked ? `Adicionado a "${list.name}"` : `Removido de "${list.name}"`);
          if (onChange) onChange();
        });
        return h("label", { class: "check list-check" }, box, h("span", {}, list.name), h("small", { class: "muted" }, String(list.works.length)));
      });

      const name = h("input", { type: "text", placeholder: data.lists.length ? "Nome da nova lista" : "Nome da primeira lista (ex.: TCC)", maxlength: "80", "aria-label": "Nome da nova lista" });
      const create = h("button", { type: "button", class: "btn btn-sm btn-primary" }, icon("plus"), "Criar e adicionar");
      const createList = async () => {
        if (!name.value.trim()) { name.focus(); return; }
        create.disabled = true;
        const made = await guarded(() => api("/api/lists", { method: "POST", body: { name: name.value } }));
        if (made && await guarded(() => api(`/api/lists/${encodeURIComponent(made.id)}/items`, { method: "POST", body: { ref: work.ref } }))) {
          toast(`Lista "${made.name}" criada com este artigo`);
          if (onChange) onChange();
          await renderMenu();
          return;
        }
        create.disabled = false;
      };
      create.addEventListener("click", createList);
      name.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); createList(); } });

      mount(picker, status,
        h("p", { class: "save-picker-title" }, data.lists.length ? "Adicionar a uma lista" : "Você ainda não tem listas. Crie a primeira:"),
        rows.length ? h("div", { class: "list-checks" }, rows) : null,
        h("div", { class: "new-list" }, name, create),
        h("button", { type: "button", class: "btn btn-sm btn-ghost close-picker", onclick: () => { closePicker(); button.focus(); } }, "Fechar"));
      (rows.length ? picker.querySelector("input[type=checkbox]") : name).focus();
    }

    async function toggleLibrary() {
      const done = await guarded(async () => {
        if (work.saved) await api(`/api/library?ref=${encodeURIComponent(work.ref)}`, { method: "DELETE" });
        else await api("/api/library", { method: "POST", body: { ref: work.ref } });
        work.saved = !work.saved;
        popNext = work.saved;
        toast(work.saved ? "Salvo na biblioteca" : "Removido da biblioteca");
        return true;
      });
      refresh();
      if (done) { if (onChange) onChange(); await renderMenu(); }
    }

    picker.addEventListener("keydown", (event) => { if (event.key === "Escape") { closePicker(); button.focus(); } });
    button.addEventListener("click", async () => {
      if (!requireUser("Entre para salvar artigos na sua biblioteca.")) return;
      if (!picker.hidden) { closePicker(); return; }
      if (!work.saved) {
        button.disabled = true;
        const done = await guarded(async () => {
          await api("/api/library", { method: "POST", body: { ref: work.ref } });
          work.saved = true;
          toast("Salvo na biblioteca");
          return true;
        });
        button.disabled = false;
        refresh();
        if (!done) return;
        if (onChange) onChange();
      }
      await renderMenu();
    });
    refresh();
    return wrap;
  }

  // ------------------------------------------------------------------ Início
  const TOPICS = ["diabetes tipo 2", "inteligência artificial na educação", "mudanças climáticas", "energia solar", "saúde mental"];
  const SAMPLE_CRITERIA = [
    ["met", "Integridade (retratação)", "20/20"], ["met", "Desenho do estudo", "22,5/25"], ["met", "Revisão por pares", "10/10"],
    ["unmet", "Tamanho da amostra informado", "0/10"], ["partial", "Resultado principal quantificado", "5/10"],
    ["partial", "Precisão estatística", "5/10"], ["met", "Método descrito no resumo", "10/10"],
  ];


  /** Busca da pagina inicial (campo, seletor de fonte e contadores), igual para convidado e para quem tem conta. */
  function homeSearch() {
    const input = h("input", { type: "search", id: "home-q", placeholder: "Tema, título, DOI ou palavra-chave", "aria-label": "Buscar artigos", maxlength: "300", autocomplete: "off" });
    const sourceBox = h("span", { class: "search-source" });
    const sourceCount = h("strong", {}, "—");
    const feedCount = h("strong", {}, "—");
    let sourceSelect = null;
    const go = (q) => {
      const fonte = sourceSelect && sourceSelect.value !== "" ? sourceSelect.value : "";
      location.hash = Lib.buildHash("/busca", { q, fonte });
    };
    loadOptions().then((options) => {
      sourceCount.dataset.target = sourceCount.textContent = String(options.sources.filter((src) => src.id !== "all").length);
      if (options.sources.length < 2) return;
      sourceSelect = h("select", { id: "home-source", "aria-label": "Fonte" },
        options.sources.map((src) => h("option", { value: src.default ? "" : src.id }, src.name)));
      sourceSelect.value = "";
      mount(sourceBox, sourceSelect);
    }).catch(() => { /* a busca funciona sem o seletor */ });
    api("/api/feed/sources").then((data) => { feedCount.dataset.target = feedCount.textContent = String(data.sources.length); }).catch(() => { feedCount.textContent = ""; });
    const form = h("form", { class: "home-search", role: "search", onsubmit: (e) => { e.preventDefault(); go(input.value.trim()); } },
      input, sourceBox,
      h("button", { type: "submit", class: "btn btn-primary" }, icon("search"), "Buscar"));
    return { form, sourceCount, feedCount };
  }

  // ---- aparicao ao rolar e contadores (com movimento reduzido, tudo aparece de uma vez)
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  let revealIo = null;
  /** Faz o elemento entrar subindo quando aparece na tela (a CSS esconde `.rv` ate la). */
  function reveal(el, delay = 0) {
    el.classList.add("rv");
    if (delay) el.style.setProperty("--d", `${delay}s`);
    if (reducedMotion() || !("IntersectionObserver" in window)) { el.classList.add("in"); return el; }
    if (!revealIo) {
      revealIo = new IntersectionObserver((entries) => entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add("in"); revealIo.unobserve(entry.target); }
      }), { threshold: 0.12 });
    }
    revealIo.observe(el);
    return el;
  }
  function resetReveal() { if (revealIo) { revealIo.disconnect(); revealIo = null; } }
  /** Chama `fn` uma vez, quando o elemento aparece na tela. */
  function whenVisible(el, fn) {
    if (reducedMotion() || !("IntersectionObserver" in window)) { fn(); return; }
    const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { io.disconnect(); fn(); } }, { threshold: 0.4 });
    io.observe(el);
  }
  /** Anima o numero de 0 ate `end` (sem animacao se a pessoa pediu movimento reduzido). */
  function countTo(el, end, ms = 1200) {
    if (reducedMotion() || !(end > 0)) { el.textContent = String(end); return; }
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      el.textContent = String(Lib.countAt(end, k));
      if (k < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  /** Numera os filhos com `--i`, que a CSS usa para escalonar as animacoes. */
  function indexed(nodes) { nodes.forEach((node, i) => node.style.setProperty("--i", String(i))); return nodes; }

  // O inicio muda conforme a pessoa: convidado ve a vitrine do produto; quem tem conta ve o painel de trabalho.
  function renderHome() {
    resetReveal();
    if (session.user) renderDashboard(); else renderGuestHome();
  }

  // ------------------------------------------------------------------ Inicio de quem tem conta: painel em blocos ("bento")
  const DASH_DEFAULT_SHORTCUTS = [["Buscar artigos", "#/busca"], ["Minha biblioteca", "#/biblioteca"], ["Relatórios", "#/relatorio"], ["Feed de novidades", "#/feed"]];

  /** Um bloco do painel; o brilho que segue o cursor e posto pelo ouvinte do painel inteiro. */
  function bentoTile(cls, ...kids) { return h("article", { class: `bento-tile ${cls}` }, kids); }
  function bentoHead(ic, title, link) {
    return h("div", { class: "bento-head" }, h("span", { class: "bento-ic", "aria-hidden": "true" }, icon(ic)), h("h2", {}, title), link || null);
  }

  async function renderDashboard() {
    setTitle("Início");
    const { form } = homeSearch();
    const first = session.name.split(" ")[0];
    const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
    const numTile = (href, label) => h("a", { class: "bento-tile b-num", href }, h("strong", { class: "b-n" }, "0"), h("span", { class: "b-l" }, label));
    const savedTile = numTile("#/biblioteca", "artigos salvos");
    const listsTile = numTile("#/biblioteca", "listas");
    const reportsTile = numTile("#/relatorio", "relatórios");
    const stepsTile = bentoTile("b-steps", skeleton("row", 1, "Carregando seus passos…"));
    const alertsBox = h("div", {}, skeleton("row", 2, "Carregando avisos…"));
    const alertsTile = bentoTile("b-alerts", bentoHead("bell", "Avisos", h("a", { class: "dash-link", href: "#/perfil/notificacoes" }, "Notificações")), alertsBox);
    const recentBox = h("div", {}, skeleton("row", 2, "Carregando seus artigos…"));
    const recentTile = bentoTile("b-recent", bentoHead("bookmark", "Últimos salvos", h("a", { class: "dash-link", href: "#/biblioteca" }, "Biblioteca")), recentBox,
      h("div", { class: "b-fan", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
    const susResult = h("div", { class: "stack" });
    const susNote = h("div", {});
    const susTile = bentoTile("b-sus", bentoHead("check", "Consta no SUS?"),
      h("p", { class: "muted b-sub" }, "Medicamento, cirurgia, exame ou técnica: confira nas bases oficiais."), susSearch(susResult, susNote, { compact: true }), susResult, susNote);
    const shortcuts = PROFILE_SHORTCUTS[session.profile] || DASH_DEFAULT_SHORTCUTS;
    const linksNav = h("nav", { class: "b-chips", "aria-label": "Atalhos" },
      shortcuts.map(([label, href]) => h("a", { class: "b-chip", href }, label)), h("a", { class: "b-chip", href: "/ia" }, "Laboratório de IA"));
    const linksTile = bentoTile("b-links", bentoHead("arrow", "Atalhos"), linksNav);
    const feedBox = h("section", { class: "dash-feed", hidden: "" });
    const tiles = [savedTile, listsTile, reportsTile, stepsTile, alertsTile, recentTile, susTile, linksTile];
    tiles.forEach((tile, i) => reveal(tile, i * 0.06));
    const bento = h("section", { class: "bento", "aria-label": "Seu painel" }, tiles);

    mount($app,
      h("section", { class: "home-hero dash-hero" },
        h("p", { class: "eyebrow" }, today.charAt(0).toUpperCase() + today.slice(1)),
        h("h1", { class: "display" }, first ? `Bem-vindo, ${first}` : "Bem-vindo de volta"),
        h("p", { class: "lead" }, "O que vamos pesquisar hoje?"),
        form),
      bento, feedBox);

    const [accountRes, billingRes, alertsRes, libraryRes] = await Promise.allSettled([
      api("/api/account"), api("/api/billing/me"), api("/api/alerts"), api("/api/library")]);
    if (currentView !== "") return;  // a pessoa ja foi para outra tela
    const account = accountRes.status === "fulfilled" ? accountRes.value : null;
    const billing = billingRes.status === "fulfilled" ? billingRes.value : null;

    // -- numeros (com barra de uso quando a cobranca esta ativa)
    if (account) {
      const limits = billing ? billing.limits : {};
      [[savedTile, account.counts.library, limits.library], [listsTile, account.counts.lists, limits.lists], [reportsTile, account.counts.reports, limits.reports]].forEach(([tile, value, limit]) => {
        countTo(tile.querySelector(".b-n"), value);
        if (limit && billing && billing.enforced) {
          const bar = h("i", {});
          bar.style.setProperty("--w", `${Math.min(100, Math.round((value / limit) * 100))}%`);
          tile.querySelector(".b-l").textContent += ` · de ${limit}`;
          tile.append(h("div", { class: "meter b-meter", role: "img", "aria-label": `${value} de ${limit}` }, bar));
        }
      });
      if (billing && billing.enforced) linksNav.prepend(h("a", { class: "b-chip is-plan", href: "#/planos" }, billing.active ? `Plano ${billing.planName}` : "Ver planos"));
    } else { [savedTile, listsTile, reportsTile].forEach((tile) => tile.remove()); }

    // -- primeiros passos: anel de progresso; quando acabam, o bloco vira um convite ao Laboratorio
    if (account) {
      const summary = Lib.stepsSummary([
        { done: account.interests.topics + account.interests.terms > 0, label: "Escolha seus interesses", href: "#/perfil/interesses" },
        { done: Boolean(account.profile && account.profile.configured), label: "Diga o que você faz", href: "#/perfil/uso" },
        { done: account.counts.library > 0, label: "Salve seu primeiro artigo", href: "#/busca" },
        { done: account.counts.lists > 0, label: "Crie uma lista de leitura", href: "#/biblioteca" },
        { done: account.counts.reports > 0, label: "Gere um relatório", href: "#/relatorio" },
      ]);
      const ring = h("div", { class: "b-ring", role: "img", "aria-label": `${summary.done} de ${summary.total} passos feitos` }, h("b", {}, `${summary.done}/${summary.total}`));
      mount(stepsTile, h("h2", { class: "b-steps-title" }, summary.next ? "Primeiros passos" : "Tudo pronto"), ring,
        summary.next ? h("a", { class: "b-next", href: summary.next.href }, summary.next.label, icon("arrow"))
          : h("a", { class: "b-next", href: "/ia" }, "Experimente o Laboratório de IA", icon("arrow")));
      requestAnimationFrame(() => requestAnimationFrame(() => ring.style.setProperty("--p", String(summary.percent))));
    } else { stepsTile.remove(); }

    // -- avisos: sino que balanca quando ha novidade
    const alertData = alertsRes.status === "fulfilled" ? alertsRes.value : { alerts: [], unread: 0 };
    const alertItems = (alertData.alerts || []).slice(0, 3);
    if (alertData.unread) alertsTile.classList.add("has-unread");
    alertsTile.querySelector(".bento-ic").dataset.count = alertData.unread ? String(Math.min(alertData.unread, 9)) : "";
    mount(alertsBox, alertItems.length
      ? h("ul", { class: "plain-list dash-list" }, alertItems.map((item) => h("li", { class: item.read ? "" : "is-unread" },
        h("a", { href: item.href, onclick: () => { if (!item.read) api("/api/alerts/read", { method: "POST", body: { id: item.id } }).catch(() => {}); } }, item.title),
        h("small", { class: "muted" }, item.work ? [metaLine(item.work), item.topic].filter(Boolean).join(" · ") : item.body))))
      : emptyState("bell", "Nenhum aviso por enquanto", "Avisamos de artigos retratados que você guarda e de novidades nos seus interesses.",
        h("a", { class: "btn btn-secondary btn-sm", href: "#/perfil/interesses" }, "Escolher interesses")));

    // -- ultimos salvos
    const saved = libraryRes.status === "fulfilled"
      ? [...libraryRes.value.items].sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, 3) : [];
    mount(recentBox, saved.length
      ? h("ul", { class: "plain-list dash-list" }, saved.map((work) => h("li", {},
        h("a", { href: articleHref(work) }, work.title), h("small", { class: "muted" }, metaLine(work)))))
      : emptyState("library", "Nada salvo ainda", "Salve artigos com o botão “Salvar” e eles aparecem aqui.",
        h("a", { class: "btn btn-primary btn-sm", href: "#/busca" }, "Buscar artigos")));

    // -- novidades (dos interesses; se nao houver, as gerais)
    try {
      let data = await api("/api/feed?mode=voce");
      let personal = true;
      if (!data.items.length) { data = await api("/api/feed?mode=tudo"); personal = false; }
      if (currentView !== "" || !data.items.length) return;
      feedBox.hidden = false;
      mount(feedBox,
        h("div", { class: "dash-head" }, h("h2", {}, personal ? "Novidades para você" : "Novidades da ciência"), h("a", { class: "dash-link", href: "#/feed" }, "Ver o feed")),
        h("div", { class: "feed-list" }, data.items.slice(0, 6).map((item) => feedCard(item))));
      reveal(feedBox);
    } catch { /* o resto do painel segue funcionando sem o feed */ }
  }

  // ------------------------------------------------------------------ Inicio do convidado: a jornada, contada rolando a pagina
  const AUDIENCES = [
    ["Estudantes", "TCC, dissertação e tese", "Ache referências confiáveis, salve em listas e gere as citações em ABNT ou APA."],
    ["Pesquisadores", "Revisões e acompanhamento da área", "Veja a nota de cada artigo, acompanhe novidades e entregue relatórios com o método declarado."],
    ["Profissionais de saúde", "Decisão com evidência", "Cruze medicamentos com ANVISA, Conitec e Rename e receba aviso quando um estudo for retratado."],
  ];
  const JOURNEY = [
    ["01 / BUSCAR", "Uma pergunta, cinco fontes.", "PubMed, Europe PMC, arXiv, OpenAlex e DOAJ respondem juntos, sem artigos repetidos."],
    ["02 / AVALIAR", "Uma nota que mostra o cálculo.", "Oito critérios abertos, de 0 a 100. Você vê o que contou e o que faltou."],
    ["03 / ENTREGAR", "Relatório com método.", "Listas, relatório com o método declarado e citações para Word e Zotero."],
  ];
  const JOURNEY_SOURCES = ["PubMed", "Europe PMC", "arXiv", "OpenAlex", "DOAJ"];
  const JOURNEY_RESULTS = [
    ["Metformin and outcomes in older adults", "Revisão sistemática · 2025", 78],
    ["Coorte multicêntrica de pacientes com DM2", "Coorte · 2024", 71],
    ["Efeitos adversos gastrointestinais", "Ensaio clínico · 2023", 64],
  ];
  const JOURNEY_EXPORTS = ["Baixar Word", "Exportar para Zotero", "Citação ABNT"];

  /** As tres cenas da jornada (busca, nota, relatorio), com dados ficticios, como o exemplo de nota que ja existia. Cada chamada cria nos novos. */
  function journeyScenes() {
    const scene1 = h("div", { class: "jr-scene s1" },
      h("div", { class: "jr-query" }, "metformina em idosos"),
      h("div", { class: "jr-sources" }, indexed(JOURNEY_SOURCES.map((name) => h("span", {}, name)))),
      h("div", { class: "jr-results" }, indexed(JOURNEY_RESULTS.map(([title, meta, score]) =>
        h("div", {}, h("span", {}, title, h("small", {}, meta)), h("b", {}, String(score)))))));
    const ring = h("div", { class: "jr-ring" }, h("div", {}, h("b", {}, "78"), h("small", {}, "de 100")));
    const scene2 = h("div", { class: "jr-scene s2" }, ring,
      h("div", {}, h("strong", {}, "Metformin and outcomes in older adults"), h("div", { class: "muted jr-note" }, "Confiabilidade alta · dados fictícios")),
      h("ul", { class: "jr-crit" }, indexed(SAMPLE_CRITERIA.slice(0, 5).map(([status, name, pts]) =>
        h("li", { class: `st-${status}` }, icon(STATUS_ICONS[status]), h("span", {}, name), h("b", {}, pts))))));
    const lines = [92, 78, 86, 54, 70].map((width) => { const line = h("i", {}); line.style.setProperty("--w", `${width}%`); return line; });
    const scene3 = h("div", { class: "jr-scene s3" },
      h("div", { class: "jr-doc" }, h("h4", {}, "Relatório · Metformina em idosos"), h("span", { class: "jr-method" }, "Método: 5 fontes · 12 estudos incluídos"), indexed(lines)),
      h("div", { class: "jr-exports" }, indexed(JOURNEY_EXPORTS.map((name) => h("span", {}, name)))));
    return { scenes: [scene1, scene2, scene3], ring };
  }
  const jrBar = () => h("div", { class: "jr-bar" }, h("i"), h("i"), h("i"));

  /**
   * A jornada tem duas formas. No computador, uma secao alta com palco fixo: a rolagem vira progresso e troca a cena, o texto e a barra.
   * No celular, tres passos empilhados, cada um com a sua cena, que anima UMA vez quando o passo aparece: sem palco fixo, sem troca de
   * cena enquanto o dedo desliza e sem o anel girando para tras (a barra de endereco do navegador mexe na altura e confundia a conta).
   */
  function journeySection() {
    // -- computador
    const { scenes, ring } = journeyScenes();
    const items = JOURNEY.map(([n, title, text], i) => h("li", { class: i === 0 ? "on" : "" }, h("span", { class: "jr-n" }, n), h("h2", {}, title), h("p", {}, text)));
    const card = h("div", { class: "jr-card", "aria-hidden": "true" }, jrBar(), scenes);
    const stage = h("div", { class: "jr-stage jr-live" }, h("div", { class: "jr-rail", "aria-hidden": "true" }, h("i")), h("div", { class: "jr-copy" }, h("ol", {}, items)), card);
    stage.dataset.s = "1";
    // -- celular
    const steps = JOURNEY.map(([n, title, text], i) => {
      const built = journeyScenes();
      const step = h("article", { class: "jr-step jr-live" },
        h("div", { class: "jr-copy-m" }, h("span", { class: "jr-n" }, n), h("h2", {}, title), h("p", {}, text)),
        h("div", { class: "jr-card", "aria-hidden": "true" }, jrBar(), built.scenes[i]));
      step.dataset.s = "0";
      const play = () => { step.dataset.s = String(i + 1); built.ring.classList.add("on"); };
      if (reducedMotion() || !("IntersectionObserver" in window)) play();
      else {
        const io = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { io.disconnect(); play(); } }, { threshold: 0.3 });
        io.observe(step);
      }
      return step;
    });
    const section = h("section", { class: "journey", id: "jornada", "aria-label": "Como funciona, passo a passo" }, stage, h("div", { class: "jr-steps" }, steps));
    let scene = 0, queued = false;
    const rail = stage.querySelector(".jr-rail i");
    const update = () => {
      if (!section.isConnected) { removeEventListener("scroll", onScroll); removeEventListener("resize", onScroll); return; }  // saiu da pagina inicial
      if (stage.offsetParent === null) return;  // no celular o palco fixo nao existe
      const box = section.getBoundingClientRect();
      if (box.bottom < -200 || box.top > innerHeight + 200) return;  // longe da tela: nada a calcular
      const progress = Lib.journeyProgress(box.top, box.height, innerHeight);
      rail.style.setProperty("--prog", progress.toFixed(3));
      const next = Lib.journeyScene(progress);
      if (next === scene) return;
      scene = next;
      stage.dataset.s = String(next);
      items.forEach((li, i) => li.classList.toggle("on", i + 1 === next));
      if (next === 2) ring.classList.add("on");  // o anel enche uma vez e fica: voltar a rolagem nao o faz girar para tras
    };
    const onScroll = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; update(); }); };
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    setTimeout(update, 0);  // depois de montada
    return section;
  }

  // ---- fundo de rede do topo do convidado: as fontes (nos rotulados) se organizam, os demais derivam e se ligam ao cursor
  const NET_HUBS = ["PubMed", "Europe PMC", "arXiv", "OpenAlex", "DOAJ"];
  const NET_MOBILE_ANCHORS = [[0.2, 0.1], [0.5, 0.06], [0.8, 0.1], [0.3, 0.95], [0.7, 0.95]];
  function networkBackdrop(canvas, host) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let W = 0, H = 0, nodes = [], hubs = [], running = false, start = performance.now();
    let color = "#ff6a00", ink = "#ededee", frames = 0;
    const mouse = { x: -999, y: -999 };
    const readTheme = () => { const style = getComputedStyle(document.documentElement); color = style.getPropertyValue("--accent").trim() || color; ink = style.getPropertyValue("--text").trim() || ink; };
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(W < 700 ? 34 : 80, (W * H) / 16000));
      nodes = Array.from({ length: count }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35, r: 1.3 + Math.random() * 1.7 }));
      hubs = NET_HUBS.map((name, i) => ({ name, a: (i / NET_HUBS.length) * Math.PI * 2 - Math.PI / 2, x: Math.random() * W, y: Math.random() * H, anchor: W < 700 ? NET_MOBILE_ANCHORS[i] : null }));
    }
    function frame(now) {
      if (!running) return;
      if (!canvas.isConnected) { running = false; return; }  // saiu da pagina inicial
      if (++frames % 90 === 0) readTheme();
      const ease = 1 - Math.pow(1 - Math.min(1, (now - start) / 2600), 3);
      const wob = now / 4000;
      ctx.clearRect(0, 0, W, H);
      hubs.forEach((hub) => {
        const tx = hub.anchor ? W * hub.anchor[0] + Math.sin(wob + hub.a) * 10 : W * 0.78 + Math.cos(hub.a + wob * 0.25) * W * 0.14;  // no computador, so no lado direito: o texto fica livre
        const ty = hub.anchor ? H * hub.anchor[1] + Math.cos(wob * 1.3 + hub.a) * 8 : H * 0.5 + Math.sin(hub.a + wob * 0.25) * H * 0.34;
        hub.x += (tx - hub.x) * (0.02 + 0.05 * ease); hub.y += (ty - hub.y) * (0.02 + 0.05 * ease);
      });
      nodes.forEach((p) => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
        const dx = mouse.x - p.x, dy = mouse.y - p.y;
        if (Math.hypot(dx, dy) < 150) { p.x += dx * 0.012; p.y += dy * 0.012; }
      });
      const points = [...nodes, ...hubs];
      ctx.lineWidth = 1; ctx.strokeStyle = color;
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
          if (d < 130) { ctx.globalAlpha = (1 - d / 130) * 0.4; ctx.beginPath(); ctx.moveTo(points[i].x, points[i].y); ctx.lineTo(points[j].x, points[j].y); ctx.stroke(); }
        }
        const dm = Math.hypot(mouse.x - points[i].x, mouse.y - points[i].y);
        if (dm < 170) { ctx.globalAlpha = (1 - dm / 170) * 0.8; ctx.beginPath(); ctx.moveTo(points[i].x, points[i].y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke(); }
      }
      ctx.fillStyle = color; ctx.globalAlpha = 0.8;
      nodes.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill(); });
      hubs.forEach((hub) => {
        ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(hub.x, hub.y, 5, 0, 6.283); ctx.fill();
        ctx.globalAlpha = 0.22; ctx.beginPath(); ctx.arc(hub.x, hub.y, 5 + 7 * Math.abs(Math.sin(now / 900 + hub.a)), 0, 6.283); ctx.fill();
        ctx.globalAlpha = 0.9; ctx.fillStyle = ink; ctx.font = "600 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(hub.name, hub.x, hub.y - 15); ctx.fillStyle = color;
      });
      ctx.globalAlpha = 1;
      requestAnimationFrame(frame);
    }
    host.addEventListener("pointermove", (event) => { if (event.pointerType === "touch") return; const box = canvas.getBoundingClientRect(); mouse.x = event.clientX - box.left; mouse.y = event.clientY - box.top; });
    host.addEventListener("pointerleave", () => { mouse.x = mouse.y = -999; });
    host.addEventListener("pointerdown", (event) => {  // celular: um toque atrai e liga os nos por um instante
      if (event.pointerType === "mouse") return;
      const box = canvas.getBoundingClientRect(); mouse.x = event.clientX - box.left; mouse.y = event.clientY - box.top;
      clearTimeout(canvas.tapTimer); canvas.tapTimer = setTimeout(() => { mouse.x = mouse.y = -999; }, 1400);
    });
    window.addEventListener("resize", () => { if (canvas.isConnected) resize(); });
    readTheme(); resize();
    if (reducedMotion()) { start -= 5000; running = true; frame(performance.now()); running = false; return; }  // quadro unico, sem movimento
    if ("IntersectionObserver" in window) {  // so anima enquanto o topo esta na tela
      new IntersectionObserver(([entry]) => { const was = running; running = entry.isIntersecting; if (running && !was) requestAnimationFrame(frame); }).observe(host);
    } else { running = true; requestAnimationFrame(frame); }
  }

  const STRIP_ROWS = [
    ["PubMed", "Europe PMC", "arXiv", "OpenAlex", "DOAJ"],
    ["Nature", "The BMJ", "JAMA", "PLOS ONE", "eLife", "MIT News", "Quanta", "Fiocruz", "Jornal da USP"],
  ];
  /** Faixas com as fontes, passando de lado (a CSS para a animacao com "reduzir movimento"). */
  function sourceStrip() {
    return h("div", { class: "mq", "aria-label": "Algumas das fontes que o Nexus Science reúne" },
      STRIP_ROWS.map((names, row) => {
        const run = (copy) => names.map((name) => h("span", { "aria-hidden": copy ? "true" : null }, name));
        return h("div", { class: `mq-row${row ? " rev" : ""}` }, h("div", { class: "mq-track" }, run(false), run(true), run(true), run(true)));
      }));
  }

  const planCards = (data) => h("div", { class: "gplan-grid" }, data.plans.map((plan, i) => {
    const featured = plan.key === "pro";
    const paid = plan.priceCents > 0;
    return reveal(h("article", { class: `gplan-card${featured ? " is-featured" : ""}` },
      featured ? h("span", { class: "gplan-flag" }, "Mais escolhido") : null,
      h("h3", {}, plan.name),
      h("p", { class: "gplan-price" }, plan.priceCents ? h("strong", {}, plan.price) : h("strong", {}, "Grátis"), plan.priceCents ? h("span", { class: "muted" }, " por mês") : null),
      h("p", { class: "muted" }, plan.description),
      h("ul", { class: "checklist" },
        h("li", {}, icon("check"), h("span", {}, `${plan.limits.library.toLocaleString("pt-BR")} artigos na biblioteca`)),
        h("li", {}, icon("check"), h("span", {}, `${plan.limits.lists} listas de leitura`)),
        h("li", {}, icon("check"), h("span", {}, `${plan.limits.reports} ${plan.limits.reports === 1 ? "relatório" : "relatórios"} de tema`))),
      h("button", { type: "button", class: `btn ${featured ? "btn-primary" : "btn-secondary"}`,
        onclick: () => openAuth(paid ? `Crie sua conta para assinar o plano ${plan.name}.` : "Crie sua conta grátis para salvar artigos e acompanhar interesses.") },
      paid ? "Começar e assinar" : "Criar conta grátis")), i * 0.1);
  }));

  function renderGuestHome() {
    setTitle("Início");
    const { form, sourceCount, feedCount } = homeSearch();
    const plansBox = h("section", { class: "home-section", "aria-labelledby": "planos", hidden: "" });
    api("/api/billing/plans").then((data) => {
      plansBox.hidden = false;
      mount(plansBox,
        h("p", { class: "eyebrow" }, "Planos"),
        h("h2", { id: "planos" }, "Comece grátis. Cresça quando precisar."),
        h("p", { class: "lead" }, "Buscar, ler e navegar pelo feed é livre, sem conta. A conta grátis já guarda seus artigos; os planos pagos ampliam os limites para quem pesquisa todo dia."),
        planCards(data));
      reveal(plansBox);
    }).catch(() => { /* sem planos publicados, a secao simplesmente nao aparece */ });

    const line = (kids, i) => { const inner = h("span", {}, kids); inner.style.setProperty("--i", String(i)); return h("span", { class: "jr-line" }, inner); };
    const eight = h("strong", { "data-target": "8" }, "0");
    const stat = (value, label) => h("div", { class: "stat" }, value, h("span", {}, label));
    const stats = h("section", { class: "stats stats-3", "aria-label": "O produto em números" },
      stat(sourceCount, "fontes de busca em uma só"), stat(feedCount, "fontes de novidades no feed"), stat(eight, "critérios abertos de confiabilidade"));
    whenVisible(stats, () => [sourceCount, feedCount, eight].forEach((el) => countTo(el, Number(el.dataset.target || el.textContent) || 0)));

    const net = h("canvas", { class: "jr-net", "aria-hidden": "true" });
    const hero = h("section", { class: "home-hero jr-hero" },
        h("div", { class: "jr-orb a", "aria-hidden": "true" }), h("div", { class: "jr-orb b", "aria-hidden": "true" }), net,
        h("p", { class: "eyebrow" }, "Plataforma de pesquisa científica"),
        h("h1", { class: "display jr-title" }, line("Da pergunta", 0), line(["ao ", h("span", { class: "jr-accent" }, "relatório.")], 1)),
        h("p", { class: "lead" }, "Busque em várias fontes, veja com critérios abertos o quanto cada artigo merece confiança e transforme suas leituras em um relatório com método."),
        form,
        h("p", { class: "examples" }, "Exemplos: ", TOPICS.map((t) => h("a", { href: Lib.buildHash("/busca", { q: t }) }, t))),
        h("a", { class: "jr-scroll", href: "#/", onclick: (event) => { event.preventDefault(); document.getElementById("jornada").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }); } },
          h("i", { "aria-hidden": "true" }), "Role para ver como funciona"));
    setTimeout(() => networkBackdrop(net, hero), 0);  // depois de montar, quando o canvas ja tem tamanho
    mount($app,
      hero,
      sourceStrip(),

      journeySection(),

      reveal(stats),

      h("section", { class: "home-section", "aria-labelledby": "publico" },
        reveal(h("p", { class: "eyebrow" }, "Para quem é")),
        reveal(h("h2", { id: "publico" }, "Feito para quem precisa de fonte confiável."), 0.05),
        h("div", { class: "feature-grid" }, AUDIENCES.map(([who, what, text], i) => reveal(h("div", { class: "feature" },
          h("h3", {}, who), h("p", { class: "audience-what" }, what), h("p", { class: "muted" }, text)), 0.1 + i * 0.1)))),

      plansBox,

      reveal(h("section", { class: "cta" },
        h("div", {}, h("h2", {}, "Crie sua conta grátis."),
          h("p", { class: "muted" }, "Sem cartão. Salve artigos, acompanhe seus interesses e gere relatórios com método. Buscar e ler continua livre.")),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-primary", onclick: () => openAuth("Crie uma conta para salvar artigos, acompanhar interesses e montar listas.") }, "Criar conta grátis"),
          h("a", { class: "btn btn-outline", href: "/ia" }, "Conhecer o Laboratório de IA")))));
  }


  // ------------------------------------------------------------------ Disponibilidade no SUS
  const SUS_KINDS = { medicamento: "Medicamento", procedimento: "Procedimento, técnica ou produto" };
  /** Um item do veredito: o que as bases oficiais dizem (consta, incorporado, nao encontrado...), com a fonte de cada afirmacao. */
  function susItem(item) {
    return h("article", { class: `sus-item tone-${item.tone}` },
      h("div", { class: "sus-head" },
        h("h4", {}, item.name),
        h("span", { class: `sus-verdict tone-${item.tone}` }, item.label)),
      h("p", { class: "muted sus-kind" }, SUS_KINDS[item.kind] || item.kind,
        item.source ? ` · no texto: ${item.source} (${METHODS[item.method] || item.method})` : null),
      h("ul", { class: "plain-list sus-details" }, item.details.map((text) => h("li", {}, text))),
      item.procedures.length
        ? h("details", { class: "more-records" }, h("summary", {}, item.totalProcedures > item.procedures.length
          ? `Ver procedimentos (${item.procedures.length} de ${item.totalProcedures})` : `Ver procedimentos (${item.totalProcedures})`),
        h("ul", { class: "plain-list sus-procs" }, item.procedures.map((p) => h("li", {},
          h("code", {}, p.code), " ", p.name.charAt(0) + p.name.slice(1).toLowerCase(),
          h("small", { class: "muted" }, [p.group, p.complexity].filter(Boolean).join(" · "))))))
        : null,
      item.sources.length ? h("p", { class: "note" }, `Fontes: ${item.sources.join(", ")}.`) : null);
  }
  function susFooter(data) {
    const sigtapMeta = data.meta.sigtap;
    const stale = ["anvisa", "conitec", "rename", "sigtap"].filter((key) => data.meta[key] && data.meta[key].defasado);
    const link = Lib.safeHttpUrl(sigtapMeta.paginaUrl);
    return [
      stale.length ? h("p", { class: "note" }, `Atenção: dados possivelmente desatualizados (${stale.join(", ")}).`) : null,
      h("p", { class: "note" }, data.notice),
      h("p", { class: "note" }, "Bases: Rename 2024, Conitec, ANVISA e a Tabela de Procedimentos do SUS (",
        link ? h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "SIGTAP/DATASUS") : "SIGTAP/DATASUS",
        `, competência ${String(sigtapMeta.competencia).replace(/^(\d{4})(\d{2})$/, "$2/$1")}).`)];
  }
  /** Campo de consulta manual: qualquer medicamento, cirurgia, exame, tecnica ou produto, em portugues. */
  function susSearch(resultBox, footerBox, { compact = false } = {}) {
    const input = h("input", { type: "text", placeholder: "Ex.: colecistectomia, transplante de rim, metformina", maxlength: "100", "aria-label": "Buscar no SUS" });
    const run = async () => {
      const term = input.value.trim();
      if (term.length < 3) { input.focus(); return; }
      mount(resultBox, loading("Consultando as bases…"));
      const found = await guarded(() => api(`/api/brasil/sus?q=${encodeURIComponent(term)}`));
      if (!found) { mount(resultBox); return; }
      mount(resultBox, found.items.map(susItem));
      mount(footerBox, compact ? h("p", { class: "note" }, found.notice) : susFooter(found));
    };
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); run(); } });
    return h("div", { class: "new-list" }, input, h("button", { type: "button", class: "btn btn-sm btn-secondary", onclick: run }, "Buscar"));
  }

  // ------------------------------------------------------------------ Busca
  // do mais forte ao mais fraco: uma escala de um tom so (laranja ate cinza) em vez de varias cores
  const DESIGN_TONES = { sistematica: "t1", ensaio: "t2", observacional: "t3", revisao: "t4", opiniao: "t5", preprint: "t6", desconhecido: "t7" };

  /** Anel com a nota de confiabilidade de um cartao (so codigo, sem IA); sem base para avaliar mostra um traco. */
  function scoreRing(rating, { small = false } = {}) {
    const tone = Lib.scoreTone(rating);
    const value = rating && typeof rating.score === "number" ? rating.score : null;
    const ring = h("span", { class: `score-ring tone-${tone}${small ? " is-small" : ""}`, role: "img",
      "aria-label": value === null ? "Nota de confiabilidade indisponível" : `Nota de confiabilidade ${value} de 100, faixa ${rating.band}`,
      title: value === null ? "Sem resumo para avaliar" : `Confiabilidade: ${rating.band}` }, h("b", {}, value === null ? "—" : String(value)));
    ring.style.setProperty("--p", String(value === null ? 0 : value));
    return ring;
  }

  function panoramaView(info) {
    const pct = Math.round((info.openAccess / info.sample) * 100);
    const strongest = info.strongest;
    const first = info.timeline[0];
    const last = info.timeline[info.timeline.length - 1];
    const stat = (value, label) => h("div", { class: "pano-stat" }, h("strong", {}, value), h("span", {}, label));
    const bar = h("div", { class: "pano-bar", role: "img", "aria-label": `Tipos de evidência: ${info.designs.map((d) => `${d.label} ${d.count}`).join(", ")}` },
      info.designs.map((d) => {
        const part = h("i", { class: `pano-seg ${DESIGN_TONES[d.key] || "t7"}`, title: `${d.label}: ${d.count}` });
        part.style.flexGrow = String(d.count);  // via CSSOM: a CSP bloqueia style inline no HTML
        return part;
      }));
    const root = h("details", { class: "panorama" },
      h("summary", { class: "pano-head" },
        h("h3", {}, "Panorama do tema"),
        h("span", { class: "muted" }, `Primeiros ${info.sample} resultados por relevância${info.total > info.sample ? ` · de ${Lib.formatCount(info.total)}` : ""}`)),
      h("div", { class: "pano-stats" },
        stat(`${pct}%`, "com acesso aberto"),
        stat(String(info.sources.length), info.sources.length === 1 ? "fonte" : "fontes"),
        first ? stat(first.year === last.year ? String(first.year) : `${first.year}–${last.year}`, "período publicado") : null,
        info.retracted ? stat(String(info.retracted), info.retracted === 1 ? "retratado" : "retratados") : null),
      h("div", { class: "pano-evidence" },
        h("h4", {}, "Tipo de evidência"),
        bar,
        h("ul", { class: "pano-legend" }, info.designs.map((d) => h("li", {},
          h("i", { class: `pano-dot ${DESIGN_TONES[d.key] || "t7"}`, "aria-hidden": "true" }), h("span", {}, d.label), h("b", {}, String(d.count)))))),
      strongest ? h("a", { class: "pano-best", href: articleHref(strongest) },
        h("span", { class: "pano-best-score" }, h("strong", {}, String(Math.round(strongest.score))), h("small", {}, "/100")),
        h("span", { class: "pano-best-text" },
          h("small", {}, "Maior nota de confiabilidade na amostra"),
          h("b", {}, strongest.title),
          h("small", { class: "muted" }, [strongest.design, strongest.journal, strongest.year].filter(Boolean).join(" · ")))) : null,
      h("p", { class: "muted pano-note" }, "Conta só a amostra mostrada, não a literatura inteira. A nota mede sinais do registro e do resumo."));
    root.open = !window.matchMedia("(max-width: 560px)").matches;  // no celular comeca fechado, para a lista aparecer logo
    return root;
  }

  async function renderSearch(params) {
    setTitle("Busca");
    mount($app, h("h1", {}, "Busca"), loading("Preparando a busca…"));
    let options;
    try { options = await loadOptions(); } catch (error) { mount($app, h("h1", {}, "Busca"), errorBox(error.message)); return; }

    const st = Lib.searchStateFromParams(params);
    const defaultSource = options.sources.find((s) => s.default) || options.sources[0];
    if (!options.sources.some((s) => s.id === st.source)) st.source = "";
    const activeSource = () => options.sources.find((s) => s.id === (st.source || defaultSource.id)) || defaultSource;

    const q = h("input", { type: "search", id: "q", value: st.q, placeholder: "tema, título ou palavra-chave", autocomplete: "off", maxlength: "300" });
    const yf = h("input", { type: "number", id: "yf", min: "1800", max: "2100", value: st.yearFrom ?? "", placeholder: "de" });
    const yt = h("input", { type: "number", id: "yt", min: "1800", max: "2100", value: st.yearTo ?? "", placeholder: "até" });
    const oa = h("input", { type: "checkbox", id: "oa", checked: st.oa });
    const lang = h("select", { id: "lang" }, options.languages.map((l) => h("option", { value: l.id, selected: l.id === st.lang }, l.name)));
    const sort = h("select", { id: "sort" }, options.sorts.map((s) => h("option", { value: s.id, selected: s.id === st.sort }, s.name)));
    const source = options.sources.length > 1
      ? h("select", { id: "source" }, options.sources.map((s) => h("option", { value: s.id, selected: s.id === activeSource().id }, s.name)))
      : null;
    const typeBox = h("div", {});
    const results = h("div", { "aria-live": "polite" });

    const renderTypes = () => mount(typeBox, activeSource().studyTypes.map((t) => h("label", { class: "check" },
      h("input", { type: "checkbox", value: t, checked: st.types.includes(t) }), t)));
    renderTypes();

    const readControls = () => {
      st.q = q.value.trim();
      st.yearFrom = Number.parseInt(yf.value, 10) || null;
      st.yearTo = Number.parseInt(yt.value, 10) || null;
      st.oa = oa.checked;
      st.lang = lang.value;
      st.sort = sort.value;
      st.types = [...typeBox.querySelectorAll("input:checked")].map((i) => i.value);
      if (source) st.source = source.value === defaultSource.id ? "" : source.value;
    };

    let controller;
    const panoramaBox = h("div", { class: "panorama-slot" });
    const loadPanorama = async (signal) => {
      const params = Lib.apiParamsFromSearchState(st, PAGE_SIZE);
      params.delete("page");
      params.delete("per_page");
      try {
        const info = await api(`/api/discover/panorama?${params}`, { signal });
        if (info.sample >= 5) mount(panoramaBox, panoramaView(info));
      } catch (error) { /* o panorama e um extra: sem ele a lista segue normal */ }
    };
    let run = async () => {
      if (controller) controller.abort();
      controller = new AbortController();
      mount(panoramaBox);
      mount(results, skeleton("row", 5, "Buscando…"));
      try {
        const data = await api(`/api/discover/search?${Lib.apiParamsFromSearchState(st, PAGE_SIZE)}`, { signal: controller.signal });
        mount(results,
          h("div", { class: "results-head" },
            h("div", {}, h("strong", {}, `${Lib.formatCount(data.total)} ${data.total === 1 ? "resultado" : "resultados"}`),
              h("span", { class: "muted" }, ` · ${activeSource().name}`)),
            h("div", { class: "seg", role: "group", "aria-label": "Ordenar por" }, options.sorts.map((item) => h("button", {
              type: "button", class: `seg-btn${item.id === st.sort ? " on" : ""}`, "aria-pressed": String(item.id === st.sort),
              onclick: () => { sort.value = item.id; apply(); },
            }, item.name)))),
          notesBlock(data.notes || []),
          panoramaBox,
          data.works.length
            ? h("ol", { class: "results" }, data.works.map((work) => h("li", { class: "result" },
              scoreRing(work.rating),
              h("div", { class: "result-main" },
                h("h3", {}, h("a", { href: articleHref(work) }, highlighted(work.title, st.q))),
                h("div", { class: "meta" }, metaLine(work)),
                badges(work),
                work.snippet ? h("p", { class: "snippet" }, highlighted(work.snippet, st.q)) : null,
                h("div", { class: "row" }, saveButton(work), h("a", { class: "btn btn-sm btn-ghost", href: articleHref(work) }, "Abrir"))))))
            : emptyState("search", "Nenhum artigo encontrado", "Tente menos termos, outro idioma ou limpe os filtros."),
          data.pages > 1 ? h("nav", { class: "pager", "aria-label": "Páginas" },
            h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: data.page <= 1, onclick: () => goPage(data.page - 1) }, "Anterior"),
            Lib.pageWindow(data.page, data.pages).map((p) => (p === "…" ? h("span", { class: "muted" }, "…")
              : h("button", { type: "button", class: `btn btn-secondary btn-sm${p === data.page ? " current" : ""}`, "aria-current": p === data.page ? "page" : null, onclick: () => goPage(p) }, p))),
            h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: data.page >= data.pages, onclick: () => goPage(data.page + 1) }, "Próxima")) : null);
        if (st.page <= 1 && data.works.length) loadPanorama(controller.signal);
      } catch (error) {
        if (error.name === "AbortError") return;
        mount(results, errorBox(error.message));
      }
    };
    function sync() {
      history.replaceState(null, "", Lib.buildHash("/busca", Lib.paramsFromSearchState(st)));
      run();
    }
    function goPage(page) { st.page = page; sync(); window.scrollTo(0, 0); }
    const apply = () => { readControls(); st.page = 1; sync(); };
    const applyLater = Lib.debounce(apply, 350);

    // barra de busca sempre visivel (no celular fica fixa abaixo do cabecalho)
    const searchBar = h("form", { class: "search-bar", role: "search", onsubmit: (e) => { e.preventDefault(); applyLater.cancel(); apply(); q.blur(); } },
      h("label", { class: "visually-hidden", for: "q" }, "Buscar artigos"), q,
      h("button", { type: "submit", class: "btn btn-primary" }, icon("search"), h("span", { class: "btn-label" }, "Buscar")));

    const filters = h("form", { class: "filters", "aria-label": "Filtros", onsubmit: (e) => { e.preventDefault(); applyLater.cancel(); apply(); } },
      source ? h("div", { class: "field" }, h("label", { for: "source" }, "Fonte"), source) : null,
      h("div", { class: "field" }, h("label", {}, "Ano de publicação"), h("div", { class: "row" }, yf, yt)),
      h("div", { class: "field" }, h("label", {}, "Tipo de estudo"), typeBox),
      h("div", { class: "field" }, h("label", { class: "check" }, oa, "Só acesso aberto")),
      h("div", { class: "field" }, h("label", { for: "lang" }, "Idioma"), lang));
    filters.addEventListener("change", (event) => {
      if (event.target === source) {
        // a fonte muda os tipos de estudo oferecidos: limpa a selecao e redesenha a lista de tipos
        st.source = source.value === defaultSource.id ? "" : source.value;
        st.types = [];
        renderTypes();
      }
      applyLater();
    });
    sort.addEventListener("change", () => apply());
    yf.addEventListener("input", applyLater);
    yt.addEventListener("input", applyLater);

    // filtros ativos como chips removiveis (valem no desktop e no celular)
    const activeBox = h("div", { class: "active-filters", "aria-label": "Filtros ativos" });
    const filterButton = h("button", { type: "button", class: "btn btn-secondary filter-toggle", "aria-haspopup": "dialog", "aria-expanded": "false" });
    function activeFilters() {
      const list = [];
      if (st.yearFrom || st.yearTo) {
        const label = st.yearFrom && st.yearTo ? `${st.yearFrom}–${st.yearTo}` : st.yearFrom ? `desde ${st.yearFrom}` : `até ${st.yearTo}`;
        list.push([label, () => { yf.value = ""; yt.value = ""; }]);
      }
      st.types.forEach((type) => list.push([type, () => { [...typeBox.querySelectorAll("input")].forEach((i) => { if (i.value === type) i.checked = false; }); }]));
      if (st.oa) list.push(["Acesso aberto", () => { oa.checked = false; }]);
      if (st.lang) list.push([(options.languages.find((l) => l.id === st.lang) || {}).name || st.lang, () => { lang.value = ""; }]);
      if (st.source && source) list.push([activeSource().name.split(" (")[0], () => { source.value = defaultSource.id; st.source = ""; st.types = []; renderTypes(); }]);
      return list;
    }
    function renderActive() {
      const list = activeFilters();
      filterButton.replaceChildren(...[icon("filter"), "Filtros", list.length ? h("span", { class: "count-badge" }, String(list.length)) : null].filter(Boolean));
      mount(activeBox, list.map(([label, clear]) => h("span", { class: "chip" }, label,
        h("button", { type: "button", "aria-label": `Remover filtro ${label}`, onclick: () => { clear(); apply(); } }, "×"))));
      activeBox.hidden = list.length === 0;
    }
    const baseRun = run;
    run = () => { renderActive(); return baseRun(); };

    // painel de filtros: coluna lateral no desktop; folha inferior no celular
    const backdrop = h("div", { class: "sheet-backdrop", hidden: "" });
    const sheetTitle = h("div", { class: "sheet-head" }, h("strong", {}, "Filtros"),
      h("button", { type: "button", class: "btn btn-ghost", "aria-label": "Fechar filtros", onclick: () => closeSheet() }, "Fechar"));
    const sheetFoot = h("div", { class: "sheet-foot" },
      h("a", { class: "btn btn-secondary", href: "#/busca", onclick: () => closeSheet() }, "Limpar tudo"),
      h("button", { type: "button", class: "btn btn-primary", onclick: () => closeSheet() }, "Ver resultados"));
    const wrap = h("div", { class: "filters-wrap", role: "dialog", "aria-label": "Filtros da busca" }, sheetTitle, filters, sheetFoot);
    function openSheet() { wrap.classList.add("open"); backdrop.hidden = false; document.body.classList.add("sheet-open"); filterButton.setAttribute("aria-expanded", "true"); }
    function closeSheet() { wrap.classList.remove("open"); backdrop.hidden = true; document.body.classList.remove("sheet-open"); filterButton.setAttribute("aria-expanded", "false"); }
    filterButton.addEventListener("click", () => (wrap.classList.contains("open") ? closeSheet() : openSheet()));
    backdrop.addEventListener("click", closeSheet);
    wrap.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeSheet(); filterButton.focus(); } });
    window.addEventListener("hashchange", closeSheet, { once: true });

    mount($app, h("h1", { class: "visually-hidden" }, "Busca"), searchBar,
      h("div", { class: "search-toolbar" }, filterButton),
      activeBox,
      h("div", { class: "layout" }, wrap, results), backdrop);
    run();
  }

  // ------------------------------------------------------------------ Artigo
  const STATUS_LABELS = { met: "Atendido", partial: "Parcial", unmet: "Não atendido", na: "Não se aplica", unknown: "Desconhecido" };
  const STATUS_ICONS = { met: "check", partial: "half", unmet: "x", na: "minus", unknown: "help" };

  function reliabilityCard(rel) {
    if (!rel) return null;
    const panelId = "reliability-panel";
    const scoreText = rel.score === null ? "—" : `${rel.score}`;
    const button = h("button", { type: "button", class: `reliability-badge band-${rel.band.toLowerCase()}`, "aria-expanded": "false", "aria-controls": panelId },
      h("span", { class: "reliability-score" }, scoreText, rel.score === null ? null : h("small", {}, "/100")),
      h("span", { class: "reliability-text" }, h("strong", {}, `Confiabilidade: ${rel.band}`), h("span", {}, "Toque para ver como a nota é calculada")));
    const rows = rel.criteria.map((c) => h("li", { class: `criterion status-${c.status}` },
      h("div", { class: "criterion-head" },
        h("span", { class: "criterion-icon", "aria-hidden": "true" }, icon(STATUS_ICONS[c.status] || "help")),
        h("strong", {}, c.name),
        h("span", { class: "criterion-points" }, c.status === "na" || c.status === "unknown" ? `${STATUS_LABELS[c.status]} (fora do cálculo)` : `${STATUS_LABELS[c.status]} · ${c.points}/${c.weight}`)),
      h("p", {}, c.detail),
      c.evidence ? h("blockquote", { class: "evidence" }, c.evidence) : null,
      h("p", { class: "hint" }, `Como avaliamos: ${c.how}`)));
    const panel = h("div", { id: panelId, class: "reliability-panel stack", hidden: "" },
      h("p", {}, rel.summary),
      h("p", { class: "hint" }, "A nota é a soma dos pontos dos critérios avaliáveis dividida pelo peso desses critérios, em escala de 0 a 100. Critérios \"desconhecido\" ou \"não se aplica\" ficam fora do cálculo, e a cobertura mostra quanto foi realmente avaliado. Artigo retratado vale 0. Faixas: Alta (75 ou mais), Moderada (50 a 74), Baixa (abaixo de 50)."),
      rel.warnings.map((w) => h("p", { class: "note" }, w)),
      h("ul", { class: "criteria" }, rows),
      h("p", { class: "note" }, rel.disclaimer));
    button.addEventListener("click", () => {
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
      button.setAttribute("aria-expanded", String(open));
    });
    return h("div", { class: "card stack reliability" }, button, panel);
  }

  async function renderArticle(params) {
    const ref = params.get("ref") || "";
    mount($app, loading("Abrindo o artigo…"));
    let data;
    try {
      data = await api(`/api/discover/work?ref=${encodeURIComponent(ref)}`);
    } catch (error) {
      setTitle("Artigo");
      mount($app, h("div", { class: "stack" }, h("a", { href: "#/busca", class: "muted" }, "Voltar à busca"), errorBox(error.message)));
      return;
    }
    const work = data.work;
    setTitle(work.title);
    setCitationMeta(work);

    // citar
    const citationBox = h("div", { "aria-live": "polite" });
    const showCitation = (style) => {
      const text = data.citations[style];
      mount(citationBox, h("div", { class: "citation" }, text),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-sm btn-secondary", onclick: () => copyText(text, `Referência ${style} copiada`) }, "Copiar"),
          h("span", { class: "note" }, "Gerada por código a partir dos metadados do registro (sem IA).")));
    };

    // levar a referência para o Zotero, Mendeley ou EndNote
    const REFERENCE_FORMATS = [["RIS (Zotero, Mendeley, EndNote)", "ris"], ["EndNote (.enw)", "endnote"], ["CSL JSON (Zotero)", "csljson"], ["BibTeX", "bibtex"]];
    function referenceExport(article) {
      const query = (format) => new URLSearchParams({ ref: article.ref, format }).toString();
      const copyBibtex = async () => {
        try {
          const response = await fetch(`/api/discover/cite?${query("bibtex")}`, { credentials: "same-origin" });
          if (!response.ok) throw new Error();
          copyText(await response.text(), "BibTeX copiado");
        } catch { toast("Não foi possível copiar o BibTeX agora."); }
      };
      return h("div", { class: "stack reference-export" },
        h("h3", {}, "Levar para o gerenciador de referências"),
        h("div", { class: "row" },
          REFERENCE_FORMATS.map(([label, format]) => h("a", { class: "btn btn-secondary btn-sm", download: "", href: `/api/discover/cite?${query(format)}` }, label)),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: copyBibtex }, "Copiar BibTeX")),
        h("p", { class: "note" }, "Zotero, Mendeley e EndNote abrem o arquivo RIS (Arquivo, Importar). O Zotero também lê o CSL JSON e, com o conector do navegador instalado, captura esta página direto pelo botão dele."));
    }

    // organizar (etiquetas e listas): só com conta
    const organize = h("div", { class: "stack" });
    async function renderOrganize() {
      if (!session.user) {
        mount(organize, h("p", { class: "muted" }, "Entre na sua conta para etiquetar este artigo e adicioná-lo a listas de leitura."),
          h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-secondary", onclick: () => openAuth("Entre para organizar seus artigos.") }, "Entrar")));
        return;
      }
      mount(organize, loading("Carregando suas listas…"));
      const mine = await guarded(() => Promise.all([api("/api/library"), api("/api/lists")]));
      if (!mine) { mount(organize, h("p", { class: "muted" }, "Não foi possível carregar sua biblioteca agora.")); return; }
      const [library, lists] = mine;
      const item = library.items.find((i) => i.ref === work.ref);
      const tagsBox = h("div", { class: "stack" });
      const drawTags = (tags) => {
        const input = h("input", { type: "text", id: "tag", placeholder: "nova etiqueta (ex.: TCC)", maxlength: "30" });
        const save = async (next) => { const r = await guarded(() => api("/api/library/tags", { method: "PUT", body: { ref: work.ref, tags: next } })); if (r) drawTags(r.tags); };
        mount(tagsBox,
          h("div", { class: "chips" }, tags.map((t) => h("span", { class: "chip" }, t, h("button", { type: "button", "aria-label": `Remover etiqueta ${t}`, onclick: () => save(tags.filter((x) => x !== t)) }, "×")))),
          h("div", { class: "row" }, input, h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => input.value.trim() && save([...tags, input.value.trim()]) }, "Adicionar etiqueta")));
      };
      if (item) drawTags(item.tags); else mount(tagsBox, h("p", { class: "muted" }, "Salve o artigo para adicionar etiquetas."));

      const select = h("select", { id: "add-list", "aria-label": "Adicionar a uma lista" },
        h("option", { value: "" }, lists.lists.length ? "Adicionar à lista…" : "Você ainda não tem listas"),
        lists.lists.map((l) => h("option", { value: l.id }, `${l.name} (${l.works.length})`)));
      select.addEventListener("change", async () => {
        if (!select.value) return;
        const ok = await guarded(() => api(`/api/lists/${select.value}/items`, { method: "POST", body: { ref: work.ref } }));
        if (ok) { toast("Adicionado à lista"); renderOrganize(); }
      });
      const newName = h("input", { type: "text", id: "new-list", placeholder: "nome da nova lista", maxlength: "80" });
      const create = async () => {
        if (!newName.value.trim()) return;
        const created = await guarded(() => api("/api/lists", { method: "POST", body: { name: newName.value } }));
        if (!created) return;
        await guarded(() => api(`/api/lists/${created.id}/items`, { method: "POST", body: { ref: work.ref } }));
        toast(`Lista "${created.name}" criada`);
        renderOrganize();
      };
      mount(organize, tagsBox, h("div", { class: "row" }, select),
        h("div", { class: "row" }, newName, h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: create }, "Criar lista com este artigo")));
    }

    // registro de ensaios, citacoes e dados ligados (fontes abertas); carrega depois da pagina
    const openData = h("div", { class: "stack" }, loading("Consultando registros abertos…"));
    async function renderOpenData() {
      let extra;
      try { extra = await api(`/api/discover/enrichment?ref=${encodeURIComponent(work.ref)}`); } catch {
        mount(openData, h("p", { class: "muted" }, "Os registros abertos não responderam agora."));
        return;
      }
      const external = (href, label) => {
        const safe = Lib.safeHttpUrl(href);
        return safe ? h("a", { href: safe, target: "_blank", rel: "noopener noreferrer" }, label) : label;
      };
      const blocks = [];
      if (extra.mentionedTrials.length) {
        blocks.push(h("div", {}, h("h4", {}, "Registro do ensaio"),
          extra.trials.length
            ? h("ul", { class: "plain-list" }, extra.trials.map((t) => h("li", {},
              external(t.url, t.nct), ` · ${t.status}${t.start ? ` · início ${t.start}` : ""}${t.hasResults ? " · resultados publicados" : ""}`,
              h("small", { class: "muted" }, t.title))))
            : h("p", { class: "muted" }, `O resumo cita ${extra.mentionedTrials.join(", ")}, mas o ClinicalTrials.gov não confirmou o registro.`)));
      }
      if (extra.citations !== null) {
        blocks.push(h("div", {}, h("h4", {}, "Citações (OpenCitations)"), h("p", {}, Lib.formatCount(extra.citations))));
      }
      if (extra.relatedData.length) {
        blocks.push(h("div", {}, h("h4", {}, "Dados e materiais ligados"),
          h("ul", { class: "plain-list" }, extra.relatedData.map((d) => h("li", {},
            external(d.url, d.title), h("small", { class: "muted" }, [d.kind, d.publisher].filter(Boolean).join(" · ")))))));
      }
      mount(openData, blocks.length ? blocks
        : h("p", { class: "muted" }, "Nenhum registro de ensaio, citação ou dado ligado foi encontrado nas fontes abertas."),
      h("p", { class: "note" }, "Fontes: ClinicalTrials.gov, OpenCitations e DataCite (inclui Zenodo)."));
    }

    // analises salvas do Laboratorio de IA para este artigo (so com conta)
    const analysesBox = h("div", { class: "stack" });
    async function renderAnalyses() {
      if (!session.user) {
        mount(analysesBox, h("p", { class: "muted" }, "Entre na sua conta para guardar aqui as análises do Laboratório de IA."));
        return;
      }
      const data = await guarded(() => api(`/api/analyses?ref=${encodeURIComponent(work.ref)}`));
      if (!data) { mount(analysesBox, h("p", { class: "muted" }, "Não foi possível carregar suas análises agora.")); return; }
      mount(analysesBox,
        data.analyses.length
          ? h("ul", { class: "analysis-list" }, data.analyses.map((item) => analysisRow(item, { onChange: renderAnalyses })))
          : h("p", { class: "muted" }, "Nenhuma análise salva. No Laboratório, gere uma análise e clique em \"Salvar no artigo\"."),
        h("a", { class: "btn btn-sm btn-outline", href: Lib.aiLabHref(work.pmid || work.ref) }, "Abrir no Laboratório de IA"));
    }

    // situacao no Brasil: registro na ANVISA e decisoes da Conitec (dados oficiais locais, sem IA) para os medicamentos do resumo
    const brasilBox = h("div", { class: "stack" }, loading("Consultando dados oficiais…"));
    async function renderBrasil() {
      let data;
      try { data = await api(`/api/discover/brasil?ref=${encodeURIComponent(work.ref)}`); } catch {
        mount(brasilBox, h("p", { class: "muted" }, "Os dados oficiais do Brasil não estão disponíveis agora."));
        return;
      }
      const manualResult = h("div", { class: "stack" });
      const manualInput = h("input", { type: "text", placeholder: "Outro medicamento (nome em português)", maxlength: "80", "aria-label": "Buscar medicamento nas bases oficiais" });
      const manualButton = h("button", { type: "button", class: "btn btn-sm btn-secondary" }, "Buscar");
      const runManual = async () => {
        const term = manualInput.value.trim();
        if (term.length < 3) { manualInput.focus(); return; }
        const found = await guarded(() => api(`/api/brasil/medicamento?q=${encodeURIComponent(term)}`));
        if (!found) return;
        mount(manualResult, h("h4", {}, term), situationBlock(found, term.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()));
      };
      manualButton.addEventListener("click", runManual);
      manualInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runManual(); } });
      const meta = data.meta;
      const source = Lib.safeHttpUrl(meta.conitec.paginaUrl);
      const anvisaSource = Lib.safeHttpUrl(meta.anvisa.arquivoUrl);
      const renameSource = meta.rename ? Lib.safeHttpUrl(meta.rename.arquivoUrl) : null;
      const stale = [meta.anvisa.defasado ? `ANVISA (extraída em ${fmtDate(meta.anvisa.extraidoEm)})` : "", meta.conitec.defasado ? `Conitec (extraída em ${fmtDate(meta.conitec.extraidoEm)})` : "", meta.rename && meta.rename.defasado ? `Rename (extraída em ${fmtDate(meta.rename.extraidoEm)})` : ""].filter(Boolean);
      mount(brasilBox,
        data.candidatos.length
          ? [h("p", { class: "hint" }, "Medicamentos que o resumo parece citar. A correspondência de nomes é automática: confirme."),
            data.candidatos.map((c) => h("div", { class: "conitec-drug" },
              h("h4", {}, c.pt, h("span", { class: "muted" }, ` · no texto: ${c.en} (${METHODS[c.metodo] || c.metodo})`)),
              situationBlock(c, c.pt.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())))]
          : h("p", { class: "muted" }, "Não identificamos, no resumo, medicamentos nas bases oficiais. Busque pelo nome em português:"),
        h("div", { class: "new-list" }, manualInput, manualButton), manualResult,
        stale.length ? h("p", { class: "note" }, `Atenção: dados possivelmente desatualizados: ${stale.join("; ")}.`) : null,
        h("p", { class: "note" }, "Fontes: registros de medicamentos da ", anvisaSource ? h("a", { href: anvisaSource, target: "_blank", rel: "noopener noreferrer" }, "ANVISA (dados abertos)") : "ANVISA",
          ` (extraídos em ${fmtDate(meta.anvisa.extraidoEm)}) e decisões da `, source ? h("a", { href: source, target: "_blank", rel: "noopener noreferrer" }, "Conitec") : "Conitec",
          ` (extraídas em ${fmtDate(meta.conitec.extraidoEm)})`, meta.rename ? [" e a ", renameSource ? h("a", { href: renameSource, target: "_blank", rel: "noopener noreferrer" }, "Rename 2024") : "Rename 2024", ` (extraída do PDF oficial em ${fmtDate(meta.rename.extraidoEm)}, licença CC BY-NC-SA 4.0)`] : null,
          ". Constar na Rename indica medicamento essencial; registro ativo na ANVISA permite comercializar; decisão da Conitec trata da incorporação ao SUS. Nenhum dos três indica disponibilidade na sua unidade de saúde: consulte a Secretaria de Saúde."));
    }

    // disponibilidade no SUS: o que o artigo estuda (medicamentos, cirurgias, tecnicas) existe no SUS? Bases oficiais locais, sem IA
    const susBox = h("div", { class: "stack" }, loading("Consultando as bases do SUS…"));
    async function renderSus() {
      let data;
      try { data = await api(`/api/discover/sus?ref=${encodeURIComponent(work.ref)}`); } catch {
        mount(susBox, h("p", { class: "muted" }, "As bases do SUS não estão disponíveis agora."));
        return;
      }
      const manualResult = h("div", { class: "stack" });
      const manualFooter = h("div", { class: "stack" });
      mount(susBox,
        data.items.length
          ? [h("p", { class: "hint" }, "O que o artigo parece estudar e se consta no SUS. A ligação de nomes é automática: confirme."), data.items.map(susItem)]
          : h("p", { class: "muted" }, "Não identificamos, no resumo, medicamentos, cirurgias ou técnicas nas bases do SUS. Busque pelo nome em português:"),
        susSearch(manualResult, manualFooter), manualResult, manualFooter, susFooter(data));
    }

    // artigos semelhantes: carregam depois da pagina e ficam no fim dela
    const similarBox = h("div", { class: "similar-grid" }, loading("Procurando artigos semelhantes…"));
    const similarNote = h("p", { class: "hint" });
    const similarSection = h("section", { class: "similar-section", "aria-labelledby": "similar-title" },
      h("h2", { id: "similar-title" }, "Artigos semelhantes"), similarNote, similarBox);
    async function renderSimilar() {
      let data;
      try { data = await api(`/api/discover/similar?ref=${encodeURIComponent(work.ref)}`); } catch {
        mount(similarBox, h("p", { class: "muted" }, "Não foi possível buscar artigos semelhantes agora."));
        return;
      }
      similarNote.textContent = data.terms.length ? `Buscamos na mesma fonte por: ${data.terms.join(", ")}.` : "";
      mount(similarBox, data.works.length
        ? data.works.map((w) => h("article", { class: "similar-card" },
          h("h3", {}, h("a", { href: articleHref(w) }, w.title)),
          h("p", { class: "meta" }, metaLine(w)),
          badges(w),
          h("div", { class: "row" }, saveButton(w), h("a", { class: "btn btn-sm btn-ghost", href: articleHref(w) }, "Abrir"))))
        : h("p", { class: "muted" }, "Não encontramos artigos semelhantes nesta fonte."));
    }

    const oaHref = Lib.safeHttpUrl(work.oaUrl);
    const doiHref = work.doi ? Lib.safeHttpUrl(`https://doi.org/${work.doi}`) : "";
    const pmidHref = /^\d+$/.test(work.pmid) ? `https://pubmed.ncbi.nlm.nih.gov/${work.pmid}/` : "";
    const meta = [
      ["Tipo de estudo", (work.studyTypes || []).join(", ") || "Não informado pelo registro"],
      ["Periódico", [work.journal, work.volume && `v. ${work.volume}`, work.issue && `n. ${work.issue}`, work.pages && `p. ${work.pages}`].filter(Boolean).join(", ") || "—"],
      ["Ano", work.year || "—"],
      ["DOI", doiHref ? h("a", { href: doiHref, target: "_blank", rel: "noopener noreferrer" }, work.doi) : "—"],
      ["PubMed", pmidHref ? h("a", { href: pmidHref, target: "_blank", rel: "noopener noreferrer" }, `PMID ${work.pmid}`) : "—"],
      ["Idioma", work.language ? work.language.toUpperCase() : "—"],
      ["Fonte", work.source || "—"],
      ["Citações", work.citedBy > 0 ? Lib.formatCount(work.citedBy) : "—"],
    ];

    mount($app,
      h("article", { class: "article-page" },
        h("a", { href: "#/busca", class: "back-link" }, "Voltar à busca"),
        h("header", { class: "article-head" },
          h("h1", {}, work.title),
          h("p", { class: "byline" }, metaLine(work)),
          badges(work),
          h("div", { class: "row actions" },
            saveButton(work, { small: false, onChange: renderOrganize }),
            oaHref ? h("a", { class: "btn btn-secondary", href: oaHref, target: "_blank", rel: "noopener noreferrer" }, [icon("external"), "Versão aberta"])
              : h("span", { class: "note" }, "Sem versão aberta conhecida"),
            downloadMenu(work),
            h("a", { class: "btn btn-secondary", href: Lib.aiLabHref(work.pmid || work.ref), title: "Resumos e análises com IA, opcionais e com avisos" }, [icon("spark"), "Analisar com IA", h("span", { class: "opt" }, " (opcional)")]))),
        h("div", { class: "article-layout" },
          h("div", { class: "article-main" },
            h("section", { class: "block" }, h("h2", {}, "Resumo, com as seções originais"),
              !work.abstract ? h("p", { class: "muted" }, "Este registro não traz resumo.")
                : data.sections.length
                  ? h("dl", { class: "sections" }, data.sections.map((s) => h("div", { class: "sec" },
                    h("dt", {}, s.label && s.label.toLowerCase() !== s.heading.toLowerCase() ? `${s.heading} (rótulo original: ${s.label})` : s.heading),
                    h("dd", {}, s.text))))
                  : [h("p", { class: "note" }, "Este resumo não tem seções rotuladas; texto original completo:"), h("p", {}, work.abstract)]),
            h("section", { class: "block" }, h("h2", {}, "Números e dados estatísticos"),
              data.findings.length
                ? data.findings.map((f) => h("blockquote", { class: "finding" }, h("small", {}, f.tags.join(" · ")), f.sentence))
                : h("p", { class: "muted" }, "Nenhum dado estatístico foi encontrado no resumo."),
              h("p", { class: "note" }, "Frases copiadas do resumo; nada foi gerado nem interpretado. A seleção é por palavras-chave e pode omitir frases. Lido apenas o resumo, não o texto completo.")),
            h("section", { class: "block" }, h("h2", {}, "Citar"),
              h("div", { class: "row", role: "group", "aria-label": "Estilo da citação" }, Object.keys(data.citations).map((st) => h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => showCitation(st) }, st))),
              citationBox,
              referenceExport(work))),
          h("aside", { class: "article-aside", "aria-label": "Avaliação e detalhes" },
            reliabilityCard(data.reliability),
            h("section", { class: "card stack" }, h("h3", {}, "Detalhes"),
              h("table", {}, h("tbody", {}, meta.map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", {}, v))))),
              work.keywords.length ? h("div", { class: "kw" }, work.keywords.map((k) => h("a", { href: Lib.buildHash("/busca", { q: k }) }, k))) : null),
            h("section", { class: "card stack" }, h("h3", {}, "Registro e dados"), openData),
            showHealth() ? h("section", { class: "card stack" }, h("h3", {}, "Situação no Brasil"), brasilBox) : null,
            showHealth() ? h("section", { class: "card stack" }, h("h3", {}, "Disponibilidade no SUS"), susBox) : null,
            h("section", { class: "card stack" }, h("h3", {}, "Análises do Laboratório"), analysesBox),
            h("section", { class: "card stack" }, h("h3", {}, "Organizar"), organize),
          )),
        similarSection));
    renderOrganize();
    renderAnalyses();
    renderOpenData();
    if (showHealth()) { renderBrasil(); renderSus(); }
    renderSimilar();
  }

  // ------------------------------------------------------------------ Biblioteca
  const LIB_SORT_LABELS = { recentes: "Salvos há pouco", nota: "Maior nota", ano: "Mais recentes (ano)", titulo: "Título (A–Z)" };
  const LIB_VIEW_KEY = "nexus.libview";
  const readView = () => { try { return localStorage.getItem(LIB_VIEW_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; } };

  async function renderLibrary(params) {
    setTitle("Biblioteca");
    if (!session.user) {
      mount($app, h("h1", {}, "Biblioteca"), emptyState("lock", "Sua biblioteca espera por você", "Entre na sua conta para ver seus artigos salvos e suas listas de leitura.",
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openAuth("Entre para acessar sua biblioteca.") }, "Entrar")));
      return;
    }
    mount($app, h("h1", {}, "Biblioteca"), skeleton("row", 4, "Carregando a biblioteca…"));
    const data = await guarded(() => api("/api/library"));
    if (!data) { mount($app, h("h1", {}, "Biblioteca"), errorBox("Não foi possível carregar sua biblioteca.")); return; }
    const saved = await guarded(() => api("/api/analyses"));
    const reports = await guarded(() => api("/api/reports"));
    const billing = await api("/api/billing/me").catch(() => null);  // so para as barras de uso (com cobranca ativa)
    const activeTag = params.get("tag") || "";
    const allTags = [...new Set(data.items.flatMap((i) => i.tags))].sort();
    const view = { mode: readView(), sort: "recentes", text: "" };

    const listName = h("input", { type: "text", id: "list-name", placeholder: "Nova lista (ex.: Leituras da semana 3)", maxlength: "80", "aria-label": "Nome da nova lista" });
    const createList = async () => {
      if (!listName.value.trim()) return;
      if (await guarded(() => api("/api/lists", { method: "POST", body: { name: listName.value } }))) renderLibrary(params);
    };
    listName.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); createList(); } });

    // -- numeros da biblioteca (com a barra de uso quando a cobranca esta ativa)
    const limits = billing && billing.enforced ? billing.limits : {};
    const statTile = (label, value, limit, href) => {
      const number = h("strong", { class: "b-n" }, "0");
      countTo(number, value);
      const tile = h("a", { class: "bento-tile b-num lib-stat", href }, number, h("span", { class: "b-l" }, limit ? `${label} · de ${limit}` : label));
      if (limit) { const bar = h("i", {}); bar.style.setProperty("--w", `${Math.min(100, Math.round((value / limit) * 100))}%`); tile.append(h("div", { class: "meter b-meter", role: "img", "aria-label": `${value} de ${limit}` }, bar)); }
      return reveal(tile);
    };
    const analysesCount = saved ? saved.analyses.length : 0;
    const reportsCount = reports ? reports.reports.length : 0;
    const stats = h("div", { class: "lib-stats", "aria-label": "Sua biblioteca em números" },
      statTile(data.items.length === 1 ? "artigo salvo" : "artigos salvos", data.items.length, limits.library, "#/biblioteca"),
      statTile(data.lists.length === 1 ? "lista" : "listas", data.lists.length, limits.lists, "#/biblioteca"),
      statTile(reportsCount === 1 ? "relatório" : "relatórios", reportsCount, limits.reports, "#/relatorio"),
      statTile(analysesCount === 1 ? "análise salva" : "análises salvas", analysesCount, 0, "#/biblioteca"));

    // -- artigos: filtro, ordem e duas formas de ver (cartoes ou tabela)
    const itemsBox = h("div", { class: "lib-items" });
    const countText = h("span", { class: "muted lib-count" });
    const removeItem = async (item) => { if (await guarded(() => api(`/api/library?ref=${encodeURIComponent(item.ref)}`, { method: "DELETE" }))) renderLibrary(params); };
    const metaOf = (item) => [item.authors, item.journal].filter(Boolean).join(" · ");
    const cardOf = (item, index) => {
      const card = h("article", { class: "lib-card" },
        h("div", { class: "lib-card-top" }, scoreRing(item.rating, { small: true }),
          h("span", { class: "chip" }, (item.studyTypes || [])[0] || "Artigo"), h("span", { class: "muted lib-year" }, item.year ? String(item.year) : "")),
        h("h3", {}, h("a", { href: articleHref(item) }, item.title)),
        h("p", { class: "meta" }, metaOf(item)),
        item.tags.length ? h("div", { class: "chips" }, item.tags.map((t) => h("span", { class: "chip" }, t))) : null,
        h("div", { class: "row lib-card-actions" }, h("a", { class: "btn btn-sm btn-secondary", href: articleHref(item) }, "Abrir"),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Remover ${item.title} da biblioteca`, onclick: () => removeItem(item) }, "Remover")));
      card.style.setProperty("--i", String(Math.min(index, 8)));
      return card;
    };
    const tableOf = (shown) => h("div", { class: "table-wrap" }, h("table", { class: "library-table" },
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", class: "col-score" }, "Nota"), h("th", { scope: "col" }, "Artigo"), h("th", { scope: "col", class: "col-year" }, "Ano"),
        h("th", { scope: "col", class: "col-type" }, "Tipo"), h("th", { scope: "col" }, "Etiquetas"),
        h("th", { scope: "col", class: "col-actions" }, h("span", { class: "visually-hidden" }, "Ações")))),
      h("tbody", {}, shown.map((item) => h("tr", {},
        h("td", { class: "col-score" }, scoreRing(item.rating, { small: true })),
        h("td", { class: "col-title" }, h("a", { href: articleHref(item) }, item.title), h("div", { class: "meta" }, metaOf(item))),
        h("td", { class: "col-year" }, item.year || "—"),
        h("td", { class: "col-type" }, (item.studyTypes || [])[0] || "Artigo"),
        h("td", {}, item.tags.length ? h("div", { class: "chips" }, item.tags.map((t) => h("span", { class: "chip" }, t))) : h("span", { class: "muted" }, "—")),
        h("td", { class: "col-actions" }, h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Remover ${item.title} da biblioteca`, onclick: () => removeItem(item) }, "Remover")))))));
    const paintItems = () => {
      const shown = Lib.sortLibrary(Lib.filterLibrary(data.items, view.text, activeTag), view.sort);
      countText.textContent = shown.length === data.items.length ? `${data.items.length} ${data.items.length === 1 ? "artigo" : "artigos"}` : `${shown.length} de ${data.items.length}`;
      mount(itemsBox, shown.length
        ? (view.mode === "table" ? tableOf(shown) : h("div", { class: "lib-grid" }, shown.map(cardOf)))
        : emptyState("search", "Nada com esse filtro", "Tente outra palavra ou limpe a etiqueta.", h("a", { class: "btn btn-secondary btn-sm", href: "#/biblioteca" }, "Limpar filtros")));
    };
    const filterInput = h("input", { type: "search", class: "lib-filter", placeholder: "Filtrar por título, autor ou etiqueta", "aria-label": "Filtrar os artigos salvos", maxlength: "100" });
    filterInput.addEventListener("input", Lib.debounce(() => { view.text = filterInput.value; paintItems(); }, 150));
    const sortSelect = h("select", { "aria-label": "Ordenar os artigos salvos" }, Lib.LIBRARY_SORTS.map((key) => h("option", { value: key }, LIB_SORT_LABELS[key])));
    sortSelect.addEventListener("change", () => { view.sort = sortSelect.value; paintItems(); });
    const viewButtons = [["cards", "Cartões"], ["table", "Tabela"]].map(([mode, label]) => h("button", { type: "button", class: `seg-btn${view.mode === mode ? " on" : ""}`, "aria-pressed": String(view.mode === mode), onclick: (event) => {
      view.mode = mode;
      try { localStorage.setItem(LIB_VIEW_KEY, mode); } catch { /* sem armazenamento */ }
      viewButtons.forEach((button) => { const on = button === event.currentTarget; button.classList.toggle("on", on); button.setAttribute("aria-pressed", String(on)); });
      paintItems();
    } }, label));
    paintItems();

    mount($app,
      h("h1", {}, "Biblioteca"),
      h("p", { class: "lead" }, "Seus artigos com a nota de confiabilidade de cada um. Etiquete, exporte e monte listas para compartilhar."),
      stats,
      data.items.length ? h("div", { class: "lib-toolbar" },
        h("div", { class: "lib-tools" }, filterInput, sortSelect, h("div", { class: "seg", role: "group", "aria-label": "Forma de ver" }, viewButtons), countText),
        exportMenu()) : null,
      data.items.length && allTags.length ? h("div", { class: "chips", role: "group", "aria-label": "Filtrar por etiqueta" },
        h("a", { class: `chip${activeTag ? "" : " active"}`, href: "#/biblioteca" }, "Todas"),
        allTags.map((t) => h("a", { class: `chip${t === activeTag ? " active" : ""}`, href: Lib.buildHash("/biblioteca", { tag: t }) }, t))) : null,
      !data.items.length
        ? emptyState("library", "Sua biblioteca está vazia", "Salve artigos com o botão “Salvar” e eles ficam aqui, organizados em listas.", h("a", { class: "btn btn-primary", href: "#/busca" }, "Buscar artigos"))
        : itemsBox,
      h("h2", { class: "lib-h" }, "Listas de leitura"),
      h("div", { class: "shelf-new" }, listName, h("button", { type: "button", class: "btn btn-primary", onclick: createList }, icon("plus"), "Criar lista")),
      data.lists.length ? data.lists.map((list) => renderListCard(list, params))
        : h("p", { class: "muted" }, "Nenhuma lista ainda. Crie uma e adicione artigos pela página de cada artigo."),
      h("h2", { class: "lib-h" }, "Relatórios de tema"),
      reportRows(reports, () => renderLibrary(params)),
      h("h2", { class: "lib-h" }, "Análises salvas"),
      saved && saved.analyses.length
        ? h("ul", { class: "analysis-list" }, saved.analyses.map((item) => analysisRow(item, { showTitle: true, onChange: () => renderLibrary(params) })))
        : h("p", { class: "muted" }, "Nenhuma análise salva ainda. No Laboratório de IA, clique em \"Salvar no artigo\" depois de gerar uma análise."));
  }

  // listas abertas sobrevivem aos redesenhos da biblioteca (tirar artigo, compartilhar...)
  const openLists = new Set();

  function renderListCard(list, params) {
    const linkBox = h("div", { class: "stack" });
    const showLink = (token) => {
      const url = `${location.origin}/#/lista/${token}`;
      mount(linkBox, h("div", { class: "citation" }, url),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-sm btn-secondary", onclick: () => copyText(url, "Link copiado") }, "Copiar link"),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: async () => {
            if (await guarded(() => api(`/api/lists/${list.id}/share`, { method: "DELETE" }))) { toast("Compartilhamento desativado"); renderLibrary(params); }
          } }, "Desativar link"),
          h("span", { class: "note" }, "Qualquer pessoa com o link pode ver esta lista (somente leitura).")));
    };
    if (list.shareToken) showLink(list.shareToken);
    const bodyId = `list-${list.id}`;
    const expanded = openLists.has(list.id);
    const toggle = h("button", { type: "button", class: "list-toggle", "aria-expanded": String(expanded), "aria-controls": bodyId },
      icon("chevron"), h("span", { class: "list-name" }, list.name),
      list.shareToken ? h("span", { class: "chip shelf-shared" }, "link ativo") : null,
      h("span", { class: "muted count" }, `${list.works.length} ${list.works.length === 1 ? "artigo" : "artigos"}`));
    const body = h("div", { id: bodyId, class: "list-body stack", hidden: expanded ? null : "" },
      list.works.length ? h("ul", { class: "list-items" }, list.works.map((w) => h("li", {},
        h("a", { href: articleHref(w) }, w.title),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Tirar ${w.title} da lista`, onclick: async () => {
          if (await guarded(() => api(`/api/lists/${list.id}/items?ref=${encodeURIComponent(w.ref)}`, { method: "DELETE" }))) renderLibrary(params);
        } }, "Tirar")))) : h("p", { class: "muted" }, "Lista vazia."),
      h("div", { class: "row list-actions" },
        h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: !list.works.length, onclick: async () => {
          const shared = await guarded(() => api(`/api/lists/${list.id}/share`, { method: "POST", body: {} }));
          if (shared) { showLink(shared.token); copyText(`${location.origin}/#/lista/${shared.token}`, "Link copiado"); }
        } }, "Compartilhar por link"),
        h("button", { type: "button", class: "btn btn-secondary btn-sm", disabled: !list.works.length, onclick: () => createReportFromList(list) }, "Criar relatório"),
        list.works.length ? exportMenu(list.id) : null,
        h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: async () => {
          if (await guarded(() => api(`/api/lists/${list.id}`, { method: "DELETE" }))) renderLibrary(params);
        } }, "Excluir lista")),
      linkBox);
    toggle.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) openLists.add(list.id); else openLists.delete(list.id);
    });
    return h("section", { class: "list-block" }, h("span", { class: "shelf-fan", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("h3", {}, toggle), body);
  }

  // cartões da situação no Brasil (artigo e relatório): dados oficiais locais, sem IA
  const METHODS = { sinonimo: "sinônimo conhecido", cognato: "nome parecido" };
  const CATEGORY_PLURAL = { Genérico: "genéricos", Similar: "similares", Novo: "novos", Biológico: "biológicos", Específico: "específicos", Fitoterápico: "fitoterápicos", Dinamizado: "dinamizados", Radiofármaco: "radiofármacos" };
  const fmtDate = (iso) => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR"); };
  const fmtMonth = (ym) => (/^\d{4}-\d{2}$/.test(ym) ? `${ym.slice(5)}/${ym.slice(0, 4)}` : "");
  function conitecRows(records) {
    const rowFor = (r) => h("li", { class: "conitec-row" },
      h("div", {}, h("strong", {}, `${r.year || "—"} · ${r.recommendation || "—"}`),
        r.decisionMs && r.decisionMs !== r.recommendation ? h("span", { class: "muted" }, ` · decisão do MS: ${r.decisionMs}`) : null),
      r.indication ? h("p", { class: "conitec-indication" }, r.indication.length > 160 ? `${r.indication.slice(0, 157)}…` : r.indication) : null,
      h("small", { class: "muted" }, [r.ordinance, r.publishedAt ? fmtDate(r.publishedAt) : "", r.technicalReport ? `Relatório técnico ${r.technicalReport}` : ""].filter(Boolean).join(" · ")));
    const first = records.slice(0, 3);
    const rest = records.slice(3);
    return [h("ul", { class: "plain-list" }, first.map(rowFor)),
      rest.length ? h("details", { class: "more-records" }, h("summary", {}, `Ver as outras ${rest.length} decisões`), h("ul", { class: "plain-list" }, rest.map(rowFor))) : null];
  }
  function anvisaSummary(s) {
    const cats = Object.entries(s.categories).slice(0, 4).map(([name, n]) => `${Lib.formatCount(n)} ${CATEGORY_PLURAL[name] || name.toLowerCase()}`).join(" · ");
    return h("li", { class: "anvisa-row" },
      h("div", {}, h("strong", {}, `${s.name}: ${Lib.formatCount(s.active)} ${s.active === 1 ? "registro ativo" : "registros ativos"}`),
        s.inactive ? h("span", { class: "muted" }, ` · ${Lib.formatCount(s.inactive)} inativos`) : null),
      h("small", { class: "muted" }, [cats, s.companies ? `${s.companies} ${s.companies === 1 ? "empresa" : "empresas"}` : "",
        s.validUntil ? `validade mais distante ${fmtMonth(s.validUntil)}` : "", s.classes.length ? `classe: ${s.classes.join(", ")}` : ""].filter(Boolean).join(" · ")));
  }
  function anvisaBlock(list, key) {
    if (!list.length) return h("p", { class: "muted" }, "ANVISA: nenhum registro de medicamento com esta substância.");
    const exact = list.find((s) => s.key === key) || list[0];
    const others = list.filter((s) => s !== exact);
    return [h("h5", {}, "Registro na ANVISA"), h("ul", { class: "plain-list" }, anvisaSummary(exact)),
      others.length ? h("details", { class: "more-records" }, h("summary", {}, `Associações e outras formas (${others.length})`), h("ul", { class: "plain-list" }, others.map(anvisaSummary))) : null];
  }
  function renameSummary(r) {
    const rows = r.presentations.map((a) => h("li", {}, `${a.text} · ${a.component}`, h("span", { class: "muted" }, ` (p. ${a.page} do PDF)`)));
    const more = r.totalPresentations - r.presentations.length;
    return h("li", { class: "anvisa-row" },
      h("div", {}, h("strong", {}, `${r.name}: consta na Rename 2024`), h("span", { class: "muted" }, ` · componente ${r.components.join(", ").toLowerCase()}`)),
      h("details", { class: "more-records" }, h("summary", {}, `Apresentações listadas (${r.totalPresentations})`),
        h("ul", { class: "plain-list" }, rows, more > 0 ? h("li", { class: "muted" }, `e mais ${more} no PDF`) : null)));
  }
  function renameBlock(list, key) {
    if (!list.length) return h("p", { class: "muted" }, "Rename 2024: a substância não consta na relação nacional de medicamentos essenciais.");
    const exact = list.find((r) => r.key === key) || list[0];
    const others = list.filter((r) => r !== exact);
    return [h("h5", {}, "Rename 2024 (medicamentos essenciais)"), h("ul", { class: "plain-list" }, renameSummary(exact)),
      others.length ? h("details", { class: "more-records" }, h("summary", {}, `Associações e outras formas (${others.length})`), h("ul", { class: "plain-list" }, others.map(renameSummary))) : null];
  }
  function situationBlock(item, key) {
    return [renameBlock(item.rename || [], key), anvisaBlock(item.anvisa, key),
      h("h5", {}, "Decisões da Conitec (incorporação ao SUS)"),
      item.conitec.length ? conitecRows(item.conitec) : h("p", { class: "muted" }, "A Conitec não tem decisão registrada para esta substância.")];
  }

  // ------------------------------------------------------------------ perfil de uso
  // O perfil só escolhe o que fica em destaque e liga o pacote "Saúde no Brasil"; nenhuma função do núcleo é bloqueada.
  const showHealth = () => session.healthPack !== false;
  const PROFILE_SHORTCUTS = {
    estudante: [["Procurar artigos para o seu trabalho", "#/busca"], ["Montar uma lista e criar o relatório de tema", "#/biblioteca"], ["Exportar as referências em ABNT, APA ou Vancouver", "#/biblioteca"]],
    pesquisador: [["Acompanhar temas e receber avisos de artigos novos", "#/perfil/interesses"], ["Levar as referências para o Zotero, Mendeley ou EndNote", "#/biblioteca"], ["Criar um relatório de tema com o método declarado", "#/biblioteca"]],
    saude: [["Ver a situação de um medicamento no Brasil (ANVISA, Conitec, Rename)", Lib.buildHash("/busca", { q: "metformina" })], ["Acompanhar especialidades e receber avisos", "#/perfil/interesses"], ["Criar um relatório com a situação regulatória dos medicamentos", "#/biblioteca"]],
    consultoria: [["Criar um relatório de tema com método e histórico", "#/biblioteca"], ["Acompanhar os temas dos seus clientes", "#/perfil/interesses"], ["Exportar as referências para o cliente", "#/biblioteca"]],
  };
  const PROFILE_SKIP_KEY = () => `nexus.profile.skip:${session.user}`;
  let profileOptionsPromise;
  const loadProfileOptions = () => {
    profileOptionsPromise ||= api("/api/profile/options").catch((error) => { profileOptionsPromise = undefined; throw error; });
    return profileOptionsPromise;
  };

  function profileShortcuts() {
    const items = session.user && PROFILE_SHORTCUTS[session.profile];
    if (!items) return null;
    return h("section", { class: "home-section profile-shortcuts", "aria-labelledby": "para-voce" },
      h("p", { class: "eyebrow" }, "Para você"),
      h("h2", { id: "para-voce" }, "Por onde começar"),
      h("ul", { class: "plain-list shortcut-list" }, items.map(([label, href]) => h("li", {}, h("a", { href }, label)))),
      h("p", { class: "note" }, h("a", { href: "#/perfil/uso" }, "Mudar perfil e preferências")));
  }

  /** Formulário do perfil (usado na pergunta da primeira entrada e na tela de perfil). */
  function profileForm({ onSaved, onSkip } = {}) {
    const box = h("div", { class: "stack" }, loading());
    loadProfileOptions().then(({ profiles }) => {
      let chosen = session.profile || "";
      const healthBox = h("input", { type: "checkbox", id: "profile-health" });
      healthBox.checked = session.healthPack !== false;
      const group = h("div", { class: "stack", role: "radiogroup", "aria-label": "O que você faz" });
      const paintGroup = () => mount(group, profiles.map((p) => {
        const input = h("input", { type: "radio", name: "profile", id: `profile-${p.key}`, value: p.key });
        input.checked = chosen === p.key;
        input.addEventListener("change", () => { chosen = p.key; healthBox.checked = p.healthPack; paintGroup(); });
        return h("label", { class: `profile-option${chosen === p.key ? " is-chosen" : ""}`, for: `profile-${p.key}` }, input,
          h("span", {}, h("strong", {}, p.label), h("small", { class: "muted" }, p.description)));
      }));
      paintGroup();
      const status = h("p", { class: "note", role: "status" });
      const save = h("button", { type: "button", class: "btn btn-primary" }, "Salvar");
      save.addEventListener("click", async () => {
        if (!chosen) { status.textContent = "Escolha uma das opções."; return; }
        save.disabled = true;
        const saved = await guarded(() => api("/api/profile", { method: "PUT", body: { profile: chosen, healthPack: healthBox.checked } }));
        save.disabled = false;
        if (!saved) return;
        session.profile = saved.profile;
        session.healthPack = saved.healthPack;
        toast("Perfil salvo.");
        if (onSaved) onSaved(saved);
      });
      mount(box, group,
        h("label", { class: "report-include", for: "profile-health" }, healthBox,
          h("span", {}, h("strong", {}, "Mostrar a situação de medicamentos no Brasil"), h("small", { class: "muted" }, " ANVISA, Conitec e Rename, nos artigos e nos relatórios"))),
        status,
        h("div", { class: "row" }, save, onSkip ? h("button", { type: "button", class: "btn btn-ghost", onclick: onSkip }, "Agora não") : null));
    }).catch(() => mount(box, errorBox("Não foi possível carregar as opções agora.")));
    return box;
  }

  function askProfile() {
    if (!session.user || session.profile) return;
    try { if (localStorage.getItem(PROFILE_SKIP_KEY())) return; } catch { /* modo privado: pergunta de novo */ }
    if (document.getElementById("profile-dialog")) return;
    const dialogEl = h("dialog", { id: "profile-dialog", "aria-labelledby": "profile-title" });
    const close = () => { dialogEl.close(); dialogEl.remove(); };
    dialogEl.addEventListener("close", () => dialogEl.remove());
    dialogEl.append(h("div", { class: "auth-card stack" },
      h("h2", { id: "profile-title" }, "Como você vai usar o Nexus Science?"),
      h("p", { class: "hint" }, "Isso só escolhe o que fica em destaque. Você pode mudar quando quiser em Perfil e preferências, e nada fica bloqueado."),
      profileForm({
        onSaved: () => { close(); render(); },
        onSkip: () => { try { localStorage.setItem(PROFILE_SKIP_KEY(), "1"); } catch { /* sem armazenamento */ } close(); },
      })));
    document.body.append(dialogEl);
    if (typeof dialogEl.showModal === "function") dialogEl.showModal();
  }

  async function syncProfile() {
    if (!session.user) { session.profile = ""; session.healthPack = true; profileLink.hidden = true; return; }
    profileLink.hidden = false;
    try {
      const data = await api("/api/profile");
      session.profile = data.profile || "";
      session.healthPack = data.healthPack;
    } catch { return; }
    askProfile();
    render();
  }

  // ------------------------------------------------------------------ Feed de novidades acadêmicas
  const FEED_REFRESH_MS = 8000;
  const FEED_MAX_RETRIES = 4;
  let feedAreasPromise;
  const loadFeedAreas = () => {
    feedAreasPromise ||= api("/api/interests/options").then((data) => data.areas).catch(() => { feedAreasPromise = undefined; return []; });
    return feedAreasPromise;
  };

  function feedWhen(item) {
    if (!item.dateKnown) return "data não informada";
    const hours = Math.floor((Date.now() - new Date(item.publishedAt).getTime()) / 3600000);
    if (hours < 1) return "agora há pouco";
    if (hours < 24) return `há ${hours} h`;
    if (hours < 48) return "ontem";
    return fmtDate(item.publishedAt.slice(0, 10));
  }

  const hueOf = (text) => { let sum = 0; for (const char of String(text)) sum = (sum * 31 + char.codePointAt(0)) % 360; return sum; };
  const initials = (name) => String(name).split(/[\s.\-/]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");

  function feedCard(item, { featured = false, filterArea = "" } = {}) {
    const internal = item.internal === true;
    // com um filtro de area ativo, a capa usa a area filtrada (nao a primeira da lista), para o cartao combinar com o filtro
    const area = Lib.feedArea(filterArea && (item.areaKeys || []).includes(filterArea) ? [filterArea] : item.areaKeys);
    const hours = item.dateKnown ? (Date.now() - new Date(item.publishedAt).getTime()) / 3600000 : Infinity;
    const attrs = internal ? { href: item.url } : { href: item.url, target: "_blank", rel: "noopener noreferrer nofollow" };
    const link = h("a", attrs, item.title);
    const coverIcon = icon(`area-${area}`);
    coverIcon.classList.add("feed-cover-icon");
    const avatar = h("span", { class: "feed-avatar", "aria-hidden": "true" }, initials(item.source.name));
    avatar.style.setProperty("--hue", String(hueOf(item.source.id || item.source.name)));
    return h("article", { class: `feed-card area-${area}${featured ? " is-featured" : ""}` },
      h("a", { class: "feed-cover", ...attrs, tabindex: "-1", "aria-hidden": "true" },
        coverIcon,
        h("span", { class: `feed-tier tier-${item.source.tier}` }, item.source.tierLabel),
        hours < 6 ? h("span", { class: "feed-new" }, "Novo") : null),
      h("div", { class: "feed-body" },
        h("div", { class: "feed-meta" }, avatar,
          h("span", { class: "feed-source" }, item.source.name),
          h("span", { class: "muted" }, ` · ${feedWhen(item)}`, item.source.language && !["pt", "un"].includes(item.source.language) ? ` · ${item.source.language.toUpperCase()}` : "")),
        h("h3", {}, link, internal ? null : icon("external")),
        item.snippet ? h("p", { class: "feed-snippet" }, item.snippet) : null,
        item.matched.length ? h("div", { class: "chips" }, item.matched.map((m) => h("span", { class: "chip" }, m))) : null,
        internal ? h("a", { class: "feed-open", href: item.url }, "Ver o artigo e a nota de confiabilidade")
          : h("a", { class: "feed-open", ...attrs }, `Ler em ${item.source.name}`, icon("external"))));
  }

  async function renderFeed(params) {
    setTitle("Feed");
    const state = {
      mode: params.get("modo") === "tudo" ? "tudo" : "voce", kind: ["artigos", "noticias"].includes(params.get("tipo")) ? params.get("tipo") : "todos",
      area: (params.get("area") || "").replace(/[^a-z-]/g, "").slice(0, 30), lang: ["pt", "en"].includes(params.get("lang")) ? params.get("lang") : "",
    };
    const go = (changes) => { location.hash = Lib.buildHash("/feed", { modo: state.mode === "tudo" ? "tudo" : "", tipo: state.kind === "todos" ? "" : state.kind, area: state.area, lang: state.lang, ...changes }); };
    const list = h("div", { class: "feed-list", "aria-live": "polite" });
    const more = h("div", { class: "row feed-more" });
    const status = h("p", { class: "note" });
    const controls = h("div", { class: "feed-controls card" });
    mount($app, h("h1", {}, "Feed"),
      h("p", { class: "lead" }, "Novidades de revistas, instituições de pesquisa e divulgação científica, em todas as áreas do conhecimento. Ao clicar, você vai para a fonte."),
      controls, list, more, status, feedSourcesPanel());

    const areas = await loadFeedAreas();
    let page = 1;
    let retries = 0;
    let hasInterests = false;
    let loadingMore = false;
    let loadNext = null;
    // rolar perto do fim carrega a próxima página sozinho (o botão "Carregar mais" continua como alternativa)
    const autoMore = () => {
      if (!more.isConnected || !location.hash.startsWith("#/feed")) { window.removeEventListener("scroll", autoMore); return; }  // outra tela ou outra versão do feed
      if (loadNext && !loadingMore && more.getBoundingClientRect().top < window.innerHeight + 600) loadNext();
    };
    window.addEventListener("scroll", autoMore, { passive: true });
    const chip = (label, active, onclick) => h("button", { type: "button", class: "pick", "aria-pressed": String(active), onclick }, label);
    const paintControls = () => mount(controls,
      hasInterests ? h("div", { class: "pick-row", role: "group", "aria-label": "Mostrar" },
        chip("Para você", state.mode === "voce", () => go({ modo: "" })), chip("Tudo", state.mode === "tudo", () => go({ modo: "tudo" }))) : null,
      h("div", { class: "pick-row", role: "group", "aria-label": "Tipo" },
        [["todos", "Tudo"], ["artigos", "Artigos"], ["noticias", "Notícias"]].map(([key, label]) => chip(label, state.kind === key, () => go({ tipo: key === "todos" ? "" : key })))),
      h("div", { class: "area-pills", role: "group", "aria-label": "Área do conhecimento" },
        h("button", { type: "button", class: "area-pill", "aria-pressed": String(!state.area), onclick: () => go({ area: "" }) }, "Todas as áreas"),
        areas.map((a) => h("button", { type: "button", class: `area-pill area-${Lib.feedArea([a.key])}`, "aria-pressed": String(a.key === state.area), onclick: () => go({ area: a.key }) },
          icon(`area-${Lib.feedArea([a.key])}`), a.label))),
      h("div", { class: "row" },
        h("select", { "aria-label": "Idioma", onchange: (event) => go({ lang: event.target.value }) },
          [["", "Qualquer idioma"], ["pt", "Português"], ["en", "Inglês"]].map(([value, label]) => h("option", { value, selected: value === state.lang ? "" : null }, label)))));

    async function load(reset) {
      if (reset) { page = 1; mount(list, skeleton("card", 6, "Carregando as novidades…")); mount(more); }
      const query = new URLSearchParams({ mode: state.mode, kind: state.kind, page: String(page) });
      if (state.area) query.set("area", state.area);
      if (state.lang) query.set("lang", state.lang);
      let data;
      try { data = await api(`/api/feed?${query}`); } catch (error) { mount(list, errorBox(error.message)); return; }
      hasInterests = data.hasInterests;
      paintControls();
      if (reset) mount(list);
      list.append(...data.items.map((item, index) => feedCard(item, { featured: reset && index === 0, filterArea: state.area })));
      if (!list.children.length) {
        if (data.refreshing && retries < FEED_MAX_RETRIES) {
          mount(list, loading("Buscando as primeiras novidades nas fontes (pode levar cerca de um minuto)…"));
          retries += 1;
          setTimeout(() => { if (location.hash.startsWith("#/feed")) load(true); }, FEED_REFRESH_MS);
          return;
        }
        mount(list, emptyState("feed", data.personalized ? "Nada novo nos seus interesses" : "Nenhuma novidade com esses filtros", data.personalized ? "Quando as fontes publicarem algo sobre o que você acompanha, aparece aqui." : "Tente outra área ou idioma.",
          data.personalized ? h("button", { type: "button", class: "btn btn-secondary", onclick: () => go({ modo: "tudo" }) }, "Ver tudo") : null,
          session.user && !data.hasInterests ? h("a", { class: "btn btn-primary", href: "#/perfil/interesses" }, "Escolher interesses") : null,
          !session.user ? h("button", { type: "button", class: "btn btn-primary", onclick: () => openAuth("Entre para ver o feed dos seus interesses.") }, "Entrar") : null));
      }
      const next = () => { if (loadingMore) return; loadingMore = true; page += 1; load(false).finally(() => { loadingMore = false; if (document.documentElement.scrollHeight < window.innerHeight * 2) autoMore(); }); };
      mount(more, data.hasMore ? h("button", { type: "button", class: "btn btn-secondary", onclick: next }, "Carregar mais") : null);
      loadNext = data.hasMore ? next : null;
      status.textContent = data.updatedAt ? `Fontes atualizadas pela última vez em ${fmtDate(data.updatedAt.slice(0, 10))}.` : "";
      if (!session.user) status.append(" Entre na sua conta para ver só o que combina com os seus interesses.");
    }
    paintControls();
    load(true);
  }

  function feedSourcesPanel() {
    const body = h("div", { class: "stack" });
    let loaded = false;
    const details = h("details", { class: "more-records feed-sources" }, h("summary", {}, "Fontes e critérios do feed"), body);
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded) return;
      loaded = true;
      mount(body, loading());
      let data;
      try { data = await api("/api/feed/sources"); } catch { loaded = false; mount(body, h("p", { class: "muted" }, "Não foi possível carregar as fontes agora.")); return; }
      mount(body,
        h("p", { class: "note" }, "O feed mostra só o título, um trecho curto e o link: o conteúdo é da fonte, e você é levado a ela ao clicar. Notícias e comunicados não passam pela nota de confiabilidade dos artigos. O tipo da fonte ajuda a julgar:"),
        h("ul", { class: "plain-list" }, data.tiers.map((t) => h("li", {}, h("strong", {}, `${t.label}: `), t.description))),
        h("ul", { class: "plain-list feed-source-list" }, data.sources.map((s) => h("li", {},
          h("a", { href: s.site, target: "_blank", rel: "noopener noreferrer" }, s.name),
          h("small", { class: "muted" }, ` · ${s.tierLabel} · ${s.language.toUpperCase()} · ${s.areas.join(", ")}${s.failing ? " · fora do ar na última busca" : ""}`)))));
    });
    return details;
  }

  // ------------------------------------------------------------------ aba Perfil (visão geral, perfil de uso, interesses, conta e dados)
  const PROFILE_SECTIONS = [["", "Visão geral"], ["uso", "Perfil de uso"], ["interesses", "Interesses e alertas"], ["notificacoes", "Notificações"], ["assinatura", "Assinatura"], ["conta", "Conta e dados"]];

  function profileTabs(active) {
    return h("nav", { class: "profile-tabs", "aria-label": "Seções do perfil" }, PROFILE_SECTIONS.map(([key, label]) =>
      h("a", { class: "profile-tab", href: key ? `#/perfil/${key}` : "#/perfil", "aria-current": key === active ? "page" : null }, label)));
  }

  async function profileOverview(content) {
    mount(content, loading());
    const [account, options] = await Promise.all([guarded(() => api("/api/account")), loadProfileOptions().catch(() => ({ profiles: [] }))]);
    if (!account) { mount(content, errorBox("Não foi possível carregar o seu perfil agora.")); return; }
    const chosen = options.profiles.find((p) => p.key === (account.profile && account.profile.profile));
    const since = account.createdAt ? fmtDate(account.createdAt.slice(0, 10)) : "";
    const stat = (value, label, href) => {
      const number = h("strong", {}, Lib.formatCount(value));
      if (value > 0 && value < 1000) { number.textContent = "0"; countTo(number, value); }  // conta de zero ao valor
      return h("a", { class: "account-stat", href }, number, h("span", {}, label));
    };
    const interests = account.interests || {};
    const checked = interests.lastChecked ? fmtDate(interests.lastChecked.slice(0, 10)) : "";
    mount(content,
      h("section", { class: "card account-head" },
        h("span", { class: "avatar", "aria-hidden": "true" }, (account.name || account.email).slice(0, 1).toUpperCase()),
        h("div", {}, h("strong", { class: "account-email" }, account.name || account.email), account.name ? h("p", { class: "muted" }, account.email) : null, since ? h("p", { class: "muted" }, `Membro desde ${since}`) : null)),
      h("div", { class: "account-stats" },
        stat(account.counts.library, account.counts.library === 1 ? "artigo salvo" : "artigos salvos", "#/biblioteca"),
        stat(account.counts.lists, account.counts.lists === 1 ? "lista" : "listas", "#/biblioteca"),
        stat(account.counts.reports, account.counts.reports === 1 ? "relatório" : "relatórios", "#/biblioteca"),
        stat(account.counts.analyses, account.counts.analyses === 1 ? "análise salva" : "análises salvas", "#/biblioteca")),
      h("section", { class: "card stack" }, h("h2", {}, "Perfil de uso"),
        chosen ? h("p", {}, h("strong", {}, chosen.label), h("span", { class: "muted" }, ` · pacote Saúde no Brasil ${account.profile.healthPack ? "ligado" : "desligado"}`))
          : h("p", { class: "muted" }, "Você ainda não escolheu. Isso só define o que fica em destaque; nada é bloqueado."),
        h("div", { class: "row" }, h("a", { class: "btn btn-secondary btn-sm", href: "#/perfil/uso" }, chosen ? "Alterar" : "Escolher"))),
      h("section", { class: "card stack" }, h("h2", {}, "Interesses e alertas"),
        interests.topics || interests.terms
          ? h("p", {}, `${interests.topics} ${interests.topics === 1 ? "tema" : "temas"}, ${interests.terms} ${interests.terms === 1 ? "palavra-chave" : "palavras-chave"}`,
            h("span", { class: "muted" }, ` · ${interests.unread} ${interests.unread === 1 ? "aviso não lido" : "avisos não lidos"}${checked ? ` · última verificação em ${checked}` : ""}`))
          : h("p", { class: "muted" }, "Você ainda não escolheu o que acompanhar. Escolha áreas, subtemas e idiomas e avisamos quando sair artigo novo."),
        h("div", { class: "row" }, h("a", { class: "btn btn-secondary btn-sm", href: "#/perfil/interesses" }, interests.topics || interests.terms ? "Gerenciar" : "Escolher interesses"))),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-outline", onclick: () => logoutButton.click() }, "Sair da conta")));
  }

  async function profileNotifications(content) {
    mount(content, loading());
    const data = await guarded(() => api("/api/notifications/prefs"));
    if (!data) { mount(content, errorBox("Não foi possível carregar as notificações agora.")); return; }
    const rows = data.kinds.map((kind) => {
      const input = h("input", { type: "checkbox", id: `notif-${kind.key}` });
      input.checked = kind.enabled;
      input.addEventListener("change", async () => {
        const saved = await guarded(() => api("/api/notifications/prefs", { method: "PUT", body: { kinds: { [kind.key]: input.checked } } }));
        if (saved) toast(input.checked ? `Avisos de “${kind.label}” ligados.` : `Avisos de “${kind.label}” desligados.`);
        else input.checked = !input.checked;
      });
      return h("label", { class: "profile-option", for: `notif-${kind.key}` }, input,
        h("span", {}, h("strong", {}, kind.label, kind.priority >= 2 ? h("span", { class: "alert-kind" }, "Importante") : null), h("small", { class: "muted" }, kind.description)));
    });
    mount(content,
      h("p", { class: "lead" }, "Escolha o que aparece no sininho. Por enquanto o aviso chega só no site; e-mail e outros canais virão depois."),
      h("section", { class: "card stack" }, h("h2", {}, "O que avisar"), rows),
      h("section", { class: "card stack" }, h("h2", {}, "Como funciona"),
        h("ul", { class: "plain-list" },
          h("li", {}, "As verificações rodam quando você abre o site, no máximo a cada 6 horas."),
          h("li", {}, "Retratação: cada artigo que você guarda (biblioteca, listas e relatórios) é reconferido na fonte uma vez por semana. Só detectamos quando a fonte informa (Europe PMC, PubMed e OpenAlex); correções não são detectadas."),
          h("li", {}, "Mudança regulatória: vale para as substâncias que você confirmou em relatórios. Comparamos com o que havia na última verificação."),
          h("li", {}, "O primeiro aviso de cada tipo só guarda o estado de hoje; você é avisado do que mudar depois.")),
        h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => runCheck(true) }, "Verificar agora"))));
  }

  function profileUse(content) {
    mount(content,
      h("p", { class: "lead" }, "Diga o que você faz para destacarmos as ferramentas certas na página inicial e ligar ou desligar o pacote de saúde. Nada do núcleo (busca, biblioteca, alertas, relatórios e exportação) é bloqueado por esta escolha."),
      h("section", { class: "card stack" }, profileForm({ onSaved: () => renderProfile("uso") })));
  }

  function profileAccount(content) {
    const passwordStatus = h("p", { class: "note", role: "status" });
    const field = (id, label, autocomplete) => {
      const input = h("input", { type: "password", id, autocomplete, maxlength: "128", required: "" });
      return [h("div", { class: "field" }, h("label", { for: id }, label), input), input];
    };
    const [currentField, currentInput] = field("pw-current", "Senha atual", "current-password");
    const [newField, newInput] = field("pw-new", "Nova senha (mínimo de 8 caracteres)", "new-password");
    const [repeatField, repeatInput] = field("pw-repeat", "Repita a nova senha", "new-password");
    const saveButton = h("button", { type: "submit", class: "btn btn-primary" }, "Trocar senha");
    const passwordForm = h("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      passwordStatus.textContent = "";
      if (newInput.value !== repeatInput.value) { passwordStatus.textContent = "As senhas novas não são iguais."; return; }
      saveButton.disabled = true;
      try {
        await api("/api/account/password", { method: "POST", body: { current: currentInput.value, new: newInput.value } });
        passwordForm.reset();
        toast("Senha alterada.");
        passwordStatus.textContent = "Senha alterada. Outros aparelhos já conectados continuam conectados até a sessão expirar (7 dias).";
      } catch (error) { passwordStatus.textContent = error.message; } finally { saveButton.disabled = false; }
    } }, currentField, newField, repeatField, passwordStatus, h("div", { class: "row" }, saveButton));

    const deleteBox = h("div", { class: "stack" });
    const showDelete = () => {
      const input = h("input", { type: "password", id: "delete-password", autocomplete: "current-password", maxlength: "128", "aria-label": "Sua senha, para confirmar" });
      const status = h("p", { class: "note", role: "alert" });
      const confirmButton = h("button", { type: "button", class: "btn btn-danger" }, "Excluir definitivamente");
      confirmButton.addEventListener("click", async () => {
        if (!input.value) { status.textContent = "Digite a sua senha para confirmar."; input.focus(); return; }
        confirmButton.disabled = true;
        try {
          await api("/api/account", { method: "DELETE", body: { password: input.value } });
          setUser("");
          toast("Conta excluída.");
          location.hash = "#/";
          render();
        } catch (error) { status.textContent = error.message; confirmButton.disabled = false; }
      });
      mount(deleteBox,
        h("p", { class: "note" }, "Isso apaga a conta e tudo o que ela guardou, sem volta. Baixe os seus dados antes, se quiser."),
        h("div", { class: "field" }, h("label", { for: "delete-password" }, "Sua senha"), input), status,
        h("div", { class: "row" }, confirmButton, h("button", { type: "button", class: "btn btn-ghost", onclick: () => mount(deleteBox, startDelete) }, "Cancelar")));
      input.focus();
    };
    const startDelete = h("button", { type: "button", class: "btn btn-outline btn-danger-outline", onclick: showDelete }, "Excluir minha conta…");
    mount(deleteBox, startDelete);

    const emailBox = h("div", { class: "stack" }, h("p", { class: "muted" }, "Carregando…"));
    api("/api/account").then((account) => {
      if (account.emailVerified === null || account.emailVerified === undefined) { emailBox.remove(); return; }
      const resend = h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: async () => {
        resend.disabled = true;
        try {
          const result = await api("/api/account/resend-verification", { method: "POST", body: {} });
          toast(result.sent ? "Enviamos um novo link para o seu e-mail." : result.alreadyVerified ? "Seu e-mail já está confirmado." : "Aguarde um minuto para pedir outro link.");
        } catch (error) { toast(error.message); } finally { resend.disabled = false; }
      } }, "Reenviar e-mail de confirmação");
      mount(emailBox,
        h("p", {}, h("strong", {}, account.email), " ", h("span", { class: account.emailVerified ? "mail-state is-ok" : "mail-state" }, account.emailVerified ? "Confirmado" : "Não confirmado")),
        account.emailVerified ? h("p", { class: "note" }, "Usamos o seu e-mail para recuperar a senha e, no futuro, para os avisos por e-mail.")
          : h("p", { class: "note" }, account.emailEnabled ? "Confirme o seu e-mail pelo link que enviamos ao se cadastrar. Ele também permite recuperar a senha." : "O envio de e-mails não está ativo neste ambiente."),
        !account.emailVerified && account.emailEnabled ? h("div", { class: "row" }, resend) : null);
    }).catch(() => emailBox.remove());

    const nameInputField = h("input", { type: "text", id: "profile-name", autocomplete: "given-name", maxlength: "60", value: session.name });
    const nameStatus = h("p", { class: "note", role: "status" });
    const nameForm = h("form", { class: "stack", onsubmit: async (event) => {
      event.preventDefault();
      nameStatus.textContent = "";
      try {
        const result = await api("/api/account/name", { method: "PUT", body: { name: nameInputField.value } });
        session.name = result.name;
        nameInputField.value = result.name;
        nameStatus.textContent = "Nome salvo.";
      } catch (error) { nameStatus.textContent = error.message; }
    } }, h("div", { class: "field" }, h("label", { for: "profile-name" }, "Como podemos te chamar?"), nameInputField), nameStatus,
      h("div", { class: "row" }, h("button", { type: "submit", class: "btn btn-primary" }, "Salvar nome")));

    mount(content,
      h("section", { class: "card stack" }, h("h2", {}, "Nome"), nameForm),
      h("section", { class: "card stack" }, h("h2", {}, "E-mail"), emailBox),
      h("section", { class: "card stack" }, h("h2", {}, "Senha"), passwordForm),
      h("section", { class: "card stack" }, h("h2", {}, "Seus dados"),
        h("p", {}, "Baixe uma cópia de tudo o que a sua conta guarda: biblioteca, listas, análises salvas, relatórios, interesses, avisos e perfil. A senha não entra no arquivo."),
        h("div", { class: "row" }, h("a", { class: "btn btn-secondary", href: "/api/account/export", download: "" }, icon("download"), "Baixar meus dados (JSON)"))),
      h("section", { class: "card stack danger-zone" }, h("h2", {}, "Excluir conta"),
        h("p", {}, "Apaga a conta e todos os dados dela: biblioteca, listas (inclusive os links compartilhados), análises salvas, relatórios, interesses, avisos e perfil. Não há como desfazer."),
        deleteBox));
  }

  function renderProfile(section = "") {
    const active = PROFILE_SECTIONS.some(([key]) => key === section) ? section : "";
    setTitle(active ? `Perfil: ${PROFILE_SECTIONS.find(([key]) => key === active)[1]}` : "Perfil");
    if (!session.user) {
      mount($app, h("h1", {}, "Perfil"), emptyState("lock", "Entre para ver seu perfil", "Aqui você escolhe interesses, gerencia seus dados e acompanha seu plano.",
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openAuth("Entre para acessar o seu perfil.") }, "Entrar")));
      return;
    }
    const content = h("div", { class: "stack profile-content" });
    mount($app, h("h1", {}, "Perfil"), profileTabs(active), content);
    if (active === "uso") profileUse(content);
    else if (active === "interesses") renderInterests(content);
    else if (active === "notificacoes") profileNotifications(content);
    else if (active === "assinatura") profileSubscription(content);
    else if (active === "conta") profileAccount(content);
    else profileOverview(content);
  }

  // ------------------------------------------------------------------ Relatório de tema
  const REPORT_DOWNLOADS = [["PDF (.pdf)", "pdf"], ["Word (.docx)", "docx"], ["Página web (.html)", "html"], ["Markdown (.md)", "md"]];

  async function createReportFromList(list) {
    const created = await guarded(() => api("/api/reports", { method: "POST", body: { list_id: list.id } }));
    if (created) { toast("Relatório criado. Revise os estudos e o método."); location.hash = `#/relatorio/${created.id}`; }
  }

  function reportRows(reports, onChange) {
    if (!reports || !reports.reports.length) return h("p", { class: "muted" }, "Nenhum relatório ainda. Abra uma lista e clique em “Criar relatório”.");
    return h("ul", { class: "analysis-list" }, reports.reports.map((r) => h("li", { class: "analysis-item" },
      h("a", { href: `#/relatorio/${r.id}`, class: "analysis-article" }, r.title),
      h("small", { class: "muted" }, `${r.included} de ${r.total} estudos · versão ${r.version} · lista “${r.listName}” · ${fmtDate(r.updatedAt.slice(0, 10))}`),
      h("div", { class: "row" },
        h("a", { class: "btn btn-sm btn-secondary", href: `#/relatorio/${r.id}` }, "Abrir"),
        h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Excluir o relatório ${r.title}`, onclick: async () => {
          if (await guarded(() => api(`/api/reports/${r.id}`, { method: "DELETE" }))) { toast("Relatório excluído."); onChange(); }
        } }, "Excluir")))));
  }

  // seção "Situação no Brasil" do relatório: o autor confirma as substâncias; os cartões vêm das bases oficiais locais
  const MAX_REPORT_SUBSTANCES = 10;
  const plainTerm = (text) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  function reportBrasil(reportId, initial) {
    const box = h("div", { class: "stack" }, loading("Consultando dados oficiais…"));
    const entries = new Map(); // termo -> { nome, hint }
    const picked = new Set(initial);
    const checklist = h("div", { class: "stack", role: "group", "aria-label": "Substâncias para a seção Situação no Brasil" });
    const cards = h("div", { class: "stack" });
    const note = h("p", { class: "note" });
    const manualInput = h("input", { type: "text", placeholder: "Outro medicamento (nome em português)", maxlength: "80", "aria-label": "Adicionar medicamento" });
    const manualButton = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Adicionar");

    function paintChecklist() {
      if (!entries.size) {
        mount(checklist, h("p", { class: "muted" }, "Não identificamos substâncias nos resumos dos estudos incluídos. Se o tema é um medicamento, adicione o nome abaixo."));
        return;
      }
      mount(checklist, [...entries].map(([termo, entry]) => {
        const input = h("input", { type: "checkbox", id: `sub-${termo.replace(/\W+/g, "-")}` });
        input.checked = picked.has(termo);
        input.addEventListener("change", () => {
          if (input.checked && picked.size >= MAX_REPORT_SUBSTANCES) { input.checked = false; toast(`Escolha no máximo ${MAX_REPORT_SUBSTANCES} substâncias.`); return; }
          if (input.checked) picked.add(termo); else picked.delete(termo);
        });
        return h("label", { class: "report-include", for: input.id }, input, h("span", {}, h("strong", {}, entry.nome), h("small", { class: "muted" }, ` · ${entry.hint}`)));
      }));
    }

    async function load() {
      let data;
      try { data = await api(`/api/reports/${encodeURIComponent(reportId)}/brasil`); } catch {
        mount(box, h("p", { class: "muted" }, "Os dados oficiais do Brasil não estão disponíveis agora. O relatório pode ser salvo sem esta seção."));
        return;
      }
      for (const s of data.suggestions) {
        entries.set(s.termo, { nome: s.nome, hint: `citada em ${s.studies} ${s.studies === 1 ? "estudo" : "estudos"}; no texto: ${s.en} (${METHODS[s.metodo] || s.metodo}). Confirme` });
      }
      picked.clear();
      for (const c of data.confirmed) {
        picked.add(c.termo);
        if (!entries.has(c.termo)) entries.set(c.termo, { nome: c.nome, hint: "confirmada por você" });
      }
      paintChecklist();
      mount(cards, data.confirmed.map((c) => h("div", { class: "conitec-drug" }, h("h4", {}, c.nome), situationBlock(c, c.termo))));
      const meta = data.meta;
      note.textContent = `Bases consultadas por código, sem IA: ANVISA (extraída em ${fmtDate(meta.anvisa.extraidoEm)}), Conitec (extraída em ${fmtDate(meta.conitec.extraidoEm)}) e Rename 2024 (extraída em ${fmtDate(meta.rename.extraidoEm)}). `
        + "Constar na Rename ou ter registro na ANVISA não significa disponibilidade na unidade de saúde. Os dados ainda não foram revisados por farmacêutico ou médico.";
      mount(box, h("p", { class: "hint" }, "Opcional, para temas de medicamento. Marque as substâncias que o relatório deve tratar: a ligação do nome é automática e só entra no documento o que você confirmar. Salve para ver a situação de cada uma."),
        checklist,
        h("div", { class: "new-list" }, manualInput, manualButton),
        data.confirmed.length ? h("h3", {}, "Como aparecerá no documento") : null, cards, note);
    }

    async function addManual() {
      const query = manualInput.value.trim();
      if (query.length < 3) { manualInput.focus(); return; }
      if (picked.size >= MAX_REPORT_SUBSTANCES) { toast(`Escolha no máximo ${MAX_REPORT_SUBSTANCES} substâncias.`); return; }
      const found = await guarded(() => api(`/api/brasil/medicamento?q=${encodeURIComponent(query)}`));
      if (!found) return;
      if (!found.rename.length && !found.anvisa.length && !found.conitec.length) { toast("Não encontramos essa substância nas bases oficiais."); return; }
      const termo = plainTerm(query);
      entries.set(termo, { nome: query, hint: "adicionada por você" });
      picked.add(termo);
      manualInput.value = "";
      paintChecklist();
    }
    manualButton.addEventListener("click", addManual);
    manualInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addManual(); } });
    load();
    return { node: box, selected: () => [...picked], reload: load };
  }

  // atualizar o relatório (novos na lista, busca de novidades) e histórico de versões
  const LANGUAGE_CHOICES = [["", "Qualquer idioma"], ["pt", "Português"], ["en", "Inglês"], ["es", "Espanhol"]];

  function reportUpdates({ reportId, data, save, rerender }) {
    const box = h("div", { class: "stack" }, loading("Carregando histórico…"));
    const newBox = h("div", { class: "stack" });
    const resultsBox = h("div", { class: "stack", "aria-live": "polite" });
    const versionsBox = h("div", { class: "stack" });
    const logBox = h("div", { class: "stack" });
    const queryInput = h("input", { type: "text", maxlength: "200", placeholder: "Tema ou palavras-chave (ex.: hipertensão e exercício)", "aria-label": "Procurar artigos novos sobre o tema" });
    const languageSelect = h("select", { "aria-label": "Idioma dos artigos" }, LANGUAGE_CHOICES.map(([value, label]) => h("option", { value }, label)));
    const yearInput = h("input", { type: "number", min: "1800", max: "2100", value: String(Math.max(1800, Number(data.createdAt.slice(0, 4)) - 1)), "aria-label": "Artigos desde o ano" });
    const searchButton = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Procurar");
    let lastQuery = "";

    // salva o que está na tela antes de mudar a lista de estudos, para não perder edições
    async function addRefs(refs, origin, query = "") {
      if (!(await save())) return;
      const result = await guarded(() => api(`/api/reports/${encodeURIComponent(reportId)}/add`, { method: "POST", body: { refs, origin, query } }));
      if (!result) return;
      toast(result.added ? `${result.added} ${result.added === 1 ? "estudo adicionado" : "estudos adicionados"} ao relatório.` : "Nada novo para adicionar.");
      rerender();
    }

    async function follow() {
      const term = lastQuery.trim();
      if (!term) return;
      const prefs = await guarded(() => api("/api/interests"));
      if (!prefs) return;
      if (prefs.terms.some((t) => t.toLowerCase() === term.toLowerCase())) { toast("Esta busca já está nos seus alertas."); return; }
      if (prefs.terms.length >= 5) { toast("Você já usa as 5 palavras-chave dos alertas. Remova uma em Meus interesses."); return; }
      const saved = await guarded(() => api("/api/interests", { method: "PUT", body: { topics: prefs.topics, languages: prefs.languages, terms: [...prefs.terms, term] } }));
      if (saved) { toast("Pronto: vamos avisar no sininho quando sair artigo novo sobre isso."); syncBell(); }
    }

    async function runSearch() {
      const query = queryInput.value.trim();
      if (query.length < 2) { queryInput.focus(); return; }
      if (!(await save())) return; // a busca fica registrada no histórico, que é uma versão do relatório
      searchButton.disabled = true;
      mount(resultsBox, loading("Procurando em todas as fontes…"));
      const found = await guarded(() => api(`/api/reports/${encodeURIComponent(reportId)}/search`, {
        method: "POST", body: { query, language: languageSelect.value, yearFrom: Number(yearInput.value) || null },
      }));
      searchButton.disabled = false;
      if (!found) { mount(resultsBox); return; }
      lastQuery = query;
      mount(resultsBox,
        found.results.length
          ? [h("p", { class: "hint" }, `${found.results.length} artigos que ainda não estão no relatório (desde ${found.yearFrom}).`),
            found.results.map((work) => h("div", { class: "card stack report-study" },
              h("h3", {}, h("a", { href: articleHref(work) }, work.title)),
              h("p", { class: "meta" }, [metaLine(work), (work.studyTypes || [])[0]].filter(Boolean).join(" · ")),
              h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => addRefs([work.ref], "busca", query) }, "Adicionar ao relatório")))),
            h("div", { class: "row" },
              h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => addRefs(found.results.map((w) => w.ref), "busca", query) }, "Adicionar todos"),
              h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: follow }, "Acompanhar nos meus alertas"))]
          : [h("p", { class: "muted" }, "Nenhum artigo novo para esta busca."), h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: follow }, "Acompanhar nos meus alertas")]);
    }
    searchButton.addEventListener("click", runSearch);
    queryInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runSearch(); } });

    function paintVersions(history) {
      mount(versionsBox, history.versions.length
        ? h("ul", { class: "plain-list" }, history.versions.map((v) => {
          const row = h("li", { class: "version-row" },
            h("div", {}, h("strong", {}, `Versão ${v.version}`), v.current ? h("span", { class: "badge" }, " atual") : null,
              h("span", { class: "muted" }, ` · ${fmtDate(v.savedAt.slice(0, 10))}`)),
            h("small", { class: "muted" }, v.summary));
          if (!v.current) {
            const ask = h("div", { class: "row" });
            const start = () => mount(ask,
              h("span", { class: "note" }, "Alterações não salvas serão perdidas."),
              h("button", { type: "button", class: "btn btn-sm btn-primary", onclick: async () => {
                if (await guarded(() => api(`/api/reports/${encodeURIComponent(reportId)}/restore`, { method: "POST", body: { version: v.version } }))) { toast(`Versão ${v.version} restaurada.`); rerender(); }
              } }, "Confirmar"),
              h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => mount(ask, h("button", { type: "button", class: "btn btn-sm btn-secondary", onclick: start }, "Restaurar")) }, "Cancelar"));
            mount(ask, h("button", { type: "button", class: "btn btn-sm btn-secondary", onclick: start }, "Restaurar"));
            row.append(ask);
          }
          return row;
        }))
        : h("p", { class: "muted" }, "Sem versões registradas ainda. Salve o relatório para criar a primeira."));
    }

    async function load() {
      const history = await guarded(() => api(`/api/reports/${encodeURIComponent(reportId)}/history`));
      if (!history) { mount(box, h("p", { class: "muted" }, "Não foi possível carregar o histórico agora.")); return; }
      mount(newBox,
        !history.listAvailable
          ? h("p", { class: "muted" }, `A lista de origem (“${history.listName}”) não existe mais, então não há como comparar.`)
          : history.newInList.length
            ? [h("p", {}, `${history.newInList.length} ${history.newInList.length === 1 ? "artigo entrou" : "artigos entraram"} na lista “${history.listName}” depois deste relatório:`),
              history.newInList.map((work) => h("div", { class: "row" },
                h("a", { href: articleHref(work) }, work.title),
                h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => addRefs([work.ref], "lista") }, "Adicionar"))),
              h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => addRefs(history.newInList.map((w) => w.ref), "lista") }, "Adicionar todos"))]
            : h("p", { class: "muted" }, `Nenhum artigo novo na lista “${history.listName}”.`));
      paintVersions(history);
      mount(logBox, history.log.length
        ? h("ul", { class: "plain-list" }, history.log.map((e) => h("li", {}, h("small", { class: "muted" }, fmtDate(e.createdAt.slice(0, 10))), e.text)))
        : h("p", { class: "muted" }, "Nenhuma busca ou adição feita a partir deste relatório."));
      mount(box,
        h("h3", {}, "Novos na lista de origem"), newBox,
        h("h3", {}, "Procurar artigos novos sobre o tema"),
        h("p", { class: "hint" }, "A busca usa todas as fontes, dos mais recentes aos mais antigos, e mostra só o que ainda não está no relatório. Ela fica registrada no histórico e no apêndice de método."),
        h("div", { class: "new-list" }, queryInput,
          h("div", { class: "row" }, languageSelect, h("label", { class: "report-include" }, h("span", {}, "Desde"), yearInput), searchButton)),
        resultsBox,
        h("details", { class: "more-records" }, h("summary", {}, "Versões do relatório"), versionsBox),
        h("details", { class: "more-records" }, h("summary", {}, "Histórico de buscas e adições"), logBox));
    }
    load();
    return { node: box };
  }

  // ---- partes novas do relatorio: resumo executivo, tabela comparativa e diagrama de selecao (tudo vem calculado do servidor)
  function executiveView(summary) {
    const pairs = (items) => items.map(([name, count]) => `${name} (${count})`).join("; ");
    return h("div", { class: "exec stack" },
      h("div", { class: "exec-nums" }, summary.numbers.map((n) => h("div", { class: "exec-num" }, h("strong", {}, n.value), h("span", {}, n.label)))),
      summary.reliability.length ? h("p", {}, h("strong", {}, "Confiabilidade dos incluídos: "), summary.reliability.map((r) => `${r.band} (${r.count})`).join("; ")) : null,
      summary.types.length ? h("p", {}, h("strong", {}, "Tipos de estudo mais frequentes: "), pairs(summary.types)) : null,
      summary.top.length ? [h("h3", {}, "Estudos com maior nota de confiabilidade"),
        h("ol", { class: "plain-list" }, summary.top.map((t) => h("li", {}, `${t.title} (${t.year || "s.d."}) · ${t.score}/100 (${t.band})`)))] : null,
      summary.alerts.length ? [h("h3", {}, "Pontos de atenção"), h("ul", { class: "plain-list exec-alerts" }, summary.alerts.map((a) => h("li", {}, a)))] : null,
      h("p", { class: "hint" }, summary.note));
  }

  function comparisonView(table) {
    if (!table.rows.length) return h("p", { class: "muted" }, "Nenhum estudo incluído.");
    return h("div", { class: "table-wrap" }, h("table", { class: "compare-table" },
      h("thead", {}, h("tr", {}, table.head.map((label) => h("th", { scope: "col" }, label)))),
      h("tbody", {}, table.rows.map((row) => h("tr", {}, row.map((cell, i) => h("td", { "data-label": i <= 1 ? null : table.head[i], class: i === 1 ? "cell-main" : "" }, cell)))))));
  }

  function flowView(flow) {
    const last = flow.stages.length - 1;
    const notes = (list) => list.map((text) => h("span", { class: "prisma-note" }, text));
    return h("figure", { class: "prisma", "aria-label": flow.title },
      h("figcaption", {}, flow.title),
      flow.stages.map((stage, i) => h("div", { class: "prisma-stage" },
        h("div", { class: "prisma-row" },
          h("div", { class: `prisma-box${i === last ? " is-final" : ""}` }, h("small", {}, stage.stage), h("strong", {}, stage.label), h("b", {}, `n = ${stage.n}`), notes(stage.notes)),
          stage.out ? h("div", { class: "prisma-out" }, h("div", { class: "prisma-box" }, h("strong", {}, stage.out.label), h("b", {}, `n = ${stage.out.n}`), notes(stage.out.notes))) : null),
        i < last ? h("div", { class: "prisma-down", "aria-hidden": "true" }, "↓") : null)),
      h("p", { class: "hint" }, flow.note));
  }

  async function renderReport(reportId) {
    setTitle("Relatório");
    if (!session.user) {
      mount($app, h("h1", {}, "Relatório"), emptyState("lock", "Entre para ver seus relatórios", "Relatórios nascem das suas listas e ficam guardados na sua conta.",
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openAuth("Entre para acessar seus relatórios.") }, "Entrar")));
      return;
    }
    mount($app, h("h1", {}, "Relatório"), loading());
    const data = await guarded(() => api(`/api/reports/${encodeURIComponent(reportId)}`));
    if (!data) { mount($app, h("h1", {}, "Relatório"), errorBox("Não foi possível abrir este relatório."), h("a", { href: "#/biblioteca" }, "Voltar à biblioteca")); return; }
    setTitle(data.title);

    const titleInput = h("input", { type: "text", id: "report-title", maxlength: "200", value: data.title });
    const questionInput = h("textarea", { id: "report-question", rows: "3", maxlength: "2000", placeholder: "Ex.: O exercício físico reduz a pressão arterial em adultos hipertensos?" });
    questionInput.value = data.question;
    const methodInput = h("textarea", { id: "report-method-note", rows: "4", maxlength: "3000", placeholder: "Ex.: Busquei em março de 2026 por “hipertensão e exercício”, só em português e inglês." });
    methodInput.value = data.methodNote;
    const rows = data.items.map((item) => {
      const include = h("input", { type: "checkbox", id: `inc-${item.ref}`, checked: item.included ? "" : null });
      include.checked = item.included;
      const note = h("textarea", { rows: "2", maxlength: "1000", "aria-label": `Sua nota sobre ${item.work.title}`, placeholder: "Sua nota sobre este estudo (opcional)" });
      note.value = item.note;
      const rel = item.reliability;
      const score = rel.score === null ? `confiabilidade ${rel.band.toLowerCase()}` : `confiabilidade ${rel.score}/100 (${rel.band.toLowerCase()})`;
      const card = h("article", { class: "card stack report-study" },
        h("label", { class: "report-include", for: `inc-${item.ref}` }, include, h("span", {}, "Incluir no relatório")),
        h("h3", {}, h("a", { href: articleHref(item.work) }, item.work.title)),
        h("p", { class: "meta" }, [metaLine(item.work), (item.work.studyTypes || [])[0], score].filter(Boolean).join(" · ")),
        item.findings.length ? h("ul", { class: "plain-list" }, item.findings.map((f) => h("li", {}, h("small", { class: "muted" }, f.tags.join(" · ")), f.sentence))) : null,
        note);
      return { item, include, note, card };
    });
    const brasil = showHealth() || (data.substances || []).length ? reportBrasil(reportId, data.substances || []) : null;
    const panoramaBox = h("div", { class: "stack" });
    const paintPanorama = (summary) => {
      const lines = [["Tipo de estudo", summary.types], ["Ano", summary.years], ["Idioma", summary.languages], ["Fonte", summary.sources]]
        .filter(([, pairs]) => pairs.length).map(([label, pairs]) => h("li", {}, h("strong", {}, `${label}: `), pairs.map(([n, c]) => `${n} (${c})`).join("; ")));
      mount(panoramaBox, h("p", {}, `${summary.total} estudos incluídos; ${summary.openAccess} com acesso aberto; ${summary.retracted} retratados; ${summary.withoutAbstract} sem resumo no registro.`),
        h("ul", { class: "plain-list" }, lines));
    };
    paintPanorama(data.panorama);
    const executiveBox = h("div"), comparisonBox = h("div"), flowBox = h("div");
    const paintInsights = (info) => { mount(executiveBox, executiveView(info.executive)); mount(comparisonBox, comparisonView(info.comparison)); mount(flowBox, flowView(info.flow)); };
    paintInsights(data);
    const status = h("span", { class: "note", "aria-live": "polite" }, `Versão ${data.version}`);
    const saveButton = h("button", { type: "button", class: "btn btn-primary" }, "Salvar alterações");

    async function save() {
      saveButton.disabled = true;
      const body = {
        title: titleInput.value, question: questionInput.value, methodNote: methodInput.value,
        items: rows.map((r) => ({ ref: r.item.ref, included: r.include.checked, note: r.note.value })),
        substances: brasil ? brasil.selected() : undefined,
      };
      const saved = await guarded(() => api(`/api/reports/${encodeURIComponent(reportId)}`, { method: "PUT", body }));
      saveButton.disabled = false;
      if (!saved) return null;
      status.textContent = `Salvo · versão ${saved.version}`;
      titleInput.value = saved.title;
      paintPanorama(saved.panorama);
      paintInsights(saved);
      setTitle(saved.title);
      if (brasil) brasil.reload();
      return saved;
    }
    saveButton.addEventListener("click", async () => { if (await save()) toast("Relatório salvo."); });
    const updates = reportUpdates({ reportId, data, save, rerender: () => renderReport(reportId) });
    const download = (format) => async () => {
      if (!(await save())) return; // o arquivo reflete o que está na tela
      location.assign(`/api/reports/${encodeURIComponent(reportId)}/download?format=${format}`);
    };

    mount($app,
      h("p", {}, h("a", { href: "#/biblioteca" }, "← Biblioteca")),
      h("h1", {}, "Relatório de tema"),
      h("p", { class: "lead" }, `Gerado da lista “${data.listName}”. Os estudos foram congelados na criação; escolha quais entram e escreva suas notas. Nada aqui é gerado por IA.`),
      h("section", { class: "card stack" },
        h("div", { class: "field" }, h("label", { for: "report-title" }, "Título"), titleInput),
        h("div", { class: "field" }, h("label", { for: "report-question" }, "Pergunta ou tema"), questionInput)),
      h("h2", {}, "Resumo executivo"), executiveBox,
      h("h2", {}, "Estudos"),
      h("p", { class: "hint" }, "Desmarque o que não deve entrar. A nota de confiabilidade e as frases estatísticas vêm do resumo do registro."),
      rows.map((r) => r.card),
      h("h2", {}, "Atualizar o relatório"), updates.node,
      h("h2", {}, "Panorama"), panoramaBox,
      h("h2", {}, "Tabela comparativa"), comparisonBox,
      brasil ? [h("h2", {}, "Situação no Brasil (medicamentos)"), brasil.node] : null,
      h("h2", {}, "Método"),
      flowBox,
      h("p", { class: "hint" }, "O texto abaixo é montado automaticamente e entra no apêndice do documento."),
      h("ul", { class: "plain-list" }, data.method.map((p) => h("li", {}, p))),
      h("details", { class: "more-records" }, h("summary", {}, "Como a nota de confiabilidade é calculada"),
        h("ul", { class: "plain-list" }, data.criteria.map((c) => h("li", {}, h("strong", {}, `${c.name} (peso ${c.weight}): `), c.how)))),
      h("div", { class: "field" }, h("label", { for: "report-method-note" }, "Sua nota sobre o método (opcional)"), methodInput),
      h("div", { class: "report-foot" }, status,
        h("div", { class: "row" }, saveButton,
          REPORT_DOWNLOADS.map(([label, format]) => h("button", { type: "button", class: "btn btn-secondary", onclick: download(format) }, label)))),
      h("p", { class: "note" }, "O PDF e o Word saem com a marca, o resumo executivo, a tabela comparativa e o diagrama de seleção. O relatório não conclui nem recomenda conduta; cabe ao autor interpretar os estudos."));
  }

  // ------------------------------------------------------------------ Lista compartilhada
  async function renderSharedList(token) {
    setTitle("Lista compartilhada");
    mount($app, loading("Abrindo a lista…"));
    let data;
    try { data = await api(`/api/shared/${encodeURIComponent(token)}`); } catch (error) {
      mount($app, h("h1", {}, "Lista compartilhada"), errorBox(error.message), h("p", {}, h("a", { class: "btn btn-primary", href: "#/busca" }, "Buscar artigos")));
      return;
    }
    mount($app,
      h("h1", {}, data.name),
      h("p", { class: "note" }, "Lista compartilhada por link (somente leitura)."),
      data.works.length
        ? h("ul", { class: "results" }, data.works.map((w) => h("li", { class: "result" },
          h("h3", {}, h("a", { href: articleHref(w) }, w.title)), h("div", { class: "meta" }, metaLine(w)), badges(w))))
        : h("div", { class: "empty card" }, "Esta lista está vazia."),
      h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary", disabled: !data.works.length, onclick: async (event) => {
        if (!requireUser("Entre para salvar estes artigos na sua biblioteca.")) return;
        event.target.disabled = true;
        let saved = 0;
        for (const work of data.works) {
          const ok = await guarded(() => api("/api/library", { method: "POST", body: { ref: work.ref } }));
          if (ok) saved += 1; else break;
        }
        event.target.disabled = false;
        toast(`${saved} de ${data.works.length} artigos salvos na sua biblioteca`);
      } }, "Salvar todos na minha biblioteca")));
  }

  // ------------------------------------------------------------------ roteador
  // ------------------------------------------------------------------ interesses
  async function renderInterests(target = $app) {
    if (!session.user) {
      mount(target, h("h2", {}, "Interesses e alertas"), emptyState("bell", "Acompanhe o que importa", "Entre na sua conta para escolher o que acompanhar e receber avisos de artigos novos.",
        h("button", { type: "button", class: "btn btn-primary", onclick: () => openAuth("Entre para escolher seus interesses.") }, "Entrar")));
      return;
    }
    mount(target, h("h2", {}, "Interesses e alertas"), loading());
    let catalog; let saved;
    try { [catalog, saved] = await Promise.all([api("/api/interests/options"), api("/api/interests")]); } catch (error) {
      if (error.status === 401) { setUser(""); renderInterests(target); return; }
      mount(target, h("h2", {}, "Interesses e alertas"), errorBox(error.message));
      return;
    }
    // area -> Set de subtemas (conjunto vazio = a area inteira)
    const chosen = new Map(saved.topics.map((t) => [t.area, new Set(t.subtopics)]));
    const languages = new Set(saved.languages);
    let terms = [...saved.terms];
    const limits = catalog.limits;
    const total = () => [...chosen.values()].reduce((sum, subs) => sum + (subs.size || 1), 0);
    const summary = h("p", { class: "hint", "aria-live": "polite" });
    const areaBox = h("div", { class: "stack" });
    const termBox = h("div", { class: "chips" });
    const langBox = h("div", { class: "pick-row", role: "group", "aria-label": "Idiomas dos artigos" });
    const input = h("input", { type: "text", maxlength: String(limits.termChars), placeholder: "ex.: metformina em idosos", "aria-label": "Adicionar palavra-chave" });
    const saveButton = h("button", { type: "button", class: "btn btn-primary" }, "Salvar interesses");

    const pick = (label, pressed, onclick) => h("button", { type: "button", class: "pick", "aria-pressed": pressed ? "true" : "false", onclick }, label);
    const withinLimit = (extra) => {
      if (total() + extra > limits.topics) { toast(`Escolha no máximo ${limits.topics} temas.`); return false; }
      return true;
    };
    function paint() {
      const langText = languages.size ? `${languages.size} ${languages.size === 1 ? "idioma" : "idiomas"}` : "todos os idiomas";
      summary.textContent = `${total()} de ${limits.topics} temas escolhidos · ${langText} · ${terms.length} ${terms.length === 1 ? "palavra-chave" : "palavras-chave"}`;
      mount(langBox, catalog.languages.map((lang) => pick(lang.label, languages.has(lang.code), () => {
        if (languages.has(lang.code)) languages.delete(lang.code);
        else if (languages.size >= limits.languages) { toast(`Escolha no máximo ${limits.languages} idiomas.`); return; } else languages.add(lang.code);
        paint();
      })));
      mount(areaBox, catalog.areas.map((area) => {
        const subs = chosen.get(area.key);
        const count = subs ? subs.size || 1 : 0;
        const countText = subs && subs.size ? `${subs.size} ${subs.size === 1 ? "subtema" : "subtemas"}` : "toda a área";
        return h("details", { class: "area-card", open: Boolean(subs) || null, "data-area": area.key },
          h("summary", {}, h("span", {}, area.label), count ? h("span", { class: "area-count" }, countText) : null),
          h("div", { class: "pick-row" },
            pick("Toda a área", Boolean(subs) && subs.size === 0, () => {
              if (subs && subs.size === 0) chosen.delete(area.key);
              else { if (!withinLimit(1 - (subs ? subs.size || 1 : 0))) return; chosen.set(area.key, new Set()); }
              paint();
            }),
            area.subtopics.map((sub) => pick(sub.label, Boolean(subs) && subs.has(sub.key), () => {
              const current = chosen.get(area.key);
              if (current && current.has(sub.key)) { current.delete(sub.key); if (!current.size) chosen.delete(area.key); } else {
                // marcar um subtema troca "toda a área" (que valia 1) por subtemas (1 cada)
                if (!withinLimit(current && current.size === 0 ? 0 : 1)) return;
                if (current) current.add(sub.key); else chosen.set(area.key, new Set([sub.key]));
              }
              paint();
            }))));
      }));
      mount(termBox, terms.map((t) => h("span", { class: "chip" }, t, h("button", { type: "button", "aria-label": `Remover ${t}`, onclick: () => { terms = terms.filter((x) => x !== t); paint(); } }, "×"))));
    }
    function addTerm() {
      const text = input.value.replace(/\s+/g, " ").trim();
      if (!text) return;
      if (terms.length >= limits.terms) { toast(`Use no máximo ${limits.terms} palavras-chave.`); return; }
      if (!terms.some((t) => t.toLowerCase() === text.toLowerCase())) terms.push(text);
      input.value = "";
      paint();
    }
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addTerm(); } });
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      const body = { topics: [...chosen].map(([area, subs]) => ({ area, subtopics: [...subs] })), languages: [...languages], terms };
      const result = await guarded(() => api("/api/interests", { method: "PUT", body }));
      saveButton.disabled = false;
      if (!result) return;
      toast(result.topics.length || result.terms.length ? "Interesses salvos. Vamos avisar quando sair artigo novo." : "Interesses removidos. Você não receberá avisos.");
      syncBell();
    });
    paint();

    mount(target,
      h("h2", {}, "Interesses e alertas"),
      h("p", { class: "lede" }, "Escolha as áreas, os subtemas e os idiomas que você quer acompanhar. Quando aparecer um artigo novo sobre eles, o sininho no canto superior avisa."),
      h("section", { class: "card stack" }, h("h2", {}, "Idiomas"),
        h("p", { class: "hint" }, "Sem escolher nenhum, aceitamos todos os idiomas. Para artigos em português, buscamos também pelo nome em português."), langBox),
      h("section", { class: "stack" }, h("h2", {}, "Áreas e subtemas"),
        h("p", { class: "hint" }, "Abra uma área e marque os subtemas, ou marque “Toda a área”."), areaBox),
      h("section", { class: "card stack" }, h("h2", {}, "Palavras-chave"),
        h("p", { class: "hint" }, "Para acompanhar algo mais específico, como um medicamento ou uma doença."),
        h("div", { class: "new-list" }, input, h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: addTerm }, "Adicionar")), termBox),
      h("div", { class: "interests-foot" }, summary, h("div", { class: "row" }, saveButton)),
      h("p", { class: "note" }, "Como funciona: ao salvar, guardamos os artigos recentes que já existem e avisamos só dos que surgirem depois. Procuramos quando você abre o site, no máximo a cada 6 horas. Ainda não enviamos e-mail."));
  }

  /** Pega o token do link e o tira da barra de endereço (não fica no histórico nem em capturas de tela). */
  function takeLinkToken(params, route) {
    const token = params.get("token") || "";
    history.replaceState(null, "", `#/${route}`);
    return token;
  }

  const BRL_STATUS = { pendente: "Aguardando pagamento", confirmado: "Pago", cancelado: "Cancelado" };
  const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "");

  /** Cartão com o Pix do pedido: valor, "copia e cola" e identificador. */
  function pixCard(request, { onCancel } = {}) {
    const code = h("textarea", { class: "pix-code", readonly: "", rows: "4", "aria-label": "Pix copia e cola" }, request.pix ? request.pix.copyPaste : "");
    return h("div", { class: "card stack pix-card" },
      h("h3", {}, `Plano ${request.planName}: ${request.months} ${request.months === 1 ? "mês" : "meses"}`),
      h("p", { class: "pix-amount" }, h("strong", {}, request.amount), h("span", { class: "muted" }, ` · ${BRL_STATUS[request.status] || request.status}`)),
      request.pix ? [
        h("p", { class: "note" }, "Abra o app do seu banco, escolha Pix, Copia e Cola, cole o código abaixo e pague o valor exato."),
        code,
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: async () => {
            try { await navigator.clipboard.writeText(request.pix.copyPaste); toast("Código Pix copiado."); } catch { code.select(); toast("Selecione e copie o código."); }
          } }, "Copiar código"),
          onCancel ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: onCancel }, "Cancelar pedido") : null),
        h("p", { class: "note" }, `Chave Pix: ${request.pix.key} · Recebedor: ${request.pix.name} · Identificador: ${request.reference}`),
        h("p", { class: "note" }, "Depois do pagamento, confirmamos manualmente e avisamos por e-mail. Costuma levar algumas horas em dia útil."),
      ] : null);
  }

  async function renderPlans() {
    setTitle("Planos");
    const body = h("div", { class: "stack" }, loading());
    mount($app, h("section", { class: "stack" }, h("p", { class: "eyebrow" }, "Planos"), h("h1", {}, "Escolha o seu plano"), body));
    try {
      const [info, mine] = await Promise.all([api("/api/billing/plans"), session.user ? api("/api/billing/me").catch(() => null) : Promise.resolve(null)]);
      const periods = info.periods;
      let months = periods[0];
      const detail = h("div", { class: "stack" });
      const cards = h("div", { class: "plan-grid" });
      const paint = () => mount(cards, info.plans.map((plan) => {
        const current = mine && mine.plan === plan.key;
        const total = plan.priceCents * months;
        return h("div", { class: `card stack plan-card${current ? " is-current" : ""}` },
          h("h2", {}, plan.name), h("p", { class: "muted" }, plan.description),
          h("p", { class: "plan-price" }, plan.priceCents ? h("strong", {}, `R$ ${(total / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`) : h("strong", {}, "Grátis"),
            plan.priceCents ? h("span", { class: "muted" }, ` por ${months} ${months === 1 ? "mês" : "meses"}`) : null),
          h("ul", { class: "checklist" },
            h("li", {}, icon("check"), h("span", {}, `${plan.limits.library.toLocaleString("pt-BR")} artigos na biblioteca`)),
            h("li", {}, icon("check"), h("span", {}, `${plan.limits.lists} listas de leitura`)),
            h("li", {}, icon("check"), h("span", {}, plan.limits.reports ? `${plan.limits.reports} ${plan.limits.reports === 1 ? "relatório" : "relatórios"} de tema` : "Sem relatórios de tema"))),
          current ? h("p", { class: "note" }, mine.active && plan.priceCents ? `Plano atual, até ${fmtDay(mine.expiresAt)}.` : "Plano atual.")
            : plan.priceCents ? h("button", { type: "button", class: "btn btn-primary", onclick: () => choose(plan) }, "Assinar com Pix") : null);
      }));
      const choose = async (plan) => {
        if (!requireUser("Entre ou crie uma conta para assinar.")) return;
        try {
          const request = await api("/api/billing/requests", { method: "POST", body: { plan: plan.key, months } });
          mount(detail, pixCard(request, { onCancel: async () => { await api(`/api/billing/requests/${request.id}`, { method: "DELETE" }); mount(detail); toast("Pedido cancelado."); } }));
          detail.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) { toast(error.message); }
      };
      const picker = h("div", { class: "row", role: "group", "aria-label": "Período" }, periods.map((value) =>
        h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { months = value; paint(); } }, value === 1 ? "1 mês" : `${value} meses`)));
      paint();
      const pending = (mine ? mine.requests : []).filter((item) => item.status === "pendente" && item.pix);
      mount(body,
        info.pixAvailable ? picker : h("p", { class: "note" }, "O pagamento por Pix ainda não está ativo. Fale com o suporte."),
        cards, detail,
        pending.length ? h("section", { class: "stack" }, h("h2", {}, "Pedidos em aberto"), pending.map((item) => pixCard(item, { onCancel: async () => { await api(`/api/billing/requests/${item.id}`, { method: "DELETE" }); renderPlans(); } }))) : null,
        info.enforced ? null : h("p", { class: "note" }, "No momento todos os recursos estão liberados para todas as contas. Os limites do plano gratuito passam a valer quando a cobrança for ativada."));
    } catch (error) { mount(body, errorBox(error.message)); }
  }

  async function profileSubscription(content) {
    mount(content, loading());
    try {
      const mine = await api("/api/billing/me");
      const usage = (label, used, limit) => h("li", {}, `${label}: ${used} de ${limit}`);
      mount(content,
        h("section", { class: "card stack" }, h("h2", {}, "Seu plano"),
          h("p", {}, h("strong", {}, mine.planName), mine.active ? ` até ${fmtDay(mine.expiresAt)}` : ""),
          h("ul", { class: "plain-list" }, usage("Artigos na biblioteca", mine.usage.library, mine.limits.library), usage("Listas de leitura", mine.usage.lists, mine.limits.lists), usage("Relatórios", mine.usage.reports, mine.limits.reports)),
          mine.enforced ? null : h("p", { class: "note" }, "Os limites ainda não estão sendo aplicados: todos os recursos estão liberados."),
          h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: "#/planos" }, mine.active ? "Renovar ou mudar de plano" : "Ver planos"))),
        mine.requests.length ? h("section", { class: "card stack" }, h("h2", {}, "Pedidos"),
          h("ul", { class: "plain-list" }, mine.requests.map((item) => h("li", {}, `${fmtDay(item.createdAt)} · ${item.planName}, ${item.months} ${item.months === 1 ? "mês" : "meses"} · ${item.amount} · ${BRL_STATUS[item.status] || item.status}`)))) : null);
    } catch (error) { mount(content, errorBox(error.message)); }
  }

  /** Aba de Administração: visão geral, usuários (com plano e ações), pagamentos e sistema. Só aparece para administradores. */
  const ADMIN_TABS = [["", "Visão geral"], ["usuarios", "Usuários"], ["pagamentos", "Pagamentos"], ["sistema", "Sistema"]];
  const brl = (cents) => `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
  const PLAN_NAMES = { gratuito: "Gratuito", pro: "Pro", max: "Max" };

  function renderAdmin(tab = "") {
    setTitle("Administração");
    const active = ADMIN_TABS.some(([key]) => key === tab) ? tab : "";
    const content = h("div", { class: "stack" });
    mount($app, h("section", { class: "stack admin-page" },
      h("p", { class: "eyebrow" }, "Administração"), h("h1", {}, "Painel do administrador"),
      h("nav", { class: "profile-tabs", "aria-label": "Seções da administração" }, ADMIN_TABS.map(([key, label]) =>
        h("a", { class: "profile-tab", href: key ? `#/admin/${key}` : "#/admin", "aria-current": key === active ? "page" : null }, label))),
      content));

    // acesso: a propria sessao de administrador; o token (so para emergencia) fica apenas na aba do navegador
    let token = "";
    try { token = sessionStorage.getItem("nexus-admin") || ""; } catch { /* sem armazenamento */ }
    const call = (path, options = {}) => api(path, { ...options, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const refresh = () => renderAdmin(active);
    const run = (action, done) => async () => {
      try { await action(); if (done) toast(done); refresh(); } catch (error) { toast(error.message); }
    };
    const stat = (label, value) => {
      const number = h("strong", {}, String(value));
      if (typeof value === "number" && value > 0 && value < 100000) { number.textContent = "0"; countTo(number, value); }
      return h("div", { class: "admin-stat" }, number, h("span", {}, label));
    };

    function askToken(message) {
      const input = h("input", { type: "password", id: "admin-token", autocomplete: "off", maxlength: "200", "aria-label": "Token de administrador" });
      mount(content, h("form", { class: "card stack", onsubmit: (event) => {
        event.preventDefault();
        token = input.value.trim();
        try { sessionStorage.setItem("nexus-admin", token); } catch { /* ignora */ }
        refresh();
      } }, h("p", { class: message ? "note" : "muted", role: "alert" }, message || "Entre com uma conta de administrador ou use o token de emergência."),
      h("div", { class: "field" }, h("label", { for: "admin-token" }, "Token de administrador"), input),
      h("div", { class: "row" }, h("button", { type: "submit", class: "btn btn-primary" }, "Entrar com token"))));
    }

    async function overview() {
      const data = await call("/api/admin/overview");
      mount(content,
        h("div", { class: "admin-stats" }, stat("contas", data.users), stat("com e-mail confirmado", data.verified), stat("novas em 7 dias", data.newLast7Days),
          stat("no plano Pro", data.byPlan.pro), stat("no plano Max", data.byPlan.max || 0), stat("no plano gratuito", data.byPlan.gratuito), stat("assinaturas vencendo em 7 dias", data.expiringSoon),
          stat("suspensas", data.suspended), stat("pagamentos a conferir", data.pendingPayments), stat("receita em 30 dias", brl(data.revenueLast30DaysCents)),
          stat("receita total", brl(data.revenueTotalCents))),
        data.pendingPayments ? h("p", {}, h("a", { class: "btn btn-primary", href: "#/admin/pagamentos" }, `Conferir ${data.pendingPayments} pagamento(s) pendente(s)`)) : null);
    }

    async function users(page = 0, query = "") {
      const limit = 25;
      const data = await call(`/api/admin/users?${new URLSearchParams({ q: query, offset: String(page * limit), limit: String(limit) })}`);
      const detail = h("div", { class: "stack" });
      const search = h("input", { type: "search", value: query, placeholder: "Buscar por e-mail", "aria-label": "Buscar por e-mail", maxlength: "100" });
      const rows = data.users.map((user) => h("tr", { class: user.suspended ? "is-suspended" : "" },
        h("td", { class: "cell-main" }, h("button", { type: "button", class: "link-button", onclick: () => openUser(user.email) }, user.email)),
        h("td", { "data-label": "Plano" }, h("span", { class: `plan-badge${user.plan !== "gratuito" ? " is-pro" : ""}` }, PLAN_NAMES[user.plan] || user.plan), user.expiresAt ? h("small", { class: "muted" }, ` até ${fmtDay(user.expiresAt)}`) : null),
        h("td", { "data-label": "E-mail confirmado" }, user.verified ? "Sim" : "Não"),
        h("td", { "data-label": "Biblioteca / listas / relatórios" }, `${user.usage.library} / ${user.usage.lists} / ${user.usage.reports}`),
        h("td", { "data-label": "Criada em" }, fmtDay(user.createdAt)),
        h("td", { "data-label": "Situação" }, user.suspended ? "Suspensa" : "Ativa")));
      const pages = Math.max(1, Math.ceil(data.total / limit));

      async function openUser(email) {
        const info = await call(`/api/admin/users/${encodeURIComponent(email)}`);
        const reason = h("input", { type: "text", placeholder: "Motivo (opcional)", maxlength: "300", "aria-label": "Motivo da suspensão" });
        const confirmDelete = h("input", { type: "text", placeholder: "Digite o e-mail para confirmar", maxlength: "320", "aria-label": "Confirmar e-mail para excluir" });
        const enc = encodeURIComponent(email);
        const post = (path, body = {}) => call(path, { method: "POST", body });
        mount(detail, h("div", { class: "card stack" },
          h("h2", {}, info.email, info.isAdmin ? h("span", { class: "plan-badge is-pro" }, "Administrador") : null),
          h("p", { class: "muted" }, `Criada em ${fmtDay(info.createdAt)} · e-mail ${info.verified ? "confirmado" : "não confirmado"} · aceite dos termos: ${info.terms ? `${info.terms.version} (${fmtDay(info.terms.acceptedAt)})` : "sem registro"}`),
          h("p", {}, `Plano: ${PLAN_NAMES[info.plan] || info.plan}${info.expiresAt ? ` até ${fmtDay(info.expiresAt)}` : ""} · Uso: ${info.usage.library} artigos, ${info.usage.lists} listas, ${info.usage.reports} relatórios`),
          info.suspension ? h("p", { class: "note" }, `Conta suspensa desde ${fmtDay(info.suspension.since)}${info.suspension.reason ? `: ${info.suspension.reason}` : ""}.`) : null,
          h("h3", {}, "Plano"),
          h("div", { class: "row" },
            (() => {
              const pick = h("select", { "aria-label": "Plano a conceder" }, [["pro", "Pro"], ["max", "Max"]].map(([value, label]) => h("option", { value }, label)));
              return [pick, [30, 90, 365].map((days) => h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: run(() => post("/api/admin/billing/grant", { email: info.email, plan: pick.value, days }), `${PLAN_NAMES[pick.value]} por ${days} dias concedido.`) }, `Dar ${days} dias`))];
            })(),
            h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: run(() => post("/api/admin/billing/revoke", { email: info.email }), "Assinatura removida.") }, "Remover assinatura")),
          h("h3", {}, "Conta"),
          h("div", { class: "row" },
            h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: run(async () => { const result = await post(`/api/admin/users/${enc}/reset-password`); toast(result.sent ? "Link de redefinição enviado ao e-mail da conta." : "Já há um link recente; aguarde um minuto."); }) }, "Enviar link de redefinição de senha"),
            info.verified ? null : h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: run(() => post(`/api/admin/users/${enc}/verify`), "E-mail marcado como confirmado.") }, "Marcar e-mail como confirmado")),
          info.isAdmin ? null : h("div", { class: "stack" },
            info.suspension
              ? h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: run(() => post(`/api/admin/users/${enc}/unsuspend`), "Conta reativada.") }, "Reativar conta"))
              : h("div", { class: "row" }, reason, h("button", { type: "button", class: "btn btn-outline btn-sm", onclick: run(() => post(`/api/admin/users/${enc}/suspend`, { reason: reason.value }), "Conta suspensa.") }, "Suspender")),
            h("div", { class: "row" }, confirmDelete, h("button", { type: "button", class: "btn btn-danger btn-sm", onclick: run(() => call(`/api/admin/users/${enc}`, { method: "DELETE", body: { confirm: confirmDelete.value } }), "Conta excluída.") }, "Excluir conta e dados"))),
          h("h3", {}, "Pagamentos"),
          info.payments.length ? h("ul", { class: "plain-list" }, info.payments.map((item) => h("li", {}, `${fmtDay(item.createdAt)} · ${PLAN_NAMES[item.plan] || item.plan}, ${item.months} ${item.months === 1 ? "mês" : "meses"} · ${brl(item.amountCents)} · ${BRL_STATUS[item.status] || item.status}${item.note ? ` · ${item.note}` : ""}`))) : h("p", { class: "muted" }, "Nenhum pedido.")));
        detail.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      mount(content,
        h("form", { class: "row", onsubmit: (event) => { event.preventDefault(); load(users(0, search.value.trim())); } }, search, h("button", { type: "submit", class: "btn btn-secondary btn-sm" }, "Buscar")),
        h("div", { class: "table-wrap" }, h("table", { class: "admin-table" },
          h("thead", {}, h("tr", {}, ["E-mail", "Plano", "E-mail confirmado", "Biblioteca / listas / relatórios", "Criada em", "Situação"].map((label) => h("th", { scope: "col" }, label)))),
          h("tbody", {}, rows))),
        h("p", { class: "muted" }, `${data.total} conta(s)${query ? ` para “${query}”` : ""} · página ${page + 1} de ${pages}`),
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: page === 0, onclick: () => load(users(page - 1, query)) }, "Anterior"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", disabled: page + 1 >= pages, onclick: () => load(users(page + 1, query)) }, "Próxima")),
        detail);
    }

    async function payments() {
      const [pending, history] = await Promise.all([call("/api/admin/billing/requests"), call("/api/admin/billing/requests?status=confirmado")]);
      const note = h("input", { type: "text", placeholder: "Anotação (opcional)", maxlength: "300", "aria-label": "Anotação do pagamento" });
      mount(content,
        h("section", { class: "card stack" }, h("h2", {}, `Pedidos pendentes (${pending.requests.length})`),
          h("p", { class: "note" }, "Confira cada pedido com o extrato do banco (valor, data, nome do pagador e, quando aparecer, o identificador) antes de confirmar."), note,
          pending.requests.length ? h("ul", { class: "plain-list admin-list" }, pending.requests.map((item) => h("li", {},
            h("span", {}, `${item.email} · ${item.planName} ${item.months} m · `, h("strong", {}, item.amount), ` · ${item.reference} · ${fmtDay(item.createdAt)}`),
            h("span", { class: "row" },
              h("button", { type: "button", class: "btn btn-primary btn-sm", onclick: run(() => call(`/api/admin/billing/requests/${item.id}/confirm`, { method: "POST", body: { note: note.value } }), "Pagamento confirmado.") }, "Confirmar pagamento"),
              h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: run(() => call(`/api/admin/billing/requests/${item.id}/cancel`, { method: "POST", body: {} }), "Pedido cancelado.") }, "Cancelar")))))
            : h("p", { class: "muted" }, "Nenhum pedido pendente.")),
        h("section", { class: "card stack" }, h("h2", {}, "Pagamentos confirmados"),
          history.requests.length ? h("ul", { class: "plain-list" }, history.requests.map((item) => h("li", {}, `${fmtDay(item.confirmedAt)} · ${item.email} · ${item.planName} ${item.months} m · ${item.amount}${item.note ? ` · ${item.note}` : ""}`)))
            : h("p", { class: "muted" }, "Nenhum ainda.")));
    }

    async function system() {
      const data = await call("/api/admin/system");
      const yes = (value) => (value ? "Sim" : "Não");
      const totals = (data.usage && data.usage.totals) || {};
      mount(content, h("section", { class: "card stack" }, h("h2", {}, "Estado do servidor"),
        h("ul", { class: "plain-list" },
          h("li", {}, `Banco de dados: ${data.database}`), h("li", {}, `Ambiente de produção: ${yes(data.production)}`),
          h("li", {}, `Cobrança por plano ligada (limites valendo): ${yes(data.billingEnforced)}`), h("li", {}, `Chave Pix configurada: ${yes(data.pixConfigured)}`),
          h("li", {}, `Envio de e-mail configurado: ${yes(data.mailEnabled)}`), h("li", {}, `Aceite dos termos obrigatório: ${yes(data.termsRequired)}`),
          h("li", {}, `Dados legais (controlador e contato) completos: ${yes(data.legalComplete)}`),
          h("li", {}, `Administradores: ${data.adminEmails.length ? data.adminEmails.join(", ") : "nenhum por e-mail"}${data.tokenEnabled ? " (token de emergência ativo)" : ""}`),
          h("li", {}, `Laboratório de IA desde o último início: ${totals.calls || 0} chamadas, ${(totals.prompt_tokens || 0) + (totals.completion_tokens || 0)} tokens`))));
    }

    const load = async (promise) => {
      try { await promise; } catch (error) {
        if (error.status === 401 || error.status === 404) {
          if (token) { token = ""; try { sessionStorage.removeItem("nexus-admin"); } catch { /* ignora */ } }
          askToken(error.status === 404 ? "O painel está desativado neste servidor (defina ADMIN_EMAILS ou ADMIN_TOKEN)." : "Esta conta não é de administrador (ou o token está errado).");
        } else mount(content, errorBox(error.message));
      }
    };
    mount(content, loading());
    load({ "": overview, usuarios: () => users(), pagamentos: payments, sistema: system }[active]());
  }

  async function renderLegal(doc) {
    setTitle(doc === "termos" ? "Termos de Uso" : "Política de Privacidade");
    const body = h("div", { class: "stack" }, loading());
    mount($app, h("section", { class: "narrow stack legal" }, body));
    try {
      const data = await api(`/api/legal/${doc}`);
      const article = h("article", { class: "legal-text" });
      article.innerHTML = data.html;  // HTML gerado e escapado pelo servidor (markdown_lite)
      mount(body, article, h("p", { class: "muted" }, `Versão ${data.version}.`));
    } catch (error) { mount(body, errorBox(error.message)); }
  }

  function renderResetPassword(params) {
    setTitle("Redefinir senha");
    const token = takeLinkToken(params, "redefinir");
    const status = h("p", { class: "note", role: "status" });
    const field = (id, label) => {
      const input = h("input", { type: "password", id, autocomplete: "new-password", maxlength: "128", required: "" });
      return [h("div", { class: "field" }, h("label", { for: id }, label), input), input];
    };
    const [firstField, first] = field("reset-new", "Nova senha (mínimo de 8 caracteres)");
    const [secondField, second] = field("reset-repeat", "Repita a nova senha");
    const submit = h("button", { type: "submit", class: "btn btn-primary" }, "Salvar nova senha");
    const form = h("form", { class: "card stack", onsubmit: async (event) => {
      event.preventDefault();
      status.textContent = "";
      if (first.value !== second.value) { status.textContent = "As senhas não são iguais."; return; }
      submit.disabled = true;
      try {
        await api("/api/auth/reset", { method: "POST", body: { token, password: first.value } });
        mount($app, h("section", { class: "narrow stack" }, h("h1", {}, "Senha redefinida"),
          h("p", { class: "lead" }, "Pronto! Entre com a sua nova senha."),
          h("div", { class: "row" }, h("button", { type: "button", class: "btn btn-primary", onclick: () => { location.hash = "#/"; openAuth("Entre com a sua nova senha."); } }, "Entrar"))));
      } catch (error) { status.textContent = error.message; submit.disabled = false; }
    } }, firstField, secondField, status, h("div", { class: "row" }, submit));
    mount($app, h("section", { class: "narrow stack" }, h("h1", {}, "Redefinir senha"),
      token ? form : h("p", { class: "note" }, "Abra o link que enviamos ao seu e-mail para escolher uma nova senha. Se ele expirou, peça outro em “Esqueci a senha”.")));
  }

  async function renderConfirmEmail(params) {
    setTitle("Confirmar e-mail");
    const token = takeLinkToken(params, "confirmar");
    const body = h("div", { class: "stack" }, loading("Confirmando…"));
    mount($app, h("section", { class: "narrow stack" }, h("h1", {}, "Confirmar e-mail"), body));
    if (!token) { mount(body, h("p", { class: "note" }, "Abra o link que enviamos ao seu e-mail. Se ele expirou, peça outro em Perfil, Conta e dados.")); return; }
    try {
      const data = await api("/api/auth/verify", { method: "POST", body: { token } });
      mount(body, h("p", { class: "lead" }, `E-mail confirmado: ${data.email}.`),
        h("div", { class: "row" }, h("a", { class: "btn btn-primary", href: "#/" }, "Ir para o início")));
    } catch (error) { mount(body, errorBox(error.message)); }
  }

  function render() {
    const { view, rest, params } = Lib.parseRoute(location.hash);
    currentView = view;
    clearCitationMeta();
    closePanel();
    renderNav(view);
    if (view === "busca") renderSearch(params);
    else if (view === "artigo") renderArticle(params);
    else if (view === "biblioteca") renderLibrary(params);
    else if (view === "feed") renderFeed(params);
    else if (view === "termos" || view === "privacidade") renderLegal(view);
    else if (view === "planos") renderPlans();
    else if (view === "admin") renderAdmin(rest[0] || "");
    else if (view === "redefinir") renderResetPassword(params);
    else if (view === "confirmar") renderConfirmEmail(params);
    else if (view === "interesses") location.replace("#/perfil/interesses");
    else if (view === "perfil") renderProfile(rest[0] || "");
    else if (view === "relatorio" && rest[0]) renderReport(rest[0]);
    else if (view === "lista" && rest[0]) renderSharedList(rest[0]);
    else renderHome();
    if (view !== "busca") window.scrollTo(0, 0);
  }
  // as telas carregam por partes; com a restauração automática o navegador "persegue" a rolagem antiga enquanto o conteúdo cresce (e a rolagem infinita carregava tudo)
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("hashchange", () => { render(); $app.focus({ preventScroll: true }); });
  render();
  askProfile();
})();
