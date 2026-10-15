const express = require('express');
const router = express.Router();
const Sala = require('../models/Sala');

/**
 * POST /salas/:id/vender-pokemon
 * Pone un Pokémon del equipo del usuario a la venta en el mercado
 * El Pokémon PERMANECE en el equipo del jugador hasta que se acepte una oferta o se pague la cláusula
 */
router.post('/:id/vender-pokemon', async (req, res) => {
    try {
        const { usuario_vendedor, id_pokemon, precio_base } = req.body;
        const salaId = parseInt(req.params.id);

        // Validaciones
        if (!usuario_vendedor || !id_pokemon || !precio_base) {
            return res.status(400).json({ error: 'Datos incompletos' });
        }

        // Obtener la sala
        const sala = await Sala.findOne({ identificador: salaId });
        if (!sala) {
            return res.status(404).json({ error: 'Sala no encontrada' });
        }

        // Encontrar el equipo del vendedor
        const equipoVendedor = sala.equipos_jugadores.find(eq => eq.usuario_id === usuario_vendedor);
        if (!equipoVendedor) {
            return res.status(404).json({ error: 'Usuario no encontrado en la sala' });
        }

        // Verificar que el Pokémon existe en el equipo
        const pokemonEnEquipo = equipoVendedor.pokemons.find(p => p.id === id_pokemon);
        if (!pokemonEnEquipo) {
            return res.status(400).json({ error: 'Pokémon no encontrado en el equipo' });
        }

        // Verificar si ya está a la venta
        const yaEnVenta = sala.mercado_disponible.some(
            p => p.id_pokemon === id_pokemon && p.id_vendedor === usuario_vendedor && p.es_venta_equipo === true
        );
        if (yaEnVenta) {
            return res.status(400).json({ error: 'Este Pokémon ya está puesto a la venta en el mercado' });
        }

        // Crear entrada en el mercado (es_venta_equipo = true)
        const entradaMercado = {
            id_pokemon: id_pokemon,
            valor_base: precio_base,
            puja_actual_valor: 0,
            id_pujador: null,
            correo_pujador: null,
            hora_cierre: "14:00",
            es_venta_equipo: true,
            id_vendedor: usuario_vendedor,
            ofertas: []
        };

        // Agregar al mercado (el Pokémon sigue estando en su equipo)
        sala.mercado_disponible.push(entradaMercado);

        sala.markModified('mercado_disponible');
        await sala.save();

        // Emitir actualización vía WebSocket
        if (global.io) {
            global.io.emit('actualizacion_mercado', {
                identificador: salaId,
                evento: 'pokemon_vendido',
                id_pokemon: id_pokemon,
                timestamp: new Date().toISOString()
            });
            global.io.emit('actualizacion_equipo', { identificador: salaId });
        }

        res.json({
            success: true,
            message: `Pokémon #${id_pokemon} puesto a la venta (permanece en tu equipo hasta ser vendido)`,
            pokemon_id: id_pokemon
        });

    } catch (error) {
        console.error('Error vendiendo Pokémon:', error);
        res.status(500).json({ error: 'Error al poner a la venta el Pokémon' });
    }
});

/**
 * POST /salas/:id/cancelar-venta
 * Cancela la venta de un Pokémon en el mercado
 * Como el Pokémon nunca salió del equipo, solo se retira del mercado
 */
router.post('/:id/cancelar-venta', async (req, res) => {
    try {
        const { id_pokemon, usuario_vendedor } = req.body;
        const salaId = parseInt(req.params.id);

        if (!id_pokemon || !usuario_vendedor) {
            return res.status(400).json({ error: 'Datos incompletos' });
        }

        const sala = await Sala.findOne({ identificador: salaId });
        if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });

        const mercadoIndex = sala.mercado_disponible.findIndex(
            p => p.id_pokemon === id_pokemon && p.id_vendedor === usuario_vendedor && p.es_venta_equipo === true
        );

        if (mercadoIndex === -1) {
            return res.status(404).json({ error: 'El Pokémon no está a la venta por este usuario' });
        }

        // Retirar de mercado disponible
        sala.mercado_disponible.splice(mercadoIndex, 1);

        sala.markModified('mercado_disponible');
        await sala.save();

        if (global.io) {
            global.io.emit('actualizacion_mercado', { identificador: salaId });
            global.io.emit('actualizacion_equipo', { identificador: salaId });
        }

        res.json({
            success: true,
            message: 'Venta cancelada y Pokémon retirado del mercado'
        });

    } catch (error) {
        console.error('Error cancelando venta:', error);
        res.status(500).json({ error: 'Error al cancelar la venta' });
    }
});

