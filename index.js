require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const mysql = require("mysql2");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PUERTO = process.env.PORT || 3000;

app.use(bodyParser.json());

// id de request para correlacionar logs
app.use((req, res, next) => {
  req.rid = crypto.randomUUID().slice(0, 8);
  next();
});

// --------- Email (Gmail SMTP con App Password) ----------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// --------- DB ----------
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
  console.log("[DB] Conexión exitosa a la base de datos");
});

app.get("/", (req, res) => {
  res.send("Bienvenido a mi servicio web");
});

app.listen(PUERTO, () => {
  console.log("Servidor corriendo en el puerto " + PUERTO);
});

/* =========================
 *         CORREOS
 * ========================= */
function enviarCorreo(rid, destinatario, fecha, hora) {
  const mailOptions = {
    from: '"Clínica Salud Total" <' + (process.env.EMAIL_USER || "no-reply@clinica.com") + '>',
    to: destinatario,
    subject: "Confirmación de tu cita médica",
    html: `
      <h2 style="color: #2e86de;">¡Cita médica confirmada!</h2>
      <p>Tu cita ha sido registrada con éxito.</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>`,
  };

  console.log(`[MAIL ${rid}] → to=${destinatario} subject="Confirmación de tu cita médica"`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error(`[MAIL ${rid}] ERROR:`, error.message);
    } else {
      console.log(`[MAIL ${rid}] OK: ${info.response}`);
    }
  });
}

function enviarCorreoBienvenida(rid, destinatario, nombre) {
  const mailOptions = {
    from: '"Clínica Salud Total" <' + (process.env.EMAIL_USER || "no-reply@clinica.com") + '>',
    to: destinatario,
    subject: "Bienvenido a Clínica Salud Total",
    html: `
      <h2 style="color: #2e86de;">¡Bienvenido, ${nombre}!</h2>
      <p>Tu registro en <strong>Clínica Salud Total</strong> ha sido exitoso.</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Registro</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>
    `,
  };

  console.log(`[MAIL ${rid}] → to=${destinatario} subject="Bienvenido a Clínica Salud Total"`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error(`[MAIL ${rid}] ERROR:`, error.message);
    } else {
      console.log(`[MAIL ${rid}] OK: ${info.response}`);
    }
  });
}

function enviarCorreoRecuperacion(rid, destinatario, nombre, contrasena) {
  const mailOptions = {
    from: '"Clínica Salud Total" <' + (process.env.EMAIL_USER || "no-reply@clinica.com") + '>',
    to: destinatario,
    subject: "Recuperación de contraseña - Clínica Salud Total",
    html: `
      <h2 style="color: #e74c3c;">Recuperación de contraseña</h2>
      <p>Hola <strong>${nombre}</strong>, has solicitado recuperar tu contraseña.</p>
      <p><strong>Tu contraseña actual es:</strong> ${contrasena}</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema Atención al Cliente</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>
    `,
  };

  console.log(`[MAIL ${rid}] → to=${destinatario} subject="Recuperación de contraseña"`);
  return new Promise((resolve, reject) => {
    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error(`[MAIL ${rid}] ERROR:`, error.message);
        reject(error);
      } else {
        console.log(`[MAIL ${rid}] OK: ${info.response}`);
        resolve(info);
      }
    });
  });
}

function enviarCorreoActualizacion(rid, destinatario, fecha, hora) {
  const mailOptions = {
    from: '"Clínica Salud Total" <' + (process.env.EMAIL_USER || "no-reply@clinica.com") + '>',
    to: destinatario,
    subject: "Actualización de tu cita médica",
    html: `
      <h2 style="color: #f39c12;">¡Cita médica actualizada!</h2>
      <p>Tu cita ha sido <strong>actualizada</strong> con éxito.</p>
      <p><strong>Nueva Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>
    `,
  };

  console.log(`[MAIL ${rid}] → to=${destinatario} subject="Actualización de tu cita médica"`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error(`[MAIL ${rid}] ERROR:`, error.message);
    } else {
      console.log(`[MAIL ${rid}] OK: ${info.response}`);
    }
  });
}

