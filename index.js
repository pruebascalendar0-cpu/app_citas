// index.js - API Clínica Salud Total (MySQL + Express + Gmail API, hash, reset)
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();
const PUERTO = process.env.PORT || 10000;
app.use(express.json());

/* ============ Request-ID + logs ============ */
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  const t0 = Date.now();
  console.log(`[${req.rid}] -> ${req.method} ${req.originalUrl}`);
  if (["POST", "PUT"].includes(req.method)) { try { console.log(`[${req.rid}] body:`, req.body); } catch {} }
  res.on("finish", () => console.log(`[${req.rid}] <- ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now()-t0}ms)`));
  next();
});

/* ============ Gmail API (sin nodemailer) ============ */
const GMAIL_USER = process.env.GMAIL_USER;
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);
oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

function base64Url(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function enviarMail({ to, subject, html, text, category = "notificaciones" }) {
  const from = `Clínica Salud Total <${GMAIL_USER}>`;
  const plain = text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    // Subject UTF-8 seguro:
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=boundary001",
    `X-Category: ${category}`,
  ].join("\r\n");

  const body =
    `--boundary001\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${plain}\r\n` +
    `--boundary001\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n` +
    `--boundary001--`;

  const raw = base64Url(`${headers}\r\n\r\n${body}`);
  console.log(`[@gmail] intent to=${to} subject="${subject}" cat=${category}`);
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  console.log(`[@gmail] ok id=${r.data.id}`);
  return r.data;
}
const wrap = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;
async function correoConfirmacion(to, fecha, hora) {
  return enviarMail({
    to, subject: "Confirmación de tu cita médica",
    html: wrap(`<h2>Cita confirmada</h2><p>Tu cita ha sido registrada.</p><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-confirmada",
  });
}
async function correoActualizacion(to, fecha, hora) {
  return enviarMail({
    to, subject: "Actualización de tu cita médica",
    html: wrap(`<h2>Cita actualizada</h2><p><b>Nueva fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-actualizada",
  });
}
async function correoCancelacion(to, fecha, hora) {
  return enviarMail({
    to, subject: "Cancelación de tu cita médica",
    html: wrap(`<h2>Cita cancelada</h2><p><b>Fecha:</b> ${fecha}<br><b>Hora:</b> ${hora}</p>`),
    category: "cita-cancelada",
  });
}
async function correoBienvenida(to, nombre) {
  return enviarMail({
    to, subject: "Bienvenido a Clínica Salud Total",
    html: wrap(`<h2>¡Bienvenido, ${nombre}!</h2><p>Tu registro fue exitoso.</p>`),
    category: "bienvenida",
  });
}

/* ============ Helpers (hash + fecha) ============ */
function toYYYYMMDD(v) {
  if (!v) return v;
  const s = String(v);
  if (s.includes("T")) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return s.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function saltHash(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return `${salt}:${hash}`;
}

// --- helpers de password (déjalos cerca de tus otros helpers) ---
function verifyPassword(plain, stored) {
  // stored = "<salt>:<sha256(salt + plain)>"
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = require("crypto")
    .createHash("sha256")
    .update(salt + String(plain))
    .digest("hex");
  return test.toLowerCase() === String(hash || "").toLowerCase();
}

// (opcional: solo si necesitas crear hashes desde Node)
function makePassword(plain) {
  const crypto = require("crypto");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + String(plain)).digest("hex");
  return `${salt}:${hash}`;
}

/* ============ BD ============ */
const conexion = mysql.createConnection({
  host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});
conexion.connect((err) => {
  if (err) throw err;
  console.log("✅ Conexión MySQL OK");
  conexion.query("SET time_zone='-05:00'", () => {});
  conexion.query(`
    CREATE TABLE IF NOT EXISTS reset_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(150) NOT NULL,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (email), INDEX (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`, (e) =>
    e ? console.error("⚠️ reset_codes:", e.message) : console.log("✅ reset_codes lista")
  );
});

app.get("/", (_, res) => res.send("API Clínica Salud Total"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ===== LOGIN (compatible con tu BD actual) =====
// LOGIN robusto (normaliza correo y usa hash <salt>:<sha256>)
app.post("/usuario/login", (req, res) => {
  const correo = String(req.body?.usuario_correo || req.body?.email || "")
    .trim()
    .toLowerCase();
  const pass = String(req.body?.password || "");

  if (!correo || !pass) {
    return res.status(400).json({ mensaje: "Correo y password requeridos" });
  }

  const sql = `
    SELECT
      id_usuario,
      usuario_nombre,
      usuario_apellido,
      usuario_correo,
      usuario_tipo,
      usuario_contrasena_hash
    FROM usuarios
    WHERE LOWER(usuario_correo) = ?
    LIMIT 1
  `;

  conexion.query(sql, [correo], (e, rows) => {
    if (e) return res.status(500).json({ mensaje: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Correo no registrado" });

    const u = rows[0];
    const ok = verifyPassword(pass, u.usuario_contrasena_hash);
    if (!ok) return res.status(401).json({ mensaje: "Contraseña incorrecta" });

    // Login OK
    res.json({
      id_usuario: u.id_usuario,
      usuario_nombre: u.usuario_nombre,
      usuario_apellido: u.usuario_apellido,
      usuario_correo: u.usuario_correo,
      usuario_tipo: u.usuario_tipo,
    });
  });
});

// Registrar paciente
// === Registrar usuario desde Admin (0=Admin,1=Paciente,2=Médico) ===
app.post("/usuario/registrar", (req, res) => {
  const {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena,
    usuario_tipo,       // 0,1,2  ó  "Administrador|Paciente|Médico"
    id_especialidad     // requerido si tipo=2
  } = req.body || {};

  if (!/^\d{8}$/.test(String(usuario_dni||""))) return res.status(400).json({ mensaje: "DNI inválido (8 dígitos)" });
  if (!usuario_nombre || !usuario_apellido) return res.status(400).json({ mensaje: "Nombre y apellido obligatorios" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(usuario_correo||""))) return res.status(400).json({ mensaje: "Correo inválido" });
  if (!usuario_contrasena || String(usuario_contrasena).length < 6) return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  // mapear string a id de rol
  const mapRol = (v) => {
    if (v === 0 || v === 1 || v === 2) return Number(v);
    const s = String(v||"").toLowerCase();
    if (s.startsWith("admin")) return 0;
    if (s.startsWith("pac"))   return 1;
    if (s.startsWith("méd") || s.startsWith("med")) return 2;
    return 1;
  };
  const tipo = mapRol(usuario_tipo);

  const row = {
    usuario_dni,
    usuario_nombre,
    usuario_apellido,
    usuario_correo,
    usuario_contrasena_hash: (function saltHash(p){
      const salt = require("crypto").randomBytes(16).toString("hex");
      const h = require("crypto").createHash("sha256").update(salt + String(p)).digest("hex");
      return `${salt}:${h}`;
    })(usuario_contrasena),
    usuario_tipo: tipo
  };

  conexion.query("INSERT INTO usuarios SET ?", row, (err, r) => {
    if (err) {
      if (err.code === "ER_DUP_ENTRY") {
        if (err.sqlMessage?.includes("usuario_dni")) return res.status(400).json({ mensaje: "DNI ya registrado" });
        if (err.sqlMessage?.includes("usuario_correo")) return res.status(400).json({ mensaje: "Correo ya registrado" });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario" });
    }

    const id_usuario = r.insertId;

    if (tipo === 2) {
      if (!id_especialidad) return res.status(201).json({ mensaje: "Usuario registrado, faltó asignar especialidad", id_usuario });
      conexion.query("INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?)",
        [id_usuario, id_especialidad],
        (e2) => {
          if (e2) return res.status(201).json({ mensaje: "Usuario registrado, no se pudo asignar especialidad", id_usuario });
          res.status(201).json({ mensaje: "Médico registrado correctamente", id_usuario });
        }
      );
    } else {
      res.status(201).json({ mensaje: "Usuario registrado correctamente", id_usuario });
    }
  });
});

// Actualizar (solo nombre, apellido, correo)
// === Editar usuario: solo nombre, apellido, correo (con logs) ===
app.put("/usuario/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { usuario_nombre, usuario_apellido, usuario_correo } = req.body || {};
  console.log(`[usuario/actualizar] -> id=${id}`, { usuario_nombre, usuario_apellido, usuario_correo });

  if (!usuario_nombre || !usuario_apellido || !usuario_correo)
    return res.status(400).json({ mensaje: "Todos los campos son obligatorios" });

  const qVer = `
    SELECT id_usuario FROM usuarios 
    WHERE LOWER(usuario_correo)=LOWER(?) AND id_usuario<>? 
    LIMIT 1
  `;
  conexion.query(qVer, [usuario_correo, id], (e, r) => {
    if (e) {
      console.error("[usuario/actualizar] verificación ERROR:", e.message);
      return res.status(500).json({ mensaje: "Error al verificar correo" });
    }
    if (r.length) return res.status(409).json({ mensaje: "El correo ya está en uso por otro usuario" });

    const qUpd = `
      UPDATE usuarios 
      SET usuario_nombre=?, usuario_apellido=?, usuario_correo=? 
      WHERE id_usuario=?
    `;
    conexion.query(qUpd, [usuario_nombre, usuario_apellido, usuario_correo, id], (e2, r2) => {
      if (e2) {
        console.error("[usuario/actualizar] UPDATE ERROR:", e2.message);
        return res.status(500).json({ mensaje: "Error al actualizar usuario" });
      }
      console.log(`[usuario/actualizar] <- affectedRows=${r2.affectedRows} changedRows=${r2.changedRows}`);
      // changedRows=0 puede significar que enviaste los mismos valores
      res.json({ 
        mensaje: r2.changedRows ? "Usuario actualizado correctamente" : "No hubo cambios",
        changed: !!r2.changedRows
      });
    });
  });
});

// Listado usuarios
app.get("/usuarios", (_, res) => {
  const sql = `SELECT id_usuario, usuario_dni, usuario_nombre, usuario_apellido, usuario_correo, usuario_tipo FROM usuarios ORDER BY id_usuario ASC`;
  conexion.query(sql, (e, rows) => e ? res.status(500).json({ error: "Error al cargar usuarios" }) : res.json({ listaUsuarios: rows }));
});

// Obtener por correo
app.get("/usuario/:correo", (req, res) => {
  const correo = decodeURIComponent(req.params.correo || "");
  conexion.query("SELECT * FROM usuarios WHERE usuario_correo=?", [correo], (e, r) =>
    e ? res.status(500).send(e.message) : (!r.length ? res.status(404).send({ mensaje: "no hay registros" }) : res.json(r[0]))
  );
});

/* ============ RESET POR CÓDIGO (envía por Gmail API) ============ */
const sha256 = (s)=>crypto.createHash("sha256").update(s).digest("hex");
const genCode6 = ()=>Math.floor(100000 + Math.random()*900000).toString();

app.post("/usuario/reset/solicitar", (req, res) => {
  const correo = String(req.body.email ?? req.body.usuario_correo ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok:false, mensaje:"Correo inválido" });

  const qUser = "SELECT id_usuario FROM usuarios WHERE LOWER(usuario_correo)=?";
  conexion.query(qUser, [correo], async (e1, r1) => {
    if (e1) return res.status(500).json({ ok:false, mensaje:"Error en base de datos" });
    if (!r1.length) return res.json({ ok:true, mensaje:"Si el correo existe, se envió un código." });

    const code = genCode6(), codeHash = sha256(code), expiresAt = new Date(Date.now()+15*60*1000);
    conexion.query("INSERT INTO reset_codes (email, code_hash, expires_at) VALUES (?,?,?)", [correo, codeHash, expiresAt], async (e2) => {
      if (e2) return res.status(500).json({ ok:false, mensaje:"No se pudo generar el código" });
      try {
        await enviarMail({
          to: correo,
          subject: "Código de verificación - Restablecer contraseña",
          html: wrap(`<h2>Restablecer contraseña</h2><p>Usa este código (vence en 15 min):</p><p style="font-size:22px;letter-spacing:3px;"><b>${code}</b></p>`),
          category: "reset-password"
        });
        res.json({ ok:true, mensaje:"Código enviado" });
      } catch(e) {
        res.status(500).json({ ok:false, mensaje:"No se pudo enviar el código" });
      }
    });
  });
});

app.post("/usuario/reset/cambiar", (req, res) => {
  const correo = String(req.body.email ?? req.body.usuario_correo ?? "").trim().toLowerCase();
  const pin = String(req.body.code ?? req.body.codigo ?? "").trim();
  const nueva = String(req.body.new_password ?? req.body.nueva_contrasena ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return res.status(400).json({ ok:false, mensaje:"Correo inválido" });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ ok:false, mensaje:"Código inválido" });
  if (nueva.length < 6) return res.status(400).json({ ok:false, mensaje:"La nueva contraseña debe tener mínimo 6 caracteres." });

  const codeHash = sha256(pin);
  const q = `SELECT id, expires_at, used FROM reset_codes WHERE email=? AND code_hash=? ORDER BY id DESC LIMIT 1`;
  conexion.query(q, [correo, codeHash], (e1, r1) => {
    if (e1) return res.status(500).json({ ok:false, mensaje:"Error en base de datos" });
    if (!r1.length) return res.status(400).json({ ok:false, mensaje:"Código inválido" });
    const row = r1[0];
    if (row.used) return res.status(400).json({ ok:false, mensaje:"Código ya utilizado" });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ ok:false, mensaje:"Código vencido" });

    const newHash = saltHash(nueva);
    conexion.query("UPDATE usuarios SET usuario_contrasena_hash=? WHERE LOWER(usuario_correo)=?",
      [newHash, correo], (e2, r2) => {
        if (e2) return res.status(500).json({ ok:false, mensaje:"No se pudo actualizar la contraseña" });
        if (!r2.affectedRows) return res.status(400).json({ ok:false, mensaje:"No se encontró el usuario" });
        conexion.query("UPDATE reset_codes SET used=1 WHERE id=?", [row.id], ()=>{});
        res.json({ ok:true, mensaje:"Contraseña actualizada" });
      });
  });
});

/* ============ ESPECIALIDADES / MÉDICOS / HORARIOS ============ */
app.get("/especialidades", (_, res) => {
  conexion.query("SELECT * FROM especialidades", (e, r) => e ? res.status(500).json({ error: e.message }) : res.json({ listaEspecialidades: r }));
});

// POST /especialidad/agregar  (compat con tu frontend)
app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });

  const sql = "INSERT INTO especialidades (especialidad_nombre) VALUES (?)";
  conexion.query(sql, [especialidad_nombre], (err, r) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

// PUT /especialidad/actualizar/:id  (compat con tu frontend)
app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body || {};
  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });

  const sql = "UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?";
  conexion.query(sql, [especialidad_nombre, id], (err, r) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    if (!r.affectedRows) return res.status(404).json({ mensaje: "Especialidad no encontrada" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});

// horarios por "fecha&especialidad"
app.get("/horarios/:parametro", (req, res) => {
  const [rawFecha, idEsp] = String(req.params.parametro || "").split("&");
  const fecha = toYYYYMMDD(rawFecha);
  const sql = `
    SELECT h.*, TIME_FORMAT(h.horario_hora,'%H:%i') AS horario_horas,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad = e.id_especialidad
    WHERE h.horario_fecha = STR_TO_DATE(?, '%Y-%m-%d') AND h.id_especialidad=? AND h.horario_estado=0
    ORDER BY h.horario_hora ASC`;
  conexion.query(sql, [fecha, idEsp], (e, r) => e ? res.status(500).json({ error: e.message }) : res.json({ listaHorarios: r }));
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const todas = Array.from({ length: 9 }, (_, i) => `${(8 + i).toString().padStart(2, "0")}:00`);
  const q = `SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=?`;
  conexion.query(q, [id_medico, fecha, id_especialidad], (e, r) => {
    if (e) return res.status(500).json({ error: "Error al consultar horarios" });
    const ocupadas = r.map(x => x.hora);
    res.json({ horariosDisponibles: todas.filter(h => !ocupadas.includes(h)) });
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad", (req, res) => {
  const { id_medico, id_especialidad } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const sql = `
    SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora
    FROM horarios_medicos
    WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND id_especialidad=? AND horario_estado=0
    ORDER BY horario_hora ASC`;
  conexion.query(sql, [id_medico, fecha, id_especialidad], (e, rows) =>
    e ? res.status(500).json({ error: "Error interno del servidor" }) : res.json({ horarios: rows.map(r => r.horario_hora) })
  );
});

// ocupar/liberar/eliminar horario
app.put("/horario/editar/:id_medico/:fecha/:hora", (req, res) => {
  const { id_medico } = req.params;
  const fecha = toYYYYMMDD(req.params.fecha);
  const hora = req.params.hora;
  const { accion } = req.body || {};
  console.log(`[${req.rid}] /horario/editar ->`, { id_medico, fecha, hora, accion });

  if (!/^\d{2}:\d{2}$/.test(hora)) return res.status(400).json({ mensaje: "Hora inválida (HH:mm)" });
  const where = "id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')";
  if (accion === "ocupar")  return conexion.query(`UPDATE horarios_medicos SET horario_estado=1 WHERE ${where}`, [id_medico, fecha, hora], (e) => e?res.status(500).json({mensaje:"Error al ocupar horario"}):res.json({mensaje:"Horario ocupado"}));
  if (accion === "liberar") return conexion.query(`UPDATE horarios_medicos SET horario_estado=0 WHERE ${where}`, [id_medico, fecha, hora], (e) => e?res.status(500).json({mensaje:"Error al liberar horario"}):res.json({mensaje:"Horario liberado"}));
  if (accion === "eliminar") return conexion.query(`DELETE FROM horarios_medicos WHERE ${where}`, [id_medico, fecha, hora], (e) => e?res.status(500).json({mensaje:"Error al eliminar horario"}):res.json({mensaje:"Horario eliminado"}));
  res.status(400).json({ mensaje: "Acción inválida (ocupar|liberar|eliminar)" });
});

/* ============ CITAS ============ */

// Alias claro: /citas/usuario/:id  (igual que /citas/:usuario pero con logs explícitos)
app.get("/citas/usuario/:id", (req, res) => {
  const id = req.params.id;
  console.log(`[citas/usuario] -> id=${id}`);

  const consulta = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,   -- para la tarjeta
           DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS fecha_iso,    -- si la app lo necesita
           TIME_FORMAT(c.cita_hora,'%H:%i')     AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_usuario = ?
    ORDER BY c.id_cita ASC
  `;
  conexion.query(consulta, [id], (error, rows) => {
    if (error) {
      console.error("[citas/usuario] DB ERROR:", error.message);
      return res.status(500).json({ error: error.message });
    }
    const lista = rows.map((c, i) => ({ ...c, numero_orden: i + 1 }));
    console.log(`[citas/usuario] <- ${lista.length} citas (primera:`, lista[0], ")");
    res.json({ listaCitas: lista });
  });
});

app.post("/cita/agregar", (req, res) => {
  let { id_usuario, id_medico, cita_fecha, cita_hora } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  console.log(`[${req.rid}] /cita/agregar saneado:`, { id_usuario, id_medico, cita_fecha, cita_hora });

  conexion.query("SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?", [id_usuario], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al calcular número de orden" });
    const numero_orden = (r1[0]?.total || 0) + 1;

    const ins = `INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden) VALUES (?, ?, STR_TO_DATE(?, '%Y-%m-%d'), STR_TO_DATE(?, '%H:%i'), ?)`;
    conexion.query(ins, [id_usuario, id_medico, cita_fecha, cita_hora, numero_orden], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al registrar la cita" });

      const ocu = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(ocu, [id_medico, cita_fecha, cita_hora], () => {});

      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e3, r3) => {
        if (e3 || !r3.length) return res.status(404).json({ error: "Usuario no encontrado" });
        correoConfirmacion(r3[0].usuario_correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const { id } = req.params;
  let { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body || {};
  cita_fecha = toYYYYMMDD(cita_fecha);
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });

  conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?", [id_usuario], (e0, r0) => {
    if (e0 || !r0.length) return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    const correo = r0[0].usuario_correo;

    const ant = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?`;
    conexion.query(ant, [id], (e1, r1) => {
      if (e1 || !r1.length) return res.status(500).json({ mensaje: "Error al obtener horario anterior" });
      const a = r1[0];

      const lib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(lib, [a.id_medico, a.cita_fecha, a.cita_hora], () => {});

      const upd = `UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=STR_TO_DATE(?, '%Y-%m-%d'), cita_hora=STR_TO_DATE(?, '%H:%i'), cita_estado=? WHERE id_cita=?`;
      conexion.query(upd, [id_usuario, id_medico, cita_fecha, cita_hora, (cita_estado ?? 1), id], (e2) => {
        if (e2) return res.status(500).json({ mensaje: "Error al actualizar la cita" });

        const ocu = `UPDATE horarios_medicos SET horario_estado=1 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
        conexion.query(ocu, [id_medico, cita_fecha, cita_hora], () => {});
        correoActualizacion(correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const q = `SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS cita_fecha, TIME_FORMAT(cita_hora,'%H:%i') AS cita_hora, id_medico FROM citas WHERE id_cita=?`;
  conexion.query(q, [id_cita], (e1, r1) => {
    if (e1 || !r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    const { cita_fecha, cita_hora, id_medico } = r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });
      const lib = `UPDATE horarios_medicos SET horario_estado=0 WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(lib, [id_medico, cita_fecha, cita_hora], () => res.json({ mensaje: "Cita cancelada y horario liberado" }));
    });
  });
});

// === Cancelar por (id_usuario, numero_orden) ===
app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;

  const sel = `
    SELECT id_cita, id_medico,
           DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha,
           TIME_FORMAT(cita_hora ,'%H:%i')    AS hora,
           cita_estado
    FROM citas
    WHERE id_usuario=? AND numero_orden=? 
    LIMIT 1;
  `;

  conexion.query(sel, [id_usuario, numero_orden], (e1, r1) => {
    if (e1) return res.status(500).json({ error: "Error al buscar la cita" });
    if (!r1.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const c = r1[0];
    if (Number(c.cita_estado) === 0) {
      // aquí sí devolvemos que ya estaba cancelada
      return res.status(409).json({ mensaje: "La cita ya estaba cancelada" });
    }

    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?", [c.id_cita], (e2) => {
      if (e2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const lib = `
        UPDATE horarios_medicos SET horario_estado=0
        WHERE id_medico=? AND horario_fecha=STR_TO_DATE(?, '%Y-%m-%d') 
          AND horario_hora=STR_TO_DATE(?, '%H:%i')`;
      conexion.query(lib, [c.id_medico, c.fecha, c.hora], (e3) => {
        if (e3) return res.status(500).json({ error: "Error al liberar el horario" });
        res.json({ mensaje: "Cita cancelada exitosamente" });
      });
    });
  });
});

// GET /cita/usuario/:id_usuario/orden/:numero_orden
// === Buscar 1 cita por (id_usuario, numero_orden) con fecha ISO ===
// === Buscar 1 cita por (id_usuario, numero_orden) con campos EXACTOS ===
app.get("/cita/usuario/:id_usuario/orden/:numero_orden", (req, res) => {
  const { id_usuario, numero_orden } = req.params;
  console.log(`[cita/usuario/orden] -> u=${id_usuario} n=${numero_orden}`);

  const sql = `
    SELECT 
      c.id_cita AS IdCita,
      CONCAT(u.usuario_nombre,' ',u.usuario_apellido) AS UsuarioCita,
      e.especialidad_nombre AS Especialidad,
      CONCAT(mu.usuario_nombre,' ',mu.usuario_apellido) AS Medico,
      DATE_FORMAT(c.cita_fecha,'%Y-%m-%d') AS FechaCita,   -- <- YYYY-MM-DD
      TIME_FORMAT(c.cita_hora,'%H:%i')       AS HoraCita,   -- <- HH:mm
      c.cita_estado
    FROM citas c
    INNER JOIN usuarios u  ON u.id_usuario = c.id_usuario
    INNER JOIN medicos m   ON m.id_medico  = c.id_medico
    INNER JOIN usuarios mu ON mu.id_usuario= m.id_medico
    INNER JOIN especialidades e ON e.id_especialidad = m.id_especialidad
    WHERE c.id_usuario=? AND c.numero_orden=?
    LIMIT 1
  `;

  conexion.query(sql, [id_usuario, numero_orden], (err, rows) => {
    if (err) {
      console.error("[cita/usuario/orden] DB ERROR:", err.message);
      return res.status(500).json({ error: "Error en la base de datos" });
    }
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const r = rows[0];
    console.log("[cita/usuario/orden] <-", r);
    res.json({
      IdCita: r.IdCita,
      UsuarioCita: r.UsuarioCita,
      Especialidad: r.Especialidad,
      Medico: r.Medico,
      FechaCita: r.FechaCita,   // <- usa este campo en Android
      HoraCita:  r.HoraCita,
      EstadoCita: r.cita_estado === 1 ? "Confirmada" : "Cancelada",
    });
  });
});

// GET /citamedica/:id_cita
app.get("/citamedica/:id_cita", (req, res) => {
  const { id_cita } = req.params;
  const consulta = `
    SELECT 
      cit.id_cita                                   AS IdCita,
      CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
      esp.especialidad_nombre                       AS Especialidad,
      CONCAT(med.usuario_nombre,' ',med.usuario_apellido) AS Medico,
      DATE_FORMAT(cit.cita_fecha,'%d/%m/%Y')        AS FechaCita,     -- UI
      DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d')        AS FechaCitaISO,  -- ISO
      TIME_FORMAT(cit.cita_hora,'%H:%i')            AS HoraCita
    FROM citas cit
    INNER JOIN usuarios us  ON us.id_usuario  = cit.id_usuario
    INNER JOIN medicos m    ON m.id_medico    = cit.id_medico
    INNER JOIN usuarios med ON med.id_usuario = m.id_medico
    INNER JOIN especialidades esp ON esp.id_especialidad = m.id_especialidad
    WHERE cit.id_cita = ?`;
  conexion.query(consulta, [id_cita], (err, rows) => {
    if (err) return res.status(500).json({ error: "Error en la base de datos" });
    if (!rows.length) return res.status(404).json({ mensaje: "Cita no encontrada" });
    res.json(rows[0]);
  });
});

// Citas por usuario
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
  conexion.query(sql, [usuario], (e, rows) => e ? res.status(500).json({ error: e.message }) : res.json({ listaCitas: rows.map((x,i)=>({ ...x, numero_orden: i+1 })) }));
});

