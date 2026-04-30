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
const municipalities = JSON.parse(fs.readFileSync(path.join(__dirname, 'municipalities_data.json'), 'utf8')).sort((a, b) => b.pop - a.pop);
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
        
        // Limpieza profunda: Eliminar noticias residuales de Google News (sin imágenes reales)
        await pool.execute("DELETE FROM noticias WHERE fuente = 'Google News' OR imageUrl LIKE '%googleusercontent.com%' OR imageUrl LIKE '%placeholder%'");
        console.log('✅ Purga de Google News / Placeholders completada.');
        
        console.log('✅ Tablas MariaDB sincronizadas v6.3.9.');
    } catch (dbErr) {
        console.error('⚠️ ALERTA: MariaDB no disponible. Activando Respaldo SQLite.');
        dbType = 'sqlite';
        sqliteDB = new sqlite3.Database(path.join(__dirname, 'intlax.db'), (err) => {
            if (err) console.error('❌ Error fatal: Tampoco se pudo cargar SQLite:', err.message);
            else console.log('✅ Base de datos SQLite v6.3.0 y conectada.');
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
                const result = await dbQuery.execute('INSERT INTO usuarios (google_id, nombre, email, foto_perfil) VALUES (?, ?, ?, ?)', 
                    [profile.id, profile.displayName, (profile.emails && profile.emails[0].value) || '', (profile.photos && profile.photos[0].value) || '']);
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
    { url: 'https://www.elsoldetlaxcala.com.mx/rss.xml', source: 'El Sol de Tlaxcala' },
    { url: 'https://tlaxcala.quadratin.com.mx/feed/', source: 'Quadratín Tlaxcala' },
    { url: 'https://sintesis.com.mx/tlaxcala/feed/', source: 'Síntesis Tlaxcala' },
    { url: 'https://e-tlaxcala.mx/feed/', source: 'e-Tlaxcala' },
    { url: 'https://www.gentetlx.com.mx/feed/', source: 'Gentetlx' },
    { url: 'https://www.385grados.com/feed/', source: '385 Grados' },
    { url: 'https://faronoticias.com.mx/feed/', source: 'Faro Noticias' },
    { url: 'https://abctlax.com/feed/', source: 'ABC Tlaxcala' },
    { url: 'https://monitorxpress.com/feed/', source: 'Monitor Tlaxcala' },
    { url: 'https://agendatlaxcala.com/feed/', source: 'Agenda Tlaxcala' },
    { url: 'https://revistamomento.com.mx/feed/', source: 'Revista Momento' },
    { url: 'https://valkiria.com.mx/feed/', source: 'Valkiria' },
    { url: 'https://pinceldeluzprensa.com/feed/', source: 'Pincel de Luz' },
    { url: 'https://sndigital.mx/feed/', source: 'SN Digital' },
    { url: 'https://laprensadetlaxcala.com/feed/', source: 'La Prensa de Tlaxcala' },
    { url: 'https://lapolilla.com.mx/feed/', source: 'La Polilla' },
    // Medios Nacionales
    { url: 'https://www.eluniversal.com.mx/rss.xml', source: 'El Universal' },
    { url: 'https://www.milenio.com/rss', source: 'Milenio' },
    { url: 'https://www.excelsior.com.mx/rss.xml', source: 'Excélsior' },
    { url: 'https://www.jornada.com.mx/rss/portada.xml', source: 'La Jornada' },
    { url: 'https://www.elsoldemexico.com.mx/rss.xml', source: 'El Sol de México' },
    { url: 'https://www.eleconomista.com.mx/rss/last_news', source: 'El Economista' },
    { url: 'https://www.forbes.com.mx/feed/', source: 'Forbes México' },
    { url: 'https://www.animalpolitico.com/feed/', source: 'Animal Político' },
    { url: 'https://aristeguinoticias.com/feed/', source: 'Aristegui Noticias' }
];

async function extractImageFromUrl(url) {
    if (!url || !url.startsWith('http')) return null;
    try {
        const response = await fetch(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'es-MX,es;q=1'
            },
            signal: AbortSignal.timeout(10000) 
        });
        
        if (!response.ok) return null;
        const html = await response.text();
        const $ = cheerio.load(html);
        
        // Prioridad 1: Meta Tags de Alta Calidad
        let img = $('meta[property="og:image:secure_url"]').attr('content') ||
                  $('meta[property="og:image"]').attr('content') || 
                  $('meta[name="twitter:image"]').attr('content') ||
                  $('meta[name="twitter:image:src"]').attr('content') ||
                  $('link[rel="image_src"]').attr('href');
        
        // Prioridad 2: WordPress Featured Image y Sliders
        if (!img) img = $('.wp-post-image').attr('src') || 
                        $('.attachment-post-thumbnail').attr('src') ||
                        $('.entry-thumb img').attr('src') ||
                        $('.post-thumbnail img').attr('src') ||
                        $('.td-post-featured-image img').attr('src');

        // Prioridad 3: Selectores universales de imagen principal
        if (!img) {
            // Buscamos la primera imagen en el artículo que no sea un icono
            $('article img, main img, .content img, .post-content img, .td-post-content img').each((i, el) => {
                const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
                if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('avatar') && !src.includes('pixel') && !src.includes('icon')) {
                    img = src;
                    return false; 
                }
            });
        }
        
        if (img && img.startsWith('//')) img = 'https:' + img;
        return img;
    } catch (e) {
        return null;
    }
}

