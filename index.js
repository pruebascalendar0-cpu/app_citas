// index.js con LOGS en todos los endpoints
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const sg = require("@sendgrid/mail");

// ===================== CONFIG APP =====================
const app = express();
const PUERTO = process.env.PORT || 3000;
app.use(express.json());

// ===================== LOGGER =========================
function genId() {
  try { return crypto.randomUUID(); } catch { return (Date.now() + Math.random()).toString(36); }
}
function mask(obj) {
  try {
    const s = JSON.stringify(obj, (k, v) => {
      if (typeof v === "string" && /pass|contrasena|password|token|apikey|clave/i.test(k)) return "***";
      return v;
    }, 2);
    return s;
  } catch { return String(obj); }
}
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || genId();
  req._start = process.hrtime.bigint();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  console.log(`[REQ ${req.id}] ${req.method} ${req.originalUrl} ← ${ip}`);
  if (Object.keys(req.params||{}).length) console.log(`[REQ ${req.id}] params: ${mask(req.params)}`);
  if (Object.keys(req.query||{}).length)  console.log(`[REQ ${req.id}] query : ${mask(req.query)}`);
  if (Object.keys(req.body||{}).length)   console.log(`[REQ ${req.id}] body  : ${mask(req.body)}`);

  const end = res.end;
  res.end = function (...args) {
    const durMs = Number((process.hrtime.bigint() - req._start) / 1000000n);
    console.log(`[RES ${req.id}] status=${res.statusCode} dur=${durMs}ms`);
    end.apply(this, args);
  };
  next();
});

// ===================== EMAIL ==========================
sg.setApiKey(process.env.SENDGRID_API_KEY || "");
function FROM() { return process.env.EMAIL_FROM || "Clínica Salud Total <pruebascalendar0@gmail.com>"; }
function REPLY_TO() { return process.env.REPLY_TO || "pruebascalendar0@gmail.com"; }
function listUnsubHeaders() {
  const items = [];
  if (process.env.UNSUB_MAILTO) items.push(`<mailto:${process.env.UNSUB_MAILTO}>`);
  if (process.env.UNSUB_URL) items.push(`<${process.env.UNSUB_URL}>`);
  return items.length ? { "List-Unsubscribe": items.join(", ") } : undefined;
}
async function enviarMail({ reqId, to, subject, html, text, category = "notificaciones" }) {
  const headers = listUnsubHeaders();
  const msg = {
    from: FROM(),
    to,
    subject,
    html,
    text: text || html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    replyTo: REPLY_TO(),
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false },
    },
    mailSettings: { sandboxMode: { enable: process.env.SENDGRID_SANDBOX === "true" } },
    categories: [category],
    headers,
  };
  console.log(`[MAIL ${reqId}] → to=${to}, subject="${subject}", category=${category}`);
  try {
    const r = await sg.send(msg);
    console.log(`[MAIL ${reqId}] OK: ${r[0]?.statusCode}`);
  } catch (err) {
    if (err.response?.body) console.error(`[MAIL ${reqId}] ERROR:`, JSON.stringify(err.response.body, null, 2));
    else console.error(`[MAIL ${reqId}] ERROR:`, err);
  }
}
function tplWrapper(innerHtml) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${innerHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;
}

// ===================== HASH ===========================
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(plain, stored) {
  const [salt, hash] = stored.includes(":") ? stored.split(":") : ["", stored];
  const test = crypto.createHash("sha256").update((salt || "") + plain).digest("hex");
  return test === hash;
}
function generarPasswordTemporal(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*";
  return Array.from(crypto.randomFillSync(new Uint8Array(len))).map(b => chars[b % chars.length]).join("");
}
function generarCodigo(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomFillSync(new Uint8Array(len))).map(b => chars[b % chars.length]).join("");
}
function toYYYYMMDD(val) {
  if (!val) return val;
  if (typeof val === "string" && val.includes("T")) return val.slice(0, 10);
  return String(val).slice(0, 10);
}

// ===================== DB =============================
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: false
});

conexion.connect((error) => {
  if (error) {
    console.error("[DB] ERROR al conectar:", error?.message || error);
    process.exit(1);
  }
  console.log("[DB] Conexión exitosa");
  conexion.query("SET time_zone = '-05:00'", (e) => {
    if (e) console.error("[DB] No se pudo fijar time_zone:", e.message);
    else console.log("[DB] time_zone = -05:00");
  });
});