function enviarCorreoCancelacion(rid, destinatario, fecha, hora) {
  const mailOptions = {
    from: '"Clínica Salud Total" <' + (process.env.EMAIL_USER || "no-reply@clinica.com") + '>',
    to: destinatario,
    subject: "Cancelación de tu cita médica",
    html: `
      <h2 style="color: #c0392b;">Cita cancelada</h2>
      <p>Tu cita médica ha sido <strong>cancelada</strong> correctamente.</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Hora:</strong> ${hora}</p>
      <hr/>
      <footer style="font-size: 0.9em; color: #888; margin-top: 20px;">
        <p><strong>Clínica Salud Total</strong> – Sistema de Citas</p>
        <p>Este es un mensaje automático, no respondas a este correo.</p>
      </footer>
    `,
  };

  console.log(`[MAIL ${rid}] → to=${destinatario} subject="Cancelación de tu cita médica"`);
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error(`[MAIL ${rid}] ERROR:`, error.message);
    } else {
      console.log(`[MAIL ${rid}] OK: ${info.response}`);
    }
  });
}

/* =========================
 *         USUARIOS
 * ========================= */
app.get("/usuarios", (req, res) => {
  const consulta = "SELECT * FROM usuarios";
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error listando usuarios" });
    const obj = {};
    if (rpta.length > 0) {
      obj.listaUsuarios = rpta;
      res.json(obj);
    } else {
      res.json({ mensaje: "no hay registros" });
    }
  });
});

app.post("/usuario/agregar", (req, res) => {
  const rid = req.rid;
  const usuario = {
    usuario_dni: req.body.usuario_dni,
    usuario_nombre: req.body.usuario_nombre,
    usuario_apellido: req.body.usuario_apellido,
    usuario_correo: req.body.usuario_correo,
    usuario_contrasena: req.body.usuario_contrasena,
  };

  // Validaciones básicas
  if (!usuario.usuario_dni || !/^\d{8}$/.test(usuario.usuario_dni))
    return res.status(400).json({ mensaje: "El DNI debe tener exactamente 8 dígitos numéricos." });
  if (!usuario.usuario_nombre || !usuario.usuario_apellido)
    return res.status(400).json({ mensaje: "Nombre y apellido son obligatorios." });
  if (!usuario.usuario_correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario.usuario_correo))
    return res.status(400).json({ mensaje: "Correo electrónico no válido." });
  if (!usuario.usuario_contrasena || usuario.usuario_contrasena.length < 6)
    return res.status(400).json({ mensaje: "La contraseña debe tener al menos 6 caracteres." });

  const consulta = "INSERT INTO usuarios SET ?";
  conexion.query(consulta, usuario, (error) => {
    if (error) {
      if (error.code === "ER_DUP_ENTRY") {
        if (error.sqlMessage.includes("usuario_dni"))
          return res.status(400).json({ mensaje: "DNI ya está registrado" });
        if (error.sqlMessage.includes("usuario_correo"))
          return res.status(400).json({ mensaje: "El correo ya está registrado." });
        return res.status(400).json({ mensaje: "Datos duplicados en campos únicos." });
      }
      return res.status(500).json({ mensaje: "Error al registrar usuario." });
    }

    const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
    enviarCorreoBienvenida(rid, usuario.usuario_correo, nombreCompleto);
    return res.json({ mensaje: "Usuario registrado correctamente." });
  });
});

app.post("/usuario/recuperar-correo", (req, res) => {
  const { usuario_dni, usuario_nombre, usuario_apellido } = req.body;
  const consulta = `
    SELECT usuario_correo FROM usuarios
    WHERE usuario_dni = ? AND usuario_nombre = ? AND usuario_apellido = ?
  `;
  conexion.query(consulta, [usuario_dni, usuario_nombre, usuario_apellido], (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Usuario no encontrado" });
    res.json({ correo: resultados[0].usuario_correo });
  });
});

app.post("/usuario/recuperar-contrasena", (req, res) => {
  const rid = req.rid;
  const { usuario_correo } = req.body;
  const consulta = "SELECT usuario_nombre, usuario_apellido, usuario_contrasena FROM usuarios WHERE usuario_correo = ?";
  conexion.query(consulta, [usuario_correo], async (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error interno del servidor" });
    if (resultados.length === 0) return res.status(404).json({ mensaje: "Correo no registrado" });

    const usuario = resultados[0];
    const nombreCompleto = `${usuario.usuario_nombre} ${usuario.usuario_apellido}`;
    await enviarCorreoRecuperacion(rid, usuario_correo, nombreCompleto, usuario.usuario_contrasena);
    res.json({ mensaje: "Correo de recuperación enviado" });
  });
});

