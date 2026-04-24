const express = require('express');
const cors = require('cors');
const path = require('path');
const Parser = require('rss-parser');
const cron = require('node-cron');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
const parser = new Parser({
    customFields: {
        item: ['description', 'content:encoded', 'media:content', 'enclosure']
    }
});

const PORT = process.env.PORT || 3000;

// Inicialización de SQLite
const db = new Database('intlax.db');

db.exec(`
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
        usuario TEXT,
        comentario TEXT,
        fecha DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY (noticia_id) REFERENCES noticias(id)
    );
    CREATE TABLE IF NOT EXISTS valoraciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        noticia_id TEXT,
        puntos INTEGER CHECK(puntos BETWEEN 1 AND 5),
        FOREIGN KEY (noticia_id) REFERENCES noticias(id)
    );
`);

// Añadir columna slug si no existe (migración segura)
try { db.exec("ALTER TABLE noticias ADD COLUMN slug TEXT"); } catch(e) { /* ya existe */ }

// Función generadora de Slug SEO
function generarSlug(titulo) {
    if (!titulo) return Math.random().toString(36).substr(2, 9);
    return titulo
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 80)
        + '-' + Math.random().toString(36).substr(2, 5);
}

// Consulta preparada para Actualización Incremental (Upsert) con slug
const insertOrUpdateArticle = db.prepare(`
    INSERT INTO noticias (
        id, titulo, resumen, imageUrl, linkOriginal, fuente, 
        fecha_publicacion, puntuacion, vistas, municipio, lat, lng, fecha_captura, slug
    ) VALUES (
        @id, @titulo, @resumen, @imageUrl, @linkOriginal, @fuente, 
        @fecha_publicacion, @puntuacion, @vistas, @municipio, @lat, @lng, @fecha_captura, @slug
    ) 
    ON CONFLICT(linkOriginal) DO UPDATE SET 
        puntuacion = excluded.puntuacion,
        vistas = excluded.vistas,
        resumen = excluded.resumen,
        imageUrl = excluded.imageUrl,
        lat = excluded.lat,
        lng = excluded.lng
`);

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

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Cálculo de distancia para "Cercanía"
function calculateDistance(lat1, lon1, lat2, lon2) {
    const x = lat2 - lat1;
    const y = lon2 - lon1;
    return Math.sqrt(x * x + y * y);
}

// 1. Algoritmo de "Limpieza" Alta Resolución (Regex WP)
function limpiarUrlAltaResolucion(url) {
    if (!url) return null;
    // Eliminar patrones de thumbnails WordPress (ej: -150x150, -1024x768)
    let mejorada = url.replace(/-\d+x\d+(?=\.[a-zA-Z]+$)/, '');
    // Eliminar etiqueta scale
    mejorada = mejorada.replace('-scaled', '');
    return mejorada;
}

// 2. Rastreo profundo de atributos y validación
async function extraerUrlImagen(item) {
    let urlCruda = null;

    // Prioridad 1: mediaContent
    if (item['media:content'] && item['media:content'].$ && item['media:content'].$.url) {
        urlCruda = item['media:content'].$.url;
    } 
    // Prioridad 2: Enclosure
    else if (item.enclosure && item.enclosure.url && item.enclosure.type && item.enclosure.type.startsWith('image/')) {
        urlCruda = item.enclosure.url;
    } 
    // Prioridad 3: Deep Extraction HTML (content:encoded / description)
    else {
        const htmlToSearch = item['content:encoded'] || item.content || item.description || '';
        if (htmlToSearch) {
            const $ = cheerio.load(htmlToSearch);
            // Iterar para buscar atributos
            $('img').each((i, el) => {
                const src = $(el).attr('data-lazy-src') || $(el).attr('data-src') || $(el).attr('srcset') || $(el).attr('src');
                if (src) {
                    if ($(el).attr('srcset') && src === $(el).attr('srcset')) {
                        const particiones = src.split(',');
                        urlCruda = particiones[particiones.length - 1].trim().split(' ')[0];
                    } else {
                        urlCruda = src;
                    }
                    return false;
                }
            });
        }
    }

    // Prioridad 4 (NUEVO EXTERNO): OpenGraph Web Scraping si no hay nada en el XML
    if (!urlCruda && item.link) {
        try {
            const response = await fetch(item.link);
            const htmlContent = await response.text();
            const $ = cheerio.load(htmlContent);
            // og:image es el principal
            const ogImage = $('meta[property="og:image"]').attr('content');
            if (ogImage) {
                urlCruda = ogImage;
            } else {
                // Foto cruda del body
                const firstImg = $('article img').first().attr('src') || $('main img').first().attr('src');
                if (firstImg) urlCruda = firstImg;
            }
        } catch (e) {
            // Si falla o bloquea, será null y caerá en el fallback
        }
    }

    // 5. Verificación de Carga y Limpieza Regex
    if (urlCruda) {
        let urlFinal = limpiarUrlAltaResolucion(urlCruda).trim();
        
        // Arreglar relativas
        if (urlFinal.startsWith('//')) {
            urlFinal = 'https:' + urlFinal;
        } else if (urlFinal.startsWith('/')) {
            try {
                const base = new URL(item.link);
                urlFinal = base.origin + urlFinal;
            } catch (e) {}
        }
        
        // Validación
        try {
            const parsed = new URL(urlFinal);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return urlFinal;
            }
        } catch {
            if (urlFinal.includes('http')) return urlFinal;
        }
    }
    
    // 6. Fallback inquebrantable
    return '/img/placeholder-noticia.jpg';
}