/**
 * POST /salas/:id/hacer-oferta
 * Realiza una oferta sobre un Pokémon vendido
 * Un usuario solo puede tener UNA oferta por Pokémon
 */
router.post('/:id/hacer-oferta', async (req, res) => {
    try {
        const { id_pokemon, id_comprador, monto } = req.body;
        const salaId = parseInt(req.params.id);

        // Validaciones
        if (!id_pokemon || !id_comprador || !monto || monto <= 0) {
            return res.status(400).json({ error: 'Datos de oferta inválidos' });
        }

        // Obtener la sala
        const sala = await Sala.findOne({ identificador: salaId });
        if (!sala) {
            return res.status(404).json({ error: 'Sala no encontrada' });
        }

        // Encontrar el Pokémon en el mercado
        const mercadoIndex = sala.mercado_disponible.findIndex(p => p.id_pokemon === id_pokemon);
        if (mercadoIndex === -1) {
            return res.status(404).json({ error: 'Pokémon no encontrado en mercado' });
        }

        const pokemon = sala.mercado_disponible[mercadoIndex];

        // Validar que es una venta de equipo
        if (!pokemon.es_venta_equipo) {
            return res.status(400).json({ error: 'Solo se pueden hacer ofertas en Pokémon vendidos' });
        }

        // Validar saldo del comprador
        const equipoComprador = sala.equipos_jugadores.find(eq => eq.usuario_id === id_comprador);
        if (!equipoComprador) {
            return res.status(404).json({ error: 'Comprador no encontrado en sala' });
        }

        if (equipoComprador.saldo < monto) {
            return res.status(400).json({ error: 'Saldo insuficiente para realizar la oferta' });
        }

        // Crear nueva oferta
        const nuevaOferta = {
            id_usuario: id_comprador,
            monto: monto,
            fecha_oferta: new Date(),
            estado: "pendiente"
        };

        // Buscar y reemplazar oferta existente del mismo usuario
        const ofertaExistente = pokemon.ofertas.findIndex(o => o.id_usuario === id_comprador);

        if (ofertaExistente !== -1) {
            // Reemplazar oferta existente
            pokemon.ofertas[ofertaExistente] = nuevaOferta;
        } else {
            // Agregar nueva oferta
            pokemon.ofertas.push(nuevaOferta);
        }

        sala.markModified('mercado_disponible');
        await sala.save();

        // Emitir actualización vía WebSocket
        if (global.io) {
            global.io.emit('actualizacion_mercado', {
                identificador: salaId,
                evento: 'nueva_oferta',
                id_pokemon: id_pokemon,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            success: true,
            message: 'Oferta registrada',
            oferta: nuevaOferta
        });

    } catch (error) {
        console.error('Error haciendo oferta:', error);
        res.status(500).json({ error: 'Error al registrar la oferta' });
    }
});

/**
 * POST /salas/:id/aceptar-oferta
 * Acepta una oferta y transfiere el Pokémon al comprador
 * Solo el vendedor puede aceptar
 */
router.post('/:id/aceptar-oferta', async (req, res) => {
    try {
        const { id_pokemon, comprador, vendedor, monto } = req.body;
        const salaId = parseInt(req.params.id);
        if (!id_pokemon || !comprador || !vendedor || !monto) {
            return res.status(400).json({ error: 'Datos incompletos' });
        }
        const sala = await Sala.findOne({ identificador: salaId });
        if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });
        
        const mercadoIndex = sala.mercado_disponible.findIndex(p => p.id_pokemon === id_pokemon);
        if (mercadoIndex === -1) return res.status(404).json({ error: 'Pokémon no encontrado en el mercado' });
        const pokemon = sala.mercado_disponible[mercadoIndex];
        if (pokemon.id_vendedor !== vendedor) return res.status(403).json({ error: 'No eres el vendedor' });
        
        const equipoComprador = sala.equipos_jugadores.find(eq => eq.usuario_id === comprador);
        const equipoVendedor = sala.equipos_jugadores.find(eq => eq.usuario_id === vendedor);
        if (!equipoComprador || !equipoVendedor) {
            return res.status(404).json({ error: 'Equipos no encontrados' });
        }

        // Verificar que el Pokémon sigue en el equipo del vendedor
        const pokeVendedorIdx = equipoVendedor.pokemons.findIndex(p => p.id === id_pokemon);
        if (pokeVendedorIdx === -1) {
            sala.mercado_disponible.splice(mercadoIndex, 1);
            sala.markModified('mercado_disponible');
            await sala.save();
            return res.status(400).json({ error: 'El vendedor ya no posee este Pokémon en su equipo' });
        }

        // Validar saldo del comprador
        if (equipoComprador.saldo < monto) {
            return res.status(400).json({ error: 'El comprador ya no tiene saldo suficiente para completar la compra' });
        }

        // --- ASIGNACIÓN DE POSICIÓN: TITULARES (1-6) Y RESERVA (7-12) ---
        const posicionesOcupadas = equipoComprador.pokemons.map(p => p.posicion);
        let nuevaPosicion = -1;
        for (let i = 1; i <= 6; i++) {
            if (!posicionesOcupadas.includes(i)) {
                nuevaPosicion = i;
                break;
            }
        }
        if (nuevaPosicion === -1) {
            for (let i = 7; i <= 12; i++) {
                if (!posicionesOcupadas.includes(i)) {
                    nuevaPosicion = i;
                    break;
                }
            }
        }
        if (nuevaPosicion === -1) {
            return res.status(400).json({ error: 'El comprador no tiene espacio disponible (máximo 12 Pokémon)' });
        }

        // Retirar del equipo del vendedor
        equipoVendedor.pokemons.splice(pokeVendedorIdx, 1);

        // Añadir al equipo del comprador
        const nuevoPokemon = {
            id: id_pokemon,
            precio_base: pokemon.valor_base,
            clausula: monto, // La oferta aceptada se convierte en la nueva cláusula
            posicion: nuevaPosicion,
            fecha_adquisicion: new Date()
        };
        equipoComprador.pokemons.push(nuevoPokemon);

        // Actualizar saldos
        equipoComprador.saldo -= monto;
        equipoVendedor.saldo += monto;

        // Retirar del mercado
        sala.mercado_disponible.splice(mercadoIndex, 1);

        sala.markModified('equipos_jugadores');
        sala.markModified('mercado_disponible');
        await sala.save();

        // --- EMITIR WEBSOCKETS ---
        if (global.io) {
            global.io.emit('actualizacion_mercado', { identificador: salaId });
            global.io.emit('actualizacion_equipo', { identificador: salaId });
        }

        res.json({
            success: true,
            message: 'Oferta aceptada y Pokémon transferido',
            posicion_asignada: nuevaPosicion
        });
    } catch (error) {
        console.error('Error aceptando oferta:', error);
        res.status(500).json({ error: 'Error al aceptar la oferta' });
    }
});

