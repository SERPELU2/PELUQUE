// ========================================================
// APLICACIÓN DE CITAS DE PELUQUERÍA - CLIENTE Y ADMIN
// ========================================================

const state = {
  selectedDate: null, // 'YYYY-MM-DD'
  services: [],
  workingDays: [1, 2, 3, 4, 5, 6],
  adminToken: localStorage.getItem('pelu_admin_token') || null,
  activeAdminTab: 'tabAppointments',
  selectedFriendName: null
};

// Utilidad de seguridad contra XSS (Cross-Site Scripting)
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Formateador de fechas en castellano
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const SHORT_DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

function formatDateToIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIsoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDisplayDate(iso) {
  const d = parseIsoToDate(iso);
  const dayName = DAY_NAMES[d.getDay()];
  const dayNum = d.getDate();
  const monthName = MONTH_NAMES[d.getMonth()];
  return `${dayName}, ${dayNum} de ${monthName}`;
}

// ========================================================
// INICIALIZACIÓN
// ========================================================
document.addEventListener('DOMContentLoaded', async () => {
  initTodayDate();
  renderDaysStrip();
  await loadSalonInfo();
  await loadCalendarForSelectedDate();
  initRealtimeEvents();
  setupEventListeners();

  if (state.adminToken) {
    document.getElementById('adminLoginView').classList.add('hidden');
    document.getElementById('adminDashboardView').classList.remove('hidden');
  }
});

function initTodayDate() {
  const today = new Date();
  state.selectedDate = formatDateToIso(today);
}

// Cargar información del salón y servicios disponibles
async function loadSalonInfo() {
  try {
    const res = await fetch('/api/public/info');
    if (!res.ok) return;
    const data = await res.json();
    if (data.salonName) {
      document.getElementById('salonName').textContent = data.salonName;
    }
    state.services = data.services || [];
    state.workingDays = data.workingDays || [1, 2, 3, 4, 5, 6];

    populatePublicServicesDropdown();
  } catch (err) {
    console.error('Error cargando información pública:', err);
  }
}

function populatePublicServicesDropdown() {
  const serviceSelect = document.getElementById('bookService');
  if (!serviceSelect) return;
  serviceSelect.innerHTML = state.services
    .map(s => {
      const name = typeof s === 'object' && s !== null ? s.name : s;
      const duration = typeof s === 'object' && s !== null && s.duration ? s.duration : 45;
      return `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${duration} min)</option>`;
    })
    .join('');
}

// ========================================================
// RENDERIZADO DEL SELECTOR DE DÍAS (CARRUSEL TÁCTIL)
// ========================================================
function renderDaysStrip(baseIso) {
  const strip = document.getElementById('daysStrip');
  strip.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let startDate;
  if (baseIso) {
    startDate = parseIsoToDate(baseIso);
  } else {
    startDate = new Date(today);
  }

  // Si la fecha base está en el pasado con respecto a hoy, comenzar en hoy
  if (startDate < today) {
    startDate = new Date(today);
  }

  const daysToShow = 28;

  for (let i = 0; i < daysToShow; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const iso = formatDateToIso(d);

    const isToday = formatDateToIso(today) === iso;
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const isTomorrow = formatDateToIso(tomorrow) === iso;

    const pill = document.createElement('div');
    pill.className = `day-pill ${iso === state.selectedDate ? 'active' : ''}`;
    pill.dataset.date = iso;

    const dayName = isToday ? 'Hoy' : (isTomorrow ? 'Mañana' : SHORT_DAY_NAMES[d.getDay()]);
    const dayNum = d.getDate();
    const monthName = MONTH_NAMES[d.getMonth()].substring(0, 3);

    pill.innerHTML = `
      <span class="day-pill-name">${escapeHtml(dayName)}</span>
      <span class="day-pill-num">${dayNum}</span>
      <span class="day-pill-month">${escapeHtml(monthName)}</span>
    `;

    pill.addEventListener('click', () => {
      selectDate(iso);
    });

    strip.appendChild(pill);
  }
}

function selectDate(iso) {
  state.selectedDate = iso;

  document.querySelectorAll('.day-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.date === iso);
  });

  const activePill = document.querySelector(`.day-pill[data-date="${iso}"]`);
  if (activePill) {
    activePill.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  loadCalendarForSelectedDate();
}

