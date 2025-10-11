// index.js - API Clínica Salud Total (Express + MySQL + Gmail API) - v2025-10-11
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
 *  Gmail API (sin nodemailer)
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
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
  console.log(`[${rid}] [@gmail] intent to=${to} subject="${subject}" cat=${category}`);
  try {
    const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    console.log(`[${rid}] [@gmail] ok id=${r.data.id} (${Date.now() - t0}ms)`);
    return r.data;
  } catch (e) {
    console.error(`[${rid}] [@gmail] ERROR ${e.message}`);
    throw e;
  }
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
 *  Helpers
 * ========================================= */
function toYYYYMMDD(v) {
  if (!v) return v;
  const s = String(v).trim();

  // 1) ISO completo: 2025-10-12T00:00:00.000Z
  const iso0 = s.split("T")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso0)) return iso0;

  // 2) YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // 3) YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/](\d{2})[\/](\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // 4) DD/MM/YYYY
  m = s.match(/^(\d{2})[\/](\d{2})[\/](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  // 5) Date nativo
  const d = new Date(s);
  if (!isNaN(d)) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  return s; // NO truncar a 10 a ciegas
}

function saltHash(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  return test.toLowerCase() === String(hash || "").toLowerCase();
}

/* =========================================
 *  MySQL Pool + helper q() con logging
 * ========================================= */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
}).promise();

