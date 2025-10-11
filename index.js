/* index.js */
require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// =======================
// Config básica del app
// =======================
const app = express();
const PUERTO = process.env.PORT || 3000;

app.use(bodyParser.json());

// ==== Logger mínimo con ID de request ====
function genReqId() {
  return `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}
app.use((req, res, next) => {
  req.id = genReqId();
  const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress || "";
  console.log(`[REQ ${req.id}] ${req.method} ${req.originalUrl} ← ${ip}`);
  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      console.log(`[REQ ${req.id}] body  : ${JSON.stringify(req.body, null, 2)}`);
    } catch {
      console.log(`[REQ ${req.id}] body  : <no-serializable>`);
    }
  }
  const start = Date.now();
  res.on("finish", () => {
    const dur = Date.now() - start;
    console.log(`[RES ${req.id}] status=${res.statusCode} dur=${dur}ms`);
  });
  next();
});

console.log(`Servidor corriendo en el puerto ${PUERTO}`);

// =======================
// Mailer
// =======================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Helpers de correo (con logs)
function enviarCorreo(destinatario, fecha, hora) {
  const mailOptions = {
    from: '"Clínica Salud Total" <appclinicaprueba@gmail.com>',
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
      </footer>`,
  };

  console.log(`[MAIL] → to=${destinatario}, subject="${mailOptions.subject}", category=citas-confirmacion`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log(`[MAIL] ERROR: ${error.message}`);
    else console.log(`[MAIL] OK: ${info.response || info.messageId || "enviado"}`);
  });
}

function enviarCorreoBienvenida(destinatario, nombre) {
  const mailOptions = {
    from: '"Clínica Salud Total" <appclinicaprueba@gmail.com>',
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
      </footer>`,
  };

  console.log(`[MAIL] → to=${destinatario}, subject="${mailOptions.subject}", category=welcome`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log(`[MAIL] ERROR: ${error.message}`);
    else console.log(`[MAIL] OK: ${info.response || info.messageId || "enviado"}`);
  });
}

function enviarCorreoRecuperacion(destinatario, nombre, contrasena) {
  const mailOptions = {
    from: '"Clínica Salud Total" <appclinicaprueba@gmail.com>',
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
      </footer>`,
  };

  console.log(`[MAIL] → to=${destinatario}, subject="${mailOptions.subject}", category=reset`);
  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log(`[MAIL] ERROR: ${error.message}`);
        reject(error);
      } else {
        console.log(`[MAIL] OK: ${info.response || info.messageId || "enviado"}`);
        resolve(info);
      }
    });
  });
}

function enviarCorreoActualizacion(destinatario, fecha, hora) {
  const mailOptions = {
    from: '"Clínica Salud Total" <appclinicaprueba@gmail.com>',
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
      </footer>`,
  };

  console.log(`[MAIL] → to=${destinatario}, subject="${mailOptions.subject}", category=citas-actualizacion`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log(`[MAIL] ERROR: ${error.message}`);
    else console.log(`[MAIL] OK: ${info.response || info.messageId || "enviado"}`);
  });
}

function enviarCorreoCancelacion(destinatario, fecha, hora) {
  const mailOptions = {
    from: '"Clínica Salud Total" <appclinicaprueba@gmail.com>',
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
      </footer>`,
  };

  console.log(`[MAIL] → to=${destinatario}, subject="${mailOptions.subject}", category=citas-cancelacion`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) console.log(`[MAIL] ERROR: ${error.message}`);
    else console.log(`[MAIL] OK: ${info.response || info.messageId || "enviado"}`);
  });
}

// =======================
// MySQL
// =======================
const DEBUG_SQL = String(process.env.DEBUG_SQL || "0") === "1";
console.log(`DEBUG_SQL=${DEBUG_SQL ? "ON" : "OFF"} (exporta DEBUG_SQL=1 para ver sentencias)`);

const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: false,
  timezone: "Z", // manejamos TZ con SET time_zone
});

