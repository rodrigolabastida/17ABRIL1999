import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from scanner import NewsScanner
from async_image_hunter import AsyncImageHunter

# Configuración de fuentes
FUENTES_PRIORITARIAS = [
    {'url': 'https://www.elsoldetlaxcala.com.mx/news_sitemap.xml', 'nombre': 'El Sol de Tlaxcala'},
    {'url': 'https://tlaxcala.quadratin.com.mx/news-sitemap.xml', 'nombre': 'Quadratín Tlaxcala'}
]

FUENTES_SECUNDARIAS = [
    {'url': 'https://e-tlaxcala.mx/news_sitemap.xml', 'nombre': 'e-Tlaxcala'}
]

async def job_alta_frecuencia():
    print("🚀 Iniciando tarea de ALTA FRECUENCIA...")
    tasks = [NewsScanner.scan_sitemap(f['url'], f['nombre']) for f in FUENTES_PRIORITARIAS]
    await asyncio.gather(*tasks)

async def job_baja_frecuencia():
    print("🐢 Iniciando tarea de BAJA FRECUENCIA...")
    tasks = [NewsScanner.scan_sitemap(f['url'], f['nombre']) for f in FUENTES_SECUNDARIAS]
    await asyncio.gather(*tasks)

async def job_procesar_imagenes():
    print("🖼️ Iniciando CAZADOR DE IMÁGENES (Optimización WebP)...")
    hunter = AsyncImageHunter(concurrency=15)
    await hunter.run_batch(limit=40)

def start_scheduler():
    scheduler = AsyncIOScheduler()
    # Cada 5 minutos para prioridad
    scheduler.add_job(job_alta_frecuencia, 'interval', minutes=5)
    # Cada 60 minutos para secundarias
    scheduler.add_job(job_baja_frecuencia, 'interval', minutes=60)
    # Cada 10 minutos para optimización de imágenes
    scheduler.add_job(job_procesar_imagenes, 'interval', minutes=10)
    
    scheduler.start()
    return scheduler
