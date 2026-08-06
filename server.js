import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const juegos = {
  TEST_A: JSON.parse(fs.readFileSync('./test_a_dictador.json', 'utf8')),
  TEST_B: JSON.parse(fs.readFileSync('./test_b_falso_zen.json', 'utf8')),
  TEST_C: JSON.parse(fs.readFileSync('./test_c_buda_punal.json', 'utf8')),
  TEST_D: JSON.parse(fs.readFileSync('./test_d_barrio.json', 'utf8'))
};

const salas = {};
const CODIGOS_SALA = ['RATA', 'FALS', 'TIBI', 'CHUS', 'CARE', 'GARR', 'VAGO', 'HUMO', 'ZORR'];

function generarCodigoSala() {
  const codigo = CODIGOS_SALA[Math.floor(Math.random() * CODIGOS_SALA.length)];
  const numero = Math.floor(100 + Math.random() * 900);
  return `${codigo}-${numero}`;
}

io.on('connection', (socket) => {
  console.log(`🔌 Usuario conectado: ${socket.id}`);

  // 🚀 AHORA RECIBE EL AVATAR
  socket.on('crear_sala', ({ nombreUsuario, avatar }) => {
    const codigoSala = generarCodigoSala();
    salas[codigoSala] = {
      codigo: codigoSala,
      anfitrion: socket.id,
      estado: 'LOBBY',
      testActivo: null,
      testSeleccionadoId: null, // Guarda la elección antes de arrancar
      jugadores: [{ id: socket.id, nombre: nombreUsuario, avatar, puntos: 0, esAnfitrion: true, pinocho: false }],
      preguntaActual: 0,
      respuestasRonda: {},
      cuestionamientos: {}
    };
    socket.join(codigoSala);
    socket.emit('sala_creada', { codigoSala, jugadores: salas[codigoSala].jugadores });
  });

  socket.on('unirse_sala', ({ codigoSala, nombreUsuario, avatar }) => {
    const sala = salas[codigoSala];
    if (!sala) return socket.emit('error_conexion', { mensaje: 'La sala no existe o venció.' });
    if (sala.estado !== 'LOBBY') return socket.emit('error_conexion', { mensaje: 'La partida ya empezó.' });

    sala.jugadores.push({ id: socket.id, nombre: nombreUsuario, avatar, puntos: 0, esAnfitrion: false, pinocho: false });
    socket.join(codigoSala);
    io.to(codigoSala).emit('actualizar_jugadores', { jugadores: sala.jugadores });
  });

  // 🚀 PASO INTERMEDIO: MOSTRAR REGLAS
  socket.on('preparar_juego', ({ codigoSala, idTest }) => {
    const sala = salas[codigoSala];
    if (sala && sala.anfitrion === socket.id) {
      sala.testSeleccionadoId = idTest;
      io.to(codigoSala).emit('pantalla_reglas');
    }
  });

  socket.on('iniciar_juego', ({ codigoSala }) => {
    const sala = salas[codigoSala];
    if (sala && sala.anfitrion === socket.id) {
      sala.testActivo = juegos[sala.testSeleccionadoId]; 
      sala.estado = 'PREGUNTA';
      sala.preguntaActual = 0;
      enviarPregunta(codigoSala);
    }
  });

  socket.on('enviar_respuesta', ({ codigoSala, idOpcion, prediccion }) => {
    const sala = salas[codigoSala];
    if (!sala) return;
    const preguntaObj = sala.testActivo.preguntas[sala.preguntaActual];
    const opcionElegida = preguntaObj.opciones.find(o => o.id_opcion === idOpcion);
    
    sala.respuestasRonda[socket.id] = { opcion: opcionElegida, prediccion: prediccion || null };

    if (Object.keys(sala.respuestasRonda).length === sala.jugadores.length) {
      procesarFinPregunta(codigoSala);
    }
  });

  socket.on('cuestionar_jugador', ({ codigoSala, idJugadorAcusado }) => {
    const sala = salas[codigoSala];
    if (!sala) return;
    if (!sala.cuestionamientos[idJugadorAcusado]) sala.cuestionamientos[idJugadorAcusado] = [];
    if (!sala.cuestionamientos[idJugadorAcusado].includes(socket.id)) sala.cuestionamientos[idJugadorAcusado].push(socket.id);
    io.to(codigoSala).emit('actualizar_cuestionamientos', { cuestionamientos: sala.cuestionamientos });
  });

  socket.on('votar_juicio', ({ codigoSala, idAcusado, voto }) => {
    const sala = salas[codigoSala];
    if (!sala) return;
    if (!sala.votosJuicio) sala.votosJuicio = { salvados: 0, mentiras: 0, total: 0 };

    if (voto === 'SALVADO') sala.votosJuicio.salvados++;
    if (voto === 'MINTIO') sala.votosJuicio.mentiras++;
    sala.votosJuicio.total++;

    if (sala.votosJuicio.total === sala.jugadores.length - 1) {
      const resultado = sala.votosJuicio.mentiras > sala.votosJuicio.salvados ? 'MINTIO' : 'SALVADO';
      const jugador = sala.jugadores.find(j => j.id === idAcusado);
      if (resultado === 'MINTIO' && jugador) {
        jugador.pinocho = true;
        jugador.puntos += 10;
      }
      io.to(codigoSala).emit('fin_juicio', { idAcusado, resultado, jugadores: sala.jugadores });
      sala.votosJuicio = null;
    }
  });

  socket.on('siguiente_pregunta', ({ codigoSala }) => {
    const sala = salas[codigoSala];
    if (!sala) return;
    sala.preguntaActual++;
    if (sala.preguntaActual < sala.testActivo.preguntas.length) {
      enviarPregunta(codigoSala);
    } else {
      io.to(codigoSala).emit('juego_terminado', { jugadores: sala.jugadores, testActivo: sala.testActivo });
    }
  });

  socket.on('disconnect', () => console.log(`❌ Usuario desconectado: ${socket.id}`));
});

