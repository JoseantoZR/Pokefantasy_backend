const moment = require('moment');
const Sala = require('../models/Sala');
const Usuario = require('../models/Usuario');

// Caché en memoria para PokeAPI
const cachePokeApi = new Map();

// Gestor de combates activos en memoria
// Key: combateId (string), Value: Objeto Combate
const combatesActivos = new Map();

/**
 * Comprueba si estamos dentro de la ventana oficial de combate:
 * Domingos de 19:00 a 19:30.
 * Si process.env.MODO_DEV_COMBATE === 'true', siempre retorna true para pruebas.
 */
function esHorarioDeCombate() {
    if (process.env.MODO_DEV_COMBATE === 'true') {
        return true;
    }

    const ahora = moment();
    const esDomingo = ahora.day() === 0; // 0 = Domingo
    const hora = ahora.hour();
    const minuto = ahora.minute();

    // 19:00 a 19:30 (incluye hasta 19:29:59)
    if (esDomingo && hora === 19 && minuto < 30) {
        return true;
    }
    return false;
}

/**
 * Obtiene datos de un Pokémon desde PokeAPI con caché en memoria.
 */
async function obtenerDatosPokemon(id) {
    if (cachePokeApi.has(id)) {
        return cachePokeApi.get(id);
    }

    try {
        const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
        if (!res.ok) throw new Error(`PokeAPI error: ${res.status}`);
        const data = await res.json();

        const pokeInfo = {
            id: data.id,
            name: data.name,
            types: data.types.map(t => t.type.name),
            base_stats: {
                hp: data.stats.find(s => s.stat.name === 'hp')?.base_stat || 50,
                attack: data.stats.find(s => s.stat.name === 'attack')?.base_stat || 50,
                defense: data.stats.find(s => s.stat.name === 'defense')?.base_stat || 50,
                special_attack: data.stats.find(s => s.stat.name === 'special-attack')?.base_stat || 50,
                special_defense: data.stats.find(s => s.stat.name === 'special-defense')?.base_stat || 50,
                speed: data.stats.find(s => s.stat.name === 'speed')?.base_stat || 50
            },
            moves: data.moves
        };

        cachePokeApi.set(id, pokeInfo);
        return pokeInfo;
    } catch (e) {
        console.error(`Error obteniendo Pokémon #${id}:`, e.message);
        return {
            id,
            name: `pokemon-${id}`,
            types: ['normal'],
            base_stats: { hp: 50, attack: 50, defense: 50, special_attack: 50, special_defense: 50, speed: 50 },
            moves: []
        };
    }
}

/**
 * Calcula los 4 últimos ataques aprendidos por nivel según el nivel actual.
 * Regla: Nivel = Math.max(7, jornada * 7).
 */
function calcularAtaquesPorNivel(pokeData, nivel) {
    const movimientosAprendidos = [];

    for (const m of pokeData.moves || []) {
        for (const vgd of m.version_group_details || []) {
            if (vgd.move_learn_method.name === 'level-up' && vgd.level_learned_at <= nivel) {
                movimientosAprendidos.push({
                    name: m.move.name,
                    level: vgd.level_learned_at
                });
                break;
            }
        }
    }

    // Ordenar de mayor a menor nivel de aprendizaje
    movimientosAprendidos.sort((a, b) => b.level - a.level);

    // Evitar duplicados por nombre
    const unicos = [];
    const vistos = new Set();
    for (const m of movimientosAprendidos) {
        if (!vistos.has(m.name)) {
            vistos.add(m.name);
            unicos.push(m.name);
        }
    }

    // Tomar los 4 más recientes
    const elegidos = unicos.slice(0, 4);

    // Si tiene menos de 4, rellenar con ataques básicos seguros
    const basicos = ['tackle', 'scratch', 'quick-attack', 'pound'];
    for (const b of basicos) {
        if (elegidos.length >= 4) break;
        if (!elegidos.includes(b)) elegidos.push(b);
    }

    return elegidos;
}

/**
 * Formatea un equipo para @pkmn/sim y para la interfaz del cliente.
 */
