// index.js - API Clínica Salud Total (Nodemailer + MySQL + Express)
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();
const PUERTO = process.env.PORT || 3000;
app.use(express.json());

/* ============ Middleware de request-id y logging básico ============ */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const started = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT"].includes(req.method)) {
    try {
      console.log(`[${req.rid}] body:`, req.body);
    } catch {}
  }
  res.on("finish", () => {
    console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - started}ms)`);
  });
  next();
});

/* =================== Email (Nodemailer / SMTP) =================== */
/**
 * Requisitos para Gmail:
 * - Activar 2FA en la cuenta
 * - Crear App Password y usarla en EMAIL_PASSWORD
 * Variables .env soportadas:
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=465
 *   SMTP_SECURE=true
 *   EMAIL_USER=pruebascalendar0@gmail.com
 *   EMAIL_PASSWORD=APP_PASSWORD
 *   EMAIL_FROM=Clínica Salud Total <pruebascalendar0@gmail.com>
 *   REPLY_TO=pruebascalendar0@gmail.com
 *   (opcionales) UNSUB_MAILTO, UNSUB_URL
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") === "true", // true=465, false=587
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  connectionTimeout: 15000,
  socketTimeout: 20000,
});

const FROM = process.env.EMAIL_FROM || `Clínica Salud Total <${process.env.EMAIL_USER}>`;
const REPLY_TO = process.env.REPLY_TO || process.env.EMAIL_USER;

function listUnsubHeaders() {
  const h = [];
  if (process.env.UNSUB_MAILTO) h.push(`<mailto:${process.env.UNSUB_MAILTO}>`);
  if (process.env.UNSUB_URL) h.push(`<${process.env.UNSUB_URL}>`);
  return h.length ? { "List-Unsubscribe": h.join(", ") } : undefined;
}
function toPlainText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function sanitizeHeader(s) {
  return String(s || "").replace(/\r|\n/g, " ").replace(/\s+/g, " ").trim();
}
async function enviarMail({ to, subject, html, text, category = "notificaciones" }) {
  const headers = {
    ...(listUnsubHeaders() || {}),
    "X-Category": category,
    "X-Entity-Ref-ID": crypto.randomUUID(),
  };

  const msg = {
    from: FROM,
    to,
    subject: sanitizeHeader(subject),
    html,
    text: text || toPlainText(html),
    replyTo: REPLY_TO,
    headers,
  };

  try {
    console.log(`[@mail] intent: to=${to} subject="${subject}" category=${category}`);
    const info = await transporter.sendMail(msg);
    console.log(`[@mail] ok: messageId=${info.messageId}`);
    return info;
  } catch (e) {
    console.error(`[@mail] error:`, e?.response || e);
    throw e;
  }
}
const wrap = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;

/* =================== Helpers =================== */
function toYYYYMMDD(v) {
  if (!v) return v;
  const s = String(v);
  if (s.includes("T")) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(v);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return s.slice(0, 10);
  }
}
function verifyPassword(plain, stored) {
  // stored = "<salt>:<sha256(salt+plain)>"
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return test.toLowerCase() === (hash || "").toLowerCase();
}

/* =================== BD =================== */
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME, // railway
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
conexion.connect((err) => {
  if (err) throw err;
  console.log("✅ Conexión MySQL OK");
  // Fija TZ de la sesión para evitar corrimientos con UTC
  conexion.query("SET time_zone = '-05:00'", () => {});

  // Asegura tabla de códigos de reset
  conexion.query(`
    CREATE TABLE IF NOT EXISTS reset_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(150) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (email),
      INDEX (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, (e) => {
    if (e) console.error("⚠️  No se pudo crear/verificar tabla reset_codes:", e.message);
    else console.log("✅ Tabla reset_codes lista");
  });
});

app.get("/", (_, res) => res.send("API Clínica Salud Total"));
app.get("/health", (_, res) => res.json({ ok: true, uptime: process.uptime() }));

