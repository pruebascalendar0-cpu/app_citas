// index.js
require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const crypto = require("crypto");
const sg = require("@sendgrid/mail");

const app = express();
const PUERTO = process.env.PORT || 3000;
app.use(express.json());

// --- SendGrid (emails) ---
sg.setApiKey(process.env.SENDGRID_API_KEY);
function FROM() { return process.env.EMAIL_FROM || "Clínica Salud Total <pruebascalendar0@gmail.com>"; }
function REPLY_TO() { return process.env.REPLY_TO || "pruebascalendar0@gmail.com"; }
function listUnsubHeaders() {
  const items = [];
  if (process.env.UNSUB_MAILTO) items.push(`<mailto:${process.env.UNSUB_MAILTO}>`);
  if (process.env.UNSUB_URL) items.push(`<${process.env.UNSUB_URL}>`);
  return items.length ? { "List-Unsubscribe": items.join(", ") } : undefined;
}
async function enviarMail({ to, subject, html, text, category = "notificaciones" }) {
  const headers = listUnsubHeaders();
  const msg = {
    from: FROM(), to, subject, html,
    text: text || html.replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim(),
    replyTo: REPLY_TO(),
    trackingSettings: { clickTracking:{enable:false,enableText:false}, openTracking:{enable:false}, subscriptionTracking:{enable:false} },
    mailSettings: { sandboxMode: { enable: process.env.SENDGRID_SANDBOX === "true" } },
    categories: [category], headers,
  };
  try { await sg.send(msg); } catch (e) { console.error("❌ SG:", e.response?.body || e); }
}
const tplWrapper = (inner) => `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;color:#222;max-width:560px">
    ${inner}
    <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
    <div style="font-size:12px;color:#777">Clínica Salud Total · Mensaje automático.</div>
  </div>`;

// --- Helpers pass/códigos ---
function hashPassword(plain){ const salt=crypto.randomBytes(16).toString("hex"); const hash=crypto.createHash("sha256").update(salt+plain).digest("hex"); return `${salt}:${hash}`; }
function verifyPassword(plain, stored){ const [salt,hash]=stored.includes(":")?stored.split(":"):["",stored]; return crypto.createHash("sha256").update((salt||"")+plain).digest("hex")===hash; }
function genTempPass(n=10){ const c="ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*"; return Array.from(crypto.randomFillSync(new Uint8Array(n))).map(b=>c[b%c.length]).join(""); }
function genCode(n=6){ const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(crypto.randomFillSync(new Uint8Array(n))).map(b=>c[b%c.length]).join(""); }
function ymd(v){ if(!v) return v; return String(v).slice(0,10); } // asume 'YYYY-MM-DD...' -> 'YYYY-MM-DD'

// --- BD ---
const conexion = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
conexion.connect((error) => {
  if (error) throw error;
  console.log("Conexion exitosa a la base de datos");
});
// columnas por compatibilidad (no pasa nada si ya existen)
conexion.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_codigo VARCHAR(16) NULL", () => {});
conexion.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS usuario_contrasena_hash VARCHAR(128) NULL", () => {});

// --- Rutas base ---
app.get("/", (_req,res)=>res.send("Bienvenido a mi servicio web"));
app.get("/health", (_req,res)=>res.json({ok:true,uptime:process.uptime()}));

// --- Emails específicos ---
async function enviarCorreo(to, fecha, hora){ await enviarMail({to,subject:"Confirmación de tu cita médica",html:tplWrapper(`<h2>Cita médica confirmada</h2><p>Tu cita ha sido registrada.</p><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`),category:"citas-confirmacion"}); }
async function enviarCorreoBienvenida(to, nombre){ await enviarMail({to,subject:"Bienvenido a Clínica Salud Total",html:tplWrapper(`<h2>¡Bienvenido, ${nombre}!</h2><p>Registro exitoso.</p>`),category:"bienvenida"}); }
async function enviarCorreoRecuperacion(to, nombre, pass){ await enviarMail({to,subject:"Restablecimiento de contraseña – Clínica Salud Total",html:tplWrapper(`<h2>Contraseña temporal</h2><p>Hola <strong>${nombre}</strong></p><p><strong>${pass}</strong></p><p>Cámbiala al iniciar sesión.</p>`),category:"recuperacion"}); }
async function enviarCorreoActualizacion(to, fecha, hora){ await enviarMail({to,subject:"Actualización de tu cita médica",html:tplWrapper(`<h2>Cita actualizada</h2><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`),category:"citas-actualizacion"}); }
async function enviarCorreoCancelacion(to, fecha, hora){ await enviarMail({to,subject:"Cancelación de tu cita médica",html:tplWrapper(`<h2>Cita cancelada</h2><p><strong>Fecha:</strong> ${fecha}<br/><strong>Hora:</strong> ${hora}</p>`),category:"citas-cancelacion"}); }