async function prepararEquipoParaCombate(equipoJugador, jornada) {
    const nivel = Math.max(7, (jornada || 1) * 7);

    // Obtener los Pokémon de SalaEquipo
    const todosPokemons = equipoJugador && equipoJugador.pokemons ? equipoJugador.pokemons : [];

    // Filtrar los titulares activos (posiciones 1 a 6 en SalaEquipo)
    let titulares = todosPokemons.filter(p => p.posicion >= 1 && p.posicion <= 6);

    // Si el usuario no tiene colocados titulares en 1-6 pero tiene en reserva, tomar los primeros
    if (titulares.length === 0 && todosPokemons.length > 0) {
        titulares = todosPokemons.slice(0, 6);
    }

    // Si no tiene ningún Pokémon en la sala, asignar un inicial por defecto para evitar fallo
    if (titulares.length === 0) {
        titulares = [{ id: 25, posicion: 1 }]; // Pikachu
    }

    // ORDENAR: El Pokémon con posicion === 1 DEBE IR ESTRICTAMENTE EL PRIMERO
    titulares.sort((a, b) => {
        if (a.posicion === 1) return -1;
        if (b.posicion === 1) return 1;
        return (a.posicion || 99) - (b.posicion || 99);
    });

    const teamShowdown = [];
    const teamCliente = [];

    for (const p of titulares) {
        const data = await obtenerDatosPokemon(p.id);
        const moves = calcularAtaquesPorNivel(data, nivel);

        // Calcular PS aproximados según fórmula Pokémon
        const maxHp = Math.floor(((2 * data.base_stats.hp + 31) * nivel) / 100) + nivel + 10;

        teamShowdown.push({
            name: data.name,
            species: data.name,
            moves: moves.map(m => m.replace(/-/g, '')), // Formato Showdown sin guiones
            ability: 'No Ability',
            level: nivel,
            ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
            evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 }
        });

        teamCliente.push({
            id: p.id,
            name: data.name,
            level: nivel,
            hp: maxHp,
            maxHp: maxHp,
            types: data.types,
            moves: moves,
            posicion: p.posicion,
            debilitado: false
        });
    }

    return { teamShowdown, teamCliente };
}

/**
 * Convierte un array de Pokémon en el formato empaquetado de Pokémon Showdown.
 * Estructura de tuberías (|):
 * 0: Nickname/Name
 * 1: Species (vacío si es igual al nombre)
 * 2: Item (vacío)
 * 3: Ability
 * 4: Moves (separados por coma)
 * 5: Nature (Serious)
 * 6: EVs (1,,,, -> 1 en HP, resto 0)
 * 7: Gender (vacío)
 * 8: IVs (vacío -> 31 por defecto)
 * 9: Shiny (vacío)
 * 10: Level
 * 11: Happiness (255)
 */
function packTeam(team) {
    if (!team || team.length === 0) return '';
    return team.map(p => {
        const moves = (p.moves || []).join(',');
        const ability = (p.ability && p.ability !== 'No Ability') ? p.ability : '';
        const level = p.level || 50;
        return `${p.name}|||${ability}|${moves}|Serious|1,,,,||||${level}|255`;
    }).join(']');
}

/**
 * Genera el equipo en formato texto Showdown (Pokepaste) y formato packed para localStorage
 */
async function generarEquipoTextoShowdown(equipoJugador, jornada) {
    const { teamShowdown, teamCliente } = await prepararEquipoParaCombate(equipoJugador, jornada);

    const bloques = [];
    for (const p of teamCliente) {
        const lineas = [];
        lineas.push(p.name);
        lineas.push(`Level: ${p.level}`);
        lineas.push(`Serious Nature`);
        lineas.push(`EVs: 1 HP`);
        lineas.push(`Happiness: 255`);
        for (const m of p.moves || []) {
            lineas.push(`- ${m.replace(/-/g, ' ')}`);
        }
        bloques.push(lineas.join('\n'));
    }
    const texto = bloques.join('\n\n');
    const packed = packTeam(teamShowdown);

    return { texto, packed, teamCliente };
}

