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

const TIEMPO_PREGUNTA_MS = 65000;          // 60s del cliente + 5s de margen
const TIEMPO_JUICIO_MS = 35000;            // 30s del cliente + 5s de margen
const TIEMPO_GRACIA_DESCONEXION_MS = 90000; // tiempo para reconectarse antes de sacarlo de la sala

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

// Arma un bloque de 15 preguntas normales + 2 de Fuego Cruzado insertadas en
// las posiciones 5 y 10 (relativas a ESE bloque). Se usa tanto para el
// arranque del juego como para la extensión a 30.
function construirBloqueDePreguntas(test, parte) {
  let base = parte === 2 ? test.preguntas.slice(15, 30) : test.preguntas.slice(0, 15);
  base = [...base];

  let fcMezcladas = mezclarArreglo(FUEGO_CRUZADO).slice(0, 2);
  let fcParaInsertar = fcMezcladas.map(fc => ({
     texto: "🔥 FUEGO CRUZADO 🔥\n" + fc.texto,
     es_fuego_cruzado: true
  }));

  base.splice(4, 0, fcParaInsertar[0]);
  base.splice(9, 0, fcParaInsertar[1]);
  return base;
}

function asignarMedallas(jugadores, totalPreguntas, totalFuegoCruzado) {
  const preguntasEstandar = (totalPreguntas - totalFuegoCruzado) > 0
    ? totalPreguntas - totalFuegoCruzado
    : totalPreguntas;

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

function limpiarTimers(sala) {
  if (sala.timerPregunta) { clearTimeout(sala.timerPregunta); sala.timerPregunta = null; }
  if (sala.timerJuicio) { clearTimeout(sala.timerJuicio); sala.timerJuicio = null; }
}

function esAnfitrionValido(sala, socketId) {
  return sala.jugadores.some(j => j.id === socketId && j.esAnfitrion);
}

function contarJugadoresConectados(sala) {
  return sala.jugadores.filter(j => j.conectado !== false).length;
}

// Opciones de Fuego Cruzado: solo jugadores actualmente conectados, para no
// ofrecer como "objetivo" a alguien que está en período de gracia.
function opcionesFuegoCruzado(sala) {
  return sala.jugadores
    .filter(j => j.conectado !== false)
    .map(j => ({ id_opcion: j.id, texto: `${j.avatar} ${j.nombre}` }));
}

io.on('connection', (socket) => {

  socket.on('crear_sala', (data) => {
    const codigo = generarCodigo();
    salas[codigo] = {
      codigo: codigo,
      jugadores: [{
        id: socket.id, nombre: data.nombreUsuario, avatar: data.avatar, puntos: 0, esAnfitrion: true, pinocho: false, medalla: '',
        conectado: true, token: data.token || null,
        estadisticas: { tibias: 0, falsasDenuncias: 0, escrachadoFC: 0, aciertosTraidor: 0 }
      }],
      testActivo: null,
      parteInicial: null,
      extendida: false,
      totalFuegoCruzado: 0,
      preguntas: [],
      preguntaActualIndice: 0,
      respuestasRonda: [],
      cuestionamientos: {},
      votosJuicio: {},
      idAcusadoActual: null,
      timerPregunta: null,
      timerJuicio: null,
      timersDesconexion: {}
    };
    socket.join(codigo);
    socket.emit('sala_creada', { codigoSala: codigo, jugadores: salas[codigo].jugadores });
    console.log(`[${codigo}] Sala creada por ${data.nombreUsuario}`);
  });

  socket.on('unirse_sala', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return socket.emit('error_conexion', { mensaje: 'Sala no encontrada' });

    let existente = null;
    if (data.token) {
      existente = sala.jugadores.find(j => j.token && j.token === data.token);
    }
    if (!existente) {
      const nombreNormalizado = (data.nombreUsuario || '').trim().toLowerCase();
      existente = sala.jugadores.find(j => j.nombre.trim().toLowerCase() === nombreNormalizado);
    }

    if (existente) {
      // Reconexión (por token si lo hay, o por nombre como respaldo).
      const idAnterior = existente.id;

      if (sala.timersDesconexion[idAnterior]) {
        clearTimeout(sala.timersDesconexion[idAnterior]);
        delete sala.timersDesconexion[idAnterior];
      }

      existente.id = socket.id;
      existente.conectado = true;
      if (data.avatar) existente.avatar = data.avatar;
      if (data.token) existente.token = data.token;

      sala.respuestasRonda.forEach(r => { if (r.idJugador === idAnterior) r.idJugador = socket.id; });
      Object.keys(sala.cuestionamientos).forEach(key => {
        sala.cuestionamientos[key] = sala.cuestionamientos[key].map(id => id === idAnterior ? socket.id : id);
      });
      if (sala.cuestionamientos[idAnterior]) {
        sala.cuestionamientos[socket.id] = sala.cuestionamientos[idAnterior];
        delete sala.cuestionamientos[idAnterior];
      }
      if (sala.votosJuicio[idAnterior] !== undefined) {
        sala.votosJuicio[socket.id] = sala.votosJuicio[idAnterior];
        delete sala.votosJuicio[idAnterior];
      }
      if (sala.idAcusadoActual === idAnterior) sala.idAcusadoActual = socket.id;

      console.log(`[${data.codigoSala}] ${existente.nombre} se reconectó`);
    } else {
      sala.jugadores.push({
        id: socket.id, nombre: data.nombreUsuario, avatar: data.avatar, puntos: 0, esAnfitrion: false, pinocho: false, medalla: '',
        conectado: true, token: data.token || null,
        estadisticas: { tibias: 0, falsasDenuncias: 0, escrachadoFC: 0, aciertosTraidor: 0 }
      });
      console.log(`[${data.codigoSala}] ${data.nombreUsuario} se unió`);
    }

    socket.join(data.codigoSala);
    io.to(data.codigoSala).emit('actualizar_jugadores', { jugadores: sala.jugadores });
    intentarCerrarRondaSiCorresponde(data.codigoSala);
  });

  socket.on('preparar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) {
      return socket.emit('error_conexion', { mensaje: 'Solo el anfitrión puede iniciar el juego.' });
    }
    if (sala.jugadores.length < 2) {
      return socket.emit('error_conexion', { mensaje: 'Necesitás al menos 2 jugadores para empezar.' });
    }

    let testSeleccionado = TESTS.find(t => t.id_test === data.idTest);
    if (!testSeleccionado) {
      return socket.emit('error_conexion', { mensaje: 'Ese test no existe.' });
    }

    sala.testActivo = testSeleccionado;
    sala.parteInicial = data.parte;
    sala.extendida = false;
    sala.preguntas = construirBloqueDePreguntas(testSeleccionado, data.parte);
    sala.totalFuegoCruzado = 2;

    io.to(data.codigoSala).emit('pantalla_reglas', { testActivo: sala.testActivo, parte: data.parte });
  });

  const enviarNuevaPregunta = (codigoSala) => {
    const sala = salas[codigoSala];
    if (!sala) return;

    limpiarTimers(sala);
    sala.respuestasRonda = [];
    sala.cuestionamientos = {};
    sala.votosJuicio = {};
    sala.idAcusadoActual = null;

    if (sala.preguntaActualIndice >= sala.preguntas.length) {
       asignarMedallas(sala.jugadores, sala.preguntas.length, sala.totalFuegoCruzado);
       return io.to(codigoSala).emit('juego_terminado', {
         jugadores: sala.jugadores,
         testActivo: sala.testActivo,
         parteInicial: sala.parteInicial,
         extendida: sala.extendida
       });
    }

    let preguntaCruda = sala.preguntas[sala.preguntaActualIndice];
    let preguntaLista;

    const esUltimaDelBloque = sala.preguntaActualIndice === sala.preguntas.length - 1;
    const finDeBloque = esUltimaDelBloque && !sala.extendida;

    const infoJuego = {
      idTest: sala.testActivo ? sala.testActivo.id_test : null,
      parteInicial: sala.parteInicial,
      extendida: sala.extendida
    };

    if (preguntaCruda.es_fuego_cruzado) {
        preguntaLista = {
            texto: preguntaCruda.texto,
            es_fuego_cruzado: true,
            numero: sala.preguntaActualIndice + 1,
            total: sala.preguntas.length,
            fin_de_bloque: finDeBloque,
            opciones: opcionesFuegoCruzado(sala),
            ...infoJuego
        };
    } else {
        preguntaLista = {
            ...preguntaCruda,
            opciones: mezclarArreglo(preguntaCruda.opciones),
            numero: sala.preguntaActualIndice + 1,
            total: sala.preguntas.length,
            fin_de_bloque: finDeBloque,
            ...infoJuego
        };
    }

    io.to(codigoSala).emit('nueva_pregunta', { pregunta: preguntaLista });
    console.log(`[${codigoSala}] Pregunta ${preguntaLista.numero}/${preguntaLista.total} ${preguntaLista.es_fuego_cruzado ? '(FUEGO CRUZADO)' : ''}`);

    sala.timerPregunta = setTimeout(() => {
      completarRespuestasFaltantes(codigoSala);
    }, TIEMPO_PREGUNTA_MS);
  };

  function completarRespuestasFaltantes(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;

    const preguntaActual = sala.preguntas[sala.preguntaActualIndice];
    if (!preguntaActual) return;

    const idsQueYaRespondieron = new Set(sala.respuestasRonda.map(r => r.idJugador));
    const opcionesValidas = preguntaActual.es_fuego_cruzado
      ? sala.jugadores.filter(j => j.conectado !== false).map(j => ({ id_opcion: j.id }))
      : preguntaActual.opciones;

    sala.jugadores.forEach(j => {
      if (j.conectado === false) return; // no forzamos respuesta a alguien desconectado
      if (idsQueYaRespondieron.has(j.id)) return;
      if (!opcionesValidas || opcionesValidas.length === 0) return;
      const azar = opcionesValidas[Math.floor(Math.random() * opcionesValidas.length)];
      sala.respuestasRonda.push({ idJugador: j.id, idOpcion: azar.id_opcion, prediccion: null });
    });

    console.log(`[${codigoSala}] Timer de respaldo disparado en pregunta ${sala.preguntaActualIndice + 1}`);
    finalizarRonda(codigoSala);
  }

  socket.on('iniciar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) return;
    enviarNuevaPregunta(data.codigoSala);
  });

  socket.on('siguiente_pregunta', (data) => {
      const sala = salas[data.codigoSala];
      if (!sala) return;
      if (!esAnfitrionValido(sala, socket.id)) return;
      sala.preguntaActualIndice++;
      enviarNuevaPregunta(data.codigoSala);
  });

  socket.on('extender_ronda', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) return;
    if (sala.extendida) return;

    const otraParte = sala.parteInicial === 2 ? 1 : 2;
    const bloqueExtra = construirBloqueDePreguntas(sala.testActivo, otraParte);

    sala.preguntas = [...sala.preguntas, ...bloqueExtra];
    sala.totalFuegoCruzado += 2;
    sala.extendida = true;

    console.log(`[${data.codigoSala}] Ronda extendida: ${sala.preguntas.length} preguntas en total`);

    sala.preguntaActualIndice++;
    enviarNuevaPregunta(data.codigoSala);
  });

  function finalizarRonda(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;

    limpiarTimers(sala);

    let revelacion = [];
    let preguntaActual = sala.preguntas[sala.preguntaActualIndice];
    if (!preguntaActual) return;

    if (preguntaActual.es_fuego_cruzado) {
        let conteoVotos = {};
        sala.respuestasRonda.forEach(res => {
            conteoVotos[res.idOpcion] = (conteoVotos[res.idOpcion] || 0) + 1;
            let votante = sala.jugadores.find(j => j.id === res.idJugador);
            let votado = sala.jugadores.find(j => j.id === res.idOpcion);
            if (!votante) return;

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

  function intentarCerrarRondaSiCorresponde(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;
    const conectados = contarJugadoresConectados(sala);
    if (sala.respuestasRonda.length > 0 && sala.respuestasRonda.length >= conectados) {
      finalizarRonda(codigoSala);
    }
    const votantesEsperados = Math.max(conectados - 1, 1);
    if (Object.keys(sala.votosJuicio).length > 0 && Object.keys(sala.votosJuicio).length >= votantesEsperados) {
      finalizarJuicio(codigoSala);
    }
  }

  socket.on('enviar_respuesta', (data) => {
    try {
      const sala = salas[data.codigoSala];
      if (!sala) return;
      if (sala.respuestasRonda.some(r => r.idJugador === socket.id)) return;

      sala.respuestasRonda.push({
          idJugador: socket.id,
          idOpcion: data.idOpcion,
          prediccion: data.prediccion
      });

      intentarCerrarRondaSiCorresponde(data.codigoSala);
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

    if (sala.timerJuicio) { clearTimeout(sala.timerJuicio); sala.timerJuicio = null; }

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

    if (!sala.timerJuicio) {
      sala.timerJuicio = setTimeout(() => {
        console.log(`[${data.codigoSala}] Timer de respaldo del tribunal disparado`);
        finalizarJuicio(data.codigoSala);
      }, TIEMPO_JUICIO_MS);
    }

    intentarCerrarRondaSiCorresponde(data.codigoSala);
  });

  socket.on('finalizar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) return;
    limpiarTimers(sala);
    asignarMedallas(sala.jugadores, sala.preguntas.length, sala.totalFuegoCruzado);
    io.to(data.codigoSala).emit('juego_terminado', {
      jugadores: sala.jugadores,
      testActivo: sala.testActivo,
      parteInicial: sala.parteInicial,
      extendida: sala.extendida
    });
  });

  function removerJugadorDefinitivamente(codigo, idJugador) {
    const sala = salas[codigo];
    if (!sala) return;
    const idx = sala.jugadores.findIndex(j => j.id === idJugador);
    if (idx === -1) return; // ya se reconectó, o ya fue removido

    const eraAnfitrion = sala.jugadores[idx].esAnfitrion;
    sala.jugadores.splice(idx, 1);
    delete sala.timersDesconexion[idJugador];

    if (sala.jugadores.length === 0) {
      limpiarTimers(sala);
      delete salas[codigo];
      return;
    }

    if (eraAnfitrion) sala.jugadores[0].esAnfitrion = true;

    io.to(codigo).emit('actualizar_jugadores', { jugadores: sala.jugadores });
    console.log(`[${codigo}] jugador removido definitivamente (no volvió a conectarse)`);

    intentarCerrarRondaSiCorresponde(codigo);
  }

  socket.on('disconnect', () => {
    for (const codigo in salas) {
      const sala = salas[codigo];
      const jugador = sala.jugadores.find(j => j.id === socket.id);
      if (!jugador) continue;

      // No lo sacamos de la sala todavía: le damos un período de gracia
      // para reconectarse (celular que se queda sin señal, recarga de
      // página, etc). Mientras tanto queda marcado como desconectado.
      jugador.conectado = false;
      io.to(codigo).emit('actualizar_jugadores', { jugadores: sala.jugadores });
      console.log(`[${codigo}] ${jugador.nombre} se desconectó, esperando reconexión (${TIEMPO_GRACIA_DESCONEXION_MS / 1000}s)...`);

      const idDesconectado = jugador.id;
      sala.timersDesconexion[idDesconectado] = setTimeout(() => {
        removerJugadorDefinitivamente(codigo, idDesconectado);
      }, TIEMPO_GRACIA_DESCONEXION_MS);

      intentarCerrarRondaSiCorresponde(codigo);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Servidor de toxicidad activo en puerto ${PORT}`));
