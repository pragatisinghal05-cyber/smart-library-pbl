// Smart Library - web backend (no npm packages needed, Node 16+).
// Uses the SAME text files as the C/C++ console program, in the same format:
//   books.txt  : id|title|author|genre|available|timesIssued
//   issues.txt : user|bookId|ISSUED or RETURNED
//   users.txt  : username|password|role   (student records; web login itself uses data/auth.json)
// Web-only extras (the C program ignores them):
//   issue_dates.txt  : user|bookId|issuedAt|returnedAt
//   book_stock.txt   : bookId|totalCopies   (missing = 1 copy)
//   web_settings.json: loan period and fine per day
// Run:  node web/server.js    then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const BOOKS = path.join(DATA, 'books.txt');
const ISSUES = path.join(DATA, 'issues.txt');
const USERS = path.join(DATA, 'users.txt');
const DATES = path.join(DATA, 'issue_dates.txt');
const STOCKF = path.join(DATA, 'book_stock.txt');
const SETTINGS = path.join(DATA, 'web_settings.json');
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const TOP_BOOKS = 5, MAX_BOOKS = 500, DAY = 864e5;

// ---------- file helpers ----------
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim()) : [];
const write = (f, arr) => fs.writeFileSync(f, arr.length ? arr.join('\n') + '\n' : '');
const loadBooks = () => lines(BOOKS).map(l => { const p = l.split('|');
  return { id: +p[0], title: p[1], author: p[2], genre: p[3], available: +p[4], timesIssued: +p[5] }; });
const saveBooks = b => write(BOOKS, b.map(x => [x.id, x.title, x.author, x.genre, x.available, x.timesIssued].join('|')));
const loadIssues = () => lines(ISSUES).map(l => { const p = l.split('|'); return { user: p[0], bookId: +p[1], status: p[2] }; });
const saveIssues = r => write(ISSUES, r.map(x => [x.user, x.bookId, x.status].join('|')));
const loadUsers = () => lines(USERS).map(l => { const p = l.split('|'); return { name: p[0], pass: p[1], role: p[2] }; });
const saveUsers = u => write(USERS, u.map(x => [x.name, x.pass, x.role].join('|')));
const loadDates = () => lines(DATES).map(l => { const p = l.split('|'); return { user: p[0], bookId: +p[1], issuedAt: p[2], returnedAt: p[3] || '' }; });
const saveDates = d => write(DATES, d.map(x => [x.user, x.bookId, x.issuedAt, x.returnedAt].join('|')));
const getSettings = () => { try { return { loanDays: 14, finePerDay: 2, ...JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) }; } catch { return { loanDays: 14, finePerDay: 2 }; } };
const nowStamp = () => new Date().toISOString();
// stock = total copies of a book (web-only file; a book with no entry has 1 copy)
const loadStock = () => new Map(lines(STOCKF).map(l => { const p = l.split('|'); return [+p[0], +p[1]]; }));
const saveStock = m => write(STOCKF, [...m].map(([id, n]) => id + '|' + n));
const issuedOut = id => loadIssues().filter(r => r.bookId === id && r.status === 'ISSUED').length;

// ---------- transactions (issues.txt + dates + due date + fine) ----------
// Dates are matched per (user, book) pair from the newest backwards, so records made before
// dates existed (or by the C program) simply show no date.
function transactions() {
  const recs = loadIssues().map((r, i) => ({ ...r, seq: i + 1, issuedAt: '', returnedAt: '' }));
  const dates = loadDates(), books = new Map(loadBooks().map(b => [b.id, b])), S = getSettings();
  const groups = new Map();
  recs.forEach(r => { const k = r.user + '|' + r.bookId; (groups.get(k) || groups.set(k, []).get(k)).push(r); });
  for (const [k, rs] of groups) {
    const d = dates.filter(x => x.user + '|' + x.bookId === k), n = Math.min(d.length, rs.length);
    for (let i = 1; i <= n; i++) { rs[rs.length - i].issuedAt = d[d.length - i].issuedAt; rs[rs.length - i].returnedAt = d[d.length - i].returnedAt; }
  }
  const now = Date.now();
  return recs.map(r => {
    const b = books.get(r.bookId), o = { ...r, title: b ? b.title : '(deleted book)', author: b ? b.author : '', genre: b ? b.genre : '' };
    if (r.issuedAt) {
      const due = new Date(new Date(r.issuedAt).getTime() + S.loanDays * DAY);
      const end = r.status === 'ISSUED' ? now : (r.returnedAt ? new Date(r.returnedAt).getTime() : null);
      o.dueAt = due.toISOString();
      o.overdueDays = end ? Math.max(0, Math.ceil((end - due.getTime()) / DAY)) : 0;
      o.fine = o.overdueDays * S.finePerDay;
    } else { o.dueAt = ''; o.overdueDays = 0; o.fine = 0; }
    o.overdue = r.status === 'ISSUED' && o.overdueDays > 0;
    return o;
  });
}

