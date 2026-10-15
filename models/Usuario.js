const mongoose = require('mongoose');

const UsuarioSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    correo: { type: String, required: true, unique: true },
    contrasena: { type: String, required: true },
    icono: String,
    id_salas_unidas: [Number] 
}, { collection: 'usuarios' });

module.exports = mongoose.model('Usuario', UsuarioSchema);