/**
 * Genera el calendario Round-Robin (todos contra todos) y lo guarda en la Sala.
 * Puede recibir el identificador numérico o directamente el documento Mongoose de la Sala.
 */
async function generarYGuardarCalendario(salaOrId) {
    let sala;
    if (salaOrId && typeof salaOrId === 'object' && salaOrId.equipos_jugadores) {
        sala = salaOrId;
    } else {
        const idNum = parseInt(salaOrId);
        sala = await Sala.findOne({ identificador: !isNaN(idNum) ? idNum : salaOrId });
    }
    if (!sala) throw new Error('Sala no encontrada');

    const participantes = (sala.equipos_jugadores || []).map(e => e.usuario_id).filter(Boolean);
    if (participantes.length < 2) {
        throw new Error('Se necesitan al menos 2 jugadores para generar el calendario');
    }

    const nombres = [...participantes];
    if (nombres.length % 2 !== 0) {
        nombres.push('- Descansa -');
    }

    const numEquipos = nombres.length;
    const numJornadas = numEquipos - 1;
    const partidosPorJornada = numEquipos / 2;

    const calendario = [];

    for (let j = 0; j < numJornadas; j++) {
        const partidos = [];
        for (let p = 0; p < partidosPorJornada; p++) {
            let local = (j + p) % (numEquipos - 1);
            let visitante = (numEquipos - 1 - p + j) % (numEquipos - 1);
            if (p === 0) visitante = numEquipos - 1;

            const uLocal = nombres[local];
            const uVisitante = nombres[visitante];

            // Si uno es '- Descansa -', se marca directamente finalizado
            const esDescanso = uLocal.includes('Descansa') || uVisitante.includes('Descansa');

            partidos.push({
                local: uLocal,
                visitante: uVisitante,
                listo_local: false,
                listo_visitante: false,
                ganador: esDescanso ? (uLocal.includes('Descansa') ? uVisitante : uLocal) : null,
                estado: esDescanso ? 'finalizado' : 'pendiente',
                detalles: esDescanso ? 'Jornada de descanso' : ''
            });
        }
        calendario.push({
            jornada: j + 1,
            partidos: partidos
        });
    }

    sala.calendario = calendario;
    sala.jornada_actual = 1;
    sala.markModified('calendario');
    await sala.save();

    return sala;
}

/**
 * Crea e inicializa una batalla interactiva entre dos usuarios usando @pkmn/sim.
 */
async function iniciarCombateEntreUsuarios(salaId, u1Email, u2Email, io) {
    const sala = await Sala.findOne({ identificador: salaId });
    if (!sala) throw new Error('Sala no encontrada');

    const e1 = sala.equipos_jugadores.find(e =>
        e.usuario_id && u1Email && e.usuario_id.toLowerCase().trim() === u1Email.toLowerCase().trim()
    );
    const e2 = sala.equipos_jugadores.find(e =>
        e.usuario_id && u2Email && e.usuario_id.toLowerCase().trim() === u2Email.toLowerCase().trim()
    );

    if (!e1 || !e2) throw new Error('Equipos de jugadores no encontrados');

    const jornada = sala.jornada_actual || 1;
    const eq1 = await prepararEquipoParaCombate(e1, jornada);
    const eq2 = await prepararEquipoParaCombate(e2, jornada);

    const combateId = `${salaId}_j${jornada}_${u1Email}_vs_${u2Email}`;

    // Importar @pkmn/sim
    let sim;
    try {
        sim = require('@pkmn/sim');
    } catch (e) {
        console.warn('⚠️ @pkmn/sim no está instalado aún en node_modules. Ejecutar npm install');
    }

    const estadoCombate = {
        combateId,
        salaId,
        jornada,
        p1: u1Email,
        p2: u2Email,
        p1Team: eq1.teamCliente,
        p2Team: eq2.teamCliente,
        p1Activo: 0,
        p2Activo: 0,
        turno: 1,
        elecciones: { p1: null, p2: null },
        finalizado: false,
        ganador: null,
        stream: null
    };

    if (sim && sim.BattleStream) {
        const stream = new sim.BattleStream();
        estadoCombate.stream = stream;

        // Escuchar la salida del simulador
        (async () => {
            try {
                for await (const chunk of stream) {
                    procesarLogShowdown(chunk, estadoCombate, io);
                }
            } catch (err) {
                console.error(`Error en stream de Showdown (${combateId}):`, err);
            }
        })();

        // Inicializar Showdown con formato customgame
        const p1Packed = packTeam(eq1.teamShowdown);
        const p2Packed = packTeam(eq2.teamShowdown);

        stream.write(`>start {"formatid":"gen9customgame"}\n`);
        stream.write(`>player p1 {"name":"${u1Email}","team":"${p1Packed}"}\n`);
        stream.write(`>player p2 {"name":"${u2Email}","team":"${p2Packed}"}\n`);
    }

    combatesActivos.set(combateId, estadoCombate);

    // Notificar a ambos jugadores mediante WebSocket
    io.to(`sala_${salaId}`).emit('combate_iniciado', {
        combateId,
        salaId,
        jornada,
        p1: u1Email,
        p2: u2Email,
        p1Team: eq1.teamCliente,
        p2Team: eq2.teamCliente,
        p1Activo: 0,
        p2Activo: 0
    });

    return estadoCombate;
}

