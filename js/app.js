/**
 * =============================================
 *  SISTEMA ÓTICA - APP PRINCIPAL
 *  Controla tudo: login, calendário, grade, modais
 * =============================================
 */

const STORES = [
  { id: 1, name: 'Loja 1', color: 'var(--store1)', pwd: '1234' },
  { id: 2, name: 'Loja 2', color: 'var(--store2)', pwd: '1234' },
  { id: 3, name: 'Loja 3', color: 'var(--store3)', pwd: '1234' },
  { id: 4, name: 'Loja 4', color: 'var(--store4)', pwd: '1234' },
  { id: 5, name: 'Loja 5', color: 'var(--store5)', pwd: '1234' },
];

const TIMES = [
  '08:00','08:30','09:00','09:30','10:00','10:30',
  '11:00','11:30','12:00','12:30','13:00','13:30',
  '14:00','14:30','15:00','15:30','16:00','16:30',
  '17:00','17:30','18:00'
];

/* Horários por dia da semana: 5=sexta, 6=sábado */
const TIMES_SEXTA  = ['14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30'];
const TIMES_SABADO = ['09:00','09:30','10:00','10:30','11:00','11:30','12:00','12:30'];

function getTimesForDate(date) {
  const dow = date.getDay();
  if (dow === 5) return TIMES_SEXTA;
  if (dow === 6) return TIMES_SABADO;
  return TIMES;
}

const WEEKDAYS = ['DOMINGO','SEGUNDA-FEIRA','TERÇA-FEIRA','QUARTA-FEIRA','QUINTA-FEIRA','SEXTA-FEIRA','SÁBADO'];
const MONTHS   = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];

/* =============================================
   APP OBJECT
   ============================================= */
