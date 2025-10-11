// index.js
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// --- Email providers (Gmail por defecto, SendGrid opcional) ---
let mailProvider = process.env.MAIL_PROVIDER || "gmail";
let sgMail = null;
let nodemailer = null;
let transporter = null;

if (mailProvider === "sendgrid" && process.env.SENDGRID_API_KEY) {
  try {
    sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  } catch {
    console.warn("[MAIL] @sendgrid/mail no instalado. Uso Gmail SMTP.");
    mailProvider = "gmail";
  }
}
if (mailProvider === "gmail") {
  nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
  });
}

const FROM_NAME = "Clínica Salud Total";
const FROM_EMAIL = process.env.EMAIL_USER || "no-reply@clinicasalud.com";

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
  password: process.env.DB_PASSWORD,
});

conexion.connect((error) => {
  if (error) {
    console.error("[DB] ERROR al conectar:", error.message);
    process.exit(1);
  }
  console.log("[DB] Conexión exitosa");
  conexion.query("SET time_zone = '-05:00'");
});

// ---------- Utils ----------
function hashSHA256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function hashPasswordSalted(password, storedSaltAndHash) {
  // stored format: salt:hash
  let salt = null;
  if (storedSaltAndHash && storedSaltAndHash.includes(":")) {
    salt = storedSaltAndHash.split(":")[0];
  }
  if (!salt) return null;
  const calc = hashSHA256Hex(Buffer.from(salt + password, "utf8"));
  return `${salt}:${calc}`;
}
function makeSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function makeResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
}

async function enviarCorreo({ rid, to, subject, html, category }) {
  try {
    if (mailProvider === "sendgrid" && sgMail) {
      const [resp] = await sgMail.send({
        to,
        from: { name: FROM_NAME, email: FROM_EMAIL },
        subject,
        html,
        categories: category ? [category] : undefined,
      });
      console.log(`[MAIL ${rid}] SendGrid OK: ${resp.statusCode} → ${to} "${subject}"`);
      return true;
    } else {
      const info = await transporter.sendMail({
        from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
        to,
        subject,
        html,
      });
      console.log(`[MAIL ${rid}] SMTP OK: ${info.response} → ${to} "${subject}"`);
      return true;
    }
  } catch (e) {
    console.error(`[MAIL ${rid}] ERROR:`, e?.message || e);
    return false;
  }
}

// ---- Plantillas de correo ----
const tplConfirmacion = ({ fecha, hora }) => `
  <h2 style="color:#2e86de;">¡Cita médica confirmada!</h2>
  <p>Tu cita ha sido registrada con éxito.</p>
  <p><strong>Fecha:</strong> ${fecha}</p>
  <p><strong>Hora:</strong> ${hora}</p>
  <hr><small>Clínica Salud Total – Sistema de Citas</small>
`;
const tplActualizacion = ({ fecha, hora }) => `
  <h2 style="color:#f39c12;">¡Cita médica actualizada!</h2>
  <p>Tu cita ha sido <strong>actualizada</strong> con éxito.</p>
  <p><strong>Nueva Fecha:</strong> ${fecha}</p>
  <p><strong>Hora:</strong> ${hora}</p>
  <hr><small>Clínica Salud Total – Sistema de Citas</small>
`;
const tplCancelacion = ({ fecha, hora }) => `
  <h2 style="color:#c0392b;">Cita cancelada</h2>
  <p>Tu cita médica ha sido <strong>cancelada</strong> correctamente.</p>
  <p><strong>Fecha:</strong> ${fecha}</p>
  <p><strong>Hora:</strong> ${hora}</p>
  <hr><small>Clínica Salud Total – Sistema de Citas</small>
`;
const tplResetCodigo = ({ nombre, codigo }) => `
  <h2 style="color:#2e86de;">Código para cambiar tu contraseña</h2>
  <p>Hola <strong>${nombre}</strong>, usa este código para cambiar tu contraseña:</p>
  <p style="font-size: 22px;"><strong>${codigo}</strong></p>
  <p>Vence en 10 minutos.</p>
  <hr><small>Clínica Salud Total – Seguridad</small>
`;
const tplCambioOk = ({ nombre }) => `
  <h2 style="color:#2e86de;">Contraseña actualizada</h2>
  <p>Hola <strong>${nombre}</strong>, tu contraseña fue actualizada correctamente.</p>
  <hr><small>Clínica Salud Total – Seguridad</small>
`;