// Wrapper con logs
function dbq(reqId, sql, params, cb) {
  const showSql = !!Number(process.env.DEBUG_SQL || "0");
  const start = process.hrtime.bigint();
  if (showSql) console.log(`[SQL  ${reqId}] ${sql.trim().replace(/\s+/g, " ")} | params=${mask(params)}`);
  conexion.query(sql, params, (err, rows) => {
    const dur = Number((process.hrtime.bigint() - start) / 1000000n);
    if (err) {
      console.error(`[SQL  ${reqId}] ERROR (${dur}ms):`, err.message);
      return cb(err);
    }
    if (showSql) console.log(`[SQL  ${reqId}] OK (${dur}ms) rows=${Array.isArray(rows)?rows.length: (rows?.affectedRows ?? '-')}`);
    cb(null, rows);
  });
}

// ===================== RUTAS ==========================
app.get("/", (req, res) => {
  console.log(`[LOG ${req.id}] GET /`);
  res.send("Bienvenido a mi servicio web");
});

app.get("/health", (req, res) => {
  console.log(`[LOG ${req.id}] GET /health`);
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------- Correos helpers ----------
async function enviarCorreo(reqId, destinatario, fecha, hora) {
  await enviarMail({
    reqId, to: destinatario, subject: "Confirmación de tu cita médica",
    html: tplWrapper(`<h2 style="margin:0 0 8px 0;">Cita confirmada</h2><p><b>Fecha:</b> ${fecha}<br/><b>Hora:</b> ${hora}</p>`),
    text: `Cita confirmada. Fecha: ${fecha}. Hora: ${hora}.`,
    category: "citas-confirmacion",
  });
}
async function enviarCorreoBienvenida(reqId, destinatario, nombre) {
  await enviarMail({
    reqId, to: destinatario, subject: "Bienvenido a Clínica Salud Total",
    html: tplWrapper(`<h2>¡Bienvenido, ${nombre}!</h2><p>Registro exitoso.</p>`),
    text: `Bienvenido, ${nombre}.`,
    category: "bienvenida",
  });
}
async function enviarCorreoRecuperacion(reqId, destinatario, nombre, nuevaClaveTemporal) {
  await enviarMail({
    reqId, to: destinatario, subject: "Restablecimiento de contraseña",
    html: tplWrapper(`<h2>Contraseña temporal</h2><p>Hola ${nombre}, tu clave temporal es: <b>${nuevaClaveTemporal}</b></p>`),
    text: `Contraseña temporal: ${nuevaClaveTemporal}`,
    category: "recuperacion",
  });
}
async function enviarCorreoActualizacion(reqId, destinatario, fecha, hora) {
  await enviarMail({
    reqId, to: destinatario, subject: "Actualización de tu cita médica",
    html: tplWrapper(`<h2>Cita actualizada</h2><p><b>Nueva fecha:</b> ${fecha}<br/><b>Hora:</b> ${hora}</p>`),
    text: `Cita actualizada. ${fecha} ${hora}`,
    category: "citas-actualizacion",
  });
}
async function enviarCorreoCancelacion(reqId, destinatario, fecha, hora) {
  await enviarMail({
    reqId, to: destinatario, subject: "Cancelación de tu cita médica",
    html: tplWrapper(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${fecha}<br/><b>Hora:</b> ${hora}</p>`),
    text: `Cita cancelada. ${fecha} ${hora}`,
    category: "citas-cancelacion",
  });
}

// ---------- Usuarios ----------
app.get("/usuarios", (req, res) => {
  console.log(`[LOG ${req.id}] GET /usuarios`);
  const sql = "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios";
  dbq(req.id, sql, [], (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: error.message });
    const obj = rpta.length ? { listaUsuarios: rpta } : { mensaje: "no hay registros" };
    console.log(`[LOG ${req.id}] /usuarios -> ${rpta.length} filas`);
    res.json(obj);
  });
});

app.post("/usuario/login", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/login`);
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) {
    console.warn(`[LOG ${req.id}] login faltan datos`);
    return res.status(400).json({ mensaje: "Correo y password requeridos" });
  }
  const sql = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo = ?";
  dbq(req.id, sql, [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "DB error" });
    if (!rows.length) {
      console.warn(`[LOG ${req.id}] login correo no registrado`);
      return res.status(404).json({ mensaje: "Correo no registrado" });
    }
    const u = rows[0];
    const ok = verifyPassword(password, u.usuario_contrasena_hash || "");
    console.log(`[LOG ${req.id}] login verify=${ok}`);
    if (!ok) return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    res.json({
      id_usuario: u.id_usuario, usuario_nombre: u.usuario_nombre, usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo, usuario_tipo: u.usuario_tipo,
    });
  });
});