// ========================================================
// CARGA Y RENDERIZADO DEL CALENDARIO DE FRANJAS
// ========================================================
async function loadCalendarForSelectedDate() {
  const dateTitle = document.getElementById('currentDateTitle');
  dateTitle.textContent = formatDisplayDate(state.selectedDate);

  const morningGrid = document.getElementById('morningSlotsGrid');
  const afternoonGrid = document.getElementById('afternoonSlotsGrid');
  const blockedNotice = document.getElementById('dayBlockedNotice');
  const morningSection = document.getElementById('morningSection');
  const afternoonSection = document.getElementById('afternoonSection');

  morningGrid.innerHTML = '<div class="loading-slots">Cargando horarios...</div>';
  afternoonGrid.innerHTML = '<div class="loading-slots">Cargando horarios...</div>';

  try {
    // Enviamos la fecha local del cliente para que el servidor pueda corregir desfases de zona horaria
    const clientToday = formatDateToIso(new Date());
    const res = await fetch(`/api/public/calendar?date=${state.selectedDate}&today=${clientToday}`);
    const data = await res.json();

    if (data.isDayBlocked) {
      blockedNotice.classList.remove('hidden');
      document.getElementById('blockedReasonTitle').textContent = data.reason || 'Día no disponible';
      morningSection.classList.add('hidden');
      afternoonSection.classList.add('hidden');
      return;
    }

    blockedNotice.classList.add('hidden');
    morningSection.classList.remove('hidden');
    afternoonSection.classList.remove('hidden');

    // Comprobación estricta de hoy o pasado (tanto por servidor como por fecha local)
    const clientTodayIso = formatDateToIso(new Date());
    const isTodayOrPast = state.selectedDate <= clientTodayIso || Boolean(data.isTodayClosed);

    const subtitle = document.getElementById('currentDateSubtitle');
    if (isTodayOrPast) {
      if (subtitle) {
        subtitle.textContent = '🔒 Reservas de hoy no disponibles. Todas las horas están reservadas.';
        subtitle.style.color = '#B8860B';
      }
    } else {
      if (subtitle) {
        subtitle.textContent = 'Selecciona una hora para reservar';
        subtitle.style.color = '';
      }
    }

    // Si es hoy o un día pasado: Forzar TODOS los slots a estado 'confirmed' (rojo y no seleccionable)
    const processedSlots = (data.slots || []).map(s => {
      if (isTodayOrPast) {
        return { ...s, status: 'confirmed' };
      }
      return s;
    });

    const morningSlots = processedSlots.filter(s => s.period === 'mañana');
    const afternoonSlots = processedSlots.filter(s => s.period === 'tarde');

    renderSlotsGroup(morningGrid, morningSlots);
    renderSlotsGroup(afternoonGrid, afternoonSlots);

    if (morningSlots.length === 0) {
      morningGrid.innerHTML = '<div class="no-slots">Sin horas en la mañana</div>';
    }
    if (afternoonSlots.length === 0) {
      afternoonGrid.innerHTML = '<div class="no-slots">Sin horas en la tarde</div>';
    }

  } catch (err) {
    console.error('Error cargando calendario:', err);
    morningGrid.innerHTML = '<div class="error-msg">Error al cargar las horas</div>';
    afternoonGrid.innerHTML = '';
  }
}

function renderSlotsGroup(container, slots) {
  container.innerHTML = '';

  slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.className = `slot-button slot-${slot.status}`;
    btn.dataset.time = slot.time;
    btn.dataset.date = state.selectedDate;

    let statusText = 'Disponible';
    if (slot.status === 'pending') statusText = 'En revisión';
    if (slot.status === 'confirmed') statusText = 'Ocupada';

    btn.innerHTML = `
      <span class="slot-time">${escapeHtml(slot.time)}</span>
      <span class="slot-status-label">${escapeHtml(statusText)}</span>
    `;

    if (slot.status === 'available') {
      btn.title = `Reservar cita a las ${slot.time}`;
      btn.addEventListener('click', () => {
        openBookingModal(state.selectedDate, slot.time);
      });
    } else {
      btn.disabled = true;
      if (slot.status === 'pending') {
        btn.title = 'Esta cita ha sido solicitada por un amigo y está pendiente de aprobación';
      } else {
        btn.title = 'Hora ocupada y confirmada';
      }
    }

    container.appendChild(btn);
  });
}

// ========================================================
// TIEMPO REAL: SERVER-SENT EVENTS (SSE)
// ========================================================
function initRealtimeEvents() {
  const liveIndicator = document.getElementById('liveIndicator');

  try {
    const eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
      liveIndicator.style.opacity = '1';
    };

    eventSource.addEventListener('slot_update', (e) => {
      const data = JSON.parse(e.data);
      if (data.date === state.selectedDate) {
        updateSlotElementInDom(data.time, data.status);
      }
      if (state.adminToken && !document.getElementById('adminModal').classList.contains('hidden')) {
        loadAdminAppointments();
      }

      if (data.status === 'pending') {
        playChimeSound();
        if (state.adminToken) {
          const clientName = data.client_name || 'Un amigo';
          const srvName = data.service || 'Cita';
          const duration = data.duration ? ` (${data.duration} min)` : '';
          triggerPushNotification(
            '💈 ¡Nueva cita por confirmar!',
            `${clientName} ha solicitado ${srvName}${duration} el ${data.date} a las ${data.time} h.`
          );
        }
      }
    });

    eventSource.addEventListener('services_updated', (e) => {
      const data = JSON.parse(e.data);
      if (Array.isArray(data.services)) {
        state.services = data.services;
        populatePublicServicesDropdown();
        if (state.activeAdminTab === 'tabServices') {
          renderAdminServicesList();
        }
      }
    });

    eventSource.addEventListener('settings_updated', () => {
      loadSalonInfo();
      loadCalendarForSelectedDate();
    });

    eventSource.onerror = () => {
      liveIndicator.style.opacity = '0.5';
    };
  } catch (err) {
    console.warn('SSE no disponible:', err);
  }
}

function updateSlotElementInDom(time, status) {
  const clientToday = formatDateToIso(new Date());
  if (state.selectedDate <= clientToday) {
    // Si la fecha actual es hoy o anterior, las franjas deben permanecer siempre en rojo
    return;
  }

  const btn = document.querySelector(`.slot-button[data-time="${time}"][data-date="${state.selectedDate}"]`);
  if (!btn) return;

  btn.className = `slot-button slot-${status}`;
  const label = btn.querySelector('.slot-status-label');

  if (status === 'available') {
    label.textContent = 'Disponible';
    btn.disabled = false;
    btn.onclick = () => openBookingModal(state.selectedDate, time);
  } else if (status === 'pending') {
    label.textContent = 'En revisión';
    btn.disabled = true;
    btn.onclick = null;
  } else if (status === 'confirmed') {
    label.textContent = 'Ocupada';
    btn.disabled = true;
    btn.onclick = null;
  }
}