/**
 * Procesa los logs que emite Pokémon Showdown y envía eventos estructurados a Android.
 */
function procesarLogShowdown(chunk, combate, io) {
    const lineas = chunk.split('\n');
    const eventosTurno = [];

    for (const linea of lineas) {
        const partes = linea.split('|');
        if (partes.length < 2) continue;

        const comando = partes[1];

        if (comando === 'turn') {
            combate.turno = parseInt(partes[2]) || combate.turno + 1;
            eventosTurno.push({ tipo: 'turno', numero: combate.turno });
        } else if (comando === 'move') {
            const quien = partes[2].startsWith('p1') ? 'p1' : 'p2';
            const movimiento = partes[3];
            eventosTurno.push({ tipo: 'move', jugador: quien, movimiento });
        } else if (comando === '-damage') {
            const quien = partes[2].startsWith('p1') ? 'p1' : 'p2';
            const hpStr = partes[3] || '0/100';
            const [hpActual, hpTotal] = hpStr.split(' ')[0].split('/');
            const actualNum = parseInt(hpActual) || 0;
            const totalNum = parseInt(hpTotal) || 100;
            eventosTurno.push({
                tipo: 'damage',
                jugador: quien,
                hpActual: actualNum,
                hpTotal: totalNum
            });

            // Sincronizar estado interno del equipo
            const team = quien === 'p1' ? combate.p1Team : combate.p2Team;
            const activo = quien === 'p1' ? combate.p1Activo : combate.p2Activo;
            if (team && team[activo]) {
                team[activo].hp = actualNum;
                if (actualNum <= 0) team[activo].debilitado = true;
            }
        } else if (comando === 'faint') {
            const quien = partes[2].startsWith('p1') ? 'p1' : 'p2';
            eventosTurno.push({ tipo: 'faint', jugador: quien });

            const team = quien === 'p1' ? combate.p1Team : combate.p2Team;
            const vivoIdx = team.findIndex(p => !p.debilitado && p.hp > 0);
            if (vivoIdx !== -1) {
                if (quien === 'p1') combate.p1Activo = vivoIdx;
                else combate.p2Activo = vivoIdx;
                eventosTurno.push({ tipo: 'switch', jugador: quien, pokemon: team[vivoIdx].name });
            }
        } else if (comando === 'switch') {
            const quien = partes[2].startsWith('p1') ? 'p1' : 'p2';
            const pokemonNombre = partes[3] ? partes[3].split(',')[0] : 'Pokemon';
            eventosTurno.push({ tipo: 'switch', jugador: quien, pokemon: pokemonNombre });
        } else if (comando === 'win') {
            const ganadorNombre = partes[2];
            combate.finalizado = true;
            combate.ganador = ganadorNombre;
            eventosTurno.push({ tipo: 'win', ganador: ganadorNombre });
            finalizarCombate(combate, ganadorNombre, io);
        }
    }

    if (eventosTurno.length > 0) {
        combate._turnoResuelto = true;
        io.to(`sala_${combate.salaId}`).emit('combate_eventos', {
            combateId: combate.combateId,
            eventos: eventosTurno,
            turno: combate.turno
        });
    }
}

