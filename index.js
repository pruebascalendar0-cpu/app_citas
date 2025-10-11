// ====================== BOOTSTRAP DEL SERVIDOR ======================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Request logger
app.use((req, res, next) => {
  const t0 = Date.now();
  console.log(`➡️  [REQ] ${req.method} ${req.originalUrl} | query=${JSON.stringify(req.query)} | body=${JSON.stringify(req.body)}`);
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`⬅️  [RES] ${req.method} ${req.originalUrl} | status=${res.statusCode} | ${ms}ms`);
  });
  // No-cache para evitar listas viejas
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

// ====================== GMAIL API ======================
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

async function enviarCorreo(destinatario, fecha, hora) {
  return gmailSend({
    to: destinatario,
    subject: "Confirmación de tu cita médica",
    html: `
      <h2 style="color: #2e86de;">¡Cita médica confirmada!</h2>
      <p>Tu cita ha sido registrada con éxito.</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <hr/><footer style="font-size: 0.9em; color: #888"><strong>Clínica Salud Total</strong></footer>`
  });
}

async function enviarCorreoBienvenida(destinatario, nombre) {
  return gmailSend({
    to: destinatario,
    subject: "Bienvenido a Clínica Salud Total",
    html: `<h2 style="color: #2e86de;">¡Bienvenido, ${nombre}!</h2>`
  });
}

async function enviarCorreoRecuperacion(destinatario, nombre, contrasena) {
  return gmailSend({
    to: destinatario,
    subject: "Recuperación de contraseña - Clínica Salud Total",
    html: `<h2 style="color: #e74c3c;">Recuperación de contraseña</h2><p>Hola ${nombre}. Tu contraseña es: <strong>${contrasena}</strong></p>`
  });
}

async function enviarCorreoActualizacion(destinatario, fecha, hora) {
  return gmailSend({
    to: destinatario,
    subject: "Actualización de tu cita médica",
    html: `<h2 style="color: #f39c12;">¡Cita actualizada!</h2><p>${fecha} ${hora}</p>`
  });
}

async function enviarCorreoCancelacion(destinatario, fecha, hora) {
  return gmailSend({
    to: destinatario,
    subject: "Cancelación de tu cita médica",
    html: `<h2 style="color: #c0392b;">Cita cancelada</h2><p>${fecha} ${hora}</p>`
  });
}

(async () => {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    console.log("📧 Gmail API OK. Enviando como:", profile.data.emailAddress);
  } catch (e) {
    console.error("❌ Gmail API no está listo:", e?.response?.data || e.message);
  }
})();

// ============================ ENDPOINTS ============================
//
// ⚠️ Orden importante: primero rutas específicas, luego las que tienen :params
//

/* ---------- ESPECIALIDADES ---------- */
app.get("/especialidades", (req, res) => {
  console.log("[/especialidades] Listando…");
  const sql = "SELECT * FROM especialidades";
  conexion.query(sql, (error, rpta) => {
    if (error) {
      console.error("[/especialidades] Error:", error.message);
      return res.status(500).json({ error: "Error listando especialidades" });
    }
    res.json({ listaEspecialidades: rpta || [] });
  });
});

/* ---------- RESÚMENES / ADMIN ---------- */
// Total de citas confirmadas
app.get("/citas/total", (req, res) => {
  console.log("[/citas/total]");
  const sql = "SELECT COUNT(*) AS total FROM citas WHERE cita_estado = 1";
  conexion.query(sql, (err, rows) => {
    if (err) {
      console.error("[/citas/total] Error:", err.message);
      return res.status(500).json({ error: "Error obteniendo total" });
    }
    res.json({ total: rows[0]?.total || 0 });
  });
});