// ========================================================
// VENTANA MODAL DE RESERVA (AMIGOS)
// ========================================================
function openBookingModal(dateIso, time) {
  const modal = document.getElementById('bookingModal');
  document.getElementById('bookDate').value = dateIso;
  document.getElementById('bookTime').value = time;
  document.getElementById('modalBookingSubtitle').textContent = `${formatDisplayDate(dateIso)} a las ${time} h`;
  
  document.getElementById('bookingErrorMsg').classList.add('hidden');
  document.getElementById('bookClientName').value = '';
  document.getElementById('bookClientPhone').value = '';
  const notesEl = document.getElementById('bookNotes');
  const counterEl = document.getElementById('bookNotesCounter');
  if (notesEl) notesEl.value = '';
  if (counterEl) {
    counterEl.textContent = '0/256';
    counterEl.classList.remove('limit-near');
  }

  modal.classList.remove('hidden');
  document.getElementById('bookClientName').focus();
}

function closeBookingModal() {
  document.getElementById('bookingModal').classList.add('hidden');
}

// Enviar Reserva con sanitización y feedback
document.getElementById('bookingForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const date = document.getElementById('bookDate').value;
  const time = document.getElementById('bookTime').value;
  const service = document.getElementById('bookService').value;
  const client_name = document.getElementById('bookClientName').value.trim();
  const client_phone = document.getElementById('bookClientPhone').value.trim();
  const notesEl = document.getElementById('bookNotes');
  const notes = notesEl ? notesEl.value.trim() : '';
  const clientToday = formatDateToIso(new Date());
  const errorMsg = document.getElementById('bookingErrorMsg');
  const btnSubmit = document.getElementById('btnSubmitBooking');

  if (!client_name || !client_phone) {
    errorMsg.textContent = 'Por favor completa tu nombre y número de teléfono.';
    errorMsg.classList.remove('hidden');
    return;
  }

  btnSubmit.disabled = true;
  btnSubmit.querySelector('.btn-text').textContent = 'Mandando...';
  btnSubmit.querySelector('.spinner').classList.remove('hidden');
  errorMsg.classList.add('hidden');

  try {
    const res = await fetch('/api/public/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, time, service, client_name, client_phone, notes, clientToday })
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || 'Error al procesar la reserva');
    }

    closeBookingModal();
    document.getElementById('successSummaryText').innerHTML = `
      Cita para <strong>${escapeHtml(client_name)}</strong> (${escapeHtml(service)}) el <strong>${formatDisplayDate(date)}</strong> a las <strong>${escapeHtml(time)} h</strong>.
    `;
    document.getElementById('successModal').classList.remove('hidden');

  } catch (err) {
    errorMsg.textContent = err.message;
    errorMsg.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.querySelector('.btn-text').textContent = 'Mandar Reserva';
    btnSubmit.querySelector('.spinner').classList.add('hidden');
  }
});

// ========================================================
// PANEL PRIVADO DEL PELUQUERO (ADMIN)
// ========================================================
function openAdminModal() {
  const modal = document.getElementById('adminModal');
  modal.classList.remove('hidden');

  updatePushButtonUI();

  if (state.adminToken) {
    document.getElementById('adminLoginView').classList.add('hidden');
    document.getElementById('adminDashboardView').classList.remove('hidden');
    loadActiveAdminTab();
  } else {
    document.getElementById('adminLoginView').classList.remove('hidden');
    document.getElementById('adminDashboardView').classList.add('hidden');
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('adminPasswordInput').focus();
  }
}

function closeAdminModal() {
  document.getElementById('adminModal').classList.add('hidden');
}

function loadActiveAdminTab() {
  if (state.activeAdminTab === 'tabAppointments') loadAdminAppointments();
  if (state.activeAdminTab === 'tabFriends') loadAdminFriends();
  if (state.activeAdminTab === 'tabServices') loadAdminServices();
  if (state.activeAdminTab === 'tabSchedule') loadAdminSettings();
  if (state.activeAdminTab === 'tabShare') loadAdminShare();
  if (state.activeAdminTab === 'tabBackup') initBackupSection();
}

// Iniciar sesión del peluquero
document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('adminPasswordInput').value;
  const errorEl = document.getElementById('adminLoginError');

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Contraseña incorrecta');
    }

    state.adminToken = data.token;
    localStorage.setItem('pelu_admin_token', data.token);

    errorEl.classList.add('hidden');
    document.getElementById('adminLoginView').classList.add('hidden');
    document.getElementById('adminDashboardView').classList.remove('hidden');

    loadActiveAdminTab();

  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// Cerrar sesión
document.getElementById('btnLogoutAdmin').addEventListener('click', () => {
  state.adminToken = null;
  localStorage.removeItem('pelu_admin_token');
  document.getElementById('adminDashboardView').classList.add('hidden');
  document.getElementById('adminLoginView').classList.remove('hidden');
});

// Pestañas del Admin
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-tab-pane').forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    document.getElementById(tabId).classList.add('active');
    state.activeAdminTab = tabId;

    loadActiveAdminTab();
  });
});

