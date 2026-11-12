'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = $('#view');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
const CDN = 'https://cdn.emulatorjs.org/stable/data/';

const PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120" fill="none">' +
  '<rect width="160" height="120" fill="#171717"/>' +
  '<rect x="34" y="34" width="92" height="52" rx="18" stroke="#737373" stroke-width="3"/>' +
  '<path d="M54 60h16M62 52v16" stroke="#737373" stroke-width="3" stroke-linecap="round"/>' +
  '<circle cx="102" cy="56" r="4" fill="#737373"/>' +
  '<circle cx="112" cy="64" r="4" fill="#737373"/>' +
  '</svg>'
);

const CON = [
  ['49', 'NES', 'nes'],
  ['79', 'SNES', 'snes'],
  ['167', 'Mega Drive / Genesis', 'segaMD'],
  ['74', 'Master System', 'segaMS'],
  ['26', 'Game Boy', 'gb'],
  ['43', 'Game Boy Color', 'gb'],
  ['24', 'Game Boy Advance', 'gba'],
  ['23', 'Atari 2600', 'atari2600'],
  ['83', 'Nintendo 64', 'n64'],
  ['27', 'PlayStation', 'psx']
].map(([id, n, core]) => ({ id: +id, n, core }));

const ESRB = ['Everyone', 'Everyone 10+', 'Teen', 'Mature', 'Adults Only'];

const TXT = {
  credits: '<h2>Créditos</h2><p style="margin-top:.75rem">Catálogo de jogos: <a href="https://rawg.io" target="_blank" rel="noopener">RAWG</a>. Emulação no navegador: <a href="https://emulatorjs.org" target="_blank" rel="noopener">EmulatorJS</a>.</p>',
  privacy: '<h2>Privacidade</h2><p style="margin-top:.75rem">Seus jogos salvos ficam vinculados à sua conta. Arquivos de ROM locais são processados apenas no seu navegador e não são enviados para o servidor.</p>',
  terms: '<h2>Termos de uso</h2><p style="margin-top:.75rem">Utilize apenas ROMs de domínio público, homebrew ou cópias pessoais às quais você tenha direito legal.</p>'
};

const store = {
  get(k, fallback = []) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  }
};

const G = {};
let started = false;
let emulatorTimer = null;
let currentBlobUrl = null;
let currentUser = null;
let pendingSaveGame = null;

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 110);
  }, 3100);
}

/* =========================================================
   MENU MOBILE & TEMA CLARO / ESCURO
   ========================================================= */

function setMenuOpen(open) {
  const drawer = $('#nav-drawer');
  const burger = $('#burger');
  if (!drawer || !burger) return;
  drawer.classList.toggle('open', open);
  burger.setAttribute('aria-expanded', String(open));
  burger.textContent = open ? '✕' : '☰';
}

function syncThemeButton() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  $('#theme-icon').textContent = isDark ? '☀' : '☾';
  $('#theme-label').textContent = isDark ? 'Claro' : 'Escuro';
  $('#theme-toggle').setAttribute('aria-label', isDark ? 'Mudar para tema claro' : 'Mudar para tema escuro');
}

$('#theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  syncThemeButton();
});

syncThemeButton();

/* =========================================================
   API & AUTENTICAÇÃO
   ========================================================= */

async function api(path, query = {}, options = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString();
  const url = '/api/' + path + (qs ? '?' + qs : '');
  const token = localStorage.getItem('auth_token');
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro ' + res.status);
  return data;
}

function getSavedGames() {
  if (currentUser && Array.isArray(currentUser.savedGames)) {
    return currentUser.savedGames;
  }
  return store.get('guest_saved', []);
}

function isSaved(id) {
  return getSavedGames().some(g => g.id === id);
}

function updateSavedCount() {
  const badge = $('#saved-count');
  if (badge) badge.textContent = String(getSavedGames().length);
}

