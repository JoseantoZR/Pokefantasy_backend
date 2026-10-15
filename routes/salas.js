const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Sala = require('../models/Sala');
const Usuario = require('../models/Usuario');
const { generarPokemonsAleatorios } = require('../utils/mercado-temporizador');
 
/**
 * GET /salas
 * Obtiene todas las salas
 */
router.get('/', async (req, res) => {
    try {
        const salas = await Sala.find();
        res.json(salas);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
 
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

function generarCodigoSala() {
    const caracteres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codigo = '';
    for (let i = 0; i < 6; i++) {
        codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }
    return codigo;
}

async function generarIdentificadorUnico() {
    let codigo = '';
    let existe = true;
    while (existe) {
        codigo = generarCodigoSala();
        const salaExistente = await Sala.findOne({ identificador: codigo });
        if (!salaExistente) {
            existe = false;
        }
    }
    return codigo;
}

/**
 * GET /salas/:id
 * Obtiene una sala por su ID
 */
router.get('/:id', async (req, res) => {
    try {
        const idParam = req.params.id;
        const sala = await Sala.findOne(filtroSala(idParam));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });
        res.json(sala);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
 
/**
 * POST /salas
 * Crea una nueva sala con código alfanumérico de 6 caracteres
 */
router.post('/', async (req, res) => {
    const { creador_email, nombre_sala, ...datosSala } = req.body;
 
    if (!creador_email) {
        return res.status(400).json({ error: "El email del creador es obligatorio." });
    }
 
    try {
        // Generar un código aleatorio de 6 caracteres (números y letras mayúsculas)
        const nuevoIdentificador = await generarIdentificadorUnico();
 
        // Generar 6 Pokémon iniciales según la generación elegida
        const pokemonsIniciales = generarPokemonsAleatorios(datosSala.generacion || 'GEN 1', 6);

        const nuevaSala = new Sala({
            ...datosSala,
            nombre: nombre_sala,
            identificador: nuevoIdentificador,
            mercado_disponible: pokemonsIniciales,
            equipos_jugadores: [
                {
                    usuario_id: creador_email,
                    saldo: 10000,
                    points: 0,
                    pokemons: []
                }
            ]
        });
 
        await nuevaSala.save();
        console.log(`✓ Sala creada: ${nuevaSala.nombre} (ID: ${nuevaSala.identificador}) con ${pokemonsIniciales.length} Pokémon en mercado`);
        res.status(201).json(nuevaSala);
 
    } catch (error) {
        res.status(500).json({ error: "Error interno", detalles: error.message });
    }
});
 
/**
 * POST /salas/:id/pagar-clausula
 * Realiza el pago de cláusula (fichaje inmediato e indiscutible)
 * Se calcula posición libre en el comprador de forma segura y se retira del mercado si estaba en venta
 */
router.post('/:id/pagar-clausula', async (req, res) => {
    const { comprador, vendedor, id_pokemon, precio } = req.body;
    const salaId = req.params.id;

    try {
        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const equipoComprador = sala.equipos_jugadores.find(e => e.usuario_id === comprador);
        if (!equipoComprador) return res.status(404).json({ error: "Comprador no encontrado" });

        if (equipoComprador.saldo < precio) {
            return res.status(400).json({ error: "Saldo insuficiente" });
        }

        const equipoVendedor = sala.equipos_jugadores.find(e => e.usuario_id === vendedor);
        if (!equipoVendedor) return res.status(404).json({ error: "Vendedor no encontrado" });

        const pokemonIndex = equipoVendedor.pokemons.findIndex(p => p.id === id_pokemon);
        if (pokemonIndex === -1) return res.status(404).json({ error: "Pokémon no encontrado en el equipo del vendedor" });

        // Asignación atómica de posición libre en el comprador (1-6 titulares, o 7-12 reservas)
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
            return res.status(400).json({ error: "No tienes espacio disponible en tu plantilla (máximo 12 Pokémon)" });
        }

        const pokemon = equipoVendedor.pokemons[pokemonIndex];
        pokemon.posicion = nuevaPosicion;
        pokemon.fecha_adquisicion = new Date();
        // Cláusula se mantiene igual (Regla 1)

        equipoVendedor.pokemons.splice(pokemonIndex, 1);
        equipoComprador.pokemons.push(pokemon);

        equipoComprador.saldo -= precio;
        equipoVendedor.saldo += precio;

        // Si el Pokémon estaba puesto a la venta en el mercado, se retira de inmediato
        const mercadoIndex = sala.mercado_disponible.findIndex(
            p => p.id_pokemon === id_pokemon && p.id_vendedor === vendedor && p.es_venta_equipo === true
        );
        if (mercadoIndex !== -1) {
            sala.mercado_disponible.splice(mercadoIndex, 1);
            sala.markModified('mercado_disponible');
        }

        sala.markModified('equipos_jugadores');
        await sala.save();

        if (global.io) {
            global.io.emit('actualizacion_equipo', { identificador: salaId });
            global.io.emit('actualizacion_mercado', { identificador: salaId });
        }

        res.status(200).json({ 
            mensaje: "Pokémon comprado con éxito",
            posicion_asignada: nuevaPosicion
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
 
/**
 * PUT /salas/:identificador/pujar
 * Registra una nueva puja
 */
router.put('/:identificador/pujar', async (req, res) => {
    const { identificador } = req.params;
    const { id_pokemon, correo_usuario, cantidad } = req.body;
 
    try {
        // 1. Buscar el usuario
        const usuario = await Usuario.findOne({ correo: correo_usuario });
        if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
 
        // 2. Buscar la sala
        const sala = await Sala.findOne(filtroSala(identificador));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        // Comprobar que el usuario pertenece a la sala
        const equipoUsuario = sala.equipos_jugadores.find(e => e.usuario_id === correo_usuario);
        if (!equipoUsuario) return res.status(403).json({ error: "El usuario no pertenece a esta sala" });
 
        // 3. Buscar el pokémon en el mercado
        const pokemon = sala.mercado_disponible.find(p => p.id_pokemon === id_pokemon);
        if (!pokemon) return res.status(404).json({ error: "El Pokémon no está en el mercado" });

        if (pokemon.es_venta_equipo) {
            return res.status(400).json({ error: "Este Pokémon es una venta directa y solo acepta ofertas" });
        }

        const nuevoTotalPuja = pokemon.puja_actual_valor + cantidad;
        const precioTotal = pokemon.valor_base + nuevoTotalPuja;

        // Comprobar saldo suficiente
        if (equipoUsuario.saldo < precioTotal) {
            return res.status(400).json({ error: `Saldo insuficiente. Necesitas al menos ${precioTotal}$ para cubrir la puja.` });
        }
 
        // 4. Actualizar valores
        pokemon.puja_actual_valor = nuevoTotalPuja;
        pokemon.id_pujador = usuario.nombre;
        pokemon.correo_pujador = usuario.correo;
 
        sala.markModified('mercado_disponible');
        await sala.save();
 
        // 5. Emitir evento WebSocket
        if (global.io) {
            global.io.emit('actualizacion_mercado', {
                identificador: sala.identificador,
                id_pokemon: id_pokemon,
                nuevo_valor_puja: pokemon.puja_actual_valor,
                nombre_pujador: usuario.nombre
            });
        }
 
        res.json({ 
            mensaje: "Puja registrada con éxito",
            nuevo_pujador: usuario.nombre,
            nuevo_valor: pokemon.puja_actual_valor
        });
 
    } catch (error) {
        console.error("Error en puja:", error);
        res.status(500).json({ error: error.message });
    }
});
 
/**
 * POST /salas/:id/cambiar-posicion
 * Cambia la posición de un Pokémon en el equipo
 */
router.post('/:id/cambiar-posicion', async (req, res) => {
    try {
        const { usuario_id, id_pokemon, nueva_posicion } = req.body;
        const salaId = req.params.id;
        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });
        
        const equipo = sala.equipos_jugadores.find(e => e.usuario_id === usuario_id);
        if (!equipo) return res.status(404).json({ error: "Equipo no encontrado" });

        const pokemonMovido = equipo.pokemons.find(p => p.id === Number(id_pokemon));
        if (!pokemonMovido) return res.status(404).json({ error: "Pokémon no encontrado" });
        
        // Guardamos la posición que tenía antes de moverlo
        const posicionAntigua = pokemonMovido.posicion;

        // 1. Buscamos si hay un "Pokémon B" ocupando el lugar de destino
        const pokemonOcupante = equipo.pokemons.find(p => p.posicion === Number(nueva_posicion));

        if (pokemonOcupante) {
            // 2. INTERCAMBIO: El ocupante pasa a la posición vieja del movido
            pokemonOcupante.posicion = posicionAntigua;
        }

        // 3. El movido pasa a la nueva posición
        pokemonMovido.posicion = Number(nueva_posicion);

        sala.markModified('equipos_jugadores');
        await sala.save();

        if (global.io) {
            global.io.emit('actualizacion_equipo', { identificador: sala.identificador });
        }

        res.json({ success: true, mensaje: "Posiciones intercambiadas" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /salas/:id/subir-clausula
 * Sube la cláusula de un Pokémon manualmente
 * El usuario paga una 'inversion' de su saldo y la cláusula aumenta en inversion * 1.5
 */
router.post('/:id/subir-clausula', async (req, res) => {
    try {
        const { usuario_id, id_pokemon, inversion } = req.body;
        const salaId = req.params.id;

        if (!usuario_id || !id_pokemon || !inversion || inversion <= 0) {
            return res.status(400).json({ error: "Datos incompletos o monto inválido" });
        }

        const sala = await Sala.findOne(filtroSala(salaId));
        if (!sala) return res.status(404).json({ error: "Sala no encontrada" });

        const equipo = sala.equipos_jugadores.find(e => e.usuario_id === usuario_id);
        if (!equipo) return res.status(404).json({ error: "Equipo no encontrado" });

        const pokemon = equipo.pokemons.find(p => p.id === Number(id_pokemon));
        if (!pokemon) return res.status(404).json({ error: "Pokémon no encontrado en tu equipo" });

        const montoInversion = parseInt(inversion);
        if (equipo.saldo < montoInversion) {
            return res.status(400).json({ error: "Saldo insuficiente para aumentar la cláusula" });
        }

        const aumentoClausula = Math.floor(montoInversion * 1.5);
        equipo.saldo -= montoInversion;
        pokemon.clausula = (pokemon.clausula || pokemon.precio_base || 1000) + aumentoClausula;

        sala.markModified('equipos_jugadores');
        await sala.save();

        if (global.io) {
            global.io.emit('actualizacion_equipo', { identificador: sala.identificador });
            global.io.emit('actualizacion_mercado', { identificador: sala.identificador });
        }

        res.json({
            success: true,
            mensaje: `Cláusula aumentada en ${aumentoClausula}€ (Nueva cláusula: ${pokemon.clausula}€)`,
            nuevo_saldo: equipo.saldo,
            nueva_clausula: pokemon.clausula
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
 
//eliminar sala
router.delete('/:id', async (req, res) => {
  try {
    const sala = await Sala.findOneAndDelete(filtroSala(req.params.id));
    if (!sala) return res.status(404).json({ error: 'Sala no encontrada' });
    res.json({ mensaje: 'Sala eliminada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//unirse a sala
router.put('/unirse/:correo', async (req, res) => {
    const { correo } = req.params;
    const { id_sala } = req.body;

    try {
        // 1. Buscamos la sala
        const sala = await Sala.findOne(filtroSala(id_sala));
        if (!sala) return res.status(404).json({ error: "La sala no existe" });

        // 2. Comprobamos si el usuario ya está en la sala para no duplicarlo
        const yaEnSala = sala.equipos_jugadores.some(e => e.usuario_id === correo);
        
        if (!yaEnSala) {
            // 3. AGREGAR AL USUARIO A LA SALA (equipos_jugadores)
            const nuevoEquipo = {
                usuario_id: correo,
                saldo: 10000, // Saldo inicial
                points: 0,
                pokemons: []
            };
            
            await Sala.updateOne(
                { identificador: sala.identificador },
                { $push: { equipos_jugadores: nuevoEquipo } }
            );
        }

        // 4. AGREGAR LA SALA AL USUARIO (id_salas_unidas)
        // Usamos $addToSet para evitar duplicados si el usuario pulsa varias veces
        const usuarioActualizado = await Usuario.findOneAndUpdate(
            { correo: correo },
            { $addToSet: { id_salas_unidas: sala.identificador } },
            { new: true }
        );

        if (!usuarioActualizado) return res.status(404).json({ error: "Usuario no encontrado" });

        res.json(usuarioActualizado);

    } catch (error) {
        console.error("Error al unirse a sala:", error);
        res.status(500).json({ error: error.message });
    }
});
module.exports = router;