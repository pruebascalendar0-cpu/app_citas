require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const logReq = (req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT", "PATCH"].includes(req.method)) try { console.log(`[${req.rid}] body:`, req.body); } catch {}
  res.on("finish", () => console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`));
  next();
};
app.use(logReq);

function toYYYYMMDD(v) {
  if (!v) return v;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const z = s.includes("T") ? s.slice(0, 10) : s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(z)) return z;
  const d = new Date(s);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  return `${salt}:${h}`;
}
function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, h] = stored.split(":");
  const t = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  return t.toLowerCase() === String(h || "").toLowerCase();
}
function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function toPlain(html) {
  return String(html || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function sanitizeHeader(s) {
  return String(s || "").replace(/\r|\n/g, " ").replace(/\s+/g, " ").trim();
}
const FROM = process.env.EMAIL_FROM || `Clinica Salud Total <${process.env.EMAIL_USER || ""}>`;
const REPLY_TO = process.env.REPLY_TO || process.env.EMAIL_USER || "";

async function sendViaGmailAPI({ to, subject, html, text, headers = {} }) {
  const oauth2 = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REDIRECT_URI);
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const { token } = await oauth2.getAccessToken();
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  const subjEnc = `=?UTF-8?B?${Buffer.from(sanitizeHeader(subject), "utf8").toString("base64")}?=`;
  const lines = [
    `From: ${FROM}`,
    `To: ${to}`,
    `Reply-To: ${REPLY_TO}`,
    `Subject: ${subjEnc}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ``,
    html || toPlain(text || ""),
  ];
  const raw = b64url(lines.join("\r\n"));
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return r?.data?.id;
}
async function sendViaSMTP({ to, subject, html, text, headers = {} }) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: process.env.EMAIL_PASSWORD
      ? { user: process.env.EMAIL_USER, pass: (process.env.EMAIL_PASSWORD || "").replace(/\s+/g, "") }
      : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 30000,
    socketTimeout: 45000,
    family: 4,
  });
  const info = await transporter.sendMail({
    from: FROM,
    to,
    subject: sanitizeHeader(subject),
    html,
    text: text || toPlain(html),
    replyTo: REPLY_TO,
    headers,
  });
  return info.messageId;
}
async function enviarMail({ to, subject, html, text, category }) {
  const headers = { "X-Category": category || "notificaciones", "X-Entity-Ref-ID": crypto.randomUUID() };
  if (process.env.UNSUB_MAILTO || process.env.UNSUB_URL) {
    const arr = [];
    if (process.env.UNSUB_MAILTO) arr.push(`<mailto:${process.env.UNSUB_MAILTO}>`);
    if (process.env.UNSUB_URL) arr.push(`<${process.env.UNSUB_URL}>`);
    headers["List-Unsubscribe"] = arr.join(", ");
  }
  if (String(process.env.MAIL_STRATEGY || "").toUpperCase() === "GMAIL_API") return await sendViaGmailAPI({ to, subject, html, text, headers });
  return await sendViaSMTP({ to, subject, html, text, headers });
}
const wrap = (inner) =>
  `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">${inner}<hr style="border:none;border-top:1px solid #eee;margin:16px 0" /><div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div></div>`;

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
db.connect((err) => {
  if (err) throw err;
  console.log("✅ Conexión MySQL OK");
  db.query("SET time_zone='-05:00'");
});

app.get("/", (_, res) => res.send("API Clínica Salud Total"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/usuario/login", (req, res) => {
  const correo = String(req.body?.usuario_correo || req.body?.email || "").trim();
  const pass = String(req.body?.password || "");
  const q = "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_tipo,usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?";
  db.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    if (!verifyPassword(pass, r[0].usuario_contrasena_hash)) return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    const u = r[0];
    res.json({ id_usuario: u.id_usuario, usuario_nombre: u.usuario_nombre, usuario_apellido: u.usuario_apellido, usuario_correo: u.usuario_correo, usuario_tipo: u.usuario_tipo });
  });
});

app.get("/usuario/:correo", (req, res) => {
  const c = String(req.params.correo || "").trim().toLowerCase();
  const q = "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios WHERE LOWER(usuario_correo)=?";
  db.query(q, [c], (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    if (!r.length) return res.status(404).json({ error: "No encontrado" });
    res.json(r[0]);
  });
});

