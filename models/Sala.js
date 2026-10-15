const mongoose = require('mongoose');
 
const SalaSchema = new mongoose.Schema({
    nombre: String,
    generacion: String,
    fecha_inicio: String,
    mercado_disponible: [{
        _id: false, 
        id_pokemon: Number,
        valor_base: Number,
        puja_actual_valor: { type: Number, default: 0 },
        id_pujador: { type: String, default: null },
        correo_pujador: { type: String, default: null },
        // NUEVOS CAMPOS PARA OFERTAS Y VENTA
        hora_cierre: { type: String, default: "14:00" },
        es_venta_equipo: { type: Boolean, default: false },
        id_vendedor: { type: String, default: null },
        ofertas: [{
            _id: false,
            id_usuario: String,
            monto: Number,
            fecha_oferta: { type: Date, default: Date.now },
            estado: { type: String, enum: ['pendiente', 'aceptada', 'rechazada'], default: 'pendiente' }
        }]
    }],
    equipos_jugadores: [{
        _id: false, 
        usuario_id: String,
        nick_showdown: { type: String, default: '' },
        saldo: Number,
        points: { type: Number, default: 0 },
        pokemons: [{
            _id: false, 
            id: Number,
            precio_base: Number,
            clausula: Number,
            posicion: Number,
            fecha_adquisicion: { type: Date, default: Date.now }
        }]
    }],
    jornada_actual: { type: Number, default: 1 },
    calendario: [{
        _id: false,
        jornada: Number,
        partidos: [{
            _id: false,
            local: String,
            visitante: String,
            listo_local: { type: Boolean, default: false },
            listo_visitante: { type: Boolean, default: false },
            ganador: { type: String, default: null },
            estado: { type: String, enum: ['pendiente', 'en_curso', 'finalizado'], default: 'pendiente' },
            detalles: { type: String, default: '' }
        }]
    }],
    identificador: { type: mongoose.Schema.Types.Mixed, required: true, unique: true }
}, { collection: 'salas', versionKey: false });


 
module.exports = mongoose.model('Sala', SalaSchema);