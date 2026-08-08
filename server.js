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

// 60s del cliente + 5s de margen de red/latencia
const TIEMPO_PREGUNTA_MS = 65000;

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

// Asignación de medallas dinámica según preguntas reales jugadas
function asignarMedallas(jugadores, totalPreguntas) {
  const preguntasEstandar = totalPreguntas > 2 ? totalPreguntas - 2 : totalPreguntas;

  jugadores.forEach(j => {
    let porcentajeTibio = j.estadisticas.tibias / preguntasEstandar;

    if (j.pinocho) {
      j.medalla = "🤥 PINOCHO DEL GRUPO (Atrapado mintiendo)";
    } else if (porcentajeTibio >= 0.20) {
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

function limpiarTimerPregunta(sala) {
  if (sala.timerPregunta) {
    clearTimeout(sala.timerPregunta);
    sala.timerPregunta = null;
  }
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
      votosJuicio: {},
      idAcusadoActual: null,
      timerPregunta: null
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
    if (!sala) return;

    limpiarTimerPregunta(sala);
    sala.respuestasRonda = [];
    sala.cuestionamientos = {};
    sala.votosJuicio = {};
    sala.idAcusadoActual = null;

    if (sala.preguntaActualIndice >= sala.preguntas.length) {
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
            // El servidor genera las opciones (los jugadores de la sala) para
            // que el id_opcion que vuelva por 'enviar_respuesta' sea siempre
            // válido y consistente con el estado real del servidor.
            opciones: sala.jugadores.map(j => ({ id_opcion: j.id, texto: `${j.avatar} ${j.nombre}` }))
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

    // Respaldo del lado servidor: si algún celular se queda sin timer
    // (pantalla bloqueada, app en segundo plano, conexión caída), la sala
    // no debe quedar esperándolo para siempre.
    sala.timerPregunta = setTimeout(() => {
      completarRespuestasFaltantes(codigoSala);
    }, TIEMPO_PREGUNTA_MS);
  };

  // Completa con una respuesta al azar a cualquier jugador que todavía no
  // haya respondido cuando se cumple el timeout de respaldo.
  function completarRespuestasFaltantes(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;

    const preguntaActual = sala.preguntas[sala.preguntaActualIndice];
    if (!preguntaActual) return;

    const idsQueYaRespondieron = new Set(sala.respuestasRonda.map(r => r.idJugador));
    const opcionesValidas = preguntaActual.es_fuego_cruzado
      ? sala.jugadores.map(j => ({ id_opcion: j.id }))
      : preguntaActual.opciones;

    sala.jugadores.forEach(j => {
      if (idsQueYaRespondieron.has(j.id)) return;
      if (!opcionesValidas || opcionesValidas.length === 0) return;
      const azar = opcionesValidas[Math.floor(Math.random() * opcionesValidas.length)];
      sala.respuestasRonda.push({ idJugador: j.id, idOpcion: azar.id_opcion, prediccion: null });
    });

    finalizarRonda(codigoSala);
  }

  socket.on('iniciar_juego', (data) => enviarNuevaPregunta(data.codigoSala));
  socket.on('siguiente_pregunta', (data) => {
      const sala = salas[data.codigoSala];
      if (!sala) return;
      sala.preguntaActualIndice++;
      enviarNuevaPregunta(data.codigoSala);
  });

  // Procesa la ronda completa (todos respondieron, o se forzó el cierre por
  // timeout/desconexión) y emite 'mostrar_revelacion'. Separada de
  // 'enviar_respuesta' para poder reusarla desde el timer de respaldo y
  // desde el manejo de disconnect.
  function finalizarRonda(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;

    limpiarTimerPregunta(sala);

    let revelacion = [];
    let preguntaActual = sala.preguntas[sala.preguntaActualIndice];
    if (!preguntaActual) return;

    if (preguntaActual.es_fuego_cruzado) {
        let conteoVotos = {};
        sala.respuestasRonda.forEach(res => {
            conteoVotos[res.idOpcion] = (conteoVotos[res.idOpcion] || 0) + 1;
            let votante = sala.jugadores.find(j => j.id === res.idJugador);
            let votado = sala.jugadores.find(j => j.id === res.idOpcion);
            if (!votante) return; // se desconectó justo después de responder

            revelacion.push({
                idJugador: votante.id,
                nombreJugador: votante.nombre,
                avatar: votante.avatar,
                opcionElegida: { texto: votado ? `Votó a: ${votado.avatar} ${votado.nombre}` : 'Alguien' },
                esTibia: false
            });
        });

        let maxVotos = 0;
        Object.values(conteoVotos).forEach(v => { if (v > maxVotos) maxVotos = v; });

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
            if (!jugador || !opcion) return;

            jugador.puntos += opcion.puntos;
            if (opcion.es_tibia) {
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
                if (opcion && opcion.es_tibia) {
                    let jugador = sala.jugadores.find(j => j.id === res.idJugador);
                    if (jugador) jugador.puntos += opcion.puntos;
                }
            });
        }

        sala.respuestasRonda.forEach(res => {
            if (res.prediccion) {
                let respuestaObjetivo = sala.respuestasRonda.find(r => r.idJugador === res.prediccion.jugadorObjetivoId);
                if (respuestaObjetivo && respuestaObjetivo.idOpcion === res.prediccion.opcionAdivinadaId) {
                    let adivinador = sala.jugadores.find(j => j.id === res.idJugador);
                    let victima = sala.jugadores.find(j => j.id === res.prediccion.jugadorObjetivoId);
                    if (adivinador && victima) {
                        adivinador.puntos = Math.max(0, adivinador.puntos - 2);
                        adivinador.estadisticas.aciertosTraidor++;
                        victima.puntos += 2;
                    }
                }
            }
        });
    }

    io.to(codigoSala).emit('mostrar_revelacion', { revelacion, jugadores: sala.jugadores });
  }

  socket.on('enviar_respuesta', (data) => {
    try {
      const sala = salas[data.codigoSala];
      if (!sala) return;

      // Evita duplicados si el evento llega dos veces (doble click, reintento de red)
      if (sala.respuestasRonda.some(r => r.idJugador === socket.id)) return;

      sala.respuestasRonda.push({
          idJugador: socket.id,
          idOpcion: data.idOpcion,
          prediccion: data.prediccion
      });

      if (sala.respuestasRonda.length >= sala.jugadores.length) {
          finalizarRonda(data.codigoSala);
      }
    } catch (err) {
      console.error('Error en enviar_respuesta:', err);
      io.to(data.codigoSala).emit('error_conexion', { mensaje: 'Hubo un error procesando la respuesta. Reintentando...' });
    }
  });

  socket.on('cuestionar_jugador', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    sala.cuestionamientos[data.idJugadorAcusado] = sala.cuestionamientos[data.idJugadorAcusado] || [];
    sala.cuestionamientos[data.idJugadorAcusado].push(socket.id);
    io.to(data.codigoSala).emit('actualizar_cuestionamientos', { cuestionamientos: sala.cuestionamientos });
  });

  function finalizarJuicio(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;

    let votosCulpable = 0;
    let votosInocente = 0;

    Object.values(sala.votosJuicio).forEach(v => {
        if (v === 'MINTIO') votosCulpable++;
        else votosInocente++;
    });

    let resultado = votosCulpable > votosInocente ? 'MINTIO' : 'SALVADO';
    const idAcusado = sala.idAcusadoActual;

    if (resultado === 'MINTIO') {
        let acusado = sala.jugadores.find(j => j.id === idAcusado);
        if (acusado) {
            acusado.puntos += 10;
            acusado.pinocho = true;
        }
    } else {
        let acusadoresIds = sala.cuestionamientos[idAcusado] || [];
        acusadoresIds.forEach(idAcusador => {
            let acusador = sala.jugadores.find(j => j.id === idAcusador);
            if (acusador) {
              acusador.puntos += 5;
              acusador.estadisticas.falsasDenuncias++;
            }
        });
    }

    io.to(codigoSala).emit('fin_juicio', { resultado, jugadores: sala.jugadores });
  }

  socket.on('votar_juicio', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;

    sala.idAcusadoActual = data.idAcusado;
    sala.votosJuicio[socket.id] = data.voto;

    const votantesEsperados = Math.max(sala.jugadores.length - 1, 1);
    if (Object.keys(sala.votosJuicio).length >= votantesEsperados) {
        finalizarJuicio(data.codigoSala);
    }
  });

  socket.on('finalizar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    limpiarTimerPregunta(sala);
    asignarMedallas(sala.jugadores, sala.preguntas.length);
    io.to(data.codigoSala).emit('juego_terminado', { jugadores: sala.jugadores, testActivo: sala.testActivo });
  });

  socket.on('disconnect', () => {
    for (const codigo in salas) {
      const sala = salas[codigo];
      const idx = sala.jugadores.findIndex(j => j.id === socket.id);
      if (idx === -1) continue;

      const eraAnfitrion = sala.jugadores[idx].esAnfitrion;
      sala.jugadores.splice(idx, 1);

      if (sala.jugadores.length === 0) {
        limpiarTimerPregunta(sala);
        delete salas[codigo];
        continue;
      }

      // Si se fue el anfitrión, el rol pasa a quien sigue en la lista para
      // que la sala no quede sin nadie que pueda avanzar el juego.
      if (eraAnfitrion) {
        sala.jugadores[0].esAnfitrion = true;
      }

      io.to(codigo).emit('actualizar_jugadores', { jugadores: sala.jugadores });

      // Si su respuesta era lo único que faltaba para cerrar la ronda, o su
      // voto era lo único que faltaba en el tribunal, cerrar ahora en vez de
      // esperar al timer de respaldo.
      if (sala.respuestasRonda.length > 0 && sala.respuestasRonda.length >= sala.jugadores.length) {
        finalizarRonda(codigo);
      }
      const votantesEsperados = Math.max(sala.jugadores.length - 1, 1);
      if (Object.keys(sala.votosJuicio).length > 0 && Object.keys(sala.votosJuicio).length >= votantesEsperados) {
        finalizarJuicio(codigo);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Servidor de toxicidad activo en puerto ${PORT}`));