// Citas por día (para gráfica)
app.get("/citas/por-dia", (req, res) => {
  console.log("[/citas/por-dia]");
  const sql = `
    SELECT DATE(cita_fecha) AS fecha, COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY DATE(cita_fecha)
    ORDER BY DATE(cita_fecha) ASC
  `;
  conexion.query(sql, (error, resultados) => {
    if (error) {
      console.error("[/citas/por-dia] Error:", error.message);
      return res.status(500).json({ error: "Error en la base de datos" });
    }
    const datos = (resultados || []).map(r => ({
      fecha: (r.fecha instanceof Date) ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10),
      cantidad: r.cantidad
    }));
    console.log("[/citas/por-dia] Datos:", datos);
    res.json({ listaCitas: datos });
  });
});

// Buscar citas (q en nombre/apellido paciente/medico, especialidad o fecha YYYY-MM-DD)
app.get("/citas/buscar", (req, res) => {
  const { q = "" } = req.query;
  console.log("[/citas/buscar] q=", q);
  const like = `%${q}%`;
  const sql = `
    SELECT 
      c.id_cita,
      DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
      TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
      u.usuario_nombre AS paciente_nombre, u.usuario_apellido AS paciente_apellido,
      mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido,
      e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN usuarios u ON c.id_usuario = u.id_usuario
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE u.usuario_nombre LIKE ? OR u.usuario_apellido LIKE ?
       OR mu.usuario_nombre LIKE ? OR mu.usuario_apellido LIKE ?
       OR e.especialidad_nombre LIKE ?
       OR DATE_FORMAT(c.cita_fecha, '%Y-%m-%d') LIKE ?
    ORDER BY c.cita_fecha DESC, c.cita_hora DESC
    LIMIT 200
  `;
  const params = [like, like, like, like, like, like];
  conexion.query(sql, params, (err, rows) => {
    if (err) {
      console.error("[/citas/buscar] Error:", err.message);
      return res.status(500).json({ error: "Error buscando citas" });
    }
    res.json({ resultados: rows || [] });
  });
});

/* ---------- USUARIOS ---------- */
app.get("/usuarios", (req, res) => {
  console.log("[/usuarios] Listando usuarios…");
  const sql = "SELECT * FROM usuarios";
  conexion.query(sql, (error, rpta) => {
    if (error) {
      console.error("[/usuarios] Error:", error.message);
      return res.status(500).json({ error: "Error listando usuarios" });
    }
    res.json({ listaUsuarios: rpta || [] });
  });
});