// ---------- RUTAS BÁSICAS ----------
app.get("/", (_req, res) => res.send("Servicio de Citas - OK"));

// =========================
//          USUARIOS
// =========================
app.get("/usuarios", (_req, res) => {
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo FROM usuarios";
  conexion.query(q, (err, rpta) => {
    if (err) return res.status(500).json({ mensaje: "Error al listar usuarios" });
    res.json({ listaUsuarios: rpta || [] });
  });
});

// Alta rápida (legacy) — usado por el APK
app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!usuario_dni || !/^\d{8}$/.test(usuario_dni))
    return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  if (!usuario_nombre || !usuario_apellido)
    return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo))
    return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  if (!usuario_contrasena || usuario_contrasena.length < 6)
    return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  // Guardar con sal+hash en usuario_contrasena_hash
  const salt = makeSalt();
  const hash = hashSHA256Hex(Buffer.from(salt + usuario_contrasena, "utf8"));
  const usuario = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: `${salt}:${hash}`,
    usuario_tipo: 1, // Paciente
  };

  conexion.query("INSERT INTO usuarios SET ?", usuario, (error) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

// Alta con especialidad (usado por /usuario/registrar del APK)
app.post("/usuario/registrar", (req, res) => {
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || usuario_tipo === undefined) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const salt = makeSalt();
  const hash = hashSHA256Hex(Buffer.from(salt + usuario_contrasena, "utf8"));
  const nuevoUsuario = {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena_hash: `${salt}:${hash}`,
    usuario_tipo,
  };

  conexion.query("INSERT INTO usuarios SET ?", nuevoUsuario, (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (err.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }

    const id_usuario = result.insertId;
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

// Actualizar usuario (APK)
app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const verificarCorreo = "SELECT 1 FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  conexion.query(verificarCorreo, [usuario_correo, id], (e1, r1) => {
    if (e1) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (r1.length > 0) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const q = `UPDATE usuarios SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? WHERE id_usuario=?`;
    conexion.query(q, [usuario_nombre, usuario_apellido, usuario_correo, id], (e2) => {
      if (e2) return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      res.json({ mensaje: "Usuario actualizado correctamente" });
    });
  });
});

// Buscar por correo (APK)
app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  const q = `
    SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo
    FROM usuarios WHERE usuario_correo = ? LIMIT 1
  `;
  conexion.query(q, [correo], (error, rpta) => {
    if (error) return res.status(500).send({ mensaje: "Error en BD" });
    if (rpta.length > 0) res.json(rpta[0]);
    else res.status(404).send({ mensaje: "no hay registros" });
  });
});

// Login (APK) → compara password contra usuario_contrasena_hash (salt:hash)
app.post("/usuario/login", (req, res) => {
  const { correo, password } = req.body || {};
  if (!correo || !password) return res.status(400).json({ mensaje: "Credenciales incompletas" });
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo = ? LIMIT 1";
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(400).json({ mensaje: "No se pudo verificar el usuario" }); // código 400 como tu APK muestra

    const u = r[0];
    const rehash = hashPasswordSalted(password, u.usuario_contrasena_hash);
    if (rehash !== u.usuario_contrasena_hash) {
      return res.status(400).json({ mensaje: "No se pudo verificar el usuario" });
    }
    // Devuelve el dto esperado por la app
    const dto = {
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_dni: u.usuario_dni,
      usuario_tipo: u.usuario_tipo,
    };
    res.json(dto);
  });
});

// Recuperar correo (legacy APK)
app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  const q = `SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?`;
  conexion.query(q, [usuario_dni, usuario_nombre, usuario_apellido], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno del servidor" });
    if (!r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: r[0].usuario_correo });
  });
});

