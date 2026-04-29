const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { callMCP } = require('./hostinger_bridge');
require('dotenv').config();

const TARGET_DOMAIN = process.env.TARGET_DOMAIN || 'intlax.com';
const TEMP_ZIP = path.join(__dirname, '../intlax_deploy.zip');

async function deploy() {
    console.log(`📦 Preparando paquete de despliegue para ${TARGET_DOMAIN}...`);

    try {
        // 1. Limpiar despliegues anteriores
        if (fs.existsSync(TEMP_ZIP)) fs.unlinkSync(TEMP_ZIP);

        // 2. Crear ZIP excluyendo node_modules, .git, y archivos sensibles
        // Nota: Usamos el comando zip nativo de Mac
        const excludePatterns = [
            'node_modules/*',
            '.git/*',
            'intlax.db',
            '*.zip',
            'scratch/*',
            'node_modules',
            '.env'
        ].map(p => `-x "${p}"`).join(' ');

        console.log('🤐 Comprimiendo archivos...');
        execSync(`zip -r "${TEMP_ZIP}" . ${excludePatterns}`, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

        const stats = fs.statSync(TEMP_ZIP);
        console.log(`✅ Paquete creado: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

        if (process.argv.includes('--dry-run')) {
            console.log('🔍 Modo Dry-Run: Despliegue omitido.');
            return;
        }

        // 3. Subir y Desplegar
        console.log(`🚀 Subiendo a Hostinger (${TARGET_DOMAIN})...`);
        const result = await callMCP('hosting_deployJsApplication', {
            domain: TARGET_DOMAIN,
            archivePath: TEMP_ZIP,
            removeArchive: true
        });

        console.log('🎉 Despliegue iniciado correctamente!');
        console.log('Monitoriza el progreso en el hPanel o usa hosting_listJsDeployments.');
        // console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.error('❌ Error durante el despliegue:', err.message);
        process.exit(1);
    }
}

deploy();
