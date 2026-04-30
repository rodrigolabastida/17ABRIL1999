import os
import aiomysql
from dotenv import load_dotenv

load_dotenv()

class Database:
    _pool = None

    @classmethod
    async def get_pool(cls):
        if cls._pool is None:
            cls._pool = await aiomysql.create_pool(
                host=os.getenv('DB_HOST', 'localhost'),
                port=3306,
                user=os.getenv('DB_USER', 'root'),
                password=os.getenv('DB_PASSWORD', ''),
                db=os.getenv('DB_NAME', 'intlax_db'),
                autocommit=True,
                minsize=5,
                maxsize=20
            )
        return cls._pool

    @classmethod
    async def execute(cls, query, params=None):
        pool = await cls.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(query, params)
                return cur.rowcount

    @classmethod
    async def fetch_all(cls, query, params=None):
        pool = await cls.get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor(aiomysql.DictCursor) as cur:
                await cur.execute(query, params)
                return await cur.fetchall()

# Esquema sugerido para noticias_raw
INIT_SQL = """
CREATE TABLE IF NOT EXISTS noticias_raw (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo TEXT,
    url VARCHAR(255) UNIQUE,
    resumen TEXT,
    fuente VARCHAR(100),
    fecha_publicacion DATETIME,
    fecha_ingesta DATETIME DEFAULT CURRENT_TIMESTAMP,
    procesada BOOLEAN DEFAULT FALSE,
    metodo_ingesta ENUM('WEBSUB', 'SITEMAP', 'RSS_PRIORITY', 'RSS_SECONDARY')
);
"""
