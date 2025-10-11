// index.js – Clínica Salud Total (Express + MySQL2 + Gmail API)
// Esquema compatible con tu BD (usuarios.usuario_contrasena_hash, reset_* en usuarios).
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 10000;
app.use(express.json());

/* ============ Middleware de request-id y logging ============ */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT"].includes(req.method)) {
    try { console.log(`[${req.rid}] body:`, req.body); } catch {}
  }
  res.on("finish", () => {
    console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`);
  });
  next();
});

/* =================== Gmail API =================== */
const MAIL_STRATEGY = (process.env.MAIL_STRATEGY || "").toUpperCase(); // GMAIL_API
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_FROM = process.env.EMAIL_FROM || `Clínica Salud Total <${EMAIL_USER}>`;
const REPLY_TO  = process.env.REPLY_TO  || EMAIL_USER;

let gmailClient = null;
if (MAIL_STRATEGY === "GMAIL_API") {
  gmailClient = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  if (process.env.GMAIL_REFRESH_TOKEN) {
    gmailClient.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  }
}

function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}
async function enviarMail({ to, subject, html, text, category="notificaciones" }) {
  if (!gmailClient) {
    console.log(`[@mail] mock -> to=${to} subj="${subject}"`); return;
  }
  const raw = [
    `From: ${EMAIL_FROM}`,
    `To: ${to}`,
    `Subject: ${String(subject||"").replace(/\r|\n/g," ")}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    `Reply-To: ${REPLY_TO}`,
    `X-Category: ${category}`,
    "",
    html || (text || "")
  ].join("\r\n");
  const gmail = google.gmail({ version:"v1", auth: gmailClient });
  const res = await gmail.users.messages.send({ userId:"me", requestBody:{ raw: b64url(raw) } });
  console.log(`[@mail] ok id=${res.data.id}`);
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
  if (s.includes("T")) return s.slice(0,10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s); if (isNaN(d)) return s.slice(0,10);
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function verifyPassword(plain, stored) {
  // stored = "salt:sha256(salt+plain)"
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return test.toLowerCase() === (hash || "").toLowerCase();
}
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}
const genCode6 = ()=>Math.floor(100000+Math.random()*900000).toString();

/* =================== BD =================== */
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
conexion.connect((err) => {
  if (err) throw err;
  console.log("✅ Conexión MySQL OK");
  conexion.query("SET time_zone='-05:00'", ()=>{});
});

/* =================== Salud =================== */
app.get("/", (_,res)=>res.send("API Clínica Salud Total"));
app.get("/health", (_,res)=>res.json({ok:true, uptime:process.uptime(), mail:MAIL_STRATEGY}));

/* =================== Emails prearmados =================== */
const correoConfirmacion = (to, f, h)=>
  enviarMail({ to, subject:"Confirmación de tu cita médica",
    html: wrap(`<h2>Cita confirmada</h2><p><b>Fecha:</b> ${f}<br/><b>Hora:</b> ${h}</p>`),
    category:"cita-confirmada" });
const correoActualizacion = (to, f, h)=>
  enviarMail({ to, subject:"Actualización de tu cita médica",
    html: wrap(`<h2>Cita actualizada</h2><p><b>Fecha:</b> ${f}<br/><b>Hora:</b> ${h}</p>`),
    category:"cita-actualizada" });
const correoCancelacion = (to, f, h)=>
  enviarMail({ to, subject:"Cancelación de tu cita médica",
    html: wrap(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${f}<br/><b>Hora:</b> ${h}</p>`),
    category:"cita-cancelada" });
const correoBienvenida = (to, nombre)=>
  enviarMail({ to, subject:"Bienvenido a Clínica Salud Total",
    html: wrap(`<h2>¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
    category:"bienvenida" });

/* =================== USUARIOS =================== */
// LOGIN
app.post("/usuario/login", (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) return res.status(400).json({ mensaje: "Correo y password requeridos" });
  const q = `
    SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash
    FROM usuarios WHERE usuario_correo=?`;
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

// Registro simple PACIENTE
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
    usuario_tipo: 1, // paciente
  };
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

// Listado (panel admin)
app.get("/usuarios", (_req, res) => {
  const sql = `
    SELECT id_usuario, usuario_dni, usuario_nombre, usuario_apellido,
           usuario_correo, usuario_tipo
    FROM usuarios
    ORDER BY id_usuario ASC`;
  conexion.query(sql, (e, rows) => {
    if (e) return res.status(500).json({ error: "Error al cargar usuarios" });
    res.json({ listaUsuarios: rows });
  });
});

/* ====== RESET DE CONTRASEÑA (campos reset_* en usuarios) ====== */
// solicitar código
app.post("/usuario/reset/solicitar", (req, res) => {
  const { email } = req.body || {};
  const correo = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    return res.status(400).json({ ok:false, mensaje:"Correo inválido" });
  }
  // Genera un código (intenta evitar colisión con UNIQUE uq_reset_codigo)
  const intentar = (retries=5) => {
    const code = genCode6();
    const q = `
      UPDATE usuarios
         SET reset_codigo=?, reset_expires=DATE_ADD(NOW(), INTERVAL 15 MINUTE),
             reset_used=0, reset_intentos=0
       WHERE LOWER(usuario_correo)=?`;
    conexion.query(q, [code, correo], async (e, r) => {
      if (e && e.code === "ER_DUP_ENTRY" && retries > 0) return intentar(retries-1);
      if (e) return res.status(500).json({ ok:false, mensaje:"No se pudo generar el código" });
      if (r.affectedRows === 0) {
        // Respuesta genérica para no filtrar existencia
        return res.json({ ok:true, mensaje:"Si el correo existe, se envió un código." });
      }
      try {
        await enviarMail({
          to: correo,
          subject: "Código de verificación - Restablecer contraseña",
          html: wrap(`
            <h2>Restablecer contraseña</h2>
            <p>Usa este código (vence en 15 min):</p>
            <p style="font-size:22px;letter-spacing:3px;"><strong>${code}</strong></p>
          `),
          category: "reset-password",
        });
        res.json({ ok:true, mensaje:"Código enviado" });
      } catch (err) {
        res.status(500).json({ ok:false, mensaje:"No se pudo enviar el código" });
      }
    });
  };
  intentar();
});

