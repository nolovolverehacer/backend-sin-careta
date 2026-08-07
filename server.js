const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const TESTS = require('./tests.json'); 
const FUEGO_CRUZADO = require('./fuego_cruzado.json'); 

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const salas = {};

function generarCodigo() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function mezclarArreglo(array) {
  let nuevo = [...array];
  for (let i = nuevo.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nuevo[i], nuevo[j]] = [nuevo[j], nuevo[i]];
  }
  return nuevo;
}

// Función para repartir medallas de forma dinámica según el largo de la partida
function asignarMedallas(jugadores, totalPreguntas) {
  jugadores.forEach(j => {
    // Calculamos qué porcentaje de tibieza tuvo respecto a la cantidad total de preguntas
    let porcentajeTibio = j.estadisticas.tibias / totalPreguntas;

    if (j.pinocho) {
      j.medalla = "🤥 PINOCHO DEL GRUPO (Atrapado mintiendo)";
    } else if (porcentajeTibio >= 0.2) { 
      // Si fue tibio en el 20% o más de las preguntas jugadas
      j.medalla = "🐔 REY DE LOS TIBIOS (No se la juega nunca)";
    } else if (j.estadisticas.escrachadoFC >= 1) {
      j.medalla = "🎯 BLANCO FÁCIL (Destrozado por el grupo)";
    } else if (j.estadisticas.aciertosTraidor >= 2) {
      j.medalla = "👁️ MENTALISTA TÓXICO (Lee mentes y roba puntos)";
    } else if (j.estadisticas.falsasDenuncias >= 1) {
      j.medalla = "🤡 DENUNCIANTE TRUCHO (Acusa sin tener pruebas)";
    } else if (j.puntos === 0) {
      j.medalla = "😇 FALSO SANTO (Demasiado perfecto para ser real)";
    } else {
      j.medalla = "🎭 CÓMPLICE SILENCIOSO (Pasó desapercibido)";
    }
  });
}

