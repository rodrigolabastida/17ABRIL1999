const express = require('express');
const cors = require('cors');
const path = require('path');
const Parser = require('rss-parser');
const cron = require('node-cron');
const cheerio = require('cheerio');
const mysql = require('mysql2/promise');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const fs = require('fs');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

// Configuración de variables de entorno con respaldo para Hostinger
const localEnv = path.join(__dirname, '.env');
const parentEnv = path.join(__dirname, '..', '.env');

if (fs.existsSync(localEnv)) {
    require('dotenv').config({ path: localEnv });
} else if (fs.existsSync(parentEnv)) {
    require('dotenv').config({ path: parentEnv });
    console.log('🛡️ Usando .env desde carpeta superior (Blindaje Hostinger activo)');
} else {
    require('dotenv').config();
}

process.on('uncaughtException', (err) => {
    console.error('❌ CRASH: Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ CRASH: Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(cors());
app.use(session({
    secret: process.env.SESSION_SECRET || 'intlax_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));
app.use(passport.initialize());
app.use(passport.session());

const authConfigured = (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        return res.status(503).send('Servicio de autenticación no configurado.');
    }
    next();
};

const parser = new Parser({
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8'
    },
    customFields: {
        item: [
            ['media:content', 'mediaContent'],
            ['media:thumbnail', 'mediaThumbnail'],
            ['enclosure', 'enclosure'],
            ['content:encoded', 'contentEncoded'],
            'description',
            'content'
        ]
    }
});

const PORT = process.env.PORT || 3000;

// Configuración de Pool de MariaDB con respaldo SQLite
let dbType = 'mariadb';
let sqliteDB = null;

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'intlax_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const dbQuery = {
    execute: async (sql, params = []) => {
        try {
            if (dbType === 'mariadb') {
                const [results] = await pool.execute(sql, params);
                return results;
            } else {
                return new Promise((resolve, reject) => {
                    // Convert ? to $1, $2 or just keep ? for sqlite3
                    sqliteDB.run(sql.replace(/ON DUPLICATE KEY UPDATE/g, 'ON CONFLICT(linkOriginal) DO UPDATE SET').replace(/VALUES\((\w+)\)/g, 'EXCLUDED.$1'), params, function(err) {
                        if (err) reject(err);
                        else resolve({ affectedRows: this.changes, insertId: this.lastID });
                    });
                });
            }
        } catch (err) {
            console.error(`❌ DB Error (${dbType}):`, err.message);
            throw err;
        }
    },
    get: async (sql, params = []) => {
        try {
            if (dbType === 'mariadb') {
                const [rows] = await pool.execute(sql, params);
                return rows[0] || null;
            } else {
                return new Promise((resolve, reject) => {
                    sqliteDB.get(sql, params, (err, row) => {
                        if (err) reject(err);
                        else resolve(row || null);
                    });
                });
            }
        } catch (err) {
            console.error(`❌ DB Error (${dbType}):`, err.message);
            throw err;
        }
    },
    all: async (sql, params = []) => {
        try {
            if (dbType === 'mariadb') {
                const [rows] = await pool.execute(sql, params);
                return rows;
            } else {
                return new Promise((resolve, reject) => {
                    sqliteDB.all(sql, params, (err, rows) => {
                        if (err) reject(err);
                        else resolve(rows);
                    });
                });
            }
        } catch (err) {
            console.error(`❌ DB Error (${dbType}):`, err.message);
            throw err;
        }
    }
};

// Integración NLP con Python
async function analyzeNewsNLP(title, summary) {
    return new Promise((resolve) => {
        const py = spawn('python3', [path.join(__dirname, 'nlp_processor.py')]);
        let dataString = '';
        
        py.stdout.on('data', (data) => dataString += data.toString());
        py.stdout.on('end', () => {
            try {
                resolve(JSON.parse(dataString));
            } catch (e) {
                resolve({ categoria: 'GENERAL', multiplicador: 1.0, municipio: 'Tlaxcala' });
            }
        });
        
        py.stdin.write(JSON.stringify({ title, summary }));
        py.stdin.end();
    });
}

// Inicialización de DB con Blindaje Contra Colapsos (MariaDB -> SQLite Fallback)
async function initDB() {
    console.log('⚙️ Sincronización MariaDB v6.2.8...');
    try {
        // Intento de conexión MariaDB
        await pool.execute('SELECT 1');
        
        const schema = [
            `CREATE TABLE IF NOT EXISTS noticias (
                id VARCHAR(50) PRIMARY KEY, 
                titulo TEXT, 
                resumen TEXT, 
                imageUrl TEXT, 
                linkOriginal VARCHAR(255) UNIQUE, 
                fuente VARCHAR(100), 
                fecha_publicacion DATETIME, 
                puntuacion INT, 
                vistas INT DEFAULT 0, 
                municipio VARCHAR(100), 
                lat DOUBLE, 
                lng DOUBLE, 
                fecha_captura DATETIME, 
                slug VARCHAR(255), 
                etiqueta_foro VARCHAR(100), 
                autor VARCHAR(100),
                categoria_impacto VARCHAR(50) DEFAULT 'GENERAL',
                municipio_tag VARCHAR(100) DEFAULT 'OTRO',
                multiplicador_categoria DECIMAL(3,2) DEFAULT 1.0,
                votos_positivos_count INT DEFAULT 0
            )`,
            `CREATE TABLE IF NOT EXISTS usuarios (
                id INT AUTO_INCREMENT PRIMARY KEY, 
                google_id VARCHAR(255) UNIQUE, 
                nombre VARCHAR(255), 
                email VARCHAR(255), 
                foto_perfil TEXT, 
                puntos_reputacion INT DEFAULT 0, 
                fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP, 
                rol VARCHAR(50) DEFAULT 'user'
            )`,
            `CREATE TABLE IF NOT EXISTS comentarios (
                id INT AUTO_INCREMENT PRIMARY KEY, 
                noticia_id VARCHAR(50), 
                user_id INT NULL, 
                comentario TEXT, 
                ip_address VARCHAR(50), 
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS valoraciones (
                id INT AUTO_INCREMENT PRIMARY KEY, 
                noticia_id VARCHAR(50), 
                user_id INT NULL, 
                puntos INT, 
                ip_address VARCHAR(50)
            )`,
            `CREATE TABLE IF NOT EXISTS registro_vistas (
                id INT AUTO_INCREMENT PRIMARY KEY, 
                noticia_id VARCHAR(50), 
                ip_address VARCHAR(50), 
                referer TEXT, 
                user_agent TEXT, 
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
            `CREATE TABLE IF NOT EXISTS registro_favoritos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                noticia_id VARCHAR(50),
                user_id INT,
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(noticia_id, user_id)
            )`,
            `CREATE TABLE IF NOT EXISTS historial_extraccion (
                id INT AUTO_INCREMENT PRIMARY KEY, 
                nuevas INT, 
                actualizadas INT, 
                errores TEXT, 
                duracion_ms INT, 
                fecha DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        ];
        for (const sql of schema) { await pool.execute(sql); }
        console.log('✅ Tablas MariaDB sincronizadas v6.2.4.');
    } catch (dbErr) {
        console.error('⚠️ ALERTA: MariaDB no disponible. Activando Respaldo SQLite.');
        dbType = 'sqlite';
        sqliteDB = new sqlite3.Database(path.join(__dirname, 'intlax.db'), (err) => {
            if (err) console.error('❌ Error fatal: Tampoco se pudo cargar SQLite:', err.message);
            else console.log('✅ Base de datos SQLite <span style="font-size:9px; color:#555; font-weight:700; letter-spacing:0.5px; opacity:0.6;">v6.2.4</span> y conectada.');
        });
        
        // Sincronización básica de esquema SQLite (por si acaso)
        const sqliteSchema = `
            CREATE TABLE IF NOT EXISTS noticias (
                id TEXT PRIMARY KEY, titulo TEXT, resumen TEXT, imageUrl TEXT, 
                linkOriginal TEXT UNIQUE, fuente TEXT, fecha_publicacion TEXT, 
                puntuacion INTEGER, vistas INTEGER DEFAULT 0, municipio TEXT, 
                lat REAL, lng REAL, fecha_captura TEXT, slug TEXT, 
                etiqueta_foro TEXT, autor TEXT, categoria_impacto TEXT DEFAULT 'GENERAL', 
                municipio_tag TEXT DEFAULT 'OTRO', multiplicador_categoria REAL DEFAULT 1.0, 
                votos_positivos_count INTEGER DEFAULT 0
            );
        `;
        sqliteDB.exec(sqliteSchema);
    }
}

// Passport MariaDB
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL || "/auth/google/callback"
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            let user = await dbQuery.get('SELECT * FROM usuarios WHERE google_id = ?', [profile.id]);
            if (!user) {
                const [result] = await pool.execute('INSERT INTO usuarios (google_id, nombre, email, foto_perfil) VALUES (?, ?, ?, ?)', 
                    [profile.id, profile.displayName, profile.emails[0].value, profile.photos[0].value]);
                user = await dbQuery.get('SELECT * FROM usuarios WHERE id = ?', [result.insertId]);
            }
            return done(null, user);
        } catch (err) { return done(err); }
    }));
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await dbQuery.get('SELECT * FROM usuarios WHERE id = ?', [id]);
        done(null, user);
    } catch (err) { done(err); }
});