app.post("/usuario/agregar", (req, res) => {
  const b = req.body || {};
  if (!/^\d{8}$/.test(String(b.usuario_dni || ""))) return res.status(400).json({ mensaje: "DNI inválido" });
  if (!b.usuario_nombre || !b.usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido requeridos" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.usuario_correo || ""))) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!b.usuario_contrasena || String(b.usuario_contrasena).length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6 caracteres" });
  const row = {
    usuario_dni: b.usuario_dni,
    usuario_nombre: b.usuario_nombre,
    usuario_apellido: b.usuario_apellido,
    usuario_correo: b.usuario_correo,
    usuario_contrasena_hash: hashPassword(b.usuario_contrasena),
    usuario_tipo: Number(b.usuario_tipo ?? 1),
  };
  db.query("INSERT INTO usuarios SET ?", row, (e, r) => {
    if (e) {
      if (e.code === "ER_DUP_ENTRY") {
        if (e.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (e.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar" });
    }
    enviarMail({
      to: b.usuario_correo,
      subject: "Bienvenido a Clínica Salud Total",
      html: wrap(`<h2 style="margin:0 0 8px 0;">¡Bienvenido, ${b.usuario_nombre} ${b.usuario_apellido}!</h2><p>Tu registro fue exitoso.</p>`),
      category: "bienvenida",
    }).catch(() => {});
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.post("/usuario/registrar", (req, res) => {
  const b = req.body || {};
  const row = {
    usuario_dni: String(b.usuario_dni || ""),
    usuario_nombre: String(b.usuario_nombre || ""),
    usuario_apellido: String(b.usuario_apellido || ""),
    usuario_correo: String(b.usuario_correo || ""),
    usuario_contrasena_hash: hashPassword(b.usuario_contrasena || "123456"),
    usuario_tipo: Number(b.usuario_tipo ?? 1),
  };
  if (!/^\d{8}$/.test(row.usuario_dni)) return res.status(400).json({ mensaje: "DNI inválido" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.usuario_correo)) return res.status(400).json({ mensaje: "Correo inválido" });
  db.query("INSERT INTO usuarios SET ?", row, (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al registrar" });
    const id_usuario = r.insertId;
    const id_especialidad = Number(b.id_especialidad || b.especialidad || 0);
    if (row.usuario_tipo === 2 && id_especialidad) {
      db.query("INSERT INTO medicos(id_medico,id_especialidad) VALUES(?,?)", [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al vincular especialidad" });
        res.json({ ok: true, id_usuario });
      });
    } else {
      res.json({ ok: true, id_usuario });
    }
  });
});

app.put("/usuario/actualizar/:id", (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const up = {
    usuario_dni: b.usuario_dni,
    usuario_nombre: b.usuario_nombre,
    usuario_apellido: b.usuario_apellido,
    usuario_correo: b.usuario_correo,
    usuario_tipo: b.usuario_tipo,
  };
  db.query("UPDATE usuarios SET ? WHERE id_usuario=?", [up, id], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al actualizar" });
    res.json({ mensaje: "Actualizado" });
  });
});

app.get("/usuarios", (_, res) => {
  const sql = "SELECT id_usuario, usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo FROM usuarios ORDER BY id_usuario ASC";
  db.query(sql, (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    res.json({ listaUsuarios: r });
  });
});

app.post("/usuario/reset/solicitar", (req, res) => {
  const correo = String(req.body?.email || req.body?.usuario_correo || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  const qUser = "SELECT id_usuario,usuario_nombre,usuario_apellido FROM usuarios WHERE LOWER(usuario_correo)=?";
  db.query(qUser, [correo], (e1, r1) => {
    if (e1) return res.status(500).json({ ok: false, mensaje: "Error en base de datos" });
    if (!r1.length) return res.json({ ok: true, mensaje: "Si el correo existe, se envió un código." });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const exp = new Date(Date.now() + 15 * 60 * 1000);
    const up = "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE LOWER(usuario_correo)=?";
    db.query(up, [code, exp, correo], async (e2) => {
      if (e2) return res.status(500).json({ ok: false, mensaje: "No se pudo generar el código" });
      try {
        await enviarMail({
          to: correo,
          subject: "Código de verificación - Restablecer contraseña",
          html: wrap(`<h2 style="margin:0 0 8px 0;">Restablecer contraseña</h2><p>Usa este código. <strong>Vence en 15 minutos</strong>.</p><p style="font-size:22px;letter-spacing:3px;"><strong>${code}</strong></p><p>Si no solicitaste este código, ignora este correo.</p>`),
          category: "reset-password",
        });
        res.json({ ok: true, mensaje: "Código enviado" });
      } catch {
        res.status(500).json({ ok: false, mensaje: "No se pudo enviar el código" });
      }
    });
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  const correo = String(req.body?.email || req.body?.usuario_correo || "").trim().toLowerCase();
  const pin = String(req.body?.code || req.body?.codigo || "").trim();
  const nueva = String(req.body?.new_password || req.body?.nueva_contrasena || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok: false, mensaje: "La nueva contraseña debe tener mínimo 6 caracteres." });
  const q = "SELECT reset_codigo, reset_expires, reset_used, reset_intentos FROM usuarios WHERE LOWER(usuario_correo)=?";
  db.query(q, [correo], (e1, r1) => {
    if (e1 || !r1.length) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    const row = r1[0];
    if (row.reset_used) return res.status(400).json({ ok: false, mensaje: "Código ya utilizado" });
    if (row.reset_codigo !== pin) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    if (new Date(row.reset_expires).getTime() < Date.now()) return res.status(400).json({ ok: false, mensaje: "Código vencido" });
    const newHash = hashPassword(nueva);
    db.query("UPDATE usuarios SET usuario_contrasena_hash=?, reset_used=1 WHERE LOWER(usuario_correo)=?", [newHash, correo], (e2, r2) => {
      if (e2 || !r2.affectedRows) return res.status(500).json({ ok: false, mensaje: "No se pudo actualizar la contraseña" });
      res.json({ ok: true, mensaje: "Contraseña actualizada" });
    });
  });
});

app.get("/especialidades", (_, res) => {
  db.query("SELECT * FROM especialidades", (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaEspecialidades: r });
  });
});
app.post("/especialidad/agregar", (req, res) => {
  const nombre = String(req.body?.especialidad_nombre || "").trim();
  if (!nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  db.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [nombre], (e) => {
    if (e) return res.status(500).json({ mensaje: "Error al agregar" });
    res.json("Especialidad agregada");
  });
});
app.put("/especialidad/actualizar/:id", (req, res) => {
  const id = Number(req.params.id);
  const nombre = String(req.body?.especialidad_nombre || "").trim();
  if (!nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  db.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [nombre, id], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al actualizar" });
    if (!r.affectedRows) return res.status(404).json({ mensaje: "No encontrado" });
    res.json({ mensaje: "Actualizado" });
  });
});
app.get("/medico/:id_medico/especialidades", (req, res) => {
  const id = Number(req.params.id_medico);
  const q = `SELECT e.id_especialidad, e.especialidad_nombre
             FROM medicos m INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
             WHERE m.id_medico=?`;
  db.query(q, [id], (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    res.json({ listaEspecialidades: r });
  });
});

app.get("/horarios/:parametro", (req, res) => {
  const [rawFecha, idEsp] = String(req.params.parametro || "").split("&");
  const fecha = toYYYYMMDD(rawFecha);
  const q = `
    SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido, e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico=m.id_medico
    INNER JOIN usuarios u ON m.id_medico=u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad=e.id_especialidad
    WHERE h.horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND h.id_especialidad=? AND h.horario_estado=0
    ORDER BY h.horario_hora ASC`;
  db.query(q, [fecha, idEsp], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaHorarios: r });
  });
});
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const id_medico = Number(req.params.id_medico);
  const fecha = toYYYYMMDD(req.params.fecha);
  const id_especialidad = Number(req.params.id_especialidad);
  const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
  const q = `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  db.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    const ocupadas = r.map((x) => x.hora);
    const libres = todas.filter((h) => !ocupadas.includes(h));
    res.json({ horariosDisponibles: libres });
  });
});
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const id_medico = Number(req.params.id_medico);
  const fecha = toYYYYMMDD(req.params.fecha);
  const id_especialidad = Number(req.params.id_especialidad);
  const q = `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0 ORDER BY horario_hora ASC`;
  db.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    res.json({ horarios: r.map((x) => x.horario_hora) });
  });
});
app.post("/horario/registrar", (req, res) => {
  const b = req.body || {};
  const row = {
    id_medico: Number(b.id_medico),
    horario_fecha: toYYYYMMDD(b.horario_fecha),
    horario_hora: b.horario_hora,
    horario_estado: Number(b.horario_estado ?? 0),
    id_especialidad: Number(b.id_especialidad),
  };
  const q = `INSERT INTO horarios_medicos (id_medico,horario_fecha,horario_hora,horario_estado,id_especialidad) VALUES (?,STR_TO_DATE(?, '%Y-%m-%d'),STR_TO_DATE(?, '%H:%i'),?,?)`;
  db.query(q, [row.id_medico, row.horario_fecha, row.horario_hora, row.horario_estado, row.id_especialidad], (e) => {
    if (e) return res.status(500).json({ mensaje: "Error al registrar horario" });
    res.json({ mensaje: "Horario registrado" });
  });
});
app.put("/horario/actualizar/:id_horario", (req, res) => {
  const id = Number(req.params.id_horario);
  const b = req.body || {};
  const set = [];
  const vals = [];
  if (b.horario_estado != null) { set.push("horario_estado=?"); vals.push(Number(b.horario_estado)); }
  if (b.horario_fecha) { set.push("horario_fecha=STR_TO_DATE(?, '%Y-%m-%d')"); vals.push(toYYYYMMDD(b.horario_fecha)); }
  if (b.horario_hora) { set.push("horario_hora=STR_TO_DATE(?, '%H:%i')"); vals.push(b.horario_hora); }
  if (b.id_especialidad) { set.push("id_especialidad=?"); vals.push(Number(b.id_especialidad)); }
  if (!set.length) return res.status(400).json({ mensaje: "Sin cambios" });
  const q = `UPDATE horarios_medicos SET ${set.join(", ")} WHERE id_horario=?`;
  db.query(q, [...vals, id], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al actualizar" });
    res.json({ mensaje: "Horario actualizado" });
  });
});
app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const id_medico = Number(req.params.id_medico);
  const fecha = toYYYYMMDD(req.params.fecha);
  const hora = String(req.params.hora);
  const accion = String(req.body?.accion || "");
  if (!/^\d{2}:\d{2}$/.test(hora)) return res.status(400).json({ mensaje: "Hora inválida" });
  if (accion === "ocupar") {
    const q = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return db.query(q, [id_medico, fecha, hora], (e) => e ? res.status(500).json({ mensaje: "Error al ocupar" }) : res.json({ mensaje: "Horario ocupado" }));
  }
  if (accion === "liberar") {
    const q = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return db.query(q, [id_medico, fecha, hora], (e) => e ? res.status(500).json({ mensaje: "Error al liberar" }) : res.json({ mensaje: "Horario liberado" }));
  }
  if (accion === "eliminar") {
    const q = `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return db.query(q, [id_medico, fecha, hora], (e) => e ? res.status(500).json({ mensaje: "Error al eliminar" }) : res.json({ mensaje: "Horario eliminado" }));
  }
  res.status(400).json({ mensaje: "Acción inválida" });
});

