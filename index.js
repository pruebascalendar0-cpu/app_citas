// index.js
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(bodyParser.json());
app.use((req, _res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  next();
});

// ---------- DB ----------
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

conexion.connect((error) => {
  if (error) {
    console.error("[DB] ERROR al conectar:", error.message);
    process.exit(1);
  }
  console.log("[DB] Conexión exitosa");
  conexion.query("SET time_zone = '-05:00'");
});

// ---------- Helpers de password ----------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  return `${salt}:${hash}`; // 97 chars
}
function verifyPassword(stored, plain) {
  if (!stored || !plain) return false;
  const [saltHex, hashHex] = String(stored).split(":");
  const computed = crypto.createHash("sha256").update(saltHex + String(plain)).digest("hex");
  const a = Buffer.from(hashHex, "hex");
  const b = Buffer.from(computed, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Mail ----------
let mailProvider = process.env.MAIL_PROVIDER || (process.env.SENDGRID_API_KEY ? "sendgrid" : "gmail");
let sgMail = null, nodemailer = null, transporter = null;

if (mailProvider === "sendgrid" && process.env.SENDGRID_API_KEY) {
  try { sgMail = require("@sendgrid/mail"); sgMail.setApiKey(process.env.SENDGRID_API_KEY); }
  catch { mailProvider = "gmail"; }
}
if (mailProvider === "gmail") {
  nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD }
  });
}
const FROM_NAME = "Clínica Salud Total";
const FROM_EMAIL = process.env.EMAIL_USER || "no-reply@clinicasalud.com";

async function enviar({ rid, to, subject, html, category }) {
  try {
    if (mailProvider === "sendgrid" && sgMail) {
      const [resp] = await sgMail.send({
        to, from: { name: FROM_NAME, email: FROM_EMAIL }, subject, html,
        mailSettings: { sandboxMode: { enable: false } },
        categories: category ? [category] : undefined
      });
      console.log(`[MAIL ${rid}] SendGrid OK: ${resp.statusCode} -> ${to} "${subject}"`);
      return true;
    }
    const info = await transporter.sendMail({ from: `"${FROM_NAME}" <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[MAIL ${rid}] SMTP OK: ${info.response} -> ${to} "${subject}"`);
    return true;
  } catch (e) { console.error(`[MAIL ${rid}] ERROR:`, e.message); return false; }
}

// ---------- Templates correo ----------
const tplConfirmacion = ({ fecha, hora }) => `
  <h2 style="color:#2e86de;">¡Cita médica confirmada!</h2>
  <p>Tu cita ha sido registrada con éxito.</p>
  <p><strong>Fecha:</strong> ${fecha}</p><p><strong>Hora:</strong> ${hora}</p>
  <hr><small>Clínica Salud Total – Sistema de Citas</small>`;
const tplActualizacion = ({ fecha, hora }) => `
  <h2 style="color:#f39c12;">¡Cita médica actualizada!</h2>
  <p>Tu cita ha sido <strong>actualizada</strong> con éxito.</p>
  <p><strong>Nueva Fecha:</strong> ${fecha}</p><p><strong>Hora:</strong> ${hora}</p>
  <hr><small>Clínica Salud Total – Sistema de Citas</small>`;
const tplCancelacion = ({ fecha, hora }) => `
  <h2 style="color:#c0392b;">Cita cancelada</h2>
  <p>Tu cita médica ha sido <strong>cancelada</strong> correctamente.</p>
  <p><strong>Fecha:</strong> ${fecha}</p><p><strong>Hora:</strong> ${hora}</p>
  <hr><small>Clínica Salud Total – Sistema de Citas</small>`;

// ---------- Rutas base ----------
app.get("/", (_req, res) => res.send("Bienvenido"));

// ===== Usuarios =====
app.get("/usuarios", (_req, res) => {
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo FROM usuarios";
  conexion.query(q, (err, r) => err ? res.status(500).json({ mensaje: "Error al listar usuarios" }) : res.json({ listaUsuarios: r || [] }));
});

// GET /usuario/{correo}
app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  conexion.query("SELECT * FROM usuarios WHERE usuario_correo=?", [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: e.message });
    if (!r || !r[0]) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  });
});