/**
 * Registra una acción de un jugador en su turno (atacar o cambiar).
 */
function registrarAccionJugador(combateId, usuarioEmail, accion, io) {
    const combate = obtenerEstadoCombateActivo(combateId);
    if (!combate || combate.finalizado) {
        throw new Error('El combate no existe o ya ha finalizado');
    }

    const uEmailNorm = (usuarioEmail || '').toLowerCase().trim();
    const esP1 = combate.p1 && combate.p1.toLowerCase().trim() === uEmailNorm;
    const esP2 = combate.p2 && combate.p2.toLowerCase().trim() === uEmailNorm;

    if (!esP1 && !esP2) throw new Error('Usuario no pertenece a este combate');

    const jugadorId = esP1 ? 'p1' : 'p2';
    combate.elecciones[jugadorId] = accion; // ej: "move 1" o "switch 2"
    console.log(`[Combate] ${jugadorId} (${usuarioEmail}) eligió: "${accion}" para ${combate.combateId}`);

    // Notificar que este usuario ha elegido
    io.to(`sala_${combate.salaId}`).emit('combate_jugador_listo', {
        combateId: combate.combateId,
        jugador: jugadorId
    });

    // Si ambos han elegido, ejecutar la resolución
    if (combate.elecciones.p1 && combate.elecciones.p2) {
        ejecutarResolucionTurno(combate, io);
    }
}

function ejecutarResolucionTurno(combate, io) {
    const accionP1 = combate.elecciones.p1;
    const accionP2 = combate.elecciones.p2;

    combate.elecciones.p1 = null;
    combate.elecciones.p2 = null;
    combate._turnoResuelto = false;

    if (combate.stream) {
        try {
            console.log(`[Showdown] Escribiendo acciones: p1=${accionP1}, p2=${accionP2}`);
            combate.stream.write(`>p1 ${accionP1}\n>p2 ${accionP2}\n`);
        } catch (e) {
            console.error('Error escribiendo en stream de Showdown:', e);
        }
    }

    // Fallback asegurado: si Showdown no emite resultados en 800ms, resolver con motor 6v6 nativo
    setTimeout(() => {
        if (!combate._turnoResuelto && !combate.finalizado) {
            console.log(`[Combate] Resolviendo turno ${combate.turno} con motor 6v6 nativo`);
            simularTurno6v6(combate, accionP1, accionP2, io);
        }
    }, 800);
}

/**
 * Motor completo 6v6 nativo por turnos: turnos, cálculo de daño por stats,
 * debilitaciones, cambios de Pokémon vivos y condición de victoria.
 */