io.on('connection', (socket) => {
  
  socket.on('crear_sala', (data) => {
    const codigo = generarCodigo();
    salas[codigo] = {
      codigo: codigo,
      jugadores: [{ 
        id: socket.id, nombre: data.nombreUsuario, avatar: data.avatar, puntos: 0, esAnfitrion: true, pinocho: false, medalla: '',
        estadisticas: { tibias: 0, falsasDenuncias: 0, escrachadoFC: 0, aciertosTraidor: 0 } 
      }],
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

  socket.on('unirse_sala', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return socket.emit('error_conexion', { mensaje: 'Sala no encontrada' });
    sala.jugadores.push({ 
      id: socket.id, nombre: data.nombreUsuario, avatar: data.avatar, puntos: 0, esAnfitrion: false, pinocho: false, medalla: '',
      estadisticas: { tibias: 0, falsasDenuncias: 0, escrachadoFC: 0, aciertosTraidor: 0 }
    });
    socket.join(data.codigoSala);
    io.to(data.codigoSala).emit('actualizar_jugadores', { jugadores: sala.jugadores });
  });

  socket.on('preparar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    
    let testSeleccionado = TESTS.find(t => t.id_test === data.idTest);
    sala.testActivo = testSeleccionado;

    let basePreguntas = [];
    if (data.parte === 2) {
      basePreguntas = testSeleccionado.preguntas.slice(15, 30);
    } else {
      basePreguntas = testSeleccionado.preguntas.slice(0, 15);
    }

    let fcMezcladas = mezclarArreglo(FUEGO_CRUZADO).slice(0, 2);
    let fcParaInsertar = fcMezcladas.map(fc => ({
       texto: "🔥 FUEGO CRUZADO 🔥\n" + fc.texto,
       es_fuego_cruzado: true
    }));

    basePreguntas.splice(4, 0, fcParaInsertar[0]);
    basePreguntas.splice(9, 0, fcParaInsertar[1]);

    sala.preguntas = basePreguntas;
    io.to(data.codigoSala).emit('pantalla_reglas');
  });

  const enviarNuevaPregunta = (codigoSala) => {
    const sala = salas[codigoSala];
    sala.respuestasRonda = [];
    sala.cuestionamientos = {};
    sala.votosJuicio = {};

    if (sala.preguntaActualIndice >= sala.preguntas.length) {
   // Le pasamos los jugadores Y la cantidad total de preguntas que tuvo esta partida
   asignarMedallas(sala.jugadores, sala.preguntas.length);
   return io.to(codigoSala).emit('juego_terminado', { jugadores: sala.jugadores, testActivo: sala.testActivo });
}

    let preguntaCruda = sala.preguntas[sala.preguntaActualIndice];
    let preguntaLista;

    if (preguntaCruda.es_fuego_cruzado) {
        preguntaLista = {
            texto: preguntaCruda.texto,
            es_fuego_cruzado: true,
            numero: sala.preguntaActualIndice + 1,
            total: sala.preguntas.length,
            opciones: sala.jugadores.map(j => ({
                id_opcion: j.id,
                texto: `${j.avatar} ${j.nombre}`,
                puntos: 0, 
                es_tibia: false
            }))
        };
    } else {
        preguntaLista = {
            ...preguntaCruda,
            opciones: mezclarArreglo(preguntaCruda.opciones),
            numero: sala.preguntaActualIndice + 1,
            total: sala.preguntas.length
        };
    }

    io.to(codigoSala).emit('nueva_pregunta', { pregunta: preguntaLista });
  };

  socket.on('iniciar_juego', (data) => enviarNuevaPregunta(data.codigoSala));
  socket.on('siguiente_pregunta', (data) => {
      salas[data.codigoSala].preguntaActualIndice++;
      enviarNuevaPregunta(data.codigoSala);
  });

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
        
        if (preguntaActual.es_fuego_cruzado) {
            let conteoVotos = {};
            sala.respuestasRonda.forEach(res => {
                conteoVotos[res.idOpcion] = (conteoVotos[res.idOpcion] || 0) + 1;
                let votante = sala.jugadores.find(j => j.id === res.idJugador);
                let votado = sala.jugadores.find(j => j.id === res.idOpcion);
                
                revelacion.push({
                    idJugador: votante.id,
                    nombreJugador: votante.nombre,
                    avatar: votante.avatar,
                    opcionElegida: { texto: votado ? `Votó a: ${votado.avatar} ${votado.nombre}` : 'Alguien' },
                    esTibia: false
                });
            });

            let maxVotos = 0;
            Object.values(conteoVotos).forEach(v => { if(v > maxVotos) maxVotos = v; });
            
            Object.keys(conteoVotos).forEach(idVotado => {
                if (conteoVotos[idVotado] === maxVotos) {
                    let victima = sala.jugadores.find(j => j.id === idVotado);
                    if (victima) {
                      victima.puntos += 10;
                      victima.estadisticas.escrachadoFC++;
                    }
                }
            });

        } else {
            let totalTibios = 0;
            sala.respuestasRonda.forEach(res => {
                let jugador = sala.jugadores.find(j => j.id === res.idJugador);
                let opcion = preguntaActual.opciones.find(o => o.id_opcion === res.idOpcion);

                jugador.puntos += opcion.puntos;
                if(opcion.es_tibia) {
                  totalTibios++;
                  jugador.estadisticas.tibias++;
                }

                revelacion.push({
                    idJugador: jugador.id,
                    nombreJugador: jugador.nombre,
                    avatar: jugador.avatar,
                    opcionElegida: opcion,
                    esTibia: opcion.es_tibia
                });
            });

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

            sala.respuestasRonda.forEach(res => {
                if (res.prediccion) {
                    let respuestaObjetivo = sala.respuestasRonda.find(r => r.idJugador === res.prediccion.jugadorObjetivoId);
                    if (respuestaObjetivo && respuestaObjetivo.idOpcion === res.prediccion.opcionAdivinadaId) {
                        let adivinador = sala.jugadores.find(j => j.id === res.idJugador);
                        let victima = sala.jugadores.find(j => j.id === res.prediccion.jugadorObjetivoId);
                        adivinador.puntos = Math.max(0, adivinador.puntos - 2);
                        adivinador.estadisticas.aciertosTraidor++;
                        victima.puntos += 2;
                    }
                }
            });
        }

        io.to(data.codigoSala).emit('mostrar_revelacion', { revelacion, jugadores: sala.jugadores });
    }
  });

  socket.on('cuestionar_jugador', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    sala.cuestionamientos[data.idJugadorAcusado] = sala.cuestionamientos[data.idJugadorAcusado] || [];
    sala.cuestionamientos[data.idJugadorAcusado].push(socket.id);
    io.to(data.codigoSala).emit('actualizar_cuestionamientos', { cuestionamientos: sala.cuestionamientos });
  });

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
                if (acusador) {
                  acusador.puntos += 5;
                  acusador.estadisticas.falsasDenuncias++;
                }
            });
        }

        io.to(data.codigoSala).emit('fin_juicio', { resultado, jugadores: sala.jugadores });
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Servidor de toxicidad activo en puerto ${PORT}`));