// POST /usuario/agregar  (registro simple Paciente por tu APK antiguo)
app.post("/usuario/agregar", (req, res) => {
  const rid = req.rid;
  const u = req.body || {};
  if (!u.usuario_dni || !/^\d{8}$/.test(u.usuario_dni)) return res.status(400).json({ mensaje: "DNI 8 dígitos" });
  if (!u.usuario_nombre || !u.usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios" });
  if (!u.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.usuario_correo)) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!u.usuario_contrasena || String(u.usuario_contrasena).length < 6) return res.status(400).json({ mensaje: "Contraseña >= 6" });

  const nuevo = {
    usuario_nombre: u.usuario_nombre,
    usuario_apellido: u.usuario_apellido,
    usuario_correo: u.usuario_correo,
    usuario_dni: u.usuario_dni,
    usuario_contrasena_hash: hashPassword(u.usuario_contrasena),
    usuario_tipo: 1 // Paciente
  };

  conexion.query("INSERT INTO usuarios SET ?", nuevo, async (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        const msg = err.sqlMessage.includes("usuario_dni") ? "DNI ya está registrado" :
                    err.sqlMessage.includes("usuario_correo") ? "El correo ya está registrado." :
                    "Datos duplicados en campos únicos.";
        return res.status(400).json({ mensaje: msg });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    // Bienvenida
    await enviar({
      rid,
      to: u.usuario_correo,
      subject: "Bienvenido a Clínica Salud Total",
      html: `<h2 style="color:#2e86de;">¡Bienvenido, ${u.usuario_nombre} ${u.usuario_apellido}!</h2>
             <p>Tu registro fue exitoso. Ya puedes agendar tus citas.</p>
             <hr><small>Clínica Salud Total</small>`
    });
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

// POST /usuario/registrar  (permite médicos con especialidad)
app.post("/usuario/registrar", (req, res) => {
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || typeof usuario_tipo === "undefined")
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const usuario = {
    usuario_nombre, usuario_apellido, usuario_correo, usuario_dni,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo
  };

  conexion.query("INSERT INTO usuarios SET ?", usuario, (error, result) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        const msg = error.sqlMessage.includes("usuario_dni") ? "DNI ya está registrado" :
                    error.sqlMessage.includes("usuario_correo") ? "El correo ya está registrado." :
                    "Datos duplicados en campos únicos.";
        return res.status(400).json({ mensaje: msg });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    const id_usuario = result.insertId;
    if (usuario_tipo === 2 && id_especialidad) {
      conexion.query("INSERT INTO medicos(id_medico,id_especialidad) VALUES(?,?)", [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
        res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

// PUT /usuario/actualizar/{id}
app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  conexion.query("SELECT 1 FROM usuarios WHERE usuario_correo=? AND id_usuario != ?", [usuario_correo, id], (e1, r1) => {
    if (e1) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (r1.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    conexion.query(
      "UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?",
      [usuario_nombre, usuario_apellido, usuario_correo, id],
      (e2) => e2 ? res.status(500).json({ mensaje: "Error al actualizar usuario" }) : res.json({ mensaje: "Usuario actualizado correctamente" })
    );
  });
});

// Recuperar correo por DNI+nombre+apellido
app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  const q = "SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?";
  conexion.query(q, [usuario_dni, usuario_nombre, usuario_apellido], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno del servidor" });
    if (!r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: r[0].usuario_correo });
  });
});

// ===== Flujo cambio de contraseña con CÓDIGO =====

// 1) Iniciar: APK llama /usuario/recuperar-contrasena (compat), se envía código
app.post("/usuario/recuperar-contrasena", (req, res) => {
  const rid = req.rid;
  const correo = (req.body && (req.body.usuario_correo || req.body.correo)) || "";
  if (!correo) return res.status(400).json({ mensaje: "Correo requerido" });

  const qSel = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(qSel, [correo], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno del servidor" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    const expira = new Date(Date.now() + 15 * 60 * 1000);

    conexion.query(
      "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE usuario_correo=?",
      [codigo, expira, correo],
      async (e2) => {
        if (e2) return res.status(500).json({ mensaje: "No se pudo iniciar recuperación" });
        const nombre = `${r[0].usuario_nombre} ${r[0].usuario_apellido}`;
        await enviar({
          rid,
          to: correo,
          subject: "Tu código de verificación",
          html: `<h2 style="color:#2e86de;">Código de verificación</h2>
                 <p>Hola <strong>${nombre}</strong>, tu código para cambiar la contraseña es:</p>
                 <p style="font-size:22px;letter-spacing:2px"><strong>${codigo}</strong></p>
                 <p>Vence en <strong>15 minutos</strong>.</p>
                 <hr><small>Clínica Salud Total – Seguridad</small>`,
          category: "password-reset"
        });
        res.json({ mensaje: "Código enviado" });
      }
    );
  });
});

// 2) Confirmar código y actualizar contraseña
// body: { correo, codigo, nuevo_password }
app.post("/auth/recuperar/confirmar", (req, res) => {
  const { correo, codigo, nuevo_password } = req.body || {};
  if (!correo || !codigo || !nuevo_password) return res.status(400).json({ mensaje: "Datos incompletos" });
  if (String(nuevo_password).length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres" });

  const qSel = "SELECT id_usuario, reset_codigo, reset_expires, reset_used, reset_intentos FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(qSel, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error de BD" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0], now = new Date();
    if (u.reset_intentos >= 5) return res.status(429).json({ mensaje: "Demasiados intentos, solicita un nuevo código" });
    if (u.reset_used) return res.status(400).json({ mensaje: "Código ya utilizado, solicita uno nuevo" });
    if (!u.reset_codigo || codigo !== u.reset_codigo) {
      conexion.query("UPDATE usuarios SET reset_intentos=LEAST(reset_intentos+1,10) WHERE usuario_correo=?", [correo]);
      return res.status(401).json({ mensaje: "Código inválido" });
    }
    if (!u.reset_expires || now > u.reset_expires) return res.status(400).json({ mensaje: "Código vencido" });

    conexion.query(
      "UPDATE usuarios SET usuario_contrasena_hash=?, reset_used=1 WHERE id_usuario=?",
      [hashPassword(nuevo_password), u.id_usuario],
      (e2) => e2 ? res.status(500).json({ mensaje: "No se pudo actualizar contraseña" }) : res.json({ mensaje: "Contraseña actualizada" })
    );
  });
});