function simularTurno6v6(combate, accionP1, accionP2, io) {
    if (combate.finalizado) return;
    combate._turnoResuelto = true;

    const eventos = [];
    const p1Team = combate.p1Team;
    const p2Team = combate.p2Team;

    let p1Poke = p1Team[combate.p1Activo];
    let p2Poke = p2Team[combate.p2Activo];

    // 1. Procesar cambios manuales (switch) primero
    if (accionP1 && accionP1.startsWith('switch')) {
        const idx = Math.min(Math.max(0, (parseInt(accionP1.split(' ')[1]) || 1) - 1), p1Team.length - 1);
        if (!p1Team[idx].debilitado && p1Team[idx].hp > 0) {
            combate.p1Activo = idx;
            p1Poke = p1Team[idx];
            eventos.push({ tipo: 'switch', jugador: 'p1', pokemon: p1Poke.name });
        }
    }

    if (accionP2 && accionP2.startsWith('switch')) {
        const idx = Math.min(Math.max(0, (parseInt(accionP2.split(' ')[1]) || 1) - 1), p2Team.length - 1);
        if (!p2Team[idx].debilitado && p2Team[idx].hp > 0) {
            combate.p2Activo = idx;
            p2Poke = p2Team[idx];
            eventos.push({ tipo: 'switch', jugador: 'p2', pokemon: p2Poke.name });
        }
    }

    // 2. Determinar orden de ataque según velocidad
    const esAtaqueP1 = accionP1 && accionP1.startsWith('move');
    const esAtaqueP2 = accionP2 && accionP2.startsWith('move');

    const nivelP1 = p1Poke.level || 7;
    const nivelP2 = p2Poke.level || 7;

    const vel1 = nivelP1 * 2 + Math.floor(Math.random() * 10);
    const vel2 = nivelP2 * 2 + Math.floor(Math.random() * 10);

    const primero = vel1 >= vel2 ? 'p1' : 'p2';
    const segundo = primero === 'p1' ? 'p2' : 'p1';

    const orden = [
        { jugador: primero, ataca: primero === 'p1' ? esAtaqueP1 : esAtaqueP2, accion: primero === 'p1' ? accionP1 : accionP2 },
        { jugador: segundo, ataca: segundo === 'p1' ? esAtaqueP1 : esAtaqueP2, accion: segundo === 'p1' ? accionP1 : accionP2 }
    ];

    let combateTerminado = false;

    for (const turno of orden) {
        if (combateTerminado) break;
        if (!turno.ataca) continue;

        const esP1 = turno.jugador === 'p1';
        const atacante = esP1 ? p1Poke : p2Poke;
        const defensor = esP1 ? p2Poke : p1Poke;
        const defensorJugador = esP1 ? 'p2' : 'p1';
        const defensorTeam = esP1 ? p2Team : p1Team;

        if (atacante.debilitado || atacante.hp <= 0) continue;

        // Nombre del movimiento elegido
        const moveIdx = Math.min(Math.max(0, (parseInt(turno.accion.split(' ')[1]) || 1) - 1), (atacante.moves || []).length - 1);
        const nombreMovimiento = (atacante.moves && atacante.moves[moveIdx]) ? atacante.moves[moveIdx] : 'Ataque';

        eventos.push({ tipo: 'move', jugador: turno.jugador, movimiento: nombreMovimiento });

        // Cálculo de daño escalado por nivel y estadísticas
        const basePower = 50;
        const nivel = atacante.level || 7;
        const varianza = 0.85 + Math.random() * 0.15;
        const dmg = Math.max(8, Math.floor((((2 * nivel / 5 + 2) * basePower / 30) + 2) * varianza));

        defensor.hp = Math.max(0, defensor.hp - dmg);
        eventos.push({ tipo: 'damage', jugador: defensorJugador, hpActual: defensor.hp, hpTotal: defensor.maxHp });

        if (defensor.hp === 0) {
            defensor.debilitado = true;
            eventos.push({ tipo: 'faint', jugador: defensorJugador });

            // Buscar si le queda algún Pokémon vivo en su equipo de 6
            const vivoIdx = defensorTeam.findIndex(p => !p.debilitado && p.hp > 0);
            if (vivoIdx !== -1) {
                if (defensorJugador === 'p1') {
                    combate.p1Activo = vivoIdx;
                    p1Poke = p1Team[vivoIdx];
                } else {
                    combate.p2Activo = vivoIdx;
                    p2Poke = p2Team[vivoIdx];
                }
                eventos.push({ tipo: 'switch', jugador: defensorJugador, pokemon: defensorTeam[vivoIdx].name });
            } else {
                // ¡Todos los 6 Pokémon del rival se han debilitado! Fin de combate
                const ganador = esP1 ? combate.p1 : combate.p2;
                combate.finalizado = true;
                combate.ganador = ganador;
                eventos.push({ tipo: 'win', ganador: ganador });
                finalizarCombate(combate, ganador, io);
                combateTerminado = true;
            }
        }
    }

    combate.turno += 1;

    io.to(`sala_${combate.salaId}`).emit('combate_eventos', {
        combateId: combate.combateId,
        eventos,
        turno: combate.turno
    });
}