/* =========================
 *         MÉDICOS
 * ========================= */
app.get("/especialidades", (req, res) => {
  const consulta = "SELECT * FROM especialidades";
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error al obtener especialidades" });
    const obj = {};
    if (rpta.length > 0) {
      obj.listaEspecialidades = rpta;
      res.json(obj);
    } else {
      res.json({ mensaje: "no hay registros" });
    }
  });
});

app.get("/horarios/:parametro", (req, res) => {
  const valores = req.params.parametro.split("&");
  const fecha = valores[0];
  const especialidad = valores[1];

  const consulta = `
  SELECT h., 
        TIME_FORMAT(h.horario_hora,'%H:%i') as horario_horas, 
        u.usuario_nombre as medico_nombre, 
        u.usuario_apellido as medico_apellido,
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

app.put("/horario/actualizar/:id_horario", (req, res) => {
  const rid = req.rid;
  const { id_horario } = req.params;
  const { id_medico, fecha_nueva, hora_nueva, id_especialidad } = req.body;

  if (!id_medico || !fecha_nueva || !hora_nueva || !id_especialidad) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar el horario" });
  }

  // 1. Obtener el horario anterior
  const queryHorarioAnterior = `
    SELECT horario_fecha, horario_hora 
    FROM horarios_medicos 
    WHERE id_horario = ?
  `;

  conexion.query(queryHorarioAnterior, [id_horario], (err1, result1) => {
    if (err1 || result1.length === 0) {
      console.error(`[HORARIO ${rid}] ERROR obtener anterior:`, err1 && err1.message);
      return res.status(500).json({ mensaje: "Error al obtener el horario original" });
    }

    const horarioAnterior = result1[0];

    // 2. Liberar horario anterior
    const liberar = `
      UPDATE horarios_medicos 
      SET horario_estado = 0 
      WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
    `;
    conexion.query(liberar, [horarioAnterior.horario_fecha, horarioAnterior.horario_hora, id_medico], (err2, r2) => {
      if (err2) console.warn(`[HORARIO ${rid}] No se pudo liberar anterior:`, err2.message);
      console.log(`[HORARIO ${rid}] liberar -> afectadas=${r2?.affectedRows || 0}`);
    });

    // 3. Actualizar con nuevo horario
    const actualizar = `
      UPDATE horarios_medicos 
      SET horario_fecha = ?, horario_hora = ?, horario_estado = 1, id_especialidad = ?
      WHERE id_horario = ?
    `;
    conexion.query(actualizar, [fecha_nueva, hora_nueva, id_especialidad, id_horario], (err3) => {
      if (err3) {
        console.error(`[HORARIO ${rid}] ERROR actualizar:`, err3.sqlMessage || err3.message);
        return res.status(500).json({ mensaje: "Error al actualizar el horario" });
      }
      console.log(`[HORARIO ${rid}] actualizado -> id_horario=${id_horario} nueva=${fecha_nueva} ${hora_nueva}`);
      res.json({ mensaje: "Horario actualizado correctamente" });
    });
  });
});

app.post("/horario/registrar", (req, res) => {
  const rid = req.rid;
  const { id_medico, horario_horas, horario_fecha, id_especialidad } = req.body;

  if (!id_medico || !horario_horas || !horario_fecha || !id_especialidad) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }
  // libre al registrarse
  const horario_estado = 0;

  const consulta = `
    INSERT INTO horarios_medicos 
      (id_medico, horario_hora, horario_fecha, horario_estado, id_especialidad)
    VALUES (?, ?, ?, ?, ?)
  `;

  conexion.query(
    consulta,
    [id_medico, horario_horas, horario_fecha, horario_estado, id_especialidad],
    (error, resultado) => {
      if (error) {
        if (error.code === "ER_DUP_ENTRY") {
          console.warn(`[HORARIO ${rid}] duplicado medico=${id_medico} ${horario_fecha} ${horario_horas}`);
          return res.status(400).json({ error: "Ese horario ya fue registrado para este médico." });
        }
        console.error(`[HORARIO ${rid}] ERROR registrar:`, error.message);
        return res.status(500).json({ error: "Error interno al registrar el horario" });
      }

      console.log(`[HORARIO ${rid}] registrado -> id=${resultado.insertId} medico=${id_medico} ${horario_fecha} ${horario_horas}`);
      res.json({ mensaje: "Horario registrado correctamente", id_horario: resultado.insertId });
    }
  );
});

app.get("/medico/:id_medico/especialidades", (req, res) => {
  const { id_medico } = req.params;
  const consulta = `
    SELECT e.id_especialidad, e.especialidad_nombre
    FROM medicos m
    INNER JOIN especialidades e ON m.id_especialidad = e.id_especialidad
    WHERE m.id_medico = ?
  `;

  conexion.query(consulta, [id_medico], (err, rpta) => {
    if (err) return res.status(500).json({ error: "Error al obtener especialidades" });
    res.json({ listaEspecialidades: rpta });
  });
});

/* =========================
 *           CITAS
 * ========================= */
app.post("/cita/agregar", (req, res) => {
  const rid = req.rid;
  console.log(`[CITA ${rid}] agregar body=`, req.body);

  const { id_usuario, id_medico, cita_fecha, cita_hora } = req.body;
  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ error: "Datos incompletos para registrar la cita" });
  }

  const consultaOrden = "SELECT COUNT(*) AS total FROM citas WHERE id_usuario = ?";
  conexion.query(consultaOrden, [id_usuario], (error, results) => {
    if (error) {
      console.error(`[CITA ${rid}] ERROR orden:`, error.message);
      return res.status(500).json({ error: "Error interno al calcular el número de orden" });
    }

    const numero_orden = results[0].total + 1;

    const cita = { id_usuario, id_medico, cita_fecha, cita_hora, numero_orden };

    const consultaInsert = "INSERT INTO citas SET ?";
    conexion.query(consultaInsert, cita, (errorInsert) => {
      if (errorInsert) {
        console.error(`[CITA ${rid}] ERROR insertar:`, errorInsert.message);
        return res.status(500).json({ error: "Error al registrar la cita" });
      }

      // Marcar horario como ocupado
      const marcarHorario = `
        UPDATE horarios_medicos SET horario_estado = 1 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(marcarHorario, [cita_fecha, cita_hora, id_medico], (errUpdate, rU) => {
        if (errUpdate) {
          console.warn(`[HORARIO ${rid}] No se pudo ocupar:`, errUpdate.message);
        } else {
          console.log(`[HORARIO ${rid}] ocupar -> afectadas=${rU?.affectedRows || 0}`);
        }
      });

      const consultaCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
      conexion.query(consultaCorreo, [id_usuario], (errorCorreo, resultsCorreo) => {
        if (errorCorreo) {
          console.error(`[MAIL ${rid}] ERROR obtener correo:`, errorCorreo.message);
          return res.status(500).json({ error: "Error interno al obtener el correo" });
        }

        if (resultsCorreo.length === 0) {
          console.warn(`[MAIL ${rid}] Usuario sin correo id=${id_usuario}`);
          return res.status(404).json({ error: "Usuario no encontrado" });
        }

        const destinatario = resultsCorreo[0].usuario_correo;
        enviarCorreo(rid, destinatario, cita_fecha, cita_hora);

        res.json({ mensaje: "Cita registrada correctamente", numero_orden });
      });
    });
  });
});