// ---------- core actions (mirror library.c) ----------
function doIssue(user, id) {
  const books = loadBooks(), b = books.find(x => x.id === +id);
  if (!b) return ['Book not found', 404];
  const copies = loadStock().get(b.id) ?? 1, out = issuedOut(b.id);
  if (copies === 0) return ['Book is out of stock', 409];
  if (!b.available || out >= copies) return ['Book is already issued', 409];
  b.available = out + 1 < copies ? 1 : 0; b.timesIssued++;
  fs.appendFileSync(ISSUES, `${user}|${b.id}|ISSUED\n`);
  fs.appendFileSync(DATES, `${user}|${b.id}|${nowStamp()}|\n`);
  saveBooks(books); return null;
}
function doReturn(user, id) {
  const recs = loadIssues();
  const r = recs.find(x => x.user === user && x.bookId === +id && x.status === 'ISSUED');
  if (!r) return ['This student has not issued this book', 404];
  r.status = 'RETURNED'; saveIssues(recs);
  const dates = loadDates();
  for (let i = dates.length - 1; i >= 0; i--)
    if (dates[i].user === user && dates[i].bookId === r.bookId && !dates[i].returnedAt) { dates[i].returnedAt = nowStamp(); saveDates(dates); break; }
  const books = loadBooks(), b = books.find(x => x.id === r.bookId);
  if (b) { b.available = 1; saveBooks(books); }
  return null;
}
const cmp = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());
function sortBooks(list, mode) {
  const l = [...list];
  if (mode === 'author') l.sort((a, b) => cmp(a.author, b.author));
  else if (mode === 'popularity') l.sort((a, b) => b.timesIssued - a.timesIssued);
  else if (mode === 'id') l.sort((a, b) => a.id - b.id);
  else l.sort((a, b) => cmp(a.title, b.title));
  return l;
}
function recommend(user) {
  const hist = loadIssues().filter(r => r.user === user).map(r => r.bookId);
  if (!hist.length) return { message: 'No reading history yet. Issue a few books first.', books: [] };
  const books = loadBooks(), byId = new Map(books.map(b => [b.id, b])), cand = [];
  for (const b of books) {
    let s = 0, read = false;
    for (const id of hist) {
      if (id === b.id) { read = true; break; }
      const old = byId.get(id); if (!old) continue;
      if (old.genre === b.genre) s += 2;
      if (old.author === b.author) s += 3;
    }
    if (!read && s > 0) cand.push({ ...b, score: s });
  }
  cand.sort((a, b) => b.score - a.score);
  return { message: cand.length ? '' : 'No similar unread books found right now.', books: cand.slice(0, TOP_BOOKS) };
}
const countBy = (arr, key) => { const m = new Map(); arr.forEach(x => m.set(x[key], (m.get(x[key]) || 0) + 1)); return m; };
const csv = rows => rows.map(r => r.map(c => { c = String(c ?? ''); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(',')).join('\r\n');

// ---------- sessions & routing ----------
const sessions = new Map();
const tokenOf = req => (req.headers.authorization || '').replace('Bearer ', '');
const routes = [];
const route = (method, pattern, role, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), role, fn });
const ok = (data, code = 200) => ({ code, data });
const err = (msg, code = 400) => ({ code, data: { error: msg } });
const fromErr = e => e ? err(e[0], e[1]) : ok({ ok: true });
const bad = (...s) => s.some(x => String(x).includes('|'));

