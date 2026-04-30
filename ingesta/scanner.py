import aiohttp
import asyncio
from lxml import etree
from datetime import datetime, timedelta, timezone
from database import Database

class NewsScanner:
    @staticmethod
    async def scan_sitemap(url, fuente):
        """Escanea sitemaps de Google News (formato específico)"""
        headers = {'User-Agent': 'IntlaxBot/2.0 (High Efficiency News Ingestor)'}
        try:
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=10) as response:
                    if response.status != 200:
                        return
                    
                    xml_content = await response.read()
                    root = etree.fromstring(xml_content)
                    
                    # Namespaces comunes en sitemaps de noticias
                    ns = {
                        's': 'http://www.sitemaps.org/schemas/sitemap/0.9',
                        'n': 'http://www.google.com/schemas/sitemap-news/0.9'
                    }
                    
                    noticias_encontradas = 0
                    for entry in root.xpath('//s:url', namespaces=ns):
                        loc = entry.xpath('s:loc/text()', namespaces=ns)[0]
                        pub_date_str = entry.xpath('.//n:publication_date/text()', namespaces=ns)
                        titulo = entry.xpath('.//n:title/text()', namespaces=ns)
                        
                        if not pub_date_str: continue
                        
                        # Parsear fecha y filtrar (Solo últimas 24h)
                        pub_date = datetime.fromisoformat(pub_date_str[0].replace('Z', '+00:00'))
                        if datetime.now(timezone.utc) - pub_date > timedelta(hours=24):
                            continue
                            
                        # Insertar en DB evitando duplicados por URL (ignore)
                        sql = """
                            INSERT IGNORE INTO noticias_raw (titulo, url, fuente, fecha_publicacion, metodo_ingesta)
                            VALUES (%s, %s, %s, %s, 'SITEMAP')
                        """
                        res = await Database.execute(sql, (titulo[0] if titulo else 'Sin Título', loc, fuente, pub_date))
                        if res > 0: noticias_encontradas += 1
                        
                    print(f"✅ [{fuente}] Sitemap procesado: {noticias_encontradas} nuevas noticias.")
                    
        except Exception as e:
            print(f"❌ Error escaneando sitemap {fuente}: {str(e)}")

    @staticmethod
    async def scan_rss_priority(url, fuente):
        """Escáner RSS ligero para fuentes de alta frecuencia"""
        # Implementación similar usando aiohttp y xml parsing
        pass