/**
 * POST /salas/:id/rechazar-oferta
 * Rechaza una oferta
 */
router.post('/:id/rechazar-oferta', async (req, res) => {
    try {
        const { id_pokemon, id_comprador } = req.body;
        const salaId = parseInt(req.params.id);

        if (!id_pokemon || !id_comprador) {
            return res.status(400).json({ error: 'Datos incompletos' });
        }

        // Obtener la sala
        const sala = await Sala.findOne({ identificador: salaId });
        if (!sala) {
            return res.status(404).json({ error: 'Sala no encontrada' });
        }

        // Encontrar el Pokémon en el mercado
        const mercadoIndex = sala.mercado_disponible.findIndex(p => p.id_pokemon === id_pokemon);
        if (mercadoIndex === -1) {
            return res.status(404).json({ error: 'Pokémon no encontrado' });
        }

        // Remover la oferta del usuario
        const pokemon = sala.mercado_disponible[mercadoIndex];
        const ofertaIndex = pokemon.ofertas.findIndex(o => o.id_usuario === id_comprador);

        if (ofertaIndex === -1) {
            return res.status(404).json({ error: 'Oferta no encontrada' });
        }

        pokemon.ofertas.splice(ofertaIndex, 1);

        sala.markModified('mercado_disponible');
        await sala.save();

        res.json({
            success: true,
            message: 'Oferta rechazada'
        });

    } catch (error) {
        console.error('Error rechazando oferta:', error);
        res.status(500).json({ error: 'Error al rechazar la oferta' });
    }
});

module.exports = router;