// KPI citas/día
app.get("/citas/por-dia", (_, res) => {
  const q = `SELECT DATE_FORMAT(cita_fecha, '%Y-%m-%d') AS fecha, COUNT(*) AS cantidad FROM citas WHERE cita_estado=1 GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  conexion.query(q, (e, rows) => e ? res.status(500).json({ error: "Error en la base de datos" }) : res.json({ listaCitas: rows.map(r => ({ fecha: r.fecha, cantidad: r.cantidad })) }));
});

// GET /citas  -> todas para admin
app.get("/citas", (_, res) => {
  const q = `
  SELECT 
    ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha, c.cita_hora) AS numero_cita,
    c.id_cita,
    u.usuario_nombre AS paciente_nombre, u.usuario_apellido AS paciente_apellido,
    DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
    TIME_FORMAT(c.cita_hora, '%H:%i') AS cita_hora,
    e.especialidad_nombre,
    mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido,
    c.cita_estado
  FROM citas c
  INNER JOIN usuarios u  ON c.id_usuario = u.id_usuario
  INNER JOIN medicos m   ON c.id_medico  = m.id_medico
  INNER JOIN usuarios mu ON m.id_medico  = mu.id_usuario
  INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
  ORDER BY u.usuario_nombre ASC, numero_cita ASC`;
  conexion.query(q, (e, r) => e ? res.status(500).json({ error: "Error al obtener las citas" })
                               : res.json({ listaCitas: r || [] }));
});

// Mantén /citas/:usuario pero si :usuario === "0" devuelve todas
// (compat con llamadas existentes de tu UI)
const getCitasUsuarioHandler = (req, res) => {
  const { usuario } = req.params;
  if (String(usuario) === "0") return app._router.handle({ ...req, method: "GET", url: "/citas" }, res, () => {});
  const sql = `
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i') AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico = m.id_medico
    INNER JOIN usuarios u ON m.id_medico = u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE c.id_usuario = ?
    ORDER BY c.id_cita ASC`;
  conexion.query(sql, [usuario], (e, rows) =>
    e ? res.status(500).json({ error: e.message })
      : res.json({ listaCitas: rows.map((x,i)=>({ ...x, numero_orden: i+1 })) })
  );
};
app.get("/citas/:usuario", getCitasUsuarioHandler);

// (opcional) Si mantienes /citas/:usuario, deja este log para detectar 0
app.get("/citas/:usuario", (req, res, next) => {
  const u = req.params.usuario;
  if (u === "0") console.warn("[/citas/:usuario] ⚠️ Están llamando con usuario=0 (no mostrará citas del paciente)");
  return next();
});

/* ============ START ============ */
app.listen(PUERTO, () => console.log("🚀 Servidor en puerto " + PUERTO));

module.exports = { toYYYYMMDD, verifyPassword };
