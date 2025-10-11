// index.js - API Clínica Salud Total (Express + MySQL + Gmail API)
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 10000;
app.use(express.json());

/* =========================================
 *  Request-ID + Logs
 * ========================================= */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    try { console.log(`[${req.rid}] body:`, req.body); } catch {}
  }
  res.on("finish", () => {
    console.log(
      `[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`
    );
  });
  next();
});

/* =========================================
 *  MySQL (mysql2 pool + promises)
 * ========================================= */
const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 10
});
const db = pool.promise();

/* =========================================
 *  Gmail API (SIN nodemailer)  ← tu bloque
 * ========================================= */
const GMAIL_USER = process.env.GMAIL_USER;

const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

function base64Url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function enviarMail({ rid, to, subject, html, text, category = "notificaciones" }) {
  const from = `Clínica Salud Total <${GMAIL_USER}>`;
  const plain = text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=boundary001",
    `X-Category: ${category}`
  ].join("\r\n");
  const body =
    `--boundary001\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${plain}\r\n` +
    `--boundary001\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n` +
    `--boundary001--`;
  const raw = base64Url(`${headers}\r\n\r\n${body}`);

  const t0 = Date.now();
  console.log(`[${rid}] [@gmail] to=${to} subject="${subject}" cat=${category}`);
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`[${rid}] [@gmail] ok id=${r.data.id} (${Date.now() - t0}ms)`);
  return r.data;
}

const wrap = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;

