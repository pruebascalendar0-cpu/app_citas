// index.js - API Clínica Salud Total (Express + MySQL + Gmail API)
// Build: 2025-10-11-3 (fix fechas -1, ordenar rutas, reset-pass, logs)
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const mysql = require("mysql2");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 10000;

app.use(express.json());

// No cache global (evita resultados pegados/intermitentes en clientes)
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

/* ============ Request-ID + Logs ============ */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT", "PATCH"].includes(req.method)) {
    try { console.log(`[${req.rid}] body:`, req.body); } catch {}
  }
  res.on("finish", () => {
    console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`);
  });
  next();
});

/* ============ MySQL ============ */
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
function dbQuery(sql, params = [], rid = "na") {
  console.log(
    `[${rid}] SQL> ${sql.trim().replace(/\s+/g,' ')}${params && params.length ? " params="+JSON.stringify(params) : ""}`
  );
  return new Promise((resolve, reject) => {
    conexion.query(sql, params, (err, rows) => {
      if (err) {
        console.error(`[${rid}] SQL!`, err.code, err.sqlMessage || err.message);
        return reject(err);
      }
      if (Array.isArray(rows)) console.log(`[${rid}] SQL< rows=${rows.length}`);
      else console.log(`[${rid}] SQL<`, rows);
      resolve(rows);
    });
  });
}

/* ============ Gmail API (sin nodemailer) ============ */
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
  return enviarMail({ rid, to, subject: "Confirmación de tu cita médica",
    html: wrap(`<h2>Cita confirmada</h2><p>Tu cita ha sido registrada.</p><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-confirmada" });
}
async function correoActualizacion(rid, to, fecha, hora) {
  return enviarMail({ rid, to, subject: "Actualización de tu cita médica",
    html: wrap(`<h2>Cita actualizada</h2><p><b>Nueva fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-actualizada" });
}
async function correoCancelacion(rid, to, fecha, hora) {
  return enviarMail({ rid, to, subject: "Cancelación de tu cita médica",
    html: wrap(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-cancelada" });
}
async function correoBienvenida(rid, to, nombre) {
  return enviarMail({ rid, to, subject: "Bienvenido a Clínica Salud Total",
    html: wrap(`<h2>¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
    category: "bienvenida" });
}

/* ============ Helpers de fecha (anti -1 día) ============ */
function toYYYYMMDD(d) {
  const obj = d instanceof Date ? d : new Date(d);
  const y = obj.getUTCFullYear();
  const m = String(obj.getUTCMonth() + 1).padStart(2, "0");
  const day = String(obj.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function normalizeFechaParam(s) {
  if (!s) return s;
  const iso = String(s);
  if (iso.includes("T")) return toYYYYMMDD(iso);
  if (iso.includes("/")) {
    const [y, m, d] = iso.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return iso;
}
function addDays(yyyy_mm_dd, delta) {
  const d = new Date(yyyy_mm_dd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return toYYYYMMDD(d);
}
async function pickHorarioSlotFechaCorrigida(id_medico, fecha, hora, rid="na") {
  const tryDates = [fecha, addDays(fecha, 1), addDays(fecha, -1)];
  for (const f of tryDates) {
    const rows = await dbQuery(
      `SELECT id_horario, id_especialidad, horario_estado
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`,
      [id_medico, f, hora],
      rid
    );
    if (rows.length) {
      console.log(`[${rid}] pickSlot HIT fecha=${f} hora=${hora} id_horario=${rows[0].id_horario} estado=${rows[0].horario_estado}`);
      return {
        id_horario: rows[0].id_horario,
        fecha: f,
        id_especialidad: rows[0].id_especialidad,
        ocupado: rows[0].horario_estado === 1
      };
    }
  }
  console.log(`[${rid}] pickSlot MISS fechaBase=${fecha} hora=${hora}`);
  return null;
}

/* ============ Rutas ============ */
app.get("/", (req, res) => res.send("Bienvenido a mi servicio web"));

/* ----- Usuarios ----- */
app.get("/usuarios", async (req, res) => {
  try {
    const r = await dbQuery("SELECT * FROM usuarios", [], req.rid);
    res.json({ listaUsuarios: r });
  } catch {
    res.status(500).json({ error: "Error al obtener usuarios" });
  }
});

app.post("/usuario/agregar", async (req, res) => {
  const u = req.body || {};
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
      usuario_contrasena_hash: u.usuario_contrasena, // mantén el formato que ya usas
      usuario_tipo: u.usuario_tipo ?? 1
    }, req.rid);
    await correoBienvenida(req.rid, u.usuario_correo, `${u.usuario_nombre} ${u.usuario_apellido}`);
    res.json({ mensaje: "Usuario registrado correctamente." });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      if (String(e.sqlMessage).includes("usuario_dni"))
        return res.status(400).json({ mensaje: "DNI ya está registrado" });
      if (String(e.sqlMessage).includes("usuario_correo"))
        return res.status(400).json({ mensaje: "El correo ya está registrado." });
      return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
    }
    res.status(500).json({ mensaje: "Error al registrar usuario." });
  }
});

// Login (hash salteado existente)
app.post("/usuario/login", async (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) return res.status(400).json({ error: "Datos incompletos" });
  try {
    const r = await dbQuery(
      "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?",
      [usuario_correo], req.rid
    );
    if (!r.length) return res.status(404).json({ mensaje: "No encontrado" });
    const row = r[0];
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
  } catch {
    res.status(500).json({ error: "Error interno" });
  }
});

// EDITAR USUARIO por ID (nombre/apellido/correo)
app.put("/usuario/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  console.log(`[${req.rid}] PUT /usuario/actualizar/${id} data=`, { usuario_nombre, usuario_apellido, usuario_correo });

  if (!usuario_nombre || !usuario_apellido || !usuario_correo) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  try {
    const dup = await dbQuery(
      "SELECT id_usuario FROM usuarios WHERE usuario_correo=? AND id_usuario<>?",
      [usuario_correo, id], req.rid
    );
    if (dup.length) {
      console.log(`[${req.rid}] correo duplicado en id=${dup[0].id_usuario}`);
      return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });
    }

    const r = await dbQuery(
      "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre.trim(), usuario_apellido.trim(), usuario_correo.trim(), id], req.rid
    );

    console.log(`[${req.rid}] UPDATE usuarios affected=${r.affectedRows || 0}, changed=${r.changedRows || 0}`);
    return res.status(200).json({ mensaje: "Usuario actualizado correctamente" });
  } catch (e) {
    console.error(`[${req.rid}] error actualizar usuario`, e);
    return res.status(500).json({ mensaje: "Error al actualizar usuario" });
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
      usuario_contrasena_hash: usuario_contrasena,
      usuario_tipo
    }, req.rid);
    const id_usuario = r.insertId;

    if (usuario_tipo === 2 && id_especialidad) {
      try {
        await dbQuery("INSERT INTO medicos (id_medico, id_especialidad) VALUES (?,?)", [id_usuario, id_especialidad], req.rid);
        return res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      } catch (e) {
        console.error(`[${req.rid}] error insertar medico`, e);
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
    console.error(`[${req.rid}] error registrar usuario`, e);
    res.status(500).json({ mensaje: "Error al registrar usuario" });
  }
});

