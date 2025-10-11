// index.js - API Clínica Salud Total (Express + MySQL + Gmail API) - 2025-10-11
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
 *  MySQL
 * ========================================= */
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

conexion.connect((error) => {
  if (error) throw error;
  console.log("Conexion exitosa a la base de datos");
});

function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    conexion.query(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

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
 *  Helpers de fecha
 * ========================================= */
function toYYYYMMDD(d) {
  // acepta Date o string
  const obj = d instanceof Date ? d : new Date(d);
  const y = obj.getUTCFullYear();
  const m = String(obj.getUTCMonth() + 1).padStart(2, "0");
  const day = String(obj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function normalizeFechaParam(s) {
  if (!s) return s;
  // si viene ISO con zona: 2025-10-11T00:00:00.000Z -> recorta
  const iso = String(s);
  if (iso.includes("T")) return toYYYYMMDD(iso);
  if (iso.includes("/")) {
    // 2025/10/11 -> 2025-10-11
    const [y, m, d] = iso.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return iso; // ya está YYYY-MM-DD
}
function addDays(yyyy_mm_dd, delta) {
  const d = new Date(yyyy_mm_dd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return toYYYYMMDD(d);
}
async function pickHorarioSlotFechaCorrigida(id_medico, fecha, hora) {
  // busca el slot exacto por (medico,fecha,hora); si no, prueba fecha±1 (corrige desfase cliente)
  const tryDates = [fecha, addDays(fecha, 1), addDays(fecha, -1)];
  for (const f of tryDates) {
    const rows = await dbQuery(
      `SELECT id_horario, id_especialidad, horario_estado
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`,
      [id_medico, f, hora]
    );
    if (rows.length) {
      const row = rows[0];
      return {
        id_horario: row.id_horario,
        fecha: f,
        id_especialidad: row.id_especialidad,
        ocupado: row.horario_estado === 1
      };
    }
  }
  return null;
}

/* =========================================
 *  Rutas
 * ========================================= */
app.get("/", (req, res) => res.send("Bienvenido a mi servicio web"));

/* -------- Usuarios -------- */
app.get("/usuarios", async (req, res) => {
  try {
    const r = await dbQuery("SELECT * FROM usuarios");
    res.json({ listaUsuarios: r });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

app.post("/usuario/agregar", async (req, res) => {
  const u = req.body || {};
  // validaciones mínimas
  if (!u.usuario_dni || !/^\d{8}$/.test(u.usuario_dni))
    return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  if (!u.usuario_nombre || !u.usuario_apellido)
    return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!u.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.usuario_correo))
    return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  if (!u.usuario_contrasena || String(u.usuario_contrasena).length < 6)
    return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  try {
    await dbQuery("INSERT INTO usuarios SET ?", {
      usuario_dni: u.usuario_dni,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_contrasena_hash: u.usuario_contrasena, // si en este flujo no usas hash, está como texto; tu login hash sigue intacto en /usuario/login
      usuario_tipo: u.usuario_tipo ?? 1
    });

    await correoBienvenida(
      req.rid,
      u.usuario_correo,
      `${u.usuario_nombre} ${u.usuario_apellido}`
    );

    res.json({ mensaje: "Usuario registrado correctamente." });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      if (String(e.sqlMessage).includes("usuario_dni"))
        return res.status(400).json({ mensaje: "DNI ya está registrado" });
      if (String(e.sqlMessage).includes("usuario_correo"))
        return res.status(400).json({ mensaje: "El correo ya está registrado." });
      return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
    }
    console.error(e);
    res.status(500).json({ mensaje: "Error al registrar usuario." });
  }
});

// Login HASH actual (no se toca) - asumo que ya lo tienes implementado así:
app.post("/usuario/login", async (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) return res.status(400).json({ error: "Datos incompletos" });

  try {
    const r = await dbQuery(
      "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?",
      [usuario_correo]
    );
    if (!r.length) return res.status(404).json({ mensaje: "No encontrado" });

    const row = r[0];
    // hash salteado formato: <salt>:<sha256>
    const [salt, hash] = String(row.usuario_contrasena_hash || "").split(":");
    const check = crypto.createHash("sha256").update(String(salt || "") + String(password)).digest("hex");
    if (check !== hash) return res.status(401).json({ mensaje: "Contraseña incorrecta" });

    res.json({
      id_usuario: row.id_usuario,
      usuario_nombre: row.usuario_nombre,
      usuario_apellido: row.usuario_apellido,
      usuario_correo: row.usuario_correo,
      usuario_tipo: row.usuario_tipo
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error interno" });
  }
});

app.put("/usuario/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  console.log(`[${req.rid}] PUT /usuario/actualizar/${id}`, { usuario_nombre, usuario_apellido, usuario_correo });

  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  try {
    const dup = await dbQuery(
      "SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario<>?",
      [usuario_correo, id]
    );
    if (dup.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const r = await dbQuery(
      "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre, usuario_apellido, usuario_correo, id]
    );

    console.log(`[${req.rid}] actualizado filas=${r.affectedRows ?? "?"}`);
    res.json({ mensaje: "Usuario actualizado correctamente" });
  } catch (e) {
    console.error(`[${req.rid}] error actualizar`, e);
    res.status(500).json({ mensaje: "Error al actualizar usuario" });
  }
});

app.post("/usuario/registrar", async (req, res) => {
  const {
    usuario_nombre, usuario_apellido, usuario_correo, usuario_dni,
    usuario_contrasena, usuario_tipo, id_especialidad
  } = req.body || {};

  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  try {
    const r = await dbQuery("INSERT INTO usuarios SET ?", {
      usuario_nombre, usuario_apellido, usuario_correo, usuario_dni,
      usuario_contrasena_hash: usuario_contrasena, // ver nota de arriba
      usuario_tipo
    });
    const id_usuario = r.insertId;

    if (usuario_tipo === 2 && id_especialidad) {
      try {
        await dbQuery("INSERT INTO medicos (id_medico, id_especialidad) VALUES (?,?)", [id_usuario, id_especialidad]);
        return res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      } catch (e) {
        console.error("Error al insertar en médicos:", e);
        return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
      }
    }
    res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      if (String(e.sqlMessage).includes("usuario_dni")) {
        return res.status(400).json({ mensaje: "DNI ya está registrado" });
      } else if (String(e.sqlMessage).includes("usuario_correo")) {
        return res.status(400).json({ mensaje: "El correo ya está registrado." });
      }
      return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
    }
    console.error("Error al registrar usuario:", e);
    res.status(500).json({ mensaje: "Error al registrar usuario" });
  }
});

app.get("/usuario/:correo", async (req, res) => {
  try {
    const correo = decodeURIComponent(req.params.correo);
    const r = await dbQuery("SELECT * FROM usuarios WHERE usuario_correo=?", [correo]);
    if (!r.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  } catch (e) {
    res.status(500).json({ error: "Error" });
  }
});

app.post("/usuario/recuperar-correo", async (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  try {
    const r = await dbQuery(
      `SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?`,
      [usuario_dni, usuario_nombre, usuario_apellido]
    );
    if (!r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: r[0].usuario_correo });
  } catch (e) {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.post("/usuario/recuperar-contrasena", async (req, res) => {
  // (flujo legacy – puedes responder OK o enviar correo con instrucciones)
  const { usuario_correo } = req.body || {};
  try {
    const r = await dbQuery("SELECT usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=?", [usuario_correo]);
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    await enviarMail({
      rid: req.rid, to: usuario_correo,
      subject: "Instrucciones para recuperar tu contraseña",
      html: wrap(`<h2>Recuperación</h2><p>Si no solicitaste esto, ignora el mensaje.</p>`),
      category: "reset"
    });
    res.json({ mensaje: "Correo de recuperación enviado" });
  } catch (e) {
    res.status(500).json({ error: "Error interno" });
  }
});

/* -------- Especialidades / Médicos -------- */
app.get("/especialidades", async (req, res) => {
  try {
    const r = await dbQuery("SELECT * FROM especialidades");
    res.json({ listaEspecialidades: r });
  } catch (e) {
    res.status(500).json({ mensaje: "Error al obtener especialidades" });
  }
});

app.post("/especialidad/agregar", async (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    await dbQuery("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre]);
    res.status(201).json("Especialidad registrada");
  } catch (e) {
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
    res.status(500).json({ error: "Error al actualizar especialidad" });
  }
});

app.get("/medico/:id_medico/especialidades", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const r = await dbQuery(
      `SELECT e.id_especialidad, e.especialidad_nombre
         FROM medicos m INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
        WHERE m.id_medico=?`,
      [id_medico]
    );
    res.json({ listaEspecialidades: r });
  } catch (e) {
    res.status(500).json({ error: "Error al obtener especialidades" });
  }
});

/* -------- Horarios -------- */
app.get("/horarios/:parametro", async (req, res) => {
  // usado por agendado del paciente: trae slots con estado=0
  const valores = req.params.parametro.split("&");
  const fecha = normalizeFechaParam(valores[0]);
  const especialidad = valores[1];
  console.log(`[${req.rid}] GET /horarios`, { fecha, id_especialidad: especialidad });
  try {
    const r = await dbQuery(
      `SELECT h.*,
              TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
              u.usuario_nombre AS medico_nombre,
              u.usuario_apellido AS medico_apellido,
              e.especialidad_nombre
         FROM horarios_medicos h
         INNER JOIN medicos m ON h.id_medico=m.id_medico
         INNER JOIN usuarios u ON m.id_medico=u.id_usuario
         INNER JOIN especialidades e ON h.id_especialidad=e.id_especialidad
        WHERE h.horario_fecha=? AND h.id_especialidad=? AND h.horario_estado=0
        ORDER BY h.horario_hora ASC`,
      [fecha, especialidad]
    );
    res.json({ listaHorarios: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// para pantalla de “agregar horario” del médico (lista horas 08-16 que NO ha registrado)
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const f = normalizeFechaParam(fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, '0')}:00`);
  try {
    const r = await dbQuery(
      `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`,
      [id_medico, f, id_especialidad]
    );
    const ocupadas = r.map(x => x.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: disponibles });
  } catch (e) {
    res.status(500).json({ error: "Error al consultar horarios" });
  }
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const f = normalizeFechaParam(fecha);
  try {
    const r = await dbQuery(
      `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
        ORDER BY horario_hora ASC`,
      [id_medico, f, id_especialidad]
    );
    res.json({ horarios: r.map(x => x.hora) });
  } catch (e) {
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

app.post("/horario/registrar", async (req, res) => {
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body || {};
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  try {
    const r = await dbQuery(
      `INSERT INTO horarios_medicos (id_medico,horario_hora,horario_fecha,horario_estado,id_especialidad)
       VALUES (?,?,?,?,?)`,
      [id_medico, horario_horas, normalizeFechaParam(horario_fecha), 0, id_especialidad]
    );
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r.insertId });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
    res.status(500).json({ error: "Error interno al registrar el horario" });
  }
});

app.put("/horario/editar/:id_medico/:fecha/:hora", async (req, res) => {
  const { id_medico, hora } = req.params;
  const fecha = normalizeFechaParam(req.params.fecha);
  let { accion, nuevaHora, id_especialidad } = req.body || {};

  console.log(`[${req.rid}] PUT /horario/editar`, { id_medico, fecha, hora, accion, id_especialidad, nuevaHora });

  if (!accion) return res.status(400).json({ mensaje: "accion requerida" });

  try {
    if (!id_especialidad) {
      const row = await dbQuery(
        `SELECT id_especialidad FROM horarios_medicos 
          WHERE id_medico=? AND horario_fecha=? AND horario_hora=? LIMIT 1`,
        [id_medico, fecha, hora]
      );
      id_especialidad = row?.[0]?.id_especialidad ?? null;
    }

    if (accion === "eliminar") {
      const sql = id_especialidad
        ? `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`
        : `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      const params = id_especialidad ? [id_medico, fecha, hora, id_especialidad] : [id_medico, fecha, hora];
      await dbQuery(sql, params);
      return res.json({ mensaje: "Horario eliminado correctamente" });
    }

    if (accion === "actualizar") {
      if (!nuevaHora) return res.status(400).json({ mensaje: "nuevaHora requerida" });
      const sql = id_especialidad
        ? `UPDATE horarios_medicos SET horario_hora=?, horario_estado=0
             WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`
        : `UPDATE horarios_medicos SET horario_hora=?, horario_estado=0
             WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      const params = id_especialidad
        ? [nuevaHora, id_medico, fecha, hora, id_especialidad]
        : [nuevaHora, id_medico, fecha, hora];
      await dbQuery(sql, params);
      return res.json({ mensaje: "Horario actualizado correctamente" });
    }

    if (accion === "ocupar" || accion === "liberar") {
      const estado = accion === "ocupar" ? 1 : 0;
      const sql = id_especialidad
        ? `UPDATE horarios_medicos SET horario_estado=? 
             WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`
        : `UPDATE horarios_medicos SET horario_estado=? 
             WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      const params = id_especialidad
        ? [estado, id_medico, fecha, hora, id_especialidad]
        : [estado, id_medico, fecha, hora];
      await dbQuery(sql, params);
      return res.json({ mensaje: estado ? "Horario marcado como ocupado" : "Horario liberado" });
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
    const fechaReq = normalizeFechaParam(cita_fecha);

    console.log(`[${req.rid}] /cita/agregar payload`, { id_usuario, id_medico, fecha: fechaReq, cita_hora });

    if (!id_usuario || !id_medico || !fechaReq || !cita_hora) {
      return res.status(400).json({ error: "Faltan datos obligatorios" });
    }

    // Corrige desfase: usa el slot real si existe en fecha/fecha±1
    const slot = await pickHorarioSlotFechaCorrigida(id_medico, fechaReq, cita_hora);
    const fechaReal = slot?.fecha || fechaReq;
    const id_horario = slot?.id_horario || null;

    const rCnt = await dbQuery("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario]);
    const numero_orden = (rCnt[0]?.total || 0) + 1;

    await dbQuery(
      "INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado) VALUES (?,?,?,?,?,1)",
      [id_usuario, id_medico, fechaReal, cita_hora, numero_orden]
    );

    // ocupar horario EXACTO por id_horario si lo encontré; si no, por (fecha, hora, medico)
    if (id_horario) {
      await dbQuery("UPDATE horarios_medicos SET horario_estado=1 WHERE id_horario=?", [id_horario]);
    } else {
      await dbQuery(
        "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [fechaReal, cita_hora, id_medico]
      );
    }

    // correo
    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) {
      await correoConfirmacion(req.rid, rMail[0].usuario_correo, fechaReal, cita_hora);
    }

    res.json({ mensaje: "Cita registrada correctamente", numero_orden, fecha: fechaReal });
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
  const fechaReq = normalizeFechaParam(cita_fecha);

  try {
    const ant = await dbQuery("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?", [id]);
    if (!ant.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const slot = await pickHorarioSlotFechaCorrigida(id_medico, fechaReq, cita_hora);
    const fechaReal = slot?.fecha || fechaReq;
    const id_horario = slot?.id_horario || null;

    // liberar horario anterior
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [ant[0].cita_fecha, ant[0].cita_hora, id_medico]
    );

    // actualizar la cita
    await dbQuery(
      `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=?
       WHERE id_cita=?`,
      [id_usuario, id_medico, fechaReal, cita_hora, cita_estado ?? 1, id]
    );

    // ocupar nuevo horario exacto
    if (id_horario) {
      await dbQuery("UPDATE horarios_medicos SET horario_estado=1 WHERE id_horario=?", [id_horario]);
    } else {
      await dbQuery(
        "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [fechaReal, cita_hora, id_medico]
      );
    }

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) {
      await correoActualizacion(req.rid, rMail[0].usuario_correo, fechaReal, cita_hora);
    }

    res.json({ mensaje: "Cita actualizada correctamente", fecha: fechaReal });
  } catch (e) {
    console.error("Error al actualizar la cita:", e);
    res.status(500).json({ mensaje: "Error al actualizar la cita" });
  }
});

app.put("/cita/anular/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  try {
    const datos = await dbQuery("SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?", [id_cita]);
    if (!datos.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico, id_usuario } = datos[0];
    await dbQuery("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita]);
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [cita_fecha, cita_hora, id_medico]
    );

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) await correoCancelacion(req.rid, rMail[0].usuario_correo, toYYYYMMDD(cita_fecha), cita_hora);

    res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
  } catch (e) {
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

// anular por (usuario, numero_orden)
app.put("/cita/anular/:id_usuario/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const r = await dbQuery(
      `SELECT id_cita, cita_fecha, cita_hora, id_medico 
         FROM citas 
        WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`,
      [id_usuario, numero_orden]
    );
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = r[0];

    await dbQuery("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita]);
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [cita_fecha, cita_hora, id_medico]
    );

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (rMail.length) await correoCancelacion(req.rid, rMail[0].usuario_correo, toYYYYMMDD(cita_fecha), cita_hora);

    res.json({ mensaje: "Cita cancelada exitosamente" });
  } catch (e) {
    res.status(500).json({ error: "Error al cancelar" });
  }
});

app.get("/citas/:usuario", async (req, res) => {
  const { usuario } = req.params;
  if (!usuario || String(usuario) === "0") {
    return res.json({ listaCitas: [] });
  }
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
    const lista = rows.map((c, idx) => ({ ...c, numero_orden: idx + 1 }));
    res.json({ listaCitas: lista });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error al obtener las citas" });
  }
});

app.get("/citas", async (req, res) => {
  try {
    const r = await dbQuery(
      `SELECT 
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
       ORDER BY u.usuario_nombre ASC, numero_cita ASC`
    );
    res.json({ listaCitas: r });
  } catch (e) {
    res.status(500).json({ error: "Error al obtener las citas" });
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
    console.log(`[${req.rid}] /citas/por-dia -> ${listaCitas.length} filas`);
    res.json({ listaCitas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const r = await dbQuery(
      `SELECT 
        cit.id_cita AS IdCita,
        CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
        esp.especialidad_nombre AS Especialidad,
        CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
        cit.cita_fecha AS FechaCita,
        cit.cita_hora AS HoraCita,
        CASE WHEN cit.cita_estado=1 THEN 'Confirmada'
             WHEN cit.cita_estado=0 THEN 'Cancelada'
             ELSE 'Desconocido' END AS EstadoCita
       FROM citas cit
       INNER JOIN usuarios us ON us.id_usuario=cit.id_usuario
       INNER JOIN medicos m ON m.id_medico=cit.id_medico
       INNER JOIN usuarios mu ON m.id_medico=mu.id_usuario
       INNER JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
       WHERE cit.id_usuario=? AND cit.numero_orden=?`,
      [id_usuario, numero_orden]
    );
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(r[0]);
  } catch (e) {
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

app.get("/citas/medico/:id_medico", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const r = await dbQuery(
      `SELECT c.id_cita, c.id_usuario,
              us.usuario_nombre AS paciente_nombre, us.usuario_apellido AS paciente_apellido,
              DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
              TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
              u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
              e.id_especialidad, e.especialidad_nombre,
              c.cita_estado
         FROM citas c
         INNER JOIN usuarios us ON c.id_usuario=us.id_usuario
         INNER JOIN medicos m ON c.id_medico=m.id_medico
         INNER JOIN usuarios u ON m.id_medico=u.id_usuario
         INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
        WHERE c.id_medico=?
        ORDER BY c.id_cita ASC`,
      [id_medico]
    );
    const lista = r.map((cita, index) => ({ ...cita, numero_orden: index + 1 }));
    res.json({ listaCitas: lista });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/cita/estado/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body || {};
  try {
    await dbQuery("UPDATE citas SET cita_estado=? WHERE id_cita=?", [nuevo_estado, id_cita]);
    res.json({ mensaje: "Estado actualizado correctamente" });
  } catch (e) {
    res.status(500).json({ mensaje: "Error al actualizar estado" });
  }
});

app.get("/citamedica/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  try {
    const r = await dbQuery(
      `SELECT cit.id_cita AS IdCita,
              CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
              esp.especialidad_nombre AS Especialidad,
              CONCAT(med.usuario_nombre,' ',med.usuario_apellido) AS Medico,
              cit.cita_fecha AS FechaCita,
              cit.cita_hora AS HoraCita
         FROM citas cit
         INNER JOIN usuarios us ON us.id_usuario=cit.id_usuario
         INNER JOIN medicos m ON cit.id_medico=m.id_medico
         INNER JOIN usuarios med ON m.id_medico=med.id_usuario
         INNER JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
        WHERE cit.id_cita=?`,
      [id_cita]
    );
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(r[0]);
  } catch (e) {
    res.status(500).json({ error: "Error en la base de datos" });
  }
});

/* =========================================
 *  Start
 * ========================================= */
app.listen(PUERTO, () => console.log("Servidor corriendo en el puerto " + PUERTO));
