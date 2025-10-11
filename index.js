// index.js - API Clínica Salud Total (Express + MySQL + Gmail API) - v2025-10-11
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 10000;
app.use(express.json());

/* =========================================
 *  MySQL (pool promise)
 * ========================================= */
const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z", // UTC
});

async function dbQuery(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/* =========================================
 *  Request-ID + Logs + no-cache
 * ========================================= */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    try { console.log(`[${req.rid}] body:`, req.body); } catch {}
  }
  res.set("Cache-Control", "no-store");
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
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function enviarMail({ rid, to, subject, html, text, category = "notificaciones" }) {
  const from = `Clínica Salud Total <${GMAIL_USER}>`;
  const plain =
    text ||
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=boundary001",
    `X-Category: ${category}`,
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
 *  Utilidades
 * ========================================= */
function normalizeFechaParam(fechaRaw = "") {
  if (!fechaRaw) return fechaRaw;
  const isoMatch = fechaRaw.match(/^(\d{4}-\d{2}-\d{2})T/); // "YYYY-MM-DDT..."
  if (isoMatch) return isoMatch[1];
  if (fechaRaw.includes("/")) return fechaRaw.replace(/\//g, "-"); // "YYYY/MM/DD" -> "YYYY-MM-DD"
  return fechaRaw; // ya era "YYYY-MM-DD"
}

function toYYYYMMDD(date) {
  // date puede ser Date o string de MySQL. Forzamos a YYYY-MM-DD en UTC.
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/* =========================================
 *  Rutas
 * ========================================= */
app.get("/", (req, res) => res.send("Bienvenido a mi servicio web"));

/* -------- Usuarios (listado) -------- */
app.get("/usuarios", async (req, res) => {
  try {
    const rows = await dbQuery("SELECT * FROM usuarios");
    res.json({ listaUsuarios: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

/* -------- Usuario: registro simple (legacy) -------- */
app.post("/usuario/agregar", async (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo)) return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  try {
    // generar hash salteado
    const salt = crypto.randomBytes(16).toString("hex"); // 32 hex
    const hash = sha256Hex(Buffer.from(salt + usuario_contrasena, "utf8"));
    const stored = `${salt}:${hash}`;

    await dbQuery(
      "INSERT INTO usuarios (usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash,usuario_tipo) VALUES (?,?,?,?,?,1)",
      [usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, stored]
    );

    await correoBienvenida(req.rid, usuario_correo, `${usuario_nombre} ${usuario_apellido}`);
    res.json({ mensaje: "Usuario registrado correctamente." });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      const msg = (e.sqlMessage || "").includes("usuario_dni")
        ? "DNI ya está registrado"
        : (e.sqlMessage || "").includes("usuario_correo")
          ? "El correo ya está registrado."
          : "Datos duplicados en campos únicos.";
      return res.status(400).json({ mensaje: msg });
    }
    console.error(e);
    res.status(500).json({ mensaje: "Error al registrar usuario." });
  }
});

/* -------- Usuario: actualizar -------- */
app.put("/usuario/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  console.log(`[${req.rid}] PUT /usuario/actualizar/${id}`, { usuario_nombre, usuario_apellido, usuario_correo });

  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  try {
    const dup = await dbQuery("SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario<>?", [usuario_correo, id]);
    if (dup.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const r = await dbQuery(
      "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre, usuario_apellido, usuario_correo, id]
    );
    console.log(`[${req.rid}] actualizado filas=${r.affectedRows || (r.info && r.info.affectedRows) || "?"}`);
    res.json({ mensaje: "Usuario actualizado correctamente" });
  } catch (e) {
    console.error(`[${req.rid}] error actualizar`, e);
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

/* -------- Usuario: registrar (con especialidad para médico) -------- */
app.post("/usuario/registrar", async (req, res) => {
  const {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena,
    usuario_tipo,
    id_especialidad,
  } = req.body || {};

  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }
  try {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = sha256Hex(Buffer.from(salt + usuario_contrasena, "utf8"));
    const stored = `${salt}:${hash}`;

    const r = await dbQuery(
      "INSERT INTO usuarios (usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash,usuario_tipo) VALUES (?,?,?,?,?,?)",
      [usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, stored, usuario_tipo]
    );
    const id_usuario = r.insertId;

    if (usuario_tipo === 2 && id_especialidad) {
      try {
        await dbQuery("INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?)", [id_usuario, id_especialidad]);
        return res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      } catch (e) {
        console.error("Error al insertar en médicos:", e);
        return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
      }
    }
    res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      const msg = (e.sqlMessage || "").includes("usuario_dni")
        ? "DNI ya está registrado"
        : (e.sqlMessage || "").includes("usuario_correo")
          ? "El correo ya está registrado."
          : "Datos duplicados en campos únicos.";
      return res.status(400).json({ mensaje: msg });
    }
    console.error(e);
    res.status(500).json({ mensaje: "Error al registrar usuario" });
  }
});

/* -------- Usuario: login (hash salteado salt:sha256(salt+password)) -------- */
app.post("/usuario/login", async (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) return res.status(400).json({ mensaje: "Correo y contraseña requeridos" });

  try {
    const rows = await dbQuery(
      "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?",
      [usuario_correo]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "No se encontró una cuenta con ese correo." });

    const u = rows[0];
    const [salt, hex] = String(u.usuario_contrasena_hash || "").split(":");
    if (!salt || !hex) return res.status(500).json({ mensaje: "Hash inválido almacenado" });

    const calc = sha256Hex(Buffer.from(salt + password, "utf8"));
    if (calc !== hex) return res.status(401).json({ mensaje: "Contraseña incorrecta" });

    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error en el servidor" });
  }
});

/* -------- Reset por código (nuevo flujo) -------- */
app.post("/usuario/reset/solicitar", async (req, res) => {
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "usuario_correo requerido" });

  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
  const codeHash = sha256Hex(Buffer.from(code, "utf8"));
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  try {
    const rows = await dbQuery("SELECT 1 FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    await dbQuery(
      "INSERT INTO reset_codes (email,code_hash,expires_at,used) VALUES (?,?,?,0)",
      [usuario_correo, codeHash, expiresAt]
    );

    await enviarMail({
      rid: req.rid,
      to: usuario_correo,
      subject: "Tu código de recuperación",
      html: wrap(`<h2>Código de recuperación</h2><p>Tu código es <b>${code}</b>. Vence en 15 minutos.</p>`),
      category: "reset-codigo",
    });

    res.json({ mensaje: "Código enviado" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al generar código" });
  }
});

app.post("/usuario/reset/cambiar", async (req, res) => {
  const { usuario_correo, codigo, nueva_contrasena } = req.body || {};
  if (!usuario_correo || !codigo || !nueva_contrasena) {
    return res.status(400).json({ mensaje: "correo, código y nueva contraseña requeridos" });
  }
  if (nueva_contrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres" });

  try {
    const codeHash = sha256Hex(Buffer.from(codigo, "utf8"));
    const rows = await dbQuery(
      "SELECT id,expires_at,used FROM reset_codes WHERE email=? AND code_hash=? ORDER BY id DESC LIMIT 1",
      [usuario_correo, codeHash]
    );
    if (!rows.length) return res.status(400).json({ mensaje: "Código inválido" });
    const rc = rows[0];
    if (rc.used) return res.status(400).json({ mensaje: "Código ya usado" });
    if (new Date(rc.expires_at).getTime() < Date.now()) return res.status(400).json({ mensaje: "Código expirado" });

    // actualizar password
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = sha256Hex(Buffer.from(salt + nueva_contrasena, "utf8"));
    const stored = `${salt}:${hash}`;

    await dbQuery("UPDATE usuarios SET usuario_contrasena_hash=? WHERE usuario_correo=?", [stored, usuario_correo]);
    await dbQuery("UPDATE reset_codes SET used=1 WHERE id=?", [rc.id]);

    res.json({ mensaje: "Contraseña actualizada" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al actualizar contraseña" });
  }
});

/* -------- Recuperar correo por DNI+nombre+apellido (legacy) -------- */
app.post("/usuario/recuperar-correo", async (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  try {
    const rows = await dbQuery(
      "SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?",
      [usuario_dni, usuario_nombre, usuario_apellido]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: rows[0].usuario_correo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* -------- Recuperar contraseña (legacy: envía la actual -> ahora enviamos instrucción segura) -------- */
app.post("/usuario/recuperar-contrasena", async (req, res) => {
  const { usuario_correo } = req.body || {};
  try {
    const rows = await dbQuery("SELECT usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    await enviarMail({
      rid: req.rid,
      to: usuario_correo,
      subject: "Recuperación de contraseña",
      html: wrap(`<h2>Recuperación de contraseña</h2><p>Ingresa a la app y usa la opción <b>“Olvidé mi contraseña”</b> para recibir tu código.</p>`),
      category: "reset-legacy",
    });
    res.json({ mensaje: "Instrucciones enviadas" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/* -------- Especialidades -------- */
app.get("/especialidades", async (req, res) => {
  try {
    const rows = await dbQuery("SELECT * FROM especialidades");
    res.json({ listaEspecialidades: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al obtener especialidades" });
  }
});

app.post("/especialidad/agregar", async (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    const r = await dbQuery("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre]);
    res.status(201).json("Especialidad registrada");
  } catch (e) {
    console.error("Error al insertar especialidad:", e.message);
    res.status(500).json({ error: "Error al guardar especialidad" });
  }
});

app.put("/especialidad/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  try {
    await dbQuery("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id]);
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  } catch (e) {
    console.error("Error al actualizar especialidad:", e.message);
    res.status(500).json({ error: "Error al actualizar especialidad" });
  }
});

/* -------- Horarios -------- */
app.get("/medico/:id_medico/especialidades", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const rows = await dbQuery(
      `SELECT e.id_especialidad, e.especialidad_nombre
       FROM medicos m
       JOIN especialidades e ON m.id_especialidad = e.id_especialidad
       WHERE m.id_medico = ?`,
      [id_medico]
    );
    res.json({ listaEspecialidades: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener especialidades" });
  }
});

app.get("/horarios/:parametro", async (req, res) => {
  try {
    const [rawFecha, id_especialidad] = req.params.parametro.split("&");
    const fecha = normalizeFechaParam(decodeURIComponent(rawFecha));
    console.log(`[${req.rid}] GET /horarios`, { fecha, id_especialidad });

    const rows = await dbQuery(
      `SELECT h.*,
              TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
              u.usuario_nombre AS medico_nombre,
              u.usuario_apellido AS medico_apellido,
              e.especialidad_nombre
       FROM horarios_medicos h
       JOIN medicos m ON h.id_medico=m.id_medico
       JOIN usuarios u ON m.id_medico=u.id_usuario
       JOIN especialidades e ON h.id_especialidad=e.id_especialidad
       WHERE h.horario_fecha=? AND h.id_especialidad=? AND h.horario_estado=0
       ORDER BY h.horario_hora ASC`,
      [fecha, id_especialidad]
    );

    res.json({ listaHorarios: rows || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al listar horarios" });
  }
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = normalizeFechaParam(req.params.fecha);
  try {
    const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
    const rows = await dbQuery(
      `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`,
      [id_medico, fecha, id_especialidad]
    );
    const horasOcupadas = rows.map(r => r.hora);
    const horasDisponibles = todasLasHoras.filter(h => !horasOcupadas.includes(h));
    res.json({ horariosDisponibles: horasDisponibles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al consultar horarios" });
  }
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = normalizeFechaParam(req.params.fecha);
  try {
    const rows = await dbQuery(
      `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
        ORDER BY horario_hora ASC`,
      [id_medico, fecha, id_especialidad]
    );
    res.json({ horarios: rows.map(r => r.hora) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.post("/horario/registrar", async (req, res) => {
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body || {};
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  try {
    await dbQuery(
      `INSERT INTO horarios_medicos (id_medico,horario_hora,horario_fecha,horario_estado,id_especialidad)
       VALUES (?,?,?,?,?)`,
      [id_medico, horario_horas, normalizeFechaParam(horario_fecha), 0, id_especialidad]
    );
    const r2 = await dbQuery("SELECT LAST_INSERT_ID() AS id_horario");
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r2[0].id_horario });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
    }
    console.error("Error al registrar horario:", e.message);
    res.status(500).json({ error: "Error interno al registrar el horario" });
  }
});

app.put("/horario/editar/:id_medico/:fecha/:hora", async (req, res) => {
  const { id_medico, hora } = req.params;
  const fecha = normalizeFechaParam(req.params.fecha);
  const { accion, nuevaHora, id_especialidad } = req.body || {};

  console.log(`[${req.rid}] PUT /horario/editar`, { id_medico, fecha, hora, accion, id_especialidad, nuevaHora });

  if (!accion || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos" });
  }

  try {
    if (accion === "eliminar") {
      await dbQuery(
        `DELETE FROM horarios_medicos 
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [id_medico, fecha, hora, id_especialidad]
      );
      return res.json({ mensaje: "Horario eliminado correctamente" });
    }

    if (accion === "actualizar") {
      if (!nuevaHora) return res.status(400).json({ mensaje: "nuevaHora requerida" });
      await dbQuery(
        `UPDATE horarios_medicos 
           SET horario_hora=?, horario_estado=0
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [nuevaHora, id_medico, fecha, hora, id_especialidad]
      );
      return res.json({ mensaje: "Horario actualizado correctamente" });
    }

    if (accion === "ocupar") {
      await dbQuery(
        `UPDATE horarios_medicos 
           SET horario_estado=1
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [id_medico, fecha, hora, id_especialidad]
      );
      return res.json({ mensaje: "Horario marcado como ocupado" });
    }

    if (accion === "liberar") {
      await dbQuery(
        `UPDATE horarios_medicos 
           SET horario_estado=0
         WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`,
        [id_medico, fecha, hora, id_especialidad]
      );
      return res.json({ mensaje: "Horario liberado" });
    }

    res.status(400).json({ mensaje: "Acción no reconocida" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ mensaje: "Error al editar horario" });
  }
});

/* -------- Citas -------- */
app.post("/cita/agregar", async (req, res) => {
  try {
    const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
    const fecha = normalizeFechaParam(cita_fecha);
    console.log(`[${req.rid}] /cita/agregar payload`, { id_usuario, id_medico, fecha, cita_hora });

    const rCnt = await dbQuery("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario]);
    const numero_orden = (rCnt[0]?.total || 0) + 1;

    await dbQuery(
      "INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado) VALUES (?,?,?,?,?,1)",
      [id_usuario, id_medico, fecha, cita_hora, numero_orden]
    );

    // ocupar horario
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [fecha, cita_hora, id_medico]
    );

    // correo
    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) {
      await correoConfirmacion(req.rid, rMail[0].usuario_correo, fecha, cita_hora);
    }

    res.json({ mensaje: "Cita registrada correctamente", numero_orden });
  } catch (e) {
    console.error("Error insertando cita:", e);
    res.status(500).json({ error: "Error al registrar la cita" });
  }
});

app.put("/cita/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }
  const fecha = normalizeFechaParam(cita_fecha);

  try {
    // horario anterior
    const ant = await dbQuery("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?", [id]);
    if (!ant.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [ant[0].cita_fecha, ant[0].cita_hora, id_medico]
    );

    await dbQuery(
      `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=?
       WHERE id_cita=?`,
      [id_usuario, id_medico, fecha, cita_hora, cita_estado ?? 1, id]
    );

    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [fecha, cita_hora, id_medico]
    );

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) {
      await correoActualizacion(req.rid, rMail[0].usuario_correo, fecha, cita_hora);
    }

    res.json({ mensaje: "Cita actualizada correctamente" });
  } catch (e) {
    console.error("Error al actualizar la cita:", e);
    res.status(500).json({ mensaje: "Error al actualizar la cita" });
  }
});

app.put("/cita/anular/:id_usuario/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const rows = await dbQuery(
      `SELECT id_cita, cita_fecha, cita_hora, id_medico 
         FROM citas 
        WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`,
      [id_usuario, numero_orden]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = rows[0];
    await dbQuery("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita]);
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [cita_fecha, cita_hora, id_medico]
    );

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) {
      await correoCancelacion(req.rid, rMail[0].usuario_correo, toYYYYMMDD(cita_fecha), cita_hora);
    }

    res.json({ mensaje: "Cita cancelada exitosamente" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

app.get("/citas/:usuario", async (req, res) => {
  const { usuario } = req.params;
  try {
    const rows = await dbQuery(
      `SELECT c.id_cita, c.id_usuario, c.id_medico,
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
        ORDER BY c.id_cita ASC`,
      [usuario]
    );
    const citasNumeradas = rows.map((c, idx) => ({ ...c, numero_orden: idx + 1 }));
    res.json({ listaCitas: citasNumeradas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener las citas" });
  }
});

app.get("/citas/medico/:id_medico", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const rows = await dbQuery(
      `SELECT c.id_cita, c.id_usuario,
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
        ORDER BY c.id_cita ASC`,
      [id_medico]
    );
    const listaCitas = rows.map((c, idx) => ({ ...c, numero_orden: idx + 1 }));
    res.json({ listaCitas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener citas del médico" });
  }
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const rows = await dbQuery(
      `SELECT 
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
      WHERE cit.id_usuario=? AND cit.numero_orden=?`,
      [id_usuario, numero_orden]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.get("/citamedica/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  try {
    const rows = await dbQuery(
      `SELECT cit.id_cita AS IdCita,
              CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
              esp.especialidad_nombre AS Especialidad,
              CONCAT(med.usuario_nombre,' ',med.usuario_apellido) AS Medico,
              cit.cita_fecha AS FechaCita,
              cit.cita_hora AS HoraCita
         FROM citas cit
         JOIN usuarios us ON us.id_usuario=cit.id_usuario
         JOIN medicos m ON cit.id_medico=m.id_medico
         JOIN usuarios med ON m.id_medico=med.id_usuario
         JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
        WHERE cit.id_cita=?`,
      [id_cita]
    );
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.get("/citas/por-dia", async (req, res) => {
  try {
    console.log(`[${req.rid}] GET /citas/por-dia`);
    const rows = await dbQuery(
      `SELECT cita_fecha AS fecha, COUNT(*) AS cantidad
         FROM citas
        WHERE cita_estado=1
        GROUP BY cita_fecha
        ORDER BY cita_fecha ASC`
    );
    const listaCitas = rows.map(r => ({
      fecha: toYYYYMMDD(r.fecha),
      cantidad: r.cantidad,
    }));
    res.json({ listaCitas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.put("/cita/estado/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body || {};
  try {
    await dbQuery("UPDATE citas SET cita_estado=? WHERE id_cita=?", [nuevo_estado, id_cita]);
    res.json({ mensaje: "Estado actualizado correctamente" });
  } catch (e) {
    console.error("Error al actualizar estado:", e);
    res.status(500).json({ mensaje: "Error al actualizar estado" });
  }
});

/* =========================================
 *  Start
 * ========================================= */
app.listen(PUERTO, () => {
  console.log("Servidor corriendo en el puerto " + PUERTO);
});