// ========================================================
// PESTAÑA 1: CITAS Y WHATSAPP
// ========================================================
async function loadAdminAppointments() {
  if (!state.adminToken) return;

  const dateFilter = document.getElementById('filterAdminDate').value;
  const listContainer = document.getElementById('appointmentsList');
  const badgeCount = document.getElementById('pendingBadgeCount');

  listContainer.innerHTML = '<div class="loading-state">Cargando citas...</div>';

  try {
    let url = '/api/admin/appointments';
    if (dateFilter) url += `?date=${encodeURIComponent(dateFilter)}`;

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });

    if (res.status === 401) {
      state.adminToken = null;
      localStorage.removeItem('pelu_admin_token');
      openAdminModal();
      return;
    }

    const data = await res.json();
    const appointments = data.appointments || [];

    const pendingCount = appointments.filter(a => a.status === 'pending').length;
    if (pendingCount > 0) {
      badgeCount.textContent = pendingCount;
      badgeCount.classList.remove('hidden');
    } else {
      badgeCount.classList.add('hidden');
    }

    if (appointments.length === 0) {
      listContainer.innerHTML = '<div class="empty-state">No hay citas registradas para esta selección.</div>';
      return;
    }

    listContainer.innerHTML = appointments.map(app => renderAppointmentCard(app)).join('');

    document.querySelectorAll('.btn-approve-appointment').forEach(btn => {
      btn.addEventListener('click', () => approveAppointment(btn.dataset.id, btn.dataset.phone, btn.dataset.name, btn.dataset.service, btn.dataset.date, btn.dataset.time));
    });

    document.querySelectorAll('.btn-reject-appointment').forEach(btn => {
      btn.addEventListener('click', () => rejectAppointment(btn.dataset.id, btn.dataset.phone, btn.dataset.name, btn.dataset.service, btn.dataset.date, btn.dataset.time));
    });

  } catch (err) {
    console.error('Error cargando citas de admin:', err);
    listContainer.innerHTML = '<div class="error-msg">Error al cargar las citas</div>';
  }
}

function renderAppointmentCard(app) {
  const isPending = app.status === 'pending';
  const isConfirmed = app.status === 'confirmed';

  let cleanPhone = String(app.client_phone).replace(/\D/g, '');
  if (cleanPhone.length === 9) cleanPhone = '34' + cleanPhone;

  return `
    <div class="app-card" id="appCard-${app.id}">
      <div class="app-card-header">
        <div>
          <span class="app-card-time">${escapeHtml(app.time)} h</span>
          <span class="app-card-date">• ${formatDisplayDate(app.date)}</span>
        </div>
        <span class="app-status-badge status-badge-${escapeHtml(app.status)}">
          ${isPending ? 'Pendiente (Gris)' : (isConfirmed ? 'Confirmada (Roja)' : 'Cancelada')}
        </span>
      </div>

      <div class="app-card-body">
        <div class="app-client-name">👤 ${escapeHtml(app.client_name)}</div>
        <div class="app-service-name">✂️ ${escapeHtml(app.service)}${app.duration ? ` <span class="app-duration-badge">(${app.duration} min)</span>` : ''}</div>
        <div class="app-client-phone">📱 Tel: ${escapeHtml(app.client_phone)}</div>
        ${app.notes ? `<div class="app-notes">💬 ${escapeHtml(app.notes)}</div>` : ''}
      </div>

      <div class="app-card-actions">
        ${isPending ? `
          <button class="btn-wa-confirm btn-approve-appointment" 
            data-id="${app.id}" 
            data-phone="${cleanPhone}" 
            data-name="${escapeHtml(app.client_name)}" 
            data-service="${escapeHtml(app.service)}" 
            data-date="${escapeHtml(app.date)}" 
            data-time="${escapeHtml(app.time)}">
            <span>✓ Aprobar (Pasa a Rojo) y Enviar WhatsApp</span>
          </button>
          
          <button class="btn-wa-cancel btn-reject-appointment" 
            data-id="${app.id}" 
            data-phone="${cleanPhone}" 
            data-name="${escapeHtml(app.client_name)}" 
            data-service="${escapeHtml(app.service)}" 
            data-date="${escapeHtml(app.date)}" 
            data-time="${escapeHtml(app.time)}">
            <span>✕ Rechazar (Vuelve a Verde)</span>
          </button>
        ` : (isConfirmed ? `
          <button class="btn-wa-cancel btn-reject-appointment" 
            data-id="${app.id}" 
            data-phone="${cleanPhone}" 
            data-name="${escapeHtml(app.client_name)}" 
            data-service="${escapeHtml(app.service)}" 
            data-date="${escapeHtml(app.date)}" 
            data-time="${escapeHtml(app.time)}">
            <span>Cancelar Cita (Liberar a Verde)</span>
          </button>
        ` : `
          <span class="cancelled-note">Cita liberada</span>
        `)}
      </div>
    </div>
  `;
}