// Limpieza para evitar HTML en el componente de resumen
function extractSummary(desc) {
    if (!desc) return "Sin resumen disponible.";
    const text = desc.replace(/<[^>]+>/g, '').trim();
    if (text.length > 250) return text.slice(0, 250) + '...';
    return text || "Sin resumen disponible.";
}

// 1. Diccionarios de Palabras Clave
const palabrasAltaRelevancia = [
    "accidente", "muerto", "fallece", "detienen", "balacera", "robo", 
    "asalto", "tragedia", "choque", "cateo", "rescate", "volcadura", 
    "denuncia", "protesta", "bloqueo", "arma", "violencia", "homicidio"
];

const palabrasBajaRelevancia = [
    "inaugura", "gobierno", "alcalde", "gobernadora", "entrega", "programa", 
    "evento", "sesión", "cabildo", "conmemora", "celebra", "visita", 
    "positivo", "obra", "rehabilitación"
];

// 2. Función de Puntuación Eficiente (Evitando Regex complejos)
function calcularInteres(titulo, resumen) {
    let puntuacion = 50; // Puntuación base

    const txtTitulo = (titulo || "").toLowerCase();
    const txtResumen = (resumen || "").toLowerCase();

    // Contar coincidencias de Alta Relevancia
    for (let i = 0; i < palabrasAltaRelevancia.length; i++) {
        const palabra = palabrasAltaRelevancia[i];
        
        // Coincidencias en el título (Multiplicador de Título +15 y Base +25)
        const countTitulo = txtTitulo.split(palabra).length - 1;
        if (countTitulo > 0) {
            puntuacion += (25 * countTitulo) + (15 * countTitulo);
        }
        
        // Coincidencias en el resumen (Base +25)
        const countResumen = txtResumen.split(palabra).length - 1;
        if (countResumen > 0) {
            puntuacion += (25 * countResumen);
        }
    }

    // Contar coincidencias de Baja Relevancia
    for (let i = 0; i < palabrasBajaRelevancia.length; i++) {
        const palabra = palabrasBajaRelevancia[i];
        
        const countTitulo = txtTitulo.split(palabra).length - 1;
        const countResumen = txtResumen.split(palabra).length - 1;
        const totalCoins = countTitulo + countResumen;
        
        if (totalCoins > 0) {
            // Resta -20 por cada coincidencia
            puntuacion -= (20 * totalCoins);
        }
    }

    return puntuacion;
}

