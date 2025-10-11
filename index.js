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
  // Ajustamos zona horaria solo a nivel de sesión para MySQL (no transformamos los datos del cliente)
  conexion.query("SET time_zone = '-05:00'", () => {
    conexion.query("SELECT @@session.time_zone tz", (e, r) => {
      console.log("[DB] time_zone =", r && r[0] ? r[0].tz : "desconocido");
    });
  });
});

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

const FROM_NAME = 'Clínica Salud Total';
const FROM_EMAIL = process.env.EMAIL_USER || "no-reply@clinicasalud.com";

// util: enviar correo (logs solo aquí)
async function enviar({ rid, to, subject, html, category }) {
  try {
    if (mailProvider === "sendgrid" && sgMail) {
      const msg = {
        to,
        from: { name: FROM_NAME, email: FROM_EMAIL },
        subject,
        html,
        mailSettings: { sandboxMode: { enable: false } },
        categories: category ? [category] : undefined
      };
      const [resp] = await sgMail.send(msg);
      console.log(`[MAIL ${rid}] SendGrid OK: ${resp.statusCode} to=${to} subject="${subject}"`);
      return true;
    }
    // Gmail
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

// plantillas simples
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

// ---------- Rutas básicas (sin logs extra) ----------
app.get("/", (_req, res) => res.send("Bienvenido"));
app.get("/usuarios", (_req, res) => {
  const q = "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo FROM usuarios";
  conexion.query(q, (err, rpta) => {
    if (err) return res.status(500).json({ mensaje: "Error al listar usuarios" });
    res.json({ listaUsuarios: rpta || [] });
  });
});
app.get("/especialidades", (_req, res) => {
  conexion.query("SELECT * FROM especialidades", (err, r) => {
    if (err) return res.status(500).json({ mensaje: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// ---------- ENDPOINTS con LOGS (citas/horarios/correos) ----------

// Crear cita
app.post("/cita/agregar", (req, res) => {
  const rid = req.rid;
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ error: "Datos incompletos para registrar la cita" });
  }

  console.log(`[CITA ${rid}] agregar -> usuario=${id_usuario} medico=${id_medico} fecha=${cita_fecha} hora=${cita_hora}`);

  // numero_orden = cantidad de citas previas del usuario + 1
  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) {
      console.error(`[CITA ${rid}] ERROR orden:`, e1.message);
      return res.status(500).json({ error: "Error al calcular el número de orden" });
    }
    const numero_orden = (r1[0]?.total || 0) + 1;

    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };
    conexion.query("INSERT INTO citas SET ?", cita, (e2) => {
      if (e2) {
        console.error(`[CITA ${rid}] ERROR insertar:`, e2.message);
        return res.status(500).json({ error: "Error al registrar la cita" });
      }

      // ocupar horario
      const qOcupar = `
        UPDATE horarios_medicos 
        SET horario_estado = 1 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(qOcupar, [cita_fecha, cita_hora, id_medico], (e3, r3) => {
        if (e3) console.error(`[HORARIO ${rid}] ERROR ocupar:`, e3.message);
        console.log(`[HORARIO ${rid}] ocupar -> afectadas=${r3?.affectedRows || 0}`);

        // correo al usuario
        const qMail = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
        conexion.query(qMail, [id_usuario], async (e4, r4) => {
          if (e4 || !r4 || !r4[0]) {
            console.error(`[MAIL ${rid}] ERROR obtener correo usuario=${id_usuario}`);
          } else {
            await enviar({
              rid,
              to: r4[0].usuario_correo,
              subject: "Confirmación de tu cita médica",
              html: tplConfirmacion({ fecha: cita_fecha, hora: cita_hora }),
              category: "citas-confirmacion"
            });
          }
          res.json({ mensaje: "Cita registrada correctamente", numero_orden });
        });
      });
    });
  });
});

// Actualizar cita (fecha/hora/estado/medico)
app.put("/cita/actualizar/:id", (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  console.log(`[CITA ${rid}] actualizar -> id=${id} usuario=${id_usuario} medico=${id_medico} nueva=${cita_fecha} ${cita_hora}`);

  // 1. obtener horario anterior
  conexion.query("SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?", [id], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) {
      console.error(`[CITA ${rid}] ERROR obtener horario anterior`);
      return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    }
    const ant = r1[0];

    // 2. liberar anterior
    const qLiberar = `
      UPDATE horarios_medicos 
      SET horario_estado = 0 
      WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
    `;
    conexion.query(qLiberar, [ant.cita_fecha, ant.cita_hora, id_medico], (e2, r2) => {
      if (e2) console.error(`[HORARIO ${rid}] ERROR liberar:`, e2.message);
      console.log(`[HORARIO ${rid}] liberar -> afectadas=${r2?.affectedRows || 0}`);

      // 3. actualizar cita
      const qUpd = `
        UPDATE citas SET 
          id_usuario = ?, id_medico = ?, cita_fecha = ?, cita_hora = ?, cita_estado = ?
        WHERE id_cita = ?
      `;
      conexion.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], (e3) => {
        if (e3) {
          console.error(`[CITA ${rid}] ERROR actualizar:`, e3.message);
          return res.status(500).json({ mensaje: "Error al actualizar la cita" });
        }

        // 4. ocupar nuevo
        const qOcupar = `
          UPDATE horarios_medicos 
          SET horario_estado = 1 
          WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
        `;
        conexion.query(qOcupar, [cita_fecha, cita_hora, id_medico], (e4, r4) => {
          if (e4) console.error(`[HORARIO ${rid}] ERROR ocupar:`, e4.message);
          console.log(`[HORARIO ${rid}] ocupar -> afectadas=${r4?.affectedRows || 0}`);

          // 5. correo
          conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], async (e5, r5) => {
            if (e5 || !r5 || !r5[0]) {
              console.error(`[MAIL ${rid}] ERROR obtener correo usuario=${id_usuario}`);
            } else {
              await enviar({
                rid,
                to: r5[0].usuario_correo,
                subject: "Actualización de tu cita médica",
                html: tplActualizacion({ fecha: cita_fecha, hora: cita_hora }),
                category: "citas-actualizacion"
              });
            }
            res.json({ mensaje: "Cita actualizada correctamente" });
          });
        });
      });
    });
  });
});

// Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;

  console.log(`[CITA ${rid}] anular -> id=${id_cita}`);

  const qDatos = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita = ?";
  conexion.query(qDatos, [id_cita], (e1, r1) => {
    if (e1 || !r1 || !r1[0]) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];

    conexion.query("UPDATE citas SET cita_estado = 0 WHERE id_cita = ?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLiberar = `
        UPDATE horarios_medicos 
        SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(qLiberar, [cita_fecha, cita_hora, id_medico], (e3, r3) => {
        if (e3) console.error(`[HORARIO ${rid}] ERROR liberar:`, e3.message);
        console.log(`[HORARIO ${rid}] liberar -> afectadas=${r3?.affectedRows || 0}`);

        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) {
            await enviar({
              rid,
              to: r4[0].usuario_correo,
              subject: "Cancelación de tu cita médica",
              html: tplCancelacion({ fecha: cita_fecha, hora: cita_hora }),
              category: "citas-cancelacion"
            });
          }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

// Anular por usuario + numero_orden
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;
  console.log(`[CITA ${rid}] anular -> usuario=${id_usuario} orden=${numero_orden}`);

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

      const qLiberar = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(qLiberar, [cita_fecha, cita_hora, id_medico], (e3, r3) => {
        if (e3) console.error(`[HORARIO ${rid}] ERROR liberar:`, e3.message);
        console.log(`[HORARIO ${rid}] liberar -> afectadas=${r3?.affectedRows || 0}`);

        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], async (e4, r4) => {
          if (!e4 && r4 && r4[0]) {
            await enviar({
              rid,
              to: r4[0].usuario_correo,
              subject: "Cancelación de tu cita médica",
              html: tplCancelacion({ fecha: cita_fecha, hora: cita_hora }),
              category: "citas-cancelacion"
            });
          }
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

// Registrar horario (reserva/creación)
app.post("/horario/registrar", (req, res) => {
  const rid = req.rid;
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;

  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  console.log(`[HORARIO ${rid}] registrar -> medico=${id_medico} fecha=${horario_fecha} hora=${horario_horas} esp=${id_especialidad}`);

  const horario_estado = 0; // libre por defecto
  const q = `
    INSERT INTO horarios_medicos 
      (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, ?, ?)
  `;
  conexion.query(q, [id_medico, horario_horas, horario_fecha, horario_estado, id_especialidad], (err, result) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        console.warn(`[HORARIO ${rid}] duplicado`);
        return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      }
      console.error(`[HORARIO ${rid}] ERROR registrar:`, err.message);
      return res.status(500).json({ error: "Error interno al registrar el horario" });
    }
    console.log(`[HORARIO ${rid}] registrado id=${result.insertId}`);
    res.json({ mensaje: "Horario registrado correctamente", id_horario: result.insertId });
  });
});

// Actualizar horario (mueve hora/fecha)
app.put("/horario/actualizar/:id_horario", (req, res) => {
  const rid = req.rid;
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;

  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });
  }

  console.log(`[HORARIO ${rid}] actualizar -> id=${id_horario} medico=${id_medico} nueva=${fecha_nueva} ${hora_nueva} esp=${id_especialidad}`);

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
        if (e3) {
          console.error(`[HORARIO ${rid}] ERROR actualizar:`, e3.message);
          return res.status(500).json({ mensaje: "Error al actualizar el horario" });
        }
        res.json({ mensaje: "Horario actualizado correctamente" });
      });
    });
  });
});