// ===================== USUARIOS =====================
app.post("/usuario/login",(req,res)=>{
  const {usuario_correo,password}=req.body||{};
  if(!usuario_correo||!password) return res.status(400).json({mensaje:"Correo y password requeridos"});
  const q="SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_tipo,usuario_contrasena_hash FROM usuarios WHERE usuario_correo=?";
  conexion.query(q,[usuario_correo],(e,rows)=>{
    if(e) return res.status(500).json({mensaje:"Error en la base de datos"});
    if(!rows.length) return res.status(404).json({mensaje:"Correo no registrado"});
    if(!verifyPassword(password, rows[0].usuario_contrasena_hash||"")) return res.status(401).json({mensaje:"Contraseña incorrecta"});
    const u=rows[0];
    res.json({id_usuario:u.id_usuario,usuario_nombre:u.usuario_nombre,usuario_apellido:u.usuario_apellido,usuario_correo:u.usuario_correo,usuario_tipo:u.usuario_tipo});
  });
});

app.post("/usuario/recuperar-correo",(req,res)=>{
  const {usuario_dni,usuario_nombre,usuario_apellido}=req.body;
  conexion.query("SELECT usuario_correo FROM usuarios WHERE usuario_dni=? AND usuario_nombre=? AND usuario_apellido=?",
    [usuario_dni,usuario_nombre,usuario_apellido],
    (e,r)=>{ if(e) return res.status(500).json({error:"Error interno"}); if(!r.length) return res.status(404).json({mensaje:"Usuario no encontrado"}); res.json({correo:r[0].usuario_correo}); });
});

app.post("/usuario/recuperar-contrasena",(req,res)=>{
  const {usuario_correo}=req.body;
  conexion.query("SELECT id_usuario,usuario_nombre,usuario_apellido FROM usuarios WHERE usuario_correo=?",[usuario_correo],(e,r)=>{
    if(e) return res.status(500).json({error:"Error interno"}); if(!r.length) return res.status(404).json({mensaje:"Correo no registrado"});
    const temp = genTempPass(10);
    conexion.query("UPDATE usuarios SET usuario_contrasena_hash=? WHERE id_usuario=?",[hashPassword(temp), r[0].id_usuario], (e2)=>{
      if(e2) return res.status(500).json({error:"No se pudo actualizar"});
      enviarCorreoRecuperacion(usuario_correo, `${r[0].usuario_nombre} ${r[0].usuario_apellido}`, temp).catch(()=>{});
      res.json({mensaje:"Se envió una contraseña temporal a tu correo"});
    });
  });
});

app.post("/usuario/agregar",(req,res)=>{
  const u=req.body||{};
  if(!u.usuario_dni||!/^\d{8}$/.test(u.usuario_dni)) return res.status(400).json({mensaje:"DNI inválido"});
  if(!u.usuario_nombre||!u.usuario_apellido) return res.status(400).json({mensaje:"Nombre y apellido obligatorios"});
  if(!u.usuario_correo||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.usuario_correo)) return res.status(400).json({mensaje:"Correo inválido"});
  if(!u.usuario_contrasena||u.usuario_contrasena.length<6) return res.status(400).json({mensaje:"La contraseña debe tener al menos 6 caracteres."});
  const row={usuario_dni:u.usuario_dni,usuario_nombre:u.usuario_nombre,usuario_apellido:u.usuario_apellido,usuario_correo:u.usuario_correo,usuario_contrasena_hash:hashPassword(u.usuario_contrasena),usuario_tipo:1};
  conexion.query("INSERT INTO usuarios SET ?",row,(err)=>{
    if(err){
      if(err.code==="ER_DUP_ENTRY"){ if(err.sqlMessage?.includes("usuario_dni")) return res.status(400).json({mensaje:"DNI ya está registrado"}); if(err.sqlMessage?.includes("usuario_correo")) return res.status(400).json({mensaje:"El correo ya está registrado."}); return res.status(400).json({mensaje:"Datos duplicados"});}
      return res.status(500).json({mensaje:"Error al registrar usuario."});
    }
    enviarCorreoBienvenida(row.usuario_correo, `${row.usuario_nombre} ${row.usuario_apellido}`).catch(()=>{});
    res.json({mensaje:"Usuario registrado correctamente."});
  });
});