app.post("/usuario/agregar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/agregar`);
  const u = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena: req.body.usuario_contrasena,
  };
  console.log(`[LOG ${req.id}] datos usuario: ${mask(u)}`);

  // Validaciones
  if (!u.usuario_dni || !/^\d{8}$/.test(u.usuario_dni)) return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  if (!u.usuario_nombre || !u.usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!u.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.usuario_correo)) return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  if (!u.usuario_contrasena || u.usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const row = {
    usuario_dni: u.usuario_dni,
    usuario_nombre: u.usuario_nombre,
    usuario_apellido: u.usuario_apellido,
    usuario_correo: u.usuario_correo,
    usuario_contrasena_hash: hashPassword(u.usuario_contrasena),
    usuario_tipo: 1,
  };
  const consulta = "INSERT INTO usuarios SET ?";
  dbq(req.id, consulta, row, async (error) => {
    if (error) {
      console.error(`[LOG ${req.id}] error insert usuario:`, error.code, error.sqlMessage);
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados" });
      }
      if (error.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ mensaje: "Columna inválida en BD." });
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }
    const nombreCompleto = `${row.usuario_nombre} ${row.usuario_apellido}`;
    await enviarCorreoBienvenida(req.id, row.usuario_correo, nombreCompleto);
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.put("/usuario/actualizar/:id", (req, res) => {
  console.log(`[LOG ${req.id}] PUT /usuario/actualizar/${req.params.id}`);
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body;
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const verificarCorreo = "SELECT 1 FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  dbq(req.id, verificarCorreo, [usuario_correo, id], (err, results) => {
    if (err) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (results.length > 0) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const actualizarUsuario = `
      UPDATE usuarios SET usuario_nombre = ?, usuario_apellido = ?, usuario_correo = ?
      WHERE id_usuario = ?`;
    dbq(req.id, actualizarUsuario, [usuario_nombre, usuario_apellido, usuario_correo, id], (error) => {
      if (error) return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      res.status(200).json({ mensaje: "Usuario actualizado correctamente" });
    });
  });
});

app.post("/usuario/recuperar-correo", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/recuperar-correo`);
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  const consulta = `SELECT usuario_correo FROM usuarios WHERE usuario_dni = ? AND usuario_nombre = ? AND usuario_apellido = ?`;
  dbq(req.id, consulta, [usuario_dni, usuario_nombre, usuario_apellido], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: resultados[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/recuperar-contrasena`);
  const { usuario_correo } = req.body;
  const consulta = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo = ?";
  dbq(req.id, consulta, [usuario_correo], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Correo no registrado" });

    const usuario = resultados[0];
    const temp = generarPasswordTemporal(10);
    const hashed = hashPassword(temp);
    dbq(req.id, "UPDATE usuarios SET usuario_contrasena_hash=? WHERE id_usuario=?", [hashed, usuario.id_usuario], async (e2) => {
      if (e2) return res.status(500).json({ error: "No se pudo actualizar la contraseña" });
      const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
      await enviarCorreoRecuperacion(req.id, usuario_correo, nombreCompleto, temp);
      res.json({ mensaje: "Se envió una contraseña temporal a tu correo" });
    });
  });
});

