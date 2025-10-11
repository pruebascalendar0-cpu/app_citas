// index.js (tu versión, con Gmail API + hash + reset code)
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 3000;

app.use(bodyParser.json());

/* ================= Gmail API ================= */
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob"
);
oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

function buildMessage({ from, to, subject, html }) {
  const boundary = "foo_bar_baz_qux";
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].join("\r\n");

  const body =
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\r\n" +
    `--${boundary}\r\n` +
    "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
    html + "\r\n" +
    `--${boundary}--`;

  const rfc822 = `${headers}\r\n\r\n${body}`;
  return Buffer.from(rfc822).toString("base64url");
}

async function sendGmail(to, subject, html, category = "noti") {
  const raw = buildMessage({
    from: `Clínica Salud Total <${process.env.GMAIL_USER || process.env.EMAIL_USER}>`,
    to,
    subject,
    html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
        ${html}
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
        <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
      </div>`
  });
  try {
    const r = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw, labelIds: ["SENT"] }
    });
    console.log(`[@mail][${category}] ok id=${r.data.id}`);
  } catch (e) {
    console.error("[@mail] error:", e?.response?.data || e.message);
  }
}

/* ================= MySQL ================= */
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});
conexion.connect(error => {
  if (error) throw error;
  console.log("Conexion exitosa a la base de datos");
});

/* ================= Helpers ================= */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${h}`;
}
function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (!stored.includes(":")) return plain === stored; // retro-compatibilidad (antiguos en texto)
  const [salt, hash] = stored.split(":");
  const test = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return test === hash;
}
function code6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ================= Health ================= */
app.get("/", (req, res) => {
  res.send("Bienvenido a mi servicio web");
});
app.head("/", (req, res) => res.status(200).end());

app.listen(PUERTO, () => {
  console.log("Servidor corriendo en el puerto " + PUERTO);
});

/* ==================== Correos (vía Gmail API) ==================== */
function enviarCorreo(destinatario, fecha, hora) {
  return sendGmail(
    destinatario,
    "Confirmación de tu cita médica",
    `<h2 style="color:#2e86de;">¡Cita médica confirmada!</h2>
     <p>Tu cita ha sido registrada con éxito.</p>
     <p><strong>Fecha:</strong> ${fecha}</p>
     <p><strong>Hora:</strong> ${hora}</p>`
  );
}
function enviarCorreoBienvenida(destinatario, nombre) {
  return sendGmail(
    destinatario,
    "Bienvenido a Clínica Salud Total",
    `<h2 style="color:#2e86de;">¡Bienvenido, ${nombre}!</h2>
     <p>Tu registro en <strong>Clínica Salud Total</strong> fue exitoso.</p>`
  );
}
function enviarCorreoActualizacion(destinatario, fecha, hora) {
  return sendGmail(
    destinatario,
    "Actualización de tu cita médica",
    `<h2 style="color:#f39c12;">¡Cita actualizada!</h2>
     <p><strong>Nueva fecha:</strong> ${fecha}</p>
     <p><strong>Hora:</strong> ${hora}</p>`
  );
}
function enviarCorreoCancelacion(destinatario, fecha, hora) {
  return sendGmail(
    destinatario,
    "Cancelación de tu cita médica",
    `<h2 style="color:#c0392b;">Cita cancelada</h2>
     <p><strong>Fecha:</strong> ${fecha}</p>
     <p><strong>Hora:</strong> ${hora}</p>`
  );
}

/* ================ Usuarios ================ */
app.get("/usuarios", (req, res) => {
  const consulta = "SELECT * FROM usuarios";
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    const obj = {};
    if (rpta.length > 0) {
      obj.listaUsuarios = rpta;
      res.json(obj);
    } else {
      res.json({ mensaje: "no hay registros" });
    }
  });
});

