// ====================== BOOTSTRAP DEL SERVIDOR ======================
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

// Body parser
app.use(express.json());

// Request logger (método, url, query, body)
app.use((req, res, next) => {
  const started = Date.now();
  console.log(`➡️  [REQ] ${req.method} ${req.originalUrl} | query=${JSON.stringify(req.query)} | body=${JSON.stringify(req.body)}`);

  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(`⬅️  [RES] ${req.method} ${req.originalUrl} | status=${res.statusCode} | ${ms}ms`);
  });

  next();
});

// No cache (evita datos viejos en listas)
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// MySQL
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

conexion.connect(err => {
  if (err) {
    console.error("❌ Error conectando a MySQL:", err.message);
    process.exit(1);
  }
  console.log("✅ Conexión exitosa a la base de datos");
});

// Healthcheck
app.get("/", (req, res) => res.send("API OK"));

// ====================== GMAIL API (googleapis) ======================
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

// Codifica headers con caracteres no-ASCII (tildes, ñ, etc.)
function encodeHeader(str) {
  return /[^\x00-\x7F]/.test(str)
    ? `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`
    : str;
}

async function gmailSend({ to, subject, html, fromEmail = EMAIL_USER, fromName = EMAIL_FROM, replyTo = REPLY_TO }) {
  console.log(`[MAIL] Preparando envío → to=${to} | subject="${subject}"`);
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${fromEmail}>` : `<${fromEmail}>`}`,
    `To: ${to}`,
    `Subject: ${subjectEncoded}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
  ];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  const message = headers.join("\r\n") + `\r\n\r\n${html}`;
  const raw = Buffer.from(message, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

  try {
    const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.log(`[MAIL] ✅ Enviado OK | gmailId=${res.data.id}`);
    return res.data;
  } catch (err) {
    console.error("[MAIL] ❌ Error al enviar:", err?.response?.data || err.message);
    throw err;
  }
}

// Helpers de negocio (usan gmailSend)
async function enviarCorreo(destinatario, fecha, hora) {
  return gmailSend({
    to: destinatario,
    subject: "Confirmación de tu cita médica",
    html: `
      <h2 style="color: #2e86de;">¡Cita médica confirmada!</h2>
      <p>Tu cita ha sido registrada con éxito.</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <p>Gracias por confiar en nuestra clínica.</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>`
  });
}

async function enviarCorreoBienvenida(destinatario, nombre) {
  return gmailSend({
    to: destinatario,
    subject: "Bienvenido a Clínica Salud Total",
    html: `
      <h2 style="color: #2e86de;">¡Bienvenido, ${nombre}!</h2>
      <p>Tu registro en <strong>Clínica Salud Total</strong> ha sido exitoso.</p>
      <p>Ahora puedes ingresar a la aplicación y comenzar a programar tus citas médicas de forma rápida y segura.</p>
      <p>Estamos felices de tenerte con nosotros.</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Registro</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>`
  });
}

async function enviarCorreoRecuperacion(destinatario, nombre, contrasena) {
  return gmailSend({
    to: destinatario,
    subject: "Recuperación de contraseña - Clínica Salud Total",
    html: `
      <h2 style="color: #e74c3c;">Recuperación de contraseña</h2>
      <p>Hola <strong>${nombre}</strong>, has solicitado recuperar tu contraseña.</p>
      <p><strong>Tu contraseña actual es:</strong> ${contrasena}</p>
      <p>Te recomendamos cambiarla una vez inicies sesión.</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema Atención al Cliente</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>`
  });
}

async function enviarCorreoActualizacion(destinatario, fecha, hora) {
  return gmailSend({
    to: destinatario,
    subject: "Actualización de tu cita médica",
    html: `
      <h2 style="color: #f39c12;">¡Cita médica actualizada!</h2>
      <p>Tu cita ha sido <strong>actualizada</strong> con éxito.</p>
      <p><strong>Nueva Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <p>Si no solicitaste esta modificación, por favor contacta a la clínica.</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>`
  });
}

async function enviarCorreoCancelacion(destinatario, fecha, hora) {
  return gmailSend({
    to: destinatario,
    subject: "Cancelación de tu cita médica",
    html: `
      <h2 style="color: #c0392b;">Cita cancelada</h2>
      <p>Tu cita médica ha sido <strong>cancelada</strong> correctamente.</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <p>Si esto fue un error, por favor agenda una nueva cita.</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>`
  });
}

// (Opcional) Verificamos Gmail API al arrancar
(async () => {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    console.log("📧 Gmail API OK. Enviando como:", profile.data.emailAddress);
  } catch (e) {
    console.error("❌ Gmail API no está listo:", e?.response?.data || e.message);
  }
})();

// ============================ ENDPOINTS ============================

// USUARIOS
app.get("/usuarios", (req, res) => {
  console.log("[/usuarios] Listando usuarios…");
  const consulta = "SELECT * FROM usuarios";
  conexion.query(consulta, (error, rpta) => {
    if (error) {
      console.error("[/usuarios] Error:", error.message);
      return res.status(500).json({ error: "Error listando usuarios" });
    }
    const obj = {};
    obj.listaUsuarios = rpta.length > 0 ? rpta : [];
    res.json(obj);
  });
});

app.post("/usuario/agregar", async (req, res) => {
  console.log("[/usuario/agregar] Body:", req.body);
  const usuario = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena: req.body.usuario_contrasena
  };

  // Validaciones
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

  const consulta = "INSERT INTO usuarios SET ?";
  conexion.query(consulta, usuario, async (error) => {
    if (error) {
      console.error("[/usuario/agregar] Error insert:", error.code, error.sqlMessage);
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) {
          return res.status(400).json({ mensaje: "DNI ya está registrado" });
        } else if (error.sqlMessage.includes("usuario_correo")) {
          return res.status(400).json({ mensaje: "El correo ya está registrado." });
        }
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }

    const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
    try {
      await enviarCorreoBienvenida(usuario.usuario_correo, nombreCompleto);
    } catch (e) {
      console.warn("[/usuario/agregar] Aviso: no se pudo enviar correo de bienvenida:", e?.message);
    }
    return res.status(200).json({ mensaje: "Usuario registrado correctamente." });
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
    if (err) {
      console.error("[/usuario/actualizar] Error verificar correo:", err);
      return res.status(500).json({ mensaje: "Error al verificar correo" });
    }
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
      if (error) {
        console.error("[/usuario/actualizar] Error update:", error);
        return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      }
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
    if (error) {
      console.error("[/usuario/recuperar-correo] Error:", error);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: resultados[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  console.log("[/usuario/recuperar-contrasena] Body:", req.body);
  const { usuario_correo } = req.body;

  const consulta = "SELECT usuario_nombre, usuario_apellido, usuario_contrasena FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [usuario_correo], async (error, resultados) => {
    if (error) {
      console.error("[/usuario/recuperar-contrasena] Error:", error.message);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Correo no registrado" });

    const usuario = resultados[0];
    const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
    try {
      await enviarCorreoRecuperacion(usuario_correo, nombreCompleto, usuario.usuario_contrasena);
    } catch (e) {
      console.warn("[/usuario/recuperar-contrasena] Aviso: no se pudo enviar correo:", e?.message);
    }
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
    usuario_nombre, usuario_apellido, usuario_correo,
    usuario_dni, usuario_contrasena, usuario_tipo
  };

  const query = "INSERT INTO usuarios SET ?";
  conexion.query(query, nuevoUsuario, (error, resultados) => {
    if (error) {
      console.error("[/usuario/registrar] Error insert:", error.code, error.sqlMessage);
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) {
          return res.status(400).json({ mensaje: "DNI ya está registrado" });
        } else if (error.sqlMessage.includes("usuario_correo")) {
          return res.status(400).json({ mensaje: "El correo ya está registrado." });
        }
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }

    const id_usuario = resultados.insertId;

    if (usuario_tipo === 2 && id_especialidad) {
      const queryMedico = "INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)";
      conexion.query(queryMedico, [id_usuario, id_especialidad], (errorMedico) => {
        if (errorMedico) {
          console.error("[/usuario/registrar] Error insert médico:", errorMedico);
          return res.status(200).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
        }
        res.status(200).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(200).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

app.get("/usuario/:correo", (req, res) => {
  console.log("[/usuario/:correo] Params:", req.params);
  const correo = decodeURIComponent(req.params.correo);
  const consulta = "SELECT * FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [correo], (error, rpta) => {
    if (error) {
      console.error("[/usuario/:correo] Error:", error.message);
      return res.status(500).send(error.message);
    }
    if (rpta.length > 0) res.json(rpta[0]);
    else res.status(404).send({ mensaje: "no hay registros" });
  });
});

// MEDICOS / HORARIOS
app.get("/especialidades", (req, res) => {
  console.log("[/especialidades] Listando…");
  const consulta = "SELECT * FROM especialidades";
  conexion.query(consulta, (error, rpta) => {
    if (error) {
      console.error("[/especialidades] Error:", error.message);
      return res.status(500).json({ error: "Error listando especialidades" });
    }
    const obj = {};
    obj.listaEspecialidades = rpta.length > 0 ? rpta : [];
    res.json(obj);
  });
});

app.get("/horarios/:parametro", (req, res) => {
  console.log("[/horarios/:parametro] Params.parametro:", req.params.parametro);
  const valores = req.params.parametro.split("&");
  const fecha = valores[0];
  const especialidad = valores[1];

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
    if (error) {
      console.error("[/horarios/:parametro] Error:", error.message);
      return res.status(500).json({ error: error.message });
    }
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

  const queryHorarioAnterior = `SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario = ?`;
  conexion.query(queryHorarioAnterior, [id_horario], (err1, result1) => {
    if (err1 || result1.length === 0) {
      console.error("[/horario/actualizar] Error obtener anterior:", err1);
      return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    }

    const horarioAnterior = result1[0];

    const liberar = `
      UPDATE horarios_medicos 
      SET horario_estado = 0 
      WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
    `;
    conexion.query(liberar, [horarioAnterior.horario_fecha, horarioAnterior.horario_hora, id_medico], (err2) => {
      if (err2) console.warn("[/horario/actualizar] No se pudo liberar el horario anterior:", err2?.message);
    });

    const actualizar = `
      UPDATE horarios_medicos 
      SET horario_fecha = ?, horario_hora = ?, horario_estado = 1, id_especialidad = ?
      WHERE id_horario = ?
    `;
    conexion.query(actualizar, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (err3) => {
      if (err3) {
        console.error("[/horario/actualizar] Error update:", err3?.sqlMessage);
        return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      }
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
  const horario_estado = 0;

  const consulta = `
    INSERT INTO horarios_medicos 
      (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, ?, ?)
  `;

  conexion.query(consulta, [id_medico, horario_horas, horario_fecha, horario_estado, id_especialidad], (error, resultado) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        console.warn("[/horario/registrar] Horario duplicado");
        return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      }
      console.error("[/horario/registrar] Error:", error.message);
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: resultado.insertId });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  console.log("[/medico/:id_medico/especialidades] Params:", req.params);
  const { id_medico } = req.params;
  const consulta = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?
  `;

  conexion.query(consulta, [id_medico], (err, rpta) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: rpta });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  console.log("[/horarios/disponibles] Params:", req.params);
  const { id_medico, fecha, id_especialidad } = req.params;

  const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, '0')}:00`);

  const consulta = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ?
  `;

  conexion.query(consulta, [id_medico, fecha, id_especialidad], (error, resultados) => {
    if (error) {
      console.error("[/horarios/disponibles] Error:", error.message);
      return res.status(500).json({ error: "Error al consultar horarios" });
    }

    const horasOcupadas = resultados.map(r => r.hora);
    const horasDisponibles = todasLasHoras.filter(hora => !horasOcupadas.includes(hora));
    res.json({ horariosDisponibles: horasDisponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  console.log("[/horarios/registrados] Params:", req.params);
  const { id_medico, fecha, id_especialidad } = req.params;

  const sql = `
    SELECT horario_hora 
    FROM horarios_medicos 
    WHERE id_medico = ? 
      AND horario_fecha = ? 
      AND id_especialidad = ?
      AND horario_estado = 0
    ORDER BY horario_hora ASC
  `;

  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, results) => {
    if (err) {
      console.error("[/horarios/registrados] Error:", err);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
    const horarios = results.map(row => row.horario_hora);
    res.json({ horarios });
  });
});

// CITAS
app.post("/cita/agregar", (req, res) => {
  console.log("[/cita/agregar] Body:", req.body);
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;

  const consultaOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(consultaOrden, [id_usuario], (error, results) => {
    if (error) {
      console.error("[/cita/agregar] Error contando citas:", error.message);
      return res.status(500).json({ error: "Error interno al calcular el número de orden" });
    }

    const numero_orden = results[0].total + 1;
    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };

    const consultaInsert = "INSERT INTO citas SET ?";
    conexion.query(consultaInsert, cita, async (errorInsert, resultadoInsert) => {
      if (errorInsert) {
        console.error("[/cita/agregar] Error insert cita:", errorInsert.message);
        return res.status(500).json({ error: "Error al registrar la cita" });
      }

      const marcarHorario = `
        UPDATE horarios_medicos SET horario_estado = 1 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(marcarHorario, [cita_fecha, cita_hora, id_medico], (errUpdate) => {
        if (errUpdate) console.warn("[/cita/agregar] Aviso: no se pudo marcar horario ocupado:", errUpdate?.message);
      });

      const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
      conexion.query(consultaCorreo, [id_usuario], async (errorCorreo, resultsCorreo) => {
        if (errorCorreo) {
          console.error("[/cita/agregar] Error buscando correo:", errorCorreo.message);
          return res.status(500).json({ error: "Error interno al obtener el correo" });
        }
        if (resultsCorreo.length === 0) {
          console.warn("[/cita/agregar] Usuario sin correo id:", id_usuario);
          return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const destinatario = resultsCorreo[0].usuario_correo;
        try {
          await enviarCorreo(destinatario, cita_fecha, cita_hora);
        } catch (e) {
          console.warn("[/cita/agregar] Aviso: correo de confirmación no enviado:", e?.message);
        }

        res.json({
          mensaje: "Cita registrada correctamente",
          id_cita: resultadoInsert.insertId,
          numero_orden,
          cita: { id_usuario, id_medico, cita_fecha, cita_hora }
        });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  console.log("[/cita/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  const queryCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
  conexion.query(queryCorreo, [id_usuario], (errCorreo, results) => {
    if (errCorreo || results.length === 0) {
      console.error("[/cita/actualizar] Error obteniendo correo:", errCorreo);
      return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    }

    const usuario_correo = results[0].usuario_correo;

    const queryHorarioAnterior = `SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?`;
    conexion.query(queryHorarioAnterior, [id], (err1, result1) => {
      if (err1) {
        console.error("[/cita/actualizar] Error horario anterior:", err1);
        return res.status(500).json({ mensaje: "Error interno al obtener horario anterior" });
      }

      const horarioAnterior = result1[0];

      const liberar = `
        UPDATE horarios_medicos SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(liberar, [horarioAnterior.cita_fecha, horarioAnterior.cita_hora, id_medico], (err2) => {
        if (err2) console.warn("[/cita/actualizar] No se pudo liberar horario anterior:", err2);
      });

      const sql = `
        UPDATE citas SET 
          id_usuario = ?, 
          id_medico = ?, 
          cita_fecha = ?, 
          cita_hora = ?, 
          cita_estado = ?
        WHERE id_cita = ?
      `;
      conexion.query(sql, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], async (err3) => {
        if (err3) {
          console.error("[/cita/actualizar] Error update:", err3?.sqlMessage);
          return res.status(500).json({ mensaje: "Error al actualizar la cita" });
        }

        const ocupar = `
          UPDATE horarios_medicos SET horario_estado = 1 
          WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
        `;
        conexion.query(ocupar, [cita_fecha, cita_hora, id_medico], (err4) => {
          if (err4) console.warn("[/cita/actualizar] No se pudo marcar nuevo horario:", err4);
        });

        try {
          await enviarCorreoActualizacion(usuario_correo, cita_fecha, cita_hora);
        } catch (e) {
          console.warn("[/cita/actualizar] Aviso: correo no enviado:", e?.message);
        }

        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  console.log("[/cita/anular/:id_cita] Params:", req.params);
  const { id_cita } = req.params;

  const consultaDatosCita = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita = ?";
  conexion.query(consultaDatosCita, [id_cita], (error, resultados) => {
    if (error) {
      console.error("[/cita/anular:id_cita] Error obtener datos:", error.message);
      return res.status(500).json({ error: "Error al obtener los datos de la cita" });
    }
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico, id_usuario } = resultados[0];

    const consultaCancelar = "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?";
    conexion.query(consultaCancelar, [id_cita], (error2) => {
      if (error2) {
        console.error("[/cita/anular:id_cita] Error cancelar:", error2.message);
        return res.status(500).json({ error: "Error al cancelar la cita" });
      }

      const consultaLiberarHorario = `
        UPDATE horarios_medicos 
        SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], async (error3) => {
        if (error3) {
          console.error("[/cita/anular:id_cita] Error liberar horario:", error3.message);
          return res.status(500).json({ error: "Error al liberar el horario" });
        }

        const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
        conexion.query(consultaCorreo, [id_usuario], async (err4, rpta) => {
          if (err4 || rpta.length === 0) {
            console.warn("[/cita/anular:id_cita] Aviso: no se pudo obtener correo del usuario:", err4);
          } else {
            const destinatario = rpta[0].usuario_correo;
            try {
              await enviarCorreoCancelacion(destinatario, cita_fecha, cita_hora);
            } catch (e) {
              console.warn("[/cita/anular:id_cita] Aviso: correo no enviado:", e?.message);
            }
          }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  console.log("[/cita/anular/:id_usuario/:numero_orden] Params:", req.params);
  const { id_usuario, numero_orden } = req.params;

  const consultaBuscarCita = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario = ? AND numero_orden = ? AND cita_estado = 1
  `;

  conexion.query(consultaBuscarCita, [id_usuario, numero_orden], (err, resultados) => {
    if (err) return res.status(500).json({ error: "Error al buscar la cita" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = resultados[0];

    const consultaCancelar = "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?";
    conexion.query(consultaCancelar, [id_cita], (err2) => {
      if (err2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const consultaLiberarHorario = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;

      conexion.query(consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], (err3) => {
        if (err3) return res.status(500).json({ error: "Error al liberar el horario" });

        const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
        conexion.query(consultaCorreo, [id_usuario], async (err4, rpta) => {
          if (err4 || rpta.length === 0) {
            console.warn("[/cita/anular:usuario/orden] Aviso: no se pudo obtener correo:", err4);
          } else {
            const destinatario = rpta[0].usuario_correo;
            try {
              await enviarCorreoCancelacion(destinatario, cita_fecha, cita_hora);
            } catch (e) {
              console.warn("[/cita/anular:usuario/orden] Aviso: correo no enviado:", e?.message);
            }
          }
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

app.get("/citas", (req, res) => {
  console.log("[/citas] Listando todas…");
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
    ORDER BY u.usuario_nombre ASC, numero_cita ASC;
  `;

  conexion.query(consulta, (error, rpta) => {
    if (error) {
      console.error("[/citas] Error:", error.message);
      return res.status(500).json({ error: "Error al obtener las citas" });
    }
    res.json({ listaCitas: rpta.length > 0 ? rpta : [] });
  });
});

app.get("/citas/:usuario", (req, res) => {
  console.log("[/citas/:usuario] Params:", req.params);
  const { usuario } = req.params;
  const consulta = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
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
    if (error) {
      console.error("[/citas/:usuario] Error:", error.message);
      return res.status(500).json({ error: "Error listando citas del usuario" });
    }
    const obj = {};
    const citasNumeradas = (rpta || []).map((cita, index) => ({ ...cita, numero_orden: index + 1 }));
    obj.listaCitas = citasNumeradas;
    res.json(obj);
  });
});

// ESPECIALIDADES (admin)
app.get("/medicos", (req, res) => {
  console.log("[/medicos] Listando…");
  const consulta = "SELECT * FROM medicos";
  conexion.query(consulta, (error, rpta) => {
    if (error) {
      console.error("[/medicos] Error:", error.message);
      return res.status(500).json({ error: "Error listando medicos" });
    }
    const obj = {};
    obj.listaCitas = rpta.length > 0 ? rpta : [];
    res.json(obj);
  });
});

app.post("/especialidad/agregar", (req, res) => {
  console.log("[/especialidad/agregar] Body:", req.body);
  const { especialidad_nombre } = req.body;

  if (!especialidad_nombre) {
    return res.status(400).json({ error: "Nombre requerido" });
  }

  const consulta = "INSERT INTO especialidades (especialidad_nombre) VALUES (?)";
  conexion.query(consulta, [especialidad_nombre], (err, resultado) => {
    if (err) {
      console.error("[/especialidad/agregar] Error:", err.message);
      return res.status(500).json({ error: "Error al guardar especialidad" });
    }
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
    if (err) {
      console.error("[/especialidad/actualizar] Error:", err.message);
      return res.status(500).json({ error: "Error al actualizar especialidad" });
    }
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

// ============================ LISTEN ============================
app.listen(PORT, () => {
  console.log("🚀 Servidor corriendo en el puerto " + PORT);
});