// Aprobar cita y abrir WhatsApp personal
async function approveAppointment(id, phone, name, service, date, time) {
  try {
    const res = await fetch(`/api/admin/appointments/${id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.adminToken}`
      },
      body: JSON.stringify({ status: 'confirmed' })
    });

    if (!res.ok) throw new Error('No se pudo aprobar la cita');

    const displayDate = formatDisplayDate(date);
    const textMsg = `¡Hola ${name}! Te confirmo tu cita para ${service} el ${displayDate} a las ${time} h. ¡Te espero! 💈`;
    const waUrl = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(textMsg)}`;

    window.open(waUrl, '_blank');
    loadAdminAppointments();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Rechazar cita y notificar por WhatsApp
async function rejectAppointment(id, phone, name, service, date, time) {
  const confirmCancel = confirm(`¿Quieres cancelar la cita de ${name}? La hora volverá a quedar disponible en verde.`);
  if (!confirmCancel) return;

  try {
    const res = await fetch(`/api/admin/appointments/${id}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.adminToken}`
      },
      body: JSON.stringify({ status: 'cancelled' })
    });

    if (!res.ok) throw new Error('No se pudo cancelar la cita');

    const textMsg = "por motivos externos no es posible aceptar su peticion, contactar directamente";
    const waUrl = `https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(textMsg)}`;

    window.open(waUrl, '_blank');
    loadAdminAppointments();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ========================================================
// PESTAÑA 2: FICHAS DE AMIGOS Y TINTES
// ========================================================
async function loadAdminFriends() {
  if (!state.adminToken) return;

  const friendsList = document.getElementById('friendsList');
  friendsList.innerHTML = '<div class="loading-state">Cargando amigos...</div>';

  try {
    const res = await fetch('/api/admin/friends', {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });
    const data = await res.json();
    const friends = data.friends || [];

    if (friends.length === 0) {
      friendsList.innerHTML = '<div class="empty-state">Aún no hay amigos registrados.</div>';
      return;
    }

    friendsList.innerHTML = friends.map(f => `
      <button class="friend-item-btn ${state.selectedFriendName === f.client_name ? 'active' : ''}" data-name="${escapeHtml(f.client_name)}">
        <span>${escapeHtml(f.client_name)}</span>
        <span class="badge-count">${f.total_appointments}</span>
      </button>
    `).join('');

    document.querySelectorAll('.friend-item-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectFriendCard(btn.dataset.name);
      });
    });

    const searchInput = document.getElementById('searchFriendInput');
    searchInput.oninput = () => {
      const q = searchInput.value.toLowerCase().trim();
      document.querySelectorAll('.friend-item-btn').forEach(btn => {
        const name = btn.dataset.name.toLowerCase();
        btn.style.display = name.includes(q) ? 'flex' : 'none';
      });
    };

    if (state.selectedFriendName) {
      selectFriendCard(state.selectedFriendName);
    }

  } catch (err) {
    console.error('Error cargando amigos:', err);
  }
}

async function selectFriendCard(clientName) {
  state.selectedFriendName = clientName;

  document.querySelectorAll('.friend-item-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.name === clientName);
  });

  const detailBox = document.getElementById('friendDetailCard');
  detailBox.className = 'friend-detail-card';
  detailBox.innerHTML = '<div class="loading-state">Cargando ficha técnica...</div>';

  try {
    const res = await fetch(`/api/admin/friends/${encodeURIComponent(clientName)}`, {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });
    const data = await res.json();

    const historyItems = (data.history || []).map(h => `
      <div class="history-item">
        <span><strong>${formatDisplayDate(h.date)}</strong> (${escapeHtml(h.time)}h)</span>
        <span>${escapeHtml(h.service)}</span>
      </div>
    `).join('');

    detailBox.innerHTML = `
      <h3 class="friend-card-title">Ficha de: ${escapeHtml(data.client_name)}</h3>
      <p class="field-hint">Ficha privada del peluquero con fórmulas y observaciones históricas.</p>

      <h5 class="mt-3">Historial de Tratamientos Realizados:</h5>
      <div class="friend-history-box">
        ${historyItems || '<p class="text-muted">Sin citas previas completadas aún.</p>'}
      </div>

      <div class="form-group mt-3">
        <label for="friendNotesInput">Observaciones de Tintes y Productos Utilizados:</label>
        <textarea id="friendNotesInput" class="notes-textarea" placeholder="Ej. Tinte 7.1 con oxidante 20 volúmenes en raíz. Pelo seco, aplicar mascarilla de argán.">${escapeHtml(data.notes || '')}</textarea>
        <span class="field-hint">Anota aquí fórmulas de color, números de tinte y productos para recordar en su próxima visita.</span>
      </div>

      <div id="saveNotesFeedback" class="form-alert success-alert hidden">Observaciones guardadas con éxito</div>
      <button id="btnSaveFriendNotes" class="btn btn-primary btn-block">Guardar Observaciones</button>
    `;

    document.getElementById('btnSaveFriendNotes').addEventListener('click', async () => {
      const notes = document.getElementById('friendNotesInput').value;
      const feedback = document.getElementById('saveNotesFeedback');

      try {
        const saveRes = await fetch(`/api/admin/friends/${encodeURIComponent(clientName)}/notes`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${state.adminToken}`
          },
          body: JSON.stringify({ notes })
        });

        if (!saveRes.ok) throw new Error('Error al guardar');

        feedback.classList.remove('hidden');
        setTimeout(() => feedback.classList.add('hidden'), 2500);
      } catch (e) {
        alert('Error al guardar ficha: ' + e.message);
      }
    });

  } catch (err) {
    detailBox.innerHTML = '<div class="error-msg">Error al cargar la ficha del amigo</div>';
  }
}

// ========================================================
// PESTAÑA 3: GESTIÓN DE SERVICIOS (MODIFICAR Y ELIMINAR)
// ========================================================
async function loadAdminServices() {
  if (!state.adminToken) return;

  try {
    const res = await fetch('/api/admin/services', {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });
    const data = await res.json();
    state.services = data.services || [];
    renderAdminServicesList();
  } catch (err) {
    console.error('Error cargando servicios:', err);
  }
}

