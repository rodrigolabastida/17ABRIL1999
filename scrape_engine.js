const Parser = require('rss-parser');
const mysql = require('mysql2/promise');
const cheerio = require('cheerio');
const parser = new Parser({
    customFields: {
        item: [
            ['media:content', 'mediaContent'],
            ['media:thumbnail', 'mediaThumbnail'],
            ['enclosure', 'enclosure'],
            ['content:encoded', 'contentEncoded'],
            'content'
        ]
    }
});
require('dotenv').config();

const FEED_URLS = [
    { url: 'https://news.google.com/rss/search?q=Tlaxcala&hl=es-419&gl=MX&ceid=MX:es-419', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=Calpulalpan+Tlaxcala&hl=es-419&gl=MX&ceid=MX:es-419', source: 'Google News' },
    { url: 'https://www.elsoldetlaxcala.com.mx/rss.xml', source: 'El Sol de Tlaxcala' },
    { url: 'https://tlaxcala.quadratin.com.mx/feed/', source: 'Quadratín Tlaxcala' },
    { url: 'https://sintesis.com.mx/tlaxcala/feed/', source: 'Síntesis Tlaxcala' },
    { url: 'https://e-tlaxcala.mx/feed/', source: 'e-Tlaxcala' },
    { url: 'https://www.gentetlx.com.mx/feed/', source: 'Gentetlx' },
    { url: 'https://www.monitortlaxcala.com.mx/feed/', source: 'Monitor Tlaxcala' },
    { url: 'https://tlaxcaladigital.com/feed/', source: 'Tlaxcala Digital' },
    { url: 'https://www.385grados.com/feed/', source: '385 Grados' },
    { url: 'https://faronoticias.com.mx/feed/', source: 'Faro Noticias' },
    { url: 'https://exclusivastlaxcala.com.mx/feed/', source: 'Exclusivas Tlaxcala' },
    { url: 'https://laprensadetlaxcala.com/feed/', source: 'La Prensa de Tlaxcala' },
    { url: 'https://revistacodigo24.com/feed/', source: 'Código 24' }
];

async function extractImageFromUrl(url) {
    if (!url || !url.startsWith('http')) return null;
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const html = await response.text();
        const $ = cheerio.load(html);
        let img = $('meta[property="og:image"]').attr('content') || 
                  $('meta[name="twitter:image"]').attr('content');
        if (!img) img = $('.wp-post-image').attr('src') || $('.attachment-post-thumbnail').attr('src');
        if (!img) {
            $('article img, .content img, .post-content img').each((i, el) => {
                const src = $(el).attr('src');
                if (src && src.startsWith('http') && !src.includes('logo') && !src.includes('avatar')) {
                    img = src;
                    return false; 
                }
            });
        }
        return img;
    } catch (e) { return null; }
}

async function run() {
    console.log('🔄 Iniciando Extractor MariaDB v6.2.9 (Deep Image Hunter v5)...');
    
    let connection;
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'u653801218_master',
            password: process.env.DB_PASSWORD || 'IntlaxAdmin2026',
            database: process.env.DB_NAME || 'u653801218_intlax_v6'
        });
        console.log('🔗 Conexión a MariaDB establecida.');
    } catch (err) {
        console.error('❌ Error de conexión:', err.message);
        return;
    }

    let nuevas = 0;
    let total = 0;

    for (const feedData of FEED_URLS) {
        try {
            process.stdout.write(`📡 Sincronizando ${feedData.source}... `);
            const feed = await parser.parseURL(feedData.url);
            console.log(`OK (${feed.items.length} notas)`);
            
            for (const item of feed.items.slice(0, 10)) {
                total++;
                const slug = item.title.toLowerCase()
                            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                            .replace(/ /g, '-').replace(/[^\w-]+/g, '');

                let img = '/img/placeholder-noticia.jpg';
                if (item.enclosure && item.enclosure.url) img = item.enclosure.url;
                else if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) img = item.mediaContent.$.url;
                else if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) img = item.mediaThumbnail.$.url;
                else {
                    const htmlContent = (item.contentEncoded || '') + (item.contentSnippet || '') + (item.content || '');
                    if (htmlContent.includes('<img')) {
                        const $ = cheerio.load(htmlContent);
                        const foundImg = $('img').attr('src');
                        if (foundImg && foundImg.startsWith('http')) img = foundImg;
                    }
                }
                
                // DEEP SCAN
                if (img.includes('placeholder')) {
                    const deepImg = await extractImageFromUrl(item.link);
                    if (deepImg) img = deepImg;
                }

                if (feedData.source === 'Google News' && img.includes('placeholder')) {
                     const matchSnippet = (item.content || '').match(/src="([^">]+)"/);
                     if (matchSnippet) img = matchSnippet[1];
                }

                try {
                    const [res] = await connection.execute(`
                        INSERT INTO noticias (id, titulo, resumen, imageUrl, linkOriginal, fuente, fecha_publicacion, puntuacion, vistas, municipio, lat, lng, fecha_captura, slug, etiqueta_foro, autor, categoria_impacto, municipio_tag, multiplicador_categoria)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                            imageUrl = IF(imageUrl LIKE '%placeholder%', VALUES(imageUrl), imageUrl),
                            vistas = vistas + 0
                    `, [
                        Math.random().toString(36).substr(2, 9), 
                        item.title, 
                        (item.contentSnippet || item.content || '').substring(0, 300), 
                        img, 
                        item.link, 
                        feedData.source, 
                        item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 19).replace('T', ' ') : new Date().toISOString().slice(0, 19).replace('T', ' '), 
                        60, 0, '', 19.31, -98.24, 
                        new Date().toISOString().slice(0, 19).replace('T', ' '), 
                        slug, 'DEBATE',
                        item.creator || item.author || feedData.source,
                        'GENERAL', 'OTRO', 1.0
                    ]);
                    
                    if (res.affectedRows === 1) nuevas++;
                } catch (dbErr) {
                    // console.error(dbErr.message);
                }
            }
        } catch (e) {
            console.log(`⚠️ FALLO en ${feedData.source}: ${e.message}`);
        }
    }
    
    console.log(`\n🎉 EXTRACCIÓN MARIADB COMPLETADA.`);
    console.log(`✅ Noticias Nuevas: ${nuevas}`);
    console.log(`📝 Total Analizadas: ${total}`);
    
    await connection.end();
}

run();
