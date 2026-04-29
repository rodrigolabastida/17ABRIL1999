const { spawn } = require('child_process');
require('dotenv').config();

const API_TOKEN = process.env.HOSTINGER_API_TOKEN;
const TARGET_DOMAIN = process.env.TARGET_DOMAIN || 'intlax.com';

/**
 * Llama a una herramienta del servidor MCP de Hostinger.
 * Solo permite operaciones sobre el TARGET_DOMAIN cuando corresponde.
 */
async function callMCP(toolName, args = {}) {
    if (!API_TOKEN) {
        throw new Error('HOSTINGER_API_TOKEN no encontrado en .env');
    }

    // Seguridad: Si el argumento incluye un dominio, forzarlo a TARGET_DOMAIN si no coincide
    if (args.domain && args.domain !== TARGET_DOMAIN) {
        console.warn(`⚠️ Aviso: Redirigiendo operación de ${args.domain} a ${TARGET_DOMAIN}`);
        args.domain = TARGET_DOMAIN;
    }

    return new Promise((resolve, reject) => {
        const proc = spawn('npx', ['hostinger-api-mcp', '--stdio'], {
            env: { ...process.env, API_TOKEN }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            // Intentar detectar si ya tenemos una respuesta JSON-RPC válida
            if (stdout.includes('"jsonrpc"')) {
                 const lines = stdout.split('\n');
                 const responseLine = lines.find(l => l.includes('"jsonrpc"'));
                 if (responseLine) {
                     try {
                         const response = JSON.parse(responseLine);
                         clearTimeout(timeout);
                         proc.kill();
                         if (response.error) reject(new Error(response.error.message));
                         else resolve(response.result);
                     } catch (e) {
                         // Aún no es un JSON completo, seguir esperando
                     }
                 }
            }
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        const request = {
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
                name: toolName,
                arguments: args
            },
            id: 1
        };

        proc.stdin.write(JSON.stringify(request) + '\n');

        const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error(`Timeout llamando a ${toolName}. Stderr: ${stderr}`));
        }, 45000);

        proc.on('close', (code) => {
            clearTimeout(timeout);
            if (stdout.includes('"jsonrpc"')) return; // Ya resuelto
            reject(new Error(`El proceso terminó con código ${code}. Stderr: ${stderr}`));
        });
    });
}

// Interfaz de línea de comandos básica para el puente
if (require.main === module) {
    const action = process.argv[2];
    const arg1 = process.argv[3];

    (async () => {
        try {
            switch (action) {
                case 'list-websites':
                    const websites = await callMCP('hosting_listWebsitesV1');
                    console.log(JSON.stringify(websites, null, 2));
                    break;
                case 'get-websites-info':
                     const info = await callMCP('hosting_listWebsitesV1');
                     const target = JSON.parse(info.content[0].text).data.find(w => w.domain === TARGET_DOMAIN);
                     console.log(JSON.stringify(target, null, 2));
                     break;
                case 'deploy':
                    if (!arg1) return console.error('Uso: node hostinger_bridge.js deploy <path_to_zip>');
                    console.log(`🚀 Iniciando despliegue de ${arg1} en ${TARGET_DOMAIN}...`);
                    const deployResult = await callMCP('hosting_deployJsApplication', {
                        domain: TARGET_DOMAIN,
                        archivePath: arg1
                    });
                    console.log(JSON.stringify(deployResult, null, 2));
                    break;
                case 'list-deployments':
                    const deployments = await callMCP('hosting_listJsDeployments', {
                        domain: TARGET_DOMAIN
                    });
                    console.log(JSON.stringify(deployments, null, 2));
                    break;
                default:
                    console.log('Comandos disponibles: list-websites, get-websites-info, deploy <zip>, list-deployments');
            }
        } catch (err) {
            console.error('❌ Error:', err.message);
        }
    })();
}

module.exports = { callMCP };
