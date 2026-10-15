const mongoose = require('mongoose');

const UsuarioSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    correo: { type: String, required: true, unique: true },
    contrasena: { type: String, required: true },
    icono: String,
    id_salas_unidas: [mongoose.Schema.Types.Mixed] 
}, { collection: 'usuarios' });

module.exports = mongoose.model('Usuario', UsuarioSchema);