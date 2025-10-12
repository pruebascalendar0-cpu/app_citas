require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ====== LOGGING BÁSICO ======
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`➡️  [REQ] ${req.method} ${req.originalUrl} | query=${JSON.stringify(req.query)} | body=${JSON.stringify(req.body)}`);
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`⬅️  [RES] ${req.method} ${req.originalUrl} | status=${res.statusCode} | ${ms}ms`);
  });
  next();
});

// ====== DB ======
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

conexion.connect((err) => {
  if (err) {
    console.error("❌ Error conectando a MySQL:", err.message);
    process.exit(1);
  }
  console.log("✅ Conexión exitosa a la base de datos");
});

// ====== GMAIL API ======
const {
  EMAIL_USER,
  EMAIL_FROM,
  REPLY_TO,
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI,
  GMAIL_REFRESH_TOKEN,
} = process.env;

const oauth2Client = new google.auth.OAuth2(
  GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET,
  GMAIL_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

function encodeHeader(str) {
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

async function gmailSend({ to, subject, html, fromEmail = EMAIL_USER, fromName = EMAIL_FROM, replyTo = REPLY_TO }) {
  const subjectEncoded = encodeHeader(subject);
  const fromEncoded = fromName ? `${encodeHeader(fromName)} <${fromEmail}>` : `<${fromEmail}>`;

  const headers = [
    `From: ${fromEncoded}`,
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
  ];
  // ...
}

// Chequeo rápido de perfil para log
gmail.users.getProfile({ userId: "me" })
  .then(r => console.log(`📧 Gmail API OK. Enviando como: ${r.data.emailAddress || EMAIL_USER}`))
  .catch(e => console.warn("⚠️  Gmail profile check falló:", e?.response?.data || e.message));

function b64url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function gmailSend({ to, subject, html, fromEmail = EMAIL_USER, fromName = EMAIL_FROM, replyTo = REPLY_TO }) {
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const headers = [
    `From: ${fromName ? `"${fromName}" <${fromEmail}>` : `<${fromEmail}>`}`,
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  const raw = b64url(headers.join("\r\n") + `\r\n\r\n${html}`);

  console.log(`[MAIL] Preparando envío → to=${to} | subject=${JSON.stringify(subject)}`);
  const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`[MAIL] ✅ Enviado OK | gmailId=${res.data.id}`);
  return res.data;
}

async function enviarCorreo(destinatario, fecha, hora) {
  const subject = "Confirmación de tu cita médica";
  const html = `
    <h2 style="color: #2e86de;">¡Cita médica confirmada!</h2>
    <p>Tu cita ha sido registrada con éxito.</p>
    <p><strong>Fecha:</strong> ${fecha}</p>
    <p><strong>Hora:</strong> ${hora}</p>
    <p>Gracias por confiar en nuestra clínica.</p>
    <hr/>
    <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
      <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
      <p>Este es un mensaje automático, no respondas a este correo.</p>
    </footer>`;
  return gmailSend({ to: destinatario, subject, html });
}

async function enviarCorreoBienvenida(destinatario, nombre) {
  const subject = "Bienvenido a Clínica Salud Total";
  const html = `
    <h2 style="color: #2e86de;">¡Bienvenido, ${nombre}!</h2>
    <p>Tu registro en <strong>Clínica Salud Total</strong> ha sido exitoso.</p>
    <p>Ahora puedes programar tus citas médicas de forma rápida y segura.</p>
    <hr/>
    <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
      <p><strong>Clínica Salud Total</strong> – Sistema de Registro</p>
      <p>Este es un mensaje automático, no respondas a este correo.</p>
    </footer>`;
  return gmailSend({ to: destinatario, subject, html });
}

async function enviarCorreoRecuperacion(destinatario, nombre, contrasena) {
  const subject = "Recuperación de contraseña - Clínica Salud Total";
  const html = `
    <h2 style="color: #e74c3c;">Recuperación de contraseña</h2>
    <p>Hola <strong>${nombre}</strong>, has solicitado recuperar tu contraseña.</p>
    <p><strong>Tu contraseña actual es:</strong> ${contrasena}</p>
    <p>Te recomendamos cambiarla una vez inicies sesión.</p>
    <hr/>
    <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
      <p><strong>Clínica Salud Total</strong> – Atención al Cliente</p>
      <p>Este es un mensaje automático, no respondas a este correo.</p>
    </footer>`;
  return gmailSend({ to: destinatario, subject, html });
}

async function enviarCorreoActualizacion(destinatario, fecha, hora) {
  const subject = "Actualización de tu cita médica";
  const html = `
    <h2 style="color: #f39c12;">¡Cita médica actualizada!</h2>
    <p>Tu cita ha sido <strong>actualizada</strong> con éxito.</p>
    <p><strong>Nueva Fecha:</strong> ${fecha}</p>
    <p><strong>Hora:</strong> ${hora}</p>
    <hr/>
    <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
      <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
      <p>Este es un mensaje automático, no respondas a este correo.</p>
    </footer>`;
  return gmailSend({ to: destinatario, subject, html });
}

async function enviarCorreoCancelacion(destinatario, fecha, hora) {
  const subject = "Cancelación de tu cita médica";
  const html = `
    <h2 style="color: #c0392b;">Cita cancelada</h2>
    <p>Tu cita médica ha sido <strong>cancelada</strong> correctamente.</p>
    <p><strong>Fecha:</strong> ${fecha}</p>
    <p><strong>Hora:</strong> ${hora}</p>
    <hr/>
    <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
      <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
      <p>Este es un mensaje automático, no respondas a este correo.</p>
    </footer>`;
  return gmailSend({ to: destinatario, subject, html });
}

// ====== UTILS FECHAS ======
function normalizeDate(dateStr) {
  if (!dateStr) return dateStr;
  const onlyDate = String(dateStr).replace(/\//g, "-").split("T")[0];
  const m = onlyDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? onlyDate : onlyDate;
}

// ====== HEALTHCHECK ======
app.get("/", (req, res) => res.send("API OK"));

// ====== RUTAS ======

// Coloca /citas/por-dia ANTES de /citas/:usuario
app.get("/citas/por-dia", (req, res) => {
  console.log("[/citas/por-dia] Generando resumen por fecha…");
  const consulta = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY cita_fecha
    ORDER BY cita_fecha ASC
  `;
  conexion.query(consulta, (error, resultados) => {
    if (error) {
      console.error("ERROR /citas/por-dia:", error.message);
      return res.status(500).json({ error: "Error en la base de datos" });
    }
    console.log("[/citas/por-dia] OK:", resultados);
    res.json({ listaCitas: resultados });
  });
});

/* Usuarios */
app.get("/usuarios", (req, res) => {
  console.log("[/usuarios] Listando usuarios…");
  conexion.query("SELECT * FROM usuarios", (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    if (rpta.length > 0) return res.json({ listaUsuarios: rpta });
    res.json({ mensaje: "no hay registros" });
  });
});

app.post("/usuario/agregar", (req, res) => {
  console.log("[/usuario/agregar] Body:", req.body);
  const usuario = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena: req.body.usuario_contrasena
  };

  if (!usuario.usuario_dni || !/^\d{8}$/.test(usuario.usuario_dni)) {
    return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  }
  if (!usuario.usuario_nombre || !usuario.usuario_apellido) {
    return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  }
  if (!usuario.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario.usuario_correo)) {
    return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  }
  if (!usuario.usuario_contrasena || usuario.usuario_contrasena.length < 6) {
    return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });
  }

  conexion.query("INSERT INTO usuarios SET ?", usuario, (error) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) {
          return res.status(400).json({ mensaje: "DNI ya está registrado" });
        } else if (error.sqlMessage.includes("usuario_correo")) {
          return res.status(400).json({ mensaje: "El correo ya está registrado." });
        }
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      console.error("Error al registrar usuario:", error);
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }
    const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
    enviarCorreoBienvenida(usuario.usuario_correo, nombreCompleto).catch(()=>{});
    return res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.put("/usuario/actualizar/:id", (req, res) => {
  console.log("[/usuario/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body;
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }
  const verificarCorreo = "SELECT * FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  conexion.query(verificarCorreo, [usuario_correo, id], (err, results) => {
    if (err) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (results.length > 0) {
      return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });
    }
    const actualizarUsuario = `
      UPDATE usuarios SET 
      usuario_nombre = ?, 
      usuario_apellido = ?, 
      usuario_correo = ?
      WHERE id_usuario = ?
    `;
    conexion.query(actualizarUsuario, [usuario_nombre, usuario_apellido, usuario_correo, id], (error) => {
      if (error) return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      res.status(200).json({ mensaje: "Usuario actualizado correctamente" });
    });
  });
});

app.post("/usuario/recuperar-correo", (req, res) => {
  console.log("[/usuario/recuperar-correo] Body:", req.body);
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  const consulta = `
    SELECT usuario_correo FROM usuarios
    WHERE usuario_dni = ? AND usuario_nombre = ? AND usuario_apellido = ?
  `;
  conexion.query(consulta, [usuario_dni, usuario_nombre, usuario_apellido], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: resultados[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  console.log("[/usuario/recuperar-contrasena] Body:", req.body);
  const { usuario_correo } = req.body;
  const consulta = "SELECT usuario_nombre, usuario_apellido, usuario_contrasena FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [usuario_correo], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Correo no registrado" });
    const usuario = resultados[0];
    const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
    enviarCorreoRecuperacion(usuario_correo, nombreCompleto, usuario.usuario_contrasena).catch(()=>{});
    res.json({ mensaje: "Correo de recuperación enviado" });
  });
});

app.post("/usuario/registrar", (req, res) => {
  console.log("[/usuario/registrar] Body:", req.body);
  const {
    usuario_nombre, usuario_apellido, usuario_correo,
    usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad
  } = req.body;

  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const nuevoUsuario = {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena,
    usuario_tipo
  };

  conexion.query("INSERT INTO usuarios SET ?", nuevoUsuario, (error, resultados) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) {
          return res.status(400).json({ mensaje: "DNI ya está registrado" });
        } else if (error.sqlMessage.includes("usuario_correo")) {
          return res.status(400).json({ mensaje: "El correo ya está registrado." });
        }
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      console.error("Error al registrar usuario:", error);
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }

    const id_usuario = resultados.insertId;
    if (usuario_tipo === 2 && id_especialidad) {
      const queryMedico = "INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)";
      conexion.query(queryMedico, [id_usuario, id_especialidad], (errorMedico) => {
        if (errorMedico) {
          console.error("Error al insertar en médicos:", errorMedico);
          return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
        }
        res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

app.get("/usuario/:correo", (req, res) => {
  console.log("[/usuario/:correo] Params:", req.params);
  const correo = decodeURIComponent(req.params.correo);
  const consulta = "SELECT * FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [correo], (error, rpta) => {
    if (error) return res.status(500).send(error.message);
    if (rpta.length > 0) {
      res.json(rpta[0]);
    } else {
      res.status(404).send({ mensaje: "no hay registros" });
    }
  });
});

/* Medicos & Horarios */
app.get("/especialidades", (req, res) => {
  console.log("[/especialidades] Listando…");
  conexion.query("SELECT * FROM especialidades", (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    if (rpta.length > 0) return res.json({ listaEspecialidades: rpta });
    res.json({ mensaje: "no hay registros" });
  });
});

app.get("/horarios/:parametro", (req, res) => {
  const parametro = req.params.parametro;
  console.log("[/horarios/:parametro] parametro:", parametro);
  const [fechaRaw, especialidad] = parametro.split("&");
  const fecha = normalizeDate(fechaRaw);

  const consulta = `
    SELECT h.*, 
      TIME_FORMAT(h.horario_hora,'%H:%i') as horario_horas, 
      u.usuario_nombre as medico_nombre, 
      u.usuario_apellido as medico_apellido,
      e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
    WHERE h.horario_fecha = ? AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC
  `;

  conexion.query(consulta, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  console.log("[/horario/actualizar/:id_horario] Params:", req.params, "Body:", req.body);
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;

  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });
  }

  const fechaOK = normalizeDate(fecha_nueva);

  const queryHorarioAnterior = `SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario = ?`;
  conexion.query(queryHorarioAnterior, [id_horario], (err1, result1) => {
    if (err1 || result1.length === 0) {
      return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    }
    const horarioAnterior = result1[0];

    const liberar = `
      UPDATE horarios_medicos 
      SET horario_estado = 0 
      WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
    `;
    conexion.query(liberar, [horarioAnterior.horario_fecha, horarioAnterior.horario_hora, id_medico], () => {});

    const actualizar = `
      UPDATE horarios_medicos 
      SET horario_fecha = ?, horario_hora = ?, horario_estado = 1, id_especialidad = ?
      WHERE id_horario = ?
    `;
    conexion.query(actualizar, [fechaOK, hora_nueva, id_especialidad, id_horario], (err3) => {
      if (err3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      res.json({ mensaje: "Horario actualizado correctamente" });
    });
  });
});

app.post("/horario/registrar", (req, res) => {
  console.log("[/horario/registrar] Body:", req.body);
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  const fechaOK = normalizeDate(horario_fecha);
  const horario_estado = 0;

  const consulta = `
    INSERT INTO horarios_medicos 
      (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, ?, ?)
  `;
  conexion.query(consulta, [id_medico, horario_horas, fechaOK, horario_estado, id_especialidad], (error, resultado) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      }
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: resultado.insertId });
  });
});

app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  console.log("[/horario/editar/:id_medico/:fecha/:hora] Params:", req.params, "Body:", req.body);
  const { id_medico, hora } = req.params;
  const fecha = normalizeDate(req.params.fecha);
  const { accion, nuevaHora, id_especialidad } = req.body;

  if (!accion || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }

  if (accion === "eliminar") {
    const eliminar = `
      DELETE FROM horarios_medicos 
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? AND id_especialidad = ?
    `;
    conexion.query(eliminar, [id_medico, fecha, hora, id_especialidad], (err) => {
      if (err) return res.status(500).json({ mensaje: "Error al eliminar horario" });
      return res.json({ mensaje: "Horario eliminado correctamente" });
    });
  } else if (accion === "actualizar") {
    const actualizar = `
      UPDATE horarios_medicos SET horario_hora = ?, horario_estado = 0
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? AND id_especialidad = ?
    `;
    conexion.query(actualizar, [nuevaHora, id_medico, fecha, hora, id_especialidad], (err) => {
      if (err) return res.status(500).json({ mensaje: "Error al actualizar horario" });
      return res.json({ mensaje: "Horario actualizado correctamente" });
    });
  } else if (accion === "ocupar") {
    const ocupar = `
      UPDATE horarios_medicos SET horario_estado = 1
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? AND id_especialidad = ?
    `;
    conexion.query(ocupar, [id_medico, fecha, hora, id_especialidad], (err) => {
      if (err) return res.status(500).json({ mensaje: "Error al ocupar horario" });
      return res.json({ mensaje: "Horario marcado como ocupado" });
    });
  } else {
    res.status(400).json({ mensaje: "Acción no reconocida" });
  }
});

// === ESPECIALIDADES DEL MÉDICO ===
app.get("/medico/:id/especialidades", (req, res) => {
  const { id } = req.params;
  const sql = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?
  `;
  conexion.query(sql, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades del médico" });
    return res.json({ listaEspecialidades: rows || [] });
  });
});

// === HORARIOS REGISTRADOS DEL MÉDICO POR FECHA Y ESPECIALIDAD ===
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const fechaOK = normalizeDate(fecha);

  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ?
    ORDER BY horario_hora ASC
  `;
  conexion.query(sql, [id_medico, fechaOK, id_especialidad], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error al listar horarios registrados" });
    res.json({ horarios: (rows || []).map(r => r.hora) });
  });
});

// === CITAS DE UN MÉDICO ===
app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const sql = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha, '%Y-%m-%d') AS cita_fecha_sql,
           DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha_mostrar,
           TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
           u.usuario_nombre AS paciente_nombre,
           u.usuario_apellido AS paciente_apellido,
           e.especialidad_nombre,
           c.cita_estado
    FROM citas c
    INNER JOIN usuarios u ON c.id_usuario = u.id_usuario
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_medico = ?
    ORDER BY c.cita_fecha, c.cita_hora
  `;
  conexion.query(sql, [id_medico], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error al obtener citas del médico" });
    res.json({ listaCitas: rows || [] });
  });
});