app.get("/usuario/:correo", async (req, res) => {
  try {
    const correo = decodeURIComponent(req.params.correo);
    const r = await dbQuery("SELECT * FROM usuarios WHERE usuario_correo=?", [correo], req.rid);
    if (!r.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  } catch {
    res.status(500).json({ error: "Error" });
  }
});

/* ----- Especialidades / Médicos ----- */
app.get("/especialidades", async (req, res) => {
  try {
    const r = await dbQuery("SELECT * FROM especialidades", [], req.rid);
    res.json({ listaEspecialidades: r });
  } catch {
    res.status(500).json({ mensaje: "Error al obtener especialidades" });
  }
});

app.post("/especialidad/agregar", async (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  try {
    await dbQuery("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], req.rid);
    res.status(201).json("Especialidad registrada");
  } catch {
    res.status(500).json({ error: "Error al guardar especialidad" });
  }
});

app.put("/especialidad/actualizar/:id", async (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  try {
    await dbQuery("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id], req.rid);
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  } catch {
    res.status(500).json({ error: "Error al actualizar especialidad" });
  }
});

app.get("/medico/:id_medico/especialidades", async (req, res) => {
  const { id_medico } = req.params;
  try {
    const r = await dbQuery(
      `SELECT e.id_especialidad, e.especialidad_nombre
         FROM medicos m
         INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
        WHERE m.id_medico=?`,
      [id_medico], req.rid
    );
    res.json({ listaEspecialidades: r });
  } catch {
    res.status(500).json({ error: "Error al obtener especialidades" });
  }
});

/* ----- Horarios ----- */
app.get("/horarios/:parametro", async (req, res) => {
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
      [fecha, especialidad], req.rid
    );
    console.log(`[${req.rid}] horarios disponibles=${r.length} para fecha=${fecha}`);
    res.json({ listaHorarios: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", async (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const f = normalizeFechaParam(fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, '0')}:00`);
  try {
    const r = await dbQuery(
      `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
         FROM horarios_medicos
        WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`,
      [id_medico, f, id_especialidad], req.rid
    );
    const ocupadas = r.map(x => x.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    console.log(`[${req.rid}] horas ocupadas=${ocupadas.length} disponibles=${disponibles.length}`);
    res.json({ horariosDisponibles: disponibles });
  } catch {
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
      [id_medico, f, id_especialidad], req.rid
    );
    res.json({ horarios: r.map(x => x.hora) });
  } catch {
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
      [id_medico, horario_horas, normalizeFechaParam(horario_fecha), 0, id_especialidad], req.rid
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
        [id_medico, fecha, hora], req.rid
      );
      id_especialidad = row?.[0]?.id_especialidad ?? null;
    }

    if (accion === "eliminar") {
      const sql = id_especialidad
        ? `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`
        : `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      const params = id_especialidad ? [id_medico, fecha, hora, id_especialidad] : [id_medico, fecha, hora];
      const r = await dbQuery(sql, params, req.rid);
      return res.json({ mensaje: "Horario eliminado correctamente", afectadas: r.affectedRows || 0 });
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
      const r = await dbQuery(sql, params, req.rid);
      return res.json({ mensaje: "Horario actualizado correctamente", afectadas: r.affectedRows || 0 });
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
      const r = await dbQuery(sql, params, req.rid);
      return res.json({ mensaje: estado ? "Horario marcado como ocupado" : "Horario liberado", afectadas: r.affectedRows || 0 });
    }

    res.status(400).json({ mensaje: "Acción no reconocida" });
  } catch {
    res.status(500).json({ mensaje: "Error al editar horario" });
  }
});

/* ----- Citas ----- */
// ⚠️ IMPORTANTE: rutas estáticas antes que paramétricas para evitar capturas erróneas
app.get("/citas/por-dia", async (req, res) => {
  try {
    console.log(`[${req.rid}] GET /citas/por-dia`);
    const rows = await dbQuery(
      `SELECT cita_fecha AS fecha, COUNT(*) AS cantidad
         FROM citas
        WHERE cita_estado=1
        GROUP BY cita_fecha
        ORDER BY cita_fecha ASC`,
      [], req.rid
    );
    const listaCitas = rows.map(r => ({ fecha: toYYYYMMDD(r.fecha), cantidad: r.cantidad }));
    const total = listaCitas.reduce((a, b) => a + Number(b.cantidad || 0), 0);
    console.log(`[${req.rid}] /citas/por-dia -> grupos=${listaCitas.length} total=${total} sample=${JSON.stringify(listaCitas.slice(0,3))}`);
    res.json({ listaCitas });
  } catch (e) {
    console.error(`[${req.rid}] /citas/por-dia ERROR`, e);
    res.status(500).json({ error: "Error en la base de datos" });
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
       ORDER BY u.usuario_nombre ASC, numero_cita ASC`,
      [], req.rid
    );
    console.log(`[${req.rid}] /citas (admin) -> total filas=${r.length}`);
    res.json({ listaCitas: r });
  } catch (e) {
    console.error(`[${req.rid}] /citas ERROR`, e);
    res.status(500).json({ error: "Error al obtener las citas" });
  }
});

app.post("/cita/agregar", async (req, res) => {
  try {
    const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
    const fechaReq = normalizeFechaParam(cita_fecha);
    console.log(`[${req.rid}] /cita/agregar payload`, { id_usuario, id_medico, fecha: fechaReq, cita_hora });

    if (!id_usuario || !id_medico || !fechaReq || !cita_hora) {
      return res.status(400).json({ error: "Faltan datos obligatorios" });
    }

    const slot = await pickHorarioSlotFechaCorrigida(id_medico, fechaReq, cita_hora, req.rid);
    const fechaReal = slot?.fecha || fechaReq;
    const id_horario = slot?.id_horario || null;

    const rCnt = await dbQuery("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario], req.rid);
    const numero_orden = (rCnt[0]?.total || 0) + 1;

    await dbQuery(
      "INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado) VALUES (?,?,?,?,?,1)",
      [id_usuario, id_medico, fechaReal, cita_hora, numero_orden], req.rid
    );

    if (id_horario) {
      await dbQuery("UPDATE horarios_medicos SET horario_estado=1 WHERE id_horario=?", [id_horario], req.rid);
    } else {
      await dbQuery(
        "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [fechaReal, cita_hora, id_medico], req.rid
      );
    }

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], req.rid);
    if (rMail.length) await correoConfirmacion(req.rid, rMail[0].usuario_correo, fechaReal, cita_hora);

    res.json({ mensaje: "Cita registrada correctamente", numero_orden, fecha: fechaReal });
  } catch (e) {
    console.error(`[${req.rid}] Error insertando cita:`, e);
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
    const ant = await dbQuery("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?", [id], req.rid);
    if (!ant.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const fechaAnt = toYYYYMMDD(ant[0].cita_fecha);
    const horaAnt = String(ant[0].cita_hora).substring(0,5)+":00".substring(5); // seguro

    const slot = await pickHorarioSlotFechaCorrigida(id_medico, fechaReq, cita_hora, req.rid);
    const fechaReal = slot?.fecha || fechaReq;
    const id_horario = slot?.id_horario || null;

    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [fechaAnt, horaAnt, id_medico], req.rid
    );

    const r = await dbQuery(
      `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=?
       WHERE id_cita=?`,
      [id_usuario, id_medico, fechaReal, cita_hora, cita_estado ?? 1, id], req.rid
    );
    console.log(`[${req.rid}] cita actualizada affected=${r.affectedRows || 0}`);

    if (id_horario) {
      await dbQuery("UPDATE horarios_medicos SET horario_estado=1 WHERE id_horario=?", [id_horario], req.rid);
    } else {
      await dbQuery(
        "UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [fechaReal, cita_hora, id_medico], req.rid
      );
    }

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], req.rid);
    if (rMail.length) await correoActualizacion(req.rid, rMail[0].usuario_correo, fechaReal, cita_hora);

    res.json({ mensaje: "Cita actualizada correctamente", fecha: fechaReal });
  } catch (e) {
    console.error(`[${req.rid}] Error al actualizar la cita:`, e);
    res.status(500).json({ mensaje: "Error al actualizar la cita" });
  }
});