/* Login (usa hash; compatible con contraseñas antiguas en texto) */
app.post("/usuario/login", (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password)
    return res.status(400).json({ mensaje: "Faltan datos" });

  const q = "SELECT * FROM usuarios WHERE usuario_correo = ?";
  conexion.query(q, [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error DB" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    const u = rows[0];
    if (!verifyPassword(password, u.usuario_contrasena)) {
      return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    }
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo
    });
  });
});

app.post("/usuario/agregar", (req, res) => {
  const usuario = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena: hashPassword(req.body.usuario_contrasena)
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

  const consulta = "INSERT INTO usuarios SET ?";
  conexion.query(consulta, usuario, (error) => {
    if (error) {
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
    const nombreCompleto = `${req.body.usuario_nombre} ${req.body.usuario_apellido}`;
    enviarCorreoBienvenida(usuario.usuario_correo, nombreCompleto);
    return res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body;

  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const verificarCorreo = "SELECT * FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  conexion.query(verificarCorreo, [usuario_correo, id], (err, results) => {
    if (err) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (results.length > 0) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

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

/* ======== Reset por código (Gmail API) ======== */
app.post("/usuario/reset/solicitar", (req, res) => {
  const correo = String(req.body?.usuario_correo || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ mensaje: "Correo inválido" });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE LOWER(usuario_correo)=?";
  conexion.query(q, [correo], async (err, rows) => {
    // respuesta genérica por privacidad
    const done = () => res.json({ ok: true, mensaje: "Si el correo existe, se envió un código." });
    if (err) return done();
    if (!rows.length) return done();

    const code = code6();
    const exp = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    const up = "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE id_usuario=?";
    conexion.query(up, [code, exp, rows[0].id_usuario], async (e2) => {
      if (e2) return done();
      await sendGmail(
        correo,
        "Código de verificación - Restablecer contraseña",
        `<h2>Restablecer contraseña</h2>
         <p>Usa este código. <b>Vence en 15 minutos</b>.</p>
         <p style="font-size:22px;letter-spacing:3px;"><b>${code}</b></p>`,
        "reset"
      );
      return done();
    });
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  const correo = String(req.body?.usuario_correo || "").trim().toLowerCase();
  const codigo = String(req.body?.codigo || "").trim();
  const nueva = String(req.body?.nueva_contrasena || "").trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  if (!/^\d{6}$/.test(codigo)) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok: false, mensaje: "Contraseña mínima 6" });

  const q = "SELECT id_usuario, reset_codigo, reset_expires, reset_used FROM usuarios WHERE LOWER(usuario_correo)=?";
  conexion.query(q, [correo], (err, rows) => {
    if (err || !rows.length) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    const r = rows[0];
    if (r.reset_used) return res.status(400).json({ ok: false, mensaje: "Código ya utilizado" });
    if (r.reset_codigo !== codigo) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    if (new Date(r.reset_expires).getTime() < Date.now()) return res.status(400).json({ ok: false, mensaje: "Código vencido" });

    const hashed = hashPassword(nueva);
    const up = "UPDATE usuarios SET usuario_contrasena=?, reset_used=1 WHERE id_usuario=?";
    conexion.query(up, [hashed, r.id_usuario], (e2, r2) => {
      if (e2 || !r2.affectedRows) return res.status(500).json({ ok: false, mensaje: "No se pudo actualizar" });
      res.json({ ok: true, mensaje: "Contraseña actualizada" });
    });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  // conservar endpoint por compatibilidad, pero ya NO enviamos contraseñas
  res.status(410).json({ mensaje: "Usa /usuario/reset/solicitar para recibir un código" });
});

app.post("/usuario/registrar", (req, res) => {
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
    usuario_contrasena: hashPassword(usuario_contrasena),
    usuario_tipo
  };

  const query = "INSERT INTO usuarios SET ?";
  conexion.query(query, nuevoUsuario, (error, resultados) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
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
  const correo = decodeURIComponent(req.params.correo);
  const consulta = "SELECT * FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [correo], (error, rpta) => {
    if (error) return res.status(500).send(error.message);
    if (rpta.length > 0) res.json(rpta[0]);
    else res.status(404).send({ mensaje: "no hay registros" });
  });
});

/* ================ Médicos / Horarios ================ */
app.get("/especialidades", (req, res) => {
  const consulta = "SELECT * FROM especialidades";
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    if (rpta.length > 0) res.json({ listaEspecialidades: rpta });
    else res.json({ mensaje: "no hay registros" });
  });
});

app.get("/horarios/:parametro", (req, res) => {
  const valores = req.params.parametro.split("&");
  const fecha = valores[0];
  const especialidad = valores[1];

  const consulta = `
  SELECT h., 
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
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;

  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });
  }

  const queryHorarioAnterior = `
    SELECT horario_fecha, horario_hora 
    FROM horarios_medicos 
    WHERE id_horario = ?
  `;
  conexion.query(queryHorarioAnterior, [id_horario], (err1, result1) => {
    if (err1 || result1.length === 0) {
      console.error("Error al obtener horario anterior:", err1);
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
    conexion.query(actualizar, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (err3) => {
      if (err3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      res.json({ mensaje: "Horario actualizado correctamente" });
    });
  });
});

app.post("/horario/registrar", (req, res) => {
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
      if (error.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: resultado.insertId });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
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
  const { id_medico, fecha, id_especialidad } = req.params;
  const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const consulta = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ?
  `;
  conexion.query(consulta, [id_medico, fecha, id_especialidad], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error al consultar horarios" });
    const horasOcupadas = resultados.map(r => r.hora);
    const horasDisponibles = todasLasHoras.filter(hora => !horasOcupadas.includes(hora));
    res.json({ horariosDisponibles: horasDisponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
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
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    const horarios = results.map(row => row.horario_hora);
    res.json({ horarios });
  });
});

/* ================ Citas ================ */
app.post("/cita/agregar", (req, res) => {
  console.log("Datos recibidos:", req.body);
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;

  const consultaOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(consultaOrden, [id_usuario], (error, results) => {
    if (error) return res.status(500).json({ error: "Error interno al calcular el número de orden" });
    const numero_orden = results[0].total + 1;

    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };
    const consultaInsert = "INSERT INTO citas SET ?";
    conexion.query(consultaInsert, cita, (errorInsert) => {
      if (errorInsert) return res.status(500).json({ error: "Error al registrar la cita" });

      const marcarHorario = `
        UPDATE horarios_medicos SET horario_estado = 1 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(marcarHorario, [cita_fecha, cita_hora, id_medico], () => {});

      const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
      conexion.query(consultaCorreo, [id_usuario], (errorCorreo, resultsCorreo) => {
        if (!errorCorreo && resultsCorreo.length) {
          const destinatario = resultsCorreo[0].usuario_correo;
          enviarCorreo(destinatario, cita_fecha, cita_hora);
        }
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  const queryCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
  conexion.query(queryCorreo, [id_usuario], (errCorreo, results) => {
    if (errCorreo || results.length === 0) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const usuario_correo = results[0].usuario_correo;

    const queryHorarioAnterior = `SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?`;
    conexion.query(queryHorarioAnterior, [id], (err1, result1) => {
      if (err1) return res.status(500).json({ mensaje: "Error interno al obtener horario anterior" });
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
        enviarCorreoActualizacion(usuario_correo, cita_fecha, cita_hora);
        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const { id_medico, fecha, hora } = req.params;
  const { accion, nuevaHora, id_especialidad } = req.body;

  if (!accion || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos" });

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
  } else {
    res.status(400).json({ mensaje: "Acción no reconocida" });
  }
});

app.get("/horarios/:fecha/:id_especialidad", (req, res) => {
  const { fecha, id_especialidad } = req.params;
  const sql = `
    SELECT * FROM horarios_medicos 
    WHERE horario_fecha = ? AND id_especialidad = ? AND horario_estado = 0
  `;
  conexion.query(sql, [fecha, id_especialidad], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error al obtener horarios" });
    res.status(200).json({ listaHorarios: rows });
  });
});

app.get("/citas/por-dia", (req, res) => {
  const consulta = `
    SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY DATE(cita_fecha)
    ORDER BY DATE(cita_fecha) ASC
  `;
  conexion.query(consulta, (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: resultados.map(r => ({ fecha: r.fecha, cantidad: Number(r.cantidad) })) });
  });
});

app.put("/cita/estado/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body;
  const sql = "UPDATE citas SET cita_estado = ? WHERE id_cita = ?";
  conexion.query(sql, [nuevo_estado, id_cita], (err) => {
    if (err) return res.status(500).json({ mensaje: "Error al actualizar estado" });
    res.json({ mensaje: "Estado actualizado correctamente" });
  });
});

app.get("/citas/:usuario", (req, res) => {
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

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const consulta = `
    SELECT 
      cit.id_cita AS IdCita,
      CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
      DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d') AS FechaCita,
      TIME_FORMAT(cit.cita_hora,'%H:%i') AS HoraCita,
      CASE 
          WHEN cit.cita_estado = 1 THEN 'Confirmada'
          WHEN cit.cita_estado = 0 THEN 'Cancelada'
          ELSE 'Desconocido'
      END AS EstadoCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario = cit.id_usuario
    INNER JOIN medicos m ON m.id_medico = cit.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_usuario = ? AND cit.numero_orden = ?
  `;
  conexion.query(consulta, [id_usuario, numero_orden], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (results.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const consulta = `
    SELECT c.id_cita, c.id_usuario,
           us.usuario_nombre AS paciente_nombre, us.usuario_apellido AS paciente_apellido,
           DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre,
           c.cita_estado
    FROM citas c
    INNER JOIN usuarios us ON c.id_usuario = us.id_usuario
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_medico = ?
    ORDER BY c.id_cita ASC
  `;
  conexion.query(consulta, [id_medico], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    const listaNumerada = rpta.map((cita, index) => ({ ...cita, numero_orden: index + 1 }));
    res.json({ listaCitas: listaNumerada });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const consultaDatosCita = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita = ?";
  conexion.query(consultaDatosCita, [id_cita], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error al obtener los datos de la cita" });
    if (!resultados.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico, id_usuario } = resultados[0];
    const consultaCancelar = "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?";
    conexion.query(consultaCancelar, [id_cita], (error2) => {
      if (error2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const consultaLiberarHorario = `
        UPDATE horarios_medicos 
        SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
          if (!e3 && r3.length) enviarCorreoCancelacion(r3[0].usuario_correo, cita_fecha, cita_hora);
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;

  const consultaBuscarCita = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario = ? AND numero_orden = ? AND cita_estado = 1
  `;
  conexion.query(consultaBuscarCita, [id_usuario, numero_orden], (err, resultados) => {
    if (err) return res.status(500).json({ error: "Error al buscar la cita" });
    if (!resultados.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = resultados[0];
    const consultaCancelar = "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?";
    conexion.query(consultaCancelar, [id_cita], (err2) => {
      if (err2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const consultaLiberarHorario = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], (err4, rpta) => {
          if (!err4 && rpta.length) enviarCorreoCancelacion(rpta[0].usuario_correo, cita_fecha, cita_hora);
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

app.get("/citas", (req, res) => {
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
  const consulta = "SELECT * FROM medicos";
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    if (rpta.length > 0) res.json({ listaCitas: rpta });
    else res.json({ mensaje: "no hay registros" });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  const consulta = "INSERT INTO especialidades (especialidad_nombre) VALUES (?)";
  conexion.query(consulta, [especialidad_nombre], (err) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  const sql = "UPDATE especialidades SET especialidad_nombre = ? WHERE id_especialidad = ?";
  conexion.query(sql, [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});