app.post("/usuario/registrar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/registrar`);
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad } = req.body;
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }
  const nuevo = {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo,
  };
  dbq(req.id, "INSERT INTO usuarios SET ?", nuevo, (error, resultados) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    const id_usuario = resultados.insertId;
    if (usuario_tipo === 2 && id_especialidad) {
      dbq(req.id, "INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)", [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
        res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

app.get("/usuario/:correo", (req, res) => {
  console.log(`[LOG ${req.id}] GET /usuario/${req.params.correo}`);
  const correo = decodeURIComponent(req.params.correo);
  const consulta = `SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios WHERE usuario_correo = ?`;
  dbq(req.id, consulta, [correo], (error, rpta) => {
    if (error) return res.status(500).send(error.message);
    if (rpta.length > 0) res.json(rpta[0]);
    else res.status(404).send({ mensaje: "no hay registros" });
  });
});

// ---------- Reset por código ----------
app.post("/usuario/reset/solicitar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/reset/solicitar`);
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "Correo requerido" });

  dbq(req.id, "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo = ?", [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const codigo = generarCodigo(6);
    dbq(req.id, "UPDATE usuarios SET reset_codigo=? WHERE usuario_correo=?", [codigo, usuario_correo], async (e2) => {
      if (e2) return res.status(500).json({ mensaje: "No se pudo guardar el código" });

      const nombre = `${rows[0].usuario_nombre} ${rows[0].usuario_apellido}`;
      const html = tplWrapper(`<h2>Código para cambiar tu contraseña</h2><p>Hola <b>${nombre}</b>, tu código es:</p><p style="font-size:24px;letter-spacing:3px"><b>${codigo}</b></p>`);
      await enviarMail({ reqId: req.id, to: usuario_correo, subject: "Tu código de verificación", html, category: "reset-codigo" });
      res.json({ ok: true });
    });
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /usuario/reset/cambiar`);
  const { usuario_correo, codigo, nueva_contrasena } = req.body || {};
  if (!usuario_correo || !codigo || !nueva_contrasena) return res.status(400).json({ mensaje: "correo, codigo y nueva_contrasena son requeridos" });
  if (String(nueva_contrasena).length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  dbq(req.id, "SELECT id_usuario, reset_codigo FROM usuarios WHERE usuario_correo = ?", [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = rows[0];
    if (!u.reset_codigo || u.reset_codigo !== String(codigo)) return res.status(401).json({ mensaje: "Código inválido" });

    const hashed = hashPassword(nueva_contrasena);
    dbq(req.id, "UPDATE usuarios SET usuario_contrasena_hash=?, reset_codigo=NULL WHERE id_usuario=?", [hashed, u.id_usuario], (e2) => {
      if (e2) return res.status(500).json({ mensaje: "No se pudo actualizar la contraseña" });
      res.json({ ok: true, mensaje: "Contraseña actualizada" });
    });
  });
});

// ---------- Especialidades / Médicos / Horarios ----------
app.get("/especialidades", (req, res) => {
  console.log(`[LOG ${req.id}] GET /especialidades`);
  dbq(req.id, "SELECT * FROM especialidades", [], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(rpta.length ? { listaEspecialidades: rpta } : { mensaje: "no hay registros" });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /especialidad/agregar`);
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  dbq(req.id, "INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], (err) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  console.log(`[LOG ${req.id}] PUT /especialidad/actualizar/${req.params.id}`);
  const { id } = req.params;
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  dbq(req.id, "UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

app.get("/medicos", (req, res) => {
  console.log(`[LOG ${req.id}] GET /medicos`);
  dbq(req.id, "SELECT * FROM medicos", [], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(rpta.length ? { listaCitas: rpta } : { mensaje: "no hay registros" });
  });
});

app.get("/horarios/:parametro", (req, res) => {
  console.log(`[LOG ${req.id}] GET /horarios/${req.params.parametro}`);
  const [fecha, especialidad] = (req.params.parametro || "").split("&");
  const sql = `
    SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') as horario_horas, 
           u.usuario_nombre as medico_nombre, u.usuario_apellido as medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
    WHERE h.horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC`;
  dbq(req.id, sql, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  console.log(`[LOG ${req.id}] GET /medico/${req.params.id_medico}/especialidades`);
  const { id_medico } = req.params;
  const consulta = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?`;
  dbq(req.id, consulta, [id_medico], (err, rpta) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: rpta });
  });
});

app.post("/horario/registrar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /horario/registrar`);
  let { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;
  horario_fecha = toYYYYMMDD(horario_fecha);
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) return res.status(400).json({ error: "Faltan datos obligatorios" });
  const horario_estado = 0;
  const consulta = `
    INSERT INTO horarios_medicos (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, STR_TO_DATE(?, '%H:%i'), STR_TO_DATE(?, '%Y-%m-%d'), ?, ?)`;
  dbq(req.id, consulta, [id_medico, horario_horas, horario_fecha, horario_estado, id_especialidad], (error, r) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r.insertId });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  console.log(`[LOG ${req.id}] PUT /horario/actualizar/${req.params.id_horario}`);
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;
  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });

  dbq(req.id, "SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario = ?", [id_horario], (err1, r1) => {
    if (err1 || r1.length === 0) return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    const anterior = r1[0];

    dbq(req.id, "UPDATE horarios_medicos SET horario_estado = 0 WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?", [anterior.horario_fecha, anterior.horario_hora, id_medico], () => {});

    const actualizar = `
      UPDATE horarios_medicos 
      SET horario_fecha=STR_TO_DATE(?, '%Y-%m-%d'), horario_hora=STR_TO_DATE(?, '%H:%i'), horario_estado=1, id_especialidad=?
      WHERE id_horario=?`;
    dbq(req.id, actualizar, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (err3) => {
      if (err3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      res.json({ mensaje: "Horario actualizado correctamente" });
    });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  console.log(`[LOG ${req.id}] GET /horarios/disponibles/${req.params.id_medico}/${req.params.fecha}/${req.params.id_especialidad}`);
  const { id_medico, fecha, id_especialidad } = req.params;
  const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const q = `SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
             FROM horarios_medicos
             WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  dbq(req.id, q, [id_medico, fecha, id_especialidad], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error al consultar horarios" });
    const horasOcupadas = resultados.map(r => r.hora);
    const horasDisponibles = todasLasHoras.filter(h => !horasOcupadas.includes(h));
    console.log(`[LOG ${req.id}] horasOcupadas=${JSON.stringify(horasOcupadas)} horasDisp=${JSON.stringify(horasDisponibles)}`);
    res.json({ horariosDisponibles: horasDisponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  console.log(`[LOG ${req.id}] GET /horarios/registrados/${req.params.id_medico}/${req.params.fecha}/${req.params.id_especialidad}`);
  const { id_medico, fecha, id_especialidad } = req.params;
  const sql = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS horario_hora
    FROM horarios_medicos 
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  dbq(req.id, sql, [id_medico, fecha, id_especialidad], (err, results) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    const horarios = results.map(row => row.horario_hora);
    res.json({ horarios });
  });
});

// ---------- Citas ----------
app.post("/cita/agregar", (req, res) => {
  console.log(`[LOG ${req.id}] POST /cita/agregar body=${mask(req.body)}`);
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;
  cita_fecha = toYYYYMMDD(cita_fecha);

  dbq(req.id, "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?", [id_usuario], (error, results) => {
    if (error) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = results[0].total + 1;

    const qInsert = `
      INSERT INTO citas (id_usuario, id_medico, cita_fecha, cita_hora, numero_orden)
      VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?)`;
    dbq(req.id, qInsert, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const ocupar = `
        UPDATE horarios_medicos SET horario_estado=1 
        WHERE horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i') AND id_medico=?`;
      dbq(req.id, ocupar, [cita_fecha, cita_hora, id_medico], () => {});

      dbq(req.id, "SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (e4, r4) => {
        if (e4 || r4.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
        const destinatario = r4[0].usuario_correo;
        await enviarCorreo(req.id, destinatario, cita_fecha, cita_hora);
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  console.log(`[LOG ${req.id}] PUT /cita/actualizar/${req.params.id} body=${mask(req.body)}`);
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;
  cita_fecha = toYYYYMMDD(cita_fecha);
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  dbq(req.id, "SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, rows) => {
    if (e0 || rows.length === 0) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const usuario_correo = rows[0].usuario_correo;

    const qAnterior = `SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora, '%H:%i') AS cita_hora FROM citas WHERE id_cita = ?`;
    dbq(req.id, qAnterior, [id], (e1, r1) => {
      if (e1 || r1.length === 0) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const anterior = r1[0];

      const qLiberar = `
        UPDATE horarios_medicos SET horario_estado = 0
        WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?`;
      dbq(req.id, qLiberar, [anterior.cita_fecha, anterior.cita_hora, id_medico], () => {});

      const qUpdate = `
        UPDATE citas 
        SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'),
            cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=?
        WHERE id_cita=?`;
      dbq(req.id, qUpdate, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcupar = `
          UPDATE horarios_medicos SET horario_estado = 1
          WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?`;
        dbq(req.id, qOcupar, [cita_fecha, cita_hora, id_medico], () => {});
        enviarCorreoActualizacion(req.id, usuario_correo, cita_fecha, cita_hora).catch(() => {});
        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  console.log(`[LOG ${req.id}] PUT /cita/anular/${req.params.id_cita}`);
  const { id_cita } = req.params;
  const qDatos = "SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita = ?";
  dbq(req.id, qDatos, [id_cita], (e1, r1) => {
    if (e1 || r1.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico } = r1[0];
    dbq(req.id, "UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const lib = "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i') AND id_medico=?";
      dbq(req.id, lib, [cita_fecha, cita_hora, id_medico], (e3) => {
        if (e3) return res.status(500).json({ error: "Error al liberar el horario" });
        res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  console.log(`[LOG ${req.id}] PUT /cita/anular/${req.params.id_usuario}/${req.params.numero_orden}`);
  const { id_usuario, numero_orden } = req.params;
  const consultaBuscarCita = `
    SELECT id_cita, DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario = ? AND numero_orden = ? AND cita_estado = 1`;
  dbq(req.id, consultaBuscarCita, [id_usuario, numero_orden], (err, resultados) => {
    if (err) return res.status(500).json({ error: "Error al buscar la cita" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = resultados[0];
    dbq(req.id, "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (err2) => {
      if (err2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const consultaLiberarHorario = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?`;
      dbq(req.id, consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], (err3) => {
        if (err3) return res.status(500).json({ error: "Error al liberar el horario" });

        dbq(req.id, "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], async (err4, rpta) => {
          if (!err4 && rpta.length) await enviarCorreoCancelacion(req.id, rpta[0].usuario_correo, cita_fecha, cita_hora);
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

app.get("/citas/por-dia", (req, res) => {
  console.log(`[LOG ${req.id}] GET /citas/por-dia`);
  const consulta = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY DATE(cita_fecha)
    ORDER BY DATE(cita_fecha) ASC`;
  dbq(req.id, consulta, [], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error en la base de datos" });
    const datos = resultados.map(row => ({ fecha: row.fecha, cantidad: row.cantidad }));
    console.log(`[LOG ${req.id}] /citas/por-dia -> ${datos.length} filas`);
    res.json({ listaCitas: datos });
  });
});

app.get("/citas/:usuario", (req, res) => {
  console.log(`[LOG ${req.id}] GET /citas/${req.params.usuario}`);
  const { usuario } = req.params;
  const consulta = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(DATE(c.cita_fecha), '%d/%m/%Y') AS cita_fecha,
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
    ORDER BY c.id_cita ASC`;
  dbq(req.id, consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    const lista = rpta.map((cita, idx) => ({ ...cita, numero_orden: idx + 1 }));
    res.json({ listaCitas: lista });
  });
});

app.get("/citamedica/:id_cita", (req, res) => {
  console.log(`[LOG ${req.id}] GET /citamedica/${req.params.id_cita}`);
  const { id_cita } = req.params;
  const consulta = `
    SELECT cit.id_cita AS IdCita,
           CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
           esp.especialidad_nombre AS Especialidad,
           CONCAT(med.usuario_nombre, ' ', med.usuario_apellido) AS Medico,
           DATE(cit.cita_fecha) AS FechaCita,
           cit.cita_hora AS HoraCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario = cit.id_usuario
    INNER JOIN medicos m ON cit.id_medico = m.id_medico
    INNER JOIN usuarios med ON m.id_medico = med.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_cita = ?`;
  dbq(req.id, consulta, [id_cita], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (results.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  console.log(`[LOG ${req.id}] GET /cita/usuario/${req.params.id_usuario}/orden/${req.params.numero_orden}`);
  const { id_usuario, numero_orden } = req.params;
  const consulta = `
    SELECT 
      cit.id_cita AS IdCita,
      CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
      DATE(cit.cita_fecha) AS FechaCita,
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
    WHERE cit.id_usuario = ? AND cit.numero_orden = ?`;
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
      DATE_FORMAT(DATE(c.cita_fecha), '%d/%m/%Y') AS cita_fecha,
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
    ORDER BY u.usuario_nombre ASC, numero_cita ASC`;
  dbq(req.id, consulta, [], (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error al obtener las citas" });
    res.json({ listaCitas: rpta.length ? rpta : [] });
  });
});

// ===================== EXPORTS & RUN ===================
module.exports = {
  hashPassword,
  verifyPassword,
};

app.listen(PUERTO, () => {
  console.log(`Servidor corriendo en el puerto ${PUERTO}`);
  console.log(`DEBUG_SQL=${process.env.DEBUG_SQL ? "ON" : "OFF"} (exporta DEBUG_SQL=1 para ver sentencias)`);
});
