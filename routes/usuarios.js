const express = require('express');
const router = express.Router();
const Usuario = require('../models/Usuario');
const Sala = require('../models/Sala'); 
/**
 * POST /usuarios/registro
 * Registra un nuevo usuario
 */
router.post('/registro', async (req, res) => {
    try {
        const nuevoUsuario = new Usuario(req.body);
        await nuevoUsuario.save();
        res.status(201).json(nuevoUsuario);
    } catch (error) {
        res.status(400).json({ 
            error: "Error al registrar: el correo ya existe o faltan datos.",
            detalles: error.message 
        });
    }
});
 
/**
 * POST /usuarios/login
 * Autentica un usuario
 */
router.post('/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    try {
        const usuario = await Usuario.findOne({ correo, contrasena });
        if (usuario) {
            res.json(usuario);
        } else {
            res.status(401).json({ error: "Credenciales incorrectas" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
 
/**
 * PUT /usuarios/:correo/unirse
 * Permite que un usuario se una a una sala
 */
router.put('/:correo/unirse', async (req, res) => {
    const { correo } = req.params;
    const { id_sala } = req.body;

    try {
        if (!id_sala) {
            return res.status(400).json({ error: "ID de sala requerido" });
        }

        // 1. Buscamos la sala primero para verificar que existe
        const sala = await Sala.findOne({ identificador: parseInt(id_sala) });
        if (!sala) {
            return res.status(404).json({ error: "La sala con ese ID no existe" });
        }

        // 2. Verificamos si el usuario ya está en el equipo de esa sala para no duplicar
        const yaTieneEquipo = sala.equipos_jugadores.some(e => e.usuario_id === correo);

        if (!yaTieneEquipo) {
            // Creamos el objeto del nuevo equipo siguiendo tu esquema
            const nuevoEquipo = {
                usuario_id: correo,
                saldo: 10000,
                points: 0,
                pokemons: []
            };

            // ACTUALIZAMOS LA SALA: Añadimos el equipo al array equipos_jugadores
            await Sala.updateOne(
                { identificador: parseInt(id_sala) },
                { $push: { equipos_jugadores: nuevoEquipo } }
            );
            console.log(`+ Usuario ${correo} añadido a la sala ${id_sala}`);
        }

        // 3. ACTUALIZAMOS EL USUARIO: Añadimos el ID de la sala a su lista personal
        const usuario = await Usuario.findOneAndUpdate(
            { correo: correo },
            { $addToSet: { id_salas_unidas: parseInt(id_sala) } },
            { new: true }
        );

        if (!usuario) {
            return res.status(404).json({ error: "Usuario no encontrado" });
        }

        // Devolvemos el usuario actualizado a Android
        res.json(usuario);

    } catch (error) {
        console.error("Error en unirse sala:", error);
        res.status(500).json({ error: error.message });
    }
});


//lista de todos los usuarios

router.get('/', async (req, res) => {
  try {
    const usuarios = await Usuario.find();
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
 
//editar usuarios por correo
router.put('/:correo', async (req, res) => {
  try {
    const usuario = await Usuario.findOneAndUpdate(
      { correo: req.params.correo },
      { $set: req.body },
      { new: true }
    );
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(usuario);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//eliminar usuario
router.delete('/:correo', async (req, res) => {
  try {
    const resultado = await Usuario.findOneAndDelete({ correo: req.params.correo });
    if (!resultado) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ mensaje: 'Usuario eliminado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;