app.post("/usuario/registrar",(req,res)=>{
  const {usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena,usuario_tipo,id_especialidad}=req.body;
  if(!usuario_nombre||!usuario_apellido||!usuario_correo||!usuario_dni||!usuario_contrasena||(usuario_tipo===undefined)) return res.status(400).json({mensaje:"Todos los campos son obligatorios"});
  const nuevo={usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_contrasena_hash:hashPassword(usuario_contrasena),usuario_tipo};
  conexion.query("INSERT INTO usuarios SET ?",nuevo,(e,r)=>{
    if(e){
      if(e.code==="ER_DUP_ENTRY"){ if(e.sqlMessage.includes("usuario_dni")) return res.status(400).json({mensaje:"DNI ya está registrado"}); if(e.sqlMessage.includes("usuario_correo")) return res.status(400).json({mensaje:"El correo ya está registrado."}); return res.status(400).json({mensaje:"Datos duplicados"});}
      return res.status(500).json({mensaje:"Error al registrar usuario"});
    }
    const id_usuario=r.insertId;
    if(usuario_tipo===2 && id_especialidad){
      conexion.query("INSERT INTO medicos (id_medico,id_especialidad) VALUES (?,?)",[id_usuario,id_especialidad],(e2)=>{
        if(e2) return res.status(201).json({mensaje:"Usuario registrado, pero no se pudo asignar la especialidad",id_usuario});
        res.status(201).json({mensaje:"Médico registrado correctamente",id_usuario});
      });
    } else res.status(201).json({mensaje:"Usuario registrado correctamente",id_usuario});
  });
});

app.get("/usuario/:correo",(req,res)=>{
  const correo = decodeURIComponent(req.params.correo);
  conexion.query("SELECT id_usuario,usuario_nombre,usuario_apellido,usuario_correo,usuario_dni,usuario_tipo FROM usuarios WHERE usuario_correo=?",[correo],(e,rows)=>{
    if(e) return res.status(500).send(e.message);
    if(rows.length) res.json(rows[0]); else res.status(404).send({mensaje:"no hay registros"});
  });
});

// ===================== MÉDICOS / ESPECIALIDADES / HORARIOS =====================
app.get("/especialidades",(_req,res)=>{
  conexion.query("SELECT * FROM especialidades",(e,r)=>{ if(e) return res.status(500).json({error:e.message}); res.json(r.length?{listaEspecialidades:r}:{mensaje:"no hay registros"}); });
});

app.post("/especialidad/agregar",(req,res)=>{
  const {especialidad_nombre}=req.body; if(!especialidad_nombre) return res.status(400).json({error:"Nombre requerido"});
  conexion.query("INSERT INTO especialidades (especialidad_nombre) VALUES (?)",[especialidad_nombre],(e)=>{ if(e) return res.status(500).json({error:"Error al guardar especialidad"}); res.status(201).json("Especialidad registrada"); });
});

app.put("/especialidad/actualizar/:id",(req,res)=>{
  const {id}=req.params; const {especialidad_nombre}=req.body; if(!especialidad_nombre) return res.status(400).json({mensaje:"Nombre requerido"});
  conexion.query("UPDATE especialidades SET especialidad_nombre=? WHERE id_especialidad=?",[especialidad_nombre,id],(e)=>{ if(e) return res.status(500).json({error:"Error al actualizar especialidad"}); res.json({mensaje:"Especialidad actualizada correctamente"}); });
});