function generarSlug(texto) {
    if (!texto) return Math.random().toString(36).substr(2, 9);
    return texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 90);
}

const FEED_URLS = [
    { url: 'https://news.google.com/rss/search?q=Tlaxcala&hl=es-419&gl=MX&ceid=MX:es-419', source: 'Google News' },
    { url: 'https://www.elsoldetlaxcala.com.mx/rss.xml', source: 'El Sol de Tlaxcala' },
    { url: 'https://tlaxcala.quadratin.com.mx/feed/', source: 'Quadratín Tlaxcala' },
    { url: 'https://sintesis.com.mx/tlaxcala/feed/', source: 'Síntesis Tlaxcala' },
    { url: 'https://e-tlaxcala.mx/feed/', source: 'e-Tlaxcala' },
    { url: 'https://www.gentetlx.com.mx/feed/', source: 'Gentetlx' },
    { url: 'https://www.385grados.com/feed/', source: '385 Grados' },
    { url: 'https://faronoticias.com.mx/feed/', source: 'Faro Noticias' }
];

async function fetchAllRssFeeds(force = false) {
    const startTime = Date.now();
    let nuevas = 0, actualizadas = 0;
    let erroresArr = [];

    console.log('🔄 Iniciando sincronización de feeds robusta v6.2.8...');

    for (const feedData of FEED_URLS) {
        try {
            const feed = await parser.parseURL(feedData.url);
            for (const item of feed.items.slice(0, 15)) {
                const title = item.title;
                const summaryText = (item.description || item.content || item.contentSnippet || '').replace(/<[^>]+>/g, '').trim();
                
                // Semantización NLP
                const nlp = await analyzeNewsNLP(title, summaryText);
                
                // Extracción de Imagen Robusta (Image Hunter v3 - Cheerio Edition)
                let imageUrl = '/img/placeholder-noticia.jpg';
                
                if (item.enclosure && item.enclosure.url) {
                    imageUrl = item.enclosure.url;
                } else if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
                    imageUrl = item.mediaContent.$.url;
                } else if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
                    imageUrl = item.mediaThumbnail.$.url;
                } else {
                    // Buscar en campos HTML (contentEncoded, description, content)
                    const htmlContent = (item.contentEncoded || '') + (item.description || '') + (item.content || '');
                    if (htmlContent.includes('<img')) {
                        const $ = cheerio.load(htmlContent);
                        const foundImg = $('img').attr('src');
                        if (foundImg && foundImg.startsWith('http')) {
                            imageUrl = foundImg;
                        }
                    }
                }

                // Limpieza específica para Google News si sigue fallando
                if (feedData.source === 'Google News' && imageUrl.includes('placeholder')) {
                     const match = (item.content || '').match(/src="([^">]+)"/);
                     if (match) imageUrl = match[1];
                }

                const slug = generarSlug(title);
                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                
                try {
                    const res = await dbQuery.execute(`
                        INSERT INTO noticias (id, titulo, resumen, imageUrl, linkOriginal, fuente, fecha_publicacion, puntuacion, fecha_captura, slug, categoria_impacto, municipio_tag, multiplicador_categoria)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                            imageUrl = VALUES(imageUrl),
                            puntuacion = VALUES(puntuacion),
                            categoria_impacto = VALUES(categoria_impacto),
                            multiplicador_categoria = VALUES(multiplicador_categoria)
                    `, [Math.random().toString(36).substr(2, 9), title, summaryText, imageUrl, item.link, feedData.source, 
                       item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 19).replace('T', ' ') : now, 
                       50, now, slug, nlp.categoria, nlp.municipio, nlp.multiplicador]);
                    
                    if (res.affectedRows === 1) nuevas++;
                    else actualizadas++;
                } catch (e) { console.error('Item error:', e.message); }
            }
        } catch (err) { erroresArr.push(feedData.source); }
    }
    const duration = Date.now() - startTime;
    await dbQuery.execute('INSERT INTO historial_extraccion (nuevas, actualizadas, errores, duracion_ms) VALUES (?, ?, ?, ?)', [nuevas, actualizadas, erroresArr.join(', '), duration]);
    console.log(`✅ Sincronización completada: ${nuevas} nuevas, ${actualizadas} actualizadas.`);
}