// Extracción asíncrona de los Feeds
async function fetchAllRssFeeds() {
    console.log('🔄 Extrayendo nuevos feeds RSS...');
    let agregadas = 0;
    
    for (const feedData of FEED_URLS) {
        try {
            const feed = await parser.parseURL(feedData.url);
            let count = 0;
            
            for (const item of feed.items) {
                if (count >= 50) break;
                
                // Simulación de ubicaciones relativas a Tlaxcala (~ Lat: 19.31, Lng: -98.24)
                const randLat = 19.31 + (Math.random() - 0.5) * 0.4;
                const randLng = -98.24 + (Math.random() - 0.5) * 0.4;
                
                // Sistema de Calificación de Interés Editorial
                const summaryText = extractSummary(item.description || item.content);
                const puntuacionEditorial = calcularInteres(item.title, summaryText);
                
                const simulatedViews = Math.max(100, Math.floor(puntuacionEditorial * 100) + Math.floor(Math.random() * 50));
                
                const imageUrl = await extraerUrlImagen(item);
                
                // Transición a SQLite: Upsert Real con Slug
                insertOrUpdateArticle.run({
                    id: Math.random().toString(36).substr(2, 9),
                    titulo: item.title || 'Sin Título',
                    resumen: summaryText,
                    imageUrl: imageUrl,
                    linkOriginal: item.link || String(Math.random()),
                    fuente: feedData.source,
                    fecha_publicacion: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
                    puntuacion: puntuacionEditorial,
                    vistas: simulatedViews,
                    municipio: '',
                    lat: randLat,
                    lng: randLng,
                    fecha_captura: new Date().toISOString(),
                    slug: generarSlug(item.title)
                });
                
                count++;
                agregadas++;
                
                // Pequeña pausa de 150ms para no saturar al sitio web real (prevención Anti-Bot)
                await new Promise(r => setTimeout(r, 150));
            }
        } catch (err) {
            console.error(`Error procesando feed de ${feedData.source}:`, err.message);
        }
    }
    
    console.log(`✅ Extracción completada. Operaciones SQLite (Insert/Update) procesadas: ${agregadas}.`);
}

// CronJob de Extracción: Cada hora
cron.schedule('0 * * * *', () => {
    fetchAllRssFeeds();
});

// CronJob de Supervivencia y Mantenimiento Diario: 3:00 AM
cron.schedule('0 3 * * *', () => {
    console.log('🧹 Limpieza Diaria de Base de Datos en progreso...');
    try {
        const result = db.prepare(`
            DELETE FROM noticias 
            WHERE fecha_captura <= datetime('now', '-30 days') 
            AND vistas < 500 
            AND id NOT IN (
                SELECT id FROM noticias ORDER BY puntuacion DESC LIMIT 100
            )
        `).run();
        console.log(`✅ Mantenimiento de Supervivencia ejecutado: ${result.changes} noticias descartadas de la base de datos.`);
    } catch(err) {
        console.error('Error durante limpieza DB:', err.message);
    }
});

// Extraer en arranque inicial del servidor
fetchAllRssFeeds();

// Adaptador para el frontend
function formatearFront(row) {
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
        image: row.imageUrl,
        imageUrl: row.imageUrl,
        slug: row.slug,
        lat: row.lat,
        lng: row.lng
    };
}

// ═══════════════════════════════════════
// API v1 (Versión Canónica)
// ═══════════════════════════════════════

// GET /api/v1/feed
app.get('/api/v1/feed', (req, res) => {
    const { lat, lng } = req.query;
    let dbRows = [];
    if (lat && lng) {
        dbRows = db.prepare(`SELECT * FROM noticias ORDER BY (fecha_captura >= datetime('now', '-48 hours')) DESC, puntuacion DESC LIMIT 100`).all();
        let articles = dbRows.map(formatearFront);
        const userLat = parseFloat(lat), userLng = parseFloat(lng);
        articles.sort((a, b) => calculateDistance(userLat, userLng, a.lat, a.lng) - calculateDistance(userLat, userLng, b.lat, b.lng));
        if (!articles.length) return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
        return res.json({ noticiaPrincipal: articles[0], noticiasSecundarias: articles.slice(1, 31) });
    } else {
        dbRows = db.prepare(`SELECT * FROM noticias ORDER BY (fecha_captura >= datetime('now', '-24 hours')) DESC, puntuacion DESC LIMIT 31`).all();
        let articles = dbRows.map(formatearFront);
        if (!articles.length) return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
        return res.json({ noticiaPrincipal: articles[0], noticiasSecundarias: articles.slice(1, 31) });
    }
});