app.put("/cita/anular/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  try {
    const datos = await dbQuery(
      "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?",
      [id_cita], req.rid
    );
    if (!datos.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const fecha = toYYYYMMDD(datos[0].cita_fecha);
    const hora  = String(datos[0].cita_hora).substring(0,5)+":00".substring(5);

    await dbQuery("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], req.rid);
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [fecha, hora, datos[0].id_medico], req.rid
    );

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [datos[0].id_usuario], req.rid);
    if (rMail.length) await correoCancelacion(req.rid, rMail[0].usuario_correo, fecha, hora);

    res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
  } catch {
    res.status(500).json({ error: "Error al cancelar la cita" });
  }
});

app.put("/cita/anular/:id_usuario/:numero_orden", async (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  try {
    const r = await dbQuery(
      `SELECT id_cita, cita_fecha, cita_hora, id_medico 
         FROM citas 
        WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`,
      [id_usuario, numero_orden], req.rid
    );
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const fecha = toYYYYMMDD(r[0].cita_fecha);
    const hora  = String(r[0].cita_hora).substring(0,5)+":00".substring(5);

    await dbQuery("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [r[0].id_cita], req.rid);
    await dbQuery(
      "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
      [fecha, hora, r[0].id_medico], req.rid
    );

    const rMail = await dbQuery("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], req.rid);
    if (rMail.length) await correoCancelacion(req.rid, rMail[0].usuario_correo, fecha, hora);

    res.json({ mensaje: "Cita cancelada exitosamente" });
  } catch {
    res.status(500).json({ error: "Error al cancelar" });
  }
});

// *** RUTA PARAMÉTRICA AL FINAL PARA EVITAR CAPTURAR /citas/por-dia ***
app.get("/citas/:usuario", async (req, res) => {
  const { usuario } = req.params;
  if (!usuario || String(usuario) === "0") {
    console.warn(`[${req.rid}] /citas/:usuario -> usuario=0 (cliente aún sin sesión). Respondo lista vacía.`);
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
      [usuario], req.rid
    );
    const lista = rows.map((c, idx) => ({ ...c, numero_orden: idx + 1 }));
    console.log(`[${req.rid}] /citas/${usuario} -> ${lista.length} citas`);
    res.json({ listaCitas: lista });
  } catch (e) {
    console.error(`[${req.rid}] /citas/${usuario} ERROR`, e);
    res.status(500).json({ error: "Error al obtener las citas" });
  }
});

/* ----- Consultas de una cita (con formato de fecha/hora) ----- */
app.get("/citamedica/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  try {
    const r = await dbQuery(
      `SELECT cit.id_cita AS IdCita,
              CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
              esp.especialidad_nombre AS Especialidad,
              CONCAT(med.usuario_nombre,' ',med.usuario_apellido) AS Medico,
              DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d') AS FechaCita,
              TIME_FORMAT(cit.cita_hora,'%H:%i') AS HoraCita
         FROM citas cit
         INNER JOIN usuarios us ON us.id_usuario=cit.id_usuario
         INNER JOIN medicos m ON cit.id_medico=m.id_medico
         INNER JOIN usuarios med ON m.id_medico=med.id_usuario
         INNER JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
        WHERE cit.id_cita=?`,
      [id_cita], req.rid
    );
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(r[0]);
  } catch {
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
       WHERE cit.id_usuario=? AND cit.numero_orden=?`,
      [id_usuario, numero_orden], req.rid
    );
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(r[0]);
  } catch {
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
      [id_medico], req.rid
    );
    const lista = r.map((cita, index) => ({ ...cita, numero_orden: index + 1 }));
    console.log(`[${req.rid}] /citas/medico/${id_medico} -> ${lista.length} citas`);
    res.json({ listaCitas: lista });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/cita/estado/:id_cita", async (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body || {};
  try {
    const r = await dbQuery("UPDATE citas SET cita_estado=? WHERE id_cita=?", [nuevo_estado, id_cita], req.rid);
    res.json({ mensaje: "Estado actualizado correctamente", afectadas: r.affectedRows || 0 });
  } catch {
    res.status(500).json({ mensaje: "Error al actualizar estado" });
  }
});

/* ----- Reset de contraseña (usa tabla reset_codes) ----- */
// genera código, guarda hash (sha256) y envía por correo
app.post("/usuario/reset/solicitar", async (req, res) => {
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "Correo requerido" });
  try {
    const r = await dbQuery("SELECT id_usuario FROM usuarios WHERE usuario_correo=?", [usuario_correo], req.rid);
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
    const code_hash = crypto.createHash("sha256").update(code).digest("hex");
    const expires_at = new Date(Date.now() + 15 * 60 * 1000); // +15 min

    await dbQuery(
      "INSERT INTO reset_codes (email, code_hash, expires_at, used) VALUES (?,?,?,0)",
      [usuario_correo, code_hash, toYYYYMMDD(expires_at) + " 23:59:59"], // expiración hoy 23:59 UTC-safe
      req.rid
    );

    await enviarMail({
      rid: req.rid,
      to: usuario_correo,
      subject: "Código de recuperación",
      html: wrap(`<h2>Recuperación de contraseña</h2><p>Tu código es:</p><div style="font-size:24px;font-weight:700;letter-spacing:2px">${code}</div><p>Vence en 15 minutos.</p>`),
      category: "reset-pass"
    });

    res.json({ mensaje: "Código enviado al correo" });
  } catch (e) {
    console.error(`[${req.rid}] reset solicitar`, e);
    res.status(500).json({ mensaje: "No se pudo enviar el código" });
  }
});

app.post("/usuario/reset/verificar", async (req, res) => {
  const { usuario_correo, code } = req.body || {};
  if (!usuario_correo || !code) return res.status(400).json({ mensaje: "Datos incompletos" });
  try {
    const code_hash = crypto.createHash("sha256").update(code).digest("hex");
    const r = await dbQuery(
      `SELECT id, used, expires_at 
         FROM reset_codes 
        WHERE email=? AND code_hash=? 
        ORDER BY id DESC LIMIT 1`,
      [usuario_correo, code_hash], req.rid
    );
    if (!r.length) return res.status(400).json({ valido: false, mensaje: "Código inválido" });
    if (r[0].used) return res.status(400).json({ valido: false, mensaje: "Código ya usado" });
    const exp = new Date(r[0].expires_at);
    if (Date.now() > exp.getTime()) return res.status(400).json({ valido: false, mensaje: "Código vencido" });
    res.json({ valido: true, mensaje: "Código válido" });
  } catch (e) {
    console.error(`[${req.rid}] reset verificar`, e);
    res.status(500).json({ mensaje: "Error al verificar" });
  }
});

app.post("/usuario/reset/cambiar", async (req, res) => {
  const { usuario_correo, code, nueva_contrasena } = req.body || {};
  if (!usuario_correo || !code || !nueva_contrasena) return res.status(400).json({ mensaje: "Datos incompletos" });
  if (String(nueva_contrasena).length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  try {
    const code_hash = crypto.createHash("sha256").update(code).digest("hex");
    const r = await dbQuery(
      `SELECT id, used, expires_at 
         FROM reset_codes 
        WHERE email=? AND code_hash=? 
        ORDER BY id DESC LIMIT 1`,
      [usuario_correo, code_hash], req.rid
    );
    if (!r.length) return res.status(400).json({ mensaje: "Código inválido" });
    if (r[0].used) return res.status(400).json({ mensaje: "Código ya usado" });
    const exp = new Date(r[0].expires_at);
    if (Date.now() > exp.getTime()) return res.status(400).json({ mensaje: "Código vencido" });

    // Actualizar password con formato salt:sha256
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHash("sha256").update(salt + String(nueva_contrasena)).digest("hex");
    await dbQuery("UPDATE usuarios SET usuario_contrasena_hash=? WHERE usuario_correo=?", [`${salt}:${hash}`, usuario_correo], req.rid);
    await dbQuery("UPDATE reset_codes SET used=1 WHERE id=?", [r[0].id], req.rid);

    res.json({ mensaje: "Contraseña actualizada" });
  } catch (e) {
    console.error(`[${req.rid}] reset cambiar`, e);
    res.status(500).json({ mensaje: "No se pudo actualizar la contraseña" });
  }
});

/* ============ Start ============ */
app.listen(PUERTO, () => console.log("Servidor corriendo en el puerto " + PUERTO));
