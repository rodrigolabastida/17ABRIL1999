-- Respaldo de seguridad
CREATE TABLE IF NOT EXISTS noticias_backup_2026_04_27 AS SELECT * FROM noticias;

-- Migración de estructura MariaDB
ALTER TABLE noticias 
ADD COLUMN IF NOT EXISTS categoria_impacto VARCHAR(50) DEFAULT 'GENERAL',
ADD COLUMN IF NOT EXISTS municipio_tag VARCHAR(100) DEFAULT 'OTRO',
ADD COLUMN IF NOT EXISTS multiplicador_categoria DECIMAL(3,2) DEFAULT 1.0,
ADD COLUMN IF NOT EXISTS votos_positivos_count INT DEFAULT 0;

-- Índice de rendimiento
CREATE INDEX IF NOT EXISTS idx_municipio ON noticias(municipio_tag);
