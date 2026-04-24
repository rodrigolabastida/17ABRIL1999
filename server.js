const express = require('express');
const cors = require('cors');
const path = require('path');
const Parser = require('rss-parser');
const cron = require('node-cron');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
require('dotenv').config();

process.on('uncaughtException', (err) => {
    console.error('❌ CRASH: Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ CRASH: Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(express.json());
app.use(cors());
app.use(session({
    secret: process.env.SESSION_SECRET || 'intlax_secret',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());
app.get('/ping', (req, res) => res.send('pong'));

const parser = new Parser({
    customFields: {
        item: ['description', 'content:encoded', 'media:content', 'enclosure']
    }
});

const PORT = process.env.PORT || 3000;

// Inicialización de SQLite (Asíncrono para máxima compatibilidad)
const db = new sqlite3.Database(path.join(__dirname, 'intlax.db'), (err) => {
    if (err) console.error('❌ Error al abrir base de datos:', err.message);
    else console.log('✅ Base de datos SQLite conectada.');
});

// Helpers para Promesas
const dbQuery = {
    run: (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { if (err) rej(err); else res(this); })),
    get: (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => { if (err) rej(err); else res(row); })),
    all: (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); })),
    exec: (sql) => new Promise((res, rej) => db.exec(sql, (err) => { if (err) rej(err); else res(); }))
};

