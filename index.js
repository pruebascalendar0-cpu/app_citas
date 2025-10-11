// index.js (tu base + endpoints de Citas completos)
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
const tplConfirm = ({ fecha, hora }) =>
  `<h2 style="color:#2e86de;">¡Cita confirmada!</h2><p><b>Fecha:</b> ${fecha}</p><p><b>Hora:</b> ${hora}</p>`;
const tplUpdate = ({ fecha, hora }) =>
  `<h2 style="color:#f39c12;">¡Cita actualizada!</h2><p><b>Nueva fecha:</b> ${fecha}</p><p><b>Hora:</b> ${hora}</p>`;
const tplCancel = ({ fecha, hora }) =>
  `<h2 style="color:#c0392b;">Cita cancelada</h2><p><b>Fecha:</b> ${fecha}</p><p><b>Hora:</b> ${hora}</p>`;

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

// ---------- Utils (hash / reset) ----------
const hashSHA256Hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const makeSalt = () => crypto.randomBytes(16).toString("hex");
const makeResetCode = () => Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
function rehashWithStoredSalt(plain, storedSaltHash) {
  if (!storedSaltHash || !storedSaltHash.includes(":")) return null;
  const salt = storedSaltHash.split(":")[0];
  const calc = hashSHA256Hex(Buffer.from(salt + plain, "utf8"));
  return `${salt}:${calc}`;
}

// ---------- Home ----------
app.get("/", (_req, res) => res.send("Servicio de Citas - OK"));

// =========================
//         USUARIOS
// =========================
app.get("/usuarios", (_req, res) => {
  const q = "SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios";
  conexion.query(q, (err, r) => {
    if (err) return res.status(500).json({ mensaje: "Error listando usuarios" });
    res.json({ listaUsuarios: r || [] });
  });
});

app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo);
  const q = `
    SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo
    FROM usuarios WHERE usuario_correo = ? LIMIT 1`;
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(404).json({ mensaje: "no hay registros" });
    res.json(r[0]);
  });
});

app.post("/usuario/agregar", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body || {};
  if (!usuario_dni || !/^\d{8}$/.test(usuario_dni)) return res.status(400).json({ mensaje: "DNI debe tener 8 dígitos." });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios." });
  if (!usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario_correo)) return res.status(400).json({ mensaje: "Correo no válido." });
  if (!usuario_contrasena || usuario_contrasena.length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6." });

  const salt = makeSalt();
  const hash = hashSHA256Hex(Buffer.from(salt + usuario_contrasena, "utf8"));
  const u = {
    usuario_dni, usuario_nombre, usuario_apellido, usuario_correo,
    usuario_contrasena_hash: `${salt}:${hash}`, usuario_tipo: 1,
  };
  conexion.query("INSERT INTO usuarios SET ?", u, (err) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ mensaje: "DNI o correo ya registrado" });
    return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }
    res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.post("/usuario/login", (req, res) => {
  const correo = req.body?.correo || req.body?.usuario_correo;
  const password = req.body?.password || req.body?.usuario_contrasena;
  if (!correo || !password) return res.status(400).json({ mensaje: "Credenciales incompletas" });

  const q = `
    SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo,usuario_contrasena_hash
    FROM usuarios WHERE usuario_correo=? LIMIT 1`;
  conexion.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error en BD" });
    if (!r.length) return res.status(400).json({ mensaje: "No se pudo verificar el usuario" });

    const u = r[0];
    const rehash = rehashWithStoredSalt(password, u.usuario_contrasena_hash);
    if (rehash !== u.usuario_contrasena_hash) return res.status(400).json({ mensaje: "No se pudo verificar el usuario" });

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

// Recuperación (correo / contraseña con código) — sin cambios
app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body || {};
  const q = `SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=? LIMIT 1`;
  conexion.query(q, [usuario_dni, usuario_nombre, usuario_apellido], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno" });
    if (!r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: r[0].usuario_correo });
  });
});

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
          html: `<p>Hola ${u.usuario_nombre} ${u.usuario_apellido}</p><p>Tu código es <b>${codigo}</b> (10 min)</p>`,
        });
        res.json({ mensaje: "Se envió un código a tu correo" });
      }
    );
  });
});

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
          html: `<p>Hola ${u.usuario_nombre} ${u.usuario_apellido}</p><p>Tu código es <b>${codigo}</b> (10 min)</p>`,
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
  if (nuevaContrasena.length < 6) return res.status(400).json({ mensaje: "Contraseña mínima 6" });

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
        await enviarCorreo({ to: correo, subject: "Tu contraseña fue cambiada", html: `<p>Hola ${u.usuario_nombre} ${u.usuario_apellido}</p><p>Contraseña actualizada.</p>` });
        res.json({ ok: true, mensaje: "Contraseña actualizada" });
      }
    );
  });
});

