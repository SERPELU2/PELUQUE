const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'peluqueria.db');
const PUBLIC_DIR = path.resolve(__dirname, 'public');

// --- Base de Datos SQLite ---
const db = new DatabaseSync(DB_PATH);

// Inicializar tablas seguras
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    client_name TEXT NOT NULL,
    client_phone TEXT NOT NULL,
    service TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_date_time ON appointments(date, time, status);

  CREATE TABLE IF NOT EXISTS friend_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT UNIQUE NOT NULL,
    notes TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS blocked_days (
    date TEXT PRIMARY KEY,
    reason TEXT DEFAULT ''
  );
`);

// Configuración por defecto
function initDefaultConfig() {
  const defaults = {
    admin_password: 'pelu1234',
    peluquero_name: 'Estudio de Peluquería',
    peluquero_phone: '34600000000',
    slot_duration_minutes: '45',
    morning_start: '09:30',
    morning_end: '13:30',
    afternoon_start: '16:00',
    afternoon_end: '20:30',
    working_days: JSON.stringify([1, 2, 3, 4, 5, 6]),
    services: JSON.stringify([
      'Corte de pelo',
      'Peinado y estilismo',
      'Corte + Peinado',
      'Tinte / Coloración',
      'Mechas / Balayage',
      'Tratamiento de hidratación',
      'Arreglo de barba / Ritual'
    ])
  };

  const getStmt = db.prepare('SELECT value FROM config WHERE key = ?');
  const insertStmt = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');

  for (const [key, val] of Object.entries(defaults)) {
    const existing = getStmt.get(key);
    if (!existing) {
      insertStmt.run(key, val);
    }
  }
}
initDefaultConfig();

function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

// ========================================================
// SISTEMA DE SEGURIDAD DEFENSIVA Y PROTECCIÓN
// ========================================================

// 1. Control de sesiones con expiración (24 horas)
const adminSessions = new Map(); // token -> { expiresAt: number }

function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h
  adminSessions.set(token, { expiresAt });
  return token;
}

function checkAdminAuth(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const session = adminSessions.get(token);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// Limpieza periódica de sesiones caducadas cada hora
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (now > session.expiresAt) {
      adminSessions.delete(token);
    }
  }
}, 60 * 60 * 1000);

// 2. Comparación segura contra ataques de temporización (Timing Attacks)
function verifyPasswordSafe(inputPassword, storedPassword) {
  if (typeof inputPassword !== 'string' || typeof storedPassword !== 'string') return false;
  const h1 = crypto.createHash('sha256').update(inputPassword).digest();
  const h2 = crypto.createHash('sha256').update(storedPassword).digest();
  return crypto.timingSafeEqual(h1, h2);
}

// 3. Limitador de tasa (Rate Limiting) contra ataques de fuerza bruta y DoS
const rateLimits = {
  loginAttempts: new Map(), // ip -> { count: number, blockedUntil: number }
  bookingAttempts: new Map() // ip -> { count: number, resetAt: number }
};

function checkRateLimit(ip, type, maxAttempts, windowMs, blockDurationMs) {
  const map = rateLimits[type];
  const now = Date.now();
  const record = map.get(ip) || { count: 0, resetAt: now + windowMs, blockedUntil: 0 };

  if (record.blockedUntil > now) {
    const remainingSecs = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, error: `Demasiados intentos. Espera ${remainingSecs} segundos.` };
  }

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  if (record.count > maxAttempts) {
    record.blockedUntil = now + (blockDurationMs || windowMs);
    map.set(ip, record);
    return { allowed: false, error: 'Has superado el límite de intentos. Bloqueo temporal activado por seguridad.' };
  }

  map.set(ip, record);
  return { allowed: true };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
}

// 4. Clientes suscritos a Server-Sent Events (SSE)
const sseClients = new Set();

function broadcastEvent(eventType, payload) {
  const dataString = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(dataString);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// 5. Utilidad para parsear JSON con límite de tamaño para evitar desbordamiento
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5e5) { // Límite estricto 500KB
        req.destroy();
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('JSON malformado'));
      }
    });
    req.on('error', reject);
  });
}

// Generador de franjas horarias
function generateSlots(dateStr) {
  const blocked = db.prepare('SELECT reason FROM blocked_days WHERE date = ?').get(dateStr);
  if (blocked) {
    return { isDayBlocked: true, reason: blocked.reason || 'Día cerrado por descanso', slots: [] };
  }

  const [year, month, day] = dateStr.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayOfWeek = dateObj.getDay();
  
  const workingDays = JSON.parse(getConfig('working_days') || '[1,2,3,4,5,6]');
  if (!workingDays.includes(dayOfWeek)) {
    return { isDayBlocked: true, reason: 'Día no laborable', slots: [] };
  }

  const slotMinutes = parseInt(getConfig('slot_duration_minutes') || '45', 10);
  const morningStart = getConfig('morning_start') || '09:30';
  const morningEnd = getConfig('morning_end') || '13:30';
  const afternoonStart = getConfig('afternoon_start') || '16:00';
  const afternoonEnd = getConfig('afternoon_end') || '20:30';

  function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function minutesToTime(m) {
    const h = Math.floor(m / 60).toString().padStart(2, '0');
    const min = (m % 60).toString().padStart(2, '0');
    return `${h}:${min}`;
  }

  const slots = [];

  const mStart = timeToMinutes(morningStart);
  const mEnd = timeToMinutes(morningEnd);
  for (let t = mStart; t + slotMinutes <= mEnd; t += slotMinutes) {
    slots.push({ time: minutesToTime(t), period: 'mañana' });
  }

  const aStart = timeToMinutes(afternoonStart);
  const aEnd = timeToMinutes(afternoonEnd);
  for (let t = aStart; t + slotMinutes <= aEnd; t += slotMinutes) {
    slots.push({ time: minutesToTime(t), period: 'tarde' });
  }

  const appointments = db.prepare(`
    SELECT time, status FROM appointments 
    WHERE date = ? AND status IN ('pending', 'confirmed')
  `).all(dateStr);

  const statusMap = new Map();
  for (const app of appointments) {
    statusMap.set(app.time, app.status);
  }

  const resultSlots = slots.map(s => {
    const appStatus = statusMap.get(s.time);
    let status = 'available';
    if (appStatus === 'pending') status = 'pending';
    else if (appStatus === 'confirmed') status = 'confirmed';
    return {
      time: s.time,
      period: s.period,
      status
    };
  });

  return { isDayBlocked: false, slots: resultSlots };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// Servidor HTTP con cabeceras de seguridad
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const method = req.method;
  const clientIp = getClientIp(req);

  // Cabeceras de Seguridad Reforzadas
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // --- API PÚBLICA ---

  // 1. Canal SSE en tiempo real
  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    const client = { res, id: crypto.randomUUID() };
    sseClients.add(client);

    req.on('close', () => {
      sseClients.delete(client);
    });
    return;
  }

  // 2. Consulta de franjas y disponibilidad
  if (pathname === '/api/public/calendar' && method === 'GET') {
    const date = urlObj.searchParams.get('date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Fecha no válida' }));
    }

    const calendarData = generateSlots(date);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ date, ...calendarData }));
  }

  // 3. Info de la peluquería y servicios
  if (pathname === '/api/public/info' && method === 'GET') {
    const services = JSON.parse(getConfig('services') || '[]');
    const salonName = getConfig('peluquero_name') || 'Estudio de Peluquería';
    const workingDays = JSON.parse(getConfig('working_days') || '[1,2,3,4,5,6]');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ salonName, services, workingDays }));
  }

  // 4. Reservar cita (Con Rate Limiting y Sanitización Estricta)
  if (pathname === '/api/public/book' && method === 'POST') {
    // Proteger contra bots y spam: max 12 reservas por hora por IP
    const rateCheck = checkRateLimit(clientIp, 'bookingAttempts', 12, 60 * 60 * 1000, 30 * 60 * 1000);
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: rateCheck.error }));
    }

    try {
      const body = await parseJsonBody(req);
      let { date, time, client_name, client_phone, service } = body;

      if (!date || !time || !client_name || !client_phone || !service) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Faltan datos obligatorios' }));
      }

      // Validaciones estrictas
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Formato de fecha u hora no válido' }));
      }

      // Sanitizar texto para evitar ataques XSS
      const cleanName = String(client_name).trim().replace(/[<>]/g, '').substring(0, 60);
      const cleanPhone = String(client_phone).replace(/\D/g, '').substring(0, 15);
      const cleanService = String(service).trim().replace(/[<>]/g, '').substring(0, 60);

      if (cleanName.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El nombre debe tener al menos 2 caracteres' }));
      }

      if (cleanPhone.length < 8) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Número de teléfono no válido' }));
      }

      // Comprobación atómica de franja libre
      const existing = db.prepare(`
        SELECT id FROM appointments 
        WHERE date = ? AND time = ? AND status IN ('pending', 'confirmed')
      `).get(date, time);

      if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ 
          error: 'Esta hora acaba de ser reservada. Por favor elige otro horario libre.' 
        }));
      }

      const insert = db.prepare(`
        INSERT INTO appointments (date, time, client_name, client_phone, service, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
      `);
      const info = insert.run(date, time, cleanName, cleanPhone, cleanService);

      // Ficha de amigo segura
      db.prepare(`
        INSERT INTO friend_cards (client_name, notes, updated_at)
        VALUES (?, '', datetime('now'))
        ON CONFLICT(client_name) DO NOTHING
      `).run(cleanName);

      // Notificar en tiempo real (SSE)
      broadcastEvent('slot_update', { date, time, status: 'pending' });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        success: true,
        message: '¡Reserva recibida! Tu cita queda pendiente de confirmación.',
        appointmentId: Number(info.lastInsertRowid)
      }));
    } catch (err) {
      console.error('Error al reservar:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error interno del servidor al procesar la reserva' }));
    }
  }

  // --- API PRIVADA DEL PELUQUERO ---

  // 5. Iniciar sesión con Rate Limiting y Timing-Safe Compare
  if (pathname === '/api/admin/login' && method === 'POST') {
    // Máximo 5 intentos fallidos cada 15 minutos por IP
    const rateCheck = checkRateLimit(clientIp, 'loginAttempts', 5, 15 * 60 * 1000, 15 * 60 * 1000);
    if (!rateCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: rateCheck.error }));
    }

    try {
      const { password } = await parseJsonBody(req);
      const actualPassword = getConfig('admin_password') || 'pelu1234';

      if (!password || !verifyPasswordSafe(String(password), actualPassword)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Contraseña incorrecta' }));
      }

      // Reiniciar contador de intentos tras login correcto
      rateLimits.loginAttempts.delete(clientIp);

      const token = createAdminSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, token }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al iniciar sesión' }));
    }
  }

  // Middleware de Autenticación de Admin
  if (pathname.startsWith('/api/admin/')) {
    if (!checkAdminAuth(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Acceso no autorizado o sesión caducada' }));
    }
  }

  // 6. Listado de citas de admin
  if (pathname === '/api/admin/appointments' && method === 'GET') {
    const date = urlObj.searchParams.get('date');
    let query = 'SELECT * FROM appointments ORDER BY date DESC, time ASC';
    let params = [];

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      query = 'SELECT * FROM appointments WHERE date = ? ORDER BY time ASC';
      params = [date];
    }

    const appointments = db.prepare(query).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ appointments }));
  }

  // 7. Modificar estado de cita
  if (pathname.startsWith('/api/admin/appointments/') && pathname.endsWith('/status') && method === 'POST') {
    try {
      const parts = pathname.split('/');
      const id = parseInt(parts[parts.length - 2], 10);
      const { status } = await parseJsonBody(req);

      if (!['confirmed', 'cancelled'].includes(status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Estado no válido' }));
      }

      const app = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
      if (!app) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Cita no encontrada' }));
      }

      db.prepare(`
        UPDATE appointments 
        SET status = ?, updated_at = datetime('now') 
        WHERE id = ?
      `).run(status, id);

      const slotNewStatus = status === 'confirmed' ? 'confirmed' : 'available';

      broadcastEvent('slot_update', {
        date: app.date,
        time: app.time,
        status: slotNewStatus
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        success: true, 
        appointment: { ...app, status },
        slotStatus: slotNewStatus
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al actualizar cita' }));
    }
  }

  // 8. GESTIÓN DE SERVICIOS (Añadir, modificar, borrar)
  if (pathname === '/api/admin/services' && method === 'GET') {
    const services = JSON.parse(getConfig('services') || '[]');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ services }));
  }

  if (pathname === '/api/admin/services' && method === 'POST') {
    try {
      const { name } = await parseJsonBody(req);
      const cleanName = String(name || '').trim().replace(/[<>]/g, '').substring(0, 60);

      if (cleanName.length < 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El nombre del servicio debe tener al menos 2 letras' }));
      }

      let services = JSON.parse(getConfig('services') || '[]');
      if (services.includes(cleanName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Este servicio ya existe' }));
      }

      services.push(cleanName);
      setConfig('services', JSON.stringify(services));

      broadcastEvent('services_updated', { services });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, services }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al agregar servicio' }));
    }
  }

  // Modificar o Eliminar servicio por índice
  if (pathname.startsWith('/api/admin/services/') && (method === 'PUT' || method === 'DELETE')) {
    try {
      const index = parseInt(pathname.replace('/api/admin/services/', ''), 10);
      let services = JSON.parse(getConfig('services') || '[]');

      if (isNaN(index) || index < 0 || index >= services.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Servicio no encontrado' }));
      }

      if (method === 'DELETE') {
        services.splice(index, 1);
      } else if (method === 'PUT') {
        const { name } = await parseJsonBody(req);
        const cleanName = String(name || '').trim().replace(/[<>]/g, '').substring(0, 60);
        if (cleanName.length < 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Nombre no válido' }));
        }
        services[index] = cleanName;
      }

      setConfig('services', JSON.stringify(services));
      broadcastEvent('services_updated', { services });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, services }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al modificar servicios' }));
    }
  }

  // 9. Configuración de horarios y contraseña
  if (pathname === '/api/admin/settings' && method === 'GET') {
    const settings = {
      admin_password: getConfig('admin_password'),
      peluquero_name: getConfig('peluquero_name'),
      peluquero_phone: getConfig('peluquero_phone'),
      slot_duration_minutes: parseInt(getConfig('slot_duration_minutes') || '45', 10),
      morning_start: getConfig('morning_start'),
      morning_end: getConfig('morning_end'),
      afternoon_start: getConfig('afternoon_start'),
      afternoon_end: getConfig('afternoon_end'),
      working_days: JSON.parse(getConfig('working_days') || '[1,2,3,4,5,6]'),
      services: JSON.parse(getConfig('services') || '[]')
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(settings));
  }

  if (pathname === '/api/admin/settings' && method === 'POST') {
    try {
      const data = await parseJsonBody(req);

      if (data.admin_password && String(data.admin_password).trim().length >= 4) {
        setConfig('admin_password', String(data.admin_password).trim());
      }
      if (data.peluquero_name) setConfig('peluquero_name', String(data.peluquero_name).trim().replace(/[<>]/g, '').substring(0, 80));
      if (data.peluquero_phone) setConfig('peluquero_phone', String(data.peluquero_phone).replace(/\D/g, '').substring(0, 15));
      if (data.slot_duration_minutes) setConfig('slot_duration_minutes', data.slot_duration_minutes);
      if (data.morning_start && /^\d{2}:\d{2}$/.test(data.morning_start)) setConfig('morning_start', data.morning_start);
      if (data.morning_end && /^\d{2}:\d{2}$/.test(data.morning_end)) setConfig('morning_end', data.morning_end);
      if (data.afternoon_start && /^\d{2}:\d{2}$/.test(data.afternoon_start)) setConfig('afternoon_start', data.afternoon_start);
      if (data.afternoon_end && /^\d{2}:\d{2}$/.test(data.afternoon_end)) setConfig('afternoon_end', data.afternoon_end);
      if (Array.isArray(data.working_days)) setConfig('working_days', JSON.stringify(data.working_days));

      broadcastEvent('settings_updated', { message: 'Configuración de horarios actualizada' });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Configuración guardada correctamente' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al guardar la configuración' }));
    }
  }

  // 10. Fichas de amigos
  if (pathname === '/api/admin/friends' && method === 'GET') {
    const friends = db.prepare(`
      SELECT 
        fc.client_name,
        fc.notes,
        fc.updated_at,
        COUNT(a.id) as total_appointments,
        MAX(a.date) as last_date
      FROM friend_cards fc
      LEFT JOIN appointments a ON fc.client_name = a.client_name AND a.status = 'confirmed'
      GROUP BY fc.client_name
      ORDER BY last_date DESC, fc.client_name ASC
    `).all();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ friends }));
  }

  if (pathname.startsWith('/api/admin/friends/') && !pathname.endsWith('/notes') && method === 'GET') {
    const rawName = pathname.replace('/api/admin/friends/', '');
    const clientName = decodeURIComponent(rawName);

    const friend = db.prepare('SELECT * FROM friend_cards WHERE client_name = ?').get(clientName);
    const history = db.prepare(`
      SELECT id, date, time, service, status, created_at 
      FROM appointments 
      WHERE client_name = ?
      ORDER BY date DESC, time DESC
    `).all(clientName);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      client_name: clientName,
      notes: friend ? friend.notes : '',
      history
    }));
  }

  if (pathname.startsWith('/api/admin/friends/') && pathname.endsWith('/notes') && method === 'POST') {
    try {
      const parts = pathname.split('/');
      const rawName = parts[parts.length - 2];
      const clientName = decodeURIComponent(rawName);
      const { notes } = await parseJsonBody(req);
      const cleanNotes = String(notes || '').replace(/[<>]/g, '').substring(0, 3000);

      db.prepare(`
        INSERT INTO friend_cards (client_name, notes, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(client_name) DO UPDATE SET notes = excluded.notes, updated_at = datetime('now')
      `).run(clientName, cleanNotes);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'Ficha actualizada' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al guardar ficha' }));
    }
  }

  // 11. DESCARGAR COPIA DE SEGURIDAD (BACKUP JSON COMPLETO)
  if (pathname === '/api/admin/backup' && method === 'GET') {
    const backupData = {
      app: 'Peluqueria Antigravity',
      version: '1.0',
      exported_at: new Date().toISOString(),
      config: db.prepare('SELECT key, value FROM config').all(),
      appointments: db.prepare('SELECT * FROM appointments').all(),
      friend_cards: db.prepare('SELECT * FROM friend_cards').all(),
      blocked_days: db.prepare('SELECT * FROM blocked_days').all()
    };

    const dateStr = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="copia_seguridad_pelu_${dateStr}.json"`
    });
    return res.end(JSON.stringify(backupData, null, 2));
  }

  // 12. RESTAURAR COPIA DE SEGURIDAD (IMPORTACIÓN ATÓMICA)
  if (pathname === '/api/admin/restore' && method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body || typeof body !== 'object' || (!body.appointments && !body.friend_cards && !body.config)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'El archivo no tiene un formato de copia de seguridad válido' }));
      }

      // Transacción atómica para garantizar consistencia total
      db.exec('BEGIN TRANSACTION');
      try {
        if (Array.isArray(body.config)) {
          const setCfg = db.prepare(`
            INSERT INTO config (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `);
          for (const item of body.config) {
            if (item.key && item.value !== undefined) {
              setCfg.run(item.key, String(item.value));
            }
          }
        }

        if (Array.isArray(body.appointments)) {
          db.exec('DELETE FROM appointments');
          const insertApp = db.prepare(`
            INSERT INTO appointments (id, date, time, client_name, client_phone, service, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const app of body.appointments) {
            insertApp.run(
              app.id || null,
              app.date,
              app.time,
              app.client_name,
              app.client_phone,
              app.service,
              app.status,
              app.created_at || new Date().toISOString(),
              app.updated_at || new Date().toISOString()
            );
          }
        }

        if (Array.isArray(body.friend_cards)) {
          db.exec('DELETE FROM friend_cards');
          const insertFriend = db.prepare(`
            INSERT INTO friend_cards (id, client_name, notes, updated_at)
            VALUES (?, ?, ?, ?)
          `);
          for (const f of body.friend_cards) {
            insertFriend.run(
              f.id || null,
              f.client_name,
              f.notes || '',
              f.updated_at || new Date().toISOString()
            );
          }
        }

        if (Array.isArray(body.blocked_days)) {
          db.exec('DELETE FROM blocked_days');
          const insertBlock = db.prepare(`
            INSERT INTO blocked_days (date, reason) VALUES (?, ?)
          `);
          for (const b of body.blocked_days) {
            insertBlock.run(b.date, b.reason || 'Día libre');
          }
        }

        db.exec('COMMIT');
      } catch (txErr) {
        db.exec('ROLLBACK');
        throw txErr;
      }

      broadcastEvent('settings_updated', { message: 'Copia de seguridad restaurada' });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        success: true, 
        message: 'Copia de seguridad restaurada correctamente',
        counts: {
          appointments: body.appointments ? body.appointments.length : 0,
          friends: body.friend_cards ? body.friend_cards.length : 0
        }
      }));
    } catch (err) {
      console.error('Error restaurando backup:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Error al restaurar: ' + err.message }));
    }
  }

  // --- SERVIR ARCHIVOS ESTÁTICOS CON PROTECCIÓN PATH TRAVERSAL ESTRICTA ---
  if (method === 'GET') {
    // Si la ruta contiene secuencias de escape de directorio, rechazar inmediatamente
    if (pathname.includes('..') || pathname.includes('%2e') || pathname.includes('%2E')) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Acceso denegado');
    }

    const sanitizedPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const resolvedPath = path.resolve(PUBLIC_DIR, sanitizedPath);

    // Verificación estricta anti-Directory Traversal
    if (!resolvedPath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Acceso denegado');
    }

    try {
      const stat = fs.statSync(resolvedPath);
      let targetFile = resolvedPath;
      if (stat.isDirectory()) {
        targetFile = path.join(resolvedPath, 'index.html');
      }

      const ext = path.extname(targetFile).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      const content = fs.readFileSync(targetFile);
      res.writeHead(200, { 'Content-Type': contentType });
      return res.end(content);
    } catch (err) {
      // Solo servir index.html como fallback si es una navegación directa del navegador (text/html)
      const acceptHeader = req.headers['accept'] || '';
      if (acceptHeader.includes('text/html') && !path.extname(pathname)) {
        try {
          const fallback = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(fallback);
        } catch (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('Archivo no encontrado');
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Archivo no encontrado');
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`💈 Servidor Peluquería Seguro en: http://localhost:${PORT}`);
  console.log(`🛡️ Rate limiting, Sanitización y Sesiones 24h activas`);
  console.log(`🔑 Contraseña de acceso por defecto: pelu1234`);
  console.log(`=======================================================`);
});
