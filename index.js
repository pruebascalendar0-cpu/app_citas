// index.js - API Clínica Salud Total (MySQL + Express + Gmail API, hash, reset)
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 10000;
app.use(express.json());

/* ============ Request-ID + logs ============ */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT"].includes(req.method)) { try { console.log(`[${req.rid}] body:`, req.body); } catch {} }
  res.on("finish", () => console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now()-t0}ms)`));
  next();
});

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
async function enviarMail({ to, subject, html, text, category = "notificaciones" }) {
  const from = `Clínica Salud Total <${GMAIL_USER}>`;
  const plain = text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    // Subject UTF-8 seguro:
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
  console.log(`[@gmail] intent to=${to} subject="${subject}" cat=${category}`);
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`[@gmail] ok id=${r.data.id}`);
  return r.data;
}
const wrap = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;
async function correoConfirmacion(to, fecha, hora) {
  return enviarMail({
    to, subject: "Confirmación de tu cita médica",
    html: wrap(`<h2>Cita confirmada</h2><p>Tu cita ha sido registrada.</p><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-confirmada",
  });
}
async function correoActualizacion(to, fecha, hora) {
  return enviarMail({
    to, subject: "Actualización de tu cita médica",
    html: wrap(`<h2>Cita actualizada</h2><p><b>Nueva fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-actualizada",
  });
}
async function correoCancelacion(to, fecha, hora) {
  return enviarMail({
    to, subject: "Cancelación de tu cita médica",
    html: wrap(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-cancelada",
  });
}
async function correoBienvenida(to, nombre) {
  return enviarMail({
    to, subject: "Bienvenido a Clínica Salud Total",
    html: wrap(`<h2>¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
    category: "bienvenida",
  });
}

/* ============ Helpers (hash + fecha) ============ */
function toYYYYMMDD(v) {
  if (!v) return v;
  const s = String(v);
  if (s.includes("T")) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return s.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function saltHash(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}

// --- helpers de password (déjalos cerca de tus otros helpers) ---
function verifyPassword(plain, stored) {
  // stored = "<salt>:<sha256(salt + plain)>"
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = require("crypto")
    .createHash("sha256")
    .update(salt + String(plain))
    .digest("hex");
  return test.toLowerCase() === String(hash || "").toLowerCase();
}

// (opcional: solo si necesitas crear hashes desde Node)
function makePassword(plain) {
  const crypto = require("crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  return `${salt}:${hash}`;
}

/* ============ BD ============ */
const conexion = mysql.createConnection({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
conexion.connect((err) => {
  if (err) throw err;
  console.log("✅ Conexión MySQL OK");
  conexion.query("SET time_zone='-05:00'", () => {});
  conexion.query(`
    CREATE TABLE IF NOT EXISTS reset_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(150) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (email), INDEX (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`, (e) =>
    e ? console.error("⚠️ reset_codes:", e.message) : console.log("✅ reset_codes lista")
  );
});

app.get("/", (_, res) => res.send("API Clínica Salud Total"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ===== LOGIN (compatible con tu BD actual) =====
// LOGIN robusto (normaliza correo y usa hash <salt>:<sha256>)
app.post("/usuario/login", (req, res) => {
  const correo = String(req.body?.usuario_correo || req.body?.email || "")
    .trim()
    .toLowerCase();
  const pass = String(req.body?.password || "");

  if (!correo || !pass) {
    return res.status(400).json({ mensaje: "Correo y password requeridos" });
  }

  const sql = `
    SELECT
      id_usuario,
      usuario_nombre,
      usuario_apellido,
      usuario_correo,
      usuario_tipo,
      usuario_contrasena_hash
    FROM usuarios
    WHERE LOWER(usuario_correo) = ?
    LIMIT 1
  `;

  conexion.query(sql, [correo], (e, rows) => {
    if (e) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = rows[0];
    const ok = verifyPassword(pass, u.usuario_contrasena_hash);
    if (!ok) return res.status(401).json({ mensaje: "Contraseña incorrecta" });

    // Login OK
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo,
    });
  });
});

// Registrar paciente
app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!/^\d{8}$/.test(usuario_dni || "")) return res.status(400).json({ mensaje: "DNI inválido (8 dígitos)" });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo || "")) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const row = { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena_hash: saltHash(usuario_contrasena), usuario_tipo: 1 };
  conexion.query("INSERT INTO usuarios SET ?", row, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (err.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    correoBienvenida(usuario_correo, `${usuario_nombre} ${usuario_apellido}`).catch(()=>{});
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

// Actualizar (solo nombre, apellido, correo)
app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const verificar = "SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario<>?";
  conexion.query(verificar, [usuario_correo, id], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (r.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    conexion.query(`UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?`,
      [usuario_nombre, usuario_apellido, usuario_correo, id], (e2) =>
        e2 ? res.status(500).json({ mensaje: "Error al actualizar usuario" }) : res.json({ mensaje: "Usuario actualizado correctamente" })
    );
  });
});

// Listado usuarios
app.get("/usuarios", (_, res) => {
  const sql = `SELECT id_usuario, usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo FROM usuarios ORDER BY id_usuario ASC`;
  conexion.query(sql, (e, rows) => e ? res.status(500).json({ error: "Error al cargar usuarios" }) : res.json({ listaUsuarios: rows }));
});

// Obtener por correo
app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo || "");
  conexion.query("SELECT * FROM usuarios WHERE usuario_correo=?", [correo], (e, r) =>
    e ? res.status(500).send(e.message) : (!r.length ? res.status(404).send({ mensaje: "no hay registros" }) : res.json(r[0]))
  );
});