// ===== Especialidades =====
app.get("/especialidades", (_req, res) => {
  conexion.query("SELECT * FROM especialidades", (e, r) => e ? res.status(500).json({ mensaje: "Error al obtener especialidades" }) : res.json({ listaEspecialidades: r || [] }));
});
app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  conexion.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], (e) =>
    e ? res.status(500).json({ error: "Error al guardar especialidad" }) : res.status(201).json("Especialidad registrada")
  );
});
app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params, { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  conexion.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id], (e) =>
    e ? res.status(500).json({ error: "Error al actualizar especialidad" }) : res.json({ mensaje: "Especialidad actualizada correctamente" })
  );
});

// ===== Médicos & Horarios =====
app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  const q = `SELECT e.id_especialidad, e.especialidad_nombre
             FROM medicos m INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
             WHERE m.id_medico=?`;
  conexion.query(q, [id_medico], (e, r) => e ? res.status(500).json({ error: "Error al obtener especialidades" }) : res.json({ listaEspecialidades: r }));
});

app.get("/horarios/:parametro", (req, res) => {
  const [fecha, especialidad] = String(req.params.parametro || "").split("&");
  const q = `
    SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') as horario_horas,
           u.usuario_nombre as medico_nombre, u.usuario_apellido as medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico=m.id_medico
    INNER JOIN usuarios u ON m.id_medico=u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad=e.id_especialidad
    WHERE h.horario_fecha=? AND h.id_especialidad=? AND h.horario_estado=0
    ORDER BY h.horario_hora ASC`;
  conexion.query(q, [fecha, especialidad], (e, r) => e ? res.status(500).json({ error: e.message }) : res.json({ listaHorarios: r }));
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
  const q = `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora FROM horarios_medicos
             WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`;
  conexion.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map((x) => x.hora);
    const libres = todas.filter((h) => !ocupadas.includes(h));
    res.json({ horariosDisponibles: libres });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const q = `SELECT horario_hora FROM horarios_medicos
             WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
             ORDER BY horario_hora ASC`;
  conexion.query(q, [id_medico, fecha, id_especialidad], (e, r) =>
    e ? res.status(500).json({ error: "Error interno del servidor" }) : res.json({ horarios: r.map((x) => x.horario_hora) })
  );
});

app.post("/horario/registrar", (req, res) => {
  const rid = req.rid;
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body || {};
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) return res.status(400).json({ error: "Faltan datos obligatorios" });

  const q = `INSERT INTO horarios_medicos (id_medico,horario_hora,horario_fecha,horario_estado,id_especialidad)
             VALUES(?,?,?,?,0)`;
  conexion.query(q, [id_medico, horario_horas, horario_fecha, 0, id_especialidad], (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      console.error(`[HORARIO ${rid}] ERROR registrar:`, err.message);
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: result.insertId });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  const rid = req.rid;
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body || {};
  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });

  const qAnt = "SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario=?";
  conexion.query(qAnt, [id_horario], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(500).json({ mensaje: "Error al obtener el horario original" });

    const qLib = "UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?";
    conexion.query(qLib, [r1[0].horario_fecha, r1[0].horario_hora, id_medico], () => {
      const qUpd = "UPDATE horarios_medicos SET horario_fecha=?, horario_hora=?, horario_estado=1, id_especialidad=? WHERE id_horario=?";
      conexion.query(qUpd, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (e3) =>
        e3 ? res.status(500).json({ mensaje: "Error al actualizar el horario" }) : res.json({ mensaje: "Horario actualizado correctamente" })
      );
    });
  });
});

app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const rid = req.rid;
  const { id_medico, fecha, hora } = req.params;
  const { accion, nuevaHora, id_especialidad } = req.body || {};
  if (!accion) return res.status(400).json({ mensaje: "Acción requerida" });

  if (accion === "eliminar") {
    const q = `DELETE FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND horario_hora=? ${id_especialidad ? "AND id_especialidad=?" : ""}`;
    const params = id_especialidad ? [id_medico, fecha, hora, id_especialidad] : [id_medico, fecha, hora];
    conexion.query(q, params, (e, r) => e ? res.status(500).json({ mensaje: "Error al eliminar horario" }) : res.json({ mensaje: "Horario eliminado correctamente" }));
  } else if (accion === "actualizar") {
    if (!nuevaHora || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos" });
    const q = `UPDATE horarios_medicos SET horario_hora=?, horario_estado=0 WHERE id_medico=? AND horario_fecha=? AND horario_hora=? AND id_especialidad=?`;
    conexion.query(q, [nuevaHora, id_medico, fecha, hora, id_especialidad], (e, r) =>
      e ? res.status(500).json({ mensaje: "Error al actualizar horario" }) : res.json({ mensaje: "Horario actualizado correctamente" })
    );
  } else if (accion === "ocupar") {
    conexion.query("UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=? AND horario_hora=?", [id_medico, fecha, hora], (e) =>
      e ? res.status(500).json({ mensaje: "Error al ocupar horario" }) : res.json({ mensaje: "Horario marcado como ocupado" })
    );
  } else {
    res.status(400).json({ mensaje: "Acción no reconocida" });
  }
});