// --- auth (single owner, hashed password, one session at a time) ---
// Only OWNER_ID can log in. The password is never stored in plain text: data/auth.json keeps a
// salted scrypt hash. A one-time RECOVERY KEY (also stored only as a hash) powers "Forgot password".
const OWNER_ID = '520825171576';
const INITIAL_PASSWORD = 'pragati0011';   // <-- set this ONCE before the first run, then you can delete it
const AUTH = path.join(DATA, 'auth.json');
const IDLE_MS = 15 * 60 * 1000, MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
const checkPw = (pw, stored) => {
  const [alg, salt, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const a = Buffer.from(crypto.scryptSync(String(pw), salt, 64).toString('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const normRK = s => String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
const newRecoveryKey = () => crypto.randomBytes(12).toString('hex').toUpperCase().match(/.{4}/g).join('-');
const loadAuth = () => JSON.parse(fs.readFileSync(AUTH, 'utf8'));
const saveAuth = (id, pw, rk) => fs.writeFileSync(AUTH, JSON.stringify({ id, pass: hashPw(pw), recovery: hashPw(normRK(rk)) }, null, 2), { mode: 0o600 });
const pwProblem = p => (typeof p !== 'string' || p.length < 8 || p.length > 100) ? 'Password must be 8 to 100 characters'
  : (!/[A-Za-z]/.test(p) || !/\d/.test(p)) ? 'Password must contain at least one letter and one number' : '';
(function initAuth() {
  if (fs.existsSync(AUTH)) return;
  if (INITIAL_PASSWORD === 'SET_YOUR_PASSWORD_HERE' || pwProblem(INITIAL_PASSWORD)) {
    console.error('First run: open web/server.js and set INITIAL_PASSWORD (8+ characters, letters and numbers), then start again.');
    process.exit(1);
  }
  const rk = newRecoveryKey(); saveAuth(OWNER_ID, INITIAL_PASSWORD, rk);
  console.log('\n=== Secure login created (data/auth.json) ===\nRECOVERY KEY (shown ONLY now, write it down, it is used for "Forgot password"):\n  ' + rk + '\n');
})();
// brute-force protection: 5 wrong attempts from one address = locked for 15 minutes
const fails = new Map();
const ipOf = req => req.socket.remoteAddress || '?';
const lockLeft = ip => { const f = fails.get(ip); return f && f.n >= MAX_FAILS && f.until > Date.now() ? f.until - Date.now() : 0; };
const failed = ip => { const f = fails.get(ip); const n = f && f.until > Date.now() - LOCK_MS ? f.n + 1 : 1; fails.set(ip, { n, until: Date.now() + LOCK_MS }); };
const lockMsg = ms => err('Too many wrong attempts. Try again in ' + Math.ceil(ms / 60000) + ' minute(s).', 429);
const dropExpired = () => { for (const [t, s] of sessions) if (Date.now() - s.last > IDLE_MS) sessions.delete(t); };

route('POST', '/api/login', null, ({ req, body }) => {
  const ip = ipOf(req), wait = lockLeft(ip); if (wait) return lockMsg(wait);
  const a = loadAuth();
  const idOk = String(body.username || '') === a.id, pwOk = checkPw(body.password || '', a.pass);   // always check both
  if (!(idOk && pwOk)) { failed(ip); return err('Invalid ID or password', 401); }
  fails.delete(ip); dropExpired();
  if (sessions.size) return err('Someone is already logged in. Only one login is allowed at a time.', 409);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name: a.id, role: 'admin', last: Date.now() });
  return ok({ token, username: a.id, role: 'admin' });
});
route('POST', '/api/logout', 'any', ({ req }) => { sessions.delete(tokenOf(req)); return ok({ ok: true }); });
// Forgot password: needs the ID + the recovery key. Sets a new password, issues a NEW recovery key, kicks out any session.
route('POST', '/api/forgot', null, ({ req, body }) => {
  const ip = ipOf(req), wait = lockLeft(ip); if (wait) return lockMsg(wait);
  const a = loadAuth();
  const idOk = String(body.username || '') === a.id, rkOk = checkPw(normRK(body.recoveryKey), a.recovery);
  if (!(idOk && rkOk)) { failed(ip); return err('Invalid ID or recovery key', 401); }
  const bad1 = pwProblem(body.newPassword); if (bad1) return err(bad1);
  const rk = newRecoveryKey(); saveAuth(a.id, body.newPassword, rk);
  sessions.clear(); fails.delete(ip);
  return ok({ ok: true, recoveryKey: rk });
});
route('POST', '/api/password', 'any', ({ body }) => {
  const a = loadAuth();
  if (!checkPw(body.oldPassword || '', a.pass)) return err('Current password is wrong', 403);
  const bad1 = pwProblem(body.newPassword); if (bad1) return err(bad1);
  fs.writeFileSync(AUTH, JSON.stringify({ ...a, pass: hashPw(body.newPassword) }, null, 2), { mode: 0o600 });
  return ok({ ok: true });
});

// --- books ---
route('GET', '/api/books', 'any', ({ query }) => {
  const q = (query.get('q') || '').toLowerCase();
  let list = loadBooks();
  if (q) list = list.filter(b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) || String(b.id) === q);
  const stock = loadStock(), iss = loadIssues().filter(r => r.status === 'ISSUED');
  list = list.map(b => { const copies = stock.get(b.id) ?? 1, out = iss.filter(r => r.bookId === b.id).length; return { ...b, stock: copies, out }; });
  return ok(sortBooks(list, query.get('sort')));
});
route('POST', '/api/books', 'admin', ({ body }) => {
  const id = parseInt(body.id, 10), t = (body.title || '').trim(), a = (body.author || '').trim(), g = (body.genre || '').trim();
  if (!id || id < 1 || !t || !a || !g) return err('ID, title, author and genre are required');
  if (bad(t, a, g)) return err("The '|' character is not allowed");
  const books = loadBooks();
  if (books.length >= MAX_BOOKS) return err('Library is full', 409);
  if (books.some(b => b.id === id)) return err('A book with this ID already exists', 409);
  books.push({ id, title: t, author: a, genre: g, available: 1, timesIssued: 0 });
  saveBooks(books); return ok({ ok: true }, 201);
});
route('GET', '/api/books/(\\d+)', 'admin', ({ params }) => {
  const b = loadBooks().find(x => x.id === +params[0]);
  if (!b) return err('Book not found', 404);
  const log = transactions().filter(t => t.bookId === b.id).reverse();
  return ok({ ...b, holder: (log.find(t => t.status === 'ISSUED') || {}).user || null, log });
});
route('PUT', '/api/books/(\\d+)', 'admin', ({ params, body }) => {
  const books = loadBooks(), b = books.find(x => x.id === +params[0]);
  if (!b) return err('Book not found', 404);
  const t = (body.title ?? b.title).trim(), a = (body.author ?? b.author).trim(), g = (body.genre ?? b.genre).trim();
  if (!t || !a || !g) return err('Title, author and genre cannot be empty');
  if (bad(t, a, g)) return err("The '|' character is not allowed");
  Object.assign(b, { title: t, author: a, genre: g }); saveBooks(books); return ok({ ok: true });
});
route('PUT', '/api/books/(\\d+)/stock', 'admin', ({ params, body }) => {
  const books = loadBooks(), b = books.find(x => x.id === +params[0]);
  if (!b) return err('Book not found', 404);
  const n = Number(body.stock), out = issuedOut(b.id);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return err('Stock must be a whole number from 0 to 9999');
  if (n < out) return err('Stock cannot be less than the ' + out + ' cop' + (out === 1 ? 'y' : 'ies') + ' currently issued');
  const stock = loadStock(); stock.set(b.id, n); saveStock(stock);
  b.available = out < n ? 1 : 0; saveBooks(books);
  return ok({ ok: true });
});
route('DELETE', '/api/books/(\\d+)', 'admin', ({ params }) => {
  const books = loadBooks(), i = books.findIndex(b => b.id === +params[0]);
  if (i < 0) return err('Book not found', 404);
  if (issuedOut(books[i].id) > 0) return err('Cannot delete: this book is currently issued', 409);
  const stock = loadStock(); if (stock.delete(books[i].id)) saveStock(stock);
  books.splice(i, 1); saveBooks(books); return ok({ ok: true });
});

// --- student actions ---
route('POST', '/api/issue', 'student', ({ body, session }) => fromErr(doIssue(session.name, body.id)));
route('POST', '/api/return', 'student', ({ body, session }) => fromErr(doReturn(session.name, body.id)));
route('GET', '/api/history', 'student', ({ session }) => ok(transactions().filter(t => t.user === session.name).reverse()));
route('GET', '/api/recommendations', 'student', ({ session }) => ok(recommend(session.name)));

// --- admin: issue / return desk ---
route('POST', '/api/admin/issue', 'admin', ({ body }) => {
  const u = loadUsers().find(x => x.name === body.user && x.role === 'student');
  if (!u) return err('No student with that ID', 404);
  return fromErr(doIssue(u.name, body.id));
});
route('POST', '/api/admin/return', 'admin', ({ body }) => fromErr(doReturn(body.user, body.id)));

// --- stats / dashboard ---
route('GET', '/api/stats', 'any', ({ session }) => {
  const books = loadBooks(), out = { totalBooks: books.length, available: books.filter(b => b.available).length };
  out.issued = out.totalBooks - out.available;
  const tx = transactions();
  if (session.role === 'admin') {
    out.students = loadUsers().filter(u => u.role === 'student').length;
    out.overdue = tx.filter(t => t.overdue).length;
    out.totalFines = tx.reduce((s, t) => s + t.fine, 0);
  } else {
    const mine = tx.filter(t => t.user === session.name);
    out.myIssued = mine.filter(t => t.status === 'ISSUED').length; out.myTotal = mine.length;
    out.myFines = mine.reduce((s, t) => s + t.fine, 0);
  }
  return ok(out);
});
route('GET', '/api/dashboard', 'admin', () => {
  const books = loadBooks(), tx = transactions(), S = getSettings();
  const genres = [...new Set(books.map(b => b.genre))].sort().map(g => {
    const bs = books.filter(b => b.genre === g);
    return { genre: g, total: bs.length, available: bs.filter(b => b.available).length, issued: bs.filter(b => !b.available).length, timesIssued: bs.reduce((s, b) => s + b.timesIssued, 0) };
  });
  const borrowers = [...countBy(tx, 'user')].map(([user, total]) => ({ user, total, current: tx.filter(t => t.user === user && t.status === 'ISSUED').length }))
    .sort((a, b) => b.total - a.total).slice(0, 5);
  const days = []; // last 7 days of issue activity (only records that have dates)
  for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * DAY), key = d.toISOString().slice(0, 10);
    days.push({ day: key, issued: tx.filter(t => t.issuedAt.startsWith(key)).length, returned: tx.filter(t => t.returnedAt.startsWith(key)).length }); }
  const recent = tx.filter(t => t.issuedAt).sort((a, b) => (b.returnedAt || b.issuedAt).localeCompare(a.returnedAt || a.issuedAt)).slice(0, 8);
  return ok({
    settings: S, genres, borrowers, days, recent,
    topBooks: sortBooks(books, 'popularity').slice(0, 5),
    neverIssued: books.filter(b => b.timesIssued === 0).length,
    overdue: tx.filter(t => t.overdue).sort((a, b) => b.overdueDays - a.overdueDays),
    totalFines: tx.reduce((s, t) => s + t.fine, 0), totalIssues: tx.length
  });
});