/* =================== Emails prearmados =================== */
async function correoConfirmacion(to, fecha, hora) {
  await enviarMail({
    to,
    subject: "Confirmación de tu cita médica",
    html: wrap(`
      <h2 style="margin:0 0 8px 0;">Cita médica confirmada</h2>
      <p>Tu cita ha sido registrada.</p>
      <p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>
    `),
    category: "cita-confirmada",
  });
}
async function correoActualizacion(to, fecha, hora) {
  await enviarMail({
    to,
    subject: "Actualización de tu cita médica",
    html: wrap(`
      <h2 style="margin:0 0 8px 0;">Cita actualizada</h2>
      <p><strong>Nueva fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>
    `),
    category: "cita-actualizada",
  });
}
async function correoCancelacion(to, fecha, hora) {
  await enviarMail({
    to,
    subject: "Cancelación de tu cita médica",
    html: wrap(`
      <h2 style="margin:0 0 8px 0;">Cita cancelada</h2>
      <p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>
    `),
    category: "cita-cancelada",
  });
}
async function correoBienvenida(to, nombre) {
  await enviarMail({
    to,
    subject: "Bienvenido a Clínica Salud Total",
    html: wrap(`<h2 style="margin:0 0 8px 0;">¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
    category: "bienvenida",
  });
}

/* =================== USUARIOS =================== */
// LOGIN con hash (compatible semillas en minúscula)
app.post("/usuario/login", (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) return res.status(400).json({ mensaje: "Correo y password requeridos" });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?";
  conexion.query(q, [usuario_correo], (e, rows) => {
    if (e) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    const u = rows[0];
    if (!verifyPassword(password, u.usuario_contrasena_hash || "")) {
      return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    }
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo,
    });
  });
});

// Registro simple PACIENTE (crea hash)
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}
app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!/^\d{8}$/.test(usuario_dni || "")) return res.status(400).json({ mensaje: "DNI inválido (8 dígitos)" });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo || "")) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const row = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo: 1,
  };
  conexion.query("INSERT INTO usuarios SET ?", row, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (err.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    correoBienvenida(usuario_correo, `${usuario_nombre} ${usuario_apellido}`).catch(() => {});
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

/* =================== RESET DE CONTRASEÑA (para Android) =================== */
function genCode6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Solicitar código por correo
app.post("/usuario/reset/solicitar", (req, res) => {
  const { email } = req.body || {};
  const correo = String(email || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  }

  console.log(`[${req.rid}] reset/solicitar -> ${correo}`);

  const qUser = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE LOWER(usuario_correo)=?";
  conexion.query(qUser, [correo], async (e1, r1) => {
    if (e1) {
      console.error(`[${req.rid}] reset/solicitar error DB:`, e1.message);
      return res.status(500).json({ ok: false, mensaje: "Error en base de datos" });
    }
    if (!r1.length) {
      // Evitar filtrar existencia (respuesta genérica)
      console.log(`[${req.rid}] reset/solicitar: correo no registrado (respuesta genérica ok)`);
      return res.json({ ok: true, mensaje: "Si el correo existe, se envió un código." });
    }

    const code = genCode6();
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    const qIns = "INSERT INTO reset_codes (email, code_hash, expires_at) VALUES (?, ?, ?)";

    conexion.query(qIns, [correo, codeHash, expiresAt], async (e2) => {
      if (e2) {
        console.error(`[${req.rid}] reset/solicitar insert error:`, e2.message);
        return res.status(500).json({ ok: false, mensaje: "No se pudo generar el código" });
      }

      try {
        await enviarMail({
          to: correo,
          subject: "Código de verificación - Restablecer contraseña",
          html: wrap(`
            <h2 style="margin:0 0 8px 0;">Restablecer contraseña</h2>
            <p>Usa este código para cambiar tu contraseña. <strong>Vence en 15 minutos</strong>.</p>
            <p style="font-size:22px;letter-spacing:3px;"><strong>${code}</strong></p>
            <p>Si no solicitaste este código, ignora este correo.</p>
          `),
          category: "reset-password",
        });
        console.log(`[${req.rid}] reset/solicitar -> código enviado a ${correo}`);
        return res.json({ ok: true, mensaje: "Código enviado" });
      } catch (e) {
        console.error(`[${req.rid}] reset/solicitar mail error:`, e?.response || e);
        return res.status(500).json({ ok: false, mensaje: "No se pudo enviar el código" });
      }
    });
  });
});

// Cambiar contraseña con código
app.post("/usuario/reset/cambiar", (req, res) => {
  const { email, code, new_password } = req.body || {};
  const correo = String(email || "").trim().toLowerCase();
  const pin = String(code || "").trim();
  const nueva = String(new_password || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  }
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ ok: false, mensaje: "Código inválido" });
  }
  if (nueva.length < 6) {
    return res.status(400).json({ ok: false, mensaje: "La nueva contraseña debe tener mínimo 6 caracteres." });
  }

  console.log(`[${req.rid}] reset/cambiar -> ${correo}`);

  const codeHash = sha256(pin);
  const qSel = `
    SELECT id, expires_at, used
      FROM reset_codes
     WHERE email=? AND code_hash=?
     ORDER BY id DESC
     LIMIT 1
  `;
  conexion.query(qSel, [correo, codeHash], (e1, r1) => {
    if (e1) {
      console.error(`[${req.rid}] reset/cambiar error DB:`, e1.message);
      return res.status(500).json({ ok: false, mensaje: "Error en base de datos" });
    }
    if (!r1.length) {
      return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    }
    const row = r1[0];
    if (row.used) {
      return res.status(400).json({ ok: false, mensaje: "Código ya utilizado" });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ ok: false, mensaje: "Código vencido" });
    }

    const newHash = (function hashPassword(plain) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
      return `${salt}:${hash}`;
    })(nueva);

    const qUpdPass = "UPDATE usuarios SET usuario_contrasena_hash=? WHERE LOWER(usuario_correo)=?";
    conexion.query(qUpdPass, [newHash, correo], (e2, r2) => {
      if (e2) {
        console.error(`[${req.rid}] reset/cambiar update pass error:`, e2.message);
        return res.status(500).json({ ok: false, mensaje: "No se pudo actualizar la contraseña" });
      }
      if (r2.affectedRows === 0) {
        return res.status(400).json({ ok: false, mensaje: "No se encontró el usuario" });
      }

      conexion.query("UPDATE reset_codes SET used=1 WHERE id=?", [row.id], (e3) => {
        if (e3) console.error(`[${req.rid}] reset/cambiar marcar usado error:`, e3.message);
        console.log(`[${req.rid}] reset/cambiar -> contraseña actualizada para ${correo}`);
        return res.json({ ok: true, mensaje: "Contraseña actualizada" });
      });
    });
  });
});

/* =================== ESPECIALIDADES / MÉDICOS / HORARIOS =================== */
app.get("/especialidades", (_, res) => {
  conexion.query("SELECT * FROM especialidades", (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaEspecialidades: r });
  });
});

// Listado de horarios por fecha + especialidad (fecha saneada)
app.get("/horarios/:parametro", (req, res) => {
  const [rawFecha, idEsp] = (req.params.parametro || "").split("&");
  const fecha = toYYYYMMDD(rawFecha);
  const consulta = `
    SELECT h.*,
           TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
           u.usuario_nombre AS medico_nombre,
           u.usuario_apellido AS medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
    WHERE h.horario_fecha = STR_TO_DATE(?, '%Y-%m-%d')
      AND h.id_especialidad = ?
      AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC`;
  conexion.query(consulta, [fecha, idEsp], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
  });
});

// Horas disponibles calculando huecos
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const q = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  conexion.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map(x => x.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: disponibles });
  });
});

// Horarios registrados (libres = estado 0)
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    res.json({ horarios: rows.map(r => r.horario_hora) });
  });
});

/* =================== CITAS =================== */
// Agregar cita (fecha/hora saneadas + STR_TO_DATE)
app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);

  console.log(`[${req.rid}] /cita/agregar payload saneado:`, { id_usuario, id_medico, cita_fecha, cita_hora });

  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;
    console.log(`[${req.rid}] /cita/agregar numero_orden calculado:`, numero_orden);

    const qIns = `
      INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden)
      VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?)`;
    conexion.query(qIns, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const qOcupar = `
        UPDATE horarios_medicos SET horario_estado=1
        WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(qOcupar, [id_medico, cita_fecha, cita_hora], () => {});

      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (e3 || !r3.length) return res.status(404).json({ error: "Usuario no encontrado" });
        console.log(`[${req.rid}] /cita/agregar correo a:`, r3[0].usuario_correo);
        correoConfirmacion(r3[0].usuario_correo, cita_fecha, cita_hora).catch(() => {});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

// Actualizar cita (libera/ocupa slots correctamente)
app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, r0) => {
    if (e0 || !r0.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const usuario_correo = r0[0].usuario_correo;

    const qAnt = `
      SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha,
             TIME_FORMAT(cita_hora,'%H:%i')      AS cita_hora,
             id_medico
      FROM citas WHERE id_cita=?`;
    conexion.query(qAnt, [id], (e1, r1) => {
      if (e1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const anterior = r1[0];

      const qLiberar = `
        UPDATE horarios_medicos SET horario_estado=0
        WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(qLiberar, [anterior.id_medico, anterior.cita_fecha, anterior.cita_hora], () => {});

      const qUpd = `
        UPDATE citas SET
          id_usuario=?, id_medico=?,
          cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'),
          cita_hora =STR_TO_DATE(?, '%H:%i'),
          cita_estado=?
        WHERE id_cita=?`;
      conexion.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcupar = `
          UPDATE horarios_medicos SET horario_estado=1
          WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
        conexion.query(qOcupar, [id_medico, cita_fecha, cita_hora], () => {});
        correoActualizacion(usuario_correo, cita_fecha, cita_hora).catch(() => {});
        res.json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

// Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const q = "SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?";
  conexion.query(q, [id_cita], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const qLib = `
        UPDATE horarios_medicos SET horario_estado=0
        WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(qLib, [id_medico, cita_fecha, cita_hora], () => res.json({ mensaje: "Cita cancelada y horario liberado" }));
    });
  });
});

// Citas por usuario (fechas ya formateadas para UI)
app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  console.log(`[${req.rid}] /citas/${usuario} -> consultando`);

  const consulta = `
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
  conexion.query(consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    const lista = rpta.map((cita, idx) => ({ ...cita, numero_orden: idx + 1 }));
    console.log(`[${req.rid}] /citas/${usuario} -> ${lista.length} cita(s)`);
    res.json({ listaCitas: lista });
  });
});

// KPIs por día (sin toISOString)
app.get("/citas/por-dia", (_, res) => {
  const q = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  conexion.query(q, (e, rows) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: rows.map(r => ({ fecha: r.fecha, cantidad: r.cantidad })) });
  });
});

/* =================== START =================== */
app.listen(PUERTO, () => console.log("🚀 Servidor en puerto " + PUERTO));

/* =================== Exports (opcional tests) =================== */
module.exports = { toYYYYMMDD, verifyPassword };