// ===== Citas =====
app.post("/cita/agregar", (req, res) => {
  const rid = req.rid;
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ error: "Datos incompletos para registrar la cita" });

  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?";
  conexion.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular el número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;
    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };

    conexion.query("INSERT INTO citas SET ?", cita, (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      conexion.query("UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [cita_fecha, cita_hora, id_medico], () => {});
      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (e4, r4) => {
        if (!e4 && r4 && r4[0]) await enviar({ rid, to: r4[0].usuario_correo, subject: "Confirmación de tu cita médica", html: tplConfirmacion({ fecha: cita_fecha, hora: cita_hora }), category: "citas-confirmacion" });
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const rid = req.rid, { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  conexion.query("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?", [id], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    const ant = r1[0];

    conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [ant.cita_fecha, ant.cita_hora, id_medico], () => {
      const qUpd = "UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=? WHERE id_cita=?";
      conexion.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        conexion.query("UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [cita_fecha, cita_hora, id_medico], () => {});
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (e5, r5) => {
          if (!e5 && r5 && r5[0]) await enviar({ rid, to: r5[0].usuario_correo, subject: "Actualización de tu cita médica", html: tplActualizacion({ fecha: cita_fecha, hora: cita_hora }), category: "citas-actualizacion" });
          res.json({ mensaje: "Cita actualizada correctamente" });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const rid = req.rid, { id_cita } = req.params;
  const qDatos = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?";
  conexion.query(qDatos, [id_cita], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];

    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [cita_fecha, cita_hora, id_medico], async (e3) => {
        if (e3) console.warn(`[HORARIO ${rid}] liberar error:`, e3.message);
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) await enviar({ rid, to: r4[0].usuario_correo, subject: "Cancelación de tu cita médica", html: tplCancelacion({ fecha: cita_fecha, hora: cita_hora }), category: "citas-cancelacion" });
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const rid = req.rid, { id_usuario, numero_orden } = req.params;
  const q = "SELECT id_cita, cita_fecha, cita_hora, id_medico FROM citas WHERE id_usuario=? AND numero_orden=? AND cita_estado=1";
  conexion.query(q, [id_usuario, numero_orden], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { id_cita, cita_fecha, cita_hora, id_medico } = r1[0];

    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?", [cita_fecha, cita_hora, id_medico], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) await enviar({ rid, to: r4[0].usuario_correo, subject: "Cancelación de tu cita médica", html: tplCancelacion({ fecha: cita_fecha, hora: cita_hora }), category: "citas-cancelacion" });
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  const q = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico=m.id_medico
    INNER JOIN usuarios u ON m.id_medico=u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
    WHERE c.id_usuario=?
    ORDER BY c.id_cita ASC`;
  conexion.query(q, [usuario], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    const lista = (r || []).map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas: lista });
  });
});

app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const q = `
    SELECT cit.id_cita AS IdCita,
           CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
           esp.especialidad_nombre AS Especialidad,
           CONCAT(mu.usuario_nombre,' ',mu.usuario_apellido) AS Medico,
           cit.cita_fecha AS FechaCita, cit.cita_hora AS HoraCita,
           CASE WHEN cit.cita_estado=1 THEN 'Confirmada' WHEN cit.cita_estado=0 THEN 'Cancelada' ELSE 'Desconocido' END AS EstadoCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario=cit.id_usuario
    INNER JOIN medicos m ON m.id_medico=cit.id_medico
    INNER JOIN usuarios mu ON m.id_medico=mu.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
    WHERE cit.id_usuario=? AND cit.numero_orden=?`;
  conexion.query(q, [id_usuario, numero_orden], (e, r) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    if (!r.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(r[0]);
  });
});

app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const q = `
    SELECT c.id_cita, c.id_usuario,
           us.usuario_nombre AS paciente_nombre, us.usuario_apellido AS paciente_apellido,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN usuarios us ON c.id_usuario=us.id_usuario
    INNER JOIN medicos m ON c.id_medico=m.id_medico
    INNER JOIN usuarios u ON m.id_medico=u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
    WHERE c.id_medico=?
    ORDER BY c.id_cita ASC`;
  conexion.query(q, [id_medico], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaCitas: (r || []).map((c, i) => ({ ...c, numero_orden: i + 1 })) });
  });
});

app.get("/citas/por-dia", (_req, res) => {
  const q = `
    SELECT cita_fecha AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY cita_fecha ORDER BY cita_fecha ASC`;
  conexion.query(q, (e, r) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    const datos = (r || []).map((x) => ({ fecha: x.fecha.toISOString().slice(0, 10), cantidad: x.cantidad }));
    res.json({ listaCitas: datos });
  });
});

app.put("/cita/estado/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body || {};
  conexion.query("UPDATE citas SET cita_estado=? WHERE id_cita=?", [nuevo_estado, id_cita], (e) =>
    e ? res.status(500).json({ mensaje: "Error al actualizar estado" }) : res.json({ mensaje: "Estado actualizado correctamente" })
  );
});

// ---------- Servidor ----------
app.listen(PORT, () => {
  console.log("Servidor corriendo en el puerto " + PORT);
});
