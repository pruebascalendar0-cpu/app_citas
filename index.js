require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());

// ------- request-id en logs ------
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  next();
});

// ------- Email (Gmail App Password) ------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
});

// ------- DB -------
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

db.connect((err) => {
  if (err) {
    console.error("[DB] Error de conexión:", err.message);
    process.exit(1);
  }
  console.log("[DB] Conexión OK");
});

app.get("/", (_req, res) => res.send("Servicio de Citas OK"));

// ===================== UTIL CORREOS =====================
function enviarHTML(rid, to, subject, html) {
  const from = `"Clínica Salud Total" <${process.env.EMAIL_USER || "no-reply@clinica.com"}>`;
  return transporter
    .sendMail({ from, to, subject, html })
    .then((info) => console.log(`[MAIL ${rid}] OK: ${info.response}`))
    .catch((e) => console.error(`[MAIL ${rid}] ERROR:`, e.message));
}

const tplConfirm = ({ fecha, hora }) =>
  `<h2 style="color:#2e86de">¡Cita confirmada!</h2><p><b>Fecha:</b> ${fecha}</p><p><b>Hora:</b> ${hora}</p>`;
const tplUpdate = ({ fecha, hora }) =>
  `<h2 style="color:#f39c12">¡Cita actualizada!</h2><p><b>Nueva fecha:</b> ${fecha}</p><p><b>Hora:</b> ${hora}</p>`;
const tplCancel = ({ fecha, hora }) =>
  `<h2 style="color:#c0392b">Cita cancelada</h2><p><b>Fecha:</b> ${fecha}</p><p><b>Hora:</b> ${hora}</p>`;

// ===================== USUARIOS =====================

// Listado para probar desde navegador
app.get("/usuarios", (_req, res) => {
  const q =
    "SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo FROM usuarios";
  db.query(q, (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error listando usuarios" });
    res.json({ listaUsuarios: r || [] });
  });
});

// Buscar por correo (lo usa tu WebService)
app.get("/usuario/:correo", (req, res) => {
  const { correo } = req.params;
  const q = `SELECT id_usuario, usuario_nombre, usuario_apellido, usuario_correo, usuario_dni, usuario_tipo 
             FROM usuarios WHERE usuario_correo = ?`;
  db.query(q, [correo], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error del servidor" });
    if (!r || !r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    // tu app espera un objeto Usuario simple
    res.json(r[0]);
  });
});

// Registrar (igual que antes)
app.post("/usuario/agregar", (req, res) => {
  const rid = req.rid;
  const { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena } = req.body;

  if (!/^\d{8}$/.test(usuario_dni))
    return res.status(400).json({ mensaje: "El DNI debe tener 8 dígitos" });
  if (!usuario_nombre || !usuario_apellido || !usuario_correo || !usuario_contrasena)
    return res.status(400).json({ mensaje: "Faltan datos" });

  const q = "INSERT INTO usuarios SET ?";
  db.query(
    q,
    { usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_contrasena },
    (err) => {
      if (err) {
        if (err.code === "ER_DUP_ENTRY") {
          return res.status(400).json({ mensaje: "DNI o correo ya registrado" });
        }
        return res.status(500).json({ mensaje: "Error al registrar usuario" });
      }
      enviarHTML(rid, usuario_correo, "Bienvenido a Clínica Salud Total", `<h2>¡Bienvenido ${usuario_nombre}!</h2>`);
      res.json({ mensaje: "Usuario registrado correctamente." });
    }
  );
});

// Recuperar correo
app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  const q =
    "SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?";
  db.query(q, [usuario_dni, usuario_nombre, usuario_apellido], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno" });
    if (!r || !r.length) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: r[0].usuario_correo });
  });
});

// (Opcional) recuperar-contrasena legado si lo usas
app.post("/usuario/recuperar-contrasena", (req, res) => {
  const rid = req.rid;
  const { usuario_correo } = req.body;
  const q = "SELECT usuario_nombre, usuario_apellido, usuario_contrasena FROM usuarios WHERE usuario_correo=?";
  db.query(q, [usuario_correo], async (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno" });
    if (!r || !r.length) return res.status(404).json({ mensaje: "Correo no registrado" });
    const u = r[0];
    await enviarHTML(
      rid,
      usuario_correo,
      "Recuperación de contraseña",
      `<p>Hola ${u.usuario_nombre} ${u.usuario_apellido}</p><p>Tu contraseña actual es: <b>${u.usuario_contrasena}</b></p>`
    );
    res.json({ mensaje: "Correo de recuperación enviado" });
  });
});