// Recuperar contraseña (legacy APK) → ahora **envía código** (no contraseñas)
app.post("/usuario/recuperar-contrasena", (req, res) => {
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "Correo requerido" });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(q, [usuario_correo], async (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno del servidor" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0];
    const codigo = makeResetCode();
    const vence = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    const upd = "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE id_usuario=?";
    conexion.query(upd, [codigo, vence, u.id_usuario], async (e2) => {
      if (e2) return res.status(500).json({ mensaje: "No se pudo generar el código" });
      await enviarCorreo({
        rid: "RESET",
        to: usuario_correo,
        subject: "Código para cambiar tu contraseña",
        html: tplResetCodigo({ nombre: `${u.usuario_nombre} ${u.usuario_apellido}`, codigo }),
        category: "password-reset",
      });
      res.json({ mensaje: "Se envió un código a tu correo" });
    });
  });
});

// Flujo de cambio con código (APK)
app.post("/usuario/reset/solicitar", (req, res) => {
  const { correo } = req.body || {};
  if (!correo) return res.status(400).json({ mensaje: "Correo requerido" });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(q, [correo], async (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0];
    const codigo = makeResetCode();
    const vence = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    conexion.query(
      "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE id_usuario=?",
      [codigo, vence, u.id_usuario],
      async (e2) => {
        if (e2) return res.status(500).json({ mensaje: "No se pudo generar el código" });
        await enviarCorreo({
          rid: "RESET",
          to: correo,
          subject: "Código para cambiar tu contraseña",
          html: tplResetCodigo({ nombre: `${u.usuario_nombre} ${u.usuario_apellido}`, codigo }),
          category: "password-reset",
        });
        res.json({ ok: true, mensaje: "Código enviado" });
      }
    );
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  const { correo, codigo, nuevaContrasena } = req.body || {};
  if (!correo || !codigo || !nuevaContrasena) return res.status(400).json({ mensaje: "Datos incompletos" });
  if (String(codigo).length !== 6) return res.status(400).json({ mensaje: "Código inválido" });
  if (nuevaContrasena.length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, reset_codigo, reset_expires, reset_used, reset_intentos FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0];
    const ahora = new Date();
    if (!u.reset_codigo || u.reset_codigo !== String(codigo))
      return conexion.query("UPDATE usuarios SET reset_intentos=reset_intentos+1 WHERE id_usuario=?", [u.id_usuario], () =>
        res.status(400).json({ mensaje: "Código incorrecto" })
      );
    if (u.reset_used) return res.status(400).json({ mensaje: "Código ya utilizado" });
    if (!u.reset_expires || ahora > u.reset_expires) return res.status(400).json({ mensaje: "Código expirado" });

    const salt = makeSalt();
    const hash = hashSHA256Hex(Buffer.from(salt + nuevaContrasena, "utf8"));
    const upd =
      "UPDATE usuarios SET usuario_contrasena_hash=?, reset_used=1, reset_codigo=NULL, reset_expires=NULL, reset_intentos=0 WHERE id_usuario=?";
    conexion.query(upd, [`${salt}:${hash}`, u.id_usuario], async (e2) => {
      if (e2) return res.status(500).json({ mensaje: "No se pudo actualizar la contraseña" });
      await enviarCorreo({
        rid: "RESET",
        to: correo,
        subject: "Tu contraseña fue cambiada",
        html: tplCambioOk({ nombre: `${u.usuario_nombre} ${u.usuario_apellido}` }),
        category: "password-reset-ok",
      });
      res.json({ ok: true, mensaje: "Contraseña actualizada" });
    });
  });
});