/* Citas */
app.post("/cita/agregar", (req, res) => {
  console.log("[/cita/agregar] Body:", req.body);
  const { id_usuario, id_medico } = req.body;
  const cita_fecha = normalizeDate(req.body.cita_fecha);
  const cita_hora = req.body.cita_hora;

  const consultaOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(consultaOrden, [id_usuario], (error, results) => {
    if (error) return res.status(500).json({ error: "Error al calcular el número de orden" });
    const numero_orden = results[0].total + 1;

    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };
    conexion.query("INSERT INTO citas SET ?", cita, (errorInsert) => {
      if (errorInsert) return res.status(500).json({ error: "Error al registrar la cita" });

      const marcarHorario = `
        UPDATE horarios_medicos SET horario_estado = 1 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(marcarHorario, [cita_fecha, cita_hora, id_medico], () => {});

      const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
      conexion.query(consultaCorreo, [id_usuario], (errorCorreo, resultsCorreo) => {
        if (errorCorreo) return res.status(500).json({ error: "Error al obtener el correo" });
        if (resultsCorreo.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        const destinatario = resultsCorreo[0].usuario_correo;
        enviarCorreo(destinatario, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  console.log("[/cita/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { id_usuario, id_medico, cita_hora, cita_estado } = req.body;
  const cita_fecha = normalizeDate(req.body.cita_fecha);

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  const queryCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
  conexion.query(queryCorreo, [id_usuario], (errCorreo, results) => {
    if (errCorreo || results.length === 0) {
      return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    }
    const usuario_correo = results[0].usuario_correo;

    const queryHorarioAnterior = `SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?`;
    conexion.query(queryHorarioAnterior, [id], (err1, result1) => {
      if (err1 || result1.length === 0) {
        return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      }
      const horarioAnterior = result1[0];

      const liberar = `
        UPDATE horarios_medicos SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(liberar, [horarioAnterior.cita_fecha, horarioAnterior.cita_hora, id_medico], () => {});

      const sql = `
        UPDATE citas SET 
          id_usuario = ?, 
          id_medico = ?, 
          cita_fecha = ?, 
          cita_hora = ?, 
          cita_estado = ?
        WHERE id_cita = ?
      `;
      conexion.query(sql, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], (err3) => {
        if (err3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const ocupar = `
          UPDATE horarios_medicos SET horario_estado = 1 
          WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
        `;
        conexion.query(ocupar, [cita_fecha, cita_hora, id_medico], () => {});

        enviarCorreoActualizacion(usuario_correo, cita_fecha, cita_hora).catch(()=>{});
        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.get("/citas/:usuario", (req, res) => {
  console.log("[/citas/:usuario] Params:", req.params);
  const { usuario } = req.params;
  const consulta = `
  SELECT c.id_cita, c.id_usuario, c.id_medico,
         DATE_FORMAT(c.cita_fecha, '%Y-%m-%d') AS cita_fecha_sql,
         DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha_mostrar,
         TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
         u.usuario_nombre AS medico_nombre,
         u.usuario_apellido AS medico_apellido,
         e.id_especialidad, e.especialidad_nombre,
         c.cita_estado
  FROM citas c
  INNER JOIN medicos m ON c.id_medico = m.id_medico
  INNER JOIN usuarios u ON m.id_medico = u.id_usuario
  INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
  WHERE c.id_usuario = ?
  ORDER BY c.id_cita ASC
`;
  conexion.query(consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    const obj = {};
    if (rpta.length > 0) {
      const citasNumeradas = rpta.map((cita, index) => ({ ...cita, numero_orden: index + 1 }));
      obj.listaCitas = citasNumeradas;
      res.json(obj);
    } else {
      obj.listaCitas = [];
      res.json(obj);
    }
  });
});

app.get("/citamedica/:id_cita", (req, res) => {
  console.log("[/citamedica/:id_cita] Params:", req.params);
  const { id_cita } = req.params;
  const consulta = `
    SELECT cit.id_cita AS IdCita,
           CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
           esp.especialidad_nombre AS Especialidad,
           CONCAT(med.usuario_nombre, ' ', med.usuario_apellido) AS Medico,
           cit.cita_fecha AS FechaCita,
           cit.cita_hora AS HoraCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario = cit.id_usuario
    INNER JOIN medicos m ON cit.id_medico = m.id_medico
    INNER JOIN usuarios med ON m.id_medico = med.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_cita = ?
  `;
  conexion.query(consulta, [id_cita], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (results.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

// Cancelar por posición visual (dinámico)
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  console.log("[/cita/anular/:id_usuario/:numero_orden] Params:", req.params);
  const { id_usuario, numero_orden } = req.params;

  const sqlFind = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico
    FROM (
      SELECT c.*, ROW_NUMBER() OVER (ORDER BY c.id_cita ASC) AS rn
      FROM citas c
      WHERE c.id_usuario = ? AND c.cita_estado = 1
      ORDER BY c.id_cita ASC
    ) t
    WHERE t.rn = ?
    LIMIT 1
  `;

  conexion.query(sqlFind, [id_usuario, Number(numero_orden)], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error al buscar la cita" });
    if (rows.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = rows[0];

    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e1) => {
      if (e1) return res.status(500).json({ error: "Error al cancelar la cita" });

      const freeSql = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(freeSql, [cita_fecha, cita_hora, id_medico], (e2) => {
        if (e2) return res.status(500).json({ error: "Error al liberar el horario" });
        res.json({ mensaje: "Cita cancelada exitosamente" });
      });
    });
  });
});

// Cancelar por id_cita (recomendado)
app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;

  const sel = `
    SELECT cita_estado,
           DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha_sql,
           TIME_FORMAT(cita_hora,'%H:%i')    AS hora_sql,
           id_medico, id_usuario
    FROM citas WHERE id_cita = ?
  `;
  conexion.query(sel, [id_cita], (e0, rows) => {
    if (e0) return res.status(500).json({ error: "Error al obtener la cita" });
    if (!rows || rows.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_estado, fecha_sql, hora_sql, id_medico, id_usuario } = rows[0];

    // idempotencia
    if (cita_estado === 0) {
      return res.status(409).json({ mensaje: "La cita ya estaba cancelada" });
    }

    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e1) => {
      if (e1) return res.status(500).json({ error: "Error al cancelar la cita" });

      const free = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(free, [fecha_sql, hora_sql, id_medico], (e2) => {
        if (e2) return res.status(500).json({ error: "Error al liberar el horario" });

        // enviar correo solo cuando realmente canceló
        const qMail = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
        conexion.query(qMail, [id_usuario], (e3, r3) => {
          if (!e3 && r3 && r3.length > 0) {
            enviarCorreoCancelacion(r3[0].usuario_correo, fecha_sql, hora_sql).catch(()=>{});
          }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

// === BUSCAR CITA POR NÚMERO DE ORDEN (visual) ===
app.get("/cita/usuario/:id_usuario/orden/:n", (req, res) => {
  const { id_usuario, n } = req.params;
  const sql = `
    SELECT t.*
    FROM (
      SELECT 
        c.id_cita AS IdCita,
        CONCAT(u.usuario_nombre,' ',u.usuario_apellido) AS UsuarioCita,
        e.especialidad_nombre AS Especialidad,
        CONCAT(mu.usuario_nombre,' ',mu.usuario_apellido) AS Medico,
        DATE_FORMAT(c.cita_fecha, '%Y-%m-%d') AS FechaCita,
        TIME_FORMAT(c.cita_hora, '%H:%i') AS HoraCita,
        CASE WHEN c.cita_estado=1 THEN 'Confirmada' ELSE 'Cancelada' END AS EstadoCita,
        ROW_NUMBER() OVER (ORDER BY c.id_cita ASC) AS rn
      FROM citas c
      INNER JOIN usuarios u  ON c.id_usuario = u.id_usuario
      INNER JOIN medicos m   ON c.id_medico  = m.id_medico
      INNER JOIN usuarios mu ON m.id_medico  = mu.id_usuario
      INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
      WHERE c.id_usuario = ?
      ORDER BY c.id_cita ASC
    ) t
    WHERE t.rn = ?
    LIMIT 1
  `;
  conexion.query(sql, [id_usuario, Number(n)], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error al buscar la cita" });
    if (!rows || rows.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  });
});

app.get("/citas", (req, res) => {
  console.log("[/citas] Listando todo…");
  const consulta = `
    SELECT 
      ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha, c.cita_hora) AS numero_cita,
      c.id_cita,
      u.usuario_nombre AS paciente_nombre,
      u.usuario_apellido AS paciente_apellido,
      DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
      TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
      e.especialidad_nombre,
      mu.usuario_nombre AS medico_nombre,
      mu.usuario_apellido AS medico_apellido,
      c.cita_estado
    FROM citas c 
    INNER JOIN usuarios u ON c.id_usuario = u.id_usuario 
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    ORDER BY u.usuario_nombre ASC, numero_cita ASC
  `;
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error al obtener las citas" });
    res.json({ listaCitas: rpta || [] });
  });
});

app.get("/medicos", (req, res) => {
  console.log("[/medicos] Listando…");
  conexion.query("SELECT * FROM medicos", (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    if (rpta.length > 0) return res.json({ listaCitas: rpta });
    res.json({ mensaje: "no hay registros" });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  console.log("[/especialidad/agregar] Body:", req.body);
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) {
    return res.status(400).json({ error: "Nombre requerido" });
  }
  conexion.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], (err) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  console.log("[/especialidad/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) {
    return res.status(400).json({ mensaje: "Nombre requerido" });
  }
  const sql = "UPDATE especialidades SET especialidad_nombre = ? WHERE id_especialidad = ?";
  conexion.query(sql, [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor corriendo en el puerto " + PORT);
});