// cambiar contraseña
app.post("/usuario/reset/cambiar", (req, res) => {
  const { email, code, new_password } = req.body || {};
  const correo = String(email || "").trim().toLowerCase();
  const pin = String(code || "").trim();
  const nueva = String(new_password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok:false, mensaje:"Correo inválido" });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok:false, mensaje:"Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok:false, mensaje:"La nueva contraseña debe tener mínimo 6 caracteres." });

  const sel = `
    SELECT id_usuario, reset_expires, reset_used, reset_intentos
      FROM usuarios
     WHERE LOWER(usuario_correo)=? AND reset_codigo=?
     LIMIT 1`;
  conexion.query(sel, [correo, pin], (e1, r1) => {
    if (e1) return res.status(500).json({ ok:false, mensaje:"Error en base de datos" });
    if (!r1.length) {
      // suma intento si existe usuario
      conexion.query(
        "UPDATE usuarios SET reset_intentos = LEAST(reset_intentos+1,10) WHERE LOWER(usuario_correo)=?",
        [correo], ()=>{}
      );
      return res.status(400).json({ ok:false, mensaje:"Código inválido" });
    }
    const row = r1[0];
    if (row.reset_used) return res.status(400).json({ ok:false, mensaje:"Código ya utilizado" });
    if (new Date(row.reset_expires).getTime() < Date.now()) return res.status(400).json({ ok:false, mensaje:"Código vencido" });

    const newHash = hashPassword(nueva);
    const upd = `
      UPDATE usuarios
         SET usuario_contrasena_hash=?,
             reset_used=1, reset_codigo=NULL, reset_expires=NULL, reset_intentos=0
       WHERE id_usuario=?`;
    conexion.query(upd, [newHash, row.id_usuario], (e2, r2) => {
      if (e2) return res.status(500).json({ ok:false, mensaje:"No se pudo actualizar la contraseña" });
      if (r2.affectedRows === 0) return res.status(400).json({ ok:false, mensaje:"No se encontró el usuario" });
      res.json({ ok:true, mensaje:"Contraseña actualizada" });
    });
  });
});

/* =================== ESPECIALIDADES / MÉDICOS / HORARIOS =================== */
app.get("/especialidades", (_req, res) => {
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

// Horas disponibles calculando huecos (8:00–16:00 cada hora)
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
    const ocupadas = r.map((x) => x.hora);
    const disponibles = todas.filter((h) => !ocupadas.includes(h));
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
    res.json({ horarios: rows.map((r) => r.horario_hora) });
  });
});

// Editar/ocupar/liberar/eliminar un horario
app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const { id_medico } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const hora = req.params.hora;
  const { accion } = req.body || {};

  if (!/^\d{2}:\d{2}$/.test(hora)) {
    return res.status(400).json({ mensaje: "Hora inválida (HH:mm)" });
  }

  if (accion === "ocupar") {
    const q = `
      UPDATE horarios_medicos SET horario_estado=1
      WHERE id_medico=? AND horario_fecha=STR_TODATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return conexion.query(q, [id_medico, fecha, hora], (e, r) => {
      if (e) return res.status(500).json({ mensaje: "Error al ocupar horario" });
      res.json({ mensaje: "Horario ocupado" });
    });
  }
  if (accion === "liberar") {
    const q = `
      UPDATE horarios_medicos SET horario_estado=0
      WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return conexion.query(q, [id_medico, fecha, hora], (e, r) => {
      if (e) return res.status(500).json({ mensaje: "Error al liberar horario" });
      res.json({ mensaje: "Horario liberado" });
    });
  }
  if (accion === "eliminar") {
    const q = `
      DELETE FROM horarios_medicos
      WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return conexion.query(q, [id_medico, fecha, hora], (e, r) => {
      if (e) return res.status(500).json({ mensaje: "Error al eliminar horario" });
      res.json({ mensaje: "Horario eliminado" });
    });
  }
  return res.status(400).json({ mensaje: "Acción inválida (ocupar|liberar|eliminar)" });
});

/* =================== CITAS =================== */
// Agregar cita
app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);

  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

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
        correoConfirmacion(r3[0].usuario_correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

// Actualizar cita (libera/ocupa correctamente)
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
        correoActualizacion(usuario_correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

// Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const q =
    "SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?";
  conexion.query(q, [id_cita], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const qLib = `
        UPDATE horarios_medicos SET horario_estado=0
        WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(qLib, [id_medico, cita_fecha, cita_hora], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
          if (!e3 && r3.length) correoCancelacion(r3[0].usuario_correo, cita_fecha, cita_hora).catch(()=>{});
          res.json({ mensaje: "Cita cancelada y horario liberado" });
        });
      });
    });
  });
});

// Citas por usuario
app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
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
    res.json({ listaCitas: lista });
  });
});

// KPIs por día
app.get("/citas/por-dia", (_req, res) => {
  const q = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  conexion.query(q, (e, rows) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: rows.map((r) => ({ fecha: r.fecha, cantidad: r.cantidad })) });
  });
});

/* =================== START =================== */
app.listen(PUERTO, () => console.log("🚀 Servidor en puerto " + PUERTO));

/* =================== Exports (opcional tests) =================== */
module.exports = { toYYYYMMDD, verifyPassword, hashPassword };