async function correoConfirmacion(rid, to, fecha, hora) {
  return enviarMail({
    rid, to,
    subject: "Confirmación de tu cita médica",
    html: wrap(`<h2>Cita confirmada</h2><p>Tu cita ha sido registrada.</p><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-confirmada",
  });
}
async function correoActualizacion(rid, to, fecha, hora) {
  return enviarMail({
    rid, to,
    subject: "Actualización de tu cita médica",
    html: wrap(`<h2>Cita actualizada</h2><p><b>Nueva fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-actualizada",
  });
}
async function correoCancelacion(rid, to, fecha, hora) {
  return enviarMail({
    rid, to,
    subject: "Cancelación de tu cita médica",
    html: wrap(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-cancelada",
  });
}
async function correoBienvenida(rid, to, nombre) {
  return enviarMail({
    rid, to,
    subject: "Bienvenido a Clínica Salud Total",
    html: wrap(`<h2>¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
    category: "bienvenida",
  });
}

/* =========================================
 *  Helpers de seguridad (hash con salt)
 * ========================================= */
function hashPasswordWithSalt(saltHex, password) {
  return crypto.createHash("sha256").update(saltHex + password, "utf8").digest("hex");
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}
function sixCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* =========================================
 *  Base
 * ========================================= */
app.get("/", (_, res) => res.send("API Clínica Salud Total (Express + Gmail API)"));

/* =========================================
 *  USUARIOS
 * ========================================= */
// GET /usuarios
app.get("/usuarios", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM usuarios");
    res.json({ listaUsuarios: rows || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

// POST /usuario/agregar  (RegistroActivity simple)
app.post("/usuario/agregar", async (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) return res.status(400).json({ mensaje: "El DNI debe tener 8 dígitos." });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios." });
  if (!usuario_correo) return res.status(400).json({ mensaje: "Correo obligatorio." });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6." });

  try {
    const salt = makeSalt();
    const hash = hashPasswordWithSalt(salt, usuario_contrasena);
    await db.query(
      `INSERT INTO usuarios (usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash,usuario_tipo)
       VALUES (?,?,?,?,?,1)`,
      [usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, `${salt}:${hash}`]
    );
    // correo bienvenida (no bloquear respuesta)
    correoBienvenida(req.rid, usuario_correo, `${usuario_nombre} ${usuario_apellido}`).catch(()=>{});
    res.json({ mensaje: "Usuario registrado correctamente." });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      if (String(e.sqlMessage).includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
      if (String(e.sqlMessage).includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
    }
    console.error(e);
    res.status(500).json({ mensaje: "Error al registrar usuario." });
  }
});

// POST /usuario/registrar  (RegistroUsuarioActivity – con tipo y posible especialidad)
app.post("/usuario/registrar", async (req, res) => {
  try {
    const {
      usuario_nombre, usuario_apellido, usuario_correo, usuario_dni,
      usuario_contrasena, usuario_tipo, id_especialidad
    } = req.body || {};

    if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
      return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
    }

    const salt = makeSalt();
    const hash = hashPasswordWithSalt(salt, usuario_contrasena);
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [ins] = await conn.query(
        `INSERT INTO usuarios (usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash,usuario_tipo)
         VALUES (?,?,?,?,?,?)`,
        [usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, `${salt}:${hash}`, usuario_tipo]
      );
      const id_usuario = ins.insertId;

      if (usuario_tipo === 2 && id_especialidad) {
        await conn.query("INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?)", [id_usuario, id_especialidad]);
      }

      await conn.commit();
      correoBienvenida(req.rid, usuario_correo, `${usuario_nombre} ${usuario_apellido}`).catch(()=>{});
      res.status(201).json({ mensaje: usuario_tipo === 2 ? "Médico registrado correctamente" : "Usuario registrado correctamente", id_usuario });
    } catch (tx) {
      await conn.rollback();
      if (tx.code === "ER_DUP_ENTRY") {
        if (String(tx.sqlMessage).includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (String(tx.sqlMessage).includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
      }
      console.error(tx);
      res.status(500).json({ mensaje: "Error al registrar usuario" });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error inesperado" });
  }
});

// PUT /usuario/actualizar/:id
app.put("/usuario/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  try {
    const [dup] = await db.query("SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario<>?", [usuario_correo, id]);
    if (dup.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    await db.query("UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre, usuario_apellido, usuario_correo, id]);
    res.json({ mensaje: "Usuario actualizado correctamente" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

// POST /usuario/login
app.post("/usuario/login", async (req, res) => {
  try {
    const { usuario_correo, password } = req.body || {};
    const [rows] = await db.query(
      "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_tipo,usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?",
      [usuario_correo]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "No encontrado" });

    const u = rows[0];
    const [salt, storedHash] = String(u.usuario_contrasena_hash).split(":");
    const calc = hashPasswordWithSalt(salt, password);
    if (calc !== storedHash) return res.status(401).json({ mensaje: "Unauthorized" });

    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

// POST /usuario/recuperar-correo  (ConsultaCorreoActivity)
app.post("/usuario/recuperar-correo", async (req, res) => {
  try {
    const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
    const [rows] = await db.query(
      "SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?",
      [usuario_dni, usuario_nombre, usuario_apellido]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: rows[0].usuario_correo });
  } catch (e) {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// POST /usuario/recuperar-contrasena  (compat → envía código)
app.post("/usuario/recuperar-contrasena", async (req, res) => {
  try {
    const { usuario_correo } = req.body || {};
    const [rows] = await db.query("SELECT 1 FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const code = sixCode();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await db.query("INSERT INTO reset_codes (email, code_hash, expires_at, used) VALUES (?,?,?,0)", [usuario_correo, codeHash, expires]);
    await enviarMail({
      rid: req.rid,
      to: usuario_correo,
      subject: "Código de recuperación",
      html: wrap(`<h2>Recuperación de contraseña</h2><p>Tu código es: <b>${code}</b> (válido por 15 minutos)</p>`),
      category: "reset-password"
    });
    res.json({ mensaje: "Código enviado" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /usuario/reset/solicitar
app.post("/usuario/reset/solicitar", async (req, res) => {
  try {
    const { usuario_correo } = req.body || {};
    const [rows] = await db.query("SELECT 1 FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const code = sixCode();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    await db.query("INSERT INTO reset_codes (email, code_hash, expires_at, used) VALUES (?,?,?,0)", [usuario_correo, codeHash, expires]);
    await enviarMail({
      rid: req.rid,
      to: usuario_correo,
      subject: "Código de recuperación",
      html: wrap(`<h2>Recuperación de contraseña</h2><p>Tu código es: <b>${code}</b> (válido por 15 minutos)</p>`),
      category: "reset-password"
    });
    res.json({ mensaje: "Código enviado" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al solicitar código" });
  }
});

// POST /usuario/reset/cambiar
app.post("/usuario/reset/cambiar", async (req, res) => {
  try {
    const { usuario_correo, codigo, nueva_contrasena } = req.body || {};
    if (!usuario_correo || !codigo || !nueva_contrasena || nueva_contrasena.length < 6) {
      return res.status(400).json({ mensaje: "Datos inválidos" });
    }
    const codeHash = crypto.createHash("sha256").update(codigo).digest("hex");
    const [rows] = await db.query(
      "SELECT id, expires_at, used FROM reset_codes WHERE email=? AND code_hash=? ORDER BY id DESC LIMIT 1",
      [usuario_correo, codeHash]
    );
    if (!rows.length) return res.status(400).json({ mensaje: "Código inválido" });
    const rc = rows[0];
    if (rc.used) return res.status(400).json({ mensaje: "Código ya usado" });
    if (new Date(rc.expires_at) < new Date()) return res.status(400).json({ mensaje: "Código expirado" });

    const salt = makeSalt();
    const hash = hashPasswordWithSalt(salt, nueva_contrasena);
    await db.query("UPDATE usuarios SET usuario_contrasena_hash=? WHERE usuario_correo=?", [`${salt}:${hash}`, usuario_correo]);
    await db.query("UPDATE reset_codes SET used=1 WHERE id=?", [rc.id]);

    res.json({ mensaje: "Contraseña actualizada" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al cambiar contraseña" });
  }
});

/* =========================================
 *  ESPECIALIDADES / MÉDICOS
 * ========================================= */
// GET /especialidades
app.get("/especialidades", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM especialidades");
    res.json({ listaEspecialidades: rows || [] });
  } catch {
    res.status(500).json({ mensaje: "Error al obtener especialidades" });
  }
});

// POST /especialidad/agregar
app.post("/especialidad/agregar", async (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    await db.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre]);
    res.status(201).json("Especialidad registrado");
  } catch {
    res.status(500).json({ error: "Error al guardar especialidad" });
  }
});

// PUT /especialidad/actualizar/:id
app.put("/especialidad/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  try {
    await db.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id]);
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  } catch {
    res.status(500).json({ error: "Error al actualizar especialidad" });
  }
});

// GET /medico/:id_medico/especialidades
app.get("/medico/:id_medico/especialidades", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT e.id_especialidad, e.especialidad_nombre
      FROM medicos m
      JOIN especialidades e ON m.id_especialidad=e.id_especialidad
      WHERE m.id_medico=?`, [id_medico]);
    res.json({ listaEspecialidades: rows || [] });
  } catch {
    res.status(500).json({ error: "Error al obtener especialidades" });
  }
});

/* =========================================
 *  HORARIOS
 * ========================================= */
// GET /horarios/:parametro  → "YYYY-MM-DD&{id_especialidad}"
app.get("/horarios/:parametro", async (req, res) => {
  try {
    const [fecha, id_especialidad] = req.params.parametro.split("&");
    const [rows] = await db.query(`
      SELECT h.*,
             TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
             u.usuario_nombre AS medico_nombre,
             u.usuario_apellido AS medico_apellido,
             e.especialidad_nombre
      FROM horarios_medicos h
      JOIN medicos m ON h.id_medico=m.id_medico
      JOIN usuarios u ON m.id_medico=u.id_usuario
      JOIN especialidades e ON h.id_especialidad=e.id_especialidad
      WHERE h.horario_fecha=? AND h.id_especialidad=? AND h.horario_estado=0
      ORDER BY h.horario_hora ASC`, [fecha, id_especialidad]);
    res.json({ listaHorarios: rows || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al listar horarios" });
  }
});

// GET /horarios/disponibles/:id_medico/:fecha/:id_especialidad
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  try {
    const { id_medico, fecha, id_especialidad } = req.params;
    const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
    const [rows] = await db.query(`
      SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
      FROM horarios_medicos
      WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`,
      [id_medico, fecha, id_especialidad]
    );
    const ocupadas = rows.map(r => r.hora);
    const libres = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: libres });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al consultar horarios" });
  }
});