// --- RUTA EXCLUSIVA PARA HERMES (Social Media AI) ---
app.get('/api/v1/hermes/queue', async (req, res) => {
    const apiKey = req.headers['x-hermes-key'];
    const validKey = process.env.HERMES_API_KEY || 'hermes_secret_2024_intlax';

    if (apiKey !== validKey) {
        return res.status(401).json({ error: 'No autorizado para Hermes' });
    }

    try {
        // Obtenemos las últimas 15 noticias que tengan imagen real y no sean repetidas
        const rows = await dbQuery.all(`
            SELECT id, titulo, resumen, imageUrl, linkOriginal, fuente, municipio_tag, fecha_captura 
            FROM noticias 
            WHERE imageUrl NOT LIKE '%placeholder%' 
            ORDER BY fecha_captura DESC 
            LIMIT 15
        `);
        
        res.json({
            status: 'success',
            count: rows.length,
            data: rows.map(r => ({
                id: r.id,
                title: r.titulo,
                summary: r.resumen || 'Sin resumen disponible',
                image: r.imageUrl,
                url: r.linkOriginal,
                source: r.fuente,
                municipality: r.municipio_tag,
                timestamp: r.fecha_captura
            }))
        });
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener cola para Hermes' });
    }
});

// Configuración de Búsqueda Activa (Deep Crawl)
const CRAWL_KEYWORDS = ['Calpulalpan', 'Tlaxcala', 'Apizaco', 'Huamantla'];
const CRAWL_SOURCES = [
    { name: 'Gentetlx', searchUrl: 'https://www.gentetlx.com.mx/?s={query}' },
    { name: '385 Grados', searchUrl: 'https://www.385grados.com/?s={query}' },
    { name: 'Quadratín Tlaxcala', searchUrl: 'https://tlaxcala.quadratin.com.mx/?s={query}' },
    { name: 'e-Tlaxcala', searchUrl: 'https://e-tlaxcala.mx/?s={query}' }
];