app.put("/cita/actualizar/:id", (req, res) => {
  const rid = req.rid;
  const { id } = req.params;
  const { id_usuario, id_medico, cita_fecha, cita_hora, cita_estado } = req.body;

  if (!id_usuario || !id_medico || !cita_fecha || !cita_hora) {
    return res.status(400).json({ mensaje: "Datos incompletos para actualizar la cita" });
  }

  console.log(`[CITA ${rid}] actualizar -> id=${id} usuario=${id_usuario} medico=${id_medico} nueva=${cita_fecha} ${cita_hora}`);

  const queryCorreo = "SELECT usuario_correo FROM usuarios WHERE id_usuario = ?";
  conexion.query(queryCorreo, [id_usuario], (errCorreo, results) => {
    if (errCorreo || results.length === 0) {
      console.error(`[MAIL ${rid}] ERROR obtener correo usuario=${id_usuario}`);
      return res.status(500).json({ mensaje: "No se pudo obtener el correo del usuario" });
    }

    const usuario_correo = results[0].usuario_correo;

    // 1. Horario anterior
    const queryHorarioAnterior = `SELECT cita_fecha, cita_hora FROM citas WHERE id_cita = ?`;
    conexion.query(queryHorarioAnterior, [id], (err1, result1) => {
      if (err1 || result1.length === 0) {
        console.error(`[CITA ${rid}] ERROR obtener horario anterior`);
        return res.status(500).json({ mensaje: "Error interno al obtener horario anterior" });
      }

      const horarioAnterior = result1[0];

      // 2. Liberar horario anterior
      const liberar = `
        UPDATE horarios_medicos SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(liberar, [horarioAnterior.cita_fecha, horarioAnterior.cita_hora, id_medico], (err2, r2) => {
        if (err2) console.warn(`[HORARIO ${rid}] No se pudo liberar anterior:`, err2.message);
        console.log(`[HORARIO ${rid}] liberar -> afectadas=${r2?.affectedRows || 0}`);
      });

      // 3. Actualizar la cita
      const sql = `
        UPDATE citas SET 
          id_usuario = ?, 
          id_medico = ?, 
          cita_fecha = ?, 
          cita_hora = ?, 
          cita_estado = ?
        WHERE id_cita = ?
      `;
      conexion.query(sql, [id_usuario, id_medico, cita_fecha, cita_hora, cita_estado, id], (err3) => {
        if (err3) {
          console.error(`[CITA ${rid}] ERROR actualizar:`, err3.sqlMessage || err3.message);
          return res.status(500).json({ mensaje: "Error al actualizar la cita" });
        }

        // 4. Ocupar nuevo horario
        const ocupar = `
          UPDATE horarios_medicos SET horario_estado = 1 
          WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
        `;
        conexion.query(ocupar, [cita_fecha, cita_hora, id_medico], (err4, r4) => {
          if (err4) console.warn(`[HORARIO ${rid}] No se pudo ocupar nuevo:`, err4.message);
          console.log(`[HORARIO ${rid}] ocupar -> afectadas=${r4?.affectedRows || 0}`);
        });

        // 5. Correo
        enviarCorreoActualizacion(rid, usuario_correo, cita_fecha, cita_hora);

        res.status(200).json({ mensaje: "Cita actualizada correctamente" });
      });
    });
  });
});

app.put("/cita/anular/:id_cita", (req, res) => {
  const rid = req.rid;
  const { id_cita } = req.params;
  console.log(`[CITA ${rid}] anular -> id=${id_cita}`);

  const consultaDatosCita = "SELECT cita_fecha, cita_hora, id_medico, id_usuario FROM citas WHERE id_cita = ?";
  conexion.query(consultaDatosCita, [id_cita], (error, resultados) => {
    if (error || resultados.length === 0) {
      return res.status(404).json({ mensaje: "Cita no encontrada" });
    }

    const { cita_fecha, cita_hora, id_medico, id_usuario } = resultados[0];

    const consultaCancelar = "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?";
    conexion.query(consultaCancelar, [id_cita], (error2) => {
      if (error2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const consultaLiberarHorario = `
        UPDATE horarios_medicos 
        SET horario_estado = 0 
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], (error3, r3) => {
        if (error3) return res.status(500).json({ error: "Error al liberar el horario" });
        console.log(`[HORARIO ${rid}] liberar -> afectadas=${r3?.affectedRows || 0}`);

        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], (e, r) => {
          if (!e && r && r[0]) {
            enviarCorreoCancelacion(rid, r[0].usuario_correo, cita_fecha, cita_hora);
          }
          res.json({ mensaje: "Cita cancelada y horario liberado correctamente" });
        });
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden", (req, res) => {
  const rid = req.rid;
  const { id_usuario, numero_orden } = req.params;
  console.log(`[CITA ${rid}] anular -> usuario=${id_usuario} orden=${numero_orden}`);

  const consultaBuscarCita = `
    SELECT id_cita, cita_fecha, cita_hora, id_medico 
    FROM citas 
    WHERE id_usuario = ? AND numero_orden = ? AND cita_estado = 1
  `;
  conexion.query(consultaBuscarCita, [id_usuario, numero_orden], (err, resultados) => {
    if (err || resultados.length === 0) return res.status(404).json({ mensaje: "Cita no encontrada" });

    const { id_cita, cita_fecha, cita_hora, id_medico } = resultados[0];

    const consultaCancelar = "UPDATE citas SET cita_estado = 0 WHERE id_cita = ?";
    conexion.query(consultaCancelar, [id_cita], (err2) => {
      if (err2) return res.status(500).json({ error: "Error al cancelar la cita" });

      const consultaLiberarHorario = `
        UPDATE horarios_medicos
        SET horario_estado = 0
        WHERE horario_fecha = ? AND horario_hora = ? AND id_medico = ?
      `;
      conexion.query(consultaLiberarHorario, [cita_fecha, cita_hora, id_medico], (err3, r3) => {
        if (err3) return res.status(500).json({ error: "Error al liberar el horario" });
        console.log(`[HORARIO ${rid}] liberar -> afectadas=${r3?.affectedRows || 0}`);

        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario = ?", [id_usuario], (err4, rpta) => {
          if (!err4 && rpta && rpta[0]) {
            enviarCorreoCancelacion(rid, rpta[0].usuario_correo, cita_fecha, cita_hora);
          }
          res.json({ mensaje: "Cita cancelada exitosamente" });
        });
      });
    });
  });
});

