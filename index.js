// index.js
// API Clínica UASC – Express + MySQL2 + Gmail API (googleapis)
// Autor: Grupo 4 – AppMoviles (actualizado para Gmail API y mejoras de citas)

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { google } = require('googleapis');

// ---------------------------
// Configuración de servidor
// ---------------------------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Puerto (Render usa PORT)
const PORT = process.env.PORT || 10000;

// ---------------------------
// MySQL (pool)
// ---------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 8,
  decimalNumbers: true
});

async function db(q, params = []) {
  try {
    const [rows] = await pool.query(q, params);
    return rows;
  } catch (err) {
    console.error('[DB] Error:', err.code || err.message);
    throw err;
  }
}

// ---------------------------
// Gmail API (googleapis)
// ---------------------------
const MAIL_STRATEGY = (process.env.MAIL_STRATEGY || '').toUpperCase(); // "GMAIL_API"
const GMAIL_USER = process.env.EMAIL_USER || ''; // cuenta @gmail.com usada para enviar

const oauth2Client =
  MAIL_STRATEGY === 'GMAIL_API'
    ? new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI
      )
    : null;

if (oauth2Client && process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
}

function toBase64Url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendMail({ to, subject, html, category = 'notificacion' }) {
  if (MAIL_STRATEGY !== 'GMAIL_API') {
    console.log(`[@mail] (mock) to=${to} subject="${subject}" category=${category}`);
    return { ok: true, mock: true };
  }
  if (!oauth2Client) {
    console.warn('[@mail] Gmail API no inicializado.');
    return { ok: false, error: 'gmail_not_ready' };
  }
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const fromDisplay = process.env.EMAIL_FROM || `Clinica Salud <${GMAIL_USER}>`;
    const raw = [
      `From: ${fromDisplay}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset="UTF-8"',
      `X-Category: ${category}`,
      '',
      html || ''
    ].join('\r\n');

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: toBase64Url(raw) }
    });

    console.log(`[@mail] OK to=${to} subject="${subject}" id=${res.data.id}`);
    return { ok: true, id: res.data.id };
  } catch (err) {
    console.error('[@mail] error Gmail API:', err?.message || err);
    return { ok: false, error: err?.message || 'mail_error' };
  }
}

// ---------------------------
// Utils de fechas y logs
// ---------------------------
function todayStr() {
  const d = new Date();
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
function normalizeDate(d) {
  // Acepta "2025-10-11" o "2025/10/11" o con "T00:00:00Z"
  return (d || '').replace('T00:00:00.000Z', '').replace(/\//g, '-');
}
function ok(res, data) {
  return res.status(200).json({ ok: true, data });
}
function fail(res, code = 500, message = 'error') {
  return res.status(code).json({ ok: false, message });
}

// ---------------------------
// Salud del servicio
// ---------------------------
app.head('/', (_, res) => res.status(200).end());
app.get('/', (_, res) => res.status(200).send('API Clínica UASC OK'));

// ---------------------------
// Usuarios (simple)
// ---------------------------
app.get('/usuarios', async (req, res) => {
  console.log('[usuarios] -> consultando');
  try {
    const rows = await db('SELECT * FROM usuarios ORDER BY id_usuario DESC');
    console.log(`[usuarios] -> ${rows.length} usuario(s)`);
    ok(res, rows);
  } catch {
    fail(res, 500, 'db_error');
  }
});

app.post('/usuario/login', async (req, res) => {
  const { usuario_correo = '', password = '' } = req.body || {};
  console.log('/usuario/login body:', { usuario_correo, password: password ? '(len)' : '' });
  if (!usuario_correo || !password) return fail(res, 400, 'email_y_password_requeridos');

  try {
    const rows = await db(
      'SELECT id_usuario, usuario_nombre, usuario_rol, usuario_correo FROM usuarios WHERE usuario_correo=? AND usuario_password=? LIMIT 1',
      [usuario_correo, password]
    );
    if (rows.length === 0) return fail(res, 401, 'credenciales_invalidas');
    ok(res, rows[0]);
  } catch {
    fail(res, 500, 'db_error');
  }
});

// ---------------------------
// Especialidades (incluye rutas que te marcaban 404)
// ---------------------------
app.get('/especialidades', async (req, res) => {
  try {
    const rows = await db('SELECT * FROM especialidades ORDER BY id_especialidad DESC');
    ok(res, rows);
  } catch {
    fail(res, 500, 'db_error');
  }
});

app.post('/especialidad/agregar', async (req, res) => {
  const { especialidad_nombre = '' } = req.body || {};
  if (!especialidad_nombre) return fail(res, 400, 'nombre_requerido');
  try {
    const r = await db('INSERT INTO especialidades (especialidad_nombre) VALUES (?)', [
      especialidad_nombre
    ]);
    ok(res, { id_especialidad: r.insertId, especialidad_nombre });
  } catch {
    fail(res, 500, 'db_error');
  }
});

app.put('/especialidad/actualizar/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  const { especialidad_nombre = '' } = req.body || {};
  if (!id || !especialidad_nombre) return fail(res, 400, 'datos_invalidos');
  try {
    const r = await db('UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?', [
      especialidad_nombre,
      id
    ]);
    if (r.affectedRows === 0) return fail(res, 404, 'no_encontrado');
    ok(res, { id_especialidad: id, especialidad_nombre });
  } catch {
    fail(res, 500, 'db_error');
  }
});

// ---------------------------
// Horarios y disponibilidad
// ---------------------------

// Obtiene horarios disponibles para un médico en una fecha.
// URL usada en tu app: /horarios/2025-10-11&1  (fecha & id_medico)
app.get('/horarios/:fecha&:id_medico', async (req, res) => {
  const fecha = normalizeDate(req.params.fecha || todayStr());
  const id_medico = Number(req.params.id_medico || 0);

  try {
    // Slots base (puedes ajustar aquí tu plantilla de horarios)
    const baseSlots = [];
    const start = 8; // 08:00
    const end = 17; // 17:00
    for (let h = start; h < end; h++) {
      baseSlots.push(`${String(h).padStart(2, '0')}:00`);
      baseSlots.push(`${String(h).padStart(2, '0')}:30`);
    }

    // Ocupados por citas
    const citas = await db(
      'SELECT cita_hora FROM citas WHERE id_medico=? AND cita_fecha=? AND cita_estado IN (1,2,3,4)',
      [id_medico, fecha]
    );
    const ocupados = new Set(citas.map((r) => r.cita_hora));

    // Bloqueos manuales (si tienes una tabla; si no, ignora)
    await db(
      'CREATE TABLE IF NOT EXISTS horarios_bloqueados (id INT AUTO_INCREMENT PRIMARY KEY, id_medico INT NOT NULL, fecha DATE NOT NULL, hora VARCHAR(5) NOT NULL, UNIQUE KEY uk(id_medico, fecha, hora))'
    );
    const blq = await db(
      'SELECT hora FROM horarios_bloqueados WHERE id_medico=? AND fecha=?',
      [id_medico, fecha]
    );
    blq.forEach((b) => ocupados.add(b.hora));

    const disponibles = baseSlots.filter((h) => !ocupados.has(h));
    ok(res, { fecha, id_medico, disponibles });
  } catch (err) {
    console.error('/horarios error:', err.message);
    fail(res, 500, 'db_error');
  }
});

// Ocupar / liberar un slot manualmente
// Uso visto: PUT /horario/editar/2/2025-10-11T00:00:00.000Z/15:00  body:{accion:"ocupar"|"liberar"}
app.put('/horario/editar/:id_medico/:fecha/:hora', async (req, res) => {
  const id_medico = Number(req.params.id_medico || 0);
  const fecha = normalizeDate(req.params.fecha || todayStr());
  const hora = (req.params.hora || '').slice(0, 5);
  const accion = (req.body?.accion || '').toLowerCase();

  try {
    await db(
      'CREATE TABLE IF NOT EXISTS horarios_bloqueados (id INT AUTO_INCREMENT PRIMARY KEY, id_medico INT NOT NULL, fecha DATE NOT NULL, hora VARCHAR(5) NOT NULL, UNIQUE KEY uk(id_medico, fecha, hora))'
    );

    let affected = 0;
    if (accion === 'ocupar') {
      const r = await db(
        'INSERT IGNORE INTO horarios_bloqueados (id_medico, fecha, hora) VALUES (?,?,?)',
        [id_medico, fecha, hora]
      );
      affected = r.affectedRows;
    } else if (accion === 'liberar') {
      const r = await db(
        'DELETE FROM horarios_bloqueados WHERE id_medico=? AND fecha=? AND hora=?',
        [id_medico, fecha, hora]
      );
      affected = r.affectedRows;
    } else {
      return fail(res, 400, 'accion_invalida');
    }
    ok(res, { id_medico, fecha, hora, accion, affected });
  } catch (err) {
    console.error('/horario/editar error:', err.message);
    fail(res, 500, 'db_error');
  }
});

// ---------------------------
// Citas
// ---------------------------

// Lista por día (si no envías fecha => hoy). En tu log: GET /citas/por-dia
app.get('/citas/por-dia', async (req, res) => {
  const fecha = normalizeDate(req.query.fecha || todayStr());
  console.log('/citas/por-dia ->', fecha);
  try {
    const rows = await db(
      `SELECT c.*, u.usuario_nombre, u.usuario_correo, m.medico_nombre
       FROM citas c
       LEFT JOIN usuarios u ON u.id_usuario=c.id_usuario
       LEFT JOIN medicos m ON m.id_medico=c.id_medico
       WHERE c.cita_fecha=?
       ORDER BY c.cita_hora ASC`,
      [fecha]
    );
    ok(res, rows);
  } catch (err) {
    console.error('/citas/por-dia error:', err.message);
    ok(res, []); // devuelve lista vacía en vez de 500
  }
});

// Obtener por ID (tu log muestra /citas/0 fallando; devolvemos 404 en vez de 500)
app.get('/citas/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  console.log(`/citas/${id} -> consultando`);
  if (!id) return fail(res, 404, 'no_encontrado');
  try {
    const rows = await db('SELECT * FROM citas WHERE id_cita=? LIMIT 1', [id]);
    if (rows.length === 0) return fail(res, 404, 'no_encontrado');
    ok(res, rows[0]);
  } catch {
    fail(res, 500, 'db_error');
  }
});

// Crear cita (tu payload observado)
app.post('/cita/agregar', async (req, res) => {
  const {
    id_usuario,
    id_medico,
    cita_fecha,
    cita_hora,
    usuario_correo = ''
  } = (req.body || {});

  const clean = {
    id_usuario: Number(id_usuario || 0),
    id_medico: Number(id_medico || 0),
    cita_fecha: normalizeDate(cita_fecha),
    cita_hora: (cita_hora || '').slice(0, 5)
  };
  console.log('/cita/agregar payload saneado:', clean);

  if (!clean.id_usuario || !clean.id_medico || !clean.cita_fecha || !clean.cita_hora) {
    return fail(res, 400, 'datos_invalidos');
  }

  try {
    // numero_orden = cantidad de citas ya registradas para ese médico y fecha + 1
    const count = await db(
      'SELECT COUNT(*) AS n FROM citas WHERE id_medico=? AND cita_fecha=?',
      [clean.id_medico, clean.cita_fecha]
    );
    const numero_orden = Number(count[0]?.n || 0) + 1;
    console.log('/cita/agregar numero_orden calculado:', numero_orden);

    const r = await db(
      `INSERT INTO citas (id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, numero_orden)
       VALUES (?, ?, ?, ?, 1, ?)`,
      [clean.id_usuario, clean.id_medico, clean.cita_fecha, clean.cita_hora, numero_orden]
    );

    // Marcar el slot como bloqueado para evitar doble reserva "manual"
    await db(
      'INSERT IGNORE INTO horarios_bloqueados (id_medico, fecha, hora) VALUES (?,?,?)',
      [clean.id_medico, clean.cita_fecha, clean.cita_hora]
    );

    // Email (buscamos correo si no vino en body)
    let to = usuario_correo;
    if (!to) {
      const u = await db('SELECT usuario_correo FROM usuarios WHERE id_usuario=?', [
        clean.id_usuario
      ]);
      to = u[0]?.usuario_correo || '';
    }
    console.log('/cita/agregar correo a:', to || '(sin correo)');

    if (to) {
      await sendMail({
        to,
        subject: 'Confirmación de tu cita médica',
        category: 'cita-confirmada',
        html: `
          <div style="font-family:Arial,Helvetica,sans-serif">
            <h2>Tu cita fue registrada ✅</h2>
            <p><b>Fecha:</b> ${clean.cita_fecha}</p>
            <p><b>Hora:</b> ${clean.cita_hora}</p>
            <p><b>N° de orden:</b> ${numero_orden}</p>
            <p>Gracias por confiar en Clínica Salud.</p>
          </div>
        `
      });
    }

    ok(res, { id_cita: r.insertId, numero_orden, ...clean });
  } catch (err) {
    console.error('/cita/agregar error:', err.message);
    fail(res, 500, 'db_error');
  }
});

// Obtener cita por usuario + orden (tu app consulta /cita/usuario/:id/orden/:orden)
app.get('/cita/usuario/:id_usuario/orden/:orden', async (req, res) => {
  const id_usuario = Number(req.params.id_usuario || 0);
  const orden = Number(req.params.orden || 0);
  if (!id_usuario || !orden) return fail(res, 400, 'datos_invalidos');
  try {
    const rows = await db(
      'SELECT * FROM citas WHERE id_usuario=? AND numero_orden=? ORDER BY id_cita DESC LIMIT 1',
      [id_usuario, orden]
    );
    if (rows.length === 0) return fail(res, 404, 'no_encontrado');
    ok(res, rows[0]);
  } catch {
    fail(res, 500, 'db_error');
  }
});

// Editar/rehabilitar cita
app.put('/cita/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  const { cita_fecha, cita_hora, cita_estado } = req.body || {};
  if (!id) return fail(res, 400, 'id_invalido');

  try {
    const set = [];
    const vals = [];
    if (cita_fecha) {
      set.push('cita_fecha=?');
      vals.push(normalizeDate(cita_fecha));
    }
    if (cita_hora) {
      set.push('cita_hora=?');
      vals.push(cita_hora.slice(0, 5));
    }
    if (typeof cita_estado !== 'undefined') {
      set.push('cita_estado=?');
      vals.push(Number(cita_estado));
    }
    if (!set.length) return fail(res, 400, 'sin_cambios');

    vals.push(id);
    const r = await db(`UPDATE citas SET ${set.join(', ')} WHERE id_cita=?`, vals);
    if (r.affectedRows === 0) return fail(res, 404, 'no_encontrado');

    ok(res, { id_cita: id, actualizado: true });
  } catch (err) {
    console.error('/cita/:id PUT error:', err.message);
    fail(res, 500, 'db_error');
  }
});

// Cancelar cita
app.delete('/cita/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return fail(res, 400, 'id_invalido');

  try {
    const rows = await db('SELECT * FROM citas WHERE id_cita=? LIMIT 1', [id]);
    if (rows.length === 0) return fail(res, 404, 'no_encontrado');
    const c = rows[0];

    await db('UPDATE citas SET cita_estado=0 WHERE id_cita=?', [id]); // 0 = cancelada
    await db('DELETE FROM horarios_bloqueados WHERE id_medico=? AND fecha=? AND hora=?', [
      c.id_medico,
      c.cita_fecha,
      c.cita_hora
    ]);

    // Notificar
    const u = await db('SELECT usuario_correo FROM usuarios WHERE id_usuario=?', [c.id_usuario]);
    const to = u[0]?.usuario_correo || '';
    if (to) {
      await sendMail({
        to,
        subject: 'Tu cita fue cancelada',
        category: 'cita-cancelada',
        html: `
          <div style="font-family:Arial,Helvetica,sans-serif">
            <h2>Cita cancelada ❌</h2>
            <p>Fecha: ${c.cita_fecha}</p>
            <p>Hora: ${c.cita_hora}</p>
            <p>Si no fuiste tú, por favor contáctanos.</p>
          </div>
        `
      });
    }

    ok(res, { id_cita: id, cancelada: true });
  } catch (err) {
    console.error('/cita/:id DELETE error:', err.message);
    fail(res, 500, 'db_error');
  }
});

// ---------------------------
// Arranque
// ---------------------------
(async () => {
  try {
    // Verifica conexión DB
    await pool.query('SELECT 1');
    console.log('✅ Conexión MySQL OK');

    // Tablas auxiliares si faltan (no rompe si ya existen)
    await db(
      `CREATE TABLE IF NOT EXISTS reset_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_correo VARCHAR(255) NOT NULL,
        code VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    );

    app.listen(PORT, () => {
      console.log(`🚀 Servidor en puerto ${PORT}`);
      console.log(`📧 Mail strategy: ${MAIL_STRATEGY || 'disabled'}`);
    });
  } catch (err) {
    console.error('❌ Error inicializando servidor:', err.message);
    process.exit(1);
  }
})();
