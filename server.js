const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// Sirviendo archivos estáticos desde public
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint API
app.get('/api/noticias', (req, res) => {
    res.json({
        noticiaPrincipal: {
            id: 1,
            titulo: "ALERTA: Incendio en el Centro Histórico consume antiguo edificio colonial",
            categoria: "ALERTA",
            tiempo: "Hace 10 min",
            vistas: "12.5K",
            comentarios: 145,
            imagen: "https://images.unsplash.com/photo-1542204165-65bf26472b9b?auto=format&fit=crop&q=80&w=1080&ixlib=rb-4.0.3"
        },
        noticiasSecundarias: [
            {
                id: 2,
                titulo: "Autoridades anuncian nuevo plan de bacheo para avenidas principales",
                categoria: "MI CIUDAD",
                tiempo: "Hace 2 horas",
                vistas: "4.2K",
                comentarios: 32,
                imagen: "https://images.unsplash.com/photo-1515162816999-a0c47dc192f7?auto=format&fit=crop&q=80&w=400&ixlib=rb-4.0.3"
            },
            {
                id: 3,
                titulo: "El festival cultural romperá récord de asistencia este fin de semana",
                categoria: "EVENTOS",
                tiempo: "Hace 4 horas",
                vistas: "8.9K",
                comentarios: 112,
                imagen: "https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&q=80&w=400&ixlib=rb-4.0.3"
            },
            {
                id: 4,
                titulo: "Vecinos del barrio sur denuncian falta de alumbrado público",
                categoria: "DENUNCIAS",
                tiempo: "Hace 5 horas",
                vistas: "3.1K",
                comentarios: 58,
                imagen: "https://images.unsplash.com/photo-1548625361-b55d28362ea7?auto=format&fit=crop&q=80&w=400&ixlib=rb-4.0.3"
            }
        ]
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor de Intlax corriendo en http://localhost:${PORT}`);
});
