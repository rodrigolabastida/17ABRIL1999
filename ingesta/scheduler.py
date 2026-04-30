import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from scanner import NewsScanner

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

def start_scheduler():
    scheduler = AsyncIOScheduler()
    # Cada 5 minutos para prioridad
    scheduler.add_job(job_alta_frecuencia, 'interval', minutes=5)
    # Cada 60 minutos para secundarias
    scheduler.add_job(job_baja_frecuencia, 'interval', minutes=60)
    scheduler.start()
    return scheduler