app.post("/usuario/agregar", (req, res) => {
  console.log("[/usuario/agregar] Body:", req.body);
  const u = req.body;
  if (!u.usuario_dni || !/^\d{8}$/.test(u.usuario_dni)) return res.status(400).json({ mensaje: "DNI 8 dígitos" });
  if (!u.usuario_nombre || !u.usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios" });
  if (!u.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.usuario_correo)) return res.status(400).json({ mensaje: "Correo no válido" });
  if (!u.usuario_contrasena || u.usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "Contraseña mínimo 6" });

  const sql = "INSERT INTO usuarios SET ?";
  conexion.query(sql, u, async (error) => {
    if (error) {
      console.error("[/usuario/agregar] Error:", error.code, error.sqlMessage);
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya está registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }
    try { await enviarCorreoBienvenida(u.usuario_correo, `${u.usuario_nombre} ${u.usuario_apellido}`); } catch {}
    res.status(200).json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.put("/usuario/actualizar/:id", (req, res) => {
  console.log("[/usuario/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body;
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const verificar = "SELECT 1 FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  conexion.query(verificar, [usuario_correo, id], (err, r) => {
    if (err) {
      console.error("[/usuario/actualizar] Verificar error:", err.message);
      return res.status(500).json({ mensaje: "Error al verificar correo" });
    }
    if (r.length > 0) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const upd = "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?";
    conexion.query(upd, [usuario_nombre, usuario_apellido, usuario_correo, id], (e2) => {
      if (e2) {
        console.error("[/usuario/actualizar] Update error:", e2.message);
        return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      }
      res.status(200).json({ mensaje: "Usuario actualizado correctamente" });
    });
  });
});

app.post("/usuario/recuperar-correo", (req, res) => {
  console.log("[/usuario/recuperar-correo] Body:", req.body);
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  const sql = `SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?`;
  conexion.query(sql, [usuario_dni, usuario_nombre, usuario_apellido], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    if (rows.length === 0) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: rows[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  console.log("[/usuario/recuperar-contrasena] Body:", req.body);
  const { usuario_correo } = req.body;
  const sql = "SELECT usuario_nombre, usuario_apellido, usuario_contrasena FROM usuarios WHERE usuario_correo = ?";
  conexion.query(sql, [usuario_correo], async (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    if (rows.length === 0) return res.status(404).json({ mensaje: "Correo no registrado" });
    const u = rows[0];
    try { await enviarCorreoRecuperacion(usuario_correo, `${u.usuario_nombre} ${u.usuario_apellido}`, u.usuario_contrasena); } catch {}
    res.json({ mensaje: "Correo de recuperación enviado" });
  });
});

app.post("/usuario/registrar", (req, res) => {
  console.log("[/usuario/registrar] Body:", req.body);
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad } = req.body;
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const nuevo = { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo };
  const ins = "INSERT INTO usuarios SET ?";
  conexion.query(ins, nuevo, (err, r) => {
    if (err) {
      console.error("[/usuario/registrar] Error:", err.code, err.sqlMessage);
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (err.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    const id_usuario = r.insertId;
    if (usuario_tipo === 2 && id_especialidad) {
      const insMed = "INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)";
      conexion.query(insMed, [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(200).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
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
  const sql = "SELECT * FROM usuarios WHERE usuario_correo = ?";
  conexion.query(sql, [correo], (err, rows) => {
    if (err) return res.status(500).send(err.message);
    if (rows.length > 0) res.json(rows[0]);
    else res.status(404).send({ mensaje: "no hay registros" });
  });
});

/* ---------- HORARIOS / MÉDICOS ---------- */
app.get("/horarios/:parametro", (req, res) => {
  console.log("[/horarios/:parametro] parametro:", req.params.parametro);
  const [fecha, especialidad] = req.params.parametro.split("&");
  const sql = `
    SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
    WHERE h.horario_fecha = ? AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC
  `;
  conexion.query(sql, [fecha, especialidad], (err, rpta) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ listaHorarios: rpta });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  console.log("[/horario/actualizar/:id_horario] Params:", req.params, "Body:", req.body);
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;
  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos" });

  const qPrev = `SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario = ?`;
  conexion.query(qPrev, [id_horario], (e1, r1) => {
    if (e1 || r1.length === 0) return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    const prev = r1[0];

    const liberar = `UPDATE horarios_medicos SET horario_estado = 0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?`;
    conexion.query(liberar, [prev.horario_fecha, prev.horario_hora, id_medico], () => {});

    const upd = `UPDATE horarios_medicos SET horario_fecha=?, horario_hora=?, horario_estado=1, id_especialidad=? WHERE id_horario=?`;
    conexion.query(upd, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (e3) => {
      if (e3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      res.json({ mensaje: "Horario actualizado correctamente" });
    });
  });
});

app.post("/horario/registrar", (req, res) => {
  console.log("[/horario/registrar] Body:", req.body);
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) return res.status(400).json({ error: "Faltan datos obligatorios" });

  const sql = `
    INSERT INTO horarios_medicos (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, 0, ?)
  `;
  conexion.query(sql, [id_medico, horario_horas, horario_fecha, id_especialidad], (err, r) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r.insertId });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  console.log("[/medico/:id_medico/especialidades] Params:", req.params);
  const { id_medico } = req.params;
  const sql = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?
  `;
  conexion.query(sql, [id_medico], (err, r) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  console.log("[/horarios/disponibles] Params:", req.params);
  const { id_medico } = req.params;
  const fecha = String(req.params.fecha).split("T")[0]; // acepta ISO o YYYY-MM-DD
  const { id_especialidad } = req.params;

  const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
  const sql = `SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, r) => {
    if (err) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map(x => x.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: disponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  console.log("[/horarios/registrados] Params:", req.params);
  const { id_medico } = req.params;
  const fecha = String(req.params.fecha).split("T")[0];
  const { id_especialidad } = req.params;

  const sql = `
    SELECT horario_hora 
    FROM horarios_medicos 
    WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC
  `;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    res.json({ horarios: rows.map(r => r.horario_hora) });
  });
});

/* ---------- CITAS ---------- */
// Todas las citas (admin)
app.get("/citas", (req, res) => {
  console.log("[/citas] Listando todas…");
  const sql = `
    SELECT 
      ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.id_cita) AS numero_cita,
      c.id_cita,
      u.usuario_nombre AS paciente_nombre, u.usuario_apellido AS paciente_apellido,
      DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
      TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
      e.especialidad_nombre,
      mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido,
      c.cita_estado
    FROM citas c
    INNER JOIN usuarios u ON c.id_usuario = u.id_usuario
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    ORDER BY c.cita_fecha DESC, c.cita_hora DESC
  `;
  conexion.query(sql, (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error al obtener las citas" });
    res.json({ listaCitas: rpta || [] });
  });
});

// Citas del usuario
app.get("/citas/:usuario", (req, res) => {
  console.log("[/citas/:usuario] Params:", req.params);
  const { usuario } = req.params;
  if (!/^\d+$/.test(String(usuario))) return res.status(400).json({ error: "id_usuario inválido" });

  const sql = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_usuario = ?
    ORDER BY c.id_cita ASC
  `;
  conexion.query(sql, [usuario], (error, rows) => {
    if (error) return res.status(500).json({ error: "Error listando citas del usuario" });
    const lista = (rows || []).map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas: lista });
  });
});

// Buscar por "número de orden" (derivado con ROW_NUMBER → robusto)
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  console.log("[/cita/usuario/:id/orden/:n] Params:", req.params);

  const sql = `
    WITH cte AS (
      SELECT 
        cit.*, 
        ROW_NUMBER() OVER (PARTITION BY cit.id_usuario ORDER BY cit.id_cita) AS rn
      FROM citas cit
      WHERE cit.id_usuario = ?
    )
    SELECT 
      cte.id_cita AS IdCita,
      CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
      cte.cita_fecha AS FechaCita,
      cte.cita_hora AS HoraCita,
      CASE WHEN cte.cita_estado = 1 THEN 'Confirmada'
           WHEN cte.cita_estado = 0 THEN 'Cancelada'
           ELSE 'Desconocido' END AS EstadoCita
    FROM cte
    INNER JOIN usuarios us ON us.id_usuario = cte.id_usuario
    INNER JOIN medicos m ON m.id_medico = cte.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cte.rn = ?
  `;
  conexion.query(sql, [id_usuario, Number(numero_orden)], (err, rows) => {
    if (err) {
      console.error("[/cita/usuario/:id/orden/:n] Error:", err.message);
      return res.status(500).json({ error: "Error en la base de datos" });
    }
    if (rows.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  });
});

// Crear cita
app.post("/cita/agregar", (req, res) => {
  console.log("[/cita/agregar] Body:", req.body);
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;

  const sqlCount = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(sqlCount, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });

    const numero_orden = r1[0].total + 1;
    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };

    const ins = "INSERT INTO citas SET ?";
    conexion.query(ins, cita, (e2, r2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const ocupar = `UPDATE horarios_medicos SET horario_estado = 1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?`;
      conexion.query(ocupar, [cita_fecha, cita_hora, id_medico], () => {});

      const qCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
      conexion.query(qCorreo, [id_usuario], async (e3, r3) => {
        if (!e3 && r3.length > 0) {
          try { await enviarCorreo(r3[0].usuario_correo, cita_fecha, cita_hora); } catch {}
        }
        res.json({ mensaje: "Cita registrada correctamente", id_cita: r2.insertId, numero_orden, cita: { id_usuario, id_medico, cita_fecha, cita_hora } });
      });
    });
  });
});

// Actualizar cita
app.put("/cita/actualizar/:id", (req, res) => {
  console.log("[/cita/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos" });

  const qCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
  conexion.query(qCorreo, [id_usuario], (e0, r0) => {
    if (e0 || r0.length === 0) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const correo = r0[0].usuario_correo;

    const qPrev = `SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?`;
    conexion.query(qPrev, [id], (e1, r1) => {
      if (e1) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const prev = r1[0];

      const liberar = `UPDATE horarios_medicos SET horario_estado = 0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?`;
      conexion.query(liberar, [prev.cita_fecha, prev.cita_hora, id_medico], () => {});

      const upd = `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=? WHERE id_cita=?`;
      conexion.query(upd, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], async (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const ocupar = `UPDATE horarios_medicos SET horario_estado = 1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?`;
        conexion.query(ocupar, [cita_fecha, cita_hora, id_medico], () => {});

        try { await enviarCorreoActualizacion(correo, cita_fecha, cita_hora); } catch {}
        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

// Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  console.log("[/cita/anular/:id_cita] Params:", req.params);
  const { id_cita } = req.params;

  const q = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita = ?";
  conexion.query(q, [id_cita], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al obtener datos de la cita" });
    if (r1.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];
    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const liberar = `UPDATE horarios_medicos SET horario_estado = 0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?`;
      conexion.query(liberar, [cita_fecha, cita_hora, id_medico], async (e3) => {
        if (e3) return res.status(500).json({ error: "Error al liberar el horario" });

        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], async (e4, r4) => {
          if (!e4 && r4.length > 0) { try { await enviarCorreoCancelacion(r4[0].usuario_correo, cita_fecha, cita_hora); } catch {} }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

// Anular por (usuario, numero orden) — mantiene compatibilidad
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  console.log("[/cita/anular/:id_usuario/:numero_orden] Params:", req.params);
  const { id_usuario, numero_orden } = req.params;

  // buscamos con ROW_NUMBER para no depender de columna
  const sqlFind = `
    WITH cte AS (
      SELECT id_cita, cita_fecha, cita_hora, id_medico,
             ROW_NUMBER() OVER (PARTITION BY id_usuario ORDER BY id_cita) AS rn
      FROM citas
      WHERE id_usuario = ? AND cita_estado = 1
    )
    SELECT * FROM cte WHERE rn = ?
  `;
  conexion.query(sqlFind, [id_usuario, Number(numero_orden)], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al buscar la cita" });
    if (r1.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const liberar = `UPDATE horarios_medicos SET horario_estado = 0 WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?`;
      conexion.query(liberar, [cita_fecha, cita_hora, id_medico], (e3) => {
        if (e3) return res.status(500).json({ error: "Error al liberar el horario" });
        res.json({ mensaje: "Cita cancelada exitosamente" });
      });
    });
  });
});

/* ---------- ESPECIALIDADES (ADMIN) ---------- */
app.get("/medicos", (req, res) => {
  console.log("[/medicos] Listando…");
  const sql = "SELECT * FROM medicos";
  conexion.query(sql, (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error listando medicos" });
    res.json({ listaCitas: rpta || [] });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  console.log("[/especialidad/agregar] Body:", req.body);
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });

  const sql = "INSERT INTO especialidades (especialidad_nombre) VALUES (?)";
  conexion.query(sql, [especialidad_nombre], (err, r) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  console.log("[/especialidad/actualizar/:id] Params:", req.params, "Body:", req.body);
  const { id } = req.params;
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });

  const sql = "UPDATE especialidades SET especialidad_nombre = ? WHERE id_especialidad = ?";
  conexion.query(sql, [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

// ============================ LISTEN ============================
app.listen(PORT, () => {
  console.log("🚀 Servidor corriendo en el puerto " + PORT);
});
