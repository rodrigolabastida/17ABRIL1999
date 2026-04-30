import asyncio
import os
from database import Database, INIT_SQL
from dotenv import load_dotenv

async def setup():
    print("🛠️ Iniciando configuración de Base de Datos para Ingesta v2.0...")
    load_dotenv()
    
    try:
        # Intentar conexión y creación de tabla
        await Database.get_pool()
        print("🔗 Conexión exitosa a MariaDB.")
        
        # Ejecutar el SQL de inicialización que definimos en database.py
        result = await Database.execute(INIT_SQL)
        print("✅ Tabla 'noticias_raw' verificada/creada.")
        
        # Añadir un índice único extra por URL si no existe para seguridad de duplicados
        try:
            await Database.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_noticia_url ON noticias_raw(url)")
            print("index: OK")
        except:
            pass
            
        print("\n🚀 ¡Todo listo! El sistema de ingesta ya puede escribir en la base de datos.")
        
    except Exception as e:
        print(f"\n❌ Error fatal de configuración: {str(e)}")
        print("Asegúrate de que el servidor MariaDB esté activo y el archivo .env tenga los datos correctos.")

if __name__ == "__main__":
    asyncio.run(setup())
