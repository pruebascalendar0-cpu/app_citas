// index.js (corregido y completo)
require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// request-id para logs
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  next();
});

// ---------- Email (Gmail App Password) ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
});
const FROM_NAME = "Clínica Salud Total";
const FROM_EMAIL = process.env.EMAIL_USER || "no-reply@clinicasalud.com";

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
    console.error("[DB] Error de conexión:", error.message);
    process.exit(1);
  }
  console.log("[DB] Conexión exitosa");
  conexion.query("SET time_zone='-05:00'");
});

// ---------- Utils (hash y mails) ----------
const hashSHA256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const makeSalt = () => crypto.randomBytes(16).toString("hex");
const makeResetCode = () => Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos

function rehashWithStoredSalt(plain, storedSaltHash) {
  if (!storedSaltHash || !storedSaltHash.includes(":")) return null;
  const salt = storedSaltHash.split(":")[0];
  const calc = hashSHA256Hex(Buffer.from(salt + plain, "utf8"));
  return `${salt}:${calc}`;
}

async function enviarCorreo({ to, subject, html }) {
  try {
    const info = await transporter.sendMail({
      from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to,
      subject,
      html,
    });
    console.log(`[MAIL] OK → ${to} "${subject}" :: ${info.response}`);
  } catch (e) {
    console.error("[MAIL] ERROR:", e?.message || e);
  }
}

const tplResetCodigo = ({ nombre, codigo }) => `
  <h2 style="color:#2e86de;">Código para cambiar tu contraseña</h2>
  <p>Hola <strong>${nombre}</strong>, tu código es:</p>
  <p style="font-size:22px"><strong>${codigo}</strong></p>
  <p>Caduca en 10 minutos.</p>
  <hr><small>Clínica Salud Total</small>
`;
const tplCambioOk = ({ nombre }) => `
  <h2 style="color:#2e86de;">Contraseña actualizada</h2>
  <p>Hola <strong>${nombre}</strong>, tu contraseña fue cambiada correctamente.</p>
  <hr><small>Clínica Salud Total</small>
`;

// ---------- Home ----------
app.get("/", (_req, res) => res.send("Servicio de Citas - OK"));

// =========================
//         USUARIOS
// =========================

// Listado simple (para pruebas)
app.get("/usuarios", (_req, res) => {
  const q = "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios";
  conexion.query(q, (err, r) => {
    if (err) return res.status(500).json({ mensaje: "Error listando usuarios" });
    res.json({ listaUsuarios: r || [] });
  });
});

// Buscar usuario por correo (lo usa tu WebService)
app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  const q = `
    SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo
    FROM usuarios WHERE usuario_correo = ? LIMIT 1
  `;
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  });
});

// Registrar (corrige: guarda salt:hash en usuario_contrasena_hash)
app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) return res.status(400).json({ mensaje: "DNI debe tener 8 dígitos." });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo)) return res.status(400).json({ mensaje: "Correo no válido." });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6 caracteres." });

  const salt = makeSalt();
  const hash = hashSHA256Hex(Buffer.from(salt + usuario_contrasena, "utf8"));
  const u = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: `${salt}:${hash}`,
    usuario_tipo: 1, // Paciente
  };

  conexion.query("INSERT INTO usuarios SET ?", u, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (err.sqlMessage.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

// LOGIN (lo necesita tu app) — acepta {correo,password} o {usuario_correo,usuario_contrasena}
app.post("/usuario/login", (req, res) => {
  const correo = req.body?.correo || req.body?.usuario_correo;
  const password = req.body?.password || req.body?.usuario_contrasena;
  if (!correo || !password) return res.status(400).json({ mensaje: "Credenciales incompletas" });

  const q = `
    SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo,usuario_contrasena_hash
    FROM usuarios WHERE usuario_correo=? LIMIT 1
  `;
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(400).json({ mensaje: "No se pudo verificar el usuario" });

    const u = r[0];
    const rehash = rehashWithStoredSalt(password, u.usuario_contrasena_hash);
    if (rehash !== u.usuario_contrasena_hash) {
      return res.status(400).json({ mensaje: "No se pudo verificar el usuario" });
    }
    // DTO esperado
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_dni: u.usuario_dni,
      usuario_tipo: u.usuario_tipo,
    });
  });
});

