'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = process.env.RAWG_KEY;
const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const ROMS = path.join(__dirname, 'roms');
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const RETRO = '49,79,167,74,26,43,24,23,83,27';
const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json;charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp'
};

let catalog = [];
try {
  catalog = JSON.parse(fs.readFileSync(path.join(ROMS, 'catalog.json'), 'utf8'));
} catch {}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

function createSession(userId) {
  const now = Date.now();
  for (const [tok, sess] of sessions.entries()) {
    if (sess.expiresAt <= now) sessions.delete(tok);
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, expiresAt: now + SESSION_TTL_MS });
  return token;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const keyBuf = Buffer.from(key, 'hex');
  const hashBuf = Buffer.from(hash, 'hex');
  if (keyBuf.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, hashBuf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        req.destroy();
        reject(Object.assign(new Error('Payload muito grande.'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON inválido.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token || !sessions.has(token)) return null;
  const sess = sessions.get(token);
  if (sess.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const users = readUsers();
  const user = users.find(u => u.id === sess.userId);
  return user ? { token, user, users } : null;
}

const rom = slug => {
  const r = catalog.find(x => x.slug === slug);
  if (!r) return null;
  try {
    return {
      url: '/roms/' + r.file,
      core: r.core,
      size: fs.statSync(path.join(ROMS, r.file)).size
    };
  } catch {
    return null;
  }
};

const cache = new Map();

async function rawg(p, q = {}) {
  if (!KEY || KEY === 'cole_sua_chave_aqui') {
    throw Object.assign(
      new Error('Chave da RAWG não configurada. Defina uma RAWG_KEY válida no arquivo .env.'),
      { status: 503 }
    );
  }
  const u = new URL('https://api.rawg.io/api' + p);
  for (const [k, v] of Object.entries(q)) if (v) u.searchParams.set(k, v);
  const ck = u.href;
  const c = cache.get(ck);
  if (c && c.t > Date.now()) return c.d;
  u.searchParams.set('key', KEY);
  const r = await fetch(u);
  if (!r.ok) {
    const msg = r.status === 401
      ? 'Chave da RAWG inválida ou expirada (erro 401).'
      : 'Falha na fonte de dados (RAWG ' + r.status + ').';
    throw Object.assign(new Error(msg), { status: r.status === 429 ? 429 : 502 });
  }
  const d = await r.json();
  cache.set(ck, { d, t: Date.now() + 6e5 });
  return d;
}

const slim = g => ({
  id: g.id,
  slug: g.slug,
  name: g.name,
  cover: (g.background_image || '').replace('/media/', '/media/resize/420/-/'),
  year: (g.released || '').slice(0, 4),
  rating: g.rating,
  esrb: g.esrb_rating?.name || null,
  platforms: (g.platforms || []).map(p => ({ id: p.platform.id, name: p.platform.name })),
  genres: (g.genres || []).map(x => ({ slug: x.slug, name: x.name })),
  rom: rom(g.slug)
});

const sources = {
  rawg: {
    async list(q) {
      const d = await rawg('/games', {
        search: q.search,
        platforms: q.platforms || RETRO,
        genres: q.genres,
        ordering: q.ordering,
        page: q.page,
        page_size: 12,
        dates: q.year && `${q.year}-01-01,${q.year}-12-31`
      });
      return { next: !!d.next, results: d.results.map(slim) };
    },
    async detail(id) {
      const g = await rawg('/games/' + id);
      return { ...slim(g), desc: g.description_raw, devs: (g.developers || []).map(d => d.name) };
    },
    async genres() {
      const d = await rawg('/genres');
      return { results: d.results.map(g => ({ slug: g.slug, name: g.name })) };
    }
  }
};

const src = sources[process.env.SOURCE || 'rawg'];

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (code, obj) => {
    res.writeHead(code, {
      'content-type': 'application/json;charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  };

  try {
    // --- ROTAS DE AUTENTICAÇÃO E JOGOS SALVOS ---
    if (u.pathname === '/api/auth/register' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!name || name.length < 2) return send(400, { error: 'Informe um nome com pelo menos 2 caracteres.' });
      if (!email || !email.includes('@')) return send(400, { error: 'Informe um e-mail válido.' });
      if (password.length < 4) return send(400, { error: 'A senha deve ter pelo menos 4 caracteres.' });

      const users = readUsers();
      if (users.some(x => x.email === email)) {
        return send(409, { error: 'Este e-mail já está cadastrado.' });
      }

      const user = {
        id: crypto.randomUUID(),
        name,
        email,
        passwordHash: hashPassword(password),
        savedGames: Array.isArray(body.savedGames) ? body.savedGames : [],
        createdAt: new Date().toISOString()
      };
      users.push(user);
      writeUsers(users);

      const token = createSession(user.id);
      return send(201, {
        token,
        user: { id: user.id, name: user.name, email: user.email, savedGames: user.savedGames }
      });
    }

    if (u.pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      const users = readUsers();
      const user = users.find(x => x.email === email);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return send(401, { error: 'E-mail ou senha incorretos.' });
      }

      const token = createSession(user.id);
      return send(200, {
        token,
        user: { id: user.id, name: user.name, email: user.email, savedGames: user.savedGames || [] }
      });
    }

    if (u.pathname === '/api/auth/logout' && req.method === 'POST') {
      const auth = getAuthUser(req);
      if (auth) sessions.delete(auth.token);
      return send(200, { ok: true });
    }

    if (u.pathname === '/api/auth/me' && req.method === 'GET') {
      const auth = getAuthUser(req);
      if (!auth) return send(401, { error: 'Sessão inválida ou expirada.' });
      const { user } = auth;
      return send(200, {
        user: { id: user.id, name: user.name, email: user.email, savedGames: user.savedGames || [] }
      });
    }

    if (u.pathname === '/api/saved' && req.method === 'POST') {
      const auth = getAuthUser(req);
      if (!auth) return send(401, { error: 'Faça login para salvar jogos.' });
      const body = await readBody(req);
      const game = body.game;
      if (!game || !game.id) return send(400, { error: 'Dados do jogo inválidos.' });

      const list = auth.user.savedGames || [];
      const exists = list.some(x => x.id === game.id);
      if (!exists) {
        auth.user.savedGames = [{ ...game, savedAt: new Date().toISOString() }, ...list];
        writeUsers(auth.users);
      }
      return send(200, { savedGames: auth.user.savedGames });
    }

    const delMatch = u.pathname.match(/^\/api\/saved\/(\d+)$/);
    if (delMatch && req.method === 'DELETE') {
      const auth = getAuthUser(req);
      if (!auth) return send(401, { error: 'Faça login para gerenciar jogos salvos.' });
      const gameId = Number(delMatch[1]);
      auth.user.savedGames = (auth.user.savedGames || []).filter(x => x.id !== gameId);
      writeUsers(auth.users);
      return send(200, { savedGames: auth.user.savedGames });
    }

    // --- ROTAS DE JOGOS (RAWG) ---
    if (u.pathname.startsWith('/api/')) {
      const q = Object.fromEntries(u.searchParams);
      const m = u.pathname.match(/^\/api\/games\/([\w-]+)$/);
      if (m) return send(200, await src.detail(m[1]));
      if (u.pathname === '/api/games') return send(200, await src.list(q));
      if (u.pathname === '/api/genres') return send(200, await src.genres());
      return send(404, { error: 'Rota não encontrada.' });
    }

    // --- ARQUIVOS ESTÁTICOS ---
    const r = u.pathname.startsWith('/roms/')
      ? [ROMS, u.pathname.slice(6)]
      : [PUB, u.pathname === '/' ? 'index.html' : u.pathname.slice(1)];

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(r[1]);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain;charset=utf-8' });
      return res.end('Requisição inválida');
    }

    const f = path.normalize(path.join(r[0], decodedPath));
    const isInsideRoot = f === r[0] || f.startsWith(r[0] + path.sep);

    if (
      !isInsideRoot ||
      path.basename(f) === 'catalog.json' ||
      !fs.existsSync(f) ||
      fs.statSync(f).isDirectory()
    ) {
      res.writeHead(404, { 'content-type': 'text/plain;charset=utf-8' });
      return res.end('Não encontrado');
    }

    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    send(e.status || 500, { error: e.message });
  }
}).listen(PORT, () => console.log('ROMS ONLINE em http://localhost:' + PORT));
