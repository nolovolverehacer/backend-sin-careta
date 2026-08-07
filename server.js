const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// IMPORTANTE: Asegurate de que el nombre coincida con tu archivo de preguntas
const TESTS = require('./tests.json'); 

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const salas = {};

function generarCodigo() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Esta es la función que mezcla las opciones para que no se las memoricen
function mezclarArreglo(array) {
  let nuevo = [...array];
  for (let i = nuevo.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nuevo[i], nuevo[j]] = [nuevo[j], nuevo[i]];
  }
  return nuevo;
}

io.on('connection', (socket) => {
  // 1. Crear Sala
  socket.on('crear_sala', (data) => {
    const codigo = generarCodigo();
    salas[codigo] = {
      codigo: codigo,
      jugadores: [{ id: socket.id, nombre: data.nombreUsuario, avatar: data.avatar, puntos: 0, esAnfitrion: true }],
      testActivo: null,
      preguntas: [],
      preguntaActualIndice: 0,
      respuestasRonda: [],
      cuestionamientos: {},
      votosJuicio: {}
    };
    socket.join(codigo);
    socket.emit('sala_creada', { codigoSala: codigo, jugadores: salas[codigo].jugadores });
  });

  // 2. Unirse Sala
  socket.on('unirse_sala', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return socket.emit('error_conexion', { mensaje: 'Sala no encontrada' });
    sala.jugadores.push({ id: socket.id, nombre: data.nombreUsuario, avatar: data.avatar, puntos: 0, esAnfitrion: false });
    socket.join(data.codigoSala);
    io.to(data.codigoSala).emit('actualizar_jugadores', { jugadores: sala.jugadores });
  });

  // 3. Preparar Juego (Acá dividimos Parte 1 y Parte 2)
  socket.on('preparar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    
    let testSeleccionado = TESTS.find(t => t.id_test === data.idTest);
    sala.testActivo = testSeleccionado;

    // Si desde el Frontend nos piden la Parte 2, recortamos de la 15 a la 30.
    // Si no, recortamos de la 0 a la 15 (Parte 1).
    if (data.parte === 2) {
      sala.preguntas = testSeleccionado.preguntas.slice(15, 30);
    } else {
      sala.preguntas = testSeleccionado.preguntas.slice(0, 15);
    }

    io.to(data.codigoSala).emit('pantalla_reglas');
  });

  // 4. Iniciar / Siguiente Pregunta
  const enviarNuevaPregunta = (codigoSala) => {
    const sala = salas[codigoSala];
    sala.respuestasRonda = [];
    sala.cuestionamientos = {};
    sala.votosJuicio = {};

    // Si llegamos al final de la parte (15 preguntas), termina el juego
    if (sala.preguntaActualIndice >= sala.preguntas.length) {
       return io.to(codigoSala).emit('juego_terminado', { jugadores: sala.jugadores, testActivo: sala.testActivo });
    }

    let preguntaCruda = sala.preguntas[sala.preguntaActualIndice];

    // ACÁ SE MEZCLAN LAS OPCIONES: Todos ven las mismas opciones pero en distinto orden cada vez que juegan
    let preguntaLista = {
        ...preguntaCruda,
        opciones: mezclarArreglo(preguntaCruda.opciones),
        numero: sala.preguntaActualIndice + 1,
        total: sala.preguntas.length
    };

    io.to(codigoSala).emit('nueva_pregunta', { pregunta: preguntaLista });
  };

  socket.on('iniciar_juego', (data) => enviarNuevaPregunta(data.codigoSala));
  
  socket.on('siguiente_pregunta', (data) => {
      salas[data.codigoSala].preguntaActualIndice++;
      enviarNuevaPregunta(data.codigoSala);
  });

  // 5. Recibir Respuestas y Procesar Matemáticas Tóxicas
  socket.on('enviar_respuesta', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;

    sala.respuestasRonda.push({
        idJugador: socket.id,
        idOpcion: data.idOpcion,
        prediccion: data.prediccion
    });

    if (sala.respuestasRonda.length === sala.jugadores.length) {
        let revelacion = [];
        let preguntaActual = sala.preguntas[sala.preguntaActualIndice];
        let totalTibios = 0;

        sala.respuestasRonda.forEach(res => {
            let jugador = sala.jugadores.find(j => j.id === res.idJugador);
            let opcion = preguntaActual.opciones.find(o => o.id_opcion === res.idOpcion);

            jugador.puntos += opcion.puntos;
            if(opcion.es_tibia) totalTibios++;

            revelacion.push({
                idJugador: jugador.id,
                nombreJugador: jugador.nombre,
                avatar: jugador.avatar,
                opcionElegida: opcion,
                esTibia: opcion.es_tibia
            });
        });

        // MESA DE COBARDES
        let multiplicadorTibio = (totalTibios > sala.jugadores.length / 2) ? 2 : 1;
        if (multiplicadorTibio === 2) {
            sala.respuestasRonda.forEach(res => {
                let opcion = preguntaActual.opciones.find(o => o.id_opcion === res.idOpcion);
                if(opcion.es_tibia) {
                    let jugador = sala.jugadores.find(j => j.id === res.idJugador);
                    jugador.puntos += opcion.puntos; 
                }
            });
        }

        // VOTO TRAIDOR (Robar puntos)
        sala.respuestasRonda.forEach(res => {
            if (res.prediccion) {
                let respuestaObjetivo = sala.respuestasRonda.find(r => r.idJugador === res.prediccion.jugadorObjetivoId);
                if (respuestaObjetivo && respuestaObjetivo.idOpcion === res.prediccion.opcionAdivinadaId) {
                    let adivinador = sala.jugadores.find(j => j.id === res.idJugador);
                    let victima = sala.jugadores.find(j => j.id === res.prediccion.jugadorObjetivoId);

                    adivinador.puntos = Math.max(0, adivinador.puntos - 2);
                    victima.puntos += 2;
                }
            }
        });

        io.to(data.codigoSala).emit('mostrar_revelacion', { revelacion, jugadores: sala.jugadores });
    }
  });

  // 6. Botón Mentira (Bala de Plata)
  socket.on('cuestionar_jugador', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    
    sala.cuestionamientos[data.idJugadorAcusado] = sala.cuestionamientos[data.idJugadorAcusado] || [];
    sala.cuestionamientos[data.idJugadorAcusado].push(socket.id);

    io.to(data.codigoSala).emit('actualizar_cuestionamientos', { cuestionamientos: sala.cuestionamientos });
  });

  // 7. Votación del Tribunal y Falsas Denuncias
  socket.on('votar_juicio', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;

    sala.votosJuicio[socket.id] = data.voto;

    if (Object.keys(sala.votosJuicio).length === sala.jugadores.length - 1) {
        let votosCulpable = 0;
        let votosInocente = 0;

        Object.values(sala.votosJuicio).forEach(v => {
            if (v === 'MINTIO') votosCulpable++;
            else votosInocente++;
        });

        let resultado = votosCulpable > votosInocente ? 'MINTIO' : 'SALVADO';

        if (resultado === 'MINTIO') {
            let acusado = sala.jugadores.find(j => j.id === data.idAcusado);
            acusado.puntos += 10;
            acusado.pinocho = true;
        } else {
            let acusadoresIds = sala.cuestionamientos[data.idAcusado] || [];
            acusadoresIds.forEach(idAcusador => {
                let acusador = sala.jugadores.find(j => j.id === idAcusador);
                if (acusador) acusador.puntos += 5;
            });
        }

        io.to(data.codigoSala).emit('fin_juicio', { resultado, jugadores: sala.jugadores });
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Servidor de toxicidad activo en puerto ${PORT}`));