// Igual que el viejo: comparamos fecha STRING directamente (sin STR_TO_DATE)
app.get("/horarios/:parametro",(req,res)=>{
  const [fecha, especialidad] = req.params.parametro.split("&");
  const q = `
    SELECT h.*,
           DATE_FORMAT(h.horario_fecha,'%Y-%m-%d') AS horario_fecha_str,
           TIME_FORMAT(h.horario_hora,'%H:%i')     AS horario_horas,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.especialidad_nombre
    FROM horarios_medicos h
    INNER JOIN medicos m ON h.id_medico=m.id_medico
    INNER JOIN usuarios u ON m.id_medico=u.id_usuario
    INNER JOIN especialidades e ON h.id_especialidad=e.id_especialidad
    WHERE h.horario_fecha = ? AND h.id_especialidad = ? AND h.horario_estado = 0
    ORDER BY h.horario_hora ASC`;
  conexion.query(q,[ymd(fecha), especialidad],(e,r)=>{ if(e) return res.status(500).json({error:e.message}); res.json({listaHorarios:r}); });
});

app.post("/horario/registrar",(req,res)=>{
  let {id_medico, horario_horas, horario_fecha, id_especialidad}=req.body;
  horario_fecha = ymd(horario_fecha);
  if(!id_medico||!horario_horas||!horario_fecha||!id_especialidad) return res.status(400).json({error:"Faltan datos obligatorios"});
  const q=`INSERT INTO horarios_medicos (id_medico,horario_hora,horario_fecha,horario_estado,id_especialidad) VALUES (?,?,?,?,?)`;
  conexion.query(q,[id_medico, `${horario_horas}:00`.slice(0,8), horario_fecha, 0, id_especialidad],(e,r)=>{
    if(e){ if(e.code==="ER_DUP_ENTRY") return res.status(400).json({error:"Ese horario ya fue registrado para este médico."}); return res.status(500).json({error:"Error interno al registrar el horario"}); }
    res.json({mensaje:"Horario registrado correctamente", id_horario:r.insertId});
  });
});

app.get("/horarios/disponibles/:id_medico/:fecha/:id_especialidad",(req,res)=>{
  const {id_medico,fecha,id_especialidad}=req.params;
  const todas = Array.from({length:9},(_,i)=>`${(8+i).toString().padStart(2,"0")}:00`);
  const q=`SELECT TIME_FORMAT(horario_hora,'%H:%i') AS hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND id_especialidad=?`;
  conexion.query(q,[id_medico, ymd(fecha), id_especialidad],(e,rows)=>{
    if(e) return res.status(500).json({error:"Error al consultar horarios"});
    const ocupadas = rows.map(r=>r.hora);
    res.json({horariosDisponibles: todas.filter(h=>!ocupadas.includes(h))});
  });
});

app.get("/horarios/registrados/:id_medico/:fecha/:id_especialidad",(req,res)=>{
  const {id_medico,fecha,id_especialidad}=req.params;
  const q=`SELECT TIME_FORMAT(horario_hora,'%H:%i') AS horario_hora FROM horarios_medicos WHERE id_medico=? AND horario_fecha=? AND id_especialidad=? AND horario_estado=0 ORDER BY horario_hora ASC`;
  conexion.query(q,[id_medico, ymd(fecha), id_especialidad],(e,rows)=>{
    if(e) return res.status(500).json({error:"Error interno del servidor"});
    res.json({horarios: rows.map(r=>r.horario_hora)});
  });
});

// ===================== CITAS =====================
app.post("/cita/agregar",(req,res)=>{
  let {id_usuario,id_medico,cita_fecha,cita_hora}=req.body;
  cita_fecha = ymd(cita_fecha);
  const qOrden="SELECT COUNT(*) AS total FROM citas WHERE id_usuario=?";
  conexion.query(qOrden,[id_usuario],(e,r0)=>{
    if(e) return res.status(500).json({error:"Error al calcular número de orden"});
    const numero_orden=r0[0].total+1;
    const qIns="INSERT INTO citas (id_usuario,id_medico,cita_fecha,cita_hora,numero_orden) VALUES (?,?,?,?,?)";
    conexion.query(qIns,[id_usuario,id_medico,cita_fecha,`${cita_hora}:00`.slice(0,8),numero_orden],(e2)=>{
      if(e2) return res.status(500).json({error:"Error al registrar la cita"});
      const qOcupar="UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?";
      conexion.query(qOcupar,[cita_fecha,`${cita_hora}:00`.slice(0,8),id_medico],()=>{});
      conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?",[id_usuario],(e4,r4)=>{
        if(e4||!r4.length) return res.status(404).json({error:"Usuario no encontrado"});
        enviarCorreo(r4[0].usuario_correo, cita_fecha, cita_hora).catch(()=>{});
        res.json({mensaje:"Cita registrada correctamente", numero_orden});
      });
    });
  });
});