cron.schedule('*/30 * * * *', () => fetchAllRssFeeds(true));

function formatearFront(row) {
    if (!row) return null;
    return {
        ...row,
        id: row.id,
        title: row.titulo,
        summary: row.resumen,
        source: row.fuente,
        views: row.vistas || 0,
        imageUrl: (row.imageUrl && row.imageUrl !== '' && row.imageUrl !== 'null') ? row.imageUrl : '/img/placeholder-noticia.jpg',
        link: row.linkOriginal,
        slug: row.slug,
        puntuacion: row.puntuacion || 3,
        time: row.fecha_publicacion ? new Date(row.fecha_publicacion).toLocaleDateString() : 'Hoy',
        image: (row.imageUrl && row.imageUrl !== '' && row.imageUrl !== 'null') ? row.imageUrl : '/img/placeholder-noticia.jpg'
    };
}

// ALGORITMO SEMÁNTICO-CUANTITATIVO (Híbrido)
app.get('/api/v1/feed', async (req, res) => {
    try {
        const userMunicipio = req.query.municipio || 'OTRO';
        let query = '';
        
        if (dbType === 'mariadb') {
            query = `
                SELECT *, 
                (
                    (vistas + 
                    (5 * LEAST((SELECT COUNT(*) FROM comentarios WHERE noticia_id = noticias.id), 20)) + 
                    (10 * votos_positivos_count)) *
                    multiplicador_categoria *
                    IF(municipio_tag = ?, 2.0, IF(municipio_tag != 'OTRO', 1.2, 0.5))
                ) / 
                POW((TIMESTAMPDIFF(HOUR, fecha_captura, NOW()) + 2), 1.8) as ranking_final
                FROM noticias 
                ORDER BY ranking_final DESC 
                LIMIT 100
            `;
        } else {
            query = `SELECT *, 1.0 as ranking_final FROM noticias ORDER BY fecha_captura DESC LIMIT 100`;
        }
        
        const rows = await dbQuery.all(query, [userMunicipio]);
        const formatted = rows.map(formatearFront);
        
        res.json({ 
            noticiaPrincipal: formatted[0] || null, 
            noticiasSecundarias: formatted.slice(1)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/noticias/:slug', async (req, res) => {
    try {
        const noticia = await dbQuery.get('SELECT * FROM noticias WHERE slug = ?', [req.params.slug]);
        if (!noticia) return res.status(404).json({ error: 'Noticia no encontrada' });
        
        await dbQuery.execute('UPDATE noticias SET vistas = vistas + 1 WHERE id = ?', [noticia.id]);
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await dbQuery.execute('INSERT INTO registro_vistas (noticia_id, ip_address, referer, user_agent) VALUES (?, ?, ?, ?)', [noticia.id, ip, req.headers.referer || '', req.headers['user-agent'] || '']);
        
        const val = await dbQuery.get('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?', [noticia.id]);
        const comments = await dbQuery.all('SELECT c.*, u.nombre as usuario_nombre, u.foto_perfil FROM comentarios c LEFT JOIN usuarios u ON c.user_id = u.id WHERE noticia_id = ? ORDER BY fecha DESC', [noticia.id]);
        res.json({ noticia: formatearFront(noticia), valoracion: val, comentarios: comments, user: req.user || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/valorar', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const { noticia_id, puntos } = req.body;
    try {
        await dbQuery.execute('INSERT INTO valoraciones (noticia_id, user_id, puntos, ip_address) VALUES (?, ?, ?, ?)', [noticia_id, req.user ? req.user.id : null, puntos, ip]);
        if (puntos >= 4) {
            await dbQuery.execute('UPDATE noticias SET votos_positivos_count = votos_positivos_count + 1 WHERE id = ?', [noticia_id]);
        }
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/user-status', (req, res) => {
    if (!req.user) return res.json({});
    const adminEmail = process.env.ADMIN_EMAIL || 'brayanrodrigolabastidasilva@gmail.com';
    res.json({ ...req.user, isAdmin: (req.user.rol === 'admin' || req.user.email === adminEmail) });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/home.html')));

app.listen(PORT, async () => {
    console.log(`🚀 Intlax MariaDB v6.0 ACTIVO en puerto ${PORT}`);
    await initDB();
    setTimeout(fetchAllRssFeeds, 5000);
});