conexion.connect((error) => {
  if (error) {
    console.error("[DB] ERROR Conexión:", error.message);
    process.exit(1);
  }
  console.log("[DB] Conexión exitosa");

  const tz = process.env.DB_TZ || "-05:00"; // ajusta a tu región
  conexion.query("SET time_zone = ?", [tz], (err) => {
    if (err) console.error("[DB] ERROR al setear time_zone:", err.message);
    else console.log("[DB] time_zone =", tz);
  });
});

// Wrapper con logs SQL
function dbq(reqId, sql, params, cb) {
  if (DEBUG_SQL) {
    console.log(`[SQL ${reqId}]`, sql.trim().replace(/\s+/g, " "));
    if (params && params.length) console.log(`[SQL ${reqId}] params=`, JSON.stringify(params));
  }
  conexion.query(sql, params, (err, rpta) => {
    if (err) console.error(`[SQL ${reqId}] ERROR:`, err.message);
    else if (DEBUG_SQL) console.log(`[SQL ${reqId}] OK rows=${Array.isArray(rpta) ? rpta.length : rpta.affectedRows}`);
    cb(err, rpta);
  });
}

// =======================
// Utils fecha/hora
// =======================
function normFecha(input) {
  if (!input) return input;
  let s = String(input).trim();
  if (s.includes("T")) s = s.slice(0, 10);            // ISO → YYYY-MM-DD
  s = s.replace(/\//g, "-");                          // YYYY/MM/DD → YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}
function normHora(input) {
  if (!input) return input;
  const s = String(input).trim().slice(0, 5); // HH:mm
  return s;
}

// =======================
// Rutas básicas
// =======================
app.get("/", (req, res) => {
  console.log(`[LOG ${req.id}] GET / -> Bienvenido`);
  res.send("Bienvenido a mi servicio web");
});

// =======================
// Auth (login con hash salt:sha256(salt+pwd))
// =======================
function verifyPassword(stored, rawPwd) {
  if (!stored || !rawPwd) return false;
  const [salt, hexdigest] = String(stored).split(":");
  if (!salt || !hexdigest) return false;
  const calc = crypto.createHash("sha256").update(salt + rawPwd).digest("hex");
  return calc.toLowerCase() === hexdigest.toLowerCase();
}

app.post("/usuario/login", (req, res) => {
  const { usuario_correo, password } = req.body || {};
  console.log(`[LOG ${req.id}] POST /usuario/login correo=${usuario_correo}`);

  const sql = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo = ?";
  dbq(req.id, sql, [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error al consultar usuario" });
    if (!rows || rows.length === 0) return res.status(401).json({ mensaje: "Credenciales inválidas" });

    const u = rows[0];
    const ok = verifyPassword(u.usuario_contrasena_hash, password);
    console.log(`[LOG ${req.id}] login verify=${ok}`);
    if (!ok) return res.status(401).json({ mensaje: "Credenciales inválidas" });

    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_tipo: u.usuario_tipo,
    });
  });
});

// =======================
// Usuarios
// =======================
app.get("/usuarios", (req, res) => {
  console.log(`[LOG ${req.id}] GET /usuarios`);
  const consulta = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo FROM usuarios ORDER BY id_usuario ASC";
  dbq(req.id, consulta, [], (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error al listar usuarios" });
    const obj = {};
    if (rpta.length > 0) {
      obj.listaUsuarios = rpta;
      console.log(`[LOG ${req.id}] /usuarios -> ${rpta.length} registros`);
      res.json(obj);
    } else {
      console.log(`[LOG ${req.id}] /usuarios -> sin registros`);
      res.json({ mensaje: "no hay registros" });
    }
  });
});

