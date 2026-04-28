const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function run() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'intlax_db',
        multipleStatements: true
    });

    console.log('🔗 Conectado a MariaDB...');

    try {
        const sql = fs.readFileSync(path.join(__dirname, 'scripts', 'migrate_mariadb.sql'), 'utf8');
        console.log('🚀 Ejecutando migración...');
        await connection.query(sql);
        console.log('✅ Migración completada con éxito.');
        
        // Verificación de columnas
        const [columns] = await connection.query('SHOW COLUMNS FROM noticias');
        console.log('📊 Columnas actuales en "noticias":', columns.map(c => c.Field).join(', '));
        
    } catch (err) {
        console.error('❌ Error durante la migración:', err.message);
    } finally {
        await connection.end();
    }
}

run();
