const express = require('express');
const router = express.Router();
const Sala = require('../models/Sala');
const Usuario = require('../models/Usuario');

function filtroSala(id) {
    if (!id) return { identificador: null };
    const str = String(id).trim().toUpperCase();
    return {
        $or: [
            { identificador: str },
            { identificador: String(id).trim() },
            ...(!isNaN(id) ? [{ identificador: Number(id) }] : [])
        ]
    };
}

const {
    esHorarioDeCombate,
    generarYGuardarCalendario,
    iniciarCombateEntreUsuarios,
    registrarAccionJugador,
    procesarCierreIncomparecencia,
    obtenerEstadoCombateActivo,
    combatesActivos,
    reiniciarCalendariosDeSalas
} = require('../utils/combate-manager');

/**
 * GET /salas/:id/combate-actual
 * Devuelve el estado actual y equipos del combate para inicializar la pantalla de combate.
 */
router.get('/:id/combate-actual', async (req, res) => {
    try {
        const salaId = req.params.id;
        const { combateId, usuario_id } = req.query;

        let combate = null;
        if (combateId) {
            combate = obtenerEstadoCombateActivo(combateId);
        }

        if (!combate && usuario_id) {
            for (const c of combatesActivos.values()) {
                if (String(c.salaId) === String(salaId) && (
                    c.p1.toLowerCase().trim() === usuario_id.toLowerCase().trim() ||
                    c.p2.toLowerCase().trim() === usuario_id.toLowerCase().trim()
                )) {
                    combate = c;
                    break;
                }
            }
        }

        // Si no está en memoria, crearlo a partir del partido de la jornada
        if (!combate) {
            const sala = await Sala.findOne({ identificador: salaId });
            if (sala && sala.calendario) {
                const jObj = sala.calendario.find(c => c.jornada === (sala.jornada_actual || 1));
                if (jObj) {
                    const partido = jObj.partidos.find(p =>
                        (usuario_id && p.local.toLowerCase().trim() === usuario_id.toLowerCase().trim()) ||
                        (usuario_id && p.visitante.toLowerCase().trim() === usuario_id.toLowerCase().trim())
                    );
                    if (partido) {
                        combate = await iniciarCombateEntreUsuarios(salaId, partido.local, partido.visitante, global.io);
                    }
                }
            }
        }

        if (!combate) {
            return res.status(404).json({ error: "Combate no encontrado" });
        }

        res.json({
            combateId: combate.combateId,
            salaId: combate.salaId,
            jornada: combate.jornada,
            p1: combate.p1,
            p2: combate.p2,
            p1Team: combate.p1Team,
            p2Team: combate.p2Team,
            p1Activo: combate.p1Activo || 0,
            p2Activo: combate.p2Activo || 0,
            turno: combate.turno || 1,
            finalizado: combate.finalizado || false,
            ganador: combate.ganador || null
        });
    } catch (error) {
        console.error("Error en combate-actual:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /salas/:id/datos-showdown?usuario_id=...
 * Devuelve el equipo exportado de Showdown (formato texto y packed), el rival y la URL para WebView.
 */
router.get('/:id/datos-showdown', async (req, res) => {
    try {
        const salaId = req.params.id;
        const { usuario_id } = req.query;

        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const uEmailNorm = (usuario_id || '').toLowerCase().trim();
        const miEquipoObj = sala.equipos_jugadores.find(e =>
            e.usuario_id && e.usuario_id.toLowerCase().trim() === uEmailNorm
        );
        if (!miEquipoObj) return res.status(404).json({ error: "Equipo del usuario no encontrado" });

        const jornada = sala.jornada_actual || 1;
        const jObj = (sala.calendario || []).find(c => c.jornada === jornada);

        let rivalEmail = '';
        if (jObj) {
            const partido = jObj.partidos.find(p =>
                (p.local && p.local.toLowerCase().trim() === uEmailNorm) ||
                (p.visitante && p.visitante.toLowerCase().trim() === uEmailNorm)
            );
            if (partido) {
                rivalEmail = partido.local.toLowerCase().trim() === uEmailNorm ? partido.visitante : partido.local;
            }
        }

        const { generarEquipoTextoShowdown } = require('../utils/combate-manager');
        const miExport = await generarEquipoTextoShowdown(miEquipoObj, jornada);

        let rivalExport = null;
        let rivalNickShowdown = '';
        if (rivalEmail) {
            const rivalEquipoObj = sala.equipos_jugadores.find(e =>
                e.usuario_id && e.usuario_id.toLowerCase().trim() === rivalEmail.toLowerCase().trim()
            );
            if (rivalEquipoObj) {
                rivalExport = await generarEquipoTextoShowdown(rivalEquipoObj, jornada);
                rivalNickShowdown = rivalEquipoObj.nick_showdown || '';
            }
            if (!rivalNickShowdown) {
                rivalNickShowdown = rivalEmail.includes('@') ? rivalEmail.split('@')[0] : rivalEmail;
            }
        }

        const miNickShowdown = (miEquipoObj && miEquipoObj.nick_showdown) ? miEquipoObj.nick_showdown : (usuario_id.includes('@') ? usuario_id.split('@')[0] : usuario_id);

        res.json({
            salaId,
            jornada,
            miUsuario: usuario_id,
            rivalUsuario: rivalEmail,
            miNickShowdown: miNickShowdown,
            rivalNickShowdown: rivalNickShowdown,
            miEquipoTexto: miExport.texto,
            miEquipoPacked: miExport.packed,
            rivalEquipoTexto: rivalExport ? rivalExport.texto : '',
            rivalEquipoPacked: rivalExport ? rivalExport.packed : '',
            showdownUrl: process.env.SHOWDOWN_URL || 'https://play.pokemonshowdown.com/',
            formato: 'gen9customgame'
        });

    } catch (error) {
        console.error("Error en datos-showdown:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /salas/:id/guardar-nick-showdown
 * Guarda el Nick de Showdown del usuario en la sala para que sus rivales lo reconozcan automáticamente.
 */
router.post('/:id/guardar-nick-showdown', async (req, res) => {
    try {
        const salaId = req.params.id;
        const { usuario_id, nick_showdown } = req.body;
        if (!usuario_id || !nick_showdown) {
            return res.status(400).json({ error: "usuario_id y nick_showdown son requeridos" });
        }

        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const uEmailNorm = usuario_id.toLowerCase().trim();
        const eq = sala.equipos_jugadores.find(e =>
            e.usuario_id && e.usuario_id.toLowerCase().trim() === uEmailNorm
        );

        if (eq) {
            eq.nick_showdown = nick_showdown.trim();
            sala.markModified('equipos_jugadores');
            await sala.save();
        }

        res.json({ success: true, mensaje: "Nick de Showdown guardado", nick_showdown });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /salas/:id/reportar-resultado
 * Guarda el resultado del combate desde el WebView, asigna +3 puntos al ganador y finaliza el partido.
 */
router.post('/:id/reportar-resultado', async (req, res) => {
    try {
        const salaId = req.params.id;
        const { ganador, detalles } = req.body;

        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const jornada = sala.jornada_actual || 1;
        const jObj = (sala.calendario || []).find(c => c.jornada === jornada);
        if (!jObj) return res.status(404).json({ error: "Jornada no encontrada" });

        const uGanadorNorm = (ganador || '').toLowerCase().trim();
        const partido = jObj.partidos.find(p =>
            (p.local && p.local.toLowerCase().trim() === uGanadorNorm) ||
            (p.visitante && p.visitante.toLowerCase().trim() === uGanadorNorm)
        );

        if (partido) {
            partido.estado = 'finalizado';
            partido.ganador = ganador;
            partido.detalles = detalles || `Ganador en Showdown: ${ganador}`;
        }

        // Asignar +3 puntos al ganador
        const eqGanador = sala.equipos_jugadores.find(e =>
            e.usuario_id && e.usuario_id.toLowerCase().trim() === uGanadorNorm
        );
        if (eqGanador) {
            eqGanador.points = (eqGanador.points || 0) + 3;
        }

        sala.markModified('calendario');
        sala.markModified('equipos_jugadores');
        await sala.save();

        if (global.io) {
            global.io.to(`sala_${salaId}`).emit('actualizacion_calendario', {
                identificador: salaId,
                jornada,
                ganador
            });
        }

        res.json({ success: true, mensaje: `Resultado guardado. Ganador: ${ganador} (+3 puntos)` });

    } catch (error) {
        console.error("Error en reportar-resultado:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /salas/:id/calendario
 * Obtiene el calendario completo de la sala y la jornada actual.
 * Si no existe calendario y hay al menos 2 jugadores, lo genera automáticamente.
 * Devuelve tanto los IDs/correos como los apodos (nombres) de los usuarios.
 */
router.get('/:id/calendario', async (req, res) => {
    try {
        const salaId = req.params.id;
        let sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        // Si no tiene calendario y tiene jugadores, generarlo
        if ((!sala.calendario || sala.calendario.length === 0) && sala.equipos_jugadores.length >= 2) {
            sala = await generarYGuardarCalendario(sala.identificador);
        }

        // Obtener los apodos (nombres) de todos los usuarios de la sala desde la colección Usuario
        const correos = (sala.equipos_jugadores || []).map(e => e.usuario_id).filter(Boolean);
        const usuariosDB = await Usuario.find({ correo: { $in: correos } });
        const mapaApodos = {};
        for (const u of usuariosDB) {
            if (u.correo) {
                mapaApodos[u.correo.toLowerCase().trim()] = u.nombre || u.correo;
            }
        }

        const resolverApodo = (idOEmail) => {
            if (!idOEmail) return '';
            if (idOEmail.includes('Descansa')) return idOEmail;
            const norm = idOEmail.toLowerCase().trim();
            if (mapaApodos[norm]) return mapaApodos[norm];
            if (idOEmail.includes('@')) {
                return idOEmail.split('@')[0];
            }
            return idOEmail;
        };

        const calendarioConApodos = (sala.calendario || []).map(jObj => ({
            jornada: jObj.jornada,
            partidos: (jObj.partidos || []).map(p => ({
                local: p.local,
                visitante: p.visitante,
                local_nombre: resolverApodo(p.local),
                visitante_nombre: resolverApodo(p.visitante),
                listo_local: p.listo_local,
                listo_visitante: p.listo_visitante,
                ganador: p.ganador,
                ganador_nombre: p.ganador ? resolverApodo(p.ganador) : null,
                estado: p.estado,
                detalles: p.detalles
            }))
        }));

        res.json({
            jornada_actual: sala.jornada_actual || 1,
            calendario: calendarioConApodos,
            horario_combate_activo: esHorarioDeCombate(),
            mapa_apodos: mapaApodos
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /salas/:id/generar-calendario
 * Fuerza la generación del calendario de la liga.
 */
router.post('/:id/generar-calendario', async (req, res) => {
    try {
        const salaId = req.params.id;
        const sala = await generarYGuardarCalendario(salaId);
        if (global.io) {
            global.io.to(`sala_${sala.identificador}`).emit('actualizacion_calendario', {
                identificador: sala.identificador,
                jornada_actual: sala.jornada_actual
            });
        }
        res.json({ mensaje: "Calendario generado con éxito", calendario: sala.calendario });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /salas/:id/estado-combate?usuario_id=xxx
 * Comprueba el estado del partido del usuario en la jornada actual y si el botón debe estar desbloqueado.
 */
router.get('/:id/estado-combate', async (req, res) => {
    try {
        const salaId = req.params.id;
        const usuarioId = req.query.usuario_id;
        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const horarioActivo = esHorarioDeCombate();
        const jornadaActual = sala.jornada_actual || 1;
        const jornadaObj = (sala.calendario || []).find(c => c.jornada === jornadaActual);

        let miPartido = null;
        let soyLocal = false;
        let estoyListo = false;
        let rivalListo = false;
        let rivalId = null;
        let rivalNombre = null;

        if (jornadaObj) {
            miPartido = jornadaObj.partidos.find(p => p.local === usuarioId || p.visitante === usuarioId);
            if (miPartido) {
                soyLocal = miPartido.local === usuarioId;
                estoyListo = soyLocal ? miPartido.listo_local : miPartido.listo_visitante;
                rivalListo = soyLocal ? miPartido.listo_visitante : miPartido.listo_local;
                rivalId = soyLocal ? miPartido.visitante : miPartido.local;

                if (rivalId) {
                    const rivalUserDoc = await Usuario.findOne({ correo: rivalId });
                    rivalNombre = rivalUserDoc ? rivalUserDoc.nombre : (rivalId.includes('@') ? rivalId.split('@')[0] : rivalId);
                }
            }
        }

        res.json({
            horario_activo: horarioActivo,
            jornada_actual: jornadaActual,
            partido_encontrado: !!miPartido,
            partido: miPartido,
            estoy_listo: estoyListo,
            rival_listo: rivalListo,
            rival_id: rivalId,
            rival_nombre: rivalNombre,
            puede_marcar_listo: horarioActivo && miPartido && miPartido.estado === 'pendiente' && !estoyListo
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /salas/:id/marcar-listo
 * Marca al usuario como "Listo" para el combate de la jornada actual.
 * Si ambos rivales están listos, arranca el combate automáticamente con @pkmn/sim.
 */
router.post('/:id/marcar-listo', async (req, res) => {
    try {
        const salaId = req.params.id;
        const { usuario_id } = req.body;

        if (!usuario_id) return res.status(400).json({ error: "usuario_id es requerido" });

        if (!esHorarioDeCombate()) {
            return res.status(403).json({ error: "Los combates solo están activos los domingos de 19:00 a 19:30." });
        }

        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const jornadaActual = sala.jornada_actual || 1;
        const jornadaObj = (sala.calendario || []).find(c => c.jornada === jornadaActual);
        if (!jornadaObj) return res.status(404).json({ error: "Jornada no configurada en el calendario" });

        const partido = jornadaObj.partidos.find(p => p.local === usuario_id || p.visitante === usuario_id);
        if (!partido) return res.status(404).json({ error: "No tienes partido programado en esta jornada" });

        if (partido.estado === 'finalizado') {
            return res.status(400).json({ error: "Este partido ya ha finalizado" });
        }

        const soyLocal = partido.local === usuario_id;
        if (soyLocal) {
            partido.listo_local = true;
        } else {
            partido.listo_visitante = true;
        }

        sala.markModified('calendario');
        await sala.save();

        // Notificar cambio de estado por WebSockets
        if (global.io) {
            global.io.to(`sala_${salaId}`).emit('estado_listo_actualizado', {
                identificador: salaId,
                partidoId: `${partido.local}_vs_${partido.visitante}`,
                usuario_id,
                listo_local: partido.listo_local,
                listo_visitante: partido.listo_visitante
            });
        }

        // Si ambos usuarios están listos, ¡Arrancamos el combate!
        if (partido.listo_local && partido.listo_visitante) {
            partido.estado = 'en_curso';
            sala.markModified('calendario');
            await sala.save();

            const estadoCombate = await iniciarCombateEntreUsuarios(
                salaId,
                partido.local,
                partido.visitante,
                global.io
            );

            return res.json({
                mensaje: "¡Ambos jugadores listos! Combate iniciado.",
                combate_iniciado: true,
                combateId: estadoCombate.combateId
            });
        }

        res.json({
            mensaje: "Marcado como listo. Esperando al rival.",
            combate_iniciado: false,
            listo_local: partido.listo_local,
            listo_visitante: partido.listo_visitante
        });

    } catch (error) {
        console.error("Error en marcar-listo:", error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /salas/:id/accion-combate
 * Permite enviar una acción al combate activo (atacar o cambiar).
 */
router.post('/:id/accion-combate', async (req, res) => {
    try {
        const { combateId, usuario_id, accion } = req.body;
        registrarAccionJugador(combateId, usuario_id, accion, global.io);
        res.json({ success: true, mensaje: "Acción registrada" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * RUTAS DE ADMINISTRACIÓN / DESARROLLO
 */

/**
 * GET/POST /salas/admin/reiniciar-calendarios?salaId=...&regenerar=true
 * Reinicia todos los partidos a estado 'pendiente', desmarca listos, fija jornada_actual=1
 * y notifica a las apps conectadas vía WebSockets.
 */
router.all('/admin/reiniciar-calendarios', async (req, res) => {
    try {
        const { salaId, regenerar } = req.query;
        const resultados = await reiniciarCalendariosDeSalas(
            salaId,
            regenerar === 'true',
            global.io
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

router.all('/admin/toggle-horario', (req, res) => {
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

router.all('/admin/forzar-cierre-jornada', async (req, res) => {
    try {
        await procesarCierreIncomparecencia(global.io);
        res.json({ success: true, mensaje: "Incomparecencias procesadas manualmente" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;