// GET /horarios/registrados/:id_medico/:fecha/:id_especialidad
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT TIME_FORMAT(horario_hora,'%H:%i') AS h
      FROM horarios_medicos
      WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
      ORDER BY h ASC`, [id_medico, fecha, id_especialidad]);
    res.json({ horarios: rows.map(r => r.h) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /horario/registrar
app.post("/horario/registrar", async (req, res) => {
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body || {};
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  try {
    const [ins] = await db.query(
      `INSERT INTO horarios_medicos (id_medico,horario_hora,horario_fecha,horario_estado,id_especialidad)
       VALUES (?,?,?,?,?)`,
      [id_medico, horario_horas, horario_fecha, 0, id_especialidad]
    );
    res.json({ mensaje: "Horario registrado correctamente", id_horario: ins.insertId });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
    console.error(e);
    res.status(500).json({ error: "Error al registrar horario" });
  }
});

// PUT /horario/editar/:id_medico/:fecha/:hora  (eliminar/actualizar)
app.put("/horario/editar/:id_medico/:fecha/:hora", async (req, res) => {
  const { id_medico, fecha, hora } = req.params;
  const { accion, nuevaHora, id_especialidad } = req.body || {};
  if (!accion || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos" });

  try {
    if (accion === "eliminar") {
      await db.query(
        `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [id_medico, fecha, hora, id_especialidad]
      );
      return res.json({ mensaje: "Horario eliminado correctamente" });
    }
    if (accion === "actualizar") {
      await db.query(
        `UPDATE horarios_medicos SET horario_hora=?, horario_estado=0
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [nuevaHora, id_medico, fecha, hora, id_especialidad]
      );
      return res.json({ mensaje: "Horario actualizado correctamente" });
    }
    res.status(400).json({ mensaje: "Acción no reconocida" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al editar horario" });
  }
});

/* =========================================
 *  CITAS
 * ========================================= */
// POST /cita/agregar
app.post("/cita/agregar", async (req, res) => {
  try {
    const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario]);
      const numero_orden = Number(total) + 1;

      await conn.query(
        "INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado) VALUES (?,?,?,?,?,1)",
        [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden]
      );
      await conn.query(
        "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [cita_fecha, cita_hora, id_medico]
      );
      const [[u]] = await conn.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
      await conn.commit();

      if (u?.usuario_correo) correoConfirmacion(req.rid, u.usuario_correo, cita_fecha, cita_hora).catch(()=>{});
      res.json({ mensaje: "Cita registrada correctamente", numero_orden });
    } catch (tx) {
      await conn.rollback();
      console.error(tx);
      res.status(500).json({ error: "Error al registrar la cita" });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
});

// PUT /cita/actualizar/:id
app.put("/cita/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // horario anterior
    const [[ant]] = await conn.query("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?", [id]);
    if (ant) {
      await conn.query(
        "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [ant.cita_fecha, ant.cita_hora, id_medico]
      );
    }
    await conn.query(
      "UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=? WHERE id_cita=?",
      [id_usuario, id_medico, cita_fecha, cita_hora, Number(cita_estado ?? 1), id]
    );
    await conn.query(
      "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [cita_fecha, cita_hora, id_medico]
    );

    const [[u]] = await conn.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    await conn.commit();

    if (u?.usuario_correo) correoActualizacion(req.rid, u.usuario_correo, cita_fecha, cita_hora).catch(()=>{});
    res.json({ mensaje: "Cita actualizada correctamente" });
  } catch (e) {
    await db.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ mensaje: "Error al actualizar la cita" });
  } finally {
    try { await db.query("COMMIT"); } catch {}
    conn.release();
  }
});

// PUT /cita/anular/:id_usuario/:numero_orden
app.put("/cita/anular/:id_usuario/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const [[c]] = await db.query(
      "SELECT id_cita, cita_fecha, cita_hora, id_medico FROM citas WHERE id_usuario=? AND numero_orden=? AND cita_estado=1",
      [id_usuario, numero_orden]
    );
    if (!c) return res.status(404).json({ mensaje: "Cita no encontrada" });

    await db.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [c.id_cita]);
    await db.query(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [c.cita_fecha, c.cita_hora, c.id_medico]
    );

    const [[u]] = await db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (u?.usuario_correo) correoCancelacion(req.rid, u.usuario_correo, c.cita_fecha, c.cita_hora).catch(()=>{});
    res.json({ mensaje: "Cita cancelada exitosamente" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

// PUT /cita/estado/:id_cita
app.put("/cita/estado/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body || {};
  try {
    await db.query("UPDATE citas SET cita_estado=? WHERE id_cita=?", [Number(nuevo_estado), id_cita]);
    res.json({ mensaje: "Estado actualizado correctamente" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al actualizar estado" });
  }
});

// GET /citas/:usuario
app.get("/citas/:usuario", async (req, res) => {
  const { usuario } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT c.id_cita, c.id_usuario, c.id_medico,
             DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
             TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
             u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
             e.id_especialidad, e.especialidad_nombre,
             c.cita_estado
      FROM citas c
      JOIN medicos m ON c.id_medico=m.id_medico
      JOIN usuarios u ON m.id_medico=u.id_usuario
      JOIN especialidades e ON m.id_especialidad=e.id_especialidad
      WHERE c.id_usuario=?
      ORDER BY c.id_cita ASC`, [usuario]);
    const listaCitas = rows.map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener las citas" });
  }
});

