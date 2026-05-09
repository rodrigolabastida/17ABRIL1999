import os
import sqlite3
import requests
from datetime import datetime

# Configuración
API_URL = "https://intlax.com/api/v1/hermes/queue"
API_KEY = "hermes_secret_2024_intlax"
DB_PATH = "database.db"
IMG_FOLDER = "imagenes"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS noticias_locales
                 (id TEXT PRIMARY KEY, 
                  titulo TEXT, 
                  resumen TEXT, 
                  fuente TEXT, 
                  intlax_url TEXT, 
                  original_url TEXT, 
                  ruta_imagen TEXT, 
                  fecha_sincronizacion DATETIME)''')
    conn.commit()
    conn.close()

def sync():
    print(f"🚀 Iniciando sincronización local: {datetime.now()}")
    
    headers = {"x-hermes-key": API_KEY}
    try:
        response = requests.get(API_URL, headers=headers)
        if response.status_code != 200:
            print(f"❌ Error de API: {response.status_code}")
            return
        
        data = response.json()
        noticias = data.get("data", [])
        
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        
        nuevas = 0
        for n in noticias:
            # Verificar si ya existe
            c.execute("SELECT id FROM noticias_locales WHERE id = ?", (n['id'],))
            if c.fetchone():
                continue
            
            # Descargar imagen
            img_url = n['image']
            img_name = f"{n['id']}.jpg"
            img_path = os.path.join(IMG_FOLDER, img_name)
            
            try:
                img_data = requests.get(img_url, timeout=10).content
                with open(img_path, 'wb') as f:
                    f.write(img_data)
                ruta_final = img_path
            except:
                ruta_final = "error_imagen"
            
            # Insertar en DB
            c.execute('''INSERT INTO noticias_locales 
                         (id, titulo, resumen, fuente, intlax_url, original_url, ruta_imagen, fecha_sincronizacion) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                      (n['id'], n['title'], n['summary'], n['source'], n['intlaxUrl'], n['urlOriginal'], ruta_final, datetime.now()))
            nuevas += 1
            print(f"✅ Guardada: {n['title'][:50]}...")
            
        conn.commit()
        conn.close()
        print(f"🏁 Sincronización finalizada. {nuevas} nuevas noticias guardadas localmente.")
        
    except Exception as e:
        print(f"❌ Error crítico: {e}")

if __name__ == "__main__":
    if not os.path.exists(IMG_FOLDER):
        os.makedirs(IMG_FOLDER)
    init_db()
    sync()