// Recuperar correo
app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  const q = `SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=? LIMIT 1`;
  conexion.query(q, [usuario_dni, usuario_nombre, usuario_apellido], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno" });
    if (!r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: r[0].usuario_correo });
  });
});

// Recuperar contraseña (envía CÓDIGO a correo)
app.post("/usuario/recuperar-contrasena", (req, res) => {
  const { usuario_correo } = req.body || {};
  if (!usuario_correo) return res.status(400).json({ mensaje: "Correo requerido" });
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(q, [usuario_correo], async (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0];
    const codigo = makeResetCode();
    const vence = new Date(Date.now() + 10 * 60 * 1000);
    conexion.query(
      "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE id_usuario=?",
      [codigo, vence, u.id_usuario],
      async (e2) => {
        if (e2) return res.status(500).json({ mensaje: "No se pudo generar el código" });
        await enviarCorreo({
          to: usuario_correo,
          subject: "Código para cambiar tu contraseña",
          html: tplResetCodigo({ nombre: `${u.usuario_nombre} ${u.usuario_apellido}`, codigo }),
        });
        res.json({ mensaje: "Se envió un código a tu correo" });
      }
    );
  });
});

// Flujo explícito de reset (por si lo usas en Android)
app.post("/usuario/reset/solicitar", (req, res) => {
  const { correo } = req.body || {};
  if (!correo) return res.status(400).json({ mensaje: "Correo requerido" });
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(q, [correo], async (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0];
    const codigo = makeResetCode();
    const vence = new Date(Date.now() + 10 * 60 * 1000);
    conexion.query(
      "UPDATE usuarios SET reset_codigo=?, reset_expires=?, reset_used=0, reset_intentos=0 WHERE id_usuario=?",
      [codigo, vence, u.id_usuario],
      async (e2) => {
        if (e2) return res.status(500).json({ mensaje: "No se pudo generar el código" });
        await enviarCorreo({
          to: correo,
          subject: "Código para cambiar tu contraseña",
          html: tplResetCodigo({ nombre: `${u.usuario_nombre} ${u.usuario_apellido}`, codigo }),
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
  if (nuevaContrasena.length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6 caracteres" });

  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, reset_codigo, reset_expires, reset_used FROM usuarios WHERE usuario_correo=? LIMIT 1";
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = r[0];
    const ahora = new Date();
    if (!u.reset_codigo || u.reset_codigo !== String(codigo)) return res.status(400).json({ mensaje: "Código incorrecto" });
    if (u.reset_used) return res.status(400).json({ mensaje: "Código ya utilizado" });
    if (!u.reset_expires || ahora > u.reset_expires) return res.status(400).json({ mensaje: "Código expirado" });

    const salt = makeSalt();
    const hash = hashSHA256Hex(Buffer.from(salt + nuevaContrasena, "utf8"));
    conexion.query(
      "UPDATE usuarios SET usuario_contrasena_hash=?, reset_used=1, reset_codigo=NULL, reset_expires=NULL, reset_intentos=0 WHERE id_usuario=?",
      [`${salt}:${hash}`, u.id_usuario],
      async (e2) => {
        if (e2) return res.status(500).json({ mensaje: "No se pudo actualizar la contraseña" });
        await enviarCorreo({ to: correo, subject: "Tu contraseña fue cambiada", html: tplCambioOk({ nombre: `${u.usuario_nombre} ${u.usuario_apellido}` }) });
        res.json({ ok: true, mensaje: "Contraseña actualizada" });
      }
    );
  });
});

// =========================
//         ESPECIALIDADES
// =========================
app.get("/especialidades", (_req, res) => {
  conexion.query("SELECT * FROM especialidades", (err, r) => {
    if (err) return res.status(500).json({ mensaje: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// =========================
//          HORARIOS
// =========================

// (FIX) aquí estaba el typo `SELECT h.,`
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
    WHERE h.horario_fecha = ? AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC
  `;
  conexion.query(consulta, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
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

// =========================
//           CITAS
// =========================
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

// ---------- Servidor ----------
app.listen(PORT, () => {
  console.log("Servidor corriendo en el puerto " + PORT);
});