// GET /api/v1/search
app.get('/api/v1/search', (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) return res.json({ resultados: [], relacionados: [] });
    const likeTerm = `%${query}%`;
    const dbRows = db.prepare(`SELECT * FROM noticias WHERE titulo LIKE ? OR resumen LIKE ? ORDER BY puntuacion DESC LIMIT 50`).all(likeTerm, likeTerm);
    const resultados = dbRows.map(formatearFront);
    let relacionados = [];
    if (resultados.length > 0) {
        const textCorpus = resultados.map(r => (r.title || '') + ' ' + (r.summary || '')).join(' ').toLowerCase();
        const words = textCorpus.match(/\b[a-záéíóúñ]+\b/gi) || [];
        const stopWords = ['noticia', 'tlaxcala', 'donde', 'desde', 'sobre', 'hasta', 'cuando', 'quien', 'porque', 'tiene', 'estado', 'municipio', 'gobierno'];
        const frequency = {};
        words.forEach(w => { if (w.length > 5 && !stopWords.includes(w) && !w.includes(query) && !query.includes(w)) frequency[w] = (frequency[w] || 0) + 1; });
        relacionados = Object.keys(frequency).sort((a, b) => frequency[b] - frequency[a]).slice(0, 5);
    }
    res.json({ resultados, relacionados });
});

// GET /api/v1/noticias/:slug -> Noticia individual con relacionadas
app.get('/api/v1/noticias/:slug', (req, res) => {
    const { slug } = req.params;
    const noticia = db.prepare('SELECT * FROM noticias WHERE slug = ?').get(slug);
    if (!noticia) return res.status(404).json({ error: 'Noticia no encontrada' });
    
    // Relacionadas: misma fuente o palabras clave del título
    const palabrasClave = noticia.titulo.split(' ').filter(p => p.length > 4).slice(0, 3);
    let relacionadas = [];
    for (const palabra of palabrasClave) {
        const rows = db.prepare(`SELECT * FROM noticias WHERE titulo LIKE ? AND id != ? LIMIT 2`).all(`%${palabra}%`, noticia.id);
        rows.forEach(r => { if (!relacionadas.find(x => x.id === r.id)) relacionadas.push(r); });
    }
    if (relacionadas.length < 4) {
        const extra = db.prepare(`SELECT * FROM noticias WHERE fuente = ? AND id != ? LIMIT ?`).all(noticia.fuente, noticia.id, 4 - relacionadas.length);
        extra.forEach(r => { if (!relacionadas.find(x => x.id === r.id)) relacionadas.push(r); });
    }
    
    // Valoración promedio
    const valoracionRow = db.prepare('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?').get(noticia.id);
    const comentariosRows = db.prepare('SELECT * FROM comentarios WHERE noticia_id = ? ORDER BY fecha DESC').all(noticia.id);
    
    res.json({
        noticia: formatearFront(noticia),
        relacionadas: relacionadas.slice(0, 4).map(formatearFront),
        valoracion: { promedio: valoracionRow.promedio || 0, total: valoracionRow.total },
        comentarios: comentariosRows
    });
});

// POST /api/v1/valorar
app.post('/api/v1/valorar', (req, res) => {
    const { noticia_id, puntos } = req.body;
    if (!noticia_id || !puntos || puntos < 1 || puntos > 5) return res.status(400).json({ error: 'Datos inválidos' });
    db.prepare('INSERT INTO valoraciones (noticia_id, puntos) VALUES (?, ?)').run(noticia_id, parseInt(puntos));
    const row = db.prepare('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?').get(noticia_id);
    res.json({ ok: true, promedio: row.promedio, total: row.total });
});

// POST /api/v1/comentar
app.post('/api/v1/comentar', (req, res) => {
    const { noticia_id, usuario, comentario } = req.body;
    if (!noticia_id || !comentario || comentario.trim().length < 3) return res.status(400).json({ error: 'Comentario inválido' });
    const nombre = (usuario || 'Anónimo').trim().slice(0, 50);
    db.prepare('INSERT INTO comentarios (noticia_id, usuario, comentario) VALUES (?, ?, ?)').run(noticia_id, nombre, comentario.trim().slice(0, 1000));
    res.json({ ok: true });
});