function renderAuthArea() {
  const area = $('#auth-area');
  if (!area) return;

  if (currentUser) {
    area.innerHTML = `
      <span class="user-pill">${esc(currentUser.name)}</span>
      <button type="button" class="btn ghost" id="logout-btn">Sair</button>
    `;
    $('#logout-btn').onclick = async () => {
      try {
        await api('auth/logout', {}, { method: 'POST' });
      } catch {}
      localStorage.removeItem('auth_token');
      currentUser = null;
      renderAuthArea();
      updateSavedCount();
      toast('Você saiu da sua conta.');
      route();
    };
  } else {
    area.innerHTML = `
      <button type="button" class="btn ghost" data-open-auth="login">Entrar</button>
      <button type="button" class="btn" data-open-auth="register">Cadastrar</button>
    `;
  }
  updateSavedCount();
}

function openAuthModal(tab = 'login') {
  const d = $('#auth-dlg');
  setMenuOpen(false);
  switchAuthTab(tab);
  $('#login-err').hidden = true;
  $('#register-err').hidden = true;
  d.showModal();
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  $('#login-form').hidden = !isLogin;
  $('#register-form').hidden = isLogin;
  $$('.auth-tab').forEach(btn => {
    const active = btn.dataset.authTab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

$$('.auth-tab').forEach(btn => {
  btn.onclick = () => switchAuthTab(btn.dataset.authTab);
});

$('#close-auth-1').onclick = () => $('#auth-dlg').close();
$('#close-auth-2').onclick = () => $('#auth-dlg').close();

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('#login-err');
  errEl.hidden = true;
  const fd = new FormData(e.target);
  try {
    const data = await api('auth/login', {}, {
      method: 'POST',
      body: JSON.stringify({
        email: fd.get('email'),
        password: fd.get('password')
      })
    });
    localStorage.setItem('auth_token', data.token);
    currentUser = data.user;
    $('#auth-dlg').close();
    e.target.reset();
    renderAuthArea();
    toast(`Bem-vindo, ${currentUser.name}!`);
    if (pendingSaveGame) {
      const g = pendingSaveGame;
      pendingSaveGame = null;
      await toggleSaveGame(g);
    }
    route();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

$('#register-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = $('#register-err');
  errEl.hidden = true;
  const fd = new FormData(e.target);
  try {
    const guestGames = store.get('guest_saved', []);
    const data = await api('auth/register', {}, {
      method: 'POST',
      body: JSON.stringify({
        name: fd.get('name'),
        email: fd.get('email'),
        password: fd.get('password'),
        savedGames: guestGames
      })
    });
    localStorage.setItem('auth_token', data.token);
    currentUser = data.user;
    store.set('guest_saved', []);
    $('#auth-dlg').close();
    e.target.reset();
    renderAuthArea();
    toast(`Conta criada! Olá, ${currentUser.name}.`);
    if (pendingSaveGame) {
      const g = pendingSaveGame;
      pendingSaveGame = null;
      await toggleSaveGame(g);
    }
    route();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

async function restoreSession() {
  const token = localStorage.getItem('auth_token');
  if (!token) {
    renderAuthArea();
    return;
  }
  try {
    const data = await api('auth/me');
    currentUser = data.user;
  } catch {
    localStorage.removeItem('auth_token');
    currentUser = null;
  }
  renderAuthArea();
}

async function toggleSaveGame(game) {
  if (!game || !game.id) return false;

  if (!currentUser) {
    pendingSaveGame = game;
    toast('Entre ou cadastre-se para salvar jogos na sua conta.');
    openAuthModal('login');
    return false;
  }

  const already = isSaved(game.id);
  try {
    if (already) {
      const res = await api('saved/' + game.id, {}, { method: 'DELETE' });
      currentUser.savedGames = res.savedGames;
      toast('Jogo removido dos salvos.');
    } else {
      const res = await api('saved', {}, {
        method: 'POST',
        body: JSON.stringify({ game })
      });
      currentUser.savedGames = res.savedGames;
      toast('Jogo salvo na aba Jogos Salvos!');
    }
    updateSavedCount();
    $$(`[data-save-game="${game.id}"]`).forEach(btn => {
      const on = isSaved(game.id);
      btn.classList.toggle('saved-on', on);
      btn.classList.toggle('ghost', !on);
      btn.textContent = on ? 'Salvo ✓' : 'Salvar jogo';
    });
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

/* =========================================================
   LIMPEZA DO EMULADOR ENTRE ROTAS
   ========================================================= */

function destroyEmulator() {
  if (emulatorTimer) {
    clearTimeout(emulatorTimer);
    emulatorTimer = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  try {
    window.EJS_emulator?.pause?.();
    window.EJS_emulator?.elements?.parent?.remove?.();
  } catch {}
  $$('script[data-ejs]').forEach(s => s.remove());
  for (const key of Object.keys(window)) {
    if (key.startsWith('EJS_')) {
      try {
        delete window[key];
      } catch {
        window[key] = undefined;
      }
    }
  }
  started = false;
}

/* =========================================================
   COMPONENTES DE UI
   ========================================================= */

const size = b => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(2) + ' MB');

const consolesLabel = g => {
  const m = (g.platforms || []).filter(p => CON.some(c => c.id === p.id)).map(p => p.name);
  return (m.length ? m : (g.platforms || []).slice(0, 1).map(p => p.name)).join(', ') || '—';
};

const saveBtn = g => {
  const on = isSaved(g.id);
  return `<button type="button" class="btn ${on ? 'saved-on' : 'ghost'}" data-save-game="${g.id}">${on ? 'Salvo ✓' : 'Salvar jogo'}</button>`;
};

const card = g => {
  G[g.id] = g;
  const imgSrc = g.cover ? esc(g.cover) : PLACEHOLDER_IMG;
  return `
    <article class="gc item-enter" data-game-card="${g.id}">
      <img src="${imgSrc}" onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'" alt="Capa de ${esc(g.name)}" loading="lazy" width="148" height="111">
      <div class="gc-info">
        <h3><a class="gc-title-link" href="#/game/${g.id}">${esc(g.name)}</a></h3>
        <ul class="chips">
          <li>${esc(g.year || '—')}</li>
          <li class="c">${esc(consolesLabel(g))}</li>
          <li>${g.rom ? size(g.rom.size) : 'ROM local'}</li>
          <li>${esc(g.esrb || 'Livre')}</li>
        </ul>
      </div>
      <div class="ga">
        ${saveBtn(g)}
        <a class="btn" href="#/game/${g.id}">${g.rom ? 'Jogar' : 'Abrir'}</a>
      </div>
    </article>
  `;
};

const sk = n => '<div class="gc sk"></div>'.repeat(n);

const sform = (v = '') => `
  <form class="sf" role="search">
    <input name="q" value="${esc(v)}" placeholder="Pesquisar jogo pelo nome…" aria-label="Pesquisar jogo">
    <button class="btn" type="submit">Pesquisar</button>
  </form>
`;

function dlg(h) {
  setMenuOpen(false);
  $('#dc').innerHTML = h;
  $('#dlg').showModal();
}

/* =========================================================
   VIEWS (INÍCIO, EXPLORAR, CONSOLES, RESULTADOS, SALVOS, JOGO)
   ========================================================= */

function home() {
  const saved = getSavedGames().slice(0, 3);
  const hist = store.get('hist', []).slice(0, 3);

  view.innerHTML = `
    <section class="hero">
      <div class="hi">
        <div>
          <p class="tag">Sua coleção retrô</p>
          <h1>Jogue seus clássicos favoritos.</h1>
          <p>Encontre um jogo e comece a jogar.</p>
          <div class="hero-actions">
            <a class="btn" href="#/search">Explorar jogos <span aria-hidden="true">→</span></a>
            <a class="btn ghost" href="#/consoles">Ver consoles</a>
          </div>
        </div>
        <svg class="pad" viewBox="0 0 220 130" aria-hidden="true">
          <rect x="6" y="16" width="208" height="98" rx="44" fill="none" stroke="currentColor" stroke-width="3"/>
          <rect x="44" y="54" width="44" height="14" rx="2" fill="currentColor"/>
          <rect x="59" y="39" width="14" height="44" rx="2" fill="currentColor"/>
          <circle cx="158" cy="58" r="10" fill="none" stroke="currentColor" stroke-width="3"/>
          <circle cx="182" cy="76" r="10" fill="currentColor"/>
          <rect x="96" y="78" width="28" height="6" rx="3" fill="currentColor"/>
        </svg>
      </div>
    </section>

    ${saved.length ? `
      <section class="wrap home-section">
        <div class="sec-head">
          <h2>Seus favoritos</h2>
          <a class="text-link" href="#/saved">Ver todos <span aria-hidden="true">→</span></a>
        </div>
        <div class="list">${saved.map(card).join('')}</div>
      </section>
    ` : ''}

    ${hist.length ? `
      <section class="wrap home-section">
        <div class="sec-head"><h2>Continue jogando</h2></div>
        <div class="list">${hist.map(card).join('')}</div>
      </section>
    ` : ''}
  `;
}

function search() {
  const wk = Math.floor(Date.now() / 6048e5) % 10 + 1;
  const t = s => encodeURIComponent(s);
  const C = [
    ['#/consoles', 'Consoles', 'Navegue por NES, SNES, Mega Drive, GBA e mais', { platforms: '79' }],
    ['#/results?ordering=-rating&title=' + t('Melhor avaliados'), 'Melhor avaliados', 'Os clássicos com as maiores notas', { ordering: '-rating' }],
    ['#/results?ordering=-metacritic&start=' + wk + '&title=' + t('Destaques da semana'), 'Destaques da semana', 'Seleção atualizada semanalmente', { ordering: '-metacritic', page: wk }]
  ];

  view.innerHTML = `
    <section class="wrap">
      <h1>Explorar jogos</h1>
      ${sform()}
      <div class="trio">
        ${C.map((c, i) => `
          <a class="big item-enter" id="b${i}" href="${c[0]}">
            <div>
              <h2>${c[1]}</h2>
              <p>${c[2]}</p>
            </div>
          </a>
        `).join('')}
      </div>
    </section>
  `;

  C.forEach((c, i) =>
    api('games', c[3])
      .then(d => {
        const g = d.results.find(x => x.cover);
        if (g) {
          const el = $('#b' + i);
          if (el) {
            el.style.backgroundImage = `url("${g.cover}")`;
            el.classList.add('has-img');
          }
        }
      })
      .catch(() => {})
  );
}

function consolesView() {
  view.innerHTML = `
    <section class="wrap">
      <h1>Consoles</h1>
      <p class="dim">Selecione uma plataforma para listar os jogos compatíveis.</p>
      <div class="trio">
        ${CON.map(c => `
          <a class="big con item-enter" href="#/results?platforms=${c.id}&title=${encodeURIComponent(c.n)}">
            <div>
              <h2>${c.n}</h2>
              <p>Explorar catálogo →</p>
            </div>
          </a>
        `).join('')}
      </div>
    </section>
  `;
}

function savedView() {
  const list = getSavedGames();

  if (!currentUser) {
    view.innerHTML = `
      <section class="wrap">
        <h1>Jogos Salvos</h1>
        <div class="empty item-enter">
          <h2>Entre na sua conta</h2>
          <p class="dim">Faça login ou cadastre-se para salvar seus jogos e abri-los rapidamente nesta aba.</p>
          <div class="hero-actions">
            <button type="button" class="btn" data-open-auth="login">Entrar</button>
            <button type="button" class="btn ghost" data-open-auth="register">Cadastrar usuário</button>
          </div>
        </div>
      </section>
    `;
    return;
  }

  view.innerHTML = `
    <section class="wrap">
      <div class="sec-head">
        <div>
          <h1>Jogos Salvos</h1>
          <p class="dim">Conta de ${esc(currentUser.name)} · ${list.length} ${list.length === 1 ? 'jogo salvo' : 'jogos salvos'}</p>
        </div>
        <a class="btn ghost" href="#/search">+ Adicionar jogos</a>
      </div>

      ${list.length ? `
        <div class="list" id="saved-list">${list.map(card).join('')}</div>
      ` : `
        <div class="empty item-enter">
          <h2>Nenhum jogo salvo ainda</h2>
          <p class="dim">Clique em "Salvar jogo" em qualquer título do catálogo para adicioná-lo aqui.</p>
          <a class="btn" href="#/search">Explorar catálogo</a>
        </div>
      `}
    </section>
  `;
}

async function results(p) {
  const f = k => p.get(k) || '';
  let page = +f('start') || 1;
  let first = true;

  view.innerHTML = `
    <section class="wrap">
      ${sform(f('search'))}
      <h1>${esc(f('title') || (f('search') ? 'Resultados: ' + f('search') : 'Jogos'))}</h1>
      <form id="flt" class="flt">
        <select name="platforms" aria-label="Console">
          <option value="">Todos os consoles</option>
          ${CON.map(c => `<option value="${c.id}"${f('platforms') == c.id ? ' selected' : ''}>${c.n}</option>`).join('')}
        </select>
        <select name="genres" id="gsel" aria-label="Gênero">
          <option value="">Todos os gêneros</option>
        </select>
        <input name="year" type="number" min="1970" max="2030" placeholder="Ano" value="${esc(f('year'))}" aria-label="Ano de lançamento">
        <select name="esrb" aria-label="Classificação indicativa">
          <option value="">Qualquer classificação</option>
          ${ESRB.map(e => `<option${f('esrb') === e ? ' selected' : ''}>${e}</option>`).join('')}
        </select>
      </form>
      <div id="list" class="list">${sk(4)}</div>
      <div id="more" class="more"></div>
    </section>
  `;

  $('#flt').onchange = () => {
    const n = new URLSearchParams(p);
    new FormData($('#flt')).forEach((v, k) => (v ? n.set(k, v) : n.delete(k)));
    n.delete('start');
    location.hash = '#/results?' + n;
  };

  api('genres')
    .then(d =>
      $('#gsel')?.insertAdjacentHTML(
        'beforeend',
        d.results.map(g => `<option value="${esc(g.slug)}"${f('genres') === g.slug ? ' selected' : ''}>${esc(g.name)}</option>`).join('')
      )
    )
    .catch(() => {});

  const list = $('#list');
  const more = $('#more');

  const renderMoreBtn = () => {
    more.innerHTML = '<button type="button" class="btn ghost">Carregar mais</button>';
    more.firstChild.onclick = () => {
      more.innerHTML = '<div class="spin"></div>';
      load();
    };
  };

  const load = async () => {
    more.innerHTML = '';
    try {
      const esrbFilter = f('esrb');
      let collected = [];
      let hasNext = false;
      let attempts = 0;

      do {
        const d = await api('games', {
          search: f('search'),
          platforms: f('platforms'),
          genres: f('genres'),
          year: f('year'),
          ordering: f('ordering'),
          page
        });
        hasNext = d.next;
        page++;
        attempts++;
        const matched = d.results.filter(g => !esrbFilter || g.esrb === esrbFilter);
        collected.push(...matched);
      } while (esrbFilter && collected.length < 6 && hasNext && attempts < 4);

      if (first) {
        list.innerHTML = '';
        first = false;
      }
      $('.empty', list)?.remove();
      list.insertAdjacentHTML('beforeend', collected.map(card).join(''));
      if (!$('.gc', list)) {
        const msg = hasNext
          ? 'Nenhum jogo encontrado nestas páginas com essa classificação. Clique em "Carregar mais" para continuar buscando.'
          : 'Nenhum jogo encontrado com esses filtros.';
        list.innerHTML = `<div class="empty item-enter"><p>${msg}</p></div>`;
      }
      if (hasNext) {
        renderMoreBtn();
      }
    } catch (e) {
      if (first) {
        list.innerHTML = `<div class="empty item-enter"><p>${esc(e.message)}</p></div>`;
        more.innerHTML = '';
      } else {
        renderMoreBtn();
      }
      toast(e.message);
    }
  };

  load();
}

async function game(_, id) {
  view.innerHTML = '<section class="wrap"><div id="stage"><div class="ovl"><div class="spin"></div><p>Carregando jogo…</p></div></div></section>';

  let g;
  try {
    g = await api('games/' + id);
  } catch (e) {
    view.innerHTML = `<section class="wrap"><div class="empty item-enter"><p>${esc(e.message)}</p><a class="btn" href="#/search">Voltar</a></div></section>`;
    return toast(e.message);
  }

  const { desc, devs, ...m } = g;
  G[g.id] = m;
  document.title = g.name + ' — ROMS ONLINE';

  const mt = CON.find(c => g.platforms.some(p => p.id === c.id));
  const c = mt || CON[0];
  store.set('hist', [m, ...store.get('hist', []).filter(x => x.id !== g.id)].slice(0, 12));

  view.innerHTML = `
    <section class="wrap">
      <div class="sec-head">
        <h1>${esc(g.name)}</h1>
        ${saveBtn(m)}
      </div>

      <div id="stage">
        <div id="game"></div>
        <div class="ovl" id="ovl">
          ${g.rom ? '<button type="button" class="btn" id="play">▶ Iniciar jogo</button>' : '<p>Nenhuma ROM pré-cadastrada para este título.</p>'}
          <label class="btn ghost">
            Carregar arquivo local
            <input type="file" id="file" hidden accept=".nes,.sfc,.smc,.md,.gen,.bin,.smd,.sms,.gb,.gbc,.gba,.a26,.z64,.n64,.zip,.7z">
          </label>
          <select id="core" aria-label="Console do arquivo local">
            ${CON.map(x => `<option value="${x.core}"${x === c ? ' selected' : ''}>${x.n}</option>`).join('')}
          </select>
          <small>Use apenas arquivos que você tenha autorização para executar.</small>
        </div>
      </div>

      <div class="bar">
        <button type="button" class="btn ghost" id="pause" disabled>Pausar</button>
        <button type="button" class="btn ghost" id="qsave" disabled>Salvar estado</button>
        <button type="button" class="btn ghost" id="fs">Tela cheia</button>
        <button type="button" class="btn ghost" id="cfg">Controles e áudio</button>
      </div>

      <ul class="chips">
        <li class="c">${esc(consolesLabel(g))}</li>
        <li>${esc(g.year || '—')}</li>
        ${g.genres.map(x => `<li>${esc(x.name)}</li>`).join('')}
        <li>${esc(g.esrb || 'Livre')}</li>
      </ul>

      <p>${esc((desc || '').slice(0, 500))}${(desc || '').length > 500 ? '…' : ''}</p>
      <p class="dim">${devs?.length ? 'Desenvolvedora: ' + esc(devs.join(', ')) + ' · ' : ''}Dados: RAWG</p>

      <h2>Jogos relacionados</h2>
      <div id="rel" class="list">${sk(3)}</div>
    </section>
  `;

  const go = (url, core) => {
    if (emulatorTimer) clearTimeout(emulatorTimer);
    $$('script[data-ejs]').forEach(s => s.remove());
    $('#game').innerHTML = '';

    const ovl = $('#ovl');
    if (ovl) ovl.innerHTML = '<div class="spin"></div><p>Iniciando emulador…</p>';
    started = true;

    const onStarted = () => {
      if (emulatorTimer) {
        clearTimeout(emulatorTimer);
        emulatorTimer = null;
      }
      $('#ovl')?.remove();
      const pauseBtn = $('#pause');
      const qsaveBtn = $('#qsave');
      if (pauseBtn) pauseBtn.disabled = false;
      if (qsaveBtn) qsaveBtn.disabled = false;
    };

    Object.assign(window, {
      EJS_player: '#game',
      EJS_core: core,
      EJS_gameUrl: url,
      EJS_gameName: g.slug,
      EJS_pathtodata: CDN,
      EJS_startOnLoaded: true,
      EJS_color: '#000000',
      EJS_onGameStart: onStarted,
      EJS_ready: onStarted
    });

    const fail = t => {
      if (emulatorTimer) {
        clearTimeout(emulatorTimer);
        emulatorTimer = null;
      }
      const o = $('#ovl');
      if (o) {
        o.innerHTML = `<p>${t}</p><button type="button" class="btn" id="retry-emu">Tentar novamente</button>`;
        $('#retry-emu').onclick = () => {
          destroyEmulator();
          route();
        };
        toast('Falha ao iniciar o emulador.');
      }
    };

    const s = document.createElement('script');
    s.src = CDN + 'loader.js';
    s.dataset.ejs = '1';
    s.onerror = () => fail('Não foi possível carregar o EmulatorJS. Verifique sua conexão.');
    document.body.append(s);
    emulatorTimer = setTimeout(
      () => fail('Tempo esgotado. Verifique se o arquivo corresponde ao console selecionado.'),
      45000
    );
  };

  $('#play') && ($('#play').onclick = () => go(g.rom.url, g.rom.core));
  $('#file').onchange = e => {
    const fl = e.target.files[0];
    if (fl) {
      if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
      currentBlobUrl = URL.createObjectURL(fl);
      go(currentBlobUrl, $('#core').value);
    }
  };

  let ps = false;
  $('#pause').onclick = e => {
    try {
      ps = !ps;
      ps ? window.EJS_emulator.pause() : window.EJS_emulator.play();
      e.target.textContent = ps ? 'Retomar' : 'Pausar';
    } catch {
      ps = false;
      toast('Pausa indisponível.');
    }
  };

  $('#qsave').onclick = () => {
    try {
      window.EJS_emulator.gameManager.quickSave();
      toast('Estado do jogo salvo.');
    } catch {
      toast('Este núcleo não suporta quick save.');
    }
  };

  $('#fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#stage').requestFullscreen?.());

  $('#cfg').onclick = () => {
    dlg(`
      <h2>Controles e áudio</h2>
      <label style="display:grid;gap:.4rem;margin-top:1rem">
        <span>Volume</span>
        <input type="range" id="vol" min="0" max="1" step=".05" value="1">
      </label>
      <p class="dim" style="margin-top:1rem">Teclado: setas direcionais e teclas Z, X, A, S; Enter equivale a Start. Em dispositivos móveis, os controles aparecem na tela.</p>
    `);
    $('#vol').oninput = e => {
      try {
        window.EJS_emulator.setVolume(+e.target.value);
      } catch {}
    };
  };

  api('games', { genres: g.genres[0]?.slug, platforms: mt?.id })
    .then(d => {
      const r = d.results.filter(x => x.id !== g.id).slice(0, 4);
      const rel = $('#rel');
      if (rel) {
        rel.innerHTML = r.length ? r.map(card).join('') : '<div class="empty item-enter"><p>Sem sugestões relacionadas.</p></div>';
      }
    })
    .catch(() => {
      const rel = $('#rel');
      if (rel) rel.innerHTML = '';
    });
}

/* =========================================================
   EVENTOS GLOBAIS & ROTEAMENTO
   ========================================================= */

document.addEventListener('click', async e => {
  const saveTrigger = e.target.closest('[data-save-game]');
  if (saveTrigger) {
    const id = +saveTrigger.dataset.saveGame;
    const gameObj = G[id] || getSavedGames().find(x => x.id === id);
    if (gameObj) {
      const ok = await toggleSaveGame(gameObj);
      if (ok && location.hash.startsWith('#/saved')) {
        const cardEl = saveTrigger.closest('[data-game-card]');
        if (cardEl) {
          cardEl.classList.add('item-exit');
          await new Promise(r => setTimeout(r, 100));
        }
        savedView();
      }
    }
    return;
  }

  const authTrigger = e.target.closest('[data-open-auth]');
  if (authTrigger) {
    openAuthModal(authTrigger.dataset.openAuth);
    return;
  }

  const d = e.target.closest('[data-dlg]');
  if (d) {
    dlg(TXT[d.dataset.dlg]);
    return;
  }

  const bg = e.target.closest('.burger');
  if (bg) {
    const isOpen = $('#nav-drawer').classList.contains('open');
    setMenuOpen(!isOpen);
    return;
  }

  if (!e.target.closest('#top-header') && $('#nav-drawer')?.classList.contains('open')) {
    setMenuOpen(false);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#nav-drawer')?.classList.contains('open')) {
    setMenuOpen(false);
  }
});

document.addEventListener('submit', e => {
  if (!e.target.matches('.sf')) return;
  e.preventDefault();
  const q = new FormData(e.target).get('q').trim();
  location.hash = '#/results' + (q ? '?search=' + encodeURIComponent(q) : '');
  setMenuOpen(false);
});

function route() {
  if (started) destroyEmulator();
  const [pa, qs] = (location.hash.slice(1) || '/').split('?');
  const s = pa.split('/');
  const p = new URLSearchParams(qs);
  const k = { results: 'search', game: 'search' }[s[1]] || s[1] || '';

  setMenuOpen(false);
  document.title = 'ROMS ONLINE — Jogos retrô no navegador';

  $$('#nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + k));

  view.classList.remove('go');
  void view.offsetWidth;
  view.classList.add('go');
  scrollTo(0, 0);

  ({
    search,
    consoles: consolesView,
    saved: savedView,
    results,
    game
  }[s[1]] || home)(p, s[2]);
}

addEventListener('hashchange', route);
restoreSession().then(() => route());