async function deepCrawlKeywords() {
    console.log('🕵️ Iniciando Deep Keyword Crawl...');
    let totalNuevas = 0;

    for (const keyword of CRAWL_KEYWORDS) {
        for (const source of CRAWL_SOURCES) {
            try {
                const searchUrl = source.searchUrl.replace('{query}', encodeURIComponent(keyword));
                const res = await fetch(searchUrl, { 
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
                    signal: AbortSignal.timeout(15000)
                });
                if (!res.ok) continue;
                
                const html = await res.text();
                const $ = cheerio.load(html);
                const items = [];

                // Selectores universales para WordPress y medios locales
                $('h1, h2, h3').each((i, el) => {
                    if (items.length >= 10) return false;
                    const title = $(el).text().trim();
                    const link = $(el).find('a').attr('href') || $(el).closest('a').attr('href');
                    
                    if (title && link && link.startsWith('http') && title.length > 15) {
                        // Solo si el título contiene la palabra clave para evitar "ruido" de barras laterales
                        if (title.toLowerCase().includes(keyword.toLowerCase())) {
                            items.push({ title, link });
                        }
                    }
                });

                for (const item of items) {
                    try {
                        // UPSERT Lógica: Si ya existe por título o link, verificamos si podemos mejorar la imagen
                        const existing = await dbQuery.get('SELECT id, imageUrl FROM noticias WHERE titulo = ? OR linkOriginal = ?', [item.title, item.link]);
                        
                        const imageUrl = await extractImageFromUrl(item.link) || '/img/placeholder-noticia.jpg';

                        if (existing) {
                            // Si el existente tiene placeholder y el nuevo tiene imagen real, actualizamos
                            if (existing.imageUrl.includes('placeholder') && !imageUrl.includes('placeholder')) {
                                await dbQuery.execute('UPDATE noticias SET imageUrl = ?, linkOriginal = ?, fuente = ? WHERE id = ?', 
                                    [imageUrl, item.link, source.name, existing.id]);
                            }
                            continue;
                        }

                        const nlp = await analyzeNewsNLP(item.title, "");
                        const slug = generarSlug(item.title);
                        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

                        await dbQuery.execute(`
                            INSERT INTO noticias (id, titulo, resumen, linkOriginal, imageUrl, fuente, categoria_impacto, municipio_tag, multiplicador_categoria, slug, fecha_publicacion, fecha_captura, puntuacion)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `, [Math.random().toString(36).substr(2, 9), item.title, "", item.link, imageUrl, source.name, nlp.categoria, nlp.municipio, nlp.multiplicador, slug, now, now, 50]);
                        
                        totalNuevas++;
                    } catch (err) { /* Silencioso por item */ }
                }
            } catch (e) {
                console.error(`❌ Error en Deep Crawl [${source.name}] para [${keyword}]:`, e.message);
            }
        }
    }
    console.log(`✅ Deep Crawl finalizado. ${totalNuevas} noticias nuevas encontradas.`);
}

// Ejecutar cada 2 horas
cron.schedule('0 */2 * * *', deepCrawlKeywords);

