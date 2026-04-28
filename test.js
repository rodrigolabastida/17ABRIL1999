const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <div style="background:#000; color:#0f0; padding:50px; font-family:monospace; height:100vh;">
            <h1>🚀 INTLAX EMERGENCY TEST OK</h1>
            <p>Si estás viendo esto, el servidor de Hostinger FUNCIONA.</p>
            <hr>
            <p><strong>Diagnóstico:</strong> El problema está en la base de datos intlax.db o en alguna dependencia pesada.</p>
            <p>Hora del servidor: ${new Date().toLocaleString()}</p>
        </div>
    `);
});

app.listen(PORT, () => {
    console.log('✅ Servidor de prueba listo en puerto', PORT);
});