/* ============ RESET POR CÓDIGO (envía por Gmail API) ============ */
const sha256 = (s)=>crypto.createHash("sha256").update(s).digest("hex");
const genCode6 = ()=>Math.floor(100000 + Math.random()*900000).toString();

app.post("/usuario/reset/solicitar", (req, res) => {
  const correo = String(req.body.email ?? req.body.usuario_correo ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok:false, mensaje:"Correo inválido" });

  const qUser = "SELECT id_usuario FROM usuarios WHERE LOWER(usuario_correo)=?";
  conexion.query(qUser, [correo], async (e1, r1) => {
    if (e1) return res.status(500).json({ ok:false, mensaje:"Error en base de datos" });
    if (!r1.length) return res.json({ ok:true, mensaje:"Si el correo existe, se envió un código." });

    const code = genCode6(), codeHash = sha256(code), expiresAt = new Date(Date.now()+15*60*1000);
    conexion.query("INSERT INTO reset_codes (email, code_hash, expires_at) VALUES (?,?,?)", [correo, codeHash, expiresAt], async (e2) => {
      if (e2) return res.status(500).json({ ok:false, mensaje:"No se pudo generar el código" });
      try {
        await enviarMail({
          to: correo,
          subject: "Código de verificación - Restablecer contraseña",
          html: wrap(`<h2>Restablecer contraseña</h2><p>Usa este código (vence en 15 min):</p><p style="font-size:22px;letter-spacing:3px;"><b>${code}</b></p>`),
          category: "reset-password"
        });
        res.json({ ok:true, mensaje:"Código enviado" });
      } catch(e) {
        res.status(500).json({ ok:false, mensaje:"No se pudo enviar el código" });
      }
    });
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  const correo = String(req.body.email ?? req.body.usuario_correo ?? "").trim().toLowerCase();
  const pin = String(req.body.code ?? req.body.codigo ?? "").trim();
  const nueva = String(req.body.new_password ?? req.body.nueva_contrasena ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok:false, mensaje:"Correo inválido" });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok:false, mensaje:"Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok:false, mensaje:"La nueva contraseña debe tener mínimo 6 caracteres." });

  const codeHash = sha256(pin);
  const q = `SELECT id, expires_at, used FROM reset_codes WHERE email=? AND code_hash=? ORDER BY id DESC LIMIT 1`;
  conexion.query(q, [correo, codeHash], (e1, r1) => {
    if (e1) return res.status(500).json({ ok:false, mensaje:"Error en base de datos" });
    if (!r1.length) return res.status(400).json({ ok:false, mensaje:"Código inválido" });
    const row = r1[0];
    if (row.used) return res.status(400).json({ ok:false, mensaje:"Código ya utilizado" });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ ok:false, mensaje:"Código vencido" });

    const newHash = saltHash(nueva);
    conexion.query("UPDATE usuarios SET usuario_contrasena_hash=? WHERE LOWER(usuario_correo)=?",
      [newHash, correo], (e2, r2) => {
        if (e2) return res.status(500).json({ ok:false, mensaje:"No se pudo actualizar la contraseña" });
        if (!r2.affectedRows) return res.status(400).json({ ok:false, mensaje:"No se encontró el usuario" });
        conexion.query("UPDATE reset_codes SET used=1 WHERE id=?", [row.id], ()=>{});
        res.json({ ok:true, mensaje:"Contraseña actualizada" });
      });
  });
});

