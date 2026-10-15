require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const moment = require('moment');
const cors = require('cors');



// Importar modelos
const Sala = require('./models/Sala');
const Usuario = require('./models/Usuario');

// Importar routers
const usuariosRouter = require('./routes/usuarios');
const salasRouter = require('./routes/salas');
const ofertasRouter = require('./routes/ofertas');
const combatesRouter = require('./routes/combates');

// Importar temporizador
const { inicializarTemporizadores, procesarCierreDeSubastas } = require('./utils/mercado-temporizador');
const { procesarCierreIncomparecencia, reiniciarCalendariosDeSalas, esHorarioDeCombate } = require('./utils/combate-manager');
// --- CONFIGURACIÓN INICIAL ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Hacer io y db globales para accesibilidad en routers
global.io = io;

// Middleware
app.use(express.json());

app.use(cors());

// Variables de entorno
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

// --- CONEXIÓN A MONGODB ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✓ Conexión a MongoDB establecida"))
    .catch(err => console.error("❌ Error de conexión:", err));

// --- MODELO PARA CONTADOR (Autoincremento) ---
const counterSchema = new mongoose.Schema({
    _id: String,
    seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

// --- CONFIGURACIÓN SOCKET.IO ---
io.on('connection', (socket) => {
    console.log(`[Socket] Cliente conectado: ${socket.id}`);

    // El cliente se une a una sala específica
    socket.on('unirse_sala', (salaId) => {
        socket.join(`sala_${salaId}`);
        console.log(`[Socket] Usuario se unió a sala ${salaId}`);
    });

    // Acción durante el combate (atacar o cambiar)
    socket.on('accion_combate', (data) => {
        let payload = data;
        if (typeof data === 'string') {
            try { payload = JSON.parse(data); } catch (e) {}
        }
        const { combateId, usuario_id, accion } = payload || {};
        console.log(`[Socket] accion_combate recibida: combateId=${combateId}, usuario=${usuario_id}, accion=${accion}`);
        const { registrarAccionJugador } = require('./utils/combate-manager');
        try {
            registrarAccionJugador(combateId, usuario_id, accion, io);
        } catch (err) {
            console.error('[Socket] Error en accion_combate:', err.message);
        }
    });

    // Desconexión
    socket.on('disconnect', () => {
        console.log(`[Socket] Cliente desconectado: ${socket.id}`);
    });
});

// --- CRON DOMINGO 19:30 (Cierre de combates e incomparecencia) ---
cron.schedule('30 19 * * 0', async () => {
    console.log('⏰ [CRON] Cierre de combates dominicales a las 19:30 (W.O.)...');
    await procesarCierreIncomparecencia(io);
});

// --- RUTAS DE ADMINISTRACIÓN DIRECTAS (Accesibles directamente desde el navegador) ---
app.all(['/admin/reiniciar-calendarios', '/salas/admin/reiniciar-calendarios'], async (req, res) => {
    try {
        const { salaId, regenerar } = req.query;
        const resultados = await reiniciarCalendariosDeSalas(
            salaId,
            regenerar === 'true',
            io
        );

        const isHtml = req.headers.accept && req.headers.accept.includes('text/html');
        if (isHtml) {
            return res.send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <meta charset="utf-8">
                    <title>Pokefantasy - Reinicio de Calendarios</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121820; color: #E0E6ED; padding: 2rem; margin: 0; }
                        .container { max-width: 650px; margin: 0 auto; background: #1B2431; border-radius: 12px; padding: 2rem; box-shadow: 0 8px 30px rgba(0,0,0,0.4); border: 1px solid #2B3A4F; }
                        h1 { color: #4CAF50; font-size: 1.6rem; margin-top: 0; }
                        .badge { display: inline-block; background: #2E7D32; color: #FFF; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 0.85rem; margin-bottom: 1.2rem; }
                        p { line-height: 1.5; color: #A0B0C5; }
                        .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 1.5rem 0; }
                        .btn { display: inline-block; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 0.9rem; transition: transform 0.1s; }
                        .btn:hover { opacity: 0.9; transform: translateY(-1px); }
                        .btn-blue { background: #1976D2; color: white; }
                        .btn-orange { background: #F57C00; color: white; }
                        .btn-purple { background: #7B1FA2; color: white; }
                        pre { background: #0F141C; padding: 1rem; border-radius: 8px; overflow-x: auto; color: #80CBC4; font-family: monospace; font-size: 0.85rem; border: 1px solid #1E293B; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>✅ ¡Calendarios Reiniciados con Éxito!</h1>
                        <span class="badge">Jornada 1 • Pendientes • Listo = False</span>
                        <p>Se han reseteado todos los enfrentamientos en MongoDB. Ningún usuario está marcado como "Listo" ni en combate. Las apps Android conectadas se han actualizado automáticamente mediante WebSockets.</p>
                        
                        <div class="actions">
                            <a href="/salas/admin/reiniciar-calendarios" class="btn btn-blue">🔄 Reiniciar otra vez</a>
                            <a href="/salas/admin/reiniciar-calendarios?regenerar=true" class="btn btn-purple">🎲 Regenerar Round-Robin</a>
                            <a href="/salas/admin/toggle-horario" class="btn btn-orange">⏰ Alternar Horario Dev</a>
                        </div>

                        <h3>Salas afectadas (${resultados.length}):</h3>
                        <pre>${JSON.stringify(resultados, null, 2)}</pre>
                    </div>
                </body>
                </html>
            `);
        }

        res.json({
            success: true,
            mensaje: "Calendarios reiniciados correctamente a 'pendiente' y desmarcados",
            salas_afectadas: resultados.length,
            detalles: resultados
        });
    } catch (error) {
        console.error("Error al reiniciar calendarios:", error);
        res.status(500).json({ error: error.message });
    }
});

app.all(['/admin/toggle-horario', '/salas/admin/toggle-horario'], (req, res) => {
    process.env.MODO_DEV_COMBATE = process.env.MODO_DEV_COMBATE === 'true' ? 'false' : 'true';
    const activo = esHorarioDeCombate();
    if (global.io) {
        global.io.emit('actualizacion_calendario', { horario_activo: activo });
    }

    const isHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (isHtml) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="utf-8">
                <title>Pokefantasy - Toggle Horario Dev</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #121820; color: #E0E6ED; padding: 2rem; margin: 0; }
                    .container { max-width: 600px; margin: 0 auto; background: #1B2431; border-radius: 12px; padding: 2rem; box-shadow: 0 8px 30px rgba(0,0,0,0.4); border: 1px solid #2B3A4F; }
                    h1 { color: ${activo ? '#4CAF50' : '#F44336'}; margin-top: 0; }
                    .badge { display: inline-block; background: ${activo ? '#2E7D32' : '#C62828'}; color: #FFF; padding: 6px 14px; border-radius: 20px; font-weight: bold; }
                    .btn { display: inline-block; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: bold; margin-top: 15px; margin-right: 10px; }
                    .btn-toggle { background: #FF9800; color: white; }
                    .btn-blue { background: #1976D2; color: white; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>${activo ? '🔥 Modo Dev ACTIVO: Horario Desbloqueado' : '🔒 Modo Dev INACTIVO: Horario Normal'}</h1>
                    <span class="badge">Estado actual: ${activo ? 'Combates Disponibles AHORA' : 'Solo Domingos 19:00 - 19:30'}</span>
                    <p>La app Android ha recibido la señal por WebSockets y actualizará el estado de los botones inmediatamente.</p>
                    <div>
                        <a href="/salas/admin/toggle-horario" class="btn btn-toggle">🔄 Cambiar Estado de Nuevo</a>
                        <a href="/salas/admin/reiniciar-calendarios" class="btn btn-blue">🗓️ Reiniciar Calendarios</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    }

    res.json({
        mensaje: activo ? "🔥 Horario de combate DESBLOQUEADO (Modo Dev)" : "🔒 Horario de combate BLOQUEADO (Normal)",
        modo_dev_combate: process.env.MODO_DEV_COMBATE === 'true',
        horario_activo_ahora: activo
    });
});

// --- ROUTERS ---
app.use('/usuarios', usuariosRouter);
app.use('/salas', salasRouter);
app.use('/salas', ofertasRouter);
app.use('/salas', combatesRouter);


app.put('/admin/mercado/cerrar-subastas', async (req, res) => {
    try {
        console.log('🔧 Cerrando subastas manualmente...');
        const { procesarCierreDeSubastas } = require('./utils/mercado-temporizador');
        await procesarCierreDeSubastas(io);
        res.json({ success: true, message: 'Subastas cerradas manualmente' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/admin/mercado/cerrar-subastas', async (req, res) => {
    try {
        console.log('🔧 Forzando cierre de subastas y reinicio de mercado...');

        // Llamamos a la función importada pasándole el objeto global.io
        await procesarCierreDeSubastas(global.io);

        res.json({
            success: true,
            message: 'Mercado reiniciado: Pokémon adjudicados y nuevos generados.'
        });
    } catch (error) {
        console.error('❌ Error al reiniciar mercado:', error);
        res.status(500).json({ error: error.message });
    }
});


// --- ENDPOINT HEALTH CHECK ---
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// --- ERROR HANDLING ---
app.use((err, req, res, next) => {
    console.error('❌ Error no manejado:', err);
    res.status(500).json({
        error: 'Error interno del servidor',
        message: err.message
    });
});

// --- INICIAR SERVIDOR ---
function iniciarServidor() {
    try {
        // Inicializar temporizadores
        inicializarTemporizadores(io);

        // Iniciar servidor HTTP
        server.listen(PORT, () => {
            console.log(`
╔════════════════════════════════════════════════════════════╗
║         🎮 SERVIDOR POKÉFANTASY INICIADO                   ║
║                                                            ║
║  Puerto: ${PORT}                                             ║
║  Base de datos: Conectada ✓                                ║
║  Temporizadores: Activos ✓                                 ║
║  WebSockets: Configurados ✓                                ║
║  Routers: Registrados ✓                                    ║
╚════════════════════════════════════════════════════════════╝
            `);
        });
    } catch (error) {
        console.error('❌ Error iniciando servidor:', error);
        process.exit(1);
    }
}

//mensaje de chapando servidor
process.on('SIGINT', () => {
    console.log('\n⏹️  Cerrando servidor...');
    server.close(() => {
        console.log('✓ Servidor cerrado');
        process.exit(0);
    });
});

// Ejecutar
iniciarServidor();

module.exports = { app, server, io };