const express = require('express');
const cors = require('cors');
const path = require('path');
const Parser = require('rss-parser');
const cron = require('node-cron');
const cheerio = require('cheerio');

const app = express();
const parser = new Parser({
    customFields: {
        item: ['description', 'content:encoded', 'media:content', 'enclosure']
    }
});

const PORT = process.env.PORT || 3000;

// Caché global en memoria (Sin Base de Datos)
let globalArticlesCache = [];

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
    let tempArray = [];
    
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
                
                // Vistas simuladas vinculadas a la calificación para mantener compatibilidad gráfica con la UI
                // Una nota de 100 pts tendrá alrededor de 10,000 "vistas". Una nota de 10 pts tendrá 1,000.
                const simulatedViews = Math.max(100, Math.floor(puntuacionEditorial * 100) + Math.floor(Math.random() * 50));
                
                const imageUrl = await extraerUrlImagen(item);
                
                tempArray.push({
                    id: Math.random().toString(36).substr(2, 9),
                    title: item.title,
                    source: feedData.source,
                    link: item.link,
                    pubDate: item.pubDate,
                    time: new Date(item.pubDate || new Date()).toLocaleDateString(), // Formato simple
                    category: feedData.source, 
                    puntuacion: puntuacionEditorial, // Nuevo atributo
                    views: simulatedViews, // Manteniendo el viejo para el frontend
                    summary: summaryText,
                    image: imageUrl,
                    imageUrl: imageUrl, // Nuevo atributo añadido para persistir compatibilidad y escalado
                    lat: randLat,
                    lng: randLng
                });
                count++;
                
                // Pequeña pausa de 150ms para no saturar al sitio web real (prevención Anti-Bot)
                await new Promise(r => setTimeout(r, 150));
            }
        } catch (err) {
            console.error(`Error procesando feed de ${feedData.source}:`, err.message);
        }
    }
    
    // Sobrescribe el almacenamiento en RAM
    globalArticlesCache = tempArray;
    console.log(`✅ Extracción completada. ${globalArticlesCache.length} artículos almacenados en memoria.`);
}

// CronJob: Cada hora
cron.schedule('0 * * * *', () => {
    fetchAllRssFeeds();
});

// Extraer en arranque inicial del servidor
fetchAllRssFeeds();

// GET /api/feed -> Con soporte Geolocation logic
app.get('/api/feed', (req, res) => {
    const { lat, lng } = req.query;
    
    let articles = [...globalArticlesCache];
    
    if (lat && lng) {
        const userLat = parseFloat(lat);
        const userLng = parseFloat(lng);
        // Distancia más corta primero
        articles.sort((a, b) => {
            const distA = calculateDistance(userLat, userLng, a.lat, a.lng);
            const distB = calculateDistance(userLat, userLng, b.lat, b.lng);
            return distA - distB; 
        });
    } else {
        // Mayor puntuación de interés editorial primero
        articles.sort((a, b) => b.puntuacion - a.puntuacion);
    }
    
    if(articles.length === 0) {
        return res.json({ noticiaPrincipal: null, noticiasSecundarias: [] });
    }
    
    res.json({
        noticiaPrincipal: articles[0],
        noticiasSecundarias: articles.slice(1, 31) // Mandamos 30 al feed para no saturar 
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor de Intlax corriendo en el puerto ${PORT}`);
});
