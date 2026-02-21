/**
 * =============================================
 *  SISTEMA ÓTICA - SHEETS DATABASE
 *  A planilha é o ÚNICO banco de dados.
 *  Sem localStorage para agendamentos.
 * =============================================
 */

const DB = {
  url: null,
  connected: false,
  data: [],          // cache em memória
  lastSync: null,
  timer: null,

  /* ── Config ── */
  loadConfig() {
    try {
      const s = localStorage.getItem('otica_url');
      if (s) { this.url = s; this.connected = true; }
    } catch(e) {}
  },

  saveConfig() {
    if (this.url) localStorage.setItem('otica_url', this.url);
    else localStorage.removeItem('otica_url');
  },

  /* ── Conexão ── */
  async connect(url) {
    if (!url || !url.includes('script.google.com'))
      return { ok: false, err: 'URL inválida - precisa ser script.google.com' };

    this.url = url;
    const _log = (m, t) => { if (typeof App !== 'undefined' && App.log) App.log(m, t); };
    _log('Testando conexão com: ' + url.substring(0, 60) + '...', 'info');
    const r = await this._req('ping');
    if (r.ok) {
      this.connected = true;
      this.saveConfig();
      _log('✅ Conexão estabelecida!', 'success');
      await this.refresh();
      this.startSync();
      return { ok: true };
    }
    this.url = null;
    _log('❌ Falha: ' + (r.err || 'Sem resposta'), 'error');
    return { ok: false, err: r.err || 'Falha na conexão' };
  },

  disconnect() {
    this.url = null;
    this.connected = false;
    this.data = [];
    this.stopSync();
    localStorage.removeItem('otica_url');
  },

  /* ── Comunicação ── */
  async _req(action, body) {
    if (!this.url) return { ok: false, err: 'Sem URL configurada' };
    const _log = (m, t) => { if (typeof App !== 'undefined' && App.log) App.log(m, t); };
    try {
      _log(`➡️ ${action.toUpperCase()} ${body ? JSON.stringify(body).substring(0,80) : ''}`, 'info');
      const opts = body
        ? { method:'POST', redirect:'follow', headers:{'Content-Type':'text/plain'}, body: JSON.stringify({action,...body}) }
        : { method:'GET',  redirect:'follow' };
      const u = body ? this.url : this.url + '?action=' + action;
      const res = await fetch(u, opts);
      const txt = await res.text();
      _log(`⬅️ Status ${res.status} | ${txt.substring(0,120)}`, res.ok ? 'success' : 'error');
      const parsed = JSON.parse(txt);
      if (!parsed.ok) _log(`❌ Erro: ${parsed.err}`, 'error');
      return parsed;
    } catch(e) {
      console.error('DB error:', e);
      _log(`💥 ERRO: ${e.message}`, 'error');
      return { ok: false, err: e.message };
    }
  },

  /* ── CRUD ── */
  async refresh() {
    const _log = (m, t) => { if (typeof App !== 'undefined' && App.log) App.log(m, t); };
    const r = await this._req('list');
    if (r.ok) {
      this.data = r.data || [];
      this.lastSync = new Date();
      _log(`🔄 Sync: ${this.data.length} agendamentos carregados`, 'success');
    } else {
      _log('❌ Sync falhou: ' + (r.err || 'erro desconhecido'), 'error');
    }
    return r.ok;
  },

  getAll(date, storeId) {
    let out = this.data;
    if (date)    out = out.filter(a => a.date === date);
    if (storeId) out = out.filter(a => a.storeId === storeId);
    return out;
  },

  getOne(id) {
    return this.data.find(a => String(a.id) === String(id));
  },

  getByMonth(y, m) {
    const prefix = y + '-' + String(m).padStart(2,'0');
    return this.data.filter(a => a.date && a.date.startsWith(prefix));
  },

  async create(apt) {
    apt.id = Date.now();
    apt.created = new Date().toISOString();
    const r = await this._req('create', apt);
    if (r.ok) {
      this.data.push(apt);
      return { ok: true, apt };
    }
    return r;
  },

  async update(apt) {
    const r = await this._req('update', apt);
    if (r.ok) {
      const i = this.data.findIndex(a => String(a.id) === String(apt.id));
      if (i >= 0) this.data[i] = { ...this.data[i], ...apt };
    }
    return r;
  },

  async remove(id) {
    const r = await this._req('delete', { id });
    if (r.ok) {
      this.data = this.data.filter(a => String(a.id) !== String(id));
    }
    return r;
  },

  async clearAll() {
    const r = await this._req('clear', {});
    if (r.ok) this.data = [];
    return r;
  },

  /* ── Auto-sync ── */
  startSync() {
    this.stopSync();
    this.timer = setInterval(async () => {
      if (!this.connected) return;
      await this.refresh();
      if (typeof App !== 'undefined' && App.ready) App.render();
    }, 30000);
  },

  stopSync() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
};

DB.loadConfig();