app.post("/usuario/agregar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/agregar`);
  const usuario = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena_hash: req.body.usuario_contrasena_hash, // espera ya en formato salt:hash
    usuario_tipo: 1,
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
  if (!usuario.usuario_contrasena_hash || !usuario.usuario_contrasena_hash.includes(":")) {
    return res.status(400).json({ mensaje: "Falta hash de contraseña en formato 'salt:sha256'." });
  }

  const consulta = "INSERT INTO usuarios SET ?";
  dbq(req.id, consulta, usuario, (error) => {
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
    enviarCorreoBienvenida(usuario.usuario_correo, `${usuario.usuario_nombre} ${usuario.usuario_apellido}`);
    return res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body;
  console.log(`[LOG ${req.id}] PUT /usuario/actualizar/${id}`);

  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const verificarCorreo = "SELECT 1 FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  dbq(req.id, verificarCorreo, [usuario_correo, id], (err, results) => {
    if (err) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (results.length > 0) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const actualizarUsuario = `
      UPDATE usuarios SET 
      usuario_nombre = ?, 
      usuario_apellido = ?, 
      usuario_correo = ?
      WHERE id_usuario = ?
    `;
    dbq(req.id, actualizarUsuario, [usuario_nombre, usuario_apellido, usuario_correo, id], (error) => {
      if (error) return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      res.status(200).json({ mensaje: "Usuario actualizado correctamente" });
    });
  });
});

app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  console.log(`[LOG ${req.id}] POST /usuario/recuperar-correo dni=${usuario_dni}`);

  const consulta = `
    SELECT usuario_correo FROM usuarios
    WHERE usuario_dni = ? AND usuario_nombre = ? AND usuario_apellido = ?
  `;
  dbq(req.id, consulta, [usuario_dni, usuario_nombre, usuario_apellido], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: resultados[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  const { usuario_correo } = req.body;
  console.log(`[LOG ${req.id}] POST /usuario/recuperar-contrasena correo=${usuario_correo}`);

  const consulta = "SELECT usuario_nombre, usuario_apellido, usuario_contrasena_hash FROM usuarios WHERE usuario_correo = ?";
  dbq(req.id, consulta, [usuario_correo], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Correo no registrado" });

    const usuario = resultados[0];
    // Por seguridad real, NO deberías enviar contraseñas; aquí mantenemos tu comportamiento previo
    // Si tienes contraseña en claro en otra columna, cámbialo aquí.
    enviarCorreoRecuperacion(
      usuario_correo,
      `${usuario.usuario_nombre} ${usuario.usuario_apellido}`,
      usuario.usuario_contrasena_hash // (ojo) aquí va el hash porque no hay plaintext
    );
    res.json({ mensaje: "Correo de recuperación enviado" });
  });
});

// =======================
// Especialidades / Médicos
// =======================
app.get("/especialidades", (req, res) => {
  console.log(`[LOG ${req.id}] GET /especialidades`);
  const consulta = "SELECT * FROM especialidades ORDER BY id_especialidad ASC";
  dbq(req.id, consulta, [], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[LOG ${req.id}] /especialidades -> ${rpta.length} registros`);
    res.json({ listaEspecialidades: rpta });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  console.log(`[LOG ${req.id}] GET /medico/${id_medico}/especialidades`);
  const consulta = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?
  `;
  dbq(req.id, consulta, [id_medico], (err, rpta) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: rpta });
  });
});