// ===================== ESPECIALIDADES / HORARIOS =====================

app.get("/especialidades", (_req, res) => {
  db.query("SELECT * FROM especialidades", (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// OJO: se corrigió el typo h.* (antes estaba `h.,`)
app.get("/horarios/:parametro", (req, res) => {
  const [fecha, id_especialidad] = req.params.parametro.split("&");
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
    WHERE h.horario_fecha = ? AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC`;
  db.query(sql, [fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ listaHorarios: r });
  });
});

app.post("/horario/registrar", (req, res) => {
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;
  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad)
    return res.status(400).json({ error: "Faltan datos obligatorios" });

  const sql = `
    INSERT INTO horarios_medicos (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, 0, ?)`;
  db.query(sql, [id_medico, horario_horas, horario_fecha, id_especialidad], (e, r) => {
    if (e) {
      if (e.code === "ER_DUP_ENTRY")
        return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
      return res.status(500).json({ error: "Error al registrar horario" });
    }
    res.json({ mensaje: "Horario registrado correctamente", id_horario: r.insertId });
  });
});

app.put("/horario/actualizar/:id_horario", (req, res) => {
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;
  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad)
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });

  const qSel = "SELECT horario_fecha, horario_hora FROM horarios_medicos WHERE id_horario=?";
  db.query(qSel, [id_horario], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Horario no encontrado" });

    const qLib = `UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?`;
    db.query(qLib, [r1[0].horario_fecha, r1[0].horario_hora, id_medico], () => {
      const qUpd = `UPDATE horarios_medicos SET horario_fecha=?, horario_hora=?, horario_estado=1, id_especialidad=? WHERE id_horario=?`;
      db.query(qUpd, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar el horario" });
        res.json({ mensaje: "Horario actualizado correctamente" });
      });
    });
  });
});

// Horarios auxiliares
app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const todas = Array.from({ length: 9 }, (_, i) => `${String(8 + i).padStart(2, "0")}:00`);
  const q = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`;
  db.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map((x) => x.hora);
    res.json({ horariosDisponibles: todas.filter((h) => !ocupadas.includes(h)) });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, fecha, id_especialidad } = req.params;
  const q = `
    SELECT TIME_FORMAT(horario_hora, '%H:%i') AS hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  db.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error interno" });
    res.json({ horarios: r.map((x) => x.hora) });
  });
});

// ===================== MÉDICOS =====================
app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  const q = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico=?`;
  db.query(q, [id_medico], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: r || [] });
  });
});

// ===================== CITAS =====================