/* ============ LISTAS AUXILIARES (sin logs extra) ============ */
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

app.get("/citas/por-dia", (req, res) => {
  const consulta = `
    SELECT 
      cita_fecha AS fecha, 
      COUNT(*) AS cantidad
    FROM citas
    WHERE cita_estado = 1
    GROUP BY cita_fecha
    ORDER BY cita_fecha ASC
  `;
  conexion.query(consulta, (error, resultados) => {
    if (error) return res.status(500).json({ error: "Error en la base de datos" });
    const datos = resultados.map((row) => ({
      fecha: row.fecha.toISOString().slice(0, 10),
      cantidad: row.cantidad,
    }));
    res.json({ listaCitas: datos });
  });
});

app.get("/citas", (req, res) => {
  const consulta = `
    SELECT 
      ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha, c.cita_hora) AS numero_cita,
      c.id_cita,
      u.usuario_nombre AS paciente_nombre,
      u.usuario_apellido AS paciente_apellido,
      DATE_FORMAT(c.cita_fecha, '%d/%m/%Y') AS cita_fecha,
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
    ORDER BY u.usuario_nombre ASC, numero_cita ASC;
  `;
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ error: "Error al obtener las citas" });
    res.json({ listaCitas: rpta || [] });
  });
});

app.get("/medicos", (req, res) => {
  const consulta = "SELECT * FROM medicos";
  conexion.query(consulta, (error, rpta) => {
    if (error) return res.status(500).json({ mensaje: "Error listando médicos" });
    res.json({ listaCitas: rpta || [] });
  });
});

app.post("/especialidad/agregar", (req, res) => {
  const { especialidad_nombre } = req.body;
  if (!especialidad_nombre) return res.status(400).json({ error: "Nombre requerido" });

  const consulta = "INSERT INTO especialidades (especialidad_nombre) VALUES (?)";
  conexion.query(consulta, [especialidad_nombre], (err, resultado) => {
    if (err) return res.status(500).json({ error: "Error al guardar especialidad" });
    res.status(201).json("Especialidad registrada");
  });
});

app.put("/especialidad/actualizar/:id", (req, res) => {
  const { id } = req.params;
  const { especialidad_nombre } = req.body;

  if (!especialidad_nombre) return res.status(400).json({ mensaje: "Nombre requerido" });

  const sql = "UPDATE especialidades SET especialidad_nombre = ? WHERE id_especialidad = ?";
  conexion.query(sql, [especialidad_nombre, id], (err) => {
    if (err) return res.status(500).json({ error: "Error al actualizar especialidad" });
    res.json({ mensaje: "Especialidad actualizada correctamente" });
  });
});