// =========================
//          MÉDICOS
// =========================
app.get("/especialidades", (_req, res) => {
  conexion.query("SELECT * FROM especialidades", (err, r) => {
    if (err) return res.status(500).json({ mensaje: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// Especialidad CRUD mínimo
app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });
  conexion.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)", [especialidad_nombre], (e) => {
    if (e) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});
app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });
  conexion.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?", [especialidad_nombre, id], (e) => {
    if (e) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  const q = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?
  `;
  conexion.query(q, [id_medico], (err, rpta) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: rpta });
  });
});

// =========================
//          HORARIOS
// =========================

// (FIX) — Este es el que tenía el typo
app.get("/horarios/:parametro", (req, res) => {
  const valores = req.params.parametro.split("&");
  const fecha = valores[0];
  const especialidad = valores[1];

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
    WHERE h.horario_fecha = ? 
      AND h.id_especialidad = ? 
      AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC
  `;
  conexion.query(consulta, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const consulta = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ?
  `;
  conexion.query(consulta, [id_medico, fecha, id_especialidad], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error al consultar horarios" });
    const horasOcupadas = resultados.map((r) => r.hora);
    const horasDisponibles = todasLasHoras.filter((h) => !horasOcupadas.includes(h));
    res.json({ horariosDisponibles: horasDisponibles });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const sql = `
    SELECT horario_hora 
    FROM horarios_medicos 
    WHERE id_medico = ? 
      AND horario_fecha = ? 
      AND id_especialidad = ?
      AND horario_estado = 0
    ORDER BY horario_hora ASC
  `;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, results) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    const horarios = results.map((row) => row.horario_hora);
    res.json({ horarios });
  });
});

app.post("/horario/registrar", (req, res) => {
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body || {};
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad)
    return res.status(400).json({ error: "Faltan datos obligatorios" });

  const horario_estado = 0;
  const q = `
    INSERT INTO horarios_medicos 
      (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, ?, ?)
  `;
  conexion.query(q, [id_medico, horario_horas, horario_fecha, horario_estado, id_especialidad], (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: result.insertId });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body || {};
  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad)
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });

  const qAnt = "SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario = ?";
  conexion.query(qAnt, [id_horario], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(500).json({ mensaje: "Error al obtener el horario original" });

    const qLib = `
      UPDATE horarios_medicos 
      SET horario_estado = 0 
      WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
    `;
    conexion.query(qLib, [r1[0].horario_fecha, r1[0].horario_hora, id_medico], () => {
      const qUpd = `
        UPDATE horarios_medicos 
        SET horario_fecha = ?, horario_hora = ?, horario_estado = 1, id_especialidad = ?
        WHERE id_horario = ?
      `;
      conexion.query(qUpd, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
        res.json({ mensaje: "Horario actualizado correctamente" });
      });
    });
  });
});

app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const { id_medico, fecha, hora } = req.params;
  const { accion, nuevaHora, id_especialidad } = req.body || {};
  if (!accion) return res.status(400).json({ mensaje: "Acción requerida" });

  if (accion === "eliminar") {
    const q = `
      DELETE FROM horarios_medicos 
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? ${id_especialidad ? "AND id_especialidad = ?" : ""}
    `;
    const params = id_especialidad ? [id_medico, fecha, hora, id_especialidad] : [id_medico, fecha, hora];
    conexion.query(q, params, (err, r) => {
      if (err) return res.status(500).json({ mensaje: "Error al eliminar horario" });
      return res.json({ mensaje: "Horario eliminado correctamente" });
    });
  } else if (accion === "actualizar") {
    if (!nuevaHora || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos" });
    const q = `
      UPDATE horarios_medicos SET horario_hora = ?, horario_estado = 0
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? AND id_especialidad = ?
    `;
    conexion.query(q, [nuevaHora, id_medico, fecha, hora, id_especialidad], (err) => {
      if (err) return res.status(500).json({ mensaje: "Error al actualizar horario" });
      return res.json({ mensaje: "Horario actualizado correctamente" });
    });
  } else if (accion === "ocupar") {
    const q = `UPDATE horarios_medicos SET horario_estado = 1 WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ?`;
    conexion.query(q, [id_medico, fecha, hora], (err) => {
      if (err) return res.status(500).json({ mensaje: "Error al ocupar horario" });
      return res.json({ mensaje: "Horario marcado como ocupado" });
    });
  } else {
    res.status(400).json({ mensaje: "Acción no reconocida" });
  }
});

// =========================
/*           CITAS         */
// =========================
app.post("/cita/agregar", (req, res) => {
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora)
    return res.status(400).json({ error: "Datos incompletos para registrar la cita" });

  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular el número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };
    conexion.query("INSERT INTO citas SET ?", cita, (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const qOcupar = `
        UPDATE horarios_medicos 
        SET horario_estado = 1 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(qOcupar, [cita_fecha, cita_hora, id_medico], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ? LIMIT 1", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) {
            await enviarCorreo({
              rid: "CITA",
              to: r4[0].usuario_correo,
              subject: "Confirmación de tu cita médica",
              html: tplConfirmacion({ fecha: cita_fecha, hora: cita_hora }),
              category: "citas-confirmacion",
            });
          }
          res.json({ mensaje: "Cita registrada correctamente", numero_orden });
        });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora)
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  conexion.query("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?", [id], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    const ant = r1[0];

    const qLiberar = `
      UPDATE horarios_medicos 
      SET horario_estado = 0 
      WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
    `;
    conexion.query(qLiberar, [ant.cita_fecha, ant.cita_hora, id_medico], () => {
      const qUpd = `
        UPDATE citas SET 
          id_usuario = ?, id_medico = ?, cita_fecha = ?, cita_hora = ?, cita_estado = ?
        WHERE id_cita = ?
      `;
      conexion.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcupar = `
          UPDATE horarios_medicos 
          SET horario_estado = 1 
          WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
        `;
        conexion.query(qOcupar, [cita_fecha, cita_hora, id_medico], () => {
          conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ? LIMIT 1", [id_usuario], async (e5, r5) => {
            if (!e5 && r5 && r5[0]) {
              await enviarCorreo({
                rid: "CITA",
                to: r5[0].usuario_correo,
                subject: "Actualización de tu cita médica",
                html: tplActualizacion({ fecha: cita_fecha, hora: cita_hora }),
                category: "citas-actualizacion",
              });
            }
            res.json({ mensaje: "Cita actualizada correctamente" });
          });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const qDatos = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita = ?";
  conexion.query(qDatos, [id_cita], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];

    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLib = `
        UPDATE horarios_medicos 
        SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(qLib, [cita_fecha, cita_hora, id_medico], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=? LIMIT 1", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) {
            await enviarCorreo({
              rid: "CITA",
              to: r4[0].usuario_correo,
              subject: "Cancelación de tu cita médica",
              html: tplCancelacion({ fecha: cita_fecha, hora: cita_hora }),
              category: "citas-cancelacion",
            });
          }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const qBuscar = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario = ? AND numero_orden = ? AND cita_estado = 1
  `;
  conexion.query(qBuscar, [id_usuario, numero_orden], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLib = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(qLib, [cita_fecha, cita_hora, id_medico], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=? LIMIT 1", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) {
            await enviarCorreo({
              rid: "CITA",
              to: r4[0].usuario_correo,
              subject: "Cancelación de tu cita médica",
              html: tplCancelacion({ fecha: cita_fecha, hora: cita_hora }),
              category: "citas-cancelacion",
            });
          }
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

// Cambiar estado de cita (APK)
app.put("/cita/estado/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const { nuevo_estado } = req.body || {};
  conexion.query("UPDATE citas SET cita_estado=? WHERE id_cita=?", [nuevo_estado, id_cita], (e) => {
    if (e) return res.status(500).json({ mensaje: "Error al actualizar estado" });
    res.json({ mensaje: "Estado actualizado correctamente" });
  });
});

// Listar citas por usuario (APK)
app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  const consulta = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
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
    ORDER BY c.id_cita ASC
  `;
  conexion.query(consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error al obtener citas" });
    const citasNumeradas = (rpta || []).map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas: citasNumeradas });
  });
});

// Listar citas por médico (APK)
app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const consulta = `
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
    ORDER BY c.id_cita ASC
  `;
  conexion.query(consulta, [id_medico], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    const listaNumerada = (rpta || []).map((c, i) => ({ ...c, numero_orden: i + 1 }));
    res.json({ listaCitas: listaNumerada });
  });
});

// Citas agrupadas por día (APK)
app.get("/citas/por-dia", (_req, res) => {
  const consulta = `
    SELECT cita_fecha AS fecha, COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY cita_fecha
    ORDER BY cita_fecha ASC
  `;
  conexion.query(consulta, (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error en la base de datos" });
    const datos = (resultados || []).map((row) => ({
      fecha: row.fecha.toISOString().slice(0, 10),
      cantidad: row.cantidad,
    }));
    res.json({ listaCitas: datos });
  });
});

// ---------- Servidor ----------
app.listen(PORT, () => {
  console.log("Servidor corriendo en el puerto " + PORT);
});
