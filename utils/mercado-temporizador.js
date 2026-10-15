const cron = require('node-cron');
const moment = require('moment');
const Sala = require('../models/Sala');
const Usuario = require('../models/Usuario');

const RANGOS_GENERACION = {
    'GEN 1': [[1, 151]], 'GEN 2': [[1, 251]], 'GEN 3': [[1, 386]],
    'GEN 4': [[1, 493]], 'GEN 5': [[1, 649]], 'GEN 6': [[1, 721]],
    'GEN 7': [[1, 809]], 'GEN 8': [[1, 905]], 'GEN 9': [[1, 1025]],
};

const LEGENDARIOS = new Set([144, 150, 151, 249, 250, 382, 383, 384, 483, 484, 487, 643, 644, 716, 717, 718]); // Simplificado para el ejemplo

function generarPokemonsAleatorios(generacion, cantidad = 6) {
    const rangos = RANGOS_GENERACION[generacion] || RANGOS_GENERACION['GEN 1'];
    const [min, max] = rangos[rangos.length - 1];
    const nuevos = [];

    for (let i = 0; i < cantidad; i++) {
        let id;
        do { id = Math.floor(Math.random() * (max - min + 1)) + min; } while (LEGENDARIOS.has(id));
        
        nuevos.push({
            id_pokemon: id,
            valor_base: 1000 + Math.floor(Math.random() * 4000),
            puja_actual_valor: 0,
            id_pujador: null,
            hora_cierre: '14:00',
            es_venta_equipo: false,
            id_vendedor: null,
            ofertas: []
        });
    }
    return nuevos;
}

/**
 * Función principal que procesa el fin del día
 */
async function procesarCierreDeSubastas(socketIO) {
    try {
        console.log(`⏰ [${moment().format('HH:mm:ss')}] Iniciando cierre de mercado...`);
        const salas = await Sala.find({});

        for (const sala of salas) {
            console.log(`Procesando Sala: ${sala.nombre}`);

            // 1. TRANSFERIR POKÉMONS A GANADORES
            for (const pokemonMercado of sala.mercado_disponible) {
                // Solo procesamos subastas normales con pujador
                if (!pokemonMercado.es_venta_equipo && pokemonMercado.id_pujador && pokemonMercado.id_pujador !== 'Nadie') {
                    
                    // Buscar al usuario por correo si está disponible, o por nombre como fallback
                    const usuario = pokemonMercado.correo_pujador 
                        ? await Usuario.findOne({ correo: pokemonMercado.correo_pujador })
                        : await Usuario.findOne({ nombre: pokemonMercado.id_pujador });
                    if (!usuario) continue;

                    const equipo = sala.equipos_jugadores.find(e => e.usuario_id === usuario.correo);
                    const precioFinal = Number(pokemonMercado.valor_base) + Number(pokemonMercado.puja_actual_valor);

                    if (equipo && equipo.saldo >= precioFinal) {
                        // Buscar posición libre 1-12
                        const ocupadas = equipo.pokemons.map(p => p.posicion);
                        let posLibre = -1;
                        for (let i = 1; i <= 12; i++) {
                            if (!ocupadas.includes(i)) { posLibre = i; break; }
                        }

                        if (posLibre !== -1) {
                            // Realizar la compra
                            equipo.saldo -= precioFinal;
                            equipo.pokemons.push({
                                id: pokemonMercado.id_pokemon,
                                precio_base: pokemonMercado.valor_base,
                                clausula: precioFinal, // Regla 1: se mantiene igual al precio pagado
                                posicion: posLibre,
                                fecha_adquisicion: new Date()
                            });
                            console.log(`✅ #${pokemonMercado.id_pokemon} adjudicado a ${usuario.nombre}`);
                        }
                    }
                }
            }

            // 2. LIMPIAR EL MERCADO (Borrar subastas, mantener ventas de usuarios si quieres)
            sala.mercado_disponible = sala.mercado_disponible.filter(p => p.es_venta_equipo === true);

            // 3. GENERAR NUEVOS POKÉMONS
            const nuevos = generarPokemonsAleatorios(sala.generacion || 'GEN 1', 6);
            sala.mercado_disponible.push(...nuevos);

            // 4. GUARDAR CAMBIOS
            sala.markModified('equipos_jugadores');
            sala.markModified('mercado_disponible');
            await sala.save();

            // 5. NOTIFICAR POR SOCKETS
            if (socketIO) {
                socketIO.emit('actualizacion_mercado', { identificador: sala.identificador });
                socketIO.emit('actualizacion_equipo', { identificador: sala.identificador });
            }
        }
        console.log("✅ Cierre de subastas y rotación de mercado completada.");
    } catch (error) {
        console.error("❌ Error en procesarCierreDeSubastas:", error);
    }
}

function inicializarTemporizadores(socketIO) {
    console.log('✓ Sistema de mercado activo');
    cron.schedule('0 14 * * *', () => procesarCierreDeSubastas(socketIO));
}

module.exports = {
    generarPokemonsAleatorios,
    inicializarTemporizadores,
    procesarCierreDeSubastas, // Esta es la que debes usar en tu ruta de debug
    detenerTemporizadores: () => console.log('⏹️ Stop')
};