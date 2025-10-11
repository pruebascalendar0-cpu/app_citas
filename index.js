// index.js – Clínica Salud Total (Express + MySQL + Nodemailer)
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "256kb" }));

/* --------- Logging básico + request id --------- */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  const b = (req.method === "POST" || req.method === "PUT") ? ` body: ${JSON.stringify(req.body).slice(0, 500)}` : "";
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}${b}`);
  res.on("finish", () => {
    console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`);
  });
  next();
});

/* --------- Mailer (Gmail SMTP) --------- */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: (process.env.EMAIL_PASSWORD || "").replace(/\s+/g, ""),
  },
  pool: true,
  maxConnections: 3,
  maxMessages: 50,
  connectionTimeout: 30000,
  socketTimeout: 45000,
  family: 4,
});

const FROM = process.env.EMAIL_FROM || `Clínica Salud Total <${process.env.EMAIL_USER}>`;
const REPLY_TO = process.env.REPLY_TO || process.env.EMAIL_USER;

function txt(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function wrap(inner) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;
}
async function sendMail({ to, subject, html, category = "notificaciones" }) {
  const msg = {
    from: FROM,
    to,
    subject,
    html,
    text: txt(html),
    replyTo: REPLY_TO,
    headers: { "X-Category": category, "X-Entity-Ref-ID": crypto.randomUUID() },
  };
  try {
    console.log(`[mail] -> to=${to} subj="${subject}" cat=${category}`);
    const info = await transporter.sendMail(msg);
    console.log(`[mail] <- ok id=${info.messageId}`);
  } catch (e) {
    console.error("[mail] <- error:", e?.response || e);
  }
}
const mailers = {
  bienvenida: (to, nombre) =>
    sendMail({
      to,
      subject: "Bienvenido a Clínica Salud Total",
      html: wrap(`<h2>¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
      category: "bienvenida",
    }),
  confirmacion: (to, fecha, hora) =>
    sendMail({
      to,
      subject: "Confirmación de tu cita médica",
      html: wrap(`<h2>Cita confirmada</h2><p>Tu cita ha sido registrada.</p><p><b>Fecha:</b> ${fecha}<br/><b>Hora:</b> ${hora}</p>`),
      category: "cita-confirmada",
    }),
  actualizacion: (to, fecha, hora) =>
    sendMail({
      to,
      subject: "Actualización de tu cita médica",
      html: wrap(`<h2>Cita actualizada</h2><p><b>Nueva fecha:</b> ${fecha}<br/><b>Hora:</b> ${hora}</p>`),
      category: "cita-actualizada",
    }),
  cancelacion: (to, fecha, hora) =>
    sendMail({
      to,
      subject: "Cancelación de tu cita médica",
      html: wrap(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${fecha}<br/><b>Hora:</b> ${hora}</p>`),
      category: "cita-cancelada",
    }),
  resetCodigo: (to, code) =>
    sendMail({
      to,
      subject: "Código de verificación - Restablecer contraseña",
      html: wrap(`<h2>Restablecer contraseña</h2><p>Usa este código. <b>Vence en 15 minutos</b>.</p><p style="font-size:22px;letter-spacing:3px;"><b>${code}</b></p>`),
      category: "reset-password",
    }),
};

/* --------- Helpers --------- */
function toYYYYMMDD(v) {
  if (!v) return v;
  const s = String(v);
  if (s.includes("T")) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return s.slice(0, 10);
}
function hhmm(s) {
  const m = String(s || "").match(/^(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : s;
}
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(plain, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return test.toLowerCase() === (hash || "").toLowerCase();
}

/* --------- DB --------- */
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

/* --------- Health --------- */
app.head("/", (req, res) => res.status(200).end());
app.get("/", (req, res) => res.send("API Clínica Salud Total"));
app.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ========================== USUARIOS ========================== */
app.post("/usuario/login", (req, res) => {
  const { usuario_correo, password } = req.body || {};
  const sql = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?";
  db.query(sql, [usuario_correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    const u = r[0];
    if (!verifyPassword(password, u.usuario_contrasena_hash || "")) return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo,
    });
  });
});

app.get("/usuarios", (req, res) => {
  db.query(
    "SELECT id_usuario, usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo FROM usuarios ORDER BY id_usuario ASC",
    (e, rows) => (e ? res.status(500).json({ error: e.message }) : res.json({ listaUsuarios: rows }))
  );
});

app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!/^\d{8}$/.test(usuario_dni || "")) return res.status(400).json({ mensaje: "DNI inválido (8 dígitos)" });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido requeridos" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo || "")) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "Password mínimo 6" });

  const row = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo: 1,
  };
  db.query("INSERT INTO usuarios SET ?", row, (err, r) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (err.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    mailers.bienvenida(usuario_correo, `${usuario_nombre} ${usuario_apellido}`);
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

// Admin: registrar (paciente/médico) con especialidad opcional
app.post("/usuario/registrar", (req, res) => {
  const {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena,
    usuario_tipo,
    id_especialidad,
  } = req.body || {};

  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || typeof usuario_tipo !== "number") {
    return res.status(400).json({ mensaje: "Faltan campos" });
  }

  const row = {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo,
  };

  db.query("INSERT INTO usuarios SET ?", row, (e, r) => {
    if (e) {
      if (e.code === "ER_DUP_ENTRY") {
        if (e.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (e.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    const id_usuario = r.insertId;
    if (usuario_tipo === 2 && id_especialidad) {
      db.query("INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?)", [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar especialidad", id_usuario });
        res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

// Admin: actualizar nombre, apellido, correo. Si pasa id_especialidad y es médico, actualiza en medicos.
app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, id_especialidad } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Faltan campos" });

  const qDup = "SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario<>?";
  db.query(qDup, [usuario_correo, id], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (r.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const qUpd = "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?";
    db.query(qUpd, [usuario_nombre, usuario_apellido, usuario_correo, id], (e2) => {
      if (e2) return res.status(500).json({ mensaje: "Error al actualizar usuario" });

      if (Number(usuario_tipo) === 2 && id_especialidad) {
        db.query("INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?) ON DUPLICATE KEY UPDATE id_especialidad=VALUES(id_especialidad)", [id, id_especialidad], (e3) => {
          if (e3) console.warn(`[${req.rid}] medicos upsert warn:`, e3.message);
          return res.json({ mensaje: "Usuario actualizado correctamente" });
        });
      } else {
        return res.json({ mensaje: "Usuario actualizado correctamente" });
      }
    });
  });
});

app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  db.query("SELECT * FROM usuarios WHERE usuario_correo=?", [correo], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!r.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  });
});

/* ========================== RESET PASSWORD (usa columnas de tu tabla usuarios) ========================== */
function genCode6() { return Math.floor(100000 + Math.random() * 900000).toString(); }

app.post("/usuario/reset/solicitar", (req, res) => {
  const correo = String(req.body?.usuario_correo || req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ mensaje: "Correo inválido" });

  db.query("SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE LOWER(usuario_correo)=?", [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en base de datos" });

    // Respuesta idéntica siempre por privacidad
    const done = () => res.json({ ok: true, mensaje: "Si el correo existe, se envió un código." });

    if (!r.length) return done();

    const code = genCode6();
    const exp = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    console.log(`[${req.rid}] reset -> set code for ${correo}: ${code}`);

    const q = "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE LOWER(usuario_correo)=?";
    db.query(q, [code, exp, correo], async (e2) => {
      if (e2) return res.status(500).json({ ok: false, mensaje: "No se pudo generar el código" });
      await mailers.resetCodigo(correo, code);
      return done();
    });
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  const correo = String(req.body?.usuario_correo || req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.codigo || req.body?.code || "").trim();
  const nueva = String(req.body?.nueva_contrasena || req.body?.new_password || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok: false, mensaje: "Correo inválido" });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok: false, mensaje: "Contraseña mínima 6" });

  const q = "SELECT reset_codigo, reset_expires, reset_used, reset_intentos FROM usuarios WHERE LOWER(usuario_correo)=?";
  db.query(q, [correo], (e, r) => {
    if (e || !r.length) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    const row = r[0];
    if (row.reset_used) return res.status(400).json({ ok: false, mensaje: "Código ya utilizado" });
    if (!row.reset_codigo || row.reset_codigo !== code) return res.status(400).json({ ok: false, mensaje: "Código inválido" });
    if (new Date(row.reset_expires).getTime() < Date.now()) return res.status(400).json({ ok: false, mensaje: "Código vencido" });

    const newHash = hashPassword(nueva);
    db.query("UPDATE usuarios SET usuario_contrasena_hash=?, reset_used=1 WHERE LOWER(usuario_correo)=?", [newHash, correo], (e2, r2) => {
      if (e2 || !r2.affectedRows) return res.status(500).json({ ok: false, mensaje: "No se pudo actualizar" });
      res.json({ ok: true, mensaje: "Contraseña actualizada" });
    });
  });
});

/* ========================== ESPECIALIDADES / MÉDICOS / HORARIOS ========================== */
app.get("/especialidades", (req, res) => {
  db.query("SELECT * FROM especialidades", (e, r) => (e ? res.status(500).json({ error: e.message }) : res.json({ listaEspecialidades: r })));
});

app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  db.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], (e) =>
    e ? res.status(500).json({ error: "Error al guardar especialidad" }) : res.json("Especialidad registrada")
  );
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  db.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id], (e) =>
    e ? res.status(500).json({ error: "Error al actualizar especialidad" }) : res.json({ mensaje: "Especialidad actualizada correctamente" })
  );
});

// Horarios por "YYYY-MM-DD&<id_especialidad>"
app.get("/horarios/:parametro", (req, res) => {
  const [rawFecha, idEsp] = String(req.params.parametro || "").split("&");
  const fecha = toYYYYMMDD(rawFecha);
  const sql = `
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
  db.query(sql, [fecha, idEsp], (e, r) => (e ? res.status(500).json({ error: e.message }) : res.json({ listaHorarios: r })));
});

// Horas libres calculadas
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
  const q = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  db.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map(x => x.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: disponibles });
  });
});

// Horarios registrados (estado 0 = libre)
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  db.query(sql, [id_medico, fecha, id_especialidad], (e, rows) =>
    e ? res.status(500).json({ error: "Error interno del servidor" }) : res.json({ horarios: rows.map(r => r.horario_hora) })
  );
});

// Ocupar / liberar / eliminar
app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const id_medico = req.params.id_medico;
  const fecha = toYYYYMMDD(req.params.fecha);
  const hora = hhmm(req.params.hora);
  const { accion } = req.body || {};

  if (accion === "ocupar") {
    const q = `UPDATE horarios_medicos SET horario_estado=1
               WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d')
                 AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return db.query(q, [id_medico, fecha, hora], (e) => e ? res.status(500).json({ mensaje: "Error al ocupar" }) : res.json({ mensaje: "Horario ocupado" }));
  }
  if (accion === "liberar") {
    const q = `UPDATE horarios_medicos SET horario_estado=0
               WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d')
                 AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return db.query(q, [id_medico, fecha, hora], (e) => e ? res.status(500).json({ mensaje: "Error al liberar" }) : res.json({ mensaje: "Horario liberado" }));
  }
  if (accion === "eliminar") {
    const q = `DELETE FROM horarios_medicos
               WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d')
                 AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
    return db.query(q, [id_medico, fecha, hora], (e) => e ? res.status(500).json({ mensaje: "Error al eliminar" }) : res.json({ mensaje: "Horario eliminado" }));
  }
  res.status(400).json({ mensaje: "Acción inválida" });
});

/* ========================== CITAS ========================== */
app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  cita_hora = hhmm(cita_hora);

  db.query("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

    const qIns = `INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden,cita_estado)
                  VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?, 1)`;
    db.query(qIns, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const qOcupar = `UPDATE horarios_medicos SET horario_estado=1
                       WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      db.query(qOcupar, [id_medico, cita_fecha, cita_hora]);

      db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (!e3 && r3.length) mailers.confirmacion(r3[0].usuario_correo, cita_fecha, cita_hora);
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  cita_hora = hhmm(cita_hora);

  db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, r0) => {
    if (e0 || !r0.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const usuario_correo = r0[0].usuario_correo;

    const qAnt = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico
                  FROM citas WHERE id_cita=?`;
    db.query(qAnt, [id], (e1, r1) => {
      if (e1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const ant = r1[0];

      const qLib = `UPDATE horarios_medicos SET horario_estado=0
                    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      db.query(qLib, [ant.id_medico, ant.cita_fecha, ant.cita_hora]);

      const qUpd = `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'),
                     cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=? WHERE id_cita=?`;
      db.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcupar = `UPDATE horarios_medicos SET horario_estado=1
                         WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
        db.query(qOcupar, [id_medico, cita_fecha, cita_hora]);
        mailers.actualizacion(usuario_correo, cita_fecha, cita_hora);
        res.json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

// Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const q = "SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?";
  db.query(q, [id_cita], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];
    db.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const qLib = `UPDATE horarios_medicos SET horario_estado=0
                    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      db.query(qLib, [id_medico, cita_fecha, cita_hora]);
      db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (!e3 && r3.length) mailers.cancelacion(r3[0].usuario_correo, cita_fecha, cita_hora);
        res.json({ mensaje: "Cita cancelada y horario liberado" });
      });
    });
  });
});

// Anular por usuario + número de orden
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const qFind = `SELECT id_cita, DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico
                 FROM citas WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`;
  db.query(qFind, [id_usuario, numero_orden], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al buscar la cita" });
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { id_cita, cita_fecha, cita_hora, id_medico } = r[0];

    db.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const qLib = `UPDATE horarios_medicos SET horario_estado=0
                    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      db.query(qLib, [id_medico, cita_fecha, cita_hora], () => {
        db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
          if (!e3 && r3.length) mailers.cancelacion(r3[0].usuario_correo, cita_fecha, cita_hora);
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

// Citas de un usuario (numeradas)
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
  db.query(sql, [usuario], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaCitas: r.map((row, i) => ({ ...row, numero_orden: i + 1 })) });
  });
});

// Buscar por usuario + número de orden (formato amigable para Android)
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const sql = `
    SELECT 
      cit.id_cita AS IdCita,
      CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
      DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d') AS FechaCita,
      TIME_FORMAT(cit.cita_hora,'%H:%i') AS HoraCita,
      CASE WHEN cit.cita_estado=1 THEN 'Confirmada' WHEN cit.cita_estado=0 THEN 'Cancelada' ELSE 'Desconocido' END AS EstadoCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario = cit.id_usuario
    INNER JOIN medicos m ON m.id_medico = cit.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_usuario=? AND cit.numero_orden=?`;
  db.query(sql, [id_usuario, numero_orden], (e, r) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(r[0]);
  });
});

app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const sql = `
    SELECT c.id_cita, c.id_usuario,
           us.usuario_nombre AS paciente_nombre, us.usuario_apellido AS paciente_apellido,
           DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre,
           c.cita_estado
    FROM citas c
    INNER JOIN usuarios us ON c.id_usuario = us.id_usuario
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_medico = ?
    ORDER BY c.id_cita ASC`;
  db.query(sql, [id_medico], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaCitas: r.map((x, i) => ({ ...x, numero_orden: i + 1 })) });
  });
});

// KPI citas por día (para admin)
app.get("/citas/por-dia", (req, res) => {
  const q = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  db.query(q, (e, rows) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: rows.map(r => ({ fecha: r.fecha, cantidad: Number(r.cantidad) })) });
  });
});

/* --------- Start --------- */
app.listen(PORT, () => console.log("🚀 Servidor en puerto " + PORT));

/* --------- Exports (tests) --------- */
module.exports = { toYYYYMMDD, verifyPassword };