/**
 * Cierra el combate, guarda los puntos de liga y actualiza el calendario en MongoDB.
 */
async function finalizarCombate(combate, ganadorId, io) {
    try {
        const sala = await Sala.findOne({ identificador: combate.salaId });
        if (!sala) return;

        // Actualizar el partido en el calendario
        const jItem = sala.calendario.find(c => c.jornada === combate.jornada);
        if (jItem) {
            const partido = jItem.partidos.find(p =>
                (p.local === combate.p1 && p.visitante === combate.p2) ||
                (p.local === combate.p2 && p.visitante === combate.p1)
            );
            if (partido) {
                partido.estado = 'finalizado';
                partido.ganador = ganadorId;
                partido.detalles = `Finalizado por combate. Ganador: ${ganadorId}`;
            }
        }

        // Asignar puntos al ganador (+3 puntos de liga)
        if (ganadorId && ganadorId !== 'empate') {
            const eqGanador = sala.equipos_jugadores.find(e => e.usuario_id === ganadorId);
            if (eqGanador) {
                eqGanador.points = (eqGanador.points || 0) + 3;
            }
        }

        sala.markModified('calendario');
        sala.markModified('equipos_jugadores');
        await sala.save();

        io.to(`sala_${combate.salaId}`).emit('actualizacion_calendario', {
            identificador: combate.salaId,
            jornada: combate.jornada,
            ganador: ganadorId
        });

        combatesActivos.delete(combate.combateId);
        console.log(`✓ Combate ${combate.combateId} finalizado. Ganador: ${ganadorId}`);
    } catch (e) {
        console.error('Error al finalizar combate:', e);
    }
}

/**
 * Cierre automático a las 19:30 por incomparecencia (W.O.).
 */
async function procesarCierreIncomparecencia(io) {
    console.log('⏰ [19:30 Domingo] Procesando incomparecencias de combates...');
    try {
        const salas = await Sala.find({});
        for (const sala of salas) {
            if (!sala.calendario || sala.calendario.length === 0) continue;

            const jornadaActual = sala.jornada_actual || 1;
            const jornadaObj = sala.calendario.find(c => c.jornada === jornadaActual);
            if (!jornadaObj) continue;

            let huboCambios = false;

            for (const partido of jornadaObj.partidos) {
                if (partido.estado === 'pendiente') {
                    if (partido.listo_local && !partido.listo_visitante) {
                        // Victoria local por incomparecencia
                        partido.estado = 'finalizado';
                        partido.ganador = partido.local;
                        partido.detalles = 'Victoria por incomparecencia del rival (W.O.)';
                        const eq = sala.equipos_jugadores.find(e => e.usuario_id === partido.local);
                        if (eq) eq.points = (eq.points || 0) + 3;
                        huboCambios = true;
                    } else if (partido.listo_visitante && !partido.listo_local) {
                        // Victoria visitante por incomparecencia
                        partido.estado = 'finalizado';
                        partido.ganador = partido.visitante;
                        partido.detalles = 'Victoria por incomparecencia del rival (W.O.)';
                        const eq = sala.equipos_jugadores.find(e => e.usuario_id === partido.visitante);
                        if (eq) eq.points = (eq.points || 0) + 3;
                        huboCambios = true;
                    } else if (!partido.listo_local && !partido.listo_visitante) {
                        // Ninguno listo: no disputado
                        partido.estado = 'finalizado';
                        partido.ganador = 'ninguno';
                        partido.detalles = 'No presentado ninguno (0 puntos)';
                        huboCambios = true;
                    }
                }
            }

            // Comprobar si todos los partidos de la jornada terminaron para avanzar jornada
            const todosTerminados = jornadaObj.partidos.every(p => p.estado === 'finalizado');
            if (todosTerminados && jornadaActual < sala.calendario.length) {
                sala.jornada_actual += 1;
                console.log(`🏆 Sala ${sala.identificador} avanza a Jornada ${sala.jornada_actual}`);
                huboCambios = true;
            }

            if (huboCambios) {
                sala.markModified('calendario');
                sala.markModified('equipos_jugadores');
                await sala.save();
                if (io) {
                    io.to(`sala_${sala.identificador}`).emit('actualizacion_calendario', {
                        identificador: sala.identificador,
                        jornada_actual: sala.jornada_actual
                    });
                }
            }
        }
    } catch (e) {
        console.error('Error procesando incomparecencias:', e);
    }
}

