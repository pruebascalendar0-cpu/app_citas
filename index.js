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

// request-id para correlacionar logs críticos
app.use((req, res, next) => {
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

conexion.connect(error => {
  if (error) {
    console.error("[DB] ERROR al conectar:", error.message);
    process.exit(1);
  }
  console.log("[DB] Conexión exitosa");
  conexion.query("SET time_zone = '-05:00'", () => {
    conexion.query("SELECT @@session.time_zone tz", (e, r) => {
      console.log("[DB] time_zone =", r && r[0] ? r[0].tz : "desconocido");
    });
  });
});

// ---------- Helpers de password/reset ----------
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex"); // 32 chars
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`; // coincide con tu columna usuario_contrasena_hash
}

function checkPassword(plain, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const calc = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(calc, "hex"));
}

function genCodigo6() {
  return ("" + Math.floor(100000 + Math.random() * 900000));
}

// ---------- Mail (SendGrid o Gmail) ----------
let mailProvider = "gmail"; // default
if (process.env.SENDGRID_API_KEY) mailProvider = "sendgrid";
if (process.env.MAIL_PROVIDER) mailProvider = process.env.MAIL_PROVIDER;

let sgMail = null;
let nodemailer = null;
let transporter = null;

if (mailProvider === "sendgrid" && process.env.SENDGRID_API_KEY) {
  try {
    sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  } catch (e) {
    console.warn("[MAIL] @sendgrid/mail no instalado. Cambio a Gmail SMTP.");
    mailProvider = "gmail";
  }
}

if (mailProvider === "gmail") {
  nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  });
}

const FROM_NAME = "Clínica Salud Total";
const FROM_EMAIL = process.env.EMAIL_USER || "no-reply@clinicasalud.com";

async function enviar({ rid, to, subject, html, category }) {
  try {
    if (mailProvider === "sendgrid" && sgMail) {
      const [resp] = await sgMail.send({
        to,
        from: { name: FROM_NAME, email: FROM_EMAIL },
        subject,
        html,
        mailSettings: { sandboxMode: { enable: false } },
        categories: category ? [category] : undefined
      });
      console.log(`[MAIL ${rid}] SendGrid OK: ${resp.statusCode} to=${to} subject="${subject}"`);
      return true;
    }
    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html
    });
    console.log(`[MAIL ${rid}] SMTP OK: ${info.response} to=${to} subject="${subject}"`);
    return true;
  } catch (err) {
    console.error(`[MAIL ${rid}] ERROR:`, err && err.message ? err.message : err);
    return false;
  }
}

// ---------- Plantillas mail ----------
const tplCodigo = ({ codigo }) => `
  <h2 style="color:#2e86de;">Código de verificación</h2>
  <p>Tu código para cambiar la contraseña es: <strong style="font-size:18px">${codigo}</strong></p>
  <p>Vence en 15 minutos. Si no fuiste tú, ignora este mensaje.</p>
  <hr><small>Clínica Salud Total – Seguridad</small>
`;
function tplConfirmacion({ fecha, hora }) {
  return `
    <h2 style="color:#2e86de;">¡Cita médica confirmada!</h2>
    <p>Tu cita ha sido registrada con éxito.</p>
    <p><strong>Fecha:</strong> ${fecha}</p>
    <p><strong>Hora:</strong> ${hora}</p>
    <hr><small>Clínica Salud Total – Sistema de Citas</small>
  `;
}
function tplActualizacion({ fecha, hora }) {
  return `
    <h2 style="color:#f39c12;">¡Cita médica actualizada!</h2>
    <p>Tu cita ha sido <strong>actualizada</strong> con éxito.</p>
    <p><strong>Nueva Fecha:</strong> ${fecha}</p>
    <p><strong>Hora:</strong> ${hora}</p>
    <hr><small>Clínica Salud Total – Sistema de Citas</small>
  `;
}
function tplCancelacion({ fecha, hora }) {
  return `
    <h2 style="color:#c0392b;">Cita cancelada</h2>
    <p>Tu cita médica ha sido <strong>cancelada</strong> correctamente.</p>
    <p><strong>Fecha:</strong> ${fecha}</p>
    <p><strong>Hora:</strong> ${hora}</p>
    <hr><small>Clínica Salud Total – Sistema de Citas</small>
  `;
}

// ---------- Rutas base ----------
app.get("/", (_req, res) => res.send("Bienvenido"));

// Usuarios (listado simple)
app.get("/usuarios", (_req, res) => {
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo FROM usuarios";
  conexion.query(q, (err, rpta) => {
    if (err) return res.status(500).json({ mensaje: "Error al listar usuarios" });
    res.json({ listaUsuarios: rpta || [] });
  });
});

// Especialidades
app.get("/especialidades", (_req, res) => {
  conexion.query("SELECT * FROM especialidades", (err, r) => {
    if (err) return res.status(500).json({ mensaje: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// ---------- ENDPOINTS que espera tu APK (WebService.kt) ----------

// 1) LOGIN
app.post("/usuario/login", (req, res) => {
  const { correo, password } = req.body || {};
  if (!correo || !password) return res.status(400).json({ mensaje: "Correo y password son obligatorios" });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo, usuario_contrasena_hash FROM usuarios WHERE usuario_correo = ?";
  conexion.query(q, [correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error en BD" });
    if (!rows || !rows[0]) return res.status(401).json({ mensaje: "Credenciales inválidas" });

    const u = rows[0];
    if (!checkPassword(password, u.usuario_contrasena_hash)) {
      return res.status(401).json({ mensaje: "Credenciales inválidas" });
    }
    // Respuesta tipo UsuarioDto (ajústala si tu app espera otros campos)
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo
    });
  });
});

// 2) RESET - solicitar código
app.post("/usuario/reset/solicitar", async (req, res) => {
  const rid = req.rid;
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "usuario_correo es obligatorio" });

  const q = "SELECT id_usuario FROM usuarios WHERE usuario_correo = ?";
  conexion.query(q, [usuario_correo], async (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error en BD" });
    if (!rows || !rows[0]) return res.status(404).json({ mensaje: "Correo no registrado" });

    const codigo = genCodigo6();
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
    const upd = `
      UPDATE usuarios 
         SET reset_codigo = ?, reset_expires = ?, reset_used = 0, reset_intentos = 0
       WHERE usuario_correo = ?
    `;
    conexion.query(upd, [codigo, expires, usuario_correo], async (e2) => {
      if (e2) return res.status(500).json({ mensaje: "No se pudo guardar el código" });

      await enviar({
        rid,
        to: usuario_correo,
        subject: "Código para cambiar tu contraseña",
        html: tplCodigo({ codigo }),
        category: "reset-password"
      });

      res.json({ ok: true, mensaje: "Código enviado" });
    });
  });
});

// 3) RESET - cambiar con código
app.post("/usuario/reset/cambiar", (req, res) => {
  const { correo, codigo, nuevo_password } = req.body || {};
  if (!correo || !codigo || !nuevo_password) {
    return res.status(400).json({ mensaje: "correo, codigo y nuevo_password son obligatorios" });
  }

  const q = `
    SELECT id_usuario, reset_codigo, reset_expires, reset_used, reset_intentos 
      FROM usuarios 
     WHERE usuario_correo = ?
  `;
  conexion.query(q, [correo], (err, rows) => {
    if (err) return res.status(500).json({ mensaje: "Error en BD" });
    if (!rows || !rows[0]) return res.status(404).json({ mensaje: "Usuario no encontrado" });

    const u = rows[0];
    if (!u.reset_codigo || u.reset_used === 1) return res.status(400).json({ mensaje: "Código no activo" });
    if (u.reset_intentos >= 5) return res.status(429).json({ mensaje: "Demasiados intentos, solicita otro código" });
    if (new Date(u.reset_expires).getTime() < Date.now()) return res.status(400).json({ mensaje: "Código vencido" });

    if (String(codigo) !== String(u.reset_codigo)) {
      // aumentar intentos
      conexion.query("UPDATE usuarios SET reset_intentos = reset_intentos + 1 WHERE id_usuario = ?", [u.id_usuario], () => {
        return res.status(401).json({ mensaje: "Código inválido" });
      });
      return;
    }

    const nuevoHash = hashPassword(nuevo_password);
    const upd = `
      UPDATE usuarios
         SET usuario_contrasena_hash = ?, reset_used = 1
       WHERE id_usuario = ?
    `;
    conexion.query(upd, [nuevoHash, u.id_usuario], (e2) => {
      if (e2) return res.status(500).json({ mensaje: "No se pudo actualizar la contraseña" });
      res.json({ ok: true, mensaje: "Contraseña actualizada" });
    });
  });
});

// 4) Crear usuario simple (coincide con @POST /usuario/agregar)
app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) return res.status(400).json({ mensaje: "El DNI debe tener 8 dígitos" });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios" });
  if (!usuario_correo) return res.status(400).json({ mensaje: "Correo requerido" });
  if (!usuario_contrasena || String(usuario_contrasena).length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6 caracteres" });

  const nuevo = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo: 1
  };

  conexion.query("INSERT INTO usuarios SET ?", nuevo, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        const msg = (err.sqlMessage || "").includes("usuario_correo") ? "El correo ya está registrado" :
                    (err.sqlMessage || "").includes("usuario_dni") ? "DNI ya está registrado" : "Datos duplicados";
        return res.status(400).json({ mensaje: msg });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    res.json({ mensaje: "Usuario registrado correctamente" });
  });
});

// 5) Registrar usuario con especialidad (coincide con @POST /usuario/registrar)
app.post("/usuario/registrar", (req, res) => {
  const { usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_contrasena, usuario_tipo, id_especialidad } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_dni || !usuario_contrasena || (usuario_tipo === undefined)) {
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });
  }

  const nuevo = {
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_dni,
    usuario_contrasena_hash: hashPassword(usuario_contrasena),
    usuario_tipo
  };

  conexion.query("INSERT INTO usuarios SET ?", nuevo, (err, r) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        const msg = (err.sqlMessage || "").includes("usuario_correo") ? "El correo ya está registrado" :
                    (err.sqlMessage || "").includes("usuario_dni") ? "DNI ya está registrado" : "Datos duplicados";
        return res.status(400).json({ mensaje: msg });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }

    const id_usuario = r.insertId;
    if (Number(usuario_tipo) === 2 && id_especialidad) {
      conexion.query("INSERT INTO medicos (id_medico, id_especialidad) VALUES (?, ?)", [id_usuario, id_especialidad], (e2) => {
        if (e2) return res.status(201).json({ mensaje: "Usuario registrado, pero no se pudo asignar la especialidad", id_usuario });
        return res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
      });
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

// 6) Actualizar usuario (@PUT /usuario/actualizar/:id)
app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  if (!usuario_nombre || !usuario_apellido || !usuario_correo) return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const verificar = "SELECT 1 FROM usuarios WHERE usuario_correo = ? AND id_usuario != ?";
  conexion.query(verificar, [usuario_correo, id], (e1, r1) => {
    if (e1) return res.status(500).json({ mensaje: "Error al verificar correo" });
    if (r1 && r1.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const upd = "UPDATE usuarios SET usuario_nombre = ?, usuario_apellido = ?, usuario_correo = ? WHERE id_usuario = ?";
    conexion.query(upd, [usuario_nombre, usuario_apellido, usuario_correo, id], (e2) => {
      if (e2) return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      res.json({ mensaje: "Usuario actualizado correctamente" });
    });
  });
});

// 7) Buscar usuario por correo (@GET /usuario/{correo})
app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  conexion.query("SELECT * FROM usuarios WHERE usuario_correo = ?", [correo], (err, rpta) => {
    if (err) return res.status(500).json({ mensaje: "Error en BD" });
    if (rpta && rpta[0]) return res.json(rpta[0]);
    res.status(404).json({ mensaje: "no hay registros" });
  });
});

// ---- Horarios / Médicos que usa tu APK ----

// Especialidades por médico
app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  const q = `
    SELECT e.id_especialidad, e.especialidad_nombre
      FROM medicos m
      JOIN especialidades e ON m.id_especialidad = e.id_especialidad
     WHERE m.id_medico = ?
  `;
  conexion.query(q, [id_medico], (err, r) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// Horarios disponibles (todas las horas 08:00–16:00 menos las registradas)
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);

  const q = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
      FROM horarios_medicos
     WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ?
  `;
  conexion.query(q, [id_medico, fecha, id_especialidad], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = rows.map(r => r.hora);
    const disponibles = todas.filter(h => !ocupadas.includes(h));
    res.json({ horariosDisponibles: disponibles });
  });
});