function renderAdminServicesList() {
  const container = document.getElementById('adminServicesList');
  if (!container) return;

  if (state.services.length === 0) {
    container.innerHTML = '<div class="empty-state">No tienes servicios configurados. Añade uno arriba.</div>';
    return;
  }

  container.innerHTML = state.services.map((srv, idx) => {
    const name = typeof srv === 'object' && srv !== null ? srv.name : srv;
    const duration = typeof srv === 'object' && srv !== null && srv.duration ? srv.duration : 45;
    return `
      <div class="service-item-row" data-index="${idx}">
        <div class="service-info-col">
          <span class="service-name-text">✂️ ${escapeHtml(name)}</span>
          <span class="service-duration-badge">⏱️ ${duration} min</span>
        </div>
        <div class="service-actions">
          <button class="btn-service-action btn-edit-srv" data-index="${idx}" data-name="${escapeHtml(name)}" data-duration="${duration}">✏️ Editar</button>
          <button class="btn-service-action btn-delete-srv" data-index="${idx}" data-name="${escapeHtml(name)}">🗑️ Eliminar</button>
        </div>
      </div>
    `;
  }).join('');

  // Listeners para editar
  document.querySelectorAll('.btn-edit-srv').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.index;
      const currentName = btn.dataset.name;
      const currentDuration = btn.dataset.duration || 45;
      const newName = prompt('Modificar nombre del servicio:', currentName);
      if (newName === null) return;
      const validName = newName.trim() || currentName;
      const newDurationPrompt = prompt(`Duración en minutos para "${validName}" (ej: 30, 45, 60, 90):`, currentDuration);
      if (newDurationPrompt === null) return;
      const validDuration = Math.max(15, parseInt(newDurationPrompt, 10) || 45);
      updateService(idx, validName, validDuration);
    });
  });

  // Listeners para eliminar
  document.querySelectorAll('.btn-delete-srv').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.index;
      const srvName = btn.dataset.name;
      if (confirm(`¿Estás seguro de que quieres eliminar el servicio "${srvName}"?`)) {
        deleteService(idx);
      }
    });
  });
}

// Formulario para añadir servicio
document.getElementById('addServiceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('newServiceName');
  const durationInput = document.getElementById('newServiceDuration');
  const name = input.value.trim();
  const duration = parseInt(durationInput ? durationInput.value : 45, 10) || 45;
  const feedback = document.getElementById('serviceFeedback');

  if (!name) return;

  try {
    const res = await fetch('/api/admin/services', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.adminToken}`
      },
      body: JSON.stringify({ name, duration })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo añadir');

    state.services = data.services;
    input.value = '';
    if (durationInput) durationInput.value = '45';
    renderAdminServicesList();
    populatePublicServicesDropdown();

    feedback.textContent = `Servicio "${name}" (${duration} min) añadido con éxito`;
    feedback.className = 'form-alert success-alert';
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 2500);

  } catch (err) {
    feedback.textContent = err.message;
    feedback.className = 'form-alert error-alert';
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 3000);
  }
});

async function updateService(index, name, duration) {
  try {
    const res = await fetch(`/api/admin/services/${index}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.adminToken}`
      },
      body: JSON.stringify({ name, duration })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al actualizar');

    state.services = data.services;
    renderAdminServicesList();
    populatePublicServicesDropdown();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteService(index) {
  try {
    const res = await fetch(`/api/admin/services/${index}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${state.adminToken}`
      }
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al eliminar');

    state.services = data.services;
    renderAdminServicesList();
    populatePublicServicesDropdown();
  } catch (err) {
    alert(err.message);
  }
}

// ========================================================
// PESTAÑA 4: HORARIOS Y CONFIGURACIÓN
// ========================================================
async function loadAdminSettings() {
  if (!state.adminToken) return;

  try {
    const res = await fetch('/api/admin/settings', {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });
    const s = await res.json();

    document.getElementById('cfgSalonName').value = s.peluquero_name || '';
    document.getElementById('cfgMorningStart').value = s.morning_start || '09:30';
    document.getElementById('cfgMorningEnd').value = s.morning_end || '13:30';
    document.getElementById('cfgAfternoonStart').value = s.afternoon_start || '16:00';
    document.getElementById('cfgAfternoonEnd').value = s.afternoon_end || '20:30';
    document.getElementById('cfgSlotDuration').value = s.slot_duration_minutes || '45';

    const days = s.working_days || [1, 2, 3, 4, 5, 6];
    document.querySelectorAll('input[name="workday"]').forEach(chk => {
      chk.checked = days.includes(Number(chk.value));
    });

  } catch (err) {
    console.error('Error cargando configuración:', err);
  }
}

document.getElementById('scheduleConfigForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const workingDays = [];
  document.querySelectorAll('input[name="workday"]:checked').forEach(chk => {
    workingDays.push(Number(chk.value));
  });

  const payload = {
    peluquero_name: document.getElementById('cfgSalonName').value,
    morning_start: document.getElementById('cfgMorningStart').value,
    morning_end: document.getElementById('cfgMorningEnd').value,
    afternoon_start: document.getElementById('cfgAfternoonStart').value,
    afternoon_end: document.getElementById('cfgAfternoonEnd').value,
    slot_duration_minutes: document.getElementById('cfgSlotDuration').value,
    working_days: workingDays
  };

  const newPass = document.getElementById('cfgNewPassword').value.trim();
  if (newPass) {
    payload.admin_password = newPass;
  }

  const feedback = document.getElementById('settingsFeedback');

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.adminToken}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error('Error al guardar ajustes');

    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 3000);
    document.getElementById('cfgNewPassword').value = '';

    loadCalendarForSelectedDate();
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
});

// ========================================================
// PESTAÑA 5: COMPARTIR CÓDIGO QR Y ENLACE WHATSAPP
// ========================================================
function loadAdminShare() {
  const shareInput = document.getElementById('shareUrlInput');
  const qrContainer = document.getElementById('qrCodeContainer');
  const currentUrl = window.location.origin;

  shareInput.value = currentUrl;

  // Generar código QR dinámico
  if (window.QRCodeApp) {
    const qr = new window.QRCodeApp(currentUrl, {
      size: 200,
      colorDark: '#2C221E',
      colorLight: '#FFFFFF'
    });
    qrContainer.innerHTML = qr.toSVG();
  } else {
    // Fallback imagen directa
    const encUrl = encodeURIComponent(currentUrl);
    qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encUrl}&color=2C221E&bgcolor=FFFFFF" alt="Código QR de la Peluquería" width="200" height="200">`;
  }
}