function obtenerEstadoCombateActivo(combateId) {
    if (!combateId) return null;
    if (combatesActivos.has(combateId)) {
        return combatesActivos.get(combateId);
    }
    for (const [key, c] of combatesActivos.entries()) {
        if (key.includes(combateId) || combateId.includes(key)) {
            return c;
        }
    }
    return null;
}

/**
 * Reinicia los calendarios de las salas:
 * - Pone todos los enfrentamientos en 'pendiente'
 * - listo_local = false, listo_visitante = false
 * - ganador = null, detalles = ''
 * - jornada_actual = 1
 * - Opcionalmente regenera el calendario con Round-Robin si regenerar = true
 * - Limpia combatesActivos en memoria
 * - Emite actualizacion_calendario por WebSockets a todos los clientes
 */
async function reiniciarCalendariosDeSalas(salaId = null, regenerar = false, io = null) {
    const Sala = require('../models/Sala');
    let filtro = {};
    if (salaId) {
        filtro.identificador = parseInt(salaId);
    }

    const salas = await Sala.find(filtro);
    const resultados = [];

    for (const sala of salas) {
        sala.jornada_actual = 1;

        if (regenerar || !sala.calendario || sala.calendario.length === 0) {
            const participantes = (sala.equipos_jugadores || []).map(e => e.usuario_id).filter(Boolean);
            if (participantes.length >= 2) {
                await generarYGuardarCalendario(sala);
                resultados.push({
                    sala: sala.nombre,
                    id: sala.identificador,
                    accion: "Calendario regenerado desde cero con Round-Robin",
                    jornadas: sala.calendario ? sala.calendario.length : 0
                });
            } else {
                sala.calendario = [];
                sala.markModified('calendario');
                await sala.save();
                resultados.push({
                    sala: sala.nombre,
                    id: sala.identificador,
                    accion: "Menos de 2 jugadores: calendario reseteado a vacío",
                    jornadas: 0
                });
            }
        } else {
            let count = 0;
            for (const j of sala.calendario) {
                for (const p of j.partidos || []) {
                    const esDescanso = (p.local && p.local.includes('Descansa')) ||
                                       (p.visitante && p.visitante.includes('Descansa'));
                    if (esDescanso) {
                        p.estado = 'finalizado';
                        p.ganador = p.local.includes('Descansa') ? p.visitante : p.local;
                        p.detalles = 'Jornada de descanso';
                        p.listo_local = false;
                        p.listo_visitante = false;
                    } else {
                        p.estado = 'pendiente';
                        p.listo_local = false;
                        p.listo_visitante = false;
                        p.ganador = null;
                        p.detalles = '';
                        count++;
                    }
                }
            }
            sala.markModified('calendario');
            await sala.save();
            resultados.push({
                sala: sala.nombre,
                id: sala.identificador,
                accion: "Partidos reiniciados a 'pendiente' y desmarcados",
                partidos_reseteados: count
            });
        }
    }

    combatesActivos.clear();

    const socketIo = io || global.io;
    if (socketIo) {
        socketIo.emit('actualizacion_calendario', {
            motivo: 'reinicio_admin',
            timestamp: new Date().toISOString()
        });
        for (const s of salas) {
            socketIo.to(`sala_${s.identificador}`).emit('actualizacion_calendario', {
                identificador: s.identificador,
                jornada_actual: 1
            });
        }
    }

    return resultados;
}

module.exports = {
    esHorarioDeCombate,
    generarYGuardarCalendario,
    iniciarCombateEntreUsuarios,
    registrarAccionJugador,
    procesarCierreIncomparecencia,
    obtenerEstadoCombateActivo,
    generarEquipoTextoShowdown,
    combatesActivos,
    reiniciarCalendariosDeSalas
};