async function bootstrap() {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET time_zone='-05:00'");
    await conn.query(`
      CREATE TABLE IF NOT EXISTS reset_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(150) NOT NULL,
        code_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        used TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX (email), INDEX (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log("✅ Conexión MySQL OK");
    console.log("✅ reset_codes lista");
  } finally {
    conn.release();
  }
}
bootstrap().catch((e) => {
  console.error("❌ Error al conectar MySQL:", e.message);
  process.exit(1);
});

async function q(rid, tag, sql, params = []) {
  const t0 = Date.now();
  try {
    const [rows] = await pool.query(sql, params);
    const count = typeof rows?.affectedRows === "number" ? rows.affectedRows : rows?.length ?? 0;
    console.log(`[${rid}] [DB:${tag}] ok ${Date.now() - t0}ms rows=${count}`);
    return rows;
  } catch (e) {
    console.error(`[${rid}] [DB:${tag}] ERROR ${e.code || ""} ${e.message}`);
    throw e;
  }
}

/* =========================================
 *  Básicos
 * ========================================= */
app.get("/", (_, res) => res.send("API Clínica Salud Total"));
app.get("/health", async (req, res) => {
  try {
    await q(req.rid, "health", "SELECT 1 AS ok");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================================
 *  USUARIOS (login / registrar / listar / actualizar)
 * ========================================= */

// LOGIN
app.post("/usuario/login", async (req, res) => {
  const rid = req.rid;
  const correo = String(req.body?.usuario_correo || req.body?.email || "").trim().toLowerCase();
  const pass = String(req.body?.password || "");

  if (!correo || !pass) {
    return res.status(400).json({ mensaje: "Correo y password requeridos" });
  }

  const sql = `
    SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash
    FROM usuarios WHERE LOWER(usuario_correo)=? LIMIT 1
  `;
  try {
    const rows = await q(rid, "login.select", sql, [correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = rows[0];
    const ok = verifyPassword(pass, u.usuario_contrasena_hash);
    if (!ok) return res.status(401).json({ mensaje: "Contraseña incorrecta" });

    console.log(`[${rid}] [login] OK usuario=${u.id_usuario}`);
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo,
    });
  } catch (e) {
    res.status(500).json({ mensaje: "Error en la base de datos" });
  }
});

// Registrar usuario
app.post("/usuario/registrar", async (req, res) => {
  const rid = req.rid;
  const {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena,
    usuario_tipo,     // 0,1,2 o texto
    id_especialidad   // requerido si tipo=2
  } = req.body || {};

  if (!/^\d{8}$/.test(String(usuario_dni || ""))) return res.status(400).json({ mensaje: "DNI inválido (8 dígitos)" });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(usuario_correo || ""))) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!usuario_contrasena || String(usuario_contrasena).length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const mapRol = (v) => {
    if (v === 0 || v === 1 || v === 2) return Number(v);
    const s = String(v || "").toLowerCase();
    if (s.startsWith("admin")) return 0;
    if (s.startsWith("pac")) return 1;
    if (s.startsWith("méd") || s.startsWith("med")) return 2;
    return 1;
  };
  const tipo = mapRol(usuario_tipo);

  const row = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: saltHash(String(usuario_contrasena)),
    usuario_tipo: tipo,
  };

  try {
    const r = await q(rid, "usuarios.insert", "INSERT INTO usuarios SET ?", [row]);
    const id_usuario = r.insertId;

    console.log(`[${rid}] [usuarios] insert id=${id_usuario} tipo=${tipo}`);

    if (tipo === 2 && id_especialidad) {
      await q(rid, "medicos.insert", "INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?)", [id_usuario, id_especialidad]);
      console.log(`[${rid}] [medicos] vinculado id_medico=${id_usuario} esp=${id_especialidad}`);
    }

    // Correo de bienvenida (no bloqueante)
    correoBienvenida(rid, usuario_correo, usuario_nombre).catch((e) =>
      console.error(`[${rid}] [correoBienvenida] WARN ${e.message}`)
    );

    res.status(201).json({ mensaje: tipo === 2 ? "Médico registrado correctamente" : "Usuario registrado correctamente", id_usuario });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      if (e.message?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
      if (e.message?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
    }
    res.status(500).json({ mensaje: "Error al registrar usuario" });
  }
});

// Actualizar usuario (nombre, apellido, correo)
app.put("/usuario/actualizar/:id", async (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  console.log(`[${rid}] [usuario/actualizar] -> id=${id}`, { usuario_nombre, usuario_apellido, usuario_correo });

  if (!usuario_nombre || !usuario_apellido || !usuario_correo)
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  try {
    const exists = await q(
      rid,
      "usuarios.verificarCorreo",
      "SELECT id_usuario FROM usuarios WHERE LOWER(usuario_correo)=LOWER(?) AND id_usuario<>? LIMIT 1",
      [usuario_correo, id]
    );
    if (exists.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const r2 = await q(
      rid,
      "usuarios.update",
      "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre, usuario_apellido, usuario_correo, id]
    );
    const changed = !!r2.affectedRows;
    console.log(`[${rid}] [usuario/actualizar] changed=${changed}`);
    res.json({ mensaje: changed ? "Usuario actualizado correctamente" : "No hubo cambios", changed });
  } catch (e) {
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

// Listado usuarios
app.get("/usuarios", async (req, res) => {
  const rid = req.rid;
  try {
    const rows = await q(
      rid,
      "usuarios.list",
      "SELECT id_usuario, usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo FROM usuarios ORDER BY id_usuario ASC"
    );
    res.json({ listaUsuarios: rows });
  } catch {
    res.status(500).json({ error: "Error al cargar usuarios" });
  }
});

// Obtener usuario por correo
app.get("/usuario/:correo", async (req, res) => {
  const rid = req.rid;
  const correo = decodeURIComponent(req.params.correo || "");
  try {
    const r = await q(rid, "usuarios.byCorreo", "SELECT * FROM usuarios WHERE usuario_correo=?", [correo]);
    if (!r.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

/* =========================================
 *  RESET PASSWORD por código
 * ========================================= */
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const genCode6 = () => Math.floor(100000 + Math.random() * 900000).toString();

app.post("/usuario/reset/solicitar", async (req, res) => {
  const rid = req.rid;
  const correo = String(req.body.email ?? req.body.usuario_correo ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok: false, mensaje: "Correo inválido" });

  try {
    const usr = await q(rid, "reset.buscarUser", "SELECT id_usuario FROM usuarios WHERE LOWER(usuario_correo)=?", [correo]);
    if (!usr.length) return res.json({ ok: true, mensaje: "Si el correo existe, se envió un código." });

    const code = genCode6(), codeHash = sha256(code), expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await q(rid, "reset.insertCode", "INSERT INTO reset_codes (email, code_hash, expires_at) VALUES (?,?,?)", [correo, codeHash, expiresAt]);

    try {
      await enviarMail({
        rid,
        to: correo,
        subject: "Código de verificación - Restablecer contraseña",
        html: wrap(`<h2>Restablecer contraseña</h2><p>Usa este código (vence en 15 min):</p><p style="font-size:22px;letter-spacing:3px;"><b>${code}</b></p>`),
        category: "reset-password"
      });
      res.json({ ok: true, mensaje: "Código enviado" });
    } catch {
      res.status(500).json({ ok: false, mensaje: "No se pudo enviar el código" });
    }
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: "Error en base de datos" });
  }
});

app.post("/usuario/reset/cambiar", async (req, res) => {
  const rid = req.rid;
  const correo = String(req.body.email ?? req.body.usuario_correo ?? "").trim().toLowerCase();
  const pin = String(req.body.code ?? req.body.codigo ?? "").trim();
  const nueva = String(req.body.new_password ?? req.body.nueva_contrasena ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok: false, mensaje: "La nueva contraseña debe tener mínimo 6 caracteres." });

  try {
    const codeHash = sha256(pin);
    const r1 = await q(
      rid,
      "reset.getCode",
      "SELECT id, expires_at, used FROM reset_codes WHERE email=? AND code_hash=? ORDER BY id DESC LIMIT 1",
      [correo, codeHash]
    );
    if (!r1.length) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    const row = r1[0];
    if (row.used) return res.status(400).json({ ok: false, mensaje: "Código ya utilizado" });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ ok: false, mensaje: "Código vencido" });

    const newHash = saltHash(nueva);
    const r2 = await q(rid, "reset.updatePass", "UPDATE usuarios SET usuario_contrasena_hash=? WHERE LOWER(usuario_correo)=?", [newHash, correo]);
    if (!r2.affectedRows) return res.status(400).json({ ok: false, mensaje: "No se encontró el usuario" });
    await q(rid, "reset.markUsed", "UPDATE reset_codes SET used=1 WHERE id=?", [row.id]);
    res.json({ ok: true, mensaje: "Contraseña actualizada" });
  } catch (e) {
    res.status(500).json({ ok: false, mensaje: "Error en base de datos" });
  }
});

/* =========================================
 *  ESPECIALIDADES
 * ========================================= */
app.get("/especialidades", async (req, res) => {
  const rid = req.rid;
  try {
    const r = await q(rid, "esp.list", "SELECT * FROM especialidades");
    res.json({ listaEspecialidades: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/especialidad/agregar", async (req, res) => {
  const rid = req.rid;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });

  try {
    await q(rid, "esp.insert", "INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre]);
    res.status(201).json("Especialidad registrada");
  } catch {
    res.status(500).json({ error: "Error al guardar especialidad" });
  }
});

app.put("/especialidad/actualizar/:id", async (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });

  try {
    const r = await q(rid, "esp.update", "UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id]);
    if (!r.affectedRows) return res.status(404).json({ mensaje: "Especialidad no encontrada" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  } catch {
    res.status(500).json({ error: "Error al actualizar especialidad" });
  }
});

/* =========================================
 *  HORARIOS
 * ========================================= */

// horarios por "fecha&especialidad"
app.get("/horarios/:parametro", async (req, res) => {
  const rid = req.rid;
  const [rawFecha, idEsp] = String(req.params.parametro || "").split("&");
  const fecha = toYYYYMMDD(rawFecha);
  console.log(`[${rid}] [horarios] -> fecha=${rawFecha} -> ${fecha} esp=${idEsp}`);

  const sql = `
    SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
    WHERE h.horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND h.id_especialidad=? AND h.horario_estado=0
    ORDER BY h.horario_hora ASC`;
  try {
    const r = await q(rid, "horarios.listByFechaEsp", sql, [fecha, idEsp]);
    res.json({ listaHorarios: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const rid = req.rid;
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  try {
    const r = await q(
      rid,
      "horarios.disponibles",
      "SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?",
      [id_medico, fecha, id_especialidad]
    );
    const ocupadas = r.map((x) => x.hora);
    res.json({ horariosDisponibles: todas.filter((h) => !ocupadas.includes(h)) });
  } catch {
    res.status(500).json({ error: "Error al consultar horarios" });
  }
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const rid = req.rid;
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  try {
    const rows = await q(rid, "horarios.registrados", sql, [id_medico, fecha, id_especialidad]);
    res.json({ horarios: rows.map((r) => r.horario_hora) });
  } catch {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ocupar/liberar/eliminar horario
app.put("/horario/editar/:id_medico/:fecha/:hora", async (req, res) => {
  const rid = req.rid;
  const { id_medico } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const hora = req.params.hora;
  const { accion } = req.body || {};
  console.log(`[${rid}] [horario/editar] ->`, { id_medico, fecha, hora, accion });

  if (!/^\d{2}:\d{2}$/.test(hora)) return res.status(400).json({ mensaje: "Hora inválida (HH:mm)" });
  const where = "id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')";
  try {
    if (accion === "ocupar") {
      await q(rid, "horarios.ocupar", `UPDATE horarios_medicos SET horario_estado=1 WHERE ${where}`, [id_medico, fecha, hora]);
      return res.json({ mensaje: "Horario ocupado" });
    }
    if (accion === "liberar") {
      await q(rid, "horarios.liberar", `UPDATE horarios_medicos SET horario_estado=0 WHERE ${where}`, [id_medico, fecha, hora]);
      return res.json({ mensaje: "Horario liberado" });
    }
    if (accion === "eliminar") {
      await q(rid, "horarios.eliminar", `DELETE FROM horarios_medicos WHERE ${where}`, [id_medico, fecha, hora]);
      return res.json({ mensaje: "Horario eliminado" });
    }
    res.status(400).json({ mensaje: "Acción inválida (ocupar|liberar|eliminar)" });
  } catch {
    res.status(500).json({ mensaje: "Error al modificar horario" });
  }
});

/* =========================================
 *  CITAS
 * ========================================= */

// Todas las citas (admin)
app.get("/citas", async (req, res) => {
  const rid = req.rid;
  const qAll = `
    SELECT 
      ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha, c.cita_hora) AS numero_cita,
      c.id_cita,
      u.usuario_nombre AS paciente_nombre, u.usuario_apellido AS paciente_apellido,
      DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
      TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
      e.especialidad_nombre,
      mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido,
      c.cita_estado
    FROM citas c
    INNER JOIN usuarios u  ON c.id_usuario = u.id_usuario
    INNER JOIN medicos m   ON c.id_medico  = m.id_medico
    INNER JOIN usuarios mu ON m.id_medico  = mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    ORDER BY u.usuario_nombre ASC, numero_cita ASC`;
  try {
    const r = await q(rid, "citas.adminList", qAll);
    res.json({ listaCitas: r || [] });
  } catch {
    res.status(500).json({ error: "Error al obtener las citas" });
  }
});

// Citas por usuario (si te mandan /citas/0, regresa todas para compatibilidad)
app.get("/citas/:usuario", async (req, res) => {
  const rid = req.rid;
  const { usuario } = req.params;
  if (String(usuario) === "0") return app._router.handle({ ...req, method: "GET", url: "/citas" }, res, () => {});

  const sql = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
           DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS fecha_iso,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_usuario = ?
    ORDER BY c.id_cita ASC`;
  try {
    const rows = await q(rid, "citas.byUser", sql, [usuario]);
    const lista = rows.map((x, i) => ({
      ...x,
      numero_orden: i + 1,
      estado_texto: Number(x.cita_estado) === 1 ? "Confirmada" : "Cancelada",
    }));
    console.log(`[${rid}] [citas/byUser] -> ${lista.length} citas`);
    res.json({ listaCitas: lista });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Buscar cita por (id_usuario, numero_orden)
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", async (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;
  console.log(`[${rid}] [cita/usuario/orden] -> u=${id_usuario} n=${numero_orden}`);

  const sql = `
    SELECT 
      c.id_cita AS IdCita,
      CONCAT(u.usuario_nombre,' ',u.usuario_apellido) AS UsuarioCita,
      e.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre,' ',mu.usuario_apellido) AS Medico,
      DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS FechaCita,
      TIME_FORMAT(c.cita_hora,'%H:%i')   AS HoraCita,
      c.cita_estado
    FROM citas c
    INNER JOIN usuarios u  ON u.id_usuario = c.id_usuario
    INNER JOIN medicos m   ON m.id_medico  = c.id_medico
    INNER JOIN usuarios mu ON mu.id_usuario= m.id_medico
    INNER JOIN especialidades e ON e.id_especialidad = m.id_especialidad
    WHERE c.id_usuario=? AND c.numero_orden=?
    LIMIT 1
  `;
  try {
    const rows = await q(rid, "citas.byUserOrder", sql, [id_usuario, numero_orden]);
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const r0 = rows[0];
    console.log(`[${rid}] [cita/usuario/orden] <-`, r0);
    res.json({
      IdCita: r0.IdCita,
      UsuarioCita: r0.UsuarioCita,
      Especialidad: r0.Especialidad,
      Medico: r0.Medico,
      FechaCita: r0.FechaCita,      // YYYY-MM-DD (para Android)
      HoraCita: r0.HoraCita,        // HH:mm
      cita_estado: r0.cita_estado,  // CONSISTENTE
      estado_texto: Number(r0.cita_estado) === 1 ? "Confirmada" : "Cancelada",
    });
  } catch {
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

// Detalle por id_cita
app.get("/citamedica/:id_cita", async (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;
  const consulta = `
    SELECT 
      cit.id_cita AS IdCita,
      CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(med.usuario_nombre,' ',med.usuario_apellido) AS Medico,
      DATE_FORMAT(cit.cita_fecha,'%d/%m/%Y') AS FechaCita,     -- UI
      DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d') AS FechaCitaISO,  -- ISO
      TIME_FORMAT(cit.cita_hora,'%H:%i') AS HoraCita,
      cit.cita_estado
    FROM citas cit
    INNER JOIN usuarios us  ON us.id_usuario  = cit.id_usuario
    INNER JOIN medicos m    ON m.id_medico    = cit.id_medico
    INNER JOIN usuarios med ON med.id_usuario = m.id_medico
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_cita = ?`;
  try {
    const rows = await q(rid, "citas.byId", consulta, [id_cita]);
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const r0 = rows[0];
    r0.estado_texto = Number(r0.cita_estado) === 1 ? "Confirmada" : "Cancelada";
    res.json(r0);
  } catch {
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

// Agregar cita
app.post("/cita/agregar", async (req, res) => {
  const rid = req.rid;
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  console.log(`[${rid}] /cita/agregar saneado:`, { id_usuario, id_medico, cita_fecha, cita_hora });

  try {
    const r1 = await q(rid, "citas.countUser", "SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario]);
    const numero_orden = (r1[0]?.total || 0) + 1;

    const ins = `INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden) 
                 VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?)`;
    await q(rid, "citas.insert", ins, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden]);

    await q(
      rid,
      "horarios.ocuparOnAdd",
      `UPDATE horarios_medicos SET horario_estado=1 
       WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`,
      [id_medico, cita_fecha, cita_hora]
    );

    const r3 = await q(rid, "usuarios.mailById", "SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (!r3.length) return res.status(404).json({ error: "Usuario no encontrado" });

    // correo no bloqueante
    correoConfirmacion(rid, r3[0].usuario_correo, cita_fecha, cita_hora).catch((e) =>
      console.error(`[${rid}] [correoConfirmacion] WARN ${e.message}`)
    );

    res.json({ mensaje: "Cita registrada correctamente", numero_orden });
  } catch (e) {
    res.status(500).json({ error: "Error al registrar la cita" });
  }
});

// Actualizar cita
app.put("/cita/actualizar/:id", async (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  try {
    const r0 = await q(rid, "usuarios.mailById", "SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (!r0.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const correo = r0[0].usuario_correo;

    const ant = await q(
      rid,
      "citas.prev",
      "SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?",
      [id]
    );
    if (!ant.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
    const a = ant[0];

    await q(
      rid,
      "horarios.liberarPrev",
      `UPDATE horarios_medicos SET horario_estado=0 
       WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`,
      [a.id_medico, a.cita_fecha, a.cita_hora]
    );

    await q(
      rid,
      "citas.update",
      "UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'), cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=? WHERE id_cita=?",
      [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id]
    );

    await q(
      rid,
      "horarios.ocuparNew",
      `UPDATE horarios_medicos SET horario_estado=1 
       WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`,
      [id_medico, cita_fecha, cita_hora]
    );

    correoActualizacion(rid, correo, cita_fecha, cita_hora).catch((e) =>
      console.error(`[${rid}] [correoActualizacion] WARN ${e.message}`)
    );
    res.json({ mensaje: "Cita actualizada correctamente" });
  } catch (e) {
    res.status(500).json({ mensaje: "Error al actualizar la cita" });
  }
});

// Anular cita por id_cita
app.put("/cita/anular/:id_cita", async (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;
  try {
    const r1 = await q(
      rid,
      "citas.byIdForCancel",
      "SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?",
      [id_cita]
    );
    if (!r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico } = r1[0];
    await q(rid, "citas.cancel", "UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita]);

    await q(
      rid,
      "horarios.liberar",
      `UPDATE horarios_medicos SET horario_estado=0 
       WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`,
      [id_medico, cita_fecha, cita_hora]
    );
    res.json({ mensaje: "Cita cancelada y horario liberado" });
  } catch (e) {
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

// Anular cita por (id_usuario, numero_orden)
app.put("/cita/anular/:id_usuario/:numero_orden", async (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;

  const sel = `
    SELECT id_cita, id_medico,
           DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha,
           TIME_FORMAT(cita_hora ,'%H:%i')    AS hora,
           cita_estado
    FROM citas
    WHERE id_usuario=? AND numero_orden=?
    LIMIT 1;
  `;
  try {
    const r1 = await q(rid, "citas.byUserNumOrden", sel, [id_usuario, numero_orden]);
    if (!r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const c = r1[0];
    if (Number(c.cita_estado) === 0) {
      return res.status(409).json({ mensaje: "La cita ya estaba cancelada" });
    }

    await q(rid, "citas.cancelById", "UPDATE citas SET cita_estado=0 WHERE id_cita=?", [c.id_cita]);
    await q(
      rid,
      "horarios.liberarByUser",
      `UPDATE horarios_medicos SET horario_estado=0
       WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`,
      [c.id_medico, c.fecha, c.hora]
    );
    res.json({ mensaje: "Cita cancelada exitosamente" });
  } catch (e) {
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

/* =========================================
 *  KPI
 * ========================================= */
app.get("/citas/por-dia", async (req, res) => {
  const rid = req.rid;
  const qKpi = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY DATE(cita_fecha)
    ORDER BY DATE(cita_fecha) ASC
  `;
  try {
    const rows = await q(rid, "kpi.citasPorDia", qKpi);
    res.json({ listaCitas: rows.map((r) => ({ fecha: r.fecha, cantidad: r.cantidad })) });
  } catch {
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

/* =========================================
 *  START
 * ========================================= */
app.listen(PUERTO, () => console.log("🚀 Servidor en puerto " + PUERTO));

module.exports = { toYYYYMMDD, verifyPassword };
