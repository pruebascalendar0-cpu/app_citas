// index.js
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const sg = require("@sendgrid/mail");

// --- App / Express ---
const app = express();
const PUERTO = process.env.PORT || 3000;
app.use(express.json());

// --- SendGrid ---
sg.setApiKey(process.env.SENDGRID_API_KEY);
function FROM() { return process.env.EMAIL_FROM || "Clínica Salud Total <pruebascalendar0@gmail.com>"; }
function REPLY_TO() { return process.env.REPLY_TO || "pruebascalendar0@gmail.com"; }
function listUnsubHeaders() {
  const items = [];
  if (process.env.UNSUB_MAILTO) items.push(`<mailto:${process.env.UNSUB_MAILTO}>`);
  if (process.env.UNSUB_URL) items.push(`<${process.env.UNSUB_URL}>`);
  return items.length ? { "List-Unsubscribe": items.join(", ") } : undefined;
}
async function enviarMail({ to, subject, html, text, category = "notificaciones" }) {
  const headers = listUnsubHeaders();
  const msg = {
    from: FROM(),
    to,
    subject,
    html,
    text: text || html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    replyTo: REPLY_TO(),
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false },
    },
    mailSettings: { sandboxMode: { enable: process.env.SENDGRID_SANDBOX === "true" } },
    categories: [category],
    headers,
  };
  try { await sg.send(msg); } catch (err) {
    if (err.response?.body) console.error("❌ SG Error:", JSON.stringify(err.response.body, null, 2));
    else console.error("❌ SG Error:", err);
  }
}
function tplWrapper(innerHtml) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${innerHtml}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático. Si no esperabas este correo, ignóralo.</div>
  </div>`;
}

// --- Helpers de contraseñas y códigos ---
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(plain, stored) {
  const [salt, hash] = stored.includes(":") ? stored.split(":") : ["", stored];
  const test = crypto.createHash("sha256").update((salt || "") + plain).digest("hex");
  return test === hash;
}
function generarPasswordTemporal(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*";
  return Array.from(crypto.randomFillSync(new Uint8Array(len))).map(b => chars[b % chars.length]).join("");
}
function generarCodigo(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomFillSync(new Uint8Array(len))).map(b => chars[b % chars.length]).join("");
}
function toYYYYMMDD(val) {
  if (!val) return val;
  if (typeof val === "string" && val.includes("T")) return val.slice(0, 10);
  return String(val).slice(0, 10);
}

// --- BD ---
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
conexion.connect((error) => {
  if (error) throw error;
  console.log("Conexion exitosa a la base de datos");
  conexion.query("SET time_zone = '-05:00'", () => {}); // evita corrimientos de fecha
});

// “por si acaso” (MySQL 8+)
conexion.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_codigo VARCHAR(16) NULL", () => {});
conexion.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS usuario_contrasena_hash VARCHAR(128) NULL", () => {});

// --- Rutas base ---
app.get("/", (_req, res) => res.send("Bienvenido a mi servicio web"));
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- Correos específicos ---
async function enviarCorreo(destinatario, fecha, hora) {
  await enviarMail({
    to: destinatario, subject: "Confirmación de tu cita médica",
    html: tplWrapper(`<h2 style="margin:0 0 8px 0;">Cita médica confirmada</h2><p>Tu cita ha sido registrada con éxito.</p><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`),
    text: `Cita confirmada. Fecha: ${fecha}. Hora: ${hora}.`, category: "citas-confirmacion",
  });
}
async function enviarCorreoBienvenida(destinatario, nombre) {
  await enviarMail({
    to: destinatario, subject: "Bienvenido a Clínica Salud Total",
    html: tplWrapper(`<h2 style="margin:0 0 8px 0;">¡Bienvenido, ${nombre}!</h2><p>Tu registro en <strong>Clínica Salud Total</strong> fue exitoso.</p><p>Ya puedes ingresar y programar tus citas médicas.</p>`),
    text: `Bienvenido, ${nombre}. Tu registro en Clínica Salud Total fue exitoso.`, category: "bienvenida",
  });
}
async function enviarCorreoRecuperacion(destinatario, nombre, nuevaClaveTemporal) {
  await enviarMail({
    to: destinatario, subject: "Restablecimiento de contraseña – Clínica Salud Total",
    html: tplWrapper(`<h2 style="margin:0 0 8px 0;">Contraseña temporal</h2><p>Hola <strong>${nombre}</strong>, generamos una clave temporal para que puedas ingresar.</p><p><strong>Contraseña temporal:</strong> ${nuevaClaveTemporal}</p><p>Por seguridad, cámbiala apenas inicies sesión.</p>`),
    text: `Contraseña temporal: ${nuevaClaveTemporal}. Cámbiala al iniciar sesión.`, category: "recuperacion",
  });
}
async function enviarCorreoActualizacion(destinatario, fecha, hora) {
  await enviarMail({
    to: destinatario, subject: "Actualización de tu cita médica",
    html: tplWrapper(`<h2 style="margin:0 0 8px 0;">Cita actualizada</h2><p>Hicimos un cambio en tu cita.</p><p><strong>Nueva fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`),
    text: `Cita actualizada. Nueva fecha: ${fecha}. Hora: ${hora}.`, category: "citas-actualizacion",
  });
}
async function enviarCorreoCancelacion(destinatario, fecha, hora) {
  await enviarMail({
    to: destinatario, subject: "Cancelación de tu cita médica",
    html: tplWrapper(`<h2 style="margin:0 0 8px 0;">Cita cancelada</h2><p>Se canceló tu cita.</p><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p><p>Si fue un error, agenda una nueva cita desde la app.</p>`),
    text: `Cita cancelada. Fecha: ${fecha}. Hora: ${hora}.`, category: "citas-cancelacion",
  });
}

// Test correo
app.get("/test-correo", async (_req, res) => {
  try {
    const to = process.env.TEST_TO || (process.env.EMAIL_FROM?.match(/<(.+)>/) || [])[1] || "pruebascalendar0@gmail.com";
    await enviarMail({ to, subject: "Prueba de envío (SendGrid + Render)", html: tplWrapper(`<p>Si ves este correo, todo OK 🎉</p>`), text: "Si ves este correo, todo OK.", category: "test" });
    res.json({ ok: true, to });
  } catch (err) { res.status(500).json({ ok: false, error: String(err) }); }
});

/* ===================== USUARIOS ===================== */

app.post("/usuario/login", (req, res) => {
  const { usuario_correo, password } = req.body || {};
  if (!usuario_correo || !password) return res.status(400).json({ mensaje: "Correo y password requeridos" });
  const sql = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo = ?";
  conexion.query(sql, [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    const u = rows[0];
    const ok = verifyPassword(password, u.usuario_contrasena_hash || "");
    if (!ok) return res.status(401).json({ mensaje: "Contraseña incorrecta" });
    res.json({ id_usuario: u.id_usuario, usuario_nombre: u.usuario_nombre, usuario_apellido: u.usuario_apellido, usuario_correo: u.usuario_correo, usuario_tipo: u.usuario_tipo });
  });
});

app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  const q = "SELECT usuario_correo FROM usuarios WHERE usuario_dni = ? AND usuario_nombre = ? AND usuario_apellido = ?";
  conexion.query(q, [usuario_dni, usuario_nombre, usuario_apellido], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    if (!rows.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: rows[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  const { usuario_correo } = req.body;
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo = ?";
  conexion.query(q, [usuario_correo], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    const { id_usuario, usuario_nombre, usuario_apellido } = rows[0];
    const temp = generarPasswordTemporal(10);
    const hashed = hashPassword(temp);
    conexion.query("UPDATE usuarios SET usuario_contrasena_hash=? WHERE id_usuario=?", [hashed, id_usuario], (e2) => {
      if (e2) return res.status(500).json({ error: "No se pudo actualizar la contraseña" });
      enviarCorreoRecuperacion(usuario_correo, `${usuario_nombre} ${usuario_apellido}`, temp).catch(() => {});
      res.json({ mensaje: "Se envió una contraseña temporal a tu correo" });
    });
  });
});

app.post("/usuario/agregar", (req, res) => {
  const u = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena: req.body.usuario_contrasena,
  };
  if (!u.usuario_dni || !/^\d{8}$/.test(u.usuario_dni)) return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  if (!u.usuario_nombre || !u.usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!u.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.usuario_correo)) return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  if (!u.usuario_contrasena || u.usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const row = {
    usuario_dni: u.usuario_dni,
    usuario_nombre: u.usuario_nombre,
    usuario_apellido: u.usuario_apellido,
    usuario_correo: u.usuario_correo,
    usuario_contrasena_hash: hashPassword(u.usuario_contrasena),
    usuario_tipo: 1,
  };
  conexion.query("INSERT INTO usuarios SET ?", row, (error) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados" });
      }
      if (error.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ mensaje: "Columna inválida en BD (verificar usuario_contrasena_hash)." });
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }
    enviarCorreoBienvenida(row.usuario_correo, `${row.usuario_nombre} ${row.usuario_apellido}`).catch(() => {});
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.post("/usuario/registrar", (req, res) => {
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad } = req.body;
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined)
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const nuevo = {
    usuario_nombre, usuario_apellido, usuario_correo, usuario_dni,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo,
  };
  conexion.query("INSERT INTO usuarios SET ?", nuevo, (error, r) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    const id_usuario = r.insertId;
    if (usuario_tipo === 2 && id_especialidad) {
      conexion.query("INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)", [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
        res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  const consulta = "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [correo], (error, rows) => {
    if (error) return res.status(500).send(error.message);
    if (rows.length > 0) res.json(rows[0]);
    else res.status(404).send({ mensaje: "no hay registros" });
  });
});

/* ===================== MÉDICOS / ESPECIALIDADES / HORARIOS ===================== */

app.get("/especialidades", (_req, res) => {
  conexion.query("SELECT * FROM especialidades", (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(rpta.length ? { listaEspecialidades: rpta } : { mensaje: "no hay registros" });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  conexion.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], (err) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  conexion.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

app.get("/horarios/:parametro", (req, res) => {
  const [fecha, especialidad] = req.params.parametro.split("&");
  const consulta = `
  SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') as horario_horas, 
         u.usuario_nombre as medico_nombre, u.usuario_apellido as medico_apellido,
         e.especialidad_nombre
  FROM horarios_medicos h
  INNER JOIN medicos m ON h.id_medico = m.id_medico
  INNER JOIN usuarios u ON m.id_medico = u.id_usuario
  INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
  WHERE h.horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND h.id_especialidad = ? AND h.horario_estado = 0
  ORDER BY h.horario_hora ASC`;
  conexion.query(consulta, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
  });
});

app.post("/horario/registrar", (req, res) => {
  let { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;
  horario_fecha = toYYYYMMDD(horario_fecha);
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) return res.status(400).json({ error: "Faltan datos obligatorios" });
  const consulta = `
    INSERT INTO horarios_medicos (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, STR_TO_DATE(?, '%H:%i'), STR_TO_DATE(?, '%Y-%m-%d'), 0, ?)
  `;
  conexion.query(consulta, [id_medico, horario_horas, horario_fecha, id_especialidad], (error, r) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r.insertId });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;
  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });

  const qOld = "SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario = ?";
  conexion.query(qOld, [id_horario], (err1, r1) => {
    if (err1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    const anterior = r1[0];
    conexion.query("UPDATE horarios_medicos SET horario_estado = 0 WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?", [anterior.horario_fecha, anterior.horario_hora, id_medico], () => {});
    const actualizar = "UPDATE horarios_medicos SET horario_fecha=STR_TO_DATE(?, '%Y-%m-%d'), horario_hora=STR_TO_DATE(?, '%H:%i'), horario_estado=1, id_especialidad=? WHERE id_horario=?";
    conexion.query(actualizar, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (err3) => {
      if (err3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      res.json({ mensaje: "Horario actualizado correctamente" });
    });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  const consulta = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?`;
  conexion.query(consulta, [id_medico], (err, rpta) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: rpta });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const q = `SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  conexion.query(q, [id_medico, fecha, id_especialidad], (error, rows) => {
    if (error) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = rows.map(r => r.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: disponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const sql = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS horario_hora
    FROM horarios_medicos 
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, results) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    res.json({ horarios: results.map(r => r.horario_hora) });
  });
});

/* ===================== CITAS ===================== */

app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;
  cita_fecha = toYYYYMMDD(cita_fecha);

  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(qOrden, [id_usuario], (error, r0) => {
    if (error) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = r0[0].total + 1;

    const qInsert = `
      INSERT INTO citas (id_usuario, id_medico, cita_fecha, cita_hora, numero_orden)
      VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?)
    `;
    conexion.query(qInsert, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const ocupar = `
        UPDATE horarios_medicos SET horario_estado=1 
        WHERE horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i') AND id_medico=?`;
      conexion.query(ocupar, [cita_fecha, cita_hora, id_medico], (e3, r3) => {
        if (e3) console.warn("No se pudo marcar el horario ocupado:", e3.message);
        if (!r3 || r3.affectedRows === 0) console.warn("⚠️ Slot no encontrado para ocupar.");
      });

      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e4, r4) => {
        if (e4 || !r4.length) return res.status(404).json({ error: "Usuario no encontrado" });
        enviarCorreo(r4[0].usuario_correo, cita_fecha, cita_hora).catch(() => {});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;
  cita_fecha = toYYYYMMDD(cita_fecha);
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, rows) => {
    if (e0 || !rows.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const usuario_correo = rows[0].usuario_correo;

    const qAnterior = `
      SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora, '%H:%i') AS cita_hora
      FROM citas WHERE id_cita = ?`;
    conexion.query(qAnterior, [id], (e1, r1) => {
      if (e1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const anterior = r1[0];

      const qLiberar = `
        UPDATE horarios_medicos SET horario_estado = 0
        WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?`;
      conexion.query(qLiberar, [anterior.cita_fecha, anterior.cita_hora, id_medico], () => {});

      const qUpdate = `
        UPDATE citas 
        SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'),
            cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=?
        WHERE id_cita=?`;
      conexion.query(qUpdate, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcupar = `
          UPDATE horarios_medicos SET horario_estado = 1
          WHERE horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora = STR_TO_DATE(?, '%H:%i') AND id_medico = ?`;
        conexion.query(qOcupar, [cita_fecha, cita_hora, id_medico], () => {});
        enviarCorreoActualizacion(usuario_correo, cita_fecha, cita_hora).catch(() => {});
        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const qDatos = "SELECT cita_fecha, cita_hora, id_medico FROM citas WHERE id_cita = ?";
  conexion.query(qDatos, [id_cita], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [cita_fecha, cita_hora, id_medico], (e3) => {
        if (e3) return res.status(500).json({ error: "Error al liberar el horario" });
        res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const q = "SELECT id_cita, cita_fecha, cita_hora, id_medico FROM citas WHERE id_usuario=? AND numero_orden=? AND cita_estado=1";
  conexion.query(q, [id_usuario, numero_orden], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al buscar la cita" });
    if (!r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [cita_fecha, cita_hora, id_medico], (e3) => {
        if (e3) return res.status(500).json({ error: "Error al liberar el horario" });
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e4, r4) => {
          if (!e4 && r4.length) enviarCorreoCancelacion(r4[0].usuario_correo, cita_fecha, cita_hora).catch(() => {});
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

app.get("/citas/por-dia", (_req, res) => {
  const consulta = `
    SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY DATE(cita_fecha)
    ORDER BY DATE(cita_fecha) ASC`;
  conexion.query(consulta, (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: resultados.map(r => ({ fecha: r.fecha, cantidad: r.cantidad })) });
  });
});

app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  const consulta = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(DATE(c.cita_fecha), '%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre,
           u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre,
           c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_usuario = ?
    ORDER BY c.id_cita ASC`;
  conexion.query(consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaCitas: rpta.map((c, i) => ({ ...c, numero_orden: i + 1 })) });
  });
});

app.get("/citamedica/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const consulta = `
    SELECT cit.id_cita AS IdCita,
           CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
           esp.especialidad_nombre AS Especialidad,
           CONCAT(med.usuario_nombre, ' ', med.usuario_apellido) AS Medico,
           DATE(cit.cita_fecha) AS FechaCita,
           cit.cita_hora AS HoraCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario = cit.id_usuario
    INNER JOIN medicos m ON cit.id_medico = m.id_medico
    INNER JOIN usuarios med ON m.id_medico = med.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_cita = ?`;
  conexion.query(consulta, [id_cita], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (!results.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const consulta = `
    SELECT 
      cit.id_cita AS IdCita,
      CONCAT(us.usuario_nombre, ' ', us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre, ' ', mu.usuario_apellido) AS Medico,
      DATE(cit.cita_fecha) AS FechaCita,
      cit.cita_hora AS HoraCita,
      CASE 
          WHEN cit.cita_estado = 1 THEN 'Confirmada'
          WHEN cit.cita_estado = 0 THEN 'Cancelada'
          ELSE 'Desconocido'
      END AS EstadoCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario = cit.id_usuario
    INNER JOIN medicos m ON m.id_medico = cit.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_usuario = ? AND cit.numero_orden = ?`;
  conexion.query(consulta, [id_usuario, numero_orden], (err, results) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (!results.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(results[0]);
  });
});

app.get("/citas", (_req, res) => {
  const consulta = `
    SELECT 
      ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha, c.cita_hora) AS numero_cita,
      c.id_cita,
      u.usuario_nombre AS paciente_nombre,
      u.usuario_apellido AS paciente_apellido,
      DATE_FORMAT(DATE(c.cita_fecha), '%d/%m/%Y') AS cita_fecha,
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
    ORDER BY u.usuario_nombre ASC, numero_cita ASC`;
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error al obtener las citas" });
    res.json({ listaCitas: rpta.length ? rpta : [] });
  });
});

app.get("/medicos", (_req, res) => {
  conexion.query("SELECT * FROM medicos", (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json(rpta.length ? { listaCitas: rpta } : { mensaje: "no hay registros" });
  });
});

/* ===================== EXPORTS OPCIONALES ===================== */
module.exports = {
  enviarCorreo,
  enviarCorreoBienvenida,
  enviarCorreoRecuperacion,
  enviarCorreoActualizacion,
  enviarCorreoCancelacion,
  hashPassword,
  verifyPassword,
};

/* ===================== START SERVER ===================== */
app.listen(PUERTO, () => {
  console.log("Servidor corriendo en el puerto " + PUERTO);
});