// Botón Copiar Enlace
document.getElementById('btnCopyShareUrl').addEventListener('click', () => {
  const input = document.getElementById('shareUrlInput');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    const btnText = document.getElementById('copyBtnText');
    btnText.textContent = '¡Copiado! ✓';
    setTimeout(() => {
      btnText.textContent = '📋 Copiar';
    }, 2000);
  }).catch(() => {
    alert('Enlace: ' + input.value);
  });
});

// Botón Enviar Enlace por WhatsApp
document.getElementById('btnShareWhatsApp').addEventListener('click', () => {
  const url = document.getElementById('shareUrlInput').value;
  const msg = `¡Hola! He preparado este enlace para que puedas ver mis horas libres y reservar tu cita de peluquería cómodamente cuando quieras:\n\n${url}\n\n¡Elige el día y hora que mejor te venga! 💈✨`;
  const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
});

// ========================================================
// PESTAÑA 6: COPIA DE SEGURIDAD Y RESTAURACIÓN
// ========================================================
function initBackupSection() {
  const feedback = document.getElementById('backupFeedback');
  if (feedback) feedback.classList.add('hidden');
}

// Descargar Copia de Seguridad
document.getElementById('btnDownloadBackup').addEventListener('click', async () => {
  const feedback = document.getElementById('backupFeedback');

  try {
    const res = await fetch('/api/admin/backup', {
      headers: { 'Authorization': `Bearer ${state.adminToken}` }
    });

    if (!res.ok) throw new Error('Error al generar la copia de seguridad');

    const blob = await res.blob();
    const dateStr = formatDateToIso(new Date());
    const fileName = `copia_seguridad_peluqueria_${dateStr}.json`;

    // Disparar descarga en el navegador
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(downloadUrl);

    feedback.textContent = `¡Copia de seguridad descargada con éxito (${fileName})!`;
    feedback.className = 'form-alert success-alert mt-3';
    feedback.classList.remove('hidden');
    setTimeout(() => feedback.classList.add('hidden'), 4000);

  } catch (err) {
    feedback.textContent = err.message;
    feedback.className = 'form-alert error-alert mt-3';
    feedback.classList.remove('hidden');
  }
});