// Para probar en navegador (todas)
app.get("/citas", (_req, res) => {
  const q = `
    SELECT 
      ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha, c.cita_hora) AS numero_cita,
      c.id_cita, c.id_usuario, c.id_medico, c.numero_orden,
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
  db.query(q, (e, r) => {
    if (e) return res.status(500).json({ error: "Error al obtener citas" });
    res.json({ listaCitas: r || [] });
  });
});

// Citas por usuario (lo usa tu APK en “Mis Citas”)
app.get("/citas/:usuario", (req, res) => {
  const { usuario } = req.params;
  const q = `
    SELECT 
      c.id_cita, c.numero_orden,
      DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
      TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
      c.cita_estado,
      e.especialidad_nombre,
      mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios mu ON m.id_medico = mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_usuario = ?
    ORDER BY c.cita_fecha, c.cita_hora`;
  db.query(q, [usuario], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al obtener citas del usuario" });
    res.json({ listaCitas: r || [] });
  });
});

// Citas por médico (usado por WebService)
app.get("/citas/medico/:id_medico", (req, res) => {
  const { id_medico } = req.params;
  const q = `
    SELECT 
      c.id_cita, c.id_usuario, c.numero_orden,
      DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
      TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
      c.cita_estado
    FROM citas c
    WHERE c.id_medico = ?
    ORDER BY c.cita_fecha, c.cita_hora`;
  db.query(q, [id_medico], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al obtener citas del médico" });
    res.json({ listaCitas: r || [] });
  });
});

// Buscar cita por número de orden del usuario
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  const q = `
    SELECT 
      c.id_cita, c.id_usuario, c.id_medico, c.numero_orden,
      DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS cita_fecha,
      TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
      c.cita_estado
    FROM citas c
    WHERE c.id_usuario=? AND c.numero_orden=?`;
  db.query(q, [id_usuario, numero_orden], (e, r) => {
    if (e) return res.status(500).json({ mensaje: "Error del servidor" });
    if (!r || !r.length) return res.status(404).json({ mensaje: "No existe esa cita" });
    // La app espera un objeto (no {lista:[]})
    res.json(r[0]);
  });
});

// Registrar cita
app.post("/cita/agregar", (req, res) => {
  const rid = req.rid;
  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora)
    return res.status(400).json({ error: "Datos incompletos para registrar la cita" });

  // número de orden
  const qOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?";
  db.query(qOrden, [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

    const qIns = "INSERT INTO citas SET ?";
    db.query(
      qIns,
      { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden, cita_estado: 1 },
      (e2) => {
        if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

        // ocupar horario
        const qOcc = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
        db.query(qOcc, [id_medico, cita_fecha, cita_hora], () => {});

        // correo
        db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (e3, r3) => {
          if (!e3 && r3 && r3[0]) {
            await enviarHTML(rid, r3[0].usuario_correo, "Confirmación de tu cita", tplConfirm({ fecha: cita_fecha, hora: cita_hora }));
          }
          res.json({ mensaje: "Cita registrada correctamente", numero_orden });
        });
      }
    );
  });
});

// Actualizar cita
app.put("/cita/actualizar/:id", (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora)
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  const qPrev = "SELECT cita_fecha, cita_hora FROM citas WHERE id_cita=?";
  db.query(qPrev, [id], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const qLib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
    db.query(qLib, [id_medico, r1[0].cita_fecha, r1[0].cita_hora], () => {
      const qUpd = `
        UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=?
        WHERE id_cita=?`;
      db.query(qUpd, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado ?? 1, id], (e3) => {
        if (e3) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const qOcc = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
        db.query(qOcc, [id_medico, cita_fecha, cita_hora], () => {});
        db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e5, r5) => {
          if (r5 && r5[0]) {
            await enviarHTML(rid, r5[0].usuario_correo, "Actualización de tu cita", tplUpdate({ fecha: cita_fecha, hora: cita_hora }));
          }
          res.json({ mensaje: "Cita actualizada correctamente" });
        });
      });
    });
  });
});

// Anular por id_cita
app.put("/cita/anular/:id_cita", (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;

  const qSel = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita=?";
  db.query(qSel, [id_cita], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { cita_fecha, cita_hora, id_medico, id_usuario } = r1[0];
    db.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      db.query(qLib, [id_medico, cita_fecha, cita_hora], () => {
        db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e4, r4) => {
          if (r4 && r4[0]) {
            await enviarHTML(rid, r4[0].usuario_correo, "Cancelación de tu cita", tplCancel({ fecha: cita_fecha, hora: cita_hora }));
          }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

// Anular por usuario + número de orden (usado por la app)
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;

  const qFind = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario=? AND numero_orden=? AND cita_estado=1`;
  db.query(qFind, [id_usuario, numero_orden], (e1, r1) => {
    if (e1 || !r1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = r1[0];
    db.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const qLib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=? AND horario_hora=?`;
      db.query(qLib, [id_medico, cita_fecha, cita_hora], () => {
        db.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], async (_e4, r4) => {
          if (r4 && r4[0]) {
            await enviarHTML(rid, r4[0].usuario_correo, "Cancelación de tu cita", tplCancel({ fecha: cita_fecha, hora: cita_hora }));
          }
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

// ===================== KPIs =====================
app.get("/citas/por-dia", (_req, res) => {
  const q = `
    SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY cita_fecha ORDER BY cita_fecha ASC`;
  db.query(q, (e, r) => {
    if (e) return res.status(500).json({ error: "Error en la base de datos" });
    res.json({ listaCitas: r || [] });
  });
});

// ===================== START =====================
app.listen(PORT, () => console.log("Servidor corriendo en el puerto " + PORT));