// ═══════════════════════════════════════
// Rutas Legacy (Retrocompatibilidad)
// ═══════════════════════════════════════
app.get('/api/feed', (req, res) => res.redirect(307, `/api/v1/feed${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`));
app.get('/api/search', (req, res) => res.redirect(307, `/api/v1/search${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`));

// ═══════════════════════════════════════
// SSR: Página Individual de Noticia (SEO + Open Graph)
// ═══════════════════════════════════════
app.get('/noticias/:slug', (req, res) => {
    const { slug } = req.params;
    const noticia = db.prepare('SELECT * FROM noticias WHERE slug = ?').get(slug);
    
    if (!noticia) return res.status(404).sendFile(path.join(__dirname, 'public/index.html'));
    
    const valoracionRow = db.prepare('SELECT AVG(puntos) as promedio, COUNT(*) as total FROM valoraciones WHERE noticia_id = ?').get(noticia.id);
    const promedio = valoracionRow.promedio ? valoracionRow.promedio.toFixed(1) : '0';
    const totalVotos = valoracionRow.total || 0;
    const pct = Math.round((parseFloat(promedio) / 5) * 100);
    let barColor = '#EF4444';
    if (parseFloat(promedio) >= 4) barColor = '#22C55E';
    else if (parseFloat(promedio) >= 3) barColor = '#FFCC00';
    
    const comentariosRows = db.prepare('SELECT * FROM comentarios WHERE noticia_id = ? ORDER BY fecha DESC LIMIT 20').all(noticia.id);
    const comentariosHTML = comentariosRows.length > 0
        ? comentariosRows.map(c => `<div class="comentario-item"><span class="comentario-user">${c.usuario}</span><span class="comentario-fecha">${new Date(c.fecha).toLocaleDateString()}</span><p>${c.comentario}</p></div>`).join('')
        : '<p class="sin-comentarios">Sé el primero en comentar.</p>';
    
    // Relacionadas
    const palabrasClave = noticia.titulo.split(' ').filter(p => p.length > 4).slice(0, 3);
    let relacionadas = [];
    for (const palabra of palabrasClave) {
        const rows = db.prepare(`SELECT * FROM noticias WHERE titulo LIKE ? AND id != ? LIMIT 2`).all(`%${palabra}%`, noticia.id);
        rows.forEach(r => { if (!relacionadas.find(x => x.id === r.id)) relacionadas.push(r); });
    }
    if (relacionadas.length < 4) {
        const extra = db.prepare(`SELECT * FROM noticias WHERE fuente = ? AND id != ? LIMIT ?`).all(noticia.fuente, noticia.id, 4 - relacionadas.length);
        extra.forEach(r => { if (!relacionadas.find(x => x.id === r.id)) relacionadas.push(r); });
    }
    const relacionadasHTML = relacionadas.slice(0, 4).map(r => `
        <a href="/noticias/${r.slug}" class="rel-card">
            <img src="${r.imageUrl}" alt="${r.titulo}" onerror="this.src='/img/placeholder-noticia.jpg'">
            <span>${r.titulo}</span>
        </a>`).join('');
    
    const htmlPage = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>${noticia.titulo} | Intlax</title>
<meta name="description" content="${(noticia.resumen || '').slice(0, 160)}">
<meta property="og:title" content="${noticia.titulo}">
<meta property="og:description" content="${(noticia.resumen || '').slice(0, 200)}">
<meta property="og:image" content="${noticia.imageUrl}">
<meta property="og:url" content="https://intlax.com/noticias/${noticia.slug}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<link href='https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css' rel='stylesheet'>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',sans-serif}
body{background:#121212;color:#fff;padding-bottom:30px}
.top-bar{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;position:sticky;top:0;background:#121212;z-index:100;border-bottom:1px solid #222}
.logo{font-size:22px;font-weight:800;letter-spacing:-0.5px;color:#FFCC00;text-decoration:none}
.back-btn{background:none;border:none;color:#fff;font-size:26px;cursor:pointer;display:flex;align-items:center}
.hero-img{width:100%;height:260px;object-fit:cover;display:block}
.article-body{padding:20px}
.article-source{color:#FFCC00;font-weight:700;font-size:12px;text-transform:uppercase;margin-bottom:10px}
.article-title{font-size:22px;font-weight:800;line-height:1.35;margin-bottom:14px}
.article-date{font-size:12px;color:#9E9E9E;margin-bottom:20px}
.article-summary{font-size:15px;color:#ccc;line-height:1.65;margin-bottom:24px}
.btn-primary{background:#FFCC00;color:#121212;border:none;width:100%;padding:15px;border-radius:12px;font-weight:800;font-size:15px;cursor:pointer;margin-bottom:12px}
.btn-secondary-link{color:#9E9E9E;text-align:center;font-size:13px;text-decoration:underline;display:block;margin-bottom:28px}
.section-title{font-size:16px;font-weight:700;margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid #333}
.rating-bar-wrap{background:#2A2A2C;border-radius:12px;padding:16px;margin-bottom:24px}
.rating-label{font-size:13px;color:#9E9E9E;margin-bottom:10px}
.rating-bar-bg{background:#333;border-radius:20px;height:12px;overflow:hidden}
.rating-bar-fill{height:100%;border-radius:20px;transition:width 0.6s ease}
.rating-score{font-size:24px;font-weight:800;margin-top:8px}
.rating-total{font-size:12px;color:#9E9E9E;margin-top:2px}
.star-buttons{display:flex;gap:8px;margin-top:14px}
.star-btn{flex:1;padding:8px 4px;background:#2A2A2C;border:1px solid #444;border-radius:8px;color:#fff;font-weight:700;cursor:pointer;font-size:13px;transition:all 0.2s}
.star-btn:hover,.star-btn.selected{background:#FFCC00;color:#121212;border-color:#FFCC00}
.comments-section{margin-top:24px}
.comentario-item{background:#1C1C1E;border-radius:10px;padding:14px;margin-bottom:10px}
.comentario-user{font-weight:700;font-size:13px;color:#FFCC00}
.comentario-fecha{font-size:11px;color:#666;margin-left:8px}
.comentario-item p{font-size:14px;color:#ccc;margin-top:8px;line-height:1.5}
.sin-comentarios{color:#555;font-size:14px;text-align:center;padding:20px 0}
.comment-form{margin-top:16px}
.comment-form input,.comment-form textarea{width:100%;background:#1C1C1E;border:1px solid #333;color:#fff;border-radius:10px;padding:12px;font-size:14px;margin-bottom:10px;outline:none}
.comment-form textarea{height:80px;resize:none}
.comment-form input:focus,.comment-form textarea:focus{border-color:#FFCC00}
.btn-comment{background:#FFCC00;color:#121212;border:none;border-radius:10px;padding:12px 20px;font-weight:700;cursor:pointer;width:100%}
.related-section{margin-top:28px}
.related-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.rel-card{display:block;background:#1C1C1E;border-radius:10px;overflow:hidden;text-decoration:none;color:#fff}
.rel-card img{width:100%;height:90px;object-fit:cover}
.rel-card span{display:block;font-size:12px;font-weight:600;padding:8px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.full-modal{position:fixed;inset:0;background:#121212;z-index:2000;display:none;flex-direction:column}
.full-modal.active{display:flex}
.modal-top{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid #222}
#news-iframe{width:100%;flex:1;border:none}
</style>
</head>
<body>
<header class="top-bar">
    <a href="/" class="logo">Intlax</a>
    <button class="back-btn" onclick="history.back()"><i class='bx bx-arrow-back'></i></button>
</header>

<img class="hero-img" src="${noticia.imageUrl}" alt="${noticia.titulo}" onerror="this.src='/img/placeholder-noticia.jpg'">

<div class="article-body">
    <p class="article-source">${noticia.fuente}</p>
    <h1 class="article-title">${noticia.titulo}</h1>
    <p class="article-date">${new Date(noticia.fecha_publicacion).toLocaleDateString('es-MX', {year:'numeric',month:'long',day:'numeric'})}</p>
    <p class="article-summary">${noticia.resumen}</p>
    
    <button class="btn-primary" onclick="abrirIframe('${noticia.linkOriginal}')">Ver nota completa</button>
    <a href="${noticia.linkOriginal}" target="_blank" class="btn-secondary-link">Abrir en Safari/Chrome</a>

    <!-- Valoración -->
    <div class="rating-bar-wrap">
        <p class="section-title">¿Qué tan confiable es esta nota?</p>
        <p class="rating-label">${totalVotos} valoraciones</p>
        <div class="rating-bar-bg">
            <div class="rating-bar-fill" id="rating-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>
        <p class="rating-score" id="rating-score">${promedio}/5</p>
        <p class="rating-total" id="rating-total">${totalVotos} votos</p>
        <div class="star-buttons" id="star-buttons">
            ${[1,2,3,4,5].map(n => `<button class="star-btn" onclick="votar(${n}, '${noticia.id}')">${n}⭐</button>`).join('')}
        </div>
    </div>

    <!-- Relacionadas -->
    <div class="related-section">
        <p class="section-title">Noticias Relacionadas</p>
        <div class="related-grid">${relacionadasHTML}</div>
    </div>

    <!-- Comentarios -->
    <div class="comments-section">
        <p class="section-title">Comentarios</p>
        <div id="comentarios-list">${comentariosHTML}</div>
        <div class="comment-form">
            <input type="text" id="c-usuario" placeholder="Tu nombre (opcional)">
            <textarea id="c-comentario" placeholder="Escribe tu comentario..."></textarea>
            <button class="btn-comment" onclick="enviarComentario('${noticia.id}')">Publicar comentario</button>
        </div>
    </div>
</div>

<!-- Iframe Viewer -->
<div class="full-modal" id="iframe-modal">
    <div class="modal-top">
        <span style="font-weight:800">Intlax</span>
        <button style="background:none;border:none;color:#fff;font-size:26px;cursor:pointer" onclick="cerrarIframe()"><i class='bx bx-x'></i></button>
    </div>
    <iframe id="news-iframe" src="" sandbox="allow-same-origin allow-scripts allow-popups allow-forms"></iframe>
</div>

<script>
function abrirIframe(url) {
    document.getElementById('news-iframe').src = url;
    document.getElementById('iframe-modal').classList.add('active');
}
function cerrarIframe() {
    document.getElementById('iframe-modal').classList.remove('active');
    document.getElementById('news-iframe').src = '';
}
async function votar(puntos, id) {
    const btns = document.querySelectorAll('.star-btn');
    btns.forEach((b,i) => b.classList.toggle('selected', i < puntos));
    try {
        const r = await fetch('/api/v1/valorar', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noticia_id:id,puntos})});
        const data = await r.json();
        const prom = parseFloat(data.promedio).toFixed(1);
        const pct = Math.round((prom/5)*100);
        let color = '#EF4444';
        if (prom>=4) color='#22C55E'; else if (prom>=3) color='#FFCC00';
        document.getElementById('rating-fill').style.width = pct+'%';
        document.getElementById('rating-fill').style.background = color;
        document.getElementById('rating-score').textContent = prom+'/5';
        document.getElementById('rating-total').textContent = data.total+' votos';
    } catch(e){}
}
async function enviarComentario(id) {
    const usuario = document.getElementById('c-usuario').value.trim() || 'Anónimo';
    const comentario = document.getElementById('c-comentario').value.trim();
    if (!comentario || comentario.length < 3) return alert('Escribe un comentario válido.');
    try {
        await fetch('/api/v1/comentar', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({noticia_id:id,usuario,comentario})});
        document.getElementById('c-comentario').value = '';
        const nuevoItem = document.createElement('div');
        nuevoItem.className = 'comentario-item';
        nuevoItem.innerHTML = '<span class="comentario-user">'+usuario+'</span><span class="comentario-fecha">Ahora</span><p>'+comentario+'</p>';
        const lista = document.getElementById('comentarios-list');
        lista.insertBefore(nuevoItem, lista.firstChild);
        const sinCom = lista.querySelector('.sin-comentarios');
        if (sinCom) sinCom.remove();
    } catch(e){ alert('Error al publicar.'); }
}
</script>
</body>
</html>`;

    res.send(htmlPage);
});

// ═══════════════════════════════════════
// SPA Catch-All (Rutas del Frontend)
// ═══════════════════════════════════════
// Sirve index.html para /explorar, /comunidad, /reportar y cualquier ruta no-API
app.get(/^(?!\/api|\/noticias\/).*$/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor de Intlax corriendo en el puerto ${PORT}`);
});