// GET /cita/usuario/:id_usuario/orden/:numero_orden
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT 
        cit.id_cita AS IdCita,
        CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
        esp.especialidad_nombre AS Especialidad,
        CONCAT(mu.usuario_nombre,' ',mu.usuario_apellido) AS Medico,
        cit.cita_fecha AS FechaCita,
        cit.cita_hora AS HoraCita,
        CASE WHEN cit.cita_estado=1 THEN 'Confirmada'
             WHEN cit.cita_estado=0 THEN 'Cancelada'
             ELSE 'Desconocido' END AS EstadoCita
      FROM citas cit
      JOIN usuarios us ON us.id_usuario=cit.id_usuario
      JOIN medicos m ON m.id_medico=cit.id_medico
      JOIN usuarios mu ON m.id_medico=mu.id_usuario
      JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
      WHERE cit.id_usuario=? AND cit.numero_orden=?`, [id_usuario, numero_orden]);
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

// GET /citas/medico/:id_medico
app.get("/citas/medico/:id_medico", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const [rows] = await db.query(`
      SELECT c.id_cita, c.id_usuario,
             us.usuario_nombre AS paciente_nombre, us.usuario_apellido AS paciente_apellido,
             DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
             TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
             u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
             e.id_especialidad, e.especialidad_nombre,
             c.cita_estado
      FROM citas c
      JOIN usuarios us ON c.id_usuario=us.id_usuario
      JOIN medicos m ON c.id_medico=m.id_medico
      JOIN usuarios u ON m.id_medico=u.id_usuario
      JOIN especialidades e ON m.id_especialidad=e.id_especialidad
      WHERE c.id_medico=?
      ORDER BY c.id_cita ASC`, [id_medico]);
    const listaCitas = rows.map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener citas del médico" });
  }
});

// GET /citas/por-dia  (ReportesActivity)
app.get("/citas/por-dia", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cita_fecha AS fecha, COUNT(*) AS cantidad
      FROM citas
      WHERE cita_estado=1
      GROUP BY cita_fecha
      ORDER BY cita_fecha ASC`);
    const listaCitas = rows.map(r => ({ fecha: r.fecha.toISOString().slice(0,10), cantidad: r.cantidad }));
    res.json({ listaCitas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

/* =========================================
 *  START
 * ========================================= */
app.listen(PUERTO, () => {
  console.log(`Servidor corriendo en el puerto ${PUERTO}`);
});