async function correoConfirmacion(to, fecha, hora) { await enviarMail({ to, subject: "Confirmación de tu cita médica", html: wrap(`<h2 style="margin:0 0 8px 0;">Cita confirmada</h2><p>Tu cita ha sido registrada.</p><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`), category: "cita-confirmada" }); }
async function correoActualizacion(to, fecha, hora) { await enviarMail({ to, subject: "Actualización de tu cita médica", html: wrap(`<h2 style="margin:0 0 8px 0;">Cita actualizada</h2><p><strong>Nueva fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`), category: "cita-actualizada" }); }
async function correoCancelacion(to, fecha, hora) { await enviarMail({ to, subject: "Cancelación de tu cita médica", html: wrap(`<h2 style="margin:0 0 8px 0;">Cita cancelada</h2><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`), category: "cita-cancelada" }); }

app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  const qN = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?";
  db.query(qN, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "DB" });
    const numero_orden = (r1[0]?.total || 0) + 1;
    const qIns = `INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado) VALUES (?,?,STR_TO_DATE(?, '%Y-%m-%d'),STR_TO_DATE(?, '%H:%i'),?,1)`;
    db.query(qIns, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });
      const qO = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      db.query(qO, [id_medico, cita_fecha, cita_hora]);
      db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (!e3 && r3.length) correoConfirmacion(r3[0].usuario_correo, cita_fecha, cita_hora).catch(() => {});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});