app.put("/cita/actualizar/:id",(req,res)=>{
  const {id}=req.params;
  let {id_usuario,id_medico,cita_fecha,cita_hora,cita_estado}=req.body;
  cita_fecha = ymd(cita_fecha);
  if(!id_usuario||!id_medico||!cita_fecha||!cita_hora) return res.status(400).json({mensaje:"Datos incompletos para actualizar la cita"});

  conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?",[id_usuario],(e0,rows)=>{
    if(e0||!rows.length) return res.status(500).json({mensaje:"No se pudo obtener el correo del usuario"});
    const correo=rows[0].usuario_correo;

    const qPrev="SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS f, TIME_FORMAT(cita_hora,'%H:%i') AS h FROM citas WHERE id_cita=?";
    conexion.query(qPrev,[id],(e1,r1)=>{
      if(e1||!r1.length) return res.status(500).json({mensaje:"Error al obtener horario anterior"});
      const prev=r1[0];
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
        [prev.f, `${prev.h}:00`.slice(0,8), id_medico], ()=>{});
      const qUp="UPDATE citas SET id_usuario=?, id_medico=?, cita_fecha=?, cita_hora=?, cita_estado=? WHERE id_cita=?";
      conexion.query(qUp,[id_usuario,id_medico,cita_fecha,`${cita_hora}:00`.slice(0,8),(cita_estado??1),id],(e3)=>{
        if(e3) return res.status(500).json({mensaje:"Error al actualizar la cita"});
        conexion.query("UPDATE horarios_medicos SET horario_estado=1 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",
          [cita_fecha, `${cita_hora}:00`.slice(0,8), id_medico], ()=>{});
        enviarCorreoActualizacion(correo, cita_fecha, cita_hora).catch(()=>{});
        res.status(200).json({mensaje:"Cita actualizada correctamente"});
      });
    });
  });
});

app.put("/cita/anular/:id_cita",(req,res)=>{
  const {id_cita}=req.params;
  conexion.query("SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS f, TIME_FORMAT(cita_hora,'%H:%i:%s') AS h, id_medico FROM citas WHERE id_cita=?",[id_cita],(e1,r1)=>{
    if(e1||!r1.length) return res.status(404).json({mensaje:"Cita no encontrada"});
    const {f,h,id_medico}=r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?",[id_cita],(e2)=>{
      if(e2) return res.status(500).json({error:"Error al cancelar la cita"});
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",[f,h,id_medico],(e3)=>{
        if(e3) return res.status(500).json({error:"Error al liberar el horario"});
        res.json({mensaje:"Cita cancelada y horario liberado correctamente"});
      });
    });
  });
});

app.put("/cita/anular/:id_usuario/:numero_orden",(req,res)=>{
  const {id_usuario,numero_orden}=req.params;
  const q="SELECT id_cita, DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS f, TIME_FORMAT(cita_hora,'%H:%i:%s') AS h, id_medico FROM citas WHERE id_usuario=? AND numero_orden=? AND cita_estado=1";
  conexion.query(q,[id_usuario,numero_orden],(e1,r1)=>{
    if(e1) return res.status(500).json({error:"Error al buscar la cita"});
    if(!r1.length) return res.status(404).json({mensaje:"Cita no encontrada"});
    const {id_cita,f,h,id_medico}=r1[0];
    conexion.query("UPDATE citas SET cita_estado=0 WHERE id_cita=?",[id_cita],(e2)=>{
      if(e2) return res.status(500).json({error:"Error al cancelar la cita"});
      conexion.query("UPDATE horarios_medicos SET horario_estado=0 WHERE horario_fecha=? AND horario_hora=? AND id_medico=?",[f,h,id_medico],(e3)=>{
        if(e3) return res.status(500).json({error:"Error al liberar el horario"});
        conexion.query("SELECT usuario_correo FROM usuarios WHERE id_usuario=?",[id_usuario],(e4,r4)=>{
          if(!e4&&r4.length) enviarCorreoCancelacion(r4[0].usuario_correo, f, h.slice(0,5)).catch(()=>{});
          res.json({mensaje:"Cita cancelada exitosamente"});
        });
      });
    });
  });
});