// --- admin: full issue log ---
route('GET', '/api/transactions', 'admin', ({ query }) => {
  const user = (query.get('user') || '').toLowerCase(), book = (query.get('book') || '').toLowerCase(), status = query.get('status') || '';
  let tx = transactions().reverse();
  if (user) tx = tx.filter(t => t.user.toLowerCase().includes(user));
  if (book) tx = tx.filter(t => t.title.toLowerCase().includes(book) || String(t.bookId) === book);
  if (status === 'ISSUED' || status === 'RETURNED') tx = tx.filter(t => t.status === status);
  if (status === 'OVERDUE') tx = tx.filter(t => t.overdue);
  return ok(tx);
});

// --- admin: students ---
route('GET', '/api/students', 'admin', () => {
  const tx = transactions();
  return ok(loadUsers().filter(u => u.role === 'student').map(u => {
    const mine = tx.filter(t => t.user === u.name);
    return { username: u.name, current: mine.filter(t => t.status === 'ISSUED').length, total: mine.length,
      overdue: mine.filter(t => t.overdue).length, fines: mine.reduce((s, t) => s + t.fine, 0) };
  }));
});
route('GET', '/api/students/([^/]+)', 'admin', ({ params }) => {
  const name = decodeURIComponent(params[0]).trim();
  const u = loadUsers().find(x => x.name.toLowerCase() === name.toLowerCase() && x.role === 'student');
  if (!u) return err('No student found with ID "' + name + '"', 404);
  const all = transactions().filter(t => t.user === u.name).reverse();
  const current = all.filter(t => t.status === 'ISSUED');
  return ok({ username: u.name, currentCount: current.length, totalCount: all.length, overdueCount: current.filter(t => t.overdue).length,
    fines: all.reduce((s, t) => s + t.fine, 0), current, history: all.filter(t => t.status !== 'ISSUED'), recommendations: recommend(u.name).books });
});
route('POST', '/api/users', 'admin', ({ body }) => {
  const n = (body.username || '').trim(), p = body.password || '';
  if (!n || !p || bad(n, p) || n.length >= 30) return err("Invalid username/password (no '|' allowed, username under 30 characters)");
  if (loadUsers().some(u => u.name.toLowerCase() === n.toLowerCase())) return err('This username already exists', 409);
  fs.appendFileSync(USERS, `${n}|${p}|student\n`); return ok({ ok: true }, 201);
});
route('POST', '/api/students/([^/]+)/password', 'admin', ({ params, body }) => {
  const users = loadUsers(), u = users.find(x => x.name === decodeURIComponent(params[0]) && x.role === 'student');
  if (!u) return err('Student not found', 404);
  if (!body.password || bad(body.password)) return err("Password is empty or contains '|'");
  u.pass = body.password; saveUsers(users); return ok({ ok: true });
});
route('DELETE', '/api/students/([^/]+)', 'admin', ({ params }) => {
  const name = decodeURIComponent(params[0]), users = loadUsers(), i = users.findIndex(x => x.name === name && x.role === 'student');
  if (i < 0) return err('Student not found', 404);
  if (loadIssues().some(r => r.user === name && r.status === 'ISSUED')) return err('Cannot delete: this student still has books issued', 409);
  users.splice(i, 1); saveUsers(users); return ok({ ok: true });
});