// =======================
// Horarios
// =======================
app.get("/horarios/:parametro", (req, res) => {
  console.log(`[LOG ${req.id}] GET /horarios/${req.params.parametro}`);
  const [fechaRaw, especialidad] = (req.params.parametro || "").split("&");
  const fecha = normFecha(decodeURIComponent(fechaRaw));

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
    WHERE h.horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC
  `;

  dbq(req.id, consulta, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[LOG ${req.id}] /horarios fecha=${fecha} esp=${especialidad} -> ${rpta.length} filas`);
    res.json({ listaHorarios: rpta });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = normFecha(decodeURIComponent(req.params.fecha));
  console.log(`[LOG ${req.id}] GET /horarios/disponibles/${id_medico}/${fecha}/${id_especialidad}`);

  const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);

  const consulta = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico = ? AND horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad = ?
  `;

  dbq(req.id, consulta, [id_medico, fecha, id_especialidad], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error al consultar horarios" });

    const horasOcupadas = resultados.map((r) => r.hora);
    const horasDisponibles = todasLasHoras.filter((h) => !horasOcupadas.includes(h));
    console.log(`[LOG ${req.id}] Horas disponibles -> ${JSON.stringify(horasDisponibles)}`);
    res.json({ horariosDisponibles: horasDisponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = normFecha(decodeURIComponent(req.params.fecha));
  console.log(`[LOG ${req.id}] GET /horarios/registrados/${id_medico}/${fecha}/${id_especialidad}`);

  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora
    FROM horarios_medicos 
    WHERE id_medico = ? 
      AND horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') 
      AND id_especialidad = ?
      AND horario_estado = 0
    ORDER BY horario_hora ASC
  `;

  dbq(req.id, sql, [id_medico, fecha, id_especialidad], (err, results) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    const horarios = results.map((row) => row.horario_hora);
    console.log(`[LOG ${req.id}] horarios registrados -> ${JSON.stringify(horarios)}`);
    res.json({ horarios });
  });
});

app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const { id_medico } = req.params;
  const fecha = normFecha(decodeURIComponent(req.params.fecha));
  const hora = normHora(decodeURIComponent(req.params.hora));
  const { accion, nuevaHora, id_especialidad } = req.body || {};
  console.log(
    `[LOG ${req.id}] PUT /horario/editar id_medico=${id_medico} fecha=${fecha} hora=${hora} accion=${accion} id_especialidad=${id_especialidad} nuevaHora=${nuevaHora}`
  );

  if (!accion) return res.status(400).json({ mensaje: "accion requerida (ocupar|liberar|actualizar)" });

  if (accion === "ocupar") {
    const q = `
      UPDATE horarios_medicos
      SET horario_estado = 1
      WHERE id_medico = ?
        AND horario_fecha = STR_TO_DATE(?, '%Y-%m-%d')
        AND horario_hora  = STR_TO_DATE(?, '%H:%i')
    `;
    dbq(req.id, q, [id_medico, fecha, hora], (err, r) => {
      if (err) return res.status(500).json({ mensaje: "Error al ocupar" });
      if (r.affectedRows === 0) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Horario ocupado correctamente" });
    });
  } else if (accion === "liberar") {
    const q = `
      UPDATE horarios_medicos
      SET horario_estado = 0
      WHERE id_medico = ?
        AND horario_fecha = STR_TO_DATE(?, '%Y-%m-%d')
        AND horario_hora  = STR_TO_DATE(?, '%H:%i')
    `;
    dbq(req.id, q, [id_medico, fecha, hora], (err, r) => {
      if (err) return res.status(500).json({ mensaje: "Error al liberar" });
      if (r.affectedRows === 0) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Horario liberado correctamente" });
    });
  } else if (accion === "actualizar") {
    if (!nuevaHora || !id_especialidad) {
      return res.status(400).json({ mensaje: "Para actualizar, envía nuevaHora y id_especialidad" });
    }
    const q = `
      UPDATE horarios_medicos
      SET horario_hora = STR_TO_DATE(?, '%H:%i'),
          horario_estado = 0,
          id_especialidad = ?
      WHERE id_medico = ?
        AND horario_fecha = STR_TO_DATE(?, '%Y-%m-%d')
        AND horario_hora  = STR_TO_DATE(?, '%H:%i')
    `;
    dbq(req.id, q, [normHora(nuevaHora), id_especialidad, id_medico, fecha, hora], (err, r) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ mensaje: "Ese horario ya existe para el médico" });
        return res.status(500).json({ mensaje: "Error al actualizar horario" });
      }
      if (r.affectedRows === 0) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Horario actualizado correctamente" });
    });
  } else {
    return res.status(400).json({ mensaje: "Acción no reconocida (usa ocupar|liberar|actualizar)" });
  }
});