// Conteo por día: devuelve strings YYYY-MM-DD (ni un Date de JS)
app.get("/citas/por-dia",(_req,res)=>{
  const q=`
    SELECT DATE_FORMAT(cita_fecha,'%Y-%m-%d') AS fecha, COUNT(*) AS cantidad
    FROM citas WHERE cita_estado=1
    GROUP BY DATE(cita_fecha) ORDER BY DATE(cita_fecha) ASC`;
  conexion.query(q,(e,rows)=>{ if(e) return res.status(500).json({error:"Error en la base de datos"}); res.json({listaCitas: rows}); });
});

app.get("/citas/:usuario",(req,res)=>{
  const {usuario}=req.params;
  const q=`
    SELECT c.id_cita, c.id_usuario, c.id_medico,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i')      AS cita_hora,
           u.usuario_nombre AS medico_nombre, u.usuario_apellido AS medico_apellido,
           e.id_especialidad, e.especialidad_nombre, c.cita_estado
    FROM citas c
    INNER JOIN medicos m ON c.id_medico=m.id_medico
    INNER JOIN usuarios u ON m.id_medico=u.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
    WHERE c.id_usuario=? ORDER BY c.id_cita ASC`;
  conexion.query(q,[usuario],(e,r)=>{
    if(e) return res.status(500).json({error:e.message});
    res.json({listaCitas: r.map((c,i)=>({...c,numero_orden:i+1}))});
  });
});

app.get("/citamedica/:id_cita",(req,res)=>{
  const {id_cita}=req.params;
  const q=`
    SELECT cit.id_cita AS IdCita,
           CONCAT(us.usuario_nombre,' ',us.usuario_apellido) AS UsuarioCita,
           esp.especialidad_nombre AS Especialidad,
           CONCAT(med.usuario_nombre,' ',med.usuario_apellido) AS Medico,
           DATE_FORMAT(cit.cita_fecha,'%Y-%m-%d') AS FechaCita,
           TIME_FORMAT(cit.cita_hora,'%H:%i')     AS HoraCita
    FROM citas cit
    INNER JOIN usuarios us ON us.id_usuario=cit.id_usuario
    INNER JOIN medicos m ON cit.id_medico=m.id_medico
    INNER JOIN usuarios med ON m.id_medico=med.id_usuario
    INNER JOIN especialidades esp ON esp.id_especialidad=m.id_especialidad
    WHERE cit.id_cita=?`;
  conexion.query(q,[id_cita],(e,rows)=>{ if(e) return res.status(500).json({error:"Error en la base de datos"}); if(!rows.length) return res.status(404).json({mensaje:"Cita no encontrada"}); res.json(rows[0]); });
});

app.get("/citas",(_req,res)=>{
  const q=`
    SELECT ROW_NUMBER() OVER (PARTITION BY c.id_usuario ORDER BY c.cita_fecha,c.cita_hora) AS numero_cita,
           c.id_cita,
           u.usuario_nombre AS paciente_nombre, u.usuario_apellido AS paciente_apellido,
           DATE_FORMAT(c.cita_fecha,'%d/%m/%Y') AS cita_fecha,
           TIME_FORMAT(c.cita_hora,'%H:%i')     AS cita_hora,
           e.especialidad_nombre,
           mu.usuario_nombre AS medico_nombre, mu.usuario_apellido AS medico_apellido,
           c.cita_estado
    FROM citas c
    INNER JOIN usuarios u ON c.id_usuario=u.id_usuario
    INNER JOIN medicos m ON c.id_medico=m.id_medico
    INNER JOIN usuarios mu ON m.id_medico=mu.id_usuario
    INNER JOIN especialidades e ON m.id_especialidad=e.id_especialidad
    ORDER BY u.usuario_nombre ASC, numero_cita ASC`;
  conexion.query(q,(e,r)=>{ if(e) return res.status(500).json({error:"Error al obtener las citas"}); res.json({listaCitas: r.length?r:[]}); });
});

app.get("/medicos",(_req,res)=>{
  conexion.query("SELECT * FROM medicos",(e,r)=>{ if(e) return res.status(500).json({error:e.message}); res.json(r.length?{listaCitas:r}:{mensaje:"no hay registros"}); });
});

// --- Start ---
app.listen(PUERTO,()=>console.log("Servidor corriendo en el puerto "+PUERTO));
