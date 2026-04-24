const express = require('express');
const cors = require('cors');
const path = require('path');
const Parser = require('rss-parser');
const cron = require('node-cron');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');

const app = express();
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
        fecha_captura DATETIME
    )
`);

// Consulta preparada para Actualización Incremental (Upsert)
const insertOrUpdateArticle = db.prepare(`
    INSERT INTO noticias (
        id, titulo, resumen, imageUrl, linkOriginal, fuente, 
        fecha_publicacion, puntuacion, vistas, municipio, lat, lng, fecha_captura
    ) VALUES (
        @id, @titulo, @resumen, @imageUrl, @linkOriginal, @fuente, 
        @fecha_publicacion, @puntuacion, @vistas, @municipio, @lat, @lng, @fecha_captura
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
                
                // Transición a SQLite: Upsert Real
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
                    municipio: '', // Pendiente en caso de análisis estricto en futuro
                    lat: randLat,
                    lng: randLng,
                    fecha_captura: new Date().toISOString()
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

// Adaptador para el frontend (el front espera id, title, source, link, imageUrl, etc)
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
        lat: row.lat,
        lng: row.lng
    };
}

// GET /api/feed -> Con soporte SQL directo a SQLite
app.get('/api/feed', (req, res) => {
    const { lat, lng } = req.query;
    
    let dbRows = [];
    
    if (lat && lng) {
        // En geolocalización extraemos un pool abundante (top histórico por seguridad) para ordenar en JS (haversine)
        dbRows = db.prepare(`
            SELECT * FROM noticias 
            ORDER BY (fecha_captura >= datetime('now', '-48 hours')) DESC, puntuacion DESC 
            LIMIT 100
        `).all();
        
        let articles = dbRows.map(formatearFront);
        
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);
        articles.sort((a, b) => {
            const distA = calculateDistance(userLat, userLng, a.lat, a.lng);
            const distB = calculateDistance(userLat, userLng, b.lat, b.lng);
            return distA - distB; 
        });
        
        if(articles.length === 0) return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
        return res.json({
            noticiaPrincipal: articles[0],
            noticiasSecundarias: articles.slice(1, 31)
        });
        
    } else {
        // Cargar últimos 24hrs de alta prioridad y complementar con archivo histórico relevante
        dbRows = db.prepare(`
            SELECT * FROM noticias 
            ORDER BY 
                (fecha_captura >= datetime('now', '-24 hours')) DESC, 
                puntuacion DESC 
            LIMIT 31
        `).all();
        
        let articles = dbRows.map(formatearFront);
        if(articles.length === 0) return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
        
        return res.json({
            noticiaPrincipal: articles[0],
            noticiasSecundarias: articles.slice(1, 31)
        });
    }
});

// GET /api/search -> Buscador semántico SQL
app.get('/api/search', (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) {
        return res.json({ resultados: [], relacionados: [] });
    }

    const likeTerm = `%${query}%`;
    const dbRows = db.prepare(`
        SELECT * FROM noticias 
        WHERE titulo LIKE ? OR resumen LIKE ? 
        ORDER BY puntuacion DESC 
        LIMIT 50
    `).all(likeTerm, likeTerm);

    const resultados = dbRows.map(formatearFront);

    // Minería de Términos Relacionados (Top 5 palabras más repetidas)
    let relacionados = [];
    if (resultados.length > 0) {
        const textCorpus = resultados.map(r => (r.title || '') + ' ' + (r.summary || '')).join(' ').toLowerCase();
        const words = textCorpus.match(/\b[a-záéíóúñ]+\b/gi) || [];
        
        // Stopwords básicas para español que pudieran escapar del filtro de 5 letras
        const stopWords = ['noticia', 'tlaxcala', 'donde', 'desde', 'sobre', 'hasta', 'cuando', 'quien', 'porque', 'tiene', 'estado', 'municipio', 'gobierno'];
        
        const frequency = {};
        words.forEach(w => {
            // Ignorar palabras menores a 5 letras, stopwords, y la misma palabra de busqueda
            if (w.length > 5 && !stopWords.includes(w) && !w.includes(query) && !query.includes(w)) {
                frequency[w] = (frequency[w] || 0) + 1;
            }
        });

        const sortedWords = Object.keys(frequency).sort((a, b) => frequency[b] - frequency[a]);
        relacionados = sortedWords.slice(0, 5);
    }

    res.json({
        resultados: resultados,
        relacionados: relacionados
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor de Intlax corriendo en el puerto ${PORT}`);
});
