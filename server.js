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
// Configuración de variables de entorno con respaldo para Hostinger
const fs = require('fs');
const localEnv = path.join(__dirname, '.env');
const parentEnv = path.join(__dirname, '..', '.env');

if (fs.existsSync(localEnv)) {
    require('dotenv').config({ path: localEnv });
} else if (fs.existsSync(parentEnv)) {
    require('dotenv').config({ path: parentEnv });
    console.log('🛡️ Usando .env desde carpeta superior (Blindaje Hostinger activo)');
} else {
    require('dotenv').config(); // Fallback por si están en variables de sistema
}

process.on('uncaughtException', (err) => {
    console.error('❌ CRASH: Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ CRASH: Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.set('trust proxy', 1); // Necesario para detectar HTTPS detrás de proxies como Nginx
app.use(express.json());
app.use(cors());
app.use(session({
    secret: process.env.SESSION_SECRET || 'intlax_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Recomendado para HTTPS
}));
app.use(passport.initialize());
app.use(passport.session());

// Middleware para verificar si Auth esta configurado
const authConfigured = (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return res.status(503).send('Servicio de autenticación no configurado.');
    }
    next();
};

app.get('/ping', (req, res) => res.send('pong'));

const parser = new Parser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
    },
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
                fecha_registro DATETIME DEFAULT (datetime('now')),
                rol TEXT DEFAULT 'user'
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
                vistas INTEGER DEFAULT 0,
                municipio TEXT,
                lat REAL,
                lng REAL,
                fecha_captura DATETIME,
                slug TEXT
            );
            CREATE TABLE IF NOT EXISTS comentarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                noticia_id TEXT,
                user_id INTEGER NULL,
                comentario TEXT,
                ip_address TEXT,
                fecha DATETIME DEFAULT (datetime('now')),
                FOREIGN KEY (noticia_id) REFERENCES noticias(id),
                FOREIGN KEY (user_id) REFERENCES usuarios(id)
            );
            CREATE TABLE IF NOT EXISTS valoraciones (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                noticia_id TEXT,
                user_id INTEGER NULL,
                puntos INTEGER CHECK(puntos BETWEEN 1 AND 5),
                ip_address TEXT,
                FOREIGN KEY (noticia_id) REFERENCES noticias(id),
                FOREIGN KEY (user_id) REFERENCES usuarios(id)
            );
            CREATE TABLE IF NOT EXISTS favoritos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                noticia_id TEXT,
                user_id INTEGER,
                fecha DATETIME DEFAULT (datetime('now')),
                UNIQUE(noticia_id, user_id),
                FOREIGN KEY (noticia_id) REFERENCES noticias(id),
                FOREIGN KEY (user_id) REFERENCES usuarios(id)
            );
            -- Índices de Alto Rendimiento
            CREATE INDEX IF NOT EXISTS idx_slug ON noticias(slug);
            CREATE INDEX IF NOT EXISTS idx_relevancia ON noticias(fecha_captura, puntuacion);
            CREATE INDEX IF NOT EXISTS idx_vistas ON noticias(vistas);
        `);
        console.log('✅ Base de datos optimizada con índices de velocidad.');

        // Migración simple para columnas nuevas
        try {
            await dbQuery.exec(`
                ALTER TABLE comentarios ADD COLUMN ip_address TEXT;
                ALTER TABLE valoraciones ADD COLUMN ip_address TEXT;
                ALTER TABLE noticias ADD COLUMN etiqueta_foro TEXT;
            `);
            console.log('✅ Columnas de IP y Etiqueta Foro añadidas.');
        } catch (e) {
            // Ignoramos si las columnas ya existen
        }
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
function generarSlug(texto) {
    if (!texto) return Math.random().toString(36).substr(2, 9);
    return texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 90);
}

// Fuentes RSS
const FEED_URLS = [
    { url: 'https://www.385grados.com/feed', source: '385 Grados' },
    { url: 'https://tlaxcala.quadratin.com.mx/feed/', source: 'Quadratin Tlaxcala' },
    { url: 'https://sintesis.com.mx/tlaxcala/feed/', source: 'Síntesis Tlaxcala' },
    { url: 'https://www.e-tlaxcala.mx/feed/', source: 'e-Tlaxcala' },
    { url: 'https://www.elsoldetlaxcala.com.mx/rss.xml', source: 'El Sol de Tlaxcala' },
    { url: 'https://exclusivastlaxcala.com.mx/feed/', source: 'Exclusivas Tlaxcala' },
    { url: 'https://faronoticias.com.mx/feed/', source: 'Faro Noticias' },
    { url: 'https://laprensadetlaxcala.com/feed/', source: 'La Prensa de Tlaxcala' },
    { url: 'https://www.sndigital.mx/feed/', source: 'SN Digital' },
    { url: 'https://lineadecontraste.com/feed/', source: 'Línea de Contraste' },
    { url: 'https://www.elcuartodeguerra.com/feed/', source: 'El Cuarto de Guerra' },
    { url: 'https://www.alertavigilante.com/feeds/posts/default?alt=rss', source: 'Alerta Vigilante RSS' },
    { url: 'https://www.alertavigilante.com/feeds/posts/default', source: 'Alerta Vigilante Atom' }
];

app.use(express.static(path.join(__dirname, 'public')));

function calculateDistance(lat1, lon1, lat2, lon2) {
    const x = lat2 - lat1; const y = lon2 - lon1;
    return Math.sqrt(x * x + y * y);
}

function limpiarUrlAltaResolucion(url) {
    if (!url) return null;
    let cleanUrl = url.trim();
    // Si es un srcset (varias URLs separadas por comas), tomamos la primera
    if (cleanUrl.includes(',')) cleanUrl = cleanUrl.split(',')[0];
    // Si tiene medidas (ej: url.jpg 600w), tomamos solo la URL
    if (cleanUrl.includes(' ')) cleanUrl = cleanUrl.trim().split(' ')[0];
    
    return cleanUrl.replace(/-\d+x\d+(?=\.[a-zA-Z]+$)/, '').replace('-scaled', '').trim();
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
                const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('srcset');
                if (src && src.startsWith('http')) { urlCruda = src; return false; }
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
    
    const kH = ["accidente", "muerto", "fallece", "detienen", "balacera", "robo", "asalto", "tragedia", "choque", "incendio", "homicidio", "ejecutado", "crimen"];
    const kGov = ["gobierno", "municipio", "comunicado", "boletín", "entrega", "obra", "reunion", "gobernadora", "alcalde"];

    kH.forEach(p => { if (txtTitulo.includes(p) || txtResumen.includes(p)) puntuacion += 25; });
    kGov.forEach(p => { if (txtTitulo.includes(p) || txtResumen.includes(p)) puntuacion -= 20; });
    
    return puntuacion;
}

function asignarEtiquetaForo(titulo, resumen) {
    const txt = (titulo + " " + resumen).toLowerCase();
    const seguridad = ["accidente", "muerto", "fallece", "detienen", "balacera", "robo", "asalto", "tragedia", "choque", "incendio", "homicidio", "policía", "fiscalía", "ejecutado"];
    const debate = ["gobierno", "municipio", "elecciones", "política", "congreso", "gobernadora", "alcalde", "presupuesto", "obra", "reforma"];
    const ayuda = [" extraviado", "perdido", "mascota", "apoyo", "comunidad", "vecinos", "donación", "servicio social"];

    if (seguridad.some(p => txt.includes(p))) return 'Alerta de Seguridad';
    if (debate.some(p => txt.includes(p))) return 'Debate Público';
    if (ayuda.some(p => txt.includes(p))) return 'Red de Apoyo';
    return null;
}

async function fetchAllRssFeeds(force = false) {
    // Eliminamos el bloqueo para asegurar extracción cada 30 min
    console.log('🔄 Extrayendo nuevos feeds RSS de internet...');
    for (const feedData of FEED_URLS) {
        try {
            const feed = await parser.parseURL(feedData.url);
            for (const item of feed.items.slice(0, 40)) {
                const summaryText = extractSummary(item.description || item.content);
                const score = calcularInteres(item.title, summaryText);
                const etiqueta = asignarEtiquetaForo(item.title, summaryText);
                const imageUrl = await extraerUrlImagen(item);
                const slug = generarSlug(item.title);
                
                // UPSERT Inteligente: Actualiza la puntuación pero NO infla vistas ni pisa la fecha original
                await dbQuery.run(`
                    INSERT INTO noticias (id, titulo, resumen, imageUrl, linkOriginal, fuente, fecha_publicacion, puntuacion, vistas, municipio, lat, lng, fecha_captura, slug, etiqueta_foro)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(linkOriginal) DO UPDATE SET 
                        puntuacion = excluded.puntuacion,
                        etiqueta_foro = COALESCE(noticias.etiqueta_foro, excluded.etiqueta_foro)
                `, [Math.random().toString(36).substr(2, 9), item.title, summaryText, imageUrl, item.link, feedData.source, 
                   item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(), score, 0, '', 19.31, -98.24, new Date().toISOString(), slug, etiqueta]);
            }
        } catch (err) { 
            // Log más discreto para no alarmar al usuario si un feed falla temporalmente
            console.log(`⚠️ Fuente ${feedData.source} no disponible temporalmente.`); 
        }
    }
    console.log('✅ Extracción completada.');
}

cron.schedule('*/30 * * * *', () => fetchAllRssFeeds(true));

// Adaptador para el frontend (Normalizar nombres de campos de DB a JSON)
function formatearFront(row) {
    // Si la noticia es vieja y no tiene slug, lo generamos al vuelo
    const finalSlug = row.slug || (row.titulo ? generarSlug(row.titulo) : row.id);
    const finalImage = limpiarUrlAltaResolucion(row.imageUrl) || '/img/placeholder-noticia.jpg';
    
    return {
        id: row.id,
        title: row.titulo,
        source: row.fuente,
        link: row.linkOriginal,
        pubDate: row.fecha_publicacion,
        time: new Date(row.fecha_publicacion).toLocaleDateString(),
        category: row.fuente,
        puntuacion: row.puntuacion,
        views: row.vistas,
        summary: row.resumen,
        image: finalImage,
        imageUrl: finalImage,
        slug: finalSlug,
        lat: row.lat,
        lng: row.lng,
        etiqueta_foro: row.etiqueta_foro
    };
}

// API v1 con Caché en Memoria para velocidad extrema
let cacheFeed = null;
let lastCacheTime = 0;

app.get('/api/v1/feed', async (req, res) => {
    try {
        const ahora = Date.now();
        if (cacheFeed && (ahora - lastCacheTime < 300000)) {
            return res.json(cacheFeed);
        }

        // Algoritmo de Relevancia Dinámico (v2.8): (Vistas + Interacciones + Puntuación de Interés) / Tiempo
        const rows = await dbQuery.all(`
            SELECT n.*, 
            (
                (n.vistas * 2 + n.puntuacion + COUNT(DISTINCT c.id) * 30 + COALESCE(AVG(v.puntos), 0) * 40) 
                * (CASE WHEN n.imageUrl LIKE '%placeholder%' THEN 0.05 ELSE 1.0 END)
            ) / (julianday('now') - julianday(n.fecha_captura) + 0.1) as score
            FROM noticias n
            LEFT JOIN comentarios c ON n.id = c.noticia_id
            LEFT JOIN valoraciones v ON n.id = v.noticia_id
            GROUP BY n.id
            ORDER BY score DESC 
            LIMIT 60
        `);
        
        if (!rows.length) return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
        
        const articles = rows.map(formatearFront);
        cacheFeed = { noticiaPrincipal: articles[0], noticiasSecundarias: articles.slice(1) };
        lastCacheTime = ahora;
        
        res.json(cacheFeed);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Endpoint de Foros: Noticias ordenadas por interacción reciente
app.get('/api/v1/foro', async (req, res) => {
    try {
        const categoria = req.query.categoria; // 'Todo', 'Alerta de Seguridad', etc.
        let filter = "WHERE n.etiqueta_foro IS NOT NULL";
        const params = [];

        if (categoria && categoria !== 'Todo') {
            const finalCat = (categoria === 'Ayuda' || categoria === 'Red de Apoyo') ? 'Red de Apoyo' : categoria;
            filter += " AND n.etiqueta_foro = ?";
            params.push(finalCat);
        }

        const rows = await dbQuery.all(`
            SELECT n.*, 
            (
                (COUNT(DISTINCT c.id) * 50 + COUNT(DISTINCT v.id) * 30) 
            ) as interaction_score
            FROM noticias n
            LEFT JOIN comentarios c ON n.id = c.noticia_id AND c.fecha >= datetime('now', '-48 hours')
            LEFT JOIN valoraciones v ON n.id = v.noticia_id
            ${filter}
            GROUP BY n.id
            ORDER BY interaction_score DESC, n.fecha_publicacion DESC
            LIMIT 40
        `, params);

        // Para cada noticia, obtener los 3 comentarios más relevantes
        const foros = await Promise.all(rows.map(async (row) => {
            const noticia = formatearFront(row);
            const comments = await dbQuery.all(`
                SELECT c.*, COALESCE(u.nombre, 'Ciudadano Anónimo') as usuario_nombre, 
                COALESCE(u.foto_perfil, '/img/avatar-anonimo.jpg') as foto_perfil 
                FROM comentarios c 
                LEFT JOIN usuarios u ON c.user_id = u.id 
                WHERE noticia_id = ? 
                ORDER BY c.fecha DESC LIMIT 3
            `, [row.id]);
            
            // Valoración promedio para la "Barra de Vida"
            const val = await dbQuery.get('SELECT AVG(puntos) as promedio FROM valoraciones WHERE noticia_id = ?', [row.id]);
            noticia.promedio_valoracion = val.promedio || 3;
            noticia.comentarios_destacados = comments;
            return noticia;
        }));

        res.json(foros);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/search', async (req, res) => {
    const q = `%${(req.query.q || '').trim()}%`;
    const { lat, lng } = req.query;
    try {
        let sql = `SELECT * FROM noticias`;
        let params = [];
        let where = ` WHERE (titulo LIKE ? OR resumen LIKE ?)`;
        params.push(q, q);

        if (lat && lng) {
            sql = `SELECT *, ((lat - ?) * (lat - ?) + (lng - ?) * (lng - ?)) as distance_sq FROM noticias`;
            params = [lat, lat, lng, lng, ...params];
            sql += where + ` ORDER BY distance_sq ASC LIMIT 50`;
        } else {
            sql += where + ` ORDER BY fecha_publicacion DESC LIMIT 50`;
        }

        const rows = await dbQuery.all(sql, params);
        res.json({ resultados: rows.map(formatearFront), relacionados: [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/noticias/:slug', async (req, res) => {
    try {
        const noticia = await dbQuery.get('SELECT * FROM noticias WHERE slug = ?', [req.params.slug]);
        if (!noticia) return res.status(404).json({ error: 'Noticia no encontrada' });
        
        await dbQuery.run('UPDATE noticias SET vistas = vistas + 1 WHERE id = ?', [noticia.id]);
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [noticia.id]);
        const comments = await dbQuery.all('SELECT c.*, u.nombre as usuario_nombre, u.foto_perfil FROM comentarios c JOIN usuarios u ON c.user_id = u.id WHERE noticia_id = ? ORDER BY fecha DESC', [noticia.id]);
        res.json({ noticia: formatearFront(noticia), valoracion: val, comentarios: comments, user: req.user || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/valorar', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userId = req.user ? req.user.id : null;
    
    try {
        // Verificar si ya votó (por IP o por Usuario)
        let existing = null;
        if (userId) {
            existing = await dbQuery.get('SELECT id FROM valoraciones WHERE noticia_id = ? AND user_id = ?', [req.body.noticia_id, userId]);
        } else {
            existing = await dbQuery.get('SELECT id FROM valoraciones WHERE noticia_id = ? AND ip_address = ? AND user_id IS NULL', [req.body.noticia_id, ip]);
        }

        if (existing) {
            return res.status(400).json({ error: 'Ya has emitido tu voto para esta noticia.' });
        }

        await dbQuery.run('INSERT INTO valoraciones (noticia_id, user_id, puntos, ip_address) VALUES (?, ?, ?, ?)', 
            [req.body.noticia_id, userId, req.body.puntos, ip]);
            
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [req.body.noticia_id]);
        res.json({ ok: true, promedio: val.promedio, total: val.total });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/comentar', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userId = req.user ? req.user.id : null;
    
    try {
        await dbQuery.run('INSERT INTO comentarios (noticia_id, user_id, comentario, ip_address) VALUES (?, ?, ?, ?)', 
            [req.body.noticia_id, userId, req.body.comentario, ip]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/comentarios', async (req, res) => {
    try {
        const rows = await dbQuery.all(`
            SELECT c.*, COALESCE(u.nombre, 'Ciudadano Anónimo') as usuario_nombre, 
            COALESCE(u.foto_perfil, '/img/avatar-anonimo.jpg') as foto_perfil 
            FROM comentarios c 
            LEFT JOIN usuarios u ON c.user_id = u.id 
            WHERE noticia_id = ? 
            ORDER BY fecha DESC
        `, [req.query.noticia_id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/user-status', (req, res) => {
    if (!req.user) return res.json({});
    const adminEmail = process.env.ADMIN_EMAIL || 'brayanrodrigolabastidasilva@gmail.com';
    const userData = { ...req.user, isAdmin: (req.user.rol === 'admin' || (adminEmail && req.user.email === adminEmail)) };
    res.json(userData);
});

// Favoritos
app.post('/api/v1/favoritos', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login necesario' });
    try {
        const { noticia_id } = req.body;
        const exists = await dbQuery.get('SELECT id FROM favoritos WHERE noticia_id = ? AND user_id = ?', [noticia_id, req.user.id]);
        if (exists) {
            await dbQuery.run('DELETE FROM favoritos WHERE noticia_id = ? AND user_id = ?', [noticia_id, req.user.id]);
            res.json({ saved: false });
        } else {
            await dbQuery.run('INSERT INTO favoritos (noticia_id, user_id) VALUES (?, ?)', [noticia_id, req.user.id]);
            res.json({ saved: true });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/favoritos', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login necesario' });
    try {
        const rows = await dbQuery.all(`
            SELECT n.* FROM noticias n 
            JOIN favoritos f ON n.id = f.noticia_id 
            WHERE f.user_id = ? 
            ORDER BY f.fecha DESC
        `, [req.user.id]);
        res.json(rows.map(formatearFront));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Middleware Admin (Actualizado v2.9.4)
const isAdmin = (req, res, next) => {
    const adminEmail = process.env.ADMIN_EMAIL || 'brayanrodrigolabastidasilva@gmail.com';
    if (req.isAuthenticated() && (req.user.rol === 'admin' || (adminEmail && req.user.email === adminEmail))) {
        return next();
    }
    res.status(403).json({ error: 'Acceso restringido a administradores.' });
};

// API Admin
app.get('/api/v1/admin/stats', isAdmin, async (req, res) => {
    try {
        const general = await dbQuery.get(`
            SELECT 
                (SELECT COUNT(*) FROM noticias) as totalNoticias,
                (SELECT COUNT(*) FROM usuarios) as totalUsuarios,
                (SELECT COUNT(*) FROM comentarios) as totalComentarios,
                (SELECT SUM(vistas) FROM noticias) as totalVistas
        `);
        const masRelevantes = await dbQuery.all(`
            SELECT id, titulo, vistas, fuente, fecha_publicacion,
            (SELECT COUNT(*) FROM comentarios WHERE noticia_id = noticias.id) as num_comentarios
            FROM noticias ORDER BY vistas DESC LIMIT 20
        `);
        res.json({ general, masRelevantes });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/auth/google', authConfigured, passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', authConfigured, passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/auth/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// SSR Noticia
app.get('/noticias/:slug', async (req, res) => {
    try {
        console.log(`📖 Sirviendo página dedicada para: ${req.params.slug}`);
        const noticia = await dbQuery.get('SELECT * FROM noticias WHERE slug = ?', [req.params.slug]);
        if (!noticia) return res.sendFile(path.join(__dirname, 'public/home.html'));
        
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [noticia.id]);
        const comments = await dbQuery.all(`
            SELECT c.*, COALESCE(u.nombre, 'Ciudadano Anónimo') as usuario_nombre, 
            COALESCE(u.foto_perfil, '/img/avatar-anonimo.jpg') as foto_perfil 
            FROM comentarios c 
            LEFT JOIN usuarios u ON c.user_id = u.id 
            WHERE noticia_id = ? 
            ORDER BY fecha DESC LIMIT 10
        `, [noticia.id]);
        
        const promedio = val.promedio ? parseFloat(val.promedio).toFixed(1) : '0';
        const pct = Math.round((parseFloat(promedio) / 5) * 100);
        let barColor = promedio >= 4 ? '#22C55E' : (promedio >= 3 ? '#FFCC00' : '#EF4444');

        const html = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>${noticia.titulo} | Noticias de Tlaxcala</title>
    
    <!-- SEO Dinámico -->
    <meta name="description" content="${noticia.resumen.substring(0, 160)}">
    <link rel="canonical" href="https://intlax.com/noticias/${noticia.slug}">
    <link rel="icon" type="image/png" href="/favicon.png">

    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="article">
    <meta property="og:url" content="https://intlax.com/noticias/${noticia.slug}">
    <meta property="og:title" content="${noticia.titulo}">
    <meta property="og:description" content="${noticia.resumen.substring(0, 200)}">
    <meta property="og:image" content="${noticia.imageUrl}">

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="https://intlax.com/noticias/${noticia.slug}">
    <meta property="twitter:title" content="${noticia.titulo}">
    <meta property="twitter:description" content="${noticia.resumen.substring(0, 200)}">
    <meta property="twitter:image" content="${noticia.imageUrl}">

    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&display=swap" rel="stylesheet">
    <link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
    <style>
        :root { --accent: #FFCC00; --bg: #121212; --card: #1C1C1E; --text: #FFFFFF; --text-sec: #A0A0A0; }
        * { margin: 0; padding: 0; box-box: border-box; }
        body { background: var(--bg); color: var(--text); font-family: 'Inter', sans-serif; line-height: 1.6; padding-bottom: 50px; touch-action: manipulation; -webkit-text-size-adjust: 100%; }
        .top-nav { height: 60px; display: flex; align-items: center; padding: 0 20px; background: rgba(18,18,18,0.9); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 100; border-bottom: 1px solid #333; }
        .back-btn { color: #fff; font-size: 28px; text-decoration: none; margin-right: 15px; display: flex; align-items: center; }
        .hero { width: 100%; height: 280px; object-fit: cover; }
        .container { padding: 20px; }
        .source-tag { color: var(--accent); font-weight: 800; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; display: block; }
        .article-title { font-size: 24px; font-weight: 800; line-height: 1.25; margin-bottom: 15px; }
        .article-summary { color: var(--text-sec); font-size: 16px; margin-bottom: 25px; }
        .main-btn { background: var(--accent); color: #000; font-weight: 800; text-align: center; padding: 15px; border-radius: 12px; text-decoration: none; display: block; margin-bottom: 30px; font-size: 16px; box-shadow: 0 4px 15px rgba(255,204,0,0.2); }
        .section-card { background: var(--card); border-radius: 16px; padding: 20px; margin-bottom: 20px; border: 1px solid #2c2c2e; }
        .section-title { font-size: 18px; font-weight: 800; margin-bottom: 15px; display: flex; align-items: center; gap: 8px; }
        .bar-outer { height: 12px; background: #333; border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
        .bar-inner { height: 100%; transition: width 0.8s ease-out; }
        .comment { background: #252527; padding: 12px; border-radius: 12px; margin-bottom: 12px; border-left: 3px solid var(--accent); }
        .comment-user { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; margin-bottom: 4px; }
        .comment-img { width: 22px; height: 22px; border-radius: 50%; }
        .comment-text { font-size: 14px; color: #ddd; }
        .input-area { width: 100%; background: #121212; border: 1px solid #444; border-radius: 10px; color: #fff; padding: 12px; font-family: inherit; margin-top: 10px; box-sizing: border-box; }
        .pub-btn { background: var(--accent); border: none; width: 100%; padding: 12px; border-radius: 10px; font-weight: 800; margin-top: 10px; cursor: pointer; }
    </style>
</head>
<body>
    <nav class="top-nav">
        <a href="/" class="back-btn"><i class='bx bx-chevron-left'></i></a>
        <span style="font-weight: 800; font-size: 18px;">Noticia</span>
    </nav>
    <img src="${noticia.imageUrl}" class="hero" onerror="this.src='/img/placeholder-noticia.jpg'">
    <div class="container">
        <span class="source-tag">${noticia.fuente}</span>
        <h1 class="article-title">${noticia.titulo}</h1>
        <p class="article-summary">${noticia.resumen}</p>
        <a href="${noticia.linkOriginal}" class="main-btn">VER NOTA COMPLETA</a>
        
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-bottom:30px;">
            <button onclick="shareThis()" class="main-btn" style="margin-bottom:0; background:#222; color:#fff; border:1px solid #444;">
                <i class='bx bx-share-alt'></i> Compartir
            </button>
            <a href="/" class="main-btn" style="margin-bottom:0; background:#222; color:#fff; border:1px solid #444; display:flex; align-items:center; justify-content:center; gap:8px;">
                <i class='bx bx-home-alt'></i> Inicio
            </a>
        </div>

        <div class="section-card">
            <h3 class="section-title"><i class='bx bxs-check-shield' style="color:var(--accent)"></i> Confiabilidad Ciudadana</h3>
            <p style="font-size:13px; color:var(--text-sec); margin-bottom:15px;">Pulsa una barra para calificar la nota:</p>
            <div class="battery-container">
                <div class="battery-bar" id="battery-rating" data-value="${Math.round(promedio)}">
                    <div class="battery-segment" onclick="votar(1)"></div>
                    <div class="battery-segment" onclick="votar(2)"></div>
                    <div class="battery-segment" onclick="votar(3)"></div>
                    <div class="battery-segment" onclick="votar(4)"></div>
                    <div class="battery-segment" onclick="votar(5)"></div>
                </div>
                <div class="battery-label">
                    <span>Poca Confianza</span>
                    <span>Alta Confianza</span>
                </div>
                <span class="battery-value-text" id="battery-status">${promedio} de 5 Estrellas (${val.total || 0} votos)</span>
            </div>
        </div>

        <div class="section-card">
            <h3 class="section-title"><i class='bx bxs-group' style="color:var(--accent)"></i> Comunidad</h3>
            <div id="comments-box">
                ${comments.length ? comments.map(c => `
                    <div class="comment">
                        <div class="comment-user">
                            <img src="${c.foto_perfil || '/img/avatar-anonimo.jpg'}" class="comment-img">
                            <span>${c.usuario_nombre || 'Ciudadano Anónimo'}</span>
                        </div>
                        <p class="comment-text">${c.comentario}</p>
                    </div>
                `).join('') : '<p style="color:#666; font-size:14px; text-align:center; padding:10px;">Aún no hay comentarios. ¡Sé el primero!</p>'}
            </div>
            <div style="margin-top:15px; border-top:1px solid #333; padding-top:15px;">
                <textarea id="nc" class="input-area" placeholder="Escribe tu opinión de forma anónima..." rows="3"></textarea>
                <button onclick="sc()" class="pub-btn">Publicar mi opinión</button>
                ${!req.isAuthenticated() ? `<p style="font-size:10px; color:#666; margin-top:8px; text-align:center;">Estás comentando como invitado. Inicia sesión para usar tu nombre y foto.</p>` : ''}
            </div>
        </div>
    </div>
    <script>
        async function sc(){
            const t=document.getElementById('nc').value; if(!t)return;
            const r=await fetch('/api/v1/comentar',{
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({noticia_id:'${noticia.id}',comentario:t})
            });
            if(r.ok) location.reload();
        }

        async function votar(p){
            const r = await fetch('/api/v1/valorar', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({noticia_id: '${noticia.id}', puntos: p})
            });
            if(r.ok){
                const data = await r.json();
                document.getElementById('battery-rating').setAttribute('data-value', Math.round(data.promedio));
                document.getElementById('battery-status').innerText = parseFloat(data.promedio).toFixed(1) + ' de 5 Estrellas (' + data.total + ' votos)';
                alert('¡Voto registrado!');
            } else {
                const err = await r.json();
                alert(err.error === 'Login necesario' ? 'Inicia sesión para votar' : err.error);
            }
        }

        function shareThis() {
            const title = '${noticia.titulo.replace(/'/g, "\\'")}';
            const url = window.location.origin + '/noticias/${noticia.slug}';
            if (navigator.share) {
                navigator.share({ title, url });
            } else {
                navigator.clipboard.writeText(url).then(() => alert('Enlace copiado al portapapeles'));
            }
        }
    </script>
</body>
</html>`;
        res.send(html);
    } catch (err) { res.sendFile(path.join(__dirname, 'public/home.html')); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/home.html')));

app.listen(PORT, () => {
    console.log(`🚀 Intlax ACTIVO en puerto ${PORT} - Iniciando con retardo de seguridad.`);
    setTimeout(fetchAllRssFeeds, 30000); // 30 segundos de gracia para el arranque
});
