// index.js - API Clínica Salud Total (Express + MySQL + Gmail API + Hash login) - v2025-10-11
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
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
 *  MySQL (pool)
 * ========================================= */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 10,
  timezone: "Z", // devolvemos strings controladas con DATE_FORMAT / TIME_FORMAT
});

(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log("Conexion exitosa a la base de datos");
  } catch (e) {
    console.error("ERROR DB:", e.message);
    process.exit(1);
  }
})();

/* =========================================
 *  Gmail API (OAuth2)
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
function wrap(inner) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;
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
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`[${rid}] [@gmail] ok id=${r.data.id} (${Date.now() - t0}ms)`);
  return r.data;
}
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
    html: wrap(`<h2>Cita actualizado</h2><p><b>Nueva fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
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
async function correoCodigoReset(rid, to, codigo) {
  return enviarMail({
    rid, to,
    subject: "Código de recuperación",
    html: wrap(`<h2>Recuperación de contraseña</h2><p>Tu código es: <b style="letter-spacing:2px">${codigo}</b></p><p>Vence hoy a las 23:59:59.</p>`),
    category: "reset-pass",
  });
}

/* =========================================
 *  Helpers de seguridad (hash+salt)
 * ========================================= */
function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function verifyPassword(stored, plain) {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  const calc = sha256Hex(Buffer.concat([Buffer.from(saltHex, "hex"), Buffer.from(plain)]));
  const a = Buffer.from(hashHex, "hex");
  const b = Buffer.from(calc, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function newPasswordHash(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = sha256Hex(Buffer.concat([Buffer.from(salt, "hex"), Buffer.from(plain)]));
  return `${salt}:${hash}`;
}

/* =========================================
 *  Raíz
 * ========================================= */
app.get("/", (_, res) => res.send("Bienvenido a mi servicio web"));

/* =========================================
 *  LOGIN
 * ========================================= */
app.post("/usuario/login", async (req, res) => {
  const { usuario_correo, password } = req.body || {};
  const rid = req.rid;
  try {
    const sql = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?";
    console.log(`[${rid}] SQL> ${sql} params=["${usuario_correo}"]`);
    const [rows] = await pool.query(sql, [usuario_correo]);
    if (!rows.length) return res.status(401).json({ mensaje: "Credenciales inválidas" });

    const user = rows[0];
    const ok = verifyPassword(user.usuario_contrasena_hash, password || "");
    if (!ok) return res.status(401).json({ mensaje: "Credenciales inválidas" });

    return res.json({
      id_usuario: user.id_usuario,
      usuario_nombre: user.usuario_nombre,
      usuario_apellido: user.usuario_apellido,
      usuario_correo: user.usuario_correo,
      usuario_tipo: user.usuario_tipo,
    });
  } catch (e) {
    console.error(`[${rid}] /usuario/login ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

/* =========================================
 *  RESET PASSWORD (tabla reset_codes)
 * ========================================= */
app.post("/usuario/reset/solicitar", async (req, res) => {
  const rid = req.rid;
  const { usuario_correo } = req.body || {};
  try {
    const [rows] = await pool.query("SELECT id_usuario FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = sha256Hex(codigo);
    const hoy = new Date();
    const yyyy = hoy.getUTCFullYear();
    const mm = String(hoy.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(hoy.getUTCDate()).padStart(2, "0");
    const expires = `${yyyy}-${mm}-${dd} 23:59:59`;

    const ins = "INSERT INTO reset_codes (email, code_hash, expires_at, used) VALUES (?,?,?,0)";
    console.log(`[${rid}] SQL> ${ins} params=["${usuario_correo}","${codeHash}","${expires}"]`);
    await pool.query(ins, [usuario_correo, codeHash, expires]);

    await correoCodigoReset(rid, usuario_correo, codigo);
    res.json({ mensaje: "Código enviado" });
  } catch (e) {
    console.error(`[${rid}] /usuario/reset/solicitar ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.post("/usuario/reset/cambiar", async (req, res) => {
  const rid = req.rid;
  const { usuario_correo, codigo, nueva_contrasena } = req.body || {};
  if (!usuario_correo || !codigo || !nueva_contrasena) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }
  try {
    const codeHash = sha256Hex(String(codigo).replace(/\s+/g, ""));
    const sel = `SELECT id, used, expires_at FROM reset_codes WHERE email=? AND code_hash=? ORDER BY id DESC LIMIT 1`;
    const [rows] = await pool.query(sel, [usuario_correo, codeHash]);
    if (!rows.length) return res.status(400).json({ mensaje: "Código inválido" });
    const rec = rows[0];
    if (rec.used) return res.status(400).json({ mensaje: "Código ya usado" });
    if (new Date(rec.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ mensaje: "Código expirado" });
    }
    const newHash = newPasswordHash(nueva_contrasena);
    await pool.query("UPDATE usuarios SET usuario_contrasena_hash=? WHERE usuario_correo=?", [newHash, usuario_correo]);
    await pool.query("UPDATE reset_codes SET used=1 WHERE id=?", [rec.id]);
    res.json({ mensaje: "Contraseña actualizada" });
  } catch (e) {
    console.error(`[${rid}] /usuario/reset/cambiar ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

/* =========================================
 *  ALIAS usados por Android (consulta correo + recuperar)
 * ========================================= */
app.post("/usuario/recuperar-correo", async (req, res) => {
  const rid = req.rid;
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  if (!usuario_dni) return res.status(400).json({ mensaje: "usuario_dni requerido" });
  try {
    const sql = `
      SELECT usuario_correo
        FROM usuarios
       WHERE usuario_dni = ?
         AND ( ( ? IS NULL OR ? = '' ) OR LOWER(usuario_nombre) = LOWER(?) )
         AND ( ( ? IS NULL OR ? = '' ) OR LOWER(usuario_apellido) = LOWER(?) )
       LIMIT 1`;
    const [rows] = await pool.query(sql, [
      usuario_dni,
      usuario_nombre, usuario_nombre, usuario_nombre,
      usuario_apellido, usuario_apellido, usuario_apellido
    ]);
    if (!rows.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: rows[0].usuario_correo });
  } catch (e) {
    console.error(`[${rid}] /usuario/recuperar-correo ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.post("/usuario/recuperar-contrasena", async (req, res) => {
  const rid = req.rid;
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "usuario_correo requerido" });
  try {
    const [rows] = await pool.query("SELECT id_usuario FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = sha256Hex(codigo);
    const hoy = new Date();
    const yyyy = hoy.getUTCFullYear();
    const mm = String(hoy.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(hoy.getUTCDate()).padStart(2, "0");
    const expires = `${yyyy}-${mm}-${dd} 23:59:59`;

    const ins = "INSERT INTO reset_codes (email, code_hash, expires_at, used) VALUES (?,?,?,0)";
    await pool.query(ins, [usuario_correo, codeHash, expires]);
    await correoCodigoReset(rid, usuario_correo, codigo);
    res.json({ mensaje: "Código enviado" });
  } catch (e) {
    console.error(`[${rid}] /usuario/recuperar-contrasena ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

/* =========================================
 *  USUARIOS
 * ========================================= */
app.get("/usuarios", async (req, res) => {
  const rid = req.rid;
  try {
    const [rows] = await pool.query("SELECT * FROM usuarios");
    res.json(rows.length ? { listaUsuarios: rows } : { mensaje: "no hay registros" });
  } catch (e) {
    console.error(`[${rid}] /usuarios ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.get("/usuario", async (req, res) => {
  const rid = req.rid;
  const correo = req.query.correo;
  if (!correo) return res.status(400).json({ mensaje: "Parámetro 'correo' requerido" });
  try {
    const [rows] = await pool.query("SELECT * FROM usuarios WHERE usuario_correo=?", [correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(rows[0]);
  } catch (e) {
    console.error(`[${rid}] /usuario?correo ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.get("/usuario/:correo", async (req, res) => {
  const rid = req.rid;
  const correo = decodeURIComponent(req.params.correo);
  try {
    const [rows] = await pool.query("SELECT * FROM usuarios WHERE usuario_correo=?", [correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(rows[0]);
  } catch (e) {
    console.error(`[${rid}] /usuario/:correo ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.post("/usuario/agregar", async (req, res) => {
  const rid = req.rid;
  try {
    const {
      usuario_nombre, usuario_apellido, usuario_correo,
      usuario_dni, usuario_contrasena, usuario_tipo = 1
    } = req.body || {};

    if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) {
      return res.status(400).json({ mensaje: "El DNI debe tener 8 dígitos." });
    }
    if (!usuario_nombre || !usuario_apellido) {
      return res.status(400).json({ mensaje: "Nombre y apellido obligatorios." });
    }
    if (!usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo)) {
      return res.status(400).json({ mensaje: "Correo no válido." });
    }
    if (!usuario_contrasena || usuario_contrasena.length < 6) {
      return res.status(400).json({ mensaje: "Contraseña mínima 6 caracteres." });
    }

    const usuario_contrasena_hash = newPasswordHash(usuario_contrasena);
    const ins = `INSERT INTO usuarios (usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash,usuario_tipo)
                 VALUES (?,?,?,?,?,?)`;
    const [r] = await pool.query(ins, [usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena_hash, usuario_tipo]);
    await correoBienvenida(rid, usuario_correo, `${usuario_nombre} ${usuario_apellido}`);
    res.json({ mensaje: "Usuario registrado correctamente.", id_usuario: r.insertId });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      if (String(e.sqlMessage || "").includes("usuario_dni")) {
        return res.status(400).json({ mensaje: "DNI ya está registrado" });
      }
      if (String(e.sqlMessage || "").includes("usuario_correo")) {
        return res.status(400).json({ mensaje: "El correo ya está registrado." });
      }
      return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
    }
    console.error(`/usuario/agregar ERROR`, e);
    res.status(500).json({ mensaje: "Error al registrar usuario." });
  }
});

app.post("/usuario/registrar", async (req, res) => {
  // Registrar médico con especialidad (opcional)
  const rid = req.rid;
  try {
    const {
      usuario_nombre, usuario_apellido, usuario_correo,
      usuario_dni, usuario_contrasena, usuario_tipo = 2, // 2 = Médico
      id_especialidad
    } = req.body || {};

    if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) {
      return res.status(400).json({ mensaje: "El DNI debe tener 8 dígitos." });
    }
    if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_contrasena) {
      return res.status(400).json({ mensaje: "Datos de usuario incompletos." });
    }
    const usuario_contrasena_hash = newPasswordHash(usuario_contrasena);
    const [ru] = await pool.query(
      `INSERT INTO usuarios (usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash,usuario_tipo)
       VALUES (?,?,?,?,?,?)`,
      [usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena_hash, usuario_tipo]
    );

    if (usuario_tipo === 2 && id_especialidad) {
      await pool.query(`INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)`, [ru.insertId, id_especialidad]);
    }

    await correoBienvenida(rid, usuario_correo, `${usuario_nombre} ${usuario_apellido}`);
    res.json({ mensaje: "Usuario registrado correctamente.", id_usuario: ru.insertId });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ mensaje: "Correo o DNI duplicado." });
    }
    console.error(`/usuario/registrar ERROR`, e);
    res.status(500).json({ mensaje: "Error al registrar usuario." });
  }
});

app.put("/usuario/actualizar/:id", async (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Nombre, apellido y correo son obligatorios" });
  }
  try {
    const [dup] = await pool.query("SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario<>?", [usuario_correo, id]);
    if (dup.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });
    const [r] = await pool.query(
      "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre, usuario_apellido, usuario_correo, id]
    );
    res.json({ mensaje: "Usuario actualizado correctamente" });
  } catch (e) {
    console.error(`[${rid}] /usuario/actualizar ERROR`, e);
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

/* =========================================
 *  ESPECIALIDADES
 * ========================================= */
app.get("/especialidades", async (req, res) => {
  const rid = req.rid;
  try {
    const [rows] = await pool.query("SELECT * FROM especialidades");
    res.json(rows.length ? { listaEspecialidades: rows } : { mensaje: "no hay registros" });
  } catch (e) {
    console.error(`[${rid}] /especialidades ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});
app.post("/especialidad/agregar", async (req, res) => {
  const rid = req.rid;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    await pool.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre]);
    res.status(201).json("Especialidad registrada");
  } catch (e) {
    console.error(`[${rid}] /especialidad/agregar ERROR`, e);
    res.status(500).json({ error: "Error al guardar especialidad" });
  }
});
app.put("/especialidad/actualizar/:id", async (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  try {
    await pool.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id]);
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  } catch (e) {
    console.error(`[${rid}] /especialidad/actualizar ERROR`, e);
    res.status(500).json({ error: "Error al actualizar especialidad" });
  }
});

/* =========================================
 *  MÉDICOS
 * ========================================= */
app.get("/medicos", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM medicos");
    res.json(rows.length ? { listaCitas: rows } : { mensaje: "no hay registros" });
  } catch (e) {
    res.status(500).json({ mensaje: "Error interno" });
  }
});
app.get("/medico/:id_medico/especialidades", async (req, res) => {
  const rid = req.rid;
  const { id_medico } = req.params;
  try {
    const sql = `
      SELECT e.* 
        FROM medicos m 
        JOIN especialidades e ON e.id_especialidad=m.id_especialidad
       WHERE m.id_medico=?`;
    const [rows] = await pool.query(sql, [id_medico]);
    res.json({ listaEspecialidades: rows });
  } catch (e) {
    console.error(`[${rid}] /medico/:id_medico/especialidades ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

/* =========================================
 *  HORARIOS
 * ========================================= */
function hhmmToHHMMSS(hora) {
  if (!hora) return hora;
  return /^\d{2}:\d{2}$/.test(hora) ? `${hora}:00` : hora;
}

// Horarios detallados (libres) por fecha + especialidad (para CitaActivity)
app.get("/horarios/:fecha/:id_especialidad", async (req, res) => {
  const rid = req.rid;
  const { fecha, id_especialidad } = req.params;
  try {
    const sql = `
      SELECT h.id_horario,
             h.id_medico,
             DATE_FORMAT(h.horario_fecha,'%Y-%m-%d') AS horario_fecha,
             TIME_FORMAT(h.horario_hora,'%H:%i')     AS horario_horas,
             u.usuario_nombre AS medico_nombre,
             u.usuario_apellido AS medico_apellido
        FROM horarios_medicos h
        INNER JOIN medicos m ON h.id_medico=m.id_medico
        INNER JOIN usuarios u ON m.id_medico=u.id_usuario
       WHERE h.horario_fecha=? AND h.id_especialidad=? AND h.horario_estado=0
       ORDER BY h.horario_hora ASC`;
    const [rows] = await pool.query(sql, [fecha, id_especialidad]);
    res.json({ listaHorarios: rows });
  } catch (e) {
    console.error(`[${rid}] /horarios/:fecha/:id_especialidad ERROR`, e);
    res.status(500).json({ error: "Error al obtener horarios" });
  }
});

// Horarios disponibles (solo horas) para pantalla del médico
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const rid = req.rid;
  const { id_medico, fecha, id_especialidad } = req.params;
  try {
    const sql = `
      SELECT TIME_FORMAT(horario_hora, '%H:%i:%s') AS hora
        FROM horarios_medicos
       WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
       ORDER BY horario_hora ASC`;
    const [rows] = await pool.query(sql, [id_medico, fecha, id_especialidad]);
    res.json({ horariosDisponibles: rows.map(r => r.hora) });
  } catch (e) {
    console.error(`[${rid}] /horarios/disponibles ERROR`, e);
    res.status(500).json({ mensaje: "Error al obtener horarios disponibles" });
  }
});

// Horarios registrados (todos los estados) para edición del médico
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const rid = req.rid;
  const { id_medico, fecha, id_especialidad } = req.params;
  try {
    const sql = `
      SELECT TIME_FORMAT(horario_hora, '%H:%i:%s') AS hora
        FROM horarios_medicos
       WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?
       ORDER BY horario_hora ASC`;
    const [rows] = await pool.query(sql, [id_medico, fecha, id_especialidad]);
    res.json({ horarios: rows.map(r => r.hora) });
  } catch (e) {
    console.error(`[${rid}] /horarios/registrados ERROR`, e);
    res.status(500).json({ mensaje: "Error al obtener horarios" });
  }
});

// Registrar horario (evita duplicado por UNIQUE uk_horario_medico)
app.post("/horario/registrar", async (req, res) => {
  const rid = req.rid;
  const { id_medico, id_especialidad, fecha, hora } = req.body || {};
  if (!id_medico || !id_especialidad || !fecha || !hora) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }
  try {
    const ins = `
      INSERT INTO horarios_medicos (id_medico, horario_fecha, horario_hora, horario_estado, id_especialidad)
      VALUES (?, ?, ?, 0, ?)`;
    const [r] = await pool.query(ins, [id_medico, fecha, hhmmToHHMMSS(hora), id_especialidad]);
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r.insertId });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ mensaje: "El horario ya existe" });
    }
    console.error(`[${rid}] /horario/registrar ERROR`, e);
    res.status(500).json({ mensaje: "Error al registrar horario" });
  }
});

// Editar / Eliminar / Ocupar / Liberar (clave compuesta)
app.put("/horario/editar/:id_medico/:fecha/:hora", async (req, res) => {
  const rid = req.rid;
  const { id_medico } = req.params;
  const fecha = req.params.fecha;
  const hora  = hhmmToHHMMSS(req.params.hora);
  const { accion, nuevaHora, id_especialidad } = req.body || {};
  if (!accion || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos (accion, id_especialidad)" });
  }
  try {
    if (accion === "eliminar") {
      const [r] = await pool.query(
        `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [id_medico, fecha, hora, id_especialidad]
      );
      if (!r.affectedRows) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Horario eliminado correctamente" });
    }
    if (accion === "actualizar") {
      if (!nuevaHora) return res.status(400).json({ mensaje: "nuevaHora requerida" });
      const nueva = hhmmToHHMMSS(nuevaHora);
      const [r] = await pool.query(
        `UPDATE horarios_medicos SET horario_hora=?, horario_estado=0
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [nueva, id_medico, fecha, hora, id_especialidad]
      );
      if (!r.affectedRows) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Horario actualizado correctamente" });
    }
    if (accion === "ocupar" || accion === "liberar") {
      const estado = (accion === "ocupar") ? 1 : 0;
      const [r] = await pool.query(
        `UPDATE horarios_medicos SET horario_estado=? 
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [estado, id_medico, fecha, hora, id_especialidad]
      );
      if (!r.affectedRows) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: estado ? "Horario ocupado" : "Horario liberado" });
    }
    return res.status(400).json({ mensaje: "Acción no reconocida" });
  } catch (e) {
    console.error(`[${rid}] /horario/editar ERROR`, e);
    res.status(500).json({ mensaje: "Error al editar horario" });
  }
});

// (Opcional) Actualizar por id_horario
app.put("/horario/actualizar/:id_horario", async (req, res) => {
  const rid = req.rid;
  const { id_horario } = req.params;
  const { accion, nueva_hora, estado } = req.body || {};
  try {
    if (accion === "mover") {
      if (!nueva_hora) return res.status(400).json({ mensaje: "nueva_hora requerida" });
      const [r] = await pool.query(
        `UPDATE horarios_medicos SET horario_hora=?, horario_estado=0 WHERE id_horario=?`,
        [hhmmToHHMMSS(nueva_hora), id_horario]
      );
      if (!r.affectedRows) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Horario movido" });
    }
    if (accion === "estado") {
      if (estado !== 0 && estado !== 1) return res.status(400).json({ mensaje: "estado debe ser 0 o 1" });
      const [r] = await pool.query(`UPDATE horarios_medicos SET horario_estado=? WHERE id_horario=?`, [estado, id_horario]);
      if (!r.affectedRows) return res.status(404).json({ mensaje: "Horario no encontrado" });
      return res.json({ mensaje: "Estado actualizado" });
    }
    return res.status(400).json({ mensaje: "Acción no reconocida" });
  } catch (e) {
    console.error(`[${rid}] /horario/actualizar ERROR`, e);
    res.status(500).json({ mensaje: "Error al actualizar horario" });
  }
});

/* =========================================
 *  CITAS
 * ========================================= */
app.get("/citas/por-dia", async (req, res) => {
  const rid = req.rid;
  try {
    const sql = `
      SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
        FROM citas
       WHERE cita_estado=1
       GROUP BY cita_fecha
       ORDER BY cita_fecha ASC`;
    const [rows] = await pool.query(sql);
    res.json({ listaCitas: rows });
  } catch (e) {
    console.error(`[${rid}] /citas/por-dia ERROR`, e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.get("/citas/:usuario", async (req, res) => {
  const rid = req.rid;
  const { usuario } = req.params;
  if (String(usuario) === "0") return res.json({ listaCitas: [] });
  try {
    const sql = `
      SELECT c.id_cita, c.id_usuario, c.id_medico,
             DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
             TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
             u.usuario_nombre AS medico_nombre,
             u.usuario_apellido AS medico_apellido,
             e.id_especialidad, e.especialidad_nombre,
             c.cita_estado
        FROM citas c
        JOIN medicos m ON c.id_medico=m.id_medico
        JOIN usuarios u ON m.id_medico=u.id_usuario
        JOIN especialidades e ON m.id_especialidad=e.id_especialidad
       WHERE c.id_usuario=?
       ORDER BY c.id_cita ASC`;
    const [rows] = await pool.query(sql, [usuario]);
    const citasNumeradas = rows.map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas: citasNumeradas });
  } catch (e) {
    console.error(`[${rid}] /citas/:usuario ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.get("/citas/medico/:id_medico", async (req, res) => {
  const rid = req.rid;
  const { id_medico } = req.params;
  try {
    const sql = `
      SELECT c.id_cita, c.id_usuario, c.id_medico,
             DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
             TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
             u.usuario_nombre AS paciente_nombre,
             u.usuario_apellido AS paciente_apellido,
             c.cita_estado
        FROM citas c
        JOIN usuarios u ON c.id_usuario=u.id_usuario
       WHERE c.id_medico=?
       ORDER BY c.cita_fecha, c.cita_hora`;
    const [rows] = await pool.query(sql, [id_medico]);
    res.json({ listaCitas: rows });
  } catch (e) {
    console.error(`[${rid}] /citas/medico ERROR`, e);
    res.status(500).json({ mensaje: "Error interno" });
  }
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", async (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;
  try {
    const sql = `
      SELECT 
        cit.id_cita AS IdCita,
        CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
        esp.especialidad_nombre AS Especialidad,
        CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
        DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d') AS FechaCita,
        TIME_FORMAT(cit.cita_hora,'%H:%i') AS HoraCita,
        CASE WHEN cit.cita_estado=1 THEN 'Confirmada'
             WHEN cit.cita_estado=0 THEN 'Cancelada'
             ELSE 'Desconocido' END AS EstadoCita
       FROM citas cit
       INNER JOIN usuarios us ON us.id_usuario=cit.id_usuario
       INNER JOIN medicos m ON m.id_medico=cit.id_medico
       INNER JOIN usuarios mu ON m.id_medico=mu.id_usuario
       INNER JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
       WHERE cit.id_usuario=? AND cit.numero_orden=?`;
    const [rows] = await pool.query(sql, [id_usuario, numero_orden]);
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  } catch (e) {
    console.error(`[${rid}] /cita/usuario/... ERROR`, e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.post("/cita/agregar", async (req, res) => {
  const rid = req.rid;
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  try {
    const qSlot = `SELECT id_horario, id_especialidad, horario_estado
                     FROM horarios_medicos
                    WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
    const [slotRows] = await pool.query(qSlot, [id_medico, cita_fecha, hhmmToHHMMSS(cita_hora)]);
    if (!slotRows.length || slotRows[0].horario_estado !== 0) {
      return res.status(409).json({ mensaje: "El horario no está disponible" });
    }

    const [cnt] = await pool.query("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario]);
    const numero_orden = (cnt[0]?.total || 0) + 1;

    const [rIns] = await pool.query(
      `INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado) VALUES (?,?,?,?,?,1)`,
      [id_usuario, id_medico, cita_fecha, hhmmToHHMMSS(cita_hora), numero_orden]
    );

    await pool.query("UPDATE horarios_medicos SET horario_estado=1 WHERE id_horario=?", [slotRows[0].id_horario]);

    const [mailRow] = await pool.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (mailRow.length) await correoConfirmacion(rid, mailRow[0].usuario_correo, cita_fecha, cita_hora);

    res.json({ mensaje: "Cita registrada correctamente", numero_orden, id_cita: rIns.insertId });
  } catch (e) {
    console.error(`[${rid}] /cita/agregar ERROR`, e);
    res.status(500).json({ error: "Error al registrar la cita" });
  }
});

app.put("/cita/actualizar/:id", async (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado = 1 } = req.body || {};
  try {
    const [prev] = await pool.query("SELECT cita_fecha, cita_hora, id_medico FROM citas WHERE id_cita=?", [id]);
    if (!prev.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    await pool.query(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [prev[0].cita_fecha, prev[0].cita_hora, prev[0].id_medico]
    );

    const [slotRows] = await pool.query(
      "SELECT id_horario, horario_estado FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=?",
      [id_medico, cita_fecha, hhmmToHHMMSS(cita_hora)]
    );
    if (!slotRows.length || slotRows[0].horario_estado !== 0) {
      return res.status(409).json({ mensaje: "El nuevo horario no está disponible" });
    }

    const [rUpd] = await pool.query(
      `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=? WHERE id_cita=?`,
      [id_usuario, id_medico, cita_fecha, hhmmToHHMMSS(cita_hora), cita_estado, id]
    );

    await pool.query("UPDATE horarios_medicos SET horario_estado=1 WHERE id_horario=?", [slotRows[0].id_horario]);

    const [mailRow] = await pool.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (mailRow.length) await correoActualizacion(rid, mailRow[0].usuario_correo, cita_fecha, cita_hora);

    res.json({ mensaje: "Cita actualizada correctamente" });
  } catch (e) {
    console.error(`[${rid}] /cita/actualizar ERROR`, e);
    res.status(500).json({ mensaje: "Error al actualizar la cita" });
  }
});

app.put("/cita/anular/:id_usuario/:numero_orden", async (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT id_cita, cita_fecha, cita_hora, id_medico 
         FROM citas 
        WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`,
      [id_usuario, numero_orden]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = rows[0];
    await pool.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita]);
    await pool.query(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [cita_fecha, cita_hora, id_medico]
    );

    const [mailRow] = await pool.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (mailRow.length) await correoCancelacion(rid, mailRow[0].usuario_correo, cita_fecha, cita_hora);

    res.json({ mensaje: "Cita cancelada exitosamente" });
  } catch (e) {
    console.error(`[${rid}] /cita/anular ERROR`, e);
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

app.put("/cita/estado/:id_cita", async (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;
  const { estado } = req.body || {};
  if (estado !== 0 && estado !== 1) return res.status(400).json({ mensaje: "estado debe ser 0 o 1" });
  try {
    const [r] = await pool.query("UPDATE citas SET cita_estado=? WHERE id_cita=?", [estado, id_cita]);
    if (!r.affectedRows) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json({ mensaje: "Estado de cita actualizado" });
  } catch (e) {
    console.error(`[${rid}] /cita/estado ERROR`, e);
    res.status(500).json({ mensaje: "Error al actualizar estado de cita" });
  }
});

/* =========================================
 *  Arranque
 * ========================================= */
app.listen(PUERTO, () => {
  console.log("Servidor corriendo en el puerto " + PUERTO);
});
