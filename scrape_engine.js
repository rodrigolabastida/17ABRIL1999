const Parser = require('rss-parser');
const sqlite3 = require('sqlite3').verbose();
const parser = new Parser();

const FEED_URLS = [
    { url: 'https://news.google.com/rss/search?q=Tlaxcala&hl=es-419&gl=MX&ceid=MX:es-419', source: 'Google News' },
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

const db = new sqlite3.Database('./intlax.db');

function runQuery(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

async function run() {
    console.log('🔄 Iniciando Barrido Maestro de Noticias (v3.4.2)...');
    let nuevas = 0;
    let total = 0;

    for (const feedData of FEED_URLS) {
        try {
            process.stdout.write(`📡 Conectando con ${feedData.source}... `);
            const feed = await parser.parseURL(feedData.url);
            console.log(`OK (${feed.items.length} notas halladas)`);
            
            for (const item of feed.items.slice(0, 15)) {
                total++;
                const slug = item.title.toLowerCase()
                            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                            .replace(/ /g, '-').replace(/[^\w-]+/g, '');
                            
                try {
                    const res = await runQuery(`
                        INSERT INTO noticias (id, titulo, resumen, imageUrl, linkOriginal, fuente, fecha_publicacion, puntuacion, vistas, municipio, lat, lng, fecha_captura, slug, etiqueta_foro, autor, categoria_impacto, municipio_tag, multiplicador_categoria)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(linkOriginal) DO NOTHING
                    `, [Math.random().toString(36).substr(2, 9), 
                       item.title, 
                       (item.contentSnippet || item.content || '').substring(0, 300), 
                       '', 
                       item.link, 
                       feedData.source, 
                       item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(), 
                       60, 
                       0, 
                       '', 19.31, -98.24, 
                       new Date().toISOString(), 
                       slug, 
                       'DEBATE',
                       item.creator || item.author || feedData.source,
                       'GENERAL',
                       'OTRO',
                       1.0
                    ]);
                    if (res.changes > 0) nuevas++;
                } catch (dbErr) {
                    // Ignoramos duplicados
                }
            }
        } catch (e) {
            console.log(`⚠️ FALLO en ${feedData.source}: ${e.message}`);
        }
    }
    
    console.log(`\n🎉 BARRIDO COMPLETADO.`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✅ Noticias Nuevas: ${nuevas}`);
    console.log(`📝 Total Analizadas: ${total}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    db.close();
}

run();