async function fetchAllRssFeeds(force = false) {
    const startTime = Date.now();
    let nuevas = 0, actualizadas = 0;
    let erroresArr = [];

    console.log('🔄 Iniciando sincronización de feeds robusta v6.2.9 (Deep Image Hunter v5)...');

    for (const feedData of FEED_URLS) {
        try {
            const feed = await parser.parseURL(feedData.url);
            for (const item of feed.items.slice(0, 15)) {
                const title = item.title;
                const summaryText = (item.description || item.content || item.contentSnippet || '').replace(/<[^>]+>/g, '').trim();
                
                // Semantización NLP
                const nlp = await analyzeNewsNLP(title, summaryText);
                
                // Extracción de Imagen Robusta
                let imageUrl = '/img/placeholder-noticia.jpg';
                
                if (item.enclosure && item.enclosure.url) {
                    imageUrl = item.enclosure.url;
                } else if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
                    imageUrl = item.mediaContent.$.url;
                } else if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
                    imageUrl = item.mediaThumbnail.$.url;
                } else {
                    const htmlContent = (item.contentEncoded || '') + (item.description || '') + (item.content || '');
                    if (htmlContent.includes('<img')) {
                        const $ = cheerio.load(htmlContent);
                        const foundImg = $('img').attr('src');
                        if (foundImg && foundImg.startsWith('http')) imageUrl = foundImg;
                    }
                }

                // DEEP SCAN: Si seguimos sin imagen o es un logo genérico, vamos a la fuente original
                if (imageUrl.includes('placeholder') || imageUrl.includes('googleusercontent.com')) {
                    let targetUrl = item.link;
                    if (feedData.source === 'Google News' && targetUrl.includes('articles/')) {
                        try {
                            const parts = targetUrl.split('articles/');
                            const b64 = parts[parts.length - 1].split('?')[0];
                            const decoded = Buffer.from(b64, 'base64').toString('binary');
                            const urlMatch = decoded.match(/https?:\/\/[^\s\x00-\x1f!@#$%^&*()_+={}\[\]:;|<>,?]+/);
                            if (urlMatch) targetUrl = urlMatch[0];
                        } catch (e) {}
                    }
                    
                    const deepImg = await extractImageFromUrl(targetUrl);
                    if (deepImg && !deepImg.includes('logo') && !deepImg.includes('favicon')) {
                        imageUrl = deepImg;
                    }
                }

                // Identificación de la Fuente Real (Especial para Google News)
                let source = feedData.source;
                if (feedData.source === 'Google News') {
                    const htmlContent = (item.content || '');
                    const fontMatch = htmlContent.match(/<font[^>]*>(.*?)<\/font>/);
                    if (fontMatch) {
                        source = fontMatch[1].replace(/<[^>]+>/g, '').trim();
                    } else if (item.source) {
                        source = (typeof item.source === 'object') ? (item.source._ || item.source.name || source) : item.source;
                    } else if (title.includes(' - ')) {
                        const parts = title.split(' - ');
                        source = parts[parts.length - 1].trim();
                    }
                }

                const slug = generarSlug(title);
                const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
                
                try {
                    const res = await dbQuery.execute(`
                        INSERT INTO noticias (id, titulo, resumen, imageUrl, linkOriginal, fuente, fecha_publicacion, puntuacion, fecha_captura, slug, categoria_impacto, municipio_tag, multiplicador_categoria)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                            imageUrl = VALUES(imageUrl),
                            fuente = VALUES(fuente),
                            puntuacion = VALUES(puntuacion),
                            categoria_impacto = VALUES(categoria_impacto),
                            multiplicador_categoria = VALUES(multiplicador_categoria)
                    `, [Math.random().toString(36).substr(2, 9), title, summaryText, imageUrl, item.link, source, 
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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
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
                ORDER BY (imageUrl NOT LIKE '%placeholder%') DESC, ranking_final DESC 
                LIMIT 100
            `;
        } else {
            query = `SELECT *, (imageUrl NOT LIKE '%placeholder%') as has_img FROM noticias ORDER BY has_img DESC, fecha_captura DESC LIMIT 100`;
        }
        
        const rows = await dbQuery.all(query, [userMunicipio]);
        const formatted = rows.map(formatearFront);
        
        res.json({ 
            noticiaPrincipal: formatted[0] || null, 
            noticiasSecundarias: formatted.slice(1)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/municipio/:name', async (req, res) => {
    try {
        const name = req.params.name;
        // Búsqueda insensible a mayúsculas/minúsculas usando LOWER
        const rows = await dbQuery.all('SELECT * FROM noticias WHERE LOWER(municipio_tag) = LOWER(?) ORDER BY fecha_captura DESC', [name]);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// --- RESTORED ENDPOINTS ---
app.post('/api/v1/comentar', async (req, res) => {
    const { noticia_id, comentario } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    try {
        await dbQuery.execute('INSERT INTO comentarios (noticia_id, user_id, comentario, ip_address) VALUES (?, ?, ?, ?)', 
            [noticia_id, req.user ? req.user.id : null, comentario, ip]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/comentarios', async (req, res) => {
    try {
        const { noticia_id } = req.query;
        const rows = await dbQuery.all(`
            SELECT c.*, COALESCE(u.nombre, 'Ciudadano Anónimo') as usuario_nombre, 
            COALESCE(u.foto_perfil, '/img/avatar-anonimo.jpg') as foto_perfil 
            FROM comentarios c 
            LEFT JOIN usuarios u ON c.user_id = u.id 
            WHERE noticia_id = ? 
            ORDER BY c.fecha DESC
        `, [noticia_id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/v1/favoritos', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Login necesario' });
    const { noticia_id } = req.body;
    try {
        const existing = await dbQuery.get('SELECT * FROM registro_favoritos WHERE noticia_id = ? AND user_id = ?', [noticia_id, req.user.id]);
        if (existing) {
            await dbQuery.execute('DELETE FROM registro_favoritos WHERE noticia_id = ? AND user_id = ?', [noticia_id, req.user.id]);
            res.json({ saved: false });
        } else {
            await dbQuery.execute('INSERT INTO registro_favoritos (noticia_id, user_id) VALUES (?, ?)', [noticia_id, req.user.id]);
            res.json({ saved: true });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/favoritos', async (req, res) => {
    if (!req.user) return res.json([]);
    try {
        const rows = await dbQuery.all(`
            SELECT n.* FROM noticias n
            JOIN registro_favoritos f ON n.id = f.noticia_id
            WHERE f.user_id = ?
            ORDER BY f.fecha DESC
        `, [req.user.id]);
        res.json(rows.map(formatearFront));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/foro', async (req, res) => {
    try {
        const categoria = req.query.categoria;
        let filter = "WHERE n.etiqueta_foro IS NOT NULL";
        const params = [];

        if (categoria && categoria !== 'Todo') {
            filter += " AND n.etiqueta_foro = ?";
            params.push(categoria);
        }

        const rows = await dbQuery.all(`
            SELECT n.*, 
            (
                (COUNT(DISTINCT c.id) * 50 + COUNT(DISTINCT v.id) * 30) 
            ) as interaction_score
            FROM noticias n
            LEFT JOIN comentarios c ON n.id = c.noticia_id
            LEFT JOIN valoraciones v ON n.id = v.noticia_id
            ${filter}
            GROUP BY n.id
            ORDER BY interaction_score DESC, n.fecha_publicacion DESC
            LIMIT 40
        `, params);

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
            
            const val = await dbQuery.get('SELECT AVG(puntos) as promedio FROM valoraciones WHERE noticia_id = ?', [row.id]);
            noticia.promedio_valoracion = val.promedio || 3;
            noticia.comentarios_destacados = comments;
            return noticia;
        }));

        res.json(foros);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/v1/debug', async (req, res) => {
    try {
        const rowCount = await dbQuery.get('SELECT COUNT(*) as total FROM noticias');
        const realImageCount = await dbQuery.get("SELECT COUNT(*) as total FROM noticias WHERE imageUrl NOT LIKE '%placeholder%'");
        const last10News = await dbQuery.all('SELECT titulo, fuente, imageUrl, municipio_tag, fecha_captura FROM noticias ORDER BY fecha_captura DESC LIMIT 10');
        res.json({
            dbType,
            rowCount: rowCount.total,
            realImageCount: realImageCount.total,
            last10News,
            env: {
                DB_HOST: process.env.DB_HOST,
                NODE_ENV: process.env.NODE_ENV
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/v1/user-status', (req, res) => {
    if (!req.user) return res.json({});
    const adminEmail = process.env.ADMIN_EMAIL || 'brayanrodrigolabastidasilva@gmail.com';
    res.json({ ...req.user, isAdmin: (req.user.rol === 'admin' || req.user.email === adminEmail) });
});

// Auth Routes
app.get('/auth/google', authConfigured, passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', authConfigured, passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
    res.redirect('/');
});
app.get('/auth/logout', (req, res) => {
    req.logout((err) => {
        res.redirect('/');
    });
});

app.get('/api/v1/municipalities', (req, res) => {
    res.json(municipalities);
});

app.get('/api/v1/municipio/:nombre', async (req, res) => {
    try {
        const nombre = req.params.nombre;
        // Buscamos noticias que tengan el tag del municipio o que lo mencionen en el título/resumen
        const query = `
            SELECT * FROM noticias 
            WHERE municipio_tag = ? OR titulo LIKE ? OR resumen LIKE ?
            ORDER BY fecha_captura DESC LIMIT 50
        `;
        const searchTerm = `%${nombre}%`;
        const rows = await dbQuery.all(query, [nombre, searchTerm, searchTerm]);
        res.json(rows.map(formatearFront));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/municipio/:nombre', async (req, res) => {
    const nombre = req.params.nombre;
    const municipio = municipalities.find(m => m.name.toLowerCase() === nombre.toLowerCase());
    
    // Si no existe el municipio, redirigir a home
    if (!municipio) return res.redirect('/');

    // Renderizado básico para SEO
    const htmlPath = path.join(__dirname, 'public/home.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // Inyectar Meta Tags para SEO
    const seoTitle = `Noticias de ${municipio.name} | Intlax`;
    const seoDesc = `Descubre las noticias más recientes y relevantes de ${municipio.name}, Tlaxcala. Información actualizada al momento en Intlax.`;
    
    html = html.replace('<title>Noticias de Tlaxcala | Intlax</title>', `<title>${seoTitle}</title>`);
    html = html.replace('</head>', `
        <meta name="description" content="${seoDesc}">
        <meta property="og:title" content="${seoTitle}">
        <meta property="og:description" content="${seoDesc}">
        <meta name="keywords" content="noticias, ${municipio.name}, tlaxcala, actualidad, eventos, reportes">
    </head>`);

    res.send(html);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/home.html')));

app.listen(PORT, async () => {
    console.log(`🚀 Intlax MariaDB v6.3.4 ACTIVO en puerto ${PORT}`);
    await initDB();
    setTimeout(fetchAllRssFeeds, 5000);
    setTimeout(deepCrawlKeywords, 15000); // 10 segundos después del RSS general
});