app.post("/horario/registrar", (req, res) => {
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;
  const fecha = normFecha(horario_fecha);
  const hora = normHora(horario_horas);
  console.log(`[LOG ${req.id}] POST /horario/registrar id_medico=${id_medico} fecha=${fecha} hora=${hora} esp=${id_especialidad}`);

  if (!id_medico || !hora || !fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  const horario_estado = 0;

  const consulta = `
    INSERT INTO horarios_medicos 
      (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, STR_TO_DATE(?, '%H:%i'), STR_TO_DATE(?, '%Y-%m-%d'), ?, ?)
  `;

  dbq(req.id, consulta, [id_medico, hora, fecha, horario_estado, id_especialidad], (error, resultado) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: resultado.insertId });
  });
});

// =======================
// Citas
// =======================
app.post("/cita/agregar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /cita/agregar body=${JSON.stringify(req.body, null, 2)}`);
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;
  cita_fecha = normFecha(cita_fecha);
  cita_hora = normHora(cita_hora);

  const consultaOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  dbq(req.id, consultaOrden, [id_usuario], (error, results) => {
    if (error) return res.status(500).json({ error: "Error interno al calcular el número de orden" });

    const numero_orden = results[0].total + 1;
    const consultaInsert = `
      INSERT INTO citas (id_usuario,id_medico,numero_orden,cita_fecha,cita_hora,cita_estado)
      VALUES (?, ?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), 1)
    `;

    dbq(req.id, consultaInsert, [id_usuario, id_medico, numero_orden, cita_fecha, cita_hora], (errorInsert) => {
      if (errorInsert) return res.status(500).json({ error: "Error al registrar la cita" });

      const marcarHorario = `
        UPDATE horarios_medicos SET horario_estado = 1 
        WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?
      `;
      dbq(req.id, marcarHorario, [cita_fecha, cita_hora, id_medico], (errUpdate) => {
        if (errUpdate) console.warn(`[LOG ${req.id}] No se pudo marcar el horario como ocupado: ${errUpdate.message}`);
      });

      const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
      dbq(req.id, consultaCorreo, [id_usuario], (errorCorreo, resultsCorreo) => {
        if (errorCorreo) return res.status(500).json({ error: "Error interno al obtener el correo" });
        if (resultsCorreo.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        const destinatario = resultsCorreo[0].usuario_correo;
        enviarCorreo(destinatario, cita_fecha, cita_hora);
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;
  cita_fecha = normFecha(cita_fecha);
  cita_hora = normHora(cita_hora);
  console.log(`[LOG ${req.id}] PUT /cita/actualizar/${id}`);

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  const queryCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
  dbq(req.id, queryCorreo, [id_usuario], (errCorreo, results) => {
    if (errCorreo || results.length === 0) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });

    const usuario_correo = results[0].usuario_correo;

    const queryHorarioAnterior = `SELECT cita_fecha, cita_hora, id_medico FROM citas WHERE id_cita = ?`;
    dbq(req.id, queryHorarioAnterior, [id], (err1, result1) => {
      if (err1 || result1.length === 0) return res.status(500).json({ mensaje: "Error interno al obtener horario anterior" });

      const horarioAnterior = result1[0];
      const liberar = `
        UPDATE horarios_medicos SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      dbq(req.id, liberar, [horarioAnterior.cita_fecha, horarioAnterior.cita_hora, horarioAnterior.id_medico], (err2) => {
        if (err2) console.warn(`[LOG ${req.id}] No se pudo liberar el horario anterior: ${err2.message}`);
      });

      const sql = `
        UPDATE citas SET 
          id_usuario = ?, 
          id_medico = ?, 
          cita_fecha = STR_TO_DATE(?, '%Y-%m-%d'), 
          cita_hora = STR_TO_DATE(?, '%H:%i'), 
          cita_estado = ?
        WHERE id_cita = ?
      `;
      dbq(req.id, sql, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], (err3) => {
        if (err3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const ocupar = `
          UPDATE horarios_medicos SET horario_estado = 1 
          WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?
        `;
        dbq(req.id, ocupar, [cita_fecha, cita_hora, id_medico], (err4) => {
          if (err4) console.warn(`[LOG ${req.id}] No se pudo marcar el nuevo horario como ocupado: ${err4.message}`);
        });

        enviarCorreoActualizacion(usuario_correo, cita_fecha, cita_hora);
        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.get("/citas/por-dia", (req, res) => {
  console.log(`[LOG ${req.id}] GET /citas/por-dia`);
  const consulta = `
    SELECT 
      cita_fecha AS fecha, 
      COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY cita_fecha
    ORDER BY cita_fecha ASC
  `;
  dbq(req.id, consulta, [], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error en la base de datos" });

    const datos = resultados.map((row) => ({
      fecha: row.fecha.toISOString().slice(0, 10),
      cantidad: row.cantidad,
    }));
    console.log(`[LOG ${req.id}] /citas/por-dia -> ${JSON.stringify(datos)}`);
    res.json({ listaCitas: datos });
  });
});

app.put("/cita/estado/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body;
  console.log(`[LOG ${req.id}] PUT /cita/estado/${id_cita} nuevo_estado=${nuevo_estado}`);

  const sql = "UPDATE citas SET cita_estado = ? WHERE id_cita = ?";
  dbq(req.id, sql, [nuevo_estado, id_cita], (err) => {
    if (err) return res.status(500).json({ mensaje: "Error al actualizar estado" });
    res.json({ mensaje: "Estado actualizado correctamente" });
  });
});

app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  console.log(`[LOG ${req.id}] GET /citas/${usuario}`);
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
  dbq(req.id, consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error al obtener citas" });
    const citasNumeradas = rpta.map((cita, index) => ({ ...cita, numero_orden: index + 1 }));
    console.log(`[LOG ${req.id}] /citas/${usuario} -> ${citasNumeradas.length} citas`);
    res.json({ listaCitas: citasNumeradas });
  });
});

app.get("/citamedica/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  console.log(`[LOG ${req.id}] GET /citamedica/${id_cita}`);
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
  dbq(req.id, consulta, [id_cita], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (results.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  console.log(`[LOG ${req.id}] GET /cita/usuario/${id_usuario}/orden/${numero_orden}`);
  const consulta = `
    SELECT 
      cit.id_cita AS IdCita,
      CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
      cit.cita_fecha AS FechaCita,
      cit.cita_hora AS HoraCita,
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
  dbq(req.id, consulta, [id_usuario, numero_orden], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (results.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

app.get("/citas", (req, res) => {
  console.log(`[LOG ${req.id}] GET /citas`);
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
  dbq(req.id, consulta, [], (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error al obtener las citas" });
    console.log(`[LOG ${req.id}] /citas -> ${rpta.length} filas`);
    res.json({ listaCitas: rpta });
  });
});

app.get("/medicos", (req, res) => {
  console.log(`[LOG ${req.id}] GET /medicos`);
  const consulta = "SELECT * FROM medicos";
  dbq(req.id, consulta, [], (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error al obtener médicos" });
    console.log(`[LOG ${req.id}] /medicos -> ${rpta.length} registros`);
    res.json({ listaCitas: rpta });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body;
  console.log(`[LOG ${req.id}] POST /especialidad/agregar nombre=${especialidad_nombre}`);

  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });

  const consulta = "INSERT INTO especialidades (especialidad_nombre) VALUES (?)";
  dbq(req.id, consulta, [especialidad_nombre], (err) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body;
  console.log(`[LOG ${req.id}] PUT /especialidad/actualizar/${id} nombre=${especialidad_nombre}`);

  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });

  const sql = "UPDATE especialidades SET especialidad_nombre = ? WHERE id_especialidad = ?";
  dbq(req.id, sql, [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

// =======================
// Start
// =======================
app.listen(PUERTO, () => {
  console.log(`Servidor corriendo en el puerto ${PUERTO}`);
});