// =========================
//       ESPECIALIDADES
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
app.get("/horarios/:parametro", (req, res) => {
  const [fecha, especialidad] = req.params.parametro.split("&");
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
    ORDER BY h.horario_hora ASC`;
  conexion.query(consulta, [fecha, especialidad], (error, rpta) => {
    if (error) return res.status(500).json({ error: error.message });
    res.json({ listaHorarios: rpta });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (err, results) => {
    if (err) return res.status(500).json({ error: "Error interno del servidor" });
    res.json({ horarios: results.map((r) => r.hora) });
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const todasLasHoras = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const consulta = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico = ? AND horario_fecha = ? AND id_especialidad = ?`;
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

// (A) Listar TODAS (para probar como /usuarios)
app.get("/citas", (_req, res) => {
  const q = `
    SELECT c.id_cita, c.id_usuario, c.id_medico, c.numero_orden,
           DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           c.cita_estado,
           e.especialidad_nombre,
           mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    ORDER BY c.cita_fecha, c.cita_hora`;
  conexion.query(q, (e, r) => {
    if (e) return res.status(500).json({ error: "Error al obtener citas" });
    res.json({ listaCitas: r || [] });
  });
});

// (B) Listar por usuario (para “Mis Citas” en la app)
app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  const consulta = `
    SELECT c.id_cita, c.id_usuario, c.id_medico, c.numero_orden,
           DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
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
    ORDER BY c.cita_fecha, c.cita_hora`;
  conexion.query(consulta, [usuario], (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error al obtener citas" });
    res.json({ listaCitas: rpta || [] });
  });
});

// (C) Listar por médico (lo usa tu WebService)
app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const q = `
    SELECT c.id_cita, c.id_usuario, c.numero_orden,
           DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           c.cita_estado
    FROM citas c
    WHERE c.id_medico = ?
    ORDER BY c.cita_fecha, c.cita_hora`;
  conexion.query(q, [id_medico], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al obtener citas del médico" });
    res.json({ listaCitas: r || [] });
  });
});

// (D) Buscar por número de orden del usuario
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const q = `
    SELECT c.id_cita, c.id_usuario, c.id_medico, c.numero_orden,
           DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           c.cita_estado
    FROM citas c
    WHERE c.id_usuario=? AND c.numero_orden=?`;
  conexion.query(q, [id_usuario, numero_orden], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error del servidor" });
    if (!r || !r.length) return res.status(404).json({ mensaje: "No existe esa cita" });
    res.json(r[0]);
  });
});

// (E) Registrar cita
app.post("/cita/agregar", (req, res) => {
  const rid = req.rid;
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora)
    return res.status(400).json({ error: "Datos incompletos para registrar la cita" });

  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden, cita_estado: 1 };
    conexion.query("INSERT INTO citas SET ?", cita, (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      // Ocupar horario (si existe el registro)
      const qOcc = `
        UPDATE horarios_medicos SET horario_estado=1
        WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      conexion.query(qOcc, [id_medico, cita_fecha, cita_hora], () => {});

      // Correo al usuario (si tiene)
      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e3, r3) => {
        if (r3 && r3[0]) {
          await enviarCorreo({ to: r3[0].usuario_correo, subject: "Confirmación de tu cita", html: tplConfirm({ fecha: cita_fecha, hora: cita_hora }) });
        }
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

// (F) Actualizar cita
app.put("/cita/actualizar/:id", (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora)
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  // liberar horario anterior
  conexion.query("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?", [id], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const qLib = `
      UPDATE horarios_medicos SET horario_estado=0
      WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
    conexion.query(qLib, [id_medico, r1[0].cita_fecha, r1[0].cita_hora], () => {
      const qUpd = `
        UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=?
        WHERE id_cita=?`;
      conexion.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado ?? 1, id], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcc = `
          UPDATE horarios_medicos SET horario_estado=1
          WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
        conexion.query(qOcc, [id_medico, cita_fecha, cita_hora], () => {});
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e5, r5) => {
          if (r5 && r5[0]) {
            await enviarCorreo({ to: r5[0].usuario_correo, subject: "Actualización de tu cita", html: tplUpdate({ fecha: cita_fecha, hora: cita_hora }) });
          }
          res.json({ mensaje: "Cita actualizada correctamente" });
        });
      });
    });
  });
});

// (G) Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;

  conexion.query("SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?", [id_cita], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLib = `
        UPDATE horarios_medicos SET horario_estado=0
        WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      conexion.query(qLib, [id_medico, cita_fecha, cita_hora], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e4, r4) => {
          if (r4 && r4[0]) await enviarCorreo({ to: r4[0].usuario_correo, subject: "Cancelación de tu cita", html: tplCancel({ fecha: cita_fecha, hora: cita_hora }) });
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

// (H) Anular por usuario + número de orden
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;

  const qFind = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`;
  conexion.query(qFind, [id_usuario, numero_orden], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLib = `
        UPDATE horarios_medicos SET horario_estado=0
        WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      conexion.query(qLib, [id_medico, cita_fecha, cita_hora], () => {
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e4, r4) => {
          if (r4 && r4[0]) await enviarCorreo({ to: r4[0].usuario_correo, subject: "Cancelación de tu cita", html: tplCancel({ fecha: cita_fecha, hora: cita_hora }) });
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

// =========================
//           KPIs
// =========================
app.get("/citas/por-dia", (_req, res) => {
  const q = `
    SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY cita_fecha ORDER BY cita_fecha ASC`;
  conexion.query(q, (e, r) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: r || [] });
  });
});

// ---------- Servidor ----------
app.listen(PORT, () => {
  console.log("Servidor corriendo en el puerto " + PORT);
});