function enviarPregunta(codigoSala) {
  const sala = salas[codigoSala];
  const preguntaFull = sala.testActivo.preguntas[sala.preguntaActual];
  const preguntaData = {
    numero: sala.preguntaActual + 1,
    total: sala.testActivo.preguntas.length,
    texto: preguntaFull.texto,
    opciones: preguntaFull.opciones.map(o => ({ id_opcion: o.id_opcion, texto: o.texto }))
  };
  sala.respuestasRonda = {};
  sala.cuestionamientos = {};
  io.to(codigoSala).emit('nueva_pregunta', { pregunta: preguntaData });
}

function procesarFinPregunta(codigoSala) {
  const sala = salas[codigoSala];
  const revelacionData = [];
  sala.jugadores.forEach(j => {
    const resp = sala.respuestasRonda[j.id];
    if (resp) {
      j.puntos += resp.opcion.puntos;
      if (resp.prediccion) {
        const respObjetivo = sala.respuestasRonda[resp.prediccion.jugadorObjetivoId];
        if (respObjetivo && respObjetivo.opcion.id_opcion === resp.prediccion.opcionAdivinadaId) {
          j.puntos = Math.max(0, j.puntos - 1); 
        }
      }
      revelacionData.push({ idJugador: j.id, nombreJugador: j.nombre, avatar: j.avatar, opcionElegida: resp.opcion, esTibia: resp.opcion.es_tibia });
    }
  });
  sala.estado = 'REVELACION';
  io.to(codigoSala).emit('mostrar_revelacion', { revelacion: revelacionData, jugadores: sala.jugadores });
}

const PORT = process.env.PORT || 4001;
server.listen(PORT, () => console.log(`🚀 Servidor SIN CARETA corriendo en puerto ${PORT}`));