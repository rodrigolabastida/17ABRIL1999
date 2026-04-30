import asyncio
import aiohttp
import os
import hashlib
from datetime import datetime
from PIL import Image
from io import BytesIO
from bs4 import BeautifulSoup
from database import Database
from dotenv import load_dotenv
import random

load_dotenv()

class AsyncImageHunter:
    def __init__(self, concurrency=20):
        self.semaphore = asyncio.Semaphore(concurrency)
        self.user_agents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        ]
        # Ruta base para medios (ajustar según servidor)
        self.base_media_path = os.getenv('MEDIA_PATH', 'static/media/noticias')

    async def get_headers(self):
        return {
            'User-Agent': random.choice(self.user_agents),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
        }

    async def extract_image_url(self, session, news_url):
        """Busca la mejor imagen disponible en la URL de la noticia"""
        try:
            async with session.get(news_url, timeout=10, headers=await self.get_headers()) as response:
                if response.status != 200: return None
                html = await response.text()
                soup = BeautifulSoup(html, 'lxml')

                # 1. Prioridad: OpenGraph y Twitter
                og_image = soup.find("meta", property="og:image") or soup.find("meta", property="og:image:secure_url")
                if og_image: return og_image["content"]

                twitter_image = soup.find("meta", name="twitter:image")
                if twitter_image: return twitter_image["content"]

                # 2. Fallback: Featured Images comunes en WP y otros
                featured = soup.find("img", class_="wp-post-image") or soup.find("img", class_="featured-image")
                if featured: return featured.get("src") or featured.get("data-src")

                return None
        except Exception as e:
            print(f"⚠️ Error extrayendo imagen de {news_url}: {e}")
            return None

    async def download_and_optimize(self, session, img_url, news_id):
        """Descarga, optimiza y guarda la imagen en formato WebP"""
        try:
            async with session.get(img_url, timeout=15) as response:
                if response.status != 200: return None
                img_data = await response.read()

                # Procesamiento con Pillow
                img = Image.open(BytesIO(img_data))
                
                # Convertir a RGB (necesario para JPEG/WebP si viene de PNG/RGBA)
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")

                # Redimensionar si es muy grande (Full HD max)
                if img.width > 1920:
                    ratio = 1920 / float(img.width)
                    new_height = int(float(img.height) * float(ratio))
                    img = img.resize((1920, new_height), Image.Resampling.LANCZOS)

                # Organizar carpeta por fecha AAAA/MM/DD
                now = datetime.now()
                rel_path = f"{now.year}/{now.month:02d}/{now.day:02d}"
                full_dir = os.path.join(self.base_media_path, rel_path)
                os.makedirs(full_dir, exist_ok=True)

                # Nombre único basado en hash de URL original
                filename = hashlib.md5(img_url.encode()).hexdigest() + ".webp"
                final_path = os.path.join(full_dir, filename)
                
                # Guardar como WebP optimizado
                img.save(final_path, "WEBP", quality=80, method=6)
                
                return f"/media/noticias/{rel_path}/{filename}"
        except Exception as e:
            print(f"❌ Error procesando imagen {img_url}: {e}")
            return None

    async def process_item(self, session, news_item):
        """Orquesta el proceso para una noticia individual"""
        async with self.semaphore:
            news_id = news_item['id']
            news_url = news_item['url']
            
            print(f"🔍 Cazando imagen para: {news_url[:50]}...")
            
            img_url = await self.extract_image_url(session, news_url)
            if not img_url:
                return

            local_path = await self.download_and_optimize(session, img_url, news_id)
            if local_path:
                # Actualizar DB con la ruta local
                await Database.execute(
                    "UPDATE noticias_raw SET resumen = %s, procesada = TRUE WHERE id = %s",
                    (local_path, news_id) # Usamos resumen temporalmente para guardar la ruta o una columna nueva
                )
                # O si actualizamos la tabla principal:
                await Database.execute(
                    "UPDATE noticias SET imageUrl = %s WHERE linkOriginal = %s",
                    (local_path, news_url)
                )
                print(f"✅ Imagen lista: {local_path}")

    async def run_batch(self, limit=50):
        """Procesa un lote de noticias pendientes de imagen"""
        # Obtener noticias que no tengan imageUrl local
        news_to_process = await Database.fetch_all(
            "SELECT id, url FROM noticias_raw WHERE procesada = FALSE LIMIT %s", (limit,)
        )
        
        if not news_to_process:
            print("📭 No hay noticias pendientes de imagen.")
            return

        async with aiohttp.ClientSession() as session:
            tasks = [self.process_item(session, item) for item in news_to_process]
            await asyncio.gather(*tasks)

if __name__ == "__main__":
    hunter = AsyncImageHunter()
    asyncio.run(hunter.run_batch())