// --- admin: settings & export ---
route('GET', '/api/settings', 'admin', () => ok(getSettings()));
route('PUT', '/api/settings', 'admin', ({ body }) => {
  const loanDays = parseInt(body.loanDays, 10), finePerDay = parseFloat(body.finePerDay);
  if (!(loanDays >= 1 && loanDays <= 365) || !(finePerDay >= 0 && finePerDay <= 10000)) return err('Loan days must be 1-365 and fine per day 0 or more');
  fs.writeFileSync(SETTINGS, JSON.stringify({ loanDays, finePerDay }, null, 2)); return ok({ ok: true });
});
route('GET', '/api/export/(books|transactions)', 'admin', ({ params }) => {
  if (params[0] === 'books') return { code: 200, csv: csv([['ID', 'Title', 'Author', 'Genre', 'Status', 'Times issued'],
    ...loadBooks().map(b => [b.id, b.title, b.author, b.genre, b.available ? 'Available' : 'Issued', b.timesIssued])]) };
  return { code: 200, csv: csv([['Student', 'Book ID', 'Title', 'Status', 'Issued at', 'Due at', 'Returned at', 'Overdue days', 'Fine'],
    ...transactions().reverse().map(t => [t.user, t.bookId, t.title, t.status, t.issuedAt, t.dueAt, t.returnedAt, t.overdueDays, t.fine])]) };
});

// ---------- server ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (!url.pathname.startsWith('/api/')) {
    const f = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(f));
  }
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'Bad JSON' }); }
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      let session = sessions.get(tokenOf(req));
      if (session && Date.now() - session.last > IDLE_MS) { sessions.delete(tokenOf(req)); session = undefined; }   // idle timeout
      if (session) session.last = Date.now();
      if (r.role && !session) return send(401, { error: 'Please log in' });
      if (r.role && r.role !== 'any' && session.role !== r.role) return send(403, { error: 'Not allowed for your role' });
      try {
        const out = r.fn({ req, body, query: url.searchParams, params: m.slice(1), session });
        if (out.csv !== undefined) { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(out.csv); }
        return send(out.code, out.data);
      } catch (e) { console.error(e); return send(500, { error: 'Server error' }); }
    }
    send(404, { error: 'Unknown API route' });
  });
}).listen(PORT, () => console.log(`Smart Library running at http://localhost:${PORT}`));