// Crear Tablas
async function initDB() {
    try {
        await dbQuery.exec(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                google_id TEXT UNIQUE,
                nombre TEXT,
                email TEXT,
                foto_perfil TEXT,
                puntos_reputacion INTEGER DEFAULT 0,
                fecha_registro DATETIME DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS noticias (
                id TEXT PRIMARY KEY,
                titulo TEXT,
                resumen TEXT,
                imageUrl TEXT,
                linkOriginal TEXT UNIQUE,
                fuente TEXT,
                fecha_publicacion DATETIME,
                puntuacion INTEGER,
                vistas INTEGER,
                municipio TEXT,
                lat REAL,
                lng REAL,
                fecha_captura DATETIME,
                slug TEXT
            );
            CREATE TABLE IF NOT EXISTS comentarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                noticia_id TEXT,
                user_id INTEGER,
                comentario TEXT,
                fecha DATETIME DEFAULT (datetime('now')),
                FOREIGN KEY (noticia_id) REFERENCES noticias(id),
                FOREIGN KEY (user_id) REFERENCES usuarios(id)
            );
            CREATE TABLE IF NOT EXISTS valoraciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                noticia_id TEXT,
                user_id INTEGER,
                puntos INTEGER CHECK(puntos BETWEEN 1 AND 5),
                FOREIGN KEY (noticia_id) REFERENCES noticias(id),
                FOREIGN KEY (user_id) REFERENCES usuarios(id)
            );
        `);
        console.log('✅ Tablas de base de datos verificadas.');
    } catch (err) {
        console.error('❌ Error al inicializar tablas:', err.message);
    }
}
initDB();

// Passport Config (Opcional si faltan variables de entorno)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback" // URL relativa: Passport detectará el host automáticamente
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            let user = await dbQuery.get('SELECT * FROM usuarios WHERE google_id = ?', [profile.id]);
            if (!user) {
                const result = await dbQuery.run('INSERT INTO usuarios (google_id, nombre, email, foto_perfil) VALUES (?, ?, ?, ?)', 
                    [profile.id, profile.displayName, profile.emails[0].value, profile.photos[0].value]);
                user = await dbQuery.get('SELECT * FROM usuarios WHERE id = ?', [result.lastID]);
            }
            return done(null, user);
        } catch (err) { return done(err); }
    }));
    console.log('✅ Google OAuth configurado correctamente.');
} else {
    console.warn('⚠️ ADVERTENCIA: Faltan variables de entorno para Google OAuth. El login estará deshabilitado.');
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await dbQuery.get('SELECT * FROM usuarios WHERE id = ?', [id]);
        done(null, user);
    } catch (err) { done(err); }
});

// Función generadora de Slug SEO
function generarSlug(titulo) {
    if (!titulo) return Math.random().toString(36).substr(2, 9);
    return titulo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) + '-' + Math.random().toString(36).substr(2, 5);
}

// Fuentes RSS
const FEED_URLS = [
    { url: 'https://www.385grados.com/feed', source: '385 Grados' },
    { url: 'https://tlaxcala.quadratin.com.mx/feed/', source: 'Quadratin Tlaxcala' },
    { url: 'https://sintesis.com.mx/tlaxcala/feed/', source: 'Síntesis Tlaxcala' },
    { url: 'https://www.e-tlaxcala.mx/rss.xml', source: 'e-Tlaxcala' },
    { url: 'https://www.elsoldetlaxcala.com.mx/rss.xml', source: 'El Sol de Tlaxcala' },
    { url: 'https://exclusivastlaxcala.com.mx/feed/', source: 'Exclusivas Tlaxcala' },
    { url: 'https://faronoticias.com.mx/feed/', source: 'Faro Noticias' }
];

app.use(express.static(path.join(__dirname, 'public')));

function calculateDistance(lat1, lon1, lat2, lon2) {
    const x = lat2 - lat1; const y = lon2 - lon1;
    return Math.sqrt(x * x + y * y);
}

function limpiarUrlAltaResolucion(url) {
    if (!url) return null;
    return url.replace(/-\d+x\d+(?=\.[a-zA-Z]+$)/, '').replace('-scaled', '');
}

async function extraerUrlImagen(item) {
    let urlCruda = null;
    if (item['media:content'] && item['media:content'].$ && item['media:content'].$.url) urlCruda = item['media:content'].$.url;
    else if (item.enclosure && item.enclosure.url && item.enclosure.type && item.enclosure.type.startsWith('image/')) urlCruda = item.enclosure.url;
    else {
        const htmlToSearch = item['content:encoded'] || item.content || item.description || '';
        if (htmlToSearch) {
            const $ = cheerio.load(htmlToSearch);
            $('img').each((i, el) => {
                const src = $(el).attr('data-lazy-src') || $(el).attr('data-src') || $(el).attr('srcset') || $(el).attr('src');
                if (src) { urlCruda = src; return false; }
            });
        }
    }
    if (urlCruda) return limpiarUrlAltaResolucion(urlCruda).trim();
    return '/img/placeholder-noticia.jpg';
}

function extractSummary(desc) {
    if (!desc) return "Sin resumen disponible.";
    const text = desc.replace(/<[^>]+>/g, '').trim();
    return text.length > 250 ? text.slice(0, 250) + '...' : text || "Sin resumen disponible.";
}

function calcularInteres(titulo, resumen) {
    let puntuacion = 50;
    const txtTitulo = (titulo || "").toLowerCase();
    const txtResumen = (resumen || "").toLowerCase();
    const kH = ["accidente", "muerto", "fallece", "detienen", "balacera", "robo", "asalto", "tragedia", "choque"];
    kH.forEach(p => { if (txtTitulo.includes(p)) puntuacion += 40; if (txtResumen.includes(p)) puntuacion += 20; });
    return puntuacion;
}

async function fetchAllRssFeeds() {
    console.log('🔄 Extrayendo nuevos feeds RSS...');
    for (const feedData of FEED_URLS) {
        try {
            const feed = await parser.parseURL(feedData.url);
            for (const item of feed.items.slice(0, 50)) {
                const summaryText = extractSummary(item.description || item.content);
                const score = calcularInteres(item.title, summaryText);
                const imageUrl = await extraerUrlImagen(item);
                const slug = generarSlug(item.title);
                
                await dbQuery.run(`
                    INSERT INTO noticias (id, titulo, resumen, imageUrl, linkOriginal, fuente, fecha_publicacion, puntuacion, vistas, municipio, lat, lng, fecha_captura, slug)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(linkOriginal) DO UPDATE SET vistas = vistas + 1
                `, [Math.random().toString(36).substr(2, 9), item.title, summaryText, imageUrl, item.link, feedData.source, 
                   item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(), score, 100, '', 19.31, -98.24, new Date().toISOString(), slug]);
            }
        } catch (err) { console.error(`Error en ${feedData.source}:`, err.message); }
    }
    console.log('✅ Extracción completada.');
}

cron.schedule('0 * * * *', fetchAllRssFeeds);

// API v1
app.get('/api/v1/feed', async (req, res) => {
    try {
        const rows = await dbQuery.all(`SELECT * FROM noticias ORDER BY (fecha_captura >= datetime('now', '-24 hours')) DESC, puntuacion DESC LIMIT 31`);
        if (!rows.length) return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
        res.json({ noticiaPrincipal: rows[0], noticiasSecundarias: rows.slice(1) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/search', async (req, res) => {
    const q = `%${(req.query.q || '').trim()}%`;
    try {
        const rows = await dbQuery.all(`SELECT * FROM noticias WHERE titulo LIKE ? OR resumen LIKE ? LIMIT 50`, [q, q]);
        res.json({ resultados: rows, relacionados: [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/noticias/:slug', async (req, res) => {
    try {
        const noticia = await dbQuery.get('SELECT * FROM noticias WHERE slug = ?', [req.params.slug]);
        if (!noticia) return res.status(404).json({ error: 'Noticia no encontrada' });
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [noticia.id]);
        const comments = await dbQuery.all('SELECT c.*, u.nombre as usuario_nombre, u.foto_perfil FROM comentarios c JOIN usuarios u ON c.user_id = u.id WHERE noticia_id = ? ORDER BY fecha DESC', [noticia.id]);
        res.json({ noticia, valoracion: val, comentarios: comments, user: req.user || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/valorar', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login necesario' });
    try {
        await dbQuery.run('INSERT INTO valoraciones (noticia_id, user_id, puntos) VALUES (?, ?, ?)', [req.body.noticia_id, req.user.id, req.body.puntos]);
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [req.body.noticia_id]);
        res.json({ ok: true, promedio: val.promedio, total: val.total });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/comentar', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login necesario' });
    try {
        await dbQuery.run('INSERT INTO comentarios (noticia_id, user_id, comentario) VALUES (?, ?, ?)', [req.body.noticia_id, req.user.id, req.body.comentario]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/user-status', (req, res) => res.json(req.user || {}));

// Auth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// SSR Noticia
app.get('/noticias/:slug', async (req, res) => {
    try {
        const noticia = await dbQuery.get('SELECT * FROM noticias WHERE slug = ?', [req.params.slug]);
        if (!noticia) return res.sendFile(path.join(__dirname, 'public/index.html'));
        
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [noticia.id]);
        const comments = await dbQuery.all('SELECT c.*, u.nombre as usuario_nombre, u.foto_perfil FROM comentarios c JOIN usuarios u ON c.user_id = u.id WHERE noticia_id = ? ORDER BY fecha DESC LIMIT 10', [noticia.id]);
        
        const promedio = val.promedio ? parseFloat(val.promedio).toFixed(1) : '0';
        const pct = Math.round((parseFloat(promedio) / 5) * 100);
        let barColor = promedio >= 4 ? '#22C55E' : (promedio >= 3 ? '#FFCC00' : '#EF4444');

        const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${noticia.titulo} | Intlax</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap" rel="stylesheet"><link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'><style>body{background:#121212;color:#fff;font-family:Inter,sans-serif;margin:0;padding-bottom:50px}.top-bar{padding:15px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center}.logo{color:#FFCC00;font-weight:800;font-size:20px;text-decoration:none}.hero-img{width:100%;height:250px;object-fit:cover}.content{padding:20px}.title{font-size:24px;margin:15px 0}.source{color:#FFCC00;font-weight:700;font-size:12px;text-transform:uppercase}.summary{line-height:1.6;color:#ccc}.btn-p{background:#FFCC00;color:#121212;padding:15px;border-radius:10px;text-align:center;display:block;text-decoration:none;font-weight:800;margin:20px 0}.rating-box{background:#1C1C1E;padding:15px;border-radius:12px}.bar-bg{background:#333;height:10px;border-radius:5px;overflow:hidden}.bar-fill{height:100%;transition:0.3s}.comment-item{background:#1C1C1E;padding:12px;border-radius:10px;margin-bottom:10px}.user-info{display:flex;align-items:center;gap:10px;margin-bottom:5px}.user-img{width:24px;height:24px;border-radius:50%}</style></head><body><header class="top-bar"><a href="/" class="logo">Intlax</a><button onclick="history.back()" style="background:none;border:none;color:#fff;font-size:24px"><i class='bx bx-arrow-back'></i></button></header><img src="${noticia.imageUrl}" class="hero-img"><div class="content"><p class="source">${noticia.fuente}</p><h1 class="title">${noticia.titulo}</h1><p class="summary">${noticia.resumen}</p><a href="${noticia.linkOriginal}" class="btn-p">VER NOTA COMPLETA</a><div class="rating-box"><h3>Confiabilidad</h3><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div><p>${promedio}/5 (${val.total || 0} votos)</p></div><div style="margin-top:30px"><h3>Comunidad</h3>${comments.map(c => `<div class="comment-item"><div class="user-info"><img src="${c.foto_perfil}" class="user-img"><b>${c.usuario_nombre}</b></div><p style="margin:0;font-size:14px">${c.comentario}</p></div>`).join('')}${req.isAuthenticated() ? `<div style="margin-top:15px"><textarea id="ctx" style="width:100%;background:#121212;color:#fff;border:1px solid #333;border-radius:8px;padding:10px" placeholder="Escribe un comentario..."></textarea><button onclick="postC()" style="width:100%;background:#FFCC00;border:none;padding:10px;margin-top:5px;border-radius:8px;font-weight:700">Publicar</button></div>` : `<a href="/auth/google" class="btn-p" style="font-size:14px;padding:10px">Inicia sesión para comentar</a>`}</div></div><script>async function postC(){const c=document.getElementById('ctx').value;if(!c)return;const r=await fetch('/api/v1/comentar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noticia_id:'${noticia.id}',comentario:c})});if(r.ok)location.reload();}</script></body></html>`;
        res.send(html);
    } catch (err) { res.sendFile(path.join(__dirname, 'public/index.html')); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

app.listen(PORT, () => {
    console.log(`🚀 Intlax escuchando en puerto ${PORT}`);
    setTimeout(fetchAllRssFeeds, 1000);
});