// Restaurar o Corregir Datos desde Archivo JSON
document.getElementById('btnRestoreBackup').addEventListener('click', async () => {
  const fileInput = document.getElementById('backupFileInput');
  const feedback = document.getElementById('backupFeedback');

  if (!fileInput.files || fileInput.files.length === 0) {
    feedback.textContent = 'Por favor selecciona primero un archivo .json de copia de seguridad.';
    feedback.className = 'form-alert error-alert mt-3';
    feedback.classList.remove('hidden');
    return;
  }

  const file = fileInput.files[0];
  const confirmRestore = confirm(`¿Estás seguro de que quieres restaurar la copia "${file.name}"? Los datos actuales serán reemplazados por los del archivo.`);
  if (!confirmRestore) return;

  try {
    const fileText = await file.text();
    let jsonData;
    try {
      jsonData = JSON.parse(fileText);
    } catch (e) {
      throw new Error('El archivo seleccionado no es un JSON válido o está dañado.');
    }

    const res = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.adminToken}`
      },
      body: JSON.stringify(jsonData)
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Error al restaurar los datos');

    feedback.textContent = `¡Restauración completada con éxito! Se han cargado ${result.counts.appointments} citas y ${result.counts.friends} fichas de amigos.`;
    feedback.className = 'form-alert success-alert mt-3';
    feedback.classList.remove('hidden');
    fileInput.value = '';

    // Recargar datos en la interfaz
    loadSalonInfo();
    loadCalendarForSelectedDate();
    loadAdminAppointments();
    loadAdminFriends();

  } catch (err) {
    feedback.textContent = err.message;
    feedback.className = 'form-alert error-alert mt-3';
    feedback.classList.remove('hidden');
  }
});

// ========================================================
// LISTENERS GENERALES Y NOTIFICACIONES PUSH
// ========================================================
let swRegistration = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then(reg => {
      swRegistration = reg;
    })
    .catch(err => console.warn('SW error:', err));
}

function updatePushButtonUI() {
  const btn = document.getElementById('btnTogglePush');
  const icon = document.getElementById('pushIcon');
  const text = document.getElementById('pushText');
  if (!btn || !icon || !text) return;

  if (!('Notification' in window)) {
    btn.style.display = 'none';
    return;
  }

  if (Notification.permission === 'granted') {
    btn.classList.add('active');
    icon.textContent = '🔔';
    text.textContent = 'Avisos Activos';
  } else if (Notification.permission === 'denied') {
    btn.classList.remove('active');
    icon.textContent = '🔕';
    text.textContent = 'Avisos Bloqueados';
  } else {
    btn.classList.remove('active');
    icon.textContent = '🔔';
    text.textContent = 'Avisos Móvil';
  }
}

function playChimeSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    
    // Generar un timbre agradable de 2 tonos (ding-dong tipo campana de peluquería)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.6);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(880.00, now + 0.15);
    gain2.gain.setValueAtTime(0.3, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.9);
  } catch (e) {
    console.warn('Audio chime error:', e);
  }
}

function triggerPushNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const options = {
    body,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23B8860B"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
    badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23B8860B"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>',
    vibrate: [200, 100, 200, 100, 200],
    tag: 'cita-peluqueria'
  };

  if (swRegistration && swRegistration.showNotification) {
    swRegistration.showNotification(title, options);
  } else {
    try {
      new Notification(title, options);
    } catch (e) {
      console.warn('Direct notification error:', e);
    }
  }
}

function setupEventListeners() {
  document.getElementById('btnPrevDay').addEventListener('click', () => {
    const d = parseIsoToDate(state.selectedDate);
    d.setDate(d.getDate() - 1);
    selectDate(formatDateToIso(d));
  });

  document.getElementById('btnNextDay').addEventListener('click', () => {
    const d = parseIsoToDate(state.selectedDate);
    d.setDate(d.getDate() + 1);
    selectDate(formatDateToIso(d));
  });

  // Selector de salto a mes y año
  const dateTitle = document.getElementById('currentDateTitle');
  const monthYearModal = document.getElementById('monthYearModal');
  const monthPicker = document.getElementById('selectMonthPicker');
  const yearPicker = document.getElementById('selectYearPicker');

  if (dateTitle && monthYearModal) {
    dateTitle.addEventListener('click', () => {
      const curDate = parseIsoToDate(state.selectedDate);
      if (monthPicker) monthPicker.value = String(curDate.getMonth());
      if (yearPicker) yearPicker.value = String(curDate.getFullYear());
      monthYearModal.classList.remove('hidden');
    });
  }

  const btnCloseMonthModal = document.getElementById('btnCloseMonthModal');
  if (btnCloseMonthModal && monthYearModal) {
    btnCloseMonthModal.addEventListener('click', () => {
      monthYearModal.classList.add('hidden');
    });
  }

  const btnApplyMonthYear = document.getElementById('btnApplyMonthYear');
  if (btnApplyMonthYear && monthYearModal) {
    btnApplyMonthYear.addEventListener('click', () => {
      const selectedMonth = parseInt(monthPicker.value, 10);
      const selectedYear = parseInt(yearPicker.value, 10);
      
      const today = new Date();
      let targetDay = 1;
      if (selectedYear === today.getFullYear() && selectedMonth === today.getMonth()) {
        targetDay = today.getDate();
      }

      const newDateIso = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
      monthYearModal.classList.add('hidden');
      state.selectedDate = newDateIso;
      renderDaysStrip(state.selectedDate);
      selectDate(newDateIso);
    });
  }

  // Activar avisos Push en el móvil del peluquero
  const btnTogglePush = document.getElementById('btnTogglePush');
  if (btnTogglePush) {
    btnTogglePush.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        alert('Este navegador no admite notificaciones del sistema.');
        return;
      }
      if (Notification.permission === 'granted') {
        playChimeSound();
        triggerPushNotification('💈 Avisos configurados', 'Recibirás avisos en este móvil cuando haya citas por confirmar.');
        return;
      }
      try {
        const perm = await Notification.requestPermission();
        updatePushButtonUI();
        if (perm === 'granted') {
          playChimeSound();
          triggerPushNotification('💈 ¡Avisos activados con éxito!', 'Te avisaremos al instante en tu móvil cada vez que un amigo solicite cita.');
        } else {
          alert('Para recibir avisos en el móvil, autoriza los permisos de notificación en los ajustes de tu navegador.');
        }
      } catch (err) {
        console.warn('Error solicitando permisos:', err);
      }
    });
  }

  // Contador dinámico de caracteres para observaciones (máx 256)
  const notesTextarea = document.getElementById('bookNotes');
  const notesCounter = document.getElementById('bookNotesCounter');
  if (notesTextarea && notesCounter) {
    notesTextarea.addEventListener('input', () => {
      const len = notesTextarea.value.length;
      notesCounter.textContent = `${len}/256`;
      notesCounter.classList.toggle('limit-near', len >= 230);
    });
  }

  document.getElementById('btnCloseModal').addEventListener('click', closeBookingModal);
  document.getElementById('btnCancelBooking').addEventListener('click', closeBookingModal);
  document.getElementById('btnCloseSuccess').addEventListener('click', () => {
    document.getElementById('successModal').classList.add('hidden');
  });

  document.getElementById('btnOpenAdmin').addEventListener('click', openAdminModal);
  document.getElementById('btnCloseAdmin').addEventListener('click', closeAdminModal);

  document.getElementById('btnFilterToday').addEventListener('click', () => {
    document.getElementById('filterAdminDate').value = formatDateToIso(new Date());
    loadAdminAppointments();
  });

  document.getElementById('btnFilterAll').addEventListener('click', () => {
    document.getElementById('filterAdminDate').value = '';
    loadAdminAppointments();
  });

  document.getElementById('filterAdminDate').addEventListener('change', loadAdminAppointments);
  document.getElementById('btnRefreshAppointments').addEventListener('click', loadAdminAppointments);
}