// Editar / eliminar / ocupar horario puntual
app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const rid = req.rid;
  const { id_medico, fecha, hora } = req.params;
  const { accion, nuevaHora, id_especialidad } = req.body;

  console.log(`[HORARIO ${rid}] editar -> medico=${id_medico} fecha=${fecha} hora=${hora} accion=${accion}`);

  if (!accion) return res.status(400).json({ mensaje: "Acción requerida" });

  if (accion === "eliminar") {
    const q = `
      DELETE FROM horarios_medicos 
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? ${id_especialidad ? "AND id_especialidad = ?" : ""}
    `;
    const params = id_especialidad ? [id_medico, fecha, hora, id_especialidad] : [id_medico, fecha, hora];
    conexion.query(q, params, (err, r) => {
      if (err) return res.status(500).json({ mensaje: "Error al eliminar horario" });
      console.log(`[HORARIO ${rid}] eliminado -> afectadas=${r.affectedRows}`);
      return res.json({ mensaje: "Horario eliminado correctamente" });
    });
  } else if (accion === "actualizar") {
    if (!nuevaHora || !id_especialidad) return res.status(400).json({ mensaje: "Datos incompletos" });
    const q = `
      UPDATE horarios_medicos SET horario_hora = ?, horario_estado = 0
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ? AND id_especialidad = ?
    `;
    conexion.query(q, [nuevaHora, id_medico, fecha, hora, id_especialidad], (err, r) => {
      if (err) return res.status(500).json({ mensaje: "Error al actualizar horario" });
      console.log(`[HORARIO ${rid}] actualizado -> afectadas=${r.affectedRows}`);
      return res.json({ mensaje: "Horario actualizado correctamente" });
    });
  } else if (accion === "ocupar") {
    const q = `
      UPDATE horarios_medicos SET horario_estado = 1
      WHERE id_medico = ? AND horario_fecha = ? AND horario_hora = ?
    `;
    conexion.query(q, [id_medico, fecha, hora], (err, r) => {
      if (err) return res.status(500).json({ mensaje: "Error al ocupar horario" });
      console.log(`[HORARIO ${rid}] ocupar -> afectadas=${r.affectedRows}`);
      return res.json({ mensaje: "Horario marcado como ocupado" });
    });
  } else {
    res.status(400).json({ mensaje: "Acción no reconocida" });
  }
});

// ---------- Servidor ----------
app.listen(PORT, () => {
  console.log("Servidor corriendo en el puerto " + PORT);
  console.log(`DEBUG_SQL=${process.env.DEBUG_SQL ? "ON" : "OFF"}`);
});