const App = {
  ready: false,
  store: null,     // loja logada { id, name, color }
  today: new Date(),
  selDate: new Date(),
  calDate: new Date(),
  viewMode: 'geral', // 'geral' ou 'simplificado'

  /* ── Boot ── */
  async boot() {
    // Check session
    const sid = localStorage.getItem('otica_store');
    if (sid) {
      this.store = STORES.find(s => s.id === parseInt(sid));
    }

    if (this.store) {
      this.showApp();
    } else {
      this.showLogin();
    }

    this.bindGlobal();
  },

  /* ── LOGIN ── */
  showLogin() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');

    this.renderStoreButtons();
  },

  renderStoreButtons() {
    const grid = document.getElementById('stores-grid');
    grid.innerHTML = STORES.map(s => `
      <button class="store-btn" data-id="${s.id}">
        <span class="dot" style="background:${s.color}"></span>
        ${s.name}
      </button>
    `).join('');

    let selectedId = null;

    grid.querySelectorAll('.store-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.store-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedId = parseInt(btn.dataset.id);
        document.getElementById('pwd-section').classList.remove('hidden');
        document.getElementById('pwd-input').focus();
      });
    });

    // Use onclick (replaces, not stacks) to avoid duplicate handlers
    document.getElementById('btn-enter').onclick = () => {
      if (!selectedId) { this.toast('Selecione uma loja', 'error'); return; }
      const pwd = document.getElementById('pwd-input').value;
      const store = STORES.find(s => s.id === selectedId);
      if (pwd === store.pwd) {
        this.store = store;
        localStorage.setItem('otica_store', store.id);
        document.getElementById('pwd-input').value = '';
        this.showApp();
      } else {
        this.toast('Senha incorreta', 'error');
      }
    };

    document.getElementById('pwd-input').onkeydown = (e) => {
      if (e.key === 'Enter') document.getElementById('btn-enter').click();
    };
  },

  logout() {
    this.store = null;
    this.ready = false;
    this._eventsBound = false;
    localStorage.removeItem('otica_store');
    DB.stopSync();
    this.showLogin();
  },

  /* ── MAIN APP ── */
  async showApp() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Store badge
    const badge = document.getElementById('store-badge');
    badge.querySelector('.dot').style.background = this.store.color;
    badge.querySelector('span:last-child').textContent = this.store.name;

    this.bindEvents();
    this.ready = true;

    // Init sheets
    this.log('Sistema iniciado', 'info');
    this.log('Loja: ' + this.store.name, 'info');
    if (DB.connected) {
      this.log('Conectando à planilha...', 'info');
      const ok = await DB.refresh();
      if (ok) {
        this.log('✅ Planilha conectada - ' + DB.data.length + ' agendamentos', 'success');
        DB.startSync();
      } else {
        this.log('❌ Falha ao carregar planilha', 'error');
      }
    } else {
      this.log('⚠️ Planilha não configurada - clique em Configurar', 'warn');
    }

    this.render();
    this.updateConnStatus();
  },

  /* ── Render tudo ── */
  render() {
    this.renderDateHeader();
    this.renderCalendar();
    if (this.viewMode === 'simplificado') {
      this.renderSimplified();
    } else {
      this.renderSchedule();
    }
    this.updateConnStatus();
  },

  /* ── Date header ── */
  renderDateHeader() {
    const d = this.selDate;
    document.getElementById('h-day').textContent = String(d.getDate()).padStart(2,'0');
    document.getElementById('h-weekday').textContent = WEEKDAYS[d.getDay()];
    document.getElementById('h-monthyear').textContent = MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  },

  /* ── Mini calendar ── */
  renderCalendar() {
    const y = this.calDate.getFullYear();
    const m = this.calDate.getMonth();

    document.getElementById('cal-title').textContent = MONTHS[m] + ' ' + y;

    const first   = new Date(y, m, 1).getDay();
    const days    = new Date(y, m+1, 0).getDate();
    const prevD   = new Date(y, m, 0).getDate();
    const today   = this.today;
    const sel     = this.selDate;

    // Quais dias tem agendamento?
    const aptsMonth = DB.getByMonth(y, m + 1);
    const daysWithApt = new Set(aptsMonth.map(a => parseInt(a.date.split('-')[2])));

    let html = '';

    // Prev month
    for (let i = first - 1; i >= 0; i--) {
      html += `<div class="cal-day other">${prevD - i}</div>`;
    }

    // Current month
    for (let d = 1; d <= days; d++) {
      const isToday = d === today.getDate() && m === today.getMonth() && y === today.getFullYear();
      const isSel   = d === sel.getDate() && m === sel.getMonth() && y === sel.getFullYear();
      const hasApt  = daysWithApt.has(d);
      let cls = 'cal-day';
      if (isToday) cls += ' today';
      if (isSel && !isToday) cls += ' selected';
      if (hasApt) cls += ' has-apt';
      html += `<div class="${cls}" data-day="${d}">${d}</div>`;
    }

    // Next month fill
    const total = first + days;
    const fill = total <= 35 ? 35 - total : 42 - total;
    for (let d = 1; d <= fill; d++) {
      html += `<div class="cal-day other">${d}</div>`;
    }

    const container = document.getElementById('cal-days');
    container.innerHTML = html;

    // Click days
    container.querySelectorAll('.cal-day:not(.other)').forEach(el => {
      el.addEventListener('click', () => {
        const day = parseInt(el.dataset.day);
        this.selDate = new Date(y, m, day);
        this.render();
      });
    });
  },

  /* ── Schedule Grid ── */
  renderSchedule() {
    const wrap = document.getElementById('schedule');
    const dateStr = this.fmtDate(this.selDate);
    const isSunday = this.selDate.getDay() === 0;

    let banner = '';
    if (!DB.connected) {
      banner = `
        <div class="conn-banner">
          <i class="fas fa-plug"></i>
          <span>Planilha não conectada — clique em <strong>Configurar</strong> no menu lateral</span>
          <button class="btn btn-green btn-sm" id="banner-config"><i class="fas fa-cog"></i> Configurar</button>
        </div>`;
    }

    if (isSunday) {
      wrap.innerHTML = `
        <div class="closed-msg">
          <i class="fas fa-moon"></i>
          <p>Fechado aos domingos</p>
        </div>`;
      return;
    }

    const apts = DB.connected ? DB.getAll(dateStr) : [];
    const cols = STORES.length;
    const gridCols = `70px repeat(${cols}, 1fr)`;
    const times = getTimesForDate(this.selDate);

    let html = `<div class="schedule-grid" style="grid-template-columns:${gridCols}">`;

    // Header row
    html += `<div class="grid-corner">Hora</div>`;
    STORES.forEach(s => {
      html += `<div class="grid-store-header"><span class="dot" style="background:${s.color}"></span>${s.name}</div>`;
    });

    // Time rows
    times.forEach(time => {
      html += `<div class="grid-time">${time}</div>`;
      STORES.forEach(s => {
        const apt = apts.find(a => a.time === time && a.storeId === s.id);
        if (apt) {
          const phone = this.fmtPhone(apt.phone);
          html += `
            <div class="grid-cell" data-apt-id="${apt.id}">
              <div class="apt-card store-${s.id}">
                <div class="apt-name">${this.esc(apt.client)}</div>
                <div class="apt-phone">${phone}</div>
                <div class="apt-store">${this.esc(apt.store)}</div>
              </div>
            </div>`;
        } else {
          // Pode agendar? Só na própria loja
          const canAdd = s.id === this.store.id;
          html += `
            <div class="grid-cell${canAdd ? ' can-add' : ''}" data-store="${s.id}" data-time="${time}">
              ${canAdd ? '<span class="add-icon">+</span>' : ''}
            </div>`;
        }
      });
    });

    html += '</div>';
    wrap.innerHTML = banner + html;

    // Banner config button
    document.getElementById('banner-config')?.addEventListener('click', () => this.openConfig());

    // Events: click card
    wrap.querySelectorAll('[data-apt-id]').forEach(el => {
      el.addEventListener('click', () => this.openDetail(el.dataset.aptId));
    });

    // Events: click entire cell to add
    wrap.querySelectorAll('.grid-cell.can-add').forEach(cell => {
      cell.addEventListener('click', () => {
        if (!DB.connected) { this.toast('Conecte à planilha primeiro', 'error'); return; }
        this.openNew(parseInt(cell.dataset.store), cell.dataset.time);
      });
    });
  },

  /* ── Simplified View ── */
  renderSimplified() {
    const wrap = document.getElementById('schedule');
    const dateStr = this.fmtDate(this.selDate);
    const isSunday = this.selDate.getDay() === 0;
    const dow = this.selDate.getDay();

    let banner = '';
    if (!DB.connected) {
      banner = `
        <div class="conn-banner">
          <i class="fas fa-plug"></i>
          <span>Planilha não conectada — clique em <strong>Configurar</strong> no menu lateral</span>
          <button class="btn btn-green btn-sm" id="banner-config"><i class="fas fa-cog"></i> Configurar</button>
        </div>`;
    }

    if (isSunday) {
      wrap.innerHTML = `
        <div class="closed-msg">
          <i class="fas fa-moon"></i>
          <p>Fechado aos domingos</p>
        </div>`;
      return;
    }

    const apts = DB.connected ? DB.getAll(dateStr) : [];
    const allTimes = getTimesForDate(this.selDate);

    // Split AM/PM for normal days (Mon-Thu)
    const needsSplit = dow >= 1 && dow <= 4; // seg-qui
    let sections = [];

    if (needsSplit) {
      const morning = allTimes.filter(t => parseInt(t.split(':')[0]) < 13);
      const afternoon = allTimes.filter(t => parseInt(t.split(':')[0]) >= 13);
      sections.push({ label: 'Manhã', times: morning });
      sections.push({ label: 'Tarde', times: afternoon });
    } else {
      // Friday or Saturday — single section
      const label = dow === 5 ? 'Tarde (Sexta)' : 'Manhã (Sábado)';
      sections.push({ label, times: allTimes });
    }

    const store = this.store;
    let html = '<div class="simplified-view">';

    sections.forEach(sec => {
      html += `<div class="simp-section">`;
      html += `<div class="simp-section-label">${sec.label}</div>`;
      html += `<div class="simp-table-wrap">`;
      html += `<table class="simp-table"><thead><tr>`;

      // Header: time labels
      sec.times.forEach(t => {
        html += `<th class="simp-th">${t}</th>`;
      });
      html += `</tr></thead><tbody><tr>`;

      // Single row: only logged store
      sec.times.forEach(time => {
        const apt = apts.find(a => a.time === time && a.storeId === store.id);
        if (apt) {
          const phone = this.fmtPhone(apt.phone);
          html += `
            <td class="simp-td simp-filled" data-apt-id="${apt.id}">
              <div class="simp-card store-${store.id}">
                <div class="simp-card-store">${store.name}</div>
                <div class="simp-card-name">${this.esc(apt.client)}</div>
                <div class="simp-card-phone">${phone}</div>
              </div>
            </td>`;
        } else {
          html += `
            <td class="simp-td simp-empty" data-store="${store.id}" data-time="${time}">
              <span class="simp-add">+</span>
            </td>`;
        }
      });

      html += `</tr></tbody></table>`;
      html += `</div>`;
      html += `</div>`;
    });

    html += '</div>';
    wrap.innerHTML = banner + html;

    // Banner config button
    document.getElementById('banner-config')?.addEventListener('click', () => this.openConfig());

    // Click card → detail
    wrap.querySelectorAll('[data-apt-id]').forEach(el => {
      el.addEventListener('click', () => this.openDetail(el.dataset.aptId));
    });

    // Click empty → new
    wrap.querySelectorAll('.simp-empty').forEach(cell => {
      cell.addEventListener('click', () => {
        if (!DB.connected) { this.toast('Conecte à planilha primeiro', 'error'); return; }
        this.openNew(parseInt(cell.dataset.store), cell.dataset.time);
      });
    });
  },

  /* ── Connection status ── */
  updateConnStatus() {
    const el = document.getElementById('conn-status');
    if (DB.connected) {
      el.className = 'conn-status online';
      el.innerHTML = '<span class="pulse"></span>Online';
    } else {
      el.className = 'conn-status offline';
      el.innerHTML = '<span class="pulse"></span>Offline';
    }
  },

  /* ── Events ── */
  bindGlobal() {
    // Close modals on ESC
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.closeModal();
    });
  },

  bindEvents() {
    // Guard: only bind once
    if (this._eventsBound) return;
    this._eventsBound = true;

    // Calendar nav
    document.getElementById('cal-prev').onclick = () => {
      this.calDate.setMonth(this.calDate.getMonth() - 1);
      this.renderCalendar();
    };
    document.getElementById('cal-next').onclick = () => {
      this.calDate.setMonth(this.calDate.getMonth() + 1);
      this.renderCalendar();
    };

    // Header buttons
    document.getElementById('btn-today').onclick = () => {
      this.selDate = new Date();
      this.calDate = new Date();
      this.render();
    };

    document.getElementById('btn-refresh').onclick = async () => {
      if (!DB.connected) { this.toast('Conecte à planilha', 'error'); return; }
      this.toast('Atualizando...', 'info');
      await DB.refresh();
      this.render();
      this.toast('Atualizado!', 'success');
    };

    document.getElementById('btn-clear').onclick = () => this.clearAll();

    // Sidebar nav
    document.getElementById('nav-config').onclick = () => this.openConfig();
    document.getElementById('btn-logout').onclick = () => this.logout();

    // Debug console
    document.getElementById('btn-console').onclick = () => this.toggleConsole();
    document.getElementById('debug-clear').onclick = () => this.clearConsole();

    // View toggle
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.viewMode = btn.dataset.view;
        this.render();
      });
    });
  },

  /* ── MODAIS ── */
  openModal(html) {
    this.closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal';
    overlay.innerHTML = `<div class="modal-box">${html}</div>`;
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closeModal();
    });

    // Close button
    overlay.querySelector('.modal-close')?.addEventListener('click', () => this.closeModal());
  },

  closeModal() {
    document.getElementById('modal')?.remove();
  },

  /* ── New appointment modal ── */
  openNew(storeId, time) {
    const dateDisplay = this.fmtDateDisplay(this.selDate);
    const store = STORES.find(s => s.id === storeId);

    this.openModal(`
      <div class="modal-head">
        <h3>Novo Agendamento</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>Cliente</label>
          <input type="text" id="f-client" placeholder="Nome completo" autofocus>
        </div>
        <div class="field">
          <label>Telefone</label>
          <div class="phone-row">
            <input type="tel" id="f-phone" placeholder="19912345678">
            <button class="btn-wpp" id="f-wpp" title="WhatsApp"><i class="fab fa-whatsapp"></i></button>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Data</label>
            <input type="text" id="f-date" value="${dateDisplay}" readonly>
          </div>
          <div class="field">
            <label>Horário</label>
            <select id="f-time">
              ${TIMES.map(t => `<option value="${t}" ${t===time?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label>Loja</label>
          <input type="text" value="${store.name}" readonly style="opacity:.7">
          <input type="hidden" id="f-store-id" value="${storeId}">
          <input type="hidden" id="f-store-name" value="${store.name}">
        </div>
        <div class="field">
          <label>Observações</label>
          <textarea id="f-notes" placeholder="Opcional..."></textarea>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close">Cancelar</button>
        <button class="btn btn-primary" id="f-save">Agendar</button>
      </div>
    `);

    document.getElementById('f-save').addEventListener('click', () => this.saveNew());
    document.getElementById('f-wpp').addEventListener('click', () => {
      const phone = document.getElementById('f-phone').value.replace(/\D/g,'');
      if (phone) window.open('https://wa.me/55'+phone, '_blank');
    });
    document.getElementById('f-client').focus();
  },

  async saveNew() {
    const client = document.getElementById('f-client').value.trim();
    const phone  = document.getElementById('f-phone').value.replace(/\D/g,'');
    const time   = document.getElementById('f-time').value;
    const storeId = parseInt(document.getElementById('f-store-id').value);
    const store  = document.getElementById('f-store-name').value;
    const notes  = document.getElementById('f-notes').value.trim();
    const date   = this.fmtDate(this.selDate);

    if (!client) { this.toast('Digite o nome do cliente', 'error'); return; }
    if (!phone)  { this.toast('Digite o telefone', 'error'); return; }

    // Check conflict
    const existing = DB.getAll(date).find(a => a.time === time && a.storeId === storeId);
    if (existing) { this.toast('Horário já ocupado!', 'error'); return; }

    this.closeModal();
    this.toast('Salvando...', 'info');

    const r = await DB.create({ date, time, client, phone, store, storeId, notes });
    if (r.ok) {
      this.toast('Agendamento criado!', 'success');
      this.render();
    } else {
      this.toast('Erro: ' + r.err, 'error');
    }
  },

  /* ── Detail modal ── */
  openDetail(id) {
    const apt = DB.getOne(id);
    if (!apt) return;

    const canEdit = apt.storeId === this.store.id;
    const store = STORES.find(s => s.id === apt.storeId);
    const dateDisplay = apt.date ? apt.date.split('-').reverse().join('/') : '';

    this.openModal(`
      <div class="modal-head">
        <h3>${canEdit ? 'Editar' : 'Visualizar'} Agendamento</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>Cliente</label>
          <input type="text" id="d-client" value="${this.esc(apt.client)}" ${canEdit?'':'disabled'}>
        </div>
        <div class="field">
          <label>Telefone</label>
          <div class="phone-row">
            <input type="tel" id="d-phone" value="${apt.phone}" ${canEdit?'':'disabled'}>
            <button class="btn-wpp" id="d-wpp" title="WhatsApp"><i class="fab fa-whatsapp"></i></button>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Data</label>
            <input type="text" value="${dateDisplay}" readonly>
          </div>
          <div class="field">
            <label>Horário</label>
            <select id="d-time" ${canEdit?'':'disabled'}>
              ${TIMES.map(t => `<option value="${t}" ${t===apt.time?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="field">
          <label>Loja</label>
          <input type="text" value="${store?.name || apt.store}" readonly style="opacity:.7">
        </div>
        <div class="field">
          <label>Observações</label>
          <textarea id="d-notes" ${canEdit?'':'disabled'}>${this.esc(apt.notes||'')}</textarea>
        </div>
      </div>
      <div class="modal-foot">
        ${canEdit ? '<button class="btn btn-danger" id="d-delete"><i class="fas fa-trash"></i> Excluir</button>' : ''}
        <button class="btn btn-secondary modal-close">Fechar</button>
        ${canEdit ? '<button class="btn btn-primary" id="d-save">Salvar</button>' : ''}
      </div>
    `);

    document.getElementById('d-wpp')?.addEventListener('click', () => {
      const phone = document.getElementById('d-phone').value.replace(/\D/g,'');
      if (phone) {
        const name = document.getElementById('d-client').value;
        const msg = encodeURIComponent(`Olá ${name}! Sua consulta está confirmada. Até breve!`);
        window.open(`https://wa.me/55${phone}?text=${msg}`, '_blank');
      }
    });

    document.getElementById('d-save')?.addEventListener('click', async () => {
      const updated = {
        ...apt,
        client: document.getElementById('d-client').value.trim(),
        phone:  document.getElementById('d-phone').value.replace(/\D/g,''),
        time:   document.getElementById('d-time').value,
        notes:  document.getElementById('d-notes').value.trim()
      };
      this.closeModal();
      this.toast('Salvando...', 'info');
      const r = await DB.update(updated);
      if (r.ok) { this.toast('Atualizado!', 'success'); this.render(); }
      else { this.toast('Erro: ' + r.err, 'error'); }
    });

    document.getElementById('d-delete')?.addEventListener('click', async () => {
      if (!confirm('Excluir este agendamento?')) return;
      this.closeModal();
      this.toast('Excluindo...', 'info');
      const r = await DB.remove(apt.id);
      if (r.ok) { this.toast('Excluído!', 'success'); this.render(); }
      else { this.toast('Erro: ' + r.err, 'error'); }
    });
  },

  /* ── Config modal ── */
  openConfig() {
    const connected = DB.connected;
    const lastSync = DB.lastSync ? DB.lastSync.toLocaleTimeString('pt-BR') : 'Nunca';

    this.openModal(`
      <div class="modal-head">
        <h3><i class="fas fa-cog"></i> Configurações</h3>
        <button class="modal-close">&times;</button>
      </div>
      <div class="modal-body">
        <div class="config-section">
          <h4><i class="fas fa-table"></i> Google Sheets</h4>
          
          <div class="config-status ${connected?'ok':'err'}">
            <i class="fas ${connected?'fa-check-circle':'fa-times-circle'}"></i>
            <div>
              <strong>${connected?'Conectado':'Desconectado'}</strong>
              <div style="font-size:.8rem;color:var(--text2);margin-top:2px">Última sync: ${lastSync}</div>
            </div>
          </div>

          ${connected ? `
            <div class="config-actions">
              <button class="btn btn-secondary" id="cfg-refresh"><i class="fas fa-sync"></i> Atualizar</button>
              <button class="btn btn-danger" id="cfg-disconnect"><i class="fas fa-unlink"></i> Desconectar</button>
            </div>
          ` : `
            <div class="setup-steps">
              <ol>
                <li>Crie uma planilha no Google Sheets</li>
                <li>Vá em <strong>Extensões > Apps Script</strong></li>
                <li>Cole o código do <strong>GOOGLE_SHEETS_SCRIPT.js</strong></li>
                <li>Implantar > Nova implantação > App da Web</li>
                <li>Copie a URL e cole abaixo</li>
              </ol>
            </div>
            <div class="field" style="margin-top:16px">
              <label>URL do Apps Script</label>
              <input type="url" id="cfg-url" placeholder="https://script.google.com/macros/s/...">
            </div>
            <button class="btn btn-green" id="cfg-connect" style="width:100%"><i class="fas fa-plug"></i> Conectar</button>
          `}
        </div>
      </div>
    `);

    // Connect
    document.getElementById('cfg-connect')?.addEventListener('click', async () => {
      const url = document.getElementById('cfg-url').value.trim();
      if (!url) { this.toast('Cole a URL', 'error'); this.log('❌ URL vazia', 'error'); return; }
      this.log('🔌 Tentando conectar...', 'info');
      const btn = document.getElementById('cfg-connect');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Conectando...';
      btn.disabled = true;
      const r = await DB.connect(url);
      if (r.ok) {
        this.toast('Conectado!', 'success');
        this.closeModal();
        this.render();
      } else {
        this.toast(r.err || 'Erro na conexão', 'error');
        btn.innerHTML = '<i class="fas fa-plug"></i> Conectar';
        btn.disabled = false;
      }
    });

    // Disconnect
    document.getElementById('cfg-disconnect')?.addEventListener('click', () => {
      if (!confirm('Desconectar da planilha?')) return;
      DB.disconnect();
      this.toast('Desconectado', 'info');
      this.closeModal();
      this.render();
    });

    // Refresh
    document.getElementById('cfg-refresh')?.addEventListener('click', async () => {
      await DB.refresh();
      this.toast('Atualizado!', 'success');
      this.closeModal();
      this.render();
    });
  },

  /* ── Clear all ── */
  async clearAll() {
    if (!DB.connected) { this.toast('Conecte à planilha', 'error'); return; }
    if (!confirm('⚠️ Excluir TODOS os agendamentos?')) return;
    if (!confirm('🚨 CONFIRMAÇÃO FINAL - Esta ação é irreversível!')) return;

    this.toast('Limpando...', 'info');
    const r = await DB.clearAll();
    if (r.ok) { this.toast('Tudo limpo!', 'success'); this.render(); }
    else { this.toast('Erro: ' + r.err, 'error'); }
  },

  /* ── Toast ── */
  toast(msg, type = 'info') {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.innerHTML = `<i class="fas fa-${type==='success'?'check':type==='error'?'exclamation-triangle':'info-circle'}"></i>${msg}`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  },

  /* ── Debug Console ── */
  log(msg, type = 'info') {
    const panel = document.getElementById('debug-log');
    if (!panel) return;
    const time = new Date().toLocaleTimeString('pt-BR');
    const colors = { info: '#6366f1', success: '#22c55e', error: '#ef4444', warn: '#f59e0b' };
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = `<span style="color:var(--text2)">[${time}]</span> <span style="color:${colors[type]||colors.info}">${msg}</span>`;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
  },

  toggleConsole() {
    const c = document.getElementById('debug-console');
    c.classList.toggle('hidden');
  },

  clearConsole() {
    document.getElementById('debug-log').innerHTML = '';
  },

  /* ── Helpers ── */
  fmtDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  },

  fmtDateDisplay(d) {
    return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
  },

  fmtPhone(p) {
    if (!p) return '';
    p = p.replace(/\D/g,'');
    if (p.length === 11) return `(${p.slice(0,2)}) ${p.slice(2,7)}-${p.slice(7)}`;
    if (p.length === 10) return `(${p.slice(0,2)}) ${p.slice(2,6)}-${p.slice(6)}`;
    return p;
  },

  esc(s) {
    const d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }
};

/* ── Start ── */
document.addEventListener('DOMContentLoaded', () => App.boot());