// Horarios registrados (estado=0 libres en tu consulta antigua)
app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const q = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
      FROM horarios_medicos
     WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ? AND horario_estado = 0
     ORDER BY horario_hora ASC
  `;
  conexion.query(q, [id_medico, fecha, id_especialidad], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error interno" });
    res.json({ horarios: rows.map(r => r.hora) });
  });
});

// Reporte: citas por día
app.get("/citas/por-dia", (_req, res) => {
  const q = `
    SELECT cita_fecha AS fecha, COUNT(*) AS cantidad
      FROM citas
     WHERE cita_estado = 1
     GROUP BY cita_fecha
     ORDER BY cita_fecha ASC
  `;
  conexion.query(q, (err, rows) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    const lista = rows.map(r => ({ fecha: r.fecha.toISOString().slice(0, 10), cantidad: r.cantidad }));
    res.json({ listaCitas: lista });
  });
});

// ---------- (El resto de endpoints de citas/horarios que ya tenías) ----------
// ... [Tus endpoints de /cita/agregar, /cita/actualizar/:id, /cita/anular/...,
//      /horario/registrar, /horario/actualizar/:id_horario, /horario/editar/... 
//      se mantienen EXACTAMENTE como en tu último archivo.]

// ---------- Servidor ----------
app.listen(PORT, () => {
  console.log("Servidor corriendo en el puerto " + PORT);
  console.log(`DEBUG_SQL=${process.env.DEBUG_SQL ? "ON" : "OFF"}`);
});