/* ============ ESPECIALIDADES / MÉDICOS / HORARIOS ============ */
app.get("/especialidades", (_, res) => {
  conexion.query("SELECT * FROM especialidades", (e, r) => e ? res.status(500).json({ error: e.message }) : res.json({ listaEspecialidades: r }));
});

// horarios por "fecha&especialidad"
app.get("/horarios/:parametro", (req, res) => {
  const [rawFecha, idEsp] = String(req.params.parametro || "").split("&");
  const fecha = toYYYYMMDD(rawFecha);
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
  conexion.query(sql, [fecha, idEsp], (e, r) => e ? res.status(500).json({ error: e.message }) : res.json({ listaHorarios: r }));
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const q = `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  conexion.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map(x => x.hora);
    res.json({ horariosDisponibles: todas.filter(h => !ocupadas.includes(h)) });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (e, rows) =>
    e ? res.status(500).json({ error: "Error interno del servidor" }) : res.json({ horarios: rows.map(r => r.horario_hora) })
  );
});

// ocupar/liberar/eliminar horario
app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const { id_medico } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const hora = req.params.hora;
  const { accion } = req.body || {};
  console.log(`[${req.rid}] /horario/editar ->`, { id_medico, fecha, hora, accion });

  if (!/^\d{2}:\d{2}$/.test(hora)) return res.status(400).json({ mensaje: "Hora inválida (HH:mm)" });
  const where = "id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')";
  if (accion === "ocupar")  return conexion.query(`UPDATE horarios_medicos SET horario_estado=1 WHERE ${where}`, [id_medico, fecha, hora], (e) => e?res.status(500).json({mensaje:"Error al ocupar horario"}):res.json({mensaje:"Horario ocupado"}));
  if (accion === "liberar") return conexion.query(`UPDATE horarios_medicos SET horario_estado=0 WHERE ${where}`, [id_medico, fecha, hora], (e) => e?res.status(500).json({mensaje:"Error al liberar horario"}):res.json({mensaje:"Horario liberado"}));
  if (accion === "eliminar") return conexion.query(`DELETE FROM horarios_medicos WHERE ${where}`, [id_medico, fecha, hora], (e) => e?res.status(500).json({mensaje:"Error al eliminar horario"}):res.json({mensaje:"Horario eliminado"}));
  res.status(400).json({ mensaje: "Acción inválida (ocupar|liberar|eliminar)" });
});

/* ============ CITAS ============ */
app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  console.log(`[${req.rid}] /cita/agregar saneado:`, { id_usuario, id_medico, cita_fecha, cita_hora });

  conexion.query("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

    const ins = `INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden) VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?)`;
    conexion.query(ins, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const ocu = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(ocu, [id_medico, cita_fecha, cita_hora], () => {});

      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (e3 || !r3.length) return res.status(404).json({ error: "Usuario no encontrado" });
        correoConfirmacion(r3[0].usuario_correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, r0) => {
    if (e0 || !r0.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const correo = r0[0].usuario_correo;

    const ant = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?`;
    conexion.query(ant, [id], (e1, r1) => {
      if (e1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const a = r1[0];

      const lib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(lib, [a.id_medico, a.cita_fecha, a.cita_hora], () => {});

      const upd = `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'), cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=? WHERE id_cita=?`;
      conexion.query(upd, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const ocu = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
        conexion.query(ocu, [id_medico, cita_fecha, cita_hora], () => {});
        correoActualizacion(correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const q = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?`;
  conexion.query(q, [id_cita], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const lib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(lib, [id_medico, cita_fecha, cita_hora], () => res.json({ mensaje: "Cita cancelada y horario liberado" }));
    });
  });
});

// Citas por usuario
app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
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
    ORDER BY c.id_cita ASC`;
  conexion.query(sql, [usuario], (e, rows) => e ? res.status(500).json({ error: e.message }) : res.json({ listaCitas: rows.map((x,i)=>({ ...x, numero_orden: i+1 })) }));
});

// KPI citas/día
app.get("/citas/por-dia", (_, res) => {
  const q = `SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad FROM citas WHERE cita_estado=1 GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  conexion.query(q, (e, rows) => e ? res.status(500).json({ error: "Error en la base de datos" }) : res.json({ listaCitas: rows.map(r => ({ fecha: r.fecha, cantidad: r.cantidad })) }));
});

/* ============ START ============ */
app.listen(PUERTO, () => console.log("🚀 Servidor en puerto " + PUERTO));

module.exports = { toYYYYMMDD, verifyPassword };