app.put("/cita/actualizar/:id", (req, res) => {
  const id = Number(req.params.id);
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, r0) => {
    if (e0 || !r0.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const correo = r0[0].usuario_correo;
    const qAnt = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha,TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora,id_medico FROM citas WHERE id_cita=?`;
    db.query(qAnt, [id], (e1, r1) => {
      if (e1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const ant = r1[0];
      db.query(`UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`, [ant.id_medico, ant.cita_fecha, ant.cita_hora]);
      const qUpd = `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'), cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=? WHERE id_cita=?`;
      db.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al actualizar la cita" });
        db.query(`UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`, [id_medico, cita_fecha, cita_hora]);
        correoActualizacion(correo, cita_fecha, cita_hora).catch(() => {});
        res.json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const id_usuario = Number(req.params.id_usuario);
  const numero_orden = Number(req.params.numero_orden);
  const q = `SELECT id_cita,id_medico,DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha,TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora FROM citas WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`;
  db.query(q, [id_usuario, numero_orden], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "No existe esa cita" });
    const c = r1[0];
    db.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [c.id_cita], (e2) => {
      if (e2) return res.status(500).json({ mensaje: "Error al cancelar la cita" });
      db.query(`UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`, [c.id_medico, c.cita_fecha, c.cita_hora]);
      db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (!e3 && r3.length) correoCancelacion(r3[0].usuario_correo, c.cita_fecha, c.cita_hora).catch(() => {});
        res.json({ mensaje: "Cita cancelada y horario liberado" });
      });
    });
  });
});
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const id_usuario = Number(req.params.id_usuario);
  const numero_orden = Number(req.params.numero_orden);
  const q = `SELECT c.*,DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha_fmt,TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora_fmt FROM citas c WHERE c.id_usuario=? AND c.numero_orden=?`;
  db.query(q, [id_usuario, numero_orden], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "DB" });
    if (!r.length) return res.status(404).json({ mensaje: "No existe esa cita" });
    const c = r[0];
    res.json({ id_cita: c.id_cita, id_usuario: c.id_usuario, id_medico: c.id_medico, cita_fecha: c.cita_fecha_fmt, cita_hora: c.cita_hora_fmt, numero_orden: c.numero_orden, cita_estado: c.cita_estado });
  });
});
app.put("/cita/estado/:id_cita", (req, res) => {
  const id_cita = Number(req.params.id_cita);
  const estado = Number(req.body?.cita_estado ?? 1);
  db.query("UPDATE citas SET cita_estado=? WHERE id_cita=?", [estado, id_cita], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "DB" });
    if (!r.affectedRows) return res.status(404).json({ mensaje: "No encontrado" });
    res.json({ mensaje: "Estado actualizado" });
  });
});
app.get("/citas/:usuario", (req, res) => {
  const usuario = Number(req.params.usuario);
  const q = `SELECT c.id_cita, c.id_usuario, c.id_medico, DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha, TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora, u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido, e.id_especialidad, e.especialidad_nombre, c.cita_estado
             FROM citas c
             INNER JOIN medicos m ON c.id_medico=m.id_medico
             INNER JOIN usuarios u ON m.id_medico=u.id_usuario
             INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
             WHERE c.id_usuario=? ORDER BY c.id_cita ASC`;
  db.query(q, [usuario], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaCitas: r.map((x, i) => ({ ...x, numero_orden: i + 1 })) });
  });
});
app.get("/citas/medico/:id_medico", (req, res) => {
  const id = Number(req.params.id_medico);
  const q = `SELECT c.id_cita,c.id_usuario,c.id_medico,DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,c.cita_estado,u.usuario_nombre AS paciente_nombre,u.usuario_apellido AS paciente_apellido
             FROM citas c INNER JOIN usuarios u ON c.id_usuario=u.id_usuario
             WHERE c.id_medico=? ORDER BY c.cita_fecha,c.cita_hora`;
  db.query(q, [id], (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    res.json({ listaCitas: r });
  });
});
app.get("/citas/por-dia", (_, res) => {
  const q = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha, COUNT(*) AS cantidad FROM citas WHERE cita_estado=1 GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  db.query(q, (e, r) => {
    if (e) return res.status(500).json({ error: "DB" });
    res.json({ listaCitas: r.map((x) => ({ fecha: x.fecha, cantidad: x.cantidad })) });
  });
});

app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));

module.exports = { toYYYYMMDD, verifyPassword };
