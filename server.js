const express = require('express');
const cors = require('cors');
const path = require('path');
const Parser = require('rss-parser');
const cron = require('node-cron');

const app = express();
const parser = new Parser({
    customFields: {
        item: ['description']
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

// Limpieza para evitar HTML en el componente de resumen
function extractSummary(desc) {
    if (!desc) return "Sin resumen disponible.";
    const text = desc.replace(/<[^>]+>/g, '').trim();
    if (text.length > 250) return text.slice(0, 250) + '...';
    return text || "Sin resumen disponible.";
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
                
                // Vistas simuladas basadas en rand y no dependientes
                const randomViews = Math.floor(Math.random() * 14900) + 100;
                
                let imgMatch = null;
                if(item.content) imgMatch = item.content.match(/<img[^>]+src="([^">]+)"/);
                const imageUrl = (imgMatch && imgMatch[1]) ? imgMatch[1] : "https://images.unsplash.com/photo-1542204165-65bf26472b9b?auto=format&fit=crop&q=80&w=400";
                
                tempArray.push({
                    id: Math.random().toString(36).substr(2, 9),
                    title: item.title,
                    source: feedData.source,
                    link: item.link,
                    pubDate: item.pubDate,
                    time: new Date(item.pubDate || new Date()).toLocaleDateString(), // Formato simple
                    category: feedData.source, 
                    views: randomViews,
                    summary: extractSummary(item.description || item.content),
                    image: imageUrl,
                    lat: randLat,
                    lng: randLng
                });
                count++;
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
        // Mayores vistas primero
        articles.sort((a, b) => b.views - a.views);
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
