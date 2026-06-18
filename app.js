const WEEKDAYS = ['DOMINGO', 'SEGUNDA-FEIRA', 'TERCA-FEIRA', 'QUARTA-FEIRA', 'QUINTA-FEIRA', 'SEXTA-FEIRA', 'SABADO'];
const MONTHS = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const DEFAULT_COLORS = ['#ef4444', '#2563eb', '#16a34a', '#c084fc', '#f59e0b', '#0891b2', '#db2777', '#475569'];
const SATURDAY_TIMES = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30'];
const FRIDAY_TIMES = ['14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30'];
const WEEKDAY_TIMES = [
  '08:00', '08:30', '09:00', '09:30', '10:00', '10:30',
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00',
];
const SOUND_PREF_KEY = 'otica_prescription_sound';
const SOUND_MUTED_KEY = 'otica_prescription_sound_muted';
const LOCAL_APPOINTMENT_NOTIFICATIONS_KEY = 'otica_appointment_notifications';
const APPOINTMENT_NOTIFICATIONS_DISABLED_KEY = 'otica_appointment_notifications_disabled';
const NOTIFICATION_SOUNDS = [
  { id: 'rotating-bell', label: 'Sininho giratorio', src: 'assets/sounds/rotating-bicycle-bell.wav' },
  { id: 'ding-dong', label: 'Ding dong', src: 'assets/sounds/ding-dong-bicycle-bell.ogg' },
  { id: 'classic-bell', label: 'Sino classico', src: 'assets/sounds/classic-bicycle-bell.wav' },
  { id: 'bike-bell', label: 'Campainha forte', src: 'assets/sounds/bike-bell.wav' },
  { id: 'bicycle-1', label: 'Sininho 1', src: 'assets/sounds/bicycle-bell-1.wav' },
  { id: 'bicycle-2', label: 'Sininho 2', src: 'assets/sounds/bicycle-bell-2.wav' },
  { id: 'bicycle-3', label: 'Sininho 3', src: 'assets/sounds/bicycle-bell-3.wav' },
  { id: 'marcolo', label: 'Tim curto', src: 'assets/sounds/marcolo-bicycle-bell.wav' },
  { id: 'marcel', label: 'Tim longo', src: 'assets/sounds/marcel-bicycle-bell.wav' },
  { id: 'bsu', label: 'Campainha limpa', src: 'assets/sounds/bsu-bike-bell.wav' },
];

const DB = {
  client: supabaseClient,
  connected: Boolean(supabaseClient),
  user: null,
  profile: null,
  stores: [],
  optometrists: [],
  clients: [],
  appointments: [],
  prescriptionNotifications: [],
  appointmentNotifications: [],
  prescriptionNotificationsAvailable: true,
  appointmentNotificationsAvailable: localStorage.getItem(APPOINTMENT_NOTIFICATIONS_DISABLED_KEY) !== '1',
  lastPrescriptionRealtimeToast: null,
  lastAppointmentCancelToast: null,
  lastSync: null,
  timer: null,
  realtimeChannel: null,
  realtimeDebounce: null,
  realtimeStatus: 'offline',
  refreshInFlight: null,
  authSubscription: null,

  async init() {
    if (!this.client) return false;
    const { data } = await this.client.auth.getSession();
    if (!data.session) return false;
    return this.loadUser();
  },

  async loadUser() {
    const { data: userData, error: userError } = await this.client.auth.getUser();
    if (userError || !userData.user) return false;
    this.user = userData.user;

    let profile = await this.getProfile();
    if (!profile) {
      await this.bootstrapAdminProfile();
      profile = await this.getProfile();
    }

    if (!profile) {
      await this.signOut();
      throw new Error('Conta sem perfil. Peça para o admin recriar esta loja.');
    }

    this.profile = profile;
    await this.refresh();
    return true;
  },

  async getProfile() {
    const { data, error } = await this.client
      .from('profiles')
      .select('*, stores(*)')
      .eq('id', this.user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  async bootstrapAdminProfile() {
    const name = this.user.user_metadata?.name || this.user.user_metadata?.nick || 'Administrador';
    await this.client
      .from('profiles')
      .insert({ id: this.user.id, role: 'admin', full_name: name });
  },

  async signIn(nick, password) {
    const email = nickToAuthEmail(nick);
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return this.loadUser();
  },

  async signUpAdmin(nick, password, name) {
    const cleanNick = normalizeNick(nick);
    const email = nickToAuthEmail(cleanNick);
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: { data: { name, nick: cleanNick } },
    });
    if (error) throw error;
    if (!data.session) return { needsConfirmation: true };
    await this.loadUser();
    return { needsConfirmation: false };
  },

  async signOut() {
    this.stopSync();
    this.user = null;
    this.profile = null;
    this.stores = [];
    this.optometrists = [];
    this.clients = [];
    this.appointments = [];
    this.prescriptionNotifications = [];
    this.appointmentNotifications = [];
    if (this.client) await this.client.auth.signOut();
  },

  async refresh() {
    const profile = this.user ? await this.getProfile() : null;
    if (profile) this.profile = profile;

    const [storesRes, appointmentsRes, clientsRes, optometrists] = await Promise.all([
      this.storesQuery(),
      this.appointmentsQuery(),
      this.clientsQuery(),
      this.loadOptometrists(),
    ]);

    if (storesRes.error) throw storesRes.error;
    if (appointmentsRes.error) throw appointmentsRes.error;
    if (clientsRes.error) throw clientsRes.error;

    this.stores = storesRes.data || [];
    this.optometrists = optometrists || [];
    this.appointments = appointmentsRes.data || [];
    this.clients = clientsRes.data || [];
    this.prescriptionNotifications = await this.loadPrescriptionNotifications();
    this.appointmentNotifications = await this.loadAppointmentNotifications();
    this.lastSync = new Date();
    return true;
  },

  storesQuery() {
    return this.client
      .from('stores')
      .select('*')
      .order('name', { ascending: true });
  },

  appointmentsQuery() {
    return this.client
      .from('appointments')
      .select('*')
      .order('date', { ascending: true })
      .order('time', { ascending: true });
  },

  clientsQuery() {
    let query = this.client
      .from('clients')
      .select('*')
      .order('name', { ascending: true });

    if (this.profile?.role === 'store') {
      query = query.eq('store_id', this.profile.store_id || emptyUuid());
    }

    return query;
  },

  async loadOptometrists() {
    if (this.profile?.role !== 'admin') return [];
    const { data, error } = await this.client
      .from('profiles')
      .select('*')
      .eq('role', 'optometrist')
      .order('full_name', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  async loadPrescriptionNotifications() {
    if (this.profile?.role !== 'store' || !this.profile.store_id) return [];
    const { data, error } = await this.client
      .from('prescription_notifications')
      .select('*')
      .eq('store_id', this.profile.store_id)
      .order('created_at', { ascending: false })
      .limit(30);

    if (isMissingTableError(error)) {
      this.prescriptionNotificationsAvailable = false;
      return [];
    }
    if (error) throw error;
    this.prescriptionNotificationsAvailable = true;
    return data || [];
  },

  async loadAppointmentNotifications() {
    if (this.profile?.role !== 'store' || !this.profile.store_id) return [];
    if (!this.appointmentNotificationsAvailable) return this.loadLocalAppointmentNotifications();
    const { data, error } = await this.client
      .from('appointment_notifications')
      .select('*')
      .eq('store_id', this.profile.store_id)
      .order('created_at', { ascending: false })
      .limit(30);

    if (isMissingTableError(error)) {
      this.appointmentNotificationsAvailable = false;
      localStorage.setItem(APPOINTMENT_NOTIFICATIONS_DISABLED_KEY, '1');
      return this.loadLocalAppointmentNotifications();
    }
    if (error) throw error;
    this.appointmentNotificationsAvailable = true;
    return this.mergeAppointmentNotifications(data || [], this.loadLocalAppointmentNotifications());
  },

  loadLocalAppointmentNotifications() {
    if (this.profile?.role !== 'store' || !this.profile.store_id) return [];
    try {
      return this.loadAllLocalAppointmentNotifications()
        .filter(item => item.store_id === this.profile.store_id);
    } catch (_err) {
      return [];
    }
  },

  loadAllLocalAppointmentNotifications() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_APPOINTMENT_NOTIFICATIONS_KEY) || '[]');
    } catch (_err) {
      return [];
    }
  },

  saveLocalAppointmentNotifications(items) {
    localStorage.setItem(LOCAL_APPOINTMENT_NOTIFICATIONS_KEY, JSON.stringify(items.slice(0, 100)));
  },

  addLocalAppointmentNotification(notification) {
    const allItems = this.loadAllLocalAppointmentNotifications();
    if (allItems.some(item => item.local_id === notification.local_id)) return;
    this.saveLocalAppointmentNotifications([notification, ...allItems]);
    this.appointmentNotifications = this.mergeAppointmentNotifications(this.appointmentNotifications, [notification])
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, 30);
  },

  mergeAppointmentNotifications(primary, fallback) {
    const seen = new Set();
    return [...primary, ...fallback].filter(item => {
      const key = this.appointmentNotificationKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 30);
  },

  appointmentNotificationKey(item) {
    return `${item.appointment_id || item.local_id || ''}:${item.client_name || ''}:${item.appointment_date || ''}:${item.appointment_time || ''}`;
  },

  buildAppointmentNotification(appointment) {
    return {
      local_id: `local-cancel:${appointment.id || appointment.client_name}:${appointment.date}:${appointment.time}`,
      store_id: appointment.store_id,
      appointment_id: appointment.id || null,
      client_id: appointment.client_id || null,
      client_name: appointment.client_name || 'Cliente',
      appointment_date: appointment.date || null,
      appointment_time: appointment.time ? normalizeTime(appointment.time) : null,
      message: `Agendamento cancelado: ${appointment.client_name || 'Cliente'}`,
      read_at: null,
      created_by: this.user?.id || null,
      created_at: new Date().toISOString(),
    };
  },

  async startSync() {
    this.stopSync();
    if (!this.client) return;

    this.realtimeStatus = 'connecting';
    this.connected = true;
    App.updateConnStatus?.();

    const { data } = await this.client.auth.getSession();
    if (data.session?.access_token) {
      this.client.realtime.setAuth(data.session.access_token);
    }

    const { data: authData } = this.client.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) this.client.realtime.setAuth(session.access_token);
    });
    this.authSubscription = authData.subscription;

    const storeFilterId = this.profile?.role === 'store' ? (this.profile.store_id || emptyUuid()) : null;
    const storeFilter = column => storeFilterId ? `${column}=eq.${storeFilterId}` : null;
    const profileFilter = this.profile?.role === 'store' ? `id=eq.${this.user?.id || emptyUuid()}` : null;
    const tableChanges = [
      { table: 'stores', filter: null },
      { table: 'profiles', filter: profileFilter },
      { table: 'clients', filter: storeFilter('store_id') },
      { table: 'appointments', filter: null },
    ];
    if (this.prescriptionNotificationsAvailable) {
      tableChanges.push({ table: 'prescription_notifications', filter: storeFilter('store_id') });
    }
    if (this.appointmentNotificationsAvailable) {
      tableChanges.push({ table: 'appointment_notifications', filter: storeFilter('store_id') });
    }

    let channel = this.client.channel(`agenda-realtime-${this.user?.id || Date.now()}`);
    tableChanges.forEach(({ table, filter }) => {
      const changes = { event: '*', schema: 'public', table };
      if (filter) changes.filter = filter;
      channel = channel.on(
        'postgres_changes',
        changes,
        payload => {
          this.handleRealtimePayload(table, payload);
          this.queueRealtimeRefresh();
        }
      );
    });

    this.realtimeChannel = channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        this.realtimeStatus = 'online';
        this.connected = true;
        App.updateConnStatus?.();
        return;
      }

      if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
        this.realtimeStatus = 'offline';
        this.connected = false;
        App.updateConnStatus?.();
        if (err) App.toast(`Realtime: ${err.message || status}`, 'error');
      }
    });
  },

  handleRealtimePayload(table, payload) {
    if (table === 'appointments') {
      this.handleAppointmentRealtime(payload);
    }

    if (this.profile?.role !== 'store') return;
    const oldHasNewPrescription = Object.prototype.hasOwnProperty.call(payload.old || {}, 'new_prescription');
    const oldHasNewPrescriptionUpdatedAt = Object.prototype.hasOwnProperty.call(payload.old || {}, 'new_prescription_updated_at');

    if (
      table === 'prescription_notifications'
      && payload.eventType === 'INSERT'
      && payload.new?.store_id === this.profile.store_id
    ) {
      this.toastPrescriptionRealtime(payload.new.client_id || payload.new.id);
      return;
    }

    if (
      table === 'appointment_notifications'
      && payload.eventType === 'INSERT'
      && payload.new?.store_id === this.profile.store_id
    ) {
      this.toastAppointmentCancelledRealtime(payload.new);
      return;
    }

    if (
      table === 'clients'
      && payload.eventType === 'UPDATE'
      && payload.new?.store_id === this.profile.store_id
      && payload.new?.new_prescription
      && (
        (oldHasNewPrescription && payload.new.new_prescription !== payload.old.new_prescription)
        || (oldHasNewPrescriptionUpdatedAt && payload.new.new_prescription_updated_at !== payload.old.new_prescription_updated_at)
      )
      && payload.new?.new_prescription_updated_by !== this.user?.id
    ) {
      this.toastPrescriptionRealtime(payload.new.id);
    }
  },

  handleAppointmentRealtime(payload) {
    const eventType = payload.eventType;
    const incoming = eventType === 'DELETE' ? payload.old || {} : payload.new || {};
    const local = incoming.id ? this.appointments.find(appointment => appointment.id === incoming.id) : null;
    const appointment = { ...(local || {}), ...incoming };
    if (!appointment?.store_id || !this.canSeeStoreRealtime(appointment.store_id)) return;

    const previousStatus = payload.old?.status || local?.status;
    const becameCancelled = eventType === 'UPDATE'
      && payload.new?.status === 'cancelled'
      && previousStatus !== 'cancelled';
    const wasRemoved = eventType === 'DELETE'
      && previousStatus !== 'cancelled';
    if (!becameCancelled && !wasRemoved) return;

    const toastKey = `${eventType}:${appointment.id || appointment.client_name}:${appointment.date}:${appointment.time}`;
    if (this.lastAppointmentCancelToast === toastKey) return;
    this.lastAppointmentCancelToast = toastKey;
    if (this.profile?.role === 'store') {
      this.addLocalAppointmentNotification(this.buildAppointmentNotification(appointment));
      App.updatePrescriptionNotifications();
    }
    App.toastAppointmentCancelled(appointment);
  },

  toastAppointmentCancelledRealtime(appointment) {
    const toastKey = `cancel-history:${appointment.appointment_id || appointment.id || appointment.client_name}:${appointment.appointment_date || appointment.date}:${appointment.appointment_time || appointment.time}`;
    if (this.lastAppointmentCancelToast === toastKey) return;
    this.lastAppointmentCancelToast = toastKey;
    App.toastAppointmentCancelled(appointment);
  },

  canSeeStoreRealtime(storeId) {
    return ['admin', 'optometrist'].includes(this.profile?.role)
      || this.profile?.store_id === storeId;
  },

  toastPrescriptionRealtime(key) {
    const now = Date.now();
    const toastKey = `${key || 'receita'}:${Math.floor(now / 2500)}`;
    if (this.lastPrescriptionRealtimeToast === toastKey) return;
    this.lastPrescriptionRealtimeToast = toastKey;
    App.playPrescriptionNotificationSound();
    App.renderPrescriptionRealtimeAlerts();
  },

  stopSync() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.realtimeDebounce) clearTimeout(this.realtimeDebounce);
    this.realtimeDebounce = null;
    if (this.realtimeChannel) {
      this.client?.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
    this.authSubscription?.unsubscribe();
    this.authSubscription = null;
    this.realtimeStatus = 'offline';
  },

  queueRealtimeRefresh() {
    if (this.realtimeDebounce) clearTimeout(this.realtimeDebounce);
    this.realtimeDebounce = setTimeout(async () => {
      try {
        if (this.refreshInFlight) await this.refreshInFlight;
        this.refreshInFlight = this.refresh();
        await this.refreshInFlight;
        this.refreshInFlight = null;
        App.updateAccountBadge();
        App.render();
      } catch (err) {
        this.refreshInFlight = null;
        App.toast(err.message, 'error');
      }
    }, 120);
  },

  get appointmentsToday() {
    return this.appointments.filter(a => a.date === App.fmtDate(App.selDate));
  },

  getStore(id) {
    return this.stores.find(store => store.id === id);
  },

  getClient(id) {
    return this.clients.find(client => client.id === id);
  },

  getOptometrist(id) {
    return this.optometrists.find(profile => profile.id === id);
  },

  canManageStore(storeId) {
    return ['admin', 'optometrist'].includes(this.profile?.role) || this.profile?.store_id === storeId;
  },

  async createStore(payload) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas administradores podem criar lojas');
    }

    const nick = normalizeNick(payload.nick);
    const authEmail = nickToAuthEmail(nick);

    if (!payload.name?.trim() || nick.length < 3 || String(payload.password || '').length < 6) {
      throw new Error('Informe nome, nick com pelo menos 3 caracteres e senha com pelo menos 6 caracteres');
    }

    if (this.stores.some(store => store.login_nick === nick || store.auth_email === authEmail)) {
      throw new Error('Este nick ja esta em uso');
    }

    const authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: authData, error: authError } = await authClient.auth.signUp({
      email: authEmail,
      password: payload.password,
      options: { data: { name: payload.name.trim(), nick } },
    });

    if (authError) throw authError;
    if (!authData.user?.id) {
      throw new Error('Nao foi possivel criar o login da loja. Confira se o cadastro de usuarios esta habilitado no Supabase.');
    }

    const { data: store, error: storeError } = await this.client
      .from('stores')
      .insert({
        name: payload.name.trim(),
        login_nick: nick,
        auth_email: authEmail,
        color: payload.color || '#2563eb',
        created_by: this.user.id,
      })
      .select()
      .single();

    if (storeError) throw storeError;

    const { error: profileError } = await this.client
      .from('profiles')
      .insert({
        id: authData.user.id,
        role: 'store',
        store_id: store.id,
        full_name: payload.name.trim(),
      });

    if (profileError) {
      await this.client.from('stores').delete().eq('id', store.id);
      throw profileError;
    }

    await this.refresh();
    return store;
  },

  async createOptometrist(payload) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas administradores podem criar optometristas');
    }

    const nick = normalizeNick(payload.nick);
    const authEmail = nickToAuthEmail(nick);

    if (!payload.name?.trim() || nick.length < 3 || String(payload.password || '').length < 6) {
      throw new Error('Informe nome, nick com pelo menos 3 caracteres e senha com pelo menos 6 caracteres');
    }

    const nickInStores = this.stores.some(store => store.login_nick === nick || store.auth_email === authEmail);
    const nickInOptometrists = this.optometrists.some(profile => profile.login_nick === nick || profile.auth_email === authEmail);
    if (nickInStores || nickInOptometrists) {
      throw new Error('Este nick ja esta em uso');
    }

    const authClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data: authData, error: authError } = await authClient.auth.signUp({
      email: authEmail,
      password: payload.password,
      options: { data: { name: payload.name.trim(), nick, role: 'optometrist' } },
    });

    if (authError) {
      if (String(authError.message || '').toLowerCase().includes('already')) {
        throw new Error(`Este nick ja existe no Auth do Supabase (${authEmail}), mas pode estar sem perfil. Rode o SQL de limpar usuario orfao ou use outro nick.`);
      }
      throw authError;
    }
    if (!authData.user?.id) {
      throw new Error('Nao foi possivel criar o login do optometrista. Confira o cadastro de usuarios no Supabase.');
    }

    const { data, error } = await this.client
      .from('profiles')
      .insert({
        id: authData.user.id,
        role: 'optometrist',
        full_name: payload.name.trim(),
        login_nick: nick,
        auth_email: authEmail,
        created_by: this.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    await this.refresh();
    return data;
  },

  async updateOptometrist(profileId, payload) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas administradores podem editar optometristas');
    }

    const current = this.getOptometrist(profileId);
    const nick = normalizeNick(payload.nick);
    const authEmail = nickToAuthEmail(nick);
    const password = String(payload.password || '');

    if (!payload.name?.trim() || nick.length < 3) {
      throw new Error('Informe nome e nick com pelo menos 3 caracteres');
    }
    if (password && password.length < 6) {
      throw new Error('A senha precisa ter pelo menos 6 caracteres');
    }

    const nickInStores = this.stores.some(store => store.login_nick === nick || store.auth_email === authEmail);
    const nickInOptometrists = this.optometrists.some(profile => {
      return profile.id !== profileId && (profile.login_nick === nick || profile.auth_email === authEmail);
    });
    if (nickInStores || nickInOptometrists) {
      throw new Error('Este nick ja esta em uso');
    }

    const { data, error } = await this.client.rpc('admin_update_optometrist', {
      p_profile_id: profileId,
      p_name: payload.name.trim(),
      p_login_nick: nick,
      p_password: password || null,
    });

    if (isMissingRpcError(error)) {
      throw new Error('A funcao admin_update_optometrist precisa ser criada no Supabase para editar login do optometrista.');
    }
    if (error) throw error;

    if (!data && current) {
      throw new Error('Nao foi possivel atualizar este optometrista');
    }

    await this.refresh();
    return data;
  },

  async updateStore(storeId, payload) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas administradores podem editar lojas');
    }

    const current = this.getStore(storeId);
    const clean = {
      name: payload.name.trim(),
      nick: normalizeNick(payload.nick),
      password: String(payload.password || ''),
      color: payload.color || current?.color || '#2563eb',
    };

    try {
      const { data, error } = await this.client.rpc('admin_update_store', {
        p_store_id: storeId,
        p_name: clean.name,
        p_login_nick: clean.nick,
        p_password: clean.password || null,
        p_color: clean.color,
      });

      if (error) throw error;
      await this.refresh();
      return data;
    } catch (error) {
      if (!isMissingRpcError(error)) throw error;

      const nickChanged = current && clean.nick !== current.login_nick;
      if (nickChanged || clean.password) {
        throw new Error('A funcao admin_update_store precisa ser atualizada no Supabase para alterar nick ou senha.');
      }
    }

    const { data, error } = await this.client
      .from('stores')
      .update({
        name: clean.name,
        color: clean.color,
      })
      .eq('id', storeId)
      .select()
      .single();

    if (error) throw error;
    await this.refresh();
    return data;
  },

  async saveClient(payload) {
    const current = payload.id ? this.getClient(payload.id) : null;
    const canSaveCurrentPrescription = ['admin', 'store'].includes(this.profile?.role);
    const canSaveNewPrescription = ['admin', 'optometrist'].includes(this.profile?.role);
    const nextCurrentPrescription = payload.current_prescription?.trim() || payload.prescription?.trim() || '';
    const currentPrescription = current?.prescription?.trim() || '';
    const currentPrescriptionChanged = (payload.current_prescription !== undefined || payload.prescription !== undefined)
      && nextCurrentPrescription !== currentPrescription;
    const nextNewPrescription = payload.new_prescription?.trim() || '';
    const currentNewPrescription = current?.new_prescription?.trim() || '';
    const newPrescriptionChanged = payload.new_prescription !== undefined
      && nextNewPrescription !== currentNewPrescription;

    const clean = {
      store_id: payload.store_id,
      name: payload.name.trim(),
      phone: onlyDigits(payload.phone),
      email: payload.email === undefined ? current?.email || null : payload.email?.trim() || null,
      notes: payload.notes === undefined ? current?.notes || null : payload.notes?.trim() || null,
      created_by: this.user.id,
    };

    if ((payload.current_prescription !== undefined || payload.prescription !== undefined) && canSaveCurrentPrescription) {
      clean.prescription = nextCurrentPrescription || null;
      clean.prescription_updated_at = currentPrescriptionChanged ? new Date().toISOString() : current?.prescription_updated_at || null;
      clean.prescription_updated_by = currentPrescriptionChanged ? this.user.id : current?.prescription_updated_by || null;
    }

    if (payload.new_prescription !== undefined && canSaveNewPrescription) {
      clean.new_prescription = nextNewPrescription || null;
      clean.new_prescription_updated_at = nextNewPrescription
        ? (newPrescriptionChanged ? new Date().toISOString() : current?.new_prescription_updated_at || null)
        : null;
      clean.new_prescription_updated_by = nextNewPrescription
        ? (newPrescriptionChanged ? this.user.id : current?.new_prescription_updated_by || null)
        : null;
    }

    if (payload.id) {
      const { data, error } = await this.client
        .from('clients')
        .update(clean)
        .eq('id', payload.id)
        .select()
        .single();
      if (error) throw error;
      await this.notifyPrescriptionChange(data, newPrescriptionChanged);
      await this.refresh();
      return data;
    }

    const existing = this.clients.find(c => c.store_id === clean.store_id && c.phone === clean.phone);
    if (existing) {
      const { data, error } = await this.client
        .from('clients')
        .update(clean)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      await this.notifyPrescriptionChange(data, newPrescriptionChanged);
      await this.refresh();
      return data;
    }

    const { data, error } = await this.client
      .from('clients')
      .insert(clean)
      .select()
      .single();
    if (error) throw error;
    await this.notifyPrescriptionChange(data, newPrescriptionChanged);
    await this.refresh();
    return data;
  },

  async notifyPrescriptionChange(client, prescriptionChanged) {
    if (!prescriptionChanged || !client?.new_prescription || !['admin', 'optometrist'].includes(this.profile?.role)) return;

    const store = this.getStore(client.store_id);
    const { error } = await this.client
      .from('prescription_notifications')
      .insert({
        store_id: client.store_id,
        client_id: client.id,
        client_name: client.name,
        message: `Nova receita de ${client.name} esta pronta para ${store?.name || 'loja'}.`,
        created_by: this.user.id,
      });

    if (isMissingTableError(error)) {
      throw new Error('A tabela prescription_notifications ainda nao existe. Execute o SQL de receitas no Supabase.');
    }
    if (error) throw error;
  },

  async notifyAppointmentCancelled(appointment) {
    if (!appointment?.store_id) return;
    const notification = this.buildAppointmentNotification(appointment);
    if (this.profile?.role === 'store') this.addLocalAppointmentNotification(notification);
    if (!this.appointmentNotificationsAvailable) return;

    const { error } = await this.client
      .from('appointment_notifications')
      .insert(notification);

    if (isMissingTableError(error)) {
      this.appointmentNotificationsAvailable = false;
      localStorage.setItem(APPOINTMENT_NOTIFICATIONS_DISABLED_KEY, '1');
      return;
    }
    if (error) throw error;
  },

  async markPrescriptionNotificationsRead() {
    if (this.profile?.role !== 'store' || !this.profile.store_id) return;

    const { error } = await this.client
      .from('prescription_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('store_id', this.profile.store_id)
      .is('read_at', null);

    if (error) throw error;
    await this.refresh();
  },

  async markPrescriptionNotificationRead(id) {
    if (this.profile?.role !== 'store' || !this.profile.store_id || !id) return;

    const { error } = await this.client
      .from('prescription_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', this.profile.store_id)
      .is('read_at', null);

    if (error) throw error;
    await this.refresh();
  },

  async markPrescriptionNotificationsReadForClient(clientId) {
    if (this.profile?.role !== 'store' || !this.profile.store_id || !clientId) return;

    const { error } = await this.client
      .from('prescription_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .eq('store_id', this.profile.store_id)
      .is('read_at', null);

    if (error) throw error;
    await this.refresh();
  },

  async markAppointmentNotificationsRead() {
    if (this.profile?.role !== 'store' || !this.profile.store_id) return;
    this.markLocalAppointmentNotificationsRead();
    if (!this.appointmentNotificationsAvailable) {
      await this.refresh();
      return;
    }

    const { error } = await this.client
      .from('appointment_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('store_id', this.profile.store_id)
      .is('read_at', null);

    if (isMissingTableError(error)) {
      this.appointmentNotificationsAvailable = false;
      localStorage.setItem(APPOINTMENT_NOTIFICATIONS_DISABLED_KEY, '1');
      return;
    }
    if (error) throw error;
    await this.refresh();
  },

  async markAppointmentNotificationRead(id) {
    if (this.profile?.role !== 'store' || !this.profile.store_id || !id) return;
    if (String(id).startsWith('local-')) {
      this.markLocalAppointmentNotificationsRead(id);
      await this.refresh();
      return;
    }
    if (!this.appointmentNotificationsAvailable) return;

    const { error } = await this.client
      .from('appointment_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store_id', this.profile.store_id)
      .is('read_at', null);

    if (isMissingTableError(error)) {
      this.appointmentNotificationsAvailable = false;
      localStorage.setItem(APPOINTMENT_NOTIFICATIONS_DISABLED_KEY, '1');
      return;
    }
    if (error) throw error;
    await this.refresh();
  },

  markLocalAppointmentNotificationsRead(id = null) {
    const now = new Date().toISOString();
    const items = this.loadAllLocalAppointmentNotifications().map(item => {
      if (item.store_id !== this.profile.store_id) return item;
      if (id && item.local_id !== id) return item;
      return { ...item, read_at: item.read_at || now };
    });
    this.saveLocalAppointmentNotifications(items);
  },

  async clearAllNotifications() {
    if (this.profile?.role !== 'store' || !this.profile.store_id) return;

    const prescriptionDelete = this.client
      .from('prescription_notifications')
      .delete()
      .eq('store_id', this.profile.store_id);
    const appointmentDelete = this.appointmentNotificationsAvailable
      ? this.client
        .from('appointment_notifications')
        .delete()
        .eq('store_id', this.profile.store_id)
      : Promise.resolve({ error: null });

    const [prescriptionRes, appointmentRes] = await Promise.all([prescriptionDelete, appointmentDelete]);
    if (prescriptionRes.error && !isMissingTableError(prescriptionRes.error)) throw prescriptionRes.error;
    if (appointmentRes.error && isMissingTableError(appointmentRes.error)) {
      this.appointmentNotificationsAvailable = false;
      localStorage.setItem(APPOINTMENT_NOTIFICATIONS_DISABLED_KEY, '1');
    } else if (appointmentRes.error) {
      throw appointmentRes.error;
    }

    const localItems = this.loadAllLocalAppointmentNotifications()
      .filter(item => item.store_id !== this.profile.store_id);
    this.saveLocalAppointmentNotifications(localItems);
    await this.refresh();
  },

  async saveAppointment(payload) {
    const client = await this.saveClient({
      id: payload.client_id,
      store_id: payload.store_id,
      name: payload.client_name,
      phone: payload.client_phone,
      notes: payload.client_notes,
      current_prescription: payload.client_current_prescription,
      new_prescription: payload.client_new_prescription,
    });

    const clean = {
      store_id: payload.store_id,
      client_id: client.id,
      client_name: client.name,
      client_phone: client.phone,
      date: payload.date,
      time: normalizeTime(payload.time),
      notes: payload.notes?.trim() || null,
      status: payload.status || 'scheduled',
      created_by: this.user.id,
    };

    if (payload.id) {
      const { data, error } = await this.client
        .from('appointments')
        .update(clean)
        .eq('id', payload.id)
        .select()
        .single();
      if (error) throw error;
      await this.refresh();
      return data;
    }

    const { data, error } = await this.client
      .from('appointments')
      .insert(clean)
      .select()
      .single();
    if (error) throw error;
    await this.refresh();
    return data;
  },

  async removeAppointment(id) {
    const appointment = this.appointments.find(row => row.id === id);
    const { data, error } = await this.client
      .from('appointments')
      .delete()
      .eq('id', id)
      .select('id');
    if (error) throw error;
    if (!data?.length) {
      throw new Error('Nao foi possivel excluir. Verifique as permissoes da tabela appointments no Supabase.');
    }
    if (appointment) await this.notifyAppointmentCancelled(appointment);
    await this.refresh();
    App.updatePrescriptionNotifications?.();
    if (appointment) App.toastAppointmentCancelled(appointment);
  },

  async removeClient(id) {
    const client = this.getClient(id);
    if (!client || this.profile?.role !== 'admin') {
      throw new Error('Apenas o admin pode excluir clientes');
    }

    const { data, error } = await this.client
      .from('clients')
      .delete()
      .eq('id', id)
      .select('id');
    if (error?.code === '23503') {
      throw new Error('Este cliente possui agendamentos vinculados. Exclua ou edite esses agendamentos primeiro.');
    }
    if (error) throw error;
    if (!data?.length) {
      throw new Error('Nao foi possivel excluir. Verifique as permissoes da tabela clients no Supabase.');
    }
    await this.refresh();
  },

  async removeNewPrescription(clientId) {
    if (this.profile?.role !== 'admin') {
      throw new Error('Apenas o admin pode excluir a nova receita');
    }

    const { data, error } = await this.client
      .from('clients')
      .update({
        new_prescription: null,
        new_prescription_updated_at: null,
        new_prescription_updated_by: null,
      })
      .eq('id', clientId)
      .select('id');

    if (error) throw error;
    if (!data?.length) {
      throw new Error('Nao foi possivel excluir a nova receita. Verifique as permissoes da tabela clients no Supabase.');
    }
    await this.refresh();
  },
};

const App = {
  authMode: 'login',
  activeView: 'agenda',
  scheduleMode: 'grid',
  today: new Date(),
  selDate: new Date(),
  calDate: new Date(),
  currentDateKey: null,
  dateRolloverTimer: null,
  audioContext: null,
  audioUnlocked: false,
  notificationSoundId: localStorage.getItem(SOUND_PREF_KEY) || 'bell',
  notificationSoundMuted: localStorage.getItem(SOUND_MUTED_KEY) === '1',
  dismissedPrescriptionAlerts: new Set(),

  async boot() {
    this.bindAuth();
    this.bindGlobal();

    if (!hasSupabaseConfig()) {
      this.showLogin();
      document.getElementById('setup-warning').classList.remove('hidden');
      return;
    }

    try {
      const logged = await DB.init();
      if (logged) this.showApp();
      else this.showLogin();
    } catch (err) {
      this.showLogin();
      this.toast(err.message, 'error');
    }
  },

  showLogin() {
    this.stopDateRollover();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  },

  async showApp() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    this.updateAccountBadge();
    this.updatePrescriptionNotifications();
    document.querySelectorAll('.admin-only').forEach(el => {
      el.classList.toggle('hidden', DB.profile.role !== 'admin');
    });
    this.bindAppEvents();
    this.startDateRollover();
    DB.startSync().catch(err => {
      DB.connected = false;
      DB.realtimeStatus = 'offline';
      this.updateConnStatus();
      this.toast(`Realtime: ${err.message}`, 'error');
    });
    this.render();
  },

  startDateRollover() {
    this.stopDateRollover();
    this.today = new Date();
    this.selDate = new Date(this.today);
    this.calDate = new Date(this.today);
    this.currentDateKey = this.fmtDate(this.today);
    this.dateRolloverTimer = setInterval(() => this.syncCurrentDate(), 30000);
  },

  stopDateRollover() {
    if (!this.dateRolloverTimer) return;
    clearInterval(this.dateRolloverTimer);
    this.dateRolloverTimer = null;
  },

  syncCurrentDate() {
    const now = new Date();
    const nextDateKey = this.fmtDate(now);
    this.today = now;

    if (!this.currentDateKey) {
      this.currentDateKey = nextDateKey;
      return;
    }

    if (nextDateKey === this.currentDateKey) return;

    this.currentDateKey = nextDateKey;
    this.selDate = new Date(now);
    this.calDate = new Date(now);

    if (!document.getElementById('app')?.classList.contains('hidden')) {
      this.render();
    }
  },

  bindAuth() {
    this.bindPasswordToggles(document);

    document.querySelectorAll('.auth-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.authMode = btn.dataset.mode;
        document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('auth-name-wrap').classList.toggle('hidden', this.authMode !== 'signup');
        document.getElementById('auth-submit').innerHTML = this.authMode === 'signup'
          ? '<i class="fas fa-user-plus"></i> Criar admin'
          : '<i class="fas fa-right-to-bracket"></i> Entrar';
      });
    });

    document.getElementById('login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!hasSupabaseConfig()) {
        this.toast('Configure as chaves do Supabase primeiro', 'error');
        return;
      }

      const nick = document.getElementById('auth-nick').value.trim();
      const password = document.getElementById('auth-password').value;
      const name = document.getElementById('auth-name').value.trim();
      const button = document.getElementById('auth-submit');
      button.disabled = true;
      button.classList.add('loading-btn');

      try {
        if (normalizeNick(nick).length < 3) {
          throw new Error('Use um nick com pelo menos 3 caracteres');
        }
        if (this.authMode === 'signup') {
          const result = await DB.signUpAdmin(nick, password, name || nick);
          if (result.needsConfirmation) {
            this.toast('Conta criada. Desative confirmacao de email no Supabase ou confirme pelo painel.', 'success');
            this.authMode = 'login';
            document.querySelector('[data-mode="login"]').click();
            return;
          }
        } else {
          await DB.signIn(nick, password);
        }
        this.showApp();
        this.toast('Bem-vindo!', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      } finally {
        button.disabled = false;
        button.classList.remove('loading-btn');
      }
    });
  },

  bindGlobal() {
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.closeModal();
      if (!this.audioUnlocked) this.unlockNotificationAudio();
    });
    document.addEventListener('pointerdown', () => this.unlockNotificationAudio(), { once: true });
    document.addEventListener('touchstart', () => this.unlockNotificationAudio(), { once: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.syncCurrentDate();
    });
    window.addEventListener('focus', () => this.syncCurrentDate());

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const nextMobile = this.isMobileLayout();
        if (this._lastMobileLayout === nextMobile) return;
        this._lastMobileLayout = nextMobile;
        if (!document.getElementById('app')?.classList.contains('hidden')) this.render();
      }, 140);
    });
  },

  bindAppEvents() {
    if (this._appEventsBound) return;
    this._appEventsBound = true;

    document.getElementById('cal-prev').onclick = () => {
      this.calDate.setMonth(this.calDate.getMonth() - 1);
      this.renderCalendar();
    };
    document.getElementById('cal-next').onclick = () => {
      this.calDate.setMonth(this.calDate.getMonth() + 1);
      this.renderCalendar();
    };
    document.getElementById('btn-today').onclick = () => {
      this.selDate = new Date();
      this.calDate = new Date();
      this.render();
    };
    document.getElementById('btn-refresh').onclick = async () => {
      try {
        await DB.refresh();
        this.render();
        this.toast('Atualizado', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
    document.getElementById('btn-logout').onclick = () => this.logout();
    document.getElementById('btn-menu').onclick = () => document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('btn-theme').onclick = () => this.toggleTheme();
    document.getElementById('btn-settings').onclick = () => this.openSettingsModal();
    document.getElementById('btn-appointment-stats').onclick = () => this.openAppointmentStats();
    document.getElementById('btn-prescription-notifications').onclick = () => this.openPrescriptionNotifications();

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeView = btn.dataset.view;
        document.getElementById('sidebar').classList.remove('open');
        this.render();
      });
    });

    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeView = 'agenda';
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.nav-btn[data-view="agenda"]')?.classList.add('active');
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.scheduleMode = btn.dataset.mode;
        this.render();
      });
    });
  },

  activateAgendaView(mode = 'grid') {
    this.activeView = 'agenda';
    this.scheduleMode = mode;
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === 'agenda'));
    document.querySelectorAll('.view-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
    document.getElementById('sidebar')?.classList.remove('open');
  },

  async logout() {
    this.stopDateRollover();
    await DB.signOut();
    this._appEventsBound = false;
    this.showLogin();
  },

  render() {
    this._lastMobileLayout = this.isMobileLayout();
    this.updateDateHeader();
    this.renderCalendar();
    this.updateConnStatus();
    this.updatePrescriptionNotifications();
    this.renderPrescriptionRealtimeAlerts();

    if (this.activeView === 'clients') this.renderClients();
    else if (this.activeView === 'admin') this.renderAdmin();
    else this.renderAgenda();
  },

  updateAccountBadge() {
    const store = DB.profile.stores;
    const title = DB.profile.role === 'admin'
      ? 'Administrador'
      : DB.profile.role === 'optometrist'
        ? 'Optometrista'
        : store?.name || 'Loja';
    const role = DB.profile.role === 'admin'
      ? 'acesso total'
      : DB.profile.role === 'optometrist'
        ? 'agenda e receitas'
        : 'loja';
    document.getElementById('badge-title').textContent = title;
    document.getElementById('badge-role').textContent = role;
    document.querySelector('#store-badge .dot').style.background = store?.color || '#111827';
  },

  updatePrescriptionNotifications() {
    const button = document.getElementById('btn-prescription-notifications');
    const count = document.getElementById('notification-count');
    if (!button || !count) return;

    const show = DB.profile?.role === 'store';
    const unread = DB.prescriptionNotifications.filter(item => !item.read_at).length
      + DB.appointmentNotifications.filter(item => !item.read_at).length;
    button.classList.toggle('hidden', !show);
    button.classList.toggle('has-unread', show && Boolean(unread));
    count.textContent = String(unread);
    count.classList.toggle('hidden', !unread);
  },

  unreadPrescriptionNotifications() {
    if (DB.profile?.role !== 'store') return [];
    return DB.prescriptionNotifications.filter(item => !item.read_at);
  },

  unreadPrescriptionClientIds() {
    return new Set(this.unreadPrescriptionNotifications().map(item => item.client_id).filter(Boolean));
  },

  hasUnreadPrescriptionForAppointment(apt) {
    const unreadClientIds = this.unreadPrescriptionClientIds();
    if (apt.client_id && unreadClientIds.has(apt.client_id)) return true;
    const client = DB.clients.find(row => row.store_id === apt.store_id && row.phone === apt.client_phone);
    return Boolean(client?.id && unreadClientIds.has(client.id));
  },

  renderPrescriptionRealtimeAlerts() {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    wrap.querySelectorAll('.prescription-realtime-alert').forEach(alert => alert.remove());

    const unread = this.unreadPrescriptionNotifications()
      .filter(item => !this.dismissedPrescriptionAlerts.has(String(item.id)));
    unread.slice(0, 3).forEach(item => {
      const alert = document.createElement('div');
      alert.className = 'toast info prescription-realtime-alert';
      alert.tabIndex = 0;
      alert.role = 'button';
      alert.dataset.notificationId = item.id;
      alert.innerHTML = `<i class="fas fa-sparkles"></i><span><strong>Nova receita pronta</strong><small>${esc(item.client_name || 'Cliente')}</small></span><button class="toast-close" type="button" title="Fechar"><i class="fas fa-xmark"></i></button>`;
      alert.addEventListener('click', event => {
        if (event.target.closest('.toast-close')) return;
        this.openPrescriptionNotification(item.id);
      });
      alert.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.openPrescriptionNotification(item.id);
      });
      alert.querySelector('.toast-close').addEventListener('click', event => {
        event.stopPropagation();
        this.dismissedPrescriptionAlerts.add(String(item.id));
        alert.remove();
      });
      wrap.prepend(alert);
    });
  },

  unlockNotificationAudio() {
    if (this.audioUnlocked) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      this.audioContext = this.audioContext || new AudioCtx();
      this.audioContext.resume?.();
      this.audioUnlocked = true;
    } catch (_err) {
      this.audioUnlocked = false;
    }
  },

  playPrescriptionNotificationSound() {
    if (this.notificationSoundMuted) return;
    try {
      const sound = this.getSelectedNotificationSound();
      if (!sound?.src) return;
      const audio = new Audio(sound.src);
      audio.volume = 0.95;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (_err) {
      // Som de notificacao e auxiliar; se o navegador bloquear, seguimos sem quebrar o app.
    }
  },

  getSelectedNotificationSound() {
    return NOTIFICATION_SOUNDS.find(sound => sound.id === this.notificationSoundId)
      || NOTIFICATION_SOUNDS[0];
  },

  async openPrescriptionNotification(notificationId) {
    const notification = DB.prescriptionNotifications.find(item => item.id === notificationId);
    if (!notification) return;

    const client = notification.client_id ? DB.getClient(notification.client_id) : null;
    try {
      if (!notification.read_at) await DB.markPrescriptionNotificationRead(notification.id);
      this.render();
      if (client) this.openClientModal(client, { activePrescription: 'new' });
      else this.openPrescriptionNotifications();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  openSettingsModal() {
    const currentSound = this.getSelectedNotificationSound();
    this.openModal(`<div class="modal-head">
      <h3>Configuracoes</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="settings-form">
      <label>Som da nova receita
        <div class="settings-sound-row">
          <select id="notification-sound" ${this.notificationSoundMuted ? 'disabled' : ''}>
            ${NOTIFICATION_SOUNDS.map(sound => `<option value="${sound.id}" ${sound.id === currentSound.id ? 'selected' : ''}>${esc(sound.label)}</option>`).join('')}
          </select>
          <button class="btn btn-secondary" type="button" id="test-notification-sound" ${this.notificationSoundMuted ? 'disabled' : ''}><i class="fas fa-volume-high"></i> Testar</button>
        </div>
      </label>
      <label class="check-row">
        <input type="checkbox" id="notification-sound-muted" ${this.notificationSoundMuted ? 'checked' : ''}>
        <span>Nao fazer barulho nas notificacoes</span>
      </label>
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">Salvar</button>
      </div>
    </form>`);

    document.getElementById('test-notification-sound').addEventListener('click', () => {
      const previousSoundId = this.notificationSoundId;
      this.notificationSoundId = document.getElementById('notification-sound').value;
      const previousMuted = this.notificationSoundMuted;
      this.notificationSoundMuted = document.getElementById('notification-sound-muted').checked;
      this.unlockNotificationAudio();
      this.playPrescriptionNotificationSound();
      this.notificationSoundMuted = previousMuted;
      this.notificationSoundId = previousSoundId;
    });

    document.getElementById('notification-sound-muted').addEventListener('change', event => {
      document.getElementById('notification-sound').disabled = event.target.checked;
      document.getElementById('test-notification-sound').disabled = event.target.checked;
    });

    document.getElementById('settings-form').onsubmit = event => {
      event.preventDefault();
      this.notificationSoundId = document.getElementById('notification-sound').value;
      this.notificationSoundMuted = document.getElementById('notification-sound-muted').checked;
      localStorage.setItem(SOUND_PREF_KEY, this.notificationSoundId);
      localStorage.setItem(SOUND_MUTED_KEY, this.notificationSoundMuted ? '1' : '0');
      this.closeModal();
      this.toast('Configuracoes salvas', 'success');
    };
  },

  updateDateHeader() {
    const d = this.selDate;
    document.getElementById('h-day').textContent = String(d.getDate()).padStart(2, '0');
    document.getElementById('h-weekday').textContent = WEEKDAYS[d.getDay()];
    document.getElementById('h-monthyear').textContent = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  },

  updateConnStatus() {
    const el = document.getElementById('conn-status');
    const online = DB.connected && DB.realtimeStatus !== 'offline';
    const label = DB.realtimeStatus === 'online'
      ? 'Realtime'
      : DB.realtimeStatus === 'connecting'
        ? 'Conectando'
        : 'Offline';
    el.className = `conn-status ${online ? 'online' : 'offline'}`;
    el.innerHTML = `<span class="pulse"></span>${label}`;
  },

  renderCalendar() {
    const y = this.calDate.getFullYear();
    const m = this.calDate.getMonth();
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const currentPrefix = `${y}-${String(m + 1).padStart(2, '0')}`;
    const daysWithApt = new Set(
      DB.appointments
        .filter(a => a.date?.startsWith(currentPrefix))
        .map(a => Number(a.date.split('-')[2]))
    );

    document.getElementById('cal-title').textContent = `${MONTHS[m]} ${y}`;
    let html = '';

    for (let i = first - 1; i >= 0; i--) html += `<div class="cal-day other">${prevDays - i}</div>`;
    for (let day = 1; day <= days; day++) {
      const isToday = sameDate(this.today, new Date(y, m, day));
      const isSelected = sameDate(this.selDate, new Date(y, m, day));
      const classes = ['cal-day'];
      if (isToday) classes.push('today');
      if (isSelected && !isToday) classes.push('selected');
      if (daysWithApt.has(day)) classes.push('has-apt');
      html += `<button class="${classes.join(' ')}" data-day="${day}">${day}</button>`;
    }

    const total = first + days;
    const fill = total <= 35 ? 35 - total : 42 - total;
    for (let day = 1; day <= fill; day++) html += `<div class="cal-day other">${day}</div>`;

    const container = document.getElementById('cal-days');
    container.innerHTML = html;
    container.querySelectorAll('[data-day]').forEach(day => {
      day.addEventListener('click', () => {
        this.selDate = new Date(y, m, Number(day.dataset.day));
        this.activateAgendaView(this.activeView === 'agenda' ? this.scheduleMode : 'grid');
        this.render();
      });
    });
  },

  renderAgenda() {
    const content = document.getElementById('content');
    const stores = DB.stores;
    const dateStr = this.fmtDate(this.selDate);
    const isMobile = this.isMobileLayout();

    if (!stores.length) {
      content.innerHTML = this.emptyState('fa-store', 'Nenhuma loja cadastrada', DB.profile.role === 'admin'
        ? 'Crie a primeira loja na tela Admin.'
        : 'Peça para o administrador vincular sua conta a uma loja.');
      return;
    }

    if (isSunday(this.selDate)) {
      const empty = this.emptyState('fa-moon', 'Fechado aos domingos', 'Escolha outro dia no calendario.');
      content.innerHTML = isMobile ? `${this.renderMobileAgendaControls()}${empty}` : empty;
      if (isMobile) this.bindMobileAgendaControls(content);
      return;
    }

    if (this.scheduleMode === 'simplified' && !isMobile) {
      this.renderSimplified();
      return;
    }

    const times = getTimesForDate(this.selDate);
    const appointments = DB.appointments.filter(a => a.date === dateStr && a.status !== 'cancelled');
    const occupiedTimes = new Set(appointments.map(apt => normalizeTime(apt.time)));
    if (isMobile && this.scheduleMode === 'simplified') {
      this.renderMobileSimplifiedAgenda(content, stores, times, appointments, occupiedTimes);
      return;
    }

    const gridCols = isMobile
      ? `42px repeat(${stores.length}, minmax(58px, 1fr))`
      : `76px repeat(${stores.length}, minmax(150px, 1fr))`;

    let html = isMobile ? this.renderMobileAgendaControls() : '';
    html += `<div class="schedule-grid" style="grid-template-columns:${gridCols}">`;
    html += '<div class="grid-corner">Hora</div>';
    stores.forEach(store => {
      html += `<div class="grid-store-header"><span class="dot" style="background:${store.color}"></span>${esc(store.name)}</div>`;
    });

    times.forEach(time => {
      html += `<div class="grid-time">${time}</div>`;
      stores.forEach(store => {
        const apt = appointments.find(a => a.store_id === store.id && normalizeTime(a.time) === time);
        const canAdd = DB.canManageStore(store.id) && !apt && !occupiedTimes.has(time);
        if (apt) {
          const hasNewPrescription = this.hasUnreadPrescriptionForAppointment(apt);
          html += `<div class="grid-cell filled" data-apt-id="${apt.id}">
            <div class="apt-card ${hasNewPrescription ? 'rx-ready-card' : ''}" style="--store:${store.color}; border-color:${store.color}">
              <div class="apt-name">${esc(apt.client_name)}</div>
              <div class="apt-phone">${this.fmtPhone(apt.client_phone)}</div>
              ${hasNewPrescription ? '<span class="apt-rx-dot" title="Nova receita"></span>' : ''}
            </div>
          </div>`;
        } else {
          html += `<div class="grid-cell ${canAdd ? 'can-add' : ''}" data-store="${store.id}" data-time="${time}">
            ${canAdd ? '<span class="add-icon">+</span>' : ''}
          </div>`;
        }
      });
    });
    html += '</div>';
    content.innerHTML = html;
    if (isMobile) this.bindMobileAgendaControls(content);

    content.querySelectorAll('[data-apt-id]').forEach(el => {
      el.addEventListener('click', () => this.openAppointmentDetail(el.dataset.aptId));
    });
    content.querySelectorAll('.grid-cell.can-add').forEach(cell => {
      cell.addEventListener('click', () => this.openAppointmentModal({
        store_id: cell.dataset.store,
        time: cell.dataset.time,
      }));
    });
  },

  isMobileLayout() {
    return window.matchMedia?.('(max-width: 760px)').matches || window.innerWidth <= 760;
  },

  renderMobileAgendaControls() {
    return `<div class="mobile-agenda-controls">
      <div class="mobile-date-row">
        <button class="mobile-date-btn" type="button" data-mobile-day="-1" title="Dia anterior"><i class="fas fa-chevron-left"></i></button>
        <input class="mobile-date-input" type="date" value="${this.fmtDate(this.selDate)}" data-mobile-date>
        <button class="mobile-date-btn" type="button" data-mobile-day="1" title="Proximo dia"><i class="fas fa-chevron-right"></i></button>
        <button class="mobile-today-btn" type="button" data-mobile-today>Hoje</button>
      </div>
      <div class="mobile-mode-tabs">
        <button type="button" class="${this.scheduleMode === 'grid' ? 'active' : ''}" data-mobile-mode="grid">Geral</button>
        <button type="button" class="${this.scheduleMode === 'simplified' ? 'active' : ''}" data-mobile-mode="simplified">Simplificada</button>
      </div>
    </div>`;
  },

  bindMobileAgendaControls(scope) {
    scope.querySelector('[data-mobile-date]')?.addEventListener('change', event => {
      if (!event.target.value) return;
      this.selDate = parseLocalDate(event.target.value);
      this.calDate = parseLocalDate(event.target.value);
      this.render();
    });
    scope.querySelectorAll('[data-mobile-day]').forEach(button => {
      button.addEventListener('click', () => {
        this.selDate = addDays(this.selDate, Number(button.dataset.mobileDay));
        this.calDate = new Date(this.selDate);
        this.render();
      });
    });
    scope.querySelector('[data-mobile-today]')?.addEventListener('click', () => {
      this.selDate = new Date();
      this.calDate = new Date();
      this.render();
    });
    scope.querySelectorAll('[data-mobile-mode]').forEach(button => {
      button.addEventListener('click', () => {
        this.scheduleMode = button.dataset.mobileMode;
        document.querySelectorAll('.view-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === this.scheduleMode));
        this.render();
      });
    });
  },

  renderMobileSimplifiedAgenda(content, stores, times, appointments, occupiedTimes) {
    const rows = times.map(time => {
      const atTime = appointments.filter(apt => normalizeTime(apt.time) === time);
      const canAdd = (['admin', 'optometrist'].includes(DB.profile.role) || DB.profile.store_id) && !occupiedTimes.has(time);
      return `<tr>
        <th>${time}</th>
        <td>
          ${atTime.length ? atTime.map(apt => {
            const store = DB.getStore(apt.store_id);
            const hasNewPrescription = this.hasUnreadPrescriptionForAppointment(apt);
            return `<button class="mobile-simple-apt ${hasNewPrescription ? 'rx-ready-card' : ''}" type="button" data-apt-id="${apt.id}" style="--store:${store?.color || '#64748b'}">
              <span><span class="dot" style="background:${store?.color || '#64748b'}"></span>${esc(store?.name || 'Loja')}</span>
              <strong>${esc(apt.client_name)}</strong>
            </button>`;
          }).join('') : (canAdd ? `<button class="mobile-simple-add" type="button" data-store="${DB.profile.role === 'store' ? DB.profile.store_id : stores[0]?.id}" data-time="${time}" title="Agendar"><i class="fas fa-plus"></i></button>` : '<span class="mobile-simple-blocked">Ocupado</span>')}
        </td>
      </tr>`;
    }).join('');

    content.innerHTML = `${this.renderMobileAgendaControls()}
      <div class="mobile-simple-table-wrap">
        <table class="mobile-simple-table">
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    this.bindMobileAgendaControls(content);
    content.querySelectorAll('[data-apt-id]').forEach(button => {
      button.addEventListener('click', () => this.openAppointmentDetail(button.dataset.aptId));
    });
    content.querySelectorAll('.mobile-simple-add').forEach(button => {
      button.addEventListener('click', () => this.openAppointmentModal({
        store_id: button.dataset.store,
        time: button.dataset.time,
      }));
    });
  },

  renderSimplified() {
    const dateStr = this.fmtDate(this.selDate);
    const times = getTimesForDate(this.selDate);
    const appointments = DB.appointments.filter(a => a.date === dateStr && a.status !== 'cancelled');
    const sections = [
      { label: 'Manha', icon: 'fa-sun', times: times.filter(time => parseMinutes(time) < 13 * 60) },
      { label: 'Tarde', icon: 'fa-cloud-sun', times: times.filter(time => parseMinutes(time) >= 13 * 60) },
    ].filter(section => section.times.length);

    let html = '<div class="simplified-view">';

    sections.forEach(section => {
      html += `<section class="simp-section">
        <div class="simp-tab"><i class="fas ${section.icon}"></i><span>${section.label}</span></div>
        <div class="simp-table-wrap">
          <table class="simp-table">
            <thead><tr>${section.times.map(time => `<th>${time}</th>`).join('')}</tr></thead>
            <tbody><tr>`;

      section.times.forEach(time => {
        const atTime = appointments.filter(apt => normalizeTime(apt.time) === time);
        const canAdd = ['admin', 'optometrist'].includes(DB.profile.role) || DB.profile.store_id;
        html += `<td class="${atTime.length ? 'filled' : 'empty'}" data-time="${time}">
          ${atTime.length ? atTime.map(apt => {
            const store = DB.getStore(apt.store_id);
            const hasNewPrescription = this.hasUnreadPrescriptionForAppointment(apt);
            return `<button class="simp-apt ${hasNewPrescription ? 'rx-ready-card' : ''}" data-apt-id="${apt.id}" style="--store:${store?.color || '#64748b'}">
              <span class="simp-store"><span class="dot" style="background:${store?.color || '#64748b'}"></span>${esc(store?.name || 'Loja')}</span>
              <strong>${esc(apt.client_name)}</strong>
              ${hasNewPrescription ? '<span class="apt-rx-dot" title="Nova receita"></span>' : ''}
            </button>`;
          }).join('') : (canAdd ? '<button class="simp-add" type="button"><i class="fas fa-plus"></i></button>' : '')}
        </td>`;
      });

      html += `</tr></tbody></table></div></section>`;
    });

    html += '</div>';
    document.getElementById('content').innerHTML = html;
    document.querySelectorAll('.simp-apt').forEach(card => {
      card.addEventListener('click', () => this.openAppointmentDetail(card.dataset.aptId));
    });
    document.querySelectorAll('.simp-table td.empty').forEach(cell => {
      cell.addEventListener('click', () => this.openAppointmentModal({
        store_id: DB.profile.role === 'store' ? DB.profile.store_id : DB.stores[0]?.id,
        time: cell.dataset.time,
      }));
    });
  },

  renderClients() {
    const showingAll = ['admin', 'optometrist'].includes(DB.profile.role);
    const clients = showingAll
      ? this.getVisibleClientsForAllStores()
      : DB.clients.filter(client => client.store_id === DB.profile.store_id);
    const html = `<div class="toolbar">
      <div>
        <h2>Clientes</h2>
        <p>${showingAll ? 'Todos os clientes com etiquetas por loja.' : 'Clientes da loja logada.'}</p>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-primary" id="new-client"><i class="fas fa-user-plus"></i> Cliente</button>
      </div>
    </div>
    ${clients.length ? `<div class="client-grid">
      ${clients.map(client => {
        const store = DB.getStore(client.store_id);
        const canEdit = !client.synthetic && DB.canManageStore(client.store_id);
        return `<button class="client-card" data-client-id="${client.id}" ${client.synthetic ? 'data-synthetic="1"' : ''} ${canEdit ? '' : 'data-readonly="1"'} style="--store:${store?.color || '#64748b'}">
          <span class="client-store"><span class="dot" style="background:${store?.color || '#64748b'}"></span>${esc(store?.name || 'Loja')}</span>
          <strong>${esc(client.name)}</strong>
          <span>${this.fmtPhone(client.phone)}</span>
          ${client.synthetic ? '<small>Vindo da agenda</small>' : (client.email ? `<small>${esc(client.email)}</small>` : '')}
        </button>`;
      }).join('')}
    </div>` : this.emptyState('fa-user-group', 'Nenhum cliente ainda', 'Cadastre clientes avulsos ou crie um agendamento.')}`;

    document.getElementById('content').innerHTML = html;
    document.getElementById('new-client').onclick = () => this.openClientModal();
    document.querySelectorAll('[data-client-id]').forEach(row => {
      row.addEventListener('click', () => {
        if (row.dataset.synthetic === '1') {
          this.toast('Cliente de outra loja visto pela agenda; cadastro completo bloqueado pelo Supabase', 'info');
          return;
        }
        const client = DB.getClient(row.dataset.clientId);
        if (!client) return;
        if (!DB.canManageStore(client.store_id)) {
          this.toast('Cliente de outra loja: somente visualizacao', 'info');
          return;
        }
        this.openClientModal(client);
      });
    });
  },

  getVisibleClientsForAllStores() {
    const byKey = new Map();
    const keyFor = (storeId, phone, id = '') => `${storeId || ''}:${onlyDigits(phone) || id}`;

    DB.clients.forEach(client => {
      byKey.set(keyFor(client.store_id, client.phone, client.id), { ...client, synthetic: false });
    });

    DB.appointments.forEach(apt => {
      if (!apt.store_id || apt.status === 'cancelled') return;
      const phone = apt.client_phone || '';
      const key = keyFor(apt.store_id, phone, apt.client_id || apt.id);
      if (byKey.has(key)) return;
      byKey.set(key, {
        id: `appointment-client:${apt.store_id}:${onlyDigits(phone) || apt.id}`,
        store_id: apt.store_id,
        name: apt.client_name || 'Cliente',
        phone,
        email: '',
        notes: '',
        synthetic: true,
      });
    });

    return [...byKey.values()].sort((a, b) => {
      const storeA = DB.getStore(a.store_id)?.name || '';
      const storeB = DB.getStore(b.store_id)?.name || '';
      return storeA.localeCompare(storeB, 'pt-BR') || a.name.localeCompare(b.name, 'pt-BR');
    });
  },

  renderAdmin() {
    if (DB.profile.role !== 'admin') {
      this.activeView = 'agenda';
      this.renderAgenda();
      return;
    }

    const today = this.fmtDate(new Date());
    const todayCount = DB.appointments.filter(a => a.date === today && a.status !== 'cancelled').length;

    const html = `<div class="toolbar">
      <div>
        <h2>Admin</h2>
        <p>Crie lojas, logins e acompanhe o movimento geral.</p>
      </div>
      <div class="toolbar-actions">
        <button class="btn btn-secondary" id="open-optometrist-form"><i class="fas fa-user-doctor"></i> Optometrista</button>
        <button class="btn btn-primary" id="open-store-form"><i class="fas fa-store"></i> Nova loja</button>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat"><span>${DB.stores.length}</span><small>Lojas ativas</small></div>
      <div class="stat"><span>${DB.clients.length}</span><small>Clientes</small></div>
      <div class="stat"><span>${todayCount}</span><small>Hoje</small></div>
      <div class="stat"><span>${DB.optometrists.length}</span><small>Optometristas</small></div>
    </div>
    <div class="panel">
      <div class="panel-head">
        <h3>Lojas</h3>
        <span>${DB.stores.length} cadastro(s)</span>
      </div>
      ${DB.stores.length ? `<div class="store-list">
        ${DB.stores.map(store => `<button class="store-row" data-store-id="${store.id}">
          <span class="store-color" style="background:${store.color}"></span>
          <div>
            <strong>${esc(store.name)}</strong>
            <small>${esc(store.login_nick)} - clique para editar</small>
          </div>
          <i class="fas fa-chevron-right"></i>
        </button>`).join('')}
      </div>` : this.emptyState('fa-store', 'Nenhuma loja cadastrada', 'Use o botao Nova loja para criar login e agenda da loja.')}
    </div>
    <div class="panel">
      <div class="panel-head">
        <h3>Optometristas</h3>
        <span>${DB.optometrists.length} login(s)</span>
      </div>
      ${DB.optometrists.length ? `<div class="store-list">
        ${DB.optometrists.map(profile => `<button class="store-row" data-optometrist-id="${profile.id}">
          <span class="store-color optometrist-color"><i class="fas fa-user-doctor"></i></span>
          <div>
            <strong>${esc(profile.full_name || 'Optometrista')}</strong>
            <small>${esc(profile.login_nick || 'login criado')} - clique para editar</small>
          </div>
          <i class="fas fa-chevron-right"></i>
        </button>`).join('')}
      </div>` : this.emptyState('fa-user-doctor', 'Nenhum optometrista cadastrado', 'Use o botao Optometrista para criar o login.')}
    </div>`;

    document.getElementById('content').innerHTML = html;
    document.getElementById('open-store-form').onclick = () => this.openStoreModal();
    document.getElementById('open-optometrist-form').onclick = () => this.openOptometristModal();
    document.querySelectorAll('[data-store-id]').forEach(row => {
      row.addEventListener('click', () => this.openStoreModal(DB.getStore(row.dataset.storeId)));
    });
    document.querySelectorAll('[data-optometrist-id]').forEach(row => {
      row.addEventListener('click', () => this.openOptometristModal(DB.getOptometrist(row.dataset.optometristId)));
    });
  },

  openAppointmentStats() {
    const selected = new Date(this.selDate);
    const weekStart = startOfWeekMonday(selected);
    const weekEnd = endOfDay(addDays(weekStart, 6));
    const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
    const monthEnd = endOfDay(new Date(selected.getFullYear(), selected.getMonth() + 1, 0));
    const yearStart = new Date(selected.getFullYear(), 0, 1);
    const yearEnd = endOfDay(new Date(selected.getFullYear(), 11, 31));
    const visibleAppointments = DB.appointments.filter(apt => apt.status !== 'cancelled');
    const countBetween = (start, end, storeId = null) => visibleAppointments.filter(apt => {
      if (storeId && apt.store_id !== storeId) return false;
      const date = parseLocalDate(apt.date);
      return date >= start && date <= end;
    }).length;
    const statItems = [
      { label: 'Semana', value: countBetween(weekStart, weekEnd), range: `${this.fmtDateDisplay(weekStart)} a ${this.fmtDateDisplay(weekEnd)}` },
      { label: 'Mes', value: countBetween(monthStart, monthEnd), range: `${MONTHS[selected.getMonth()]} ${selected.getFullYear()}` },
      { label: 'Ano', value: countBetween(yearStart, yearEnd), range: String(selected.getFullYear()) },
    ];
    const stores = ['admin', 'optometrist'].includes(DB.profile.role)
      ? DB.stores
      : DB.stores.filter(store => store.id === DB.profile.store_id);

    this.openModal(`<div class="modal-head">
      <h3>Agendamentos</h3>
      <button class="modal-close">&times;</button>
    </div>
    <div class="modal-body form-stack appointment-stats-body">
      <div class="stats-range">
        <i class="fas fa-calendar-day"></i>
        <span>Referencia: ${this.fmtDateDisplay(selected)}</span>
      </div>
      <div class="appointment-stats-grid">
        ${statItems.map(item => `<div class="stat">
          <span>${item.value}</span>
          <small>${item.label}</small>
          <em>${item.range}</em>
        </div>`).join('')}
      </div>
      ${stores.length > 1 ? `<div class="panel stats-store-panel">
        <div class="panel-head">
          <h3>Por loja</h3>
          <span>${stores.length} loja(s)</span>
        </div>
        <div class="store-list">
          ${stores.map(store => `<div class="store-row stats-store-row">
            <span class="store-color" style="background:${store.color}"></span>
            <div>
              <strong>${esc(store.name)}</strong>
              <small>Semana ${countBetween(weekStart, weekEnd, store.id)} - Mes ${countBetween(monthStart, monthEnd, store.id)} - Ano ${countBetween(yearStart, yearEnd, store.id)}</small>
            </div>
          </div>`).join('')}
        </div>
      </div>` : ''}
    </div>`);
  },

  openAppointmentModal(defaults = {}) {
    const allowedStores = ['admin', 'optometrist'].includes(DB.profile.role)
      ? DB.stores
      : DB.stores.filter(store => store.id === DB.profile.store_id);

    if (!allowedStores.length) {
      this.toast('Nenhuma loja disponivel para agendar', 'error');
      return;
    }

    const selectedStoreId = defaults.store_id || allowedStores[0].id;
    const store = DB.getStore(selectedStoreId) || allowedStores[0];
    const dateValue = isSunday(this.selDate) ? this.fmtDate(nextOpenDate(this.selDate)) : this.fmtDate(this.selDate);
    const initialTimes = this.getAvailableAppointmentTimes(dateValue);
    if (!initialTimes.length && !defaults.time) {
      this.toast('Todos os horarios deste dia ja estao ocupados', 'error');
      return;
    }
    const time = defaults.time || initialTimes[0] || '08:00';
    const openedFromScheduleCell = Boolean(defaults.store_id && defaults.time);
    const hideSlotFields = DB.profile.role === 'store' || openedFromScheduleCell;
    const slotFields = hideSlotFields
      ? `<input type="hidden" id="apt-store" value="${esc(store.id)}">
        <input type="hidden" id="apt-date" value="${dateValue}">
        <input type="hidden" id="apt-time" value="${time}">`
      : `<label>Loja
        <select id="apt-store">
          ${allowedStores.map(s => `<option value="${s.id}" ${s.id === store.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      <div class="field-row">
        <label>Data
          <input type="date" id="apt-date" value="${dateValue}">
        </label>
        <label>Horario
          <select id="apt-time">${initialTimes.map(t => `<option value="${t}" ${t === time ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
      </div>`;

    this.openModal(`<div class="modal-head">
      <h3>Novo agendamento</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="appointment-form">
      ${slotFields}
      <label>Cliente
        <input type="text" id="apt-client" list="clients-list" placeholder="Nome completo" required>
        <datalist id="clients-list">
          ${DB.clients.filter(c => c.store_id === store.id).map(c => `<option value="${esc(c.name)}" data-phone="${esc(c.phone)}"></option>`).join('')}
        </datalist>
      </label>
      <label>Telefone
        <input type="tel" id="apt-phone" placeholder="19912345678" required>
      </label>
      <label>Observacoes
        <textarea id="apt-notes" placeholder="Opcional"></textarea>
      </label>
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">Agendar</button>
      </div>
    </form>`);

    const storeField = document.getElementById('apt-store');
    const dateField = document.getElementById('apt-date');

    if (storeField.tagName === 'SELECT') storeField.onchange = event => {
      const selected = DB.getStore(event.target.value);
      document.getElementById('clients-list').innerHTML = DB.clients
        .filter(c => c.store_id === selected.id)
        .map(c => `<option value="${esc(c.name)}" data-phone="${esc(c.phone)}"></option>`)
        .join('');
    };

    if (dateField.type === 'date') dateField.onchange = event => {
      const times = this.getAvailableAppointmentTimes(event.target.value);
      document.getElementById('apt-time').innerHTML = times.map(t => `<option value="${t}">${t}</option>`).join('');
      if (isSunday(parseLocalDate(event.target.value))) this.toast('Fechado aos domingos', 'error');
      else if (!times.length) this.toast('Todos os horarios deste dia ja estao ocupados', 'error');
    };

    document.getElementById('apt-client').onchange = event => {
      const currentStore = document.getElementById('apt-store').value;
      const client = DB.clients.find(c => c.store_id === currentStore && c.name === event.target.value);
      if (client) {
        document.getElementById('apt-phone').value = this.fmtPhone(client.phone);
      }
    };

    document.getElementById('appointment-form').onsubmit = async event => {
      event.preventDefault();
      const payload = this.readAppointmentForm();
      if (isSunday(parseLocalDate(payload.date))) {
        this.toast('Fechado aos domingos', 'error');
        return;
      }
      if (!getTimesForDate(parseLocalDate(payload.date)).includes(normalizeTime(payload.time))) {
        this.toast('Horario fora da grade do dia', 'error');
        return;
      }
      if (this.hasAppointmentConflict(payload)) {
        this.toast('Este horario ja esta ocupado', 'error');
        return;
      }
      try {
        await DB.saveAppointment(payload);
        this.closeModal();
        this.selDate = parseLocalDate(payload.date);
        this.calDate = parseLocalDate(payload.date);
        this.render();
        this.toast('Agendamento criado', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  openAppointmentDetail(id) {
    const apt = DB.appointments.find(row => row.id === id);
    if (!apt) return;
    const store = DB.getStore(apt.store_id);
    const client = DB.getClient(apt.client_id)
      || DB.clients.find(row => row.store_id === apt.store_id && row.phone === apt.client_phone)
      || null;
    const canEdit = DB.canManageStore(apt.store_id);
    const canViewPrescription = Boolean(client && DB.canManageStore(client.store_id));
    const currentTime = normalizeTime(apt.time);
    const times = this.getAvailableAppointmentTimes(apt.date, apt.id);
    if (!times.includes(currentTime)) times.push(currentTime);
    const currentPrescription = canViewPrescription ? parsePrescription(client?.prescription) : emptyPrescription();
    const newPrescription = canViewPrescription ? parsePrescription(client?.new_prescription) : emptyPrescription();
    const canEditCurrentPrescription = canViewPrescription && canEdit && ['admin', 'store'].includes(DB.profile.role);
    const canEditNewPrescription = canViewPrescription && canEdit && ['admin', 'optometrist'].includes(DB.profile.role);
    const canDeleteNewPrescription = Boolean(canViewPrescription && client?.id && client?.new_prescription && DB.profile.role === 'admin');
    const prescriptionSection = canViewPrescription
      ? this.renderPrescriptionSection(currentPrescription, newPrescription, {
        currentEditable: canEditCurrentPrescription,
        newEditable: canEditNewPrescription,
        newDeletable: canDeleteNewPrescription,
        clientId: client?.id,
        printEnabled: true,
      })
      : '';

    this.openModal(`<div class="modal-head">
      <h3>${canEdit ? 'Editar' : 'Visualizar'} agendamento</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="appointment-detail-form">
      <label>Loja
        <input type="text" id="apt-store-name" value="${esc(store?.name || 'Loja')}" disabled>
      </label>
      <div class="field-row">
        <label>Data
          <input type="date" id="apt-date" value="${apt.date}" ${canEdit ? '' : 'disabled'}>
        </label>
        <label>Horario
          <select id="apt-time" ${canEdit ? '' : 'disabled'}>${times.map(t => `<option value="${t}" ${t === normalizeTime(apt.time) ? 'selected' : ''}>${t}</option>`).join('')}</select>
        </label>
      </div>
      <label>Cliente
        <input type="text" id="apt-client" value="${esc(apt.client_name)}" ${canEdit ? '' : 'disabled'}>
      </label>
      <label>Telefone
        <input type="tel" id="apt-phone" value="${this.fmtPhone(apt.client_phone)}" ${canEdit ? '' : 'disabled'}>
      </label>
      <label>Observacoes
        <textarea id="apt-notes" ${canEdit ? '' : 'disabled'}>${esc(apt.notes || '')}</textarea>
      </label>
      ${prescriptionSection}
      <div class="modal-foot appointment-actions">
        <button class="btn btn-whatsapp" type="button" id="whatsapp"><i class="fab fa-whatsapp"></i> WhatsApp</button>
        ${canEdit ? '<button class="btn btn-danger" type="button" id="delete-apt"><i class="fas fa-trash"></i> Excluir</button>' : ''}
        ${canEdit ? '<button class="btn btn-primary" type="submit">Salvar</button>' : ''}
      </div>
    </form>`);

    if (canEdit) {
      document.getElementById('apt-date')?.addEventListener('change', event => {
        const availableTimes = this.getAvailableAppointmentTimes(event.target.value, apt.id);
        document.getElementById('apt-time').innerHTML = availableTimes
          .map(t => `<option value="${t}">${t}</option>`)
          .join('');
        if (isSunday(parseLocalDate(event.target.value))) this.toast('Fechado aos domingos', 'error');
        else if (!availableTimes.length) this.toast('Todos os horarios deste dia ja estao ocupados', 'error');
      });
    }

    document.getElementById('whatsapp').onclick = () => {
      const phone = onlyDigits(document.getElementById('apt-phone').value);
      const name = document.getElementById('apt-client').value || 'cliente';
      const time = document.getElementById('apt-time').value;
      const date = document.getElementById('apt-date').value.split('-').reverse().join('/');
      if (phone) {
        const msg = encodeURIComponent(`Ola ${name}! Confirmamos seu agendamento para ${date} as ${time}.`);
        window.open(`https://wa.me/55${phone}?text=${msg}`, '_blank');
      }
    };

    document.getElementById('delete-apt')?.addEventListener('click', async () => {
      if (!confirm('Excluir este agendamento?')) return;
      try {
        await DB.removeAppointment(apt.id);
        this.closeModal();
        this.render();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });

    document.getElementById('appointment-detail-form').onsubmit = async event => {
      event.preventDefault();
      const payload = {
        id: apt.id,
        client_id: apt.client_id,
        store_id: apt.store_id,
        date: document.getElementById('apt-date').value,
        time: document.getElementById('apt-time').value,
        client_name: document.getElementById('apt-client').value.trim(),
        client_phone: document.getElementById('apt-phone').value,
        notes: document.getElementById('apt-notes').value,
        client_current_prescription: canEditCurrentPrescription ? serializePrescription(this.readPrescriptionGrid('current')) : undefined,
        client_new_prescription: canEditNewPrescription ? serializePrescription(this.readPrescriptionGrid('new')) : undefined,
        status: apt.status || 'scheduled',
      };
      if (this.hasAppointmentConflict(payload, apt.id)) {
        this.toast('Este horario ja esta ocupado', 'error');
        return;
      }
      if (isSunday(parseLocalDate(payload.date))) {
        this.toast('Fechado aos domingos', 'error');
        return;
      }
      if (!getTimesForDate(parseLocalDate(payload.date)).includes(normalizeTime(payload.time))) {
        this.toast('Horario fora da grade do dia', 'error');
        return;
      }
      try {
        await DB.saveAppointment(payload);
        this.closeModal();
        this.render();
        this.toast('Agendamento atualizado', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  openClientModal(client = null, options = {}) {
    const stores = ['admin', 'optometrist'].includes(DB.profile.role) ? DB.stores : DB.stores.filter(s => s.id === DB.profile.store_id);
    const selectedStoreId = client?.store_id || stores[0]?.id;
    const currentPrescription = parsePrescription(client?.prescription);
    const newPrescription = parsePrescription(client?.new_prescription);
    const canEditCurrentPrescription = ['admin', 'store'].includes(DB.profile.role);
    const canEditNewPrescription = ['admin', 'optometrist'].includes(DB.profile.role);
    const canDeleteClient = Boolean(client && DB.profile.role === 'admin');
    const canDeleteNewPrescription = Boolean(client?.id && client?.new_prescription && DB.profile.role === 'admin');

    this.openModal(`<div class="modal-head">
      <h3>${client ? 'Editar cliente' : 'Novo cliente'}</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="client-form">
      <label>Loja
        <select id="client-store" ${DB.profile.role === 'store' ? 'disabled' : ''}>
          ${stores.map(s => `<option value="${s.id}" ${s.id === selectedStoreId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      <label>Nome
        <input type="text" id="client-name" value="${esc(client?.name || '')}" required>
      </label>
      <label>Telefone
        <input type="tel" id="client-phone" value="${this.fmtPhone(client?.phone || '')}" required>
      </label>
      <label>Observacoes
        <textarea id="client-notes">${esc(client?.notes || '')}</textarea>
      </label>
      ${this.renderPrescriptionSection(currentPrescription, newPrescription, {
        currentEditable: canEditCurrentPrescription,
        newEditable: canEditNewPrescription,
        newDeletable: canDeleteNewPrescription,
        activeTab: options.activePrescription,
        clientId: client?.id,
        printEnabled: Boolean(client),
      })}
      <div class="modal-foot client-actions">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        ${canDeleteClient ? '<button class="btn btn-danger" type="button" id="delete-client"><i class="fas fa-trash"></i> Excluir</button>' : ''}
        <button class="btn btn-primary" type="submit">Salvar</button>
      </div>
    </form>`);

    document.getElementById('delete-client')?.addEventListener('click', async () => {
      if (!confirm('Excluir este cliente?')) return;
      try {
        await DB.removeClient(client.id);
        this.closeModal();
        this.render();
        this.toast('Cliente excluido', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });

    document.getElementById('client-form').onsubmit = async event => {
      event.preventDefault();
      try {
        await DB.saveClient({
          id: client?.id,
          store_id: document.getElementById('client-store').value,
          name: document.getElementById('client-name').value,
          phone: document.getElementById('client-phone').value,
          email: '',
          notes: document.getElementById('client-notes').value,
          current_prescription: canEditCurrentPrescription ? serializePrescription(this.readPrescriptionGrid('current')) : undefined,
          new_prescription: canEditNewPrescription ? serializePrescription(this.readPrescriptionGrid('new')) : undefined,
        });
        this.closeModal();
        this.render();
        this.toast('Cliente salvo', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  renderPrescriptionSection(currentPrescription, newPrescription, permissions = {}) {
    const currentDisabled = !permissions.currentEditable;
    const newDisabled = !permissions.newEditable;
    const requestedTab = ['current', 'new'].includes(permissions.activeTab) ? permissions.activeTab : null;
    const activeTab = requestedTab || (permissions.newEditable && !permissions.currentEditable ? 'new' : 'current');
    const clientAttr = permissions.clientId ? ` data-rx-client-id="${esc(permissions.clientId)}"` : '';

    return `<fieldset class="prescription-grid-field"${clientAttr}>
      <legend>Receita do oculos</legend>
      <div class="rx-toggle" role="tablist" data-rx-active-tab="${activeTab}"${clientAttr}>
        <button class="rx-toggle-btn ${activeTab === 'current' ? 'active' : ''}" type="button" data-rx-tab="current">Receita atual</button>
        <button class="rx-toggle-btn ${activeTab === 'new' ? 'active' : ''}" type="button" data-rx-tab="new">Nova receita</button>
      </div>
      <div class="rx-panel ${activeTab === 'current' ? 'active' : 'hidden'}" data-rx-panel="current">
        ${this.renderPrescriptionGrid(currentPrescription, currentDisabled, 'current')}
      </div>
      <div class="rx-panel ${activeTab === 'new' ? 'active' : 'hidden'}" data-rx-panel="new">
        ${this.renderPrescriptionGrid(newPrescription, newDisabled, 'new')}
        ${permissions.printEnabled ? `<div class="rx-print-actions">
          <button class="btn btn-secondary" type="button" data-print-prescription="a4"><i class="fas fa-print"></i> Imprimir A4</button>
          <button class="btn btn-secondary" type="button" data-print-prescription="thermal"><i class="fas fa-receipt"></i> Imprimir cupom</button>
        </div>` : ''}
        ${permissions.newDeletable ? '<button class="btn btn-danger rx-delete-new-prescription" type="button" data-delete-new-prescription><i class="fas fa-trash"></i> Excluir nova receita</button>' : ''}
      </div>
      <div class="rx-sign-toolbar hidden" data-rx-sign-toolbar aria-label="Sinal da receita">
        <button type="button" data-rx-sign="+" title="Adicionar sinal positivo">+</button>
        <button type="button" data-rx-sign="-" title="Adicionar sinal negativo">-</button>
      </div>
    </fieldset>`;
  },

  renderPrescriptionGrid(prescription, disabled = false, kind = 'current') {
    const columns = [
      ['spherical', 'Esférico'],
      ['cylindrical', 'Cilíndrico'],
      ['axis', 'Eixo'],
      ['dnp', 'DNP'],
      ['height', 'Altura'],
    ];
    const inputCell = (distance, eye, key) => `
      <input
        class="rx-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        data-rx-kind="${kind}"
        data-rx-distance="${distance}"
        data-rx-eye="${eye}"
        data-rx-field="${key}"
        value="${esc(prescription?.[distance]?.[eye]?.[key] || '')}"
        ${disabled ? 'disabled' : ''}
      >
    `;

    return `<div class="rx-prescription">
        <div class="rx-header-row">
          ${columns.map(([, label]) => `<div class="rx-head">${label}</div>`).join('')}
        </div>
        <div class="rx-body-grid">
          <div class="rx-distance far">Longe</div>
          <div class="rx-eye far">OD</div>
          ${columns.map(([key]) => inputCell('far', 'od', key)).join('')}
          <div class="rx-eye far">OE</div>
          ${columns.map(([key]) => inputCell('far', 'oe', key)).join('')}
          <div class="rx-distance near">Perto</div>
          <div class="rx-eye near">OD</div>
          ${columns.map(([key]) => inputCell('near', 'od', key)).join('')}
          <div class="rx-eye near">OE</div>
          ${columns.map(([key]) => inputCell('near', 'oe', key)).join('')}
        </div>
        <label class="rx-addition-field">Adi&ccedil;&atilde;o
          <input
            class="rx-input rx-addition-input"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            data-rx-kind="${kind}"
            data-rx-addition="1"
            data-rx-field="addition"
            value="${esc(prescription?.addition || '')}"
            ${disabled ? 'disabled' : ''}
          >
        </label>
      </div>`;
  },

  readPrescriptionGrid(kind) {
    const prescription = emptyPrescription();
    document.querySelectorAll(`[data-rx-kind="${kind}"][data-rx-distance][data-rx-eye][data-rx-field]`).forEach(input => {
      prescription[input.dataset.rxDistance][input.dataset.rxEye][input.dataset.rxField] = input.value.trim();
    });
    const addition = document.querySelector(`[data-rx-kind="${kind}"][data-rx-addition]`);
    if (addition) prescription.addition = addition.value.trim();
    return prescription;
  },

  openOptometristModal(profile = null) {
    const isEdit = Boolean(profile);
    this.openModal(`<div class="modal-head">
      <h3>${isEdit ? 'Editar optometrista' : 'Novo optometrista'}</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack" id="optometrist-form">
      <label>Nome
        <input type="text" id="optometrist-name" placeholder="Nome do optometrista" value="${esc(profile?.full_name || '')}" required>
      </label>
      <label>Nick/login
        <input type="text" id="optometrist-nick" placeholder="optometrista-1" value="${esc(profile?.login_nick || '')}" required>
      </label>
      <label>Senha
        <span class="password-row">
          <input type="password" id="optometrist-password" minlength="6" placeholder="${isEdit ? 'Deixe em branco para manter' : 'Minimo 6 caracteres'}" ${isEdit ? '' : 'required'}>
          <button class="btn-eye" type="button" data-toggle-password="optometrist-password" title="Mostrar senha"><i class="fas fa-eye"></i></button>
        </span>
      </label>
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">${isEdit ? 'Salvar login' : 'Criar login'}</button>
      </div>
    </form>`);

    document.getElementById('optometrist-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const payload = {
          name: document.getElementById('optometrist-name').value,
          nick: document.getElementById('optometrist-nick').value,
          password: document.getElementById('optometrist-password').value,
        };
        if (isEdit) await DB.updateOptometrist(profile.id, payload);
        else await DB.createOptometrist(payload);
        this.closeModal();
        this.render();
        this.toast(isEdit ? 'Optometrista atualizado' : 'Optometrista criado com login proprio', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  openPrescriptionNotifications() {
    if (DB.profile.role !== 'store') return;

    const notifications = [
      ...DB.prescriptionNotifications.map(item => ({ ...item, kind: 'prescription' })),
      ...DB.appointmentNotifications.map(item => ({ ...item, kind: 'appointment' })),
    ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    this.openModal(`<div class="modal-head">
      <h3>Notificacoes</h3>
      <button class="modal-close">&times;</button>
    </div>
    <div class="modal-body form-stack">
      ${notifications.length ? `<div class="notification-list">
        ${notifications.map(item => `<button class="notification-item ${item.read_at ? '' : 'unread'} ${item.kind === 'appointment' ? 'cancelled' : ''}" type="button" data-kind="${item.kind}" data-notification-id="${item.id || item.local_id || ''}" data-client-id="${item.client_id || ''}">
          <strong>${item.kind === 'appointment' ? 'Agendamento cancelado' : esc(item.client_name || 'Cliente')}</strong>
          <span>${esc(item.message || 'Receita recebida')}</span>
          <small>${this.fmtDateTime(item.created_at)}</small>
        </button>`).join('')}
      </div>` : this.emptyState('fa-bell', 'Nenhuma notificacao', 'Receitas prontas e cancelamentos aparecem aqui.')}
      <div class="modal-foot">
        <button class="btn btn-secondary modal-close" type="button">Fechar</button>
        ${notifications.some(item => !item.read_at) ? '<button class="btn btn-primary" type="button" id="mark-notifications-read">Marcar como lidas</button>' : ''}
        ${notifications.length ? '<button class="btn btn-danger" type="button" id="clear-notifications"><i class="fas fa-trash"></i> Limpar notificacoes</button>' : ''}
      </div>
    </div>`);

    document.querySelectorAll('.notification-item[data-client-id]').forEach(button => {
      button.addEventListener('click', async () => {
        if (button.dataset.kind === 'appointment') {
          await DB.markAppointmentNotificationRead(button.dataset.notificationId);
          this.closeModal();
          this.render();
          return;
        }
        const notificationId = button.dataset.notificationId;
        if (notificationId) {
          await this.openPrescriptionNotification(notificationId);
          return;
        }
        const client = DB.getClient(button.dataset.clientId);
        if (client) this.openClientModal(client);
      });
    });

    document.getElementById('mark-notifications-read')?.addEventListener('click', async () => {
      try {
        await DB.markPrescriptionNotificationsRead();
        await DB.markAppointmentNotificationsRead();
        this.closeModal();
        this.render();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });

    document.getElementById('clear-notifications')?.addEventListener('click', async () => {
      if (!confirm('Limpar todo o historico de notificacoes?')) return;
      try {
        await DB.clearAllNotifications();
        this.closeModal();
        this.render();
        this.toast('Notificacoes limpas', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  openStoreModal(store = null) {
    const isEdit = Boolean(store);
    const nextColor = store?.color || DEFAULT_COLORS[DB.stores.length % DEFAULT_COLORS.length];
    this.openModal(`<div class="modal-head">
      <h3>${isEdit ? 'Editar loja' : 'Nova loja'}</h3>
      <button class="modal-close">&times;</button>
    </div>
    <form class="modal-body form-stack store-form" id="store-form">
      <div class="store-form-note">
        <i class="fas fa-calendar-day"></i>
        <span>Segunda a quinta das 08:00 as 18:00. Sexta das 14:00 as 17:30. Sabado das 09:00 as 13:00.</span>
      </div>
      <label>Nome da loja
        <input type="text" id="store-name" placeholder="Loja Centro" value="${esc(store?.name || '')}" required>
      </label>
      <label>Nick/login
        <input type="text" id="store-nick" placeholder="loja-centro" value="${esc(store?.login_nick || '')}" required>
      </label>
      <label>Senha
        <span class="password-row">
          <input type="password" id="store-password" minlength="6" placeholder="${isEdit ? 'Deixe em branco para manter' : 'Minimo 6 caracteres'}" ${isEdit ? '' : 'required'}>
          <button class="btn-eye" type="button" data-toggle-password="store-password" title="Mostrar senha"><i class="fas fa-eye"></i></button>
        </span>
      </label>
      <label>Cor da loja
        <input type="hidden" id="store-color" value="${nextColor}">
        <div class="color-swatches" id="store-color-swatches">
          ${DEFAULT_COLORS.map(color => `<button class="color-swatch ${color === nextColor ? 'active' : ''}" type="button" data-color="${color}" style="--swatch:${color}" title="${color}"></button>`).join('')}
        </div>
      </label>
      <div class="modal-foot store-actions">
        <button class="btn btn-secondary modal-close" type="button">Cancelar</button>
        <button class="btn btn-primary" type="submit">${isEdit ? 'Salvar loja' : 'Criar loja'}</button>
      </div>
    </form>`);

    document.querySelectorAll('#store-color-swatches .color-swatch').forEach(button => {
      button.addEventListener('click', () => {
        document.querySelectorAll('#store-color-swatches .color-swatch').forEach(item => item.classList.remove('active'));
        button.classList.add('active');
        document.getElementById('store-color').value = button.dataset.color;
      });
    });

    document.getElementById('store-form').onsubmit = async event => {
      event.preventDefault();
      try {
        const payload = {
          name: document.getElementById('store-name').value,
          nick: document.getElementById('store-nick').value,
          password: document.getElementById('store-password').value,
          color: document.getElementById('store-color').value,
        };
        if (isEdit) await DB.updateStore(store.id, payload);
        else await DB.createStore(payload);
        this.closeModal();
        this.render();
        this.toast(isEdit ? 'Loja atualizada' : 'Loja criada com login proprio', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    };
  },

  bindPasswordToggles(scope) {
    scope.querySelectorAll('[data-toggle-password]').forEach(button => {
      if (button.dataset.bound === '1') return;
      button.dataset.bound = '1';
      button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.togglePassword);
        if (!input) return;
        const willShow = input.type === 'password';
        input.type = willShow ? 'text' : 'password';
        button.innerHTML = `<i class="fas fa-${willShow ? 'eye-slash' : 'eye'}"></i>`;
        button.title = willShow ? 'Ocultar senha' : 'Mostrar senha';
      });
    });
  },

  readAppointmentForm() {
    return {
      store_id: document.getElementById('apt-store').value,
      date: document.getElementById('apt-date').value,
      time: document.getElementById('apt-time').value,
      client_name: document.getElementById('apt-client').value.trim(),
      client_phone: document.getElementById('apt-phone').value,
      notes: document.getElementById('apt-notes').value,
    };
  },

  isAppointmentSlotTaken(date, time, ignoreId = null) {
    return DB.appointments.some(apt => {
      return apt.id !== ignoreId
        && apt.date === date
        && normalizeTime(apt.time) === normalizeTime(time)
        && apt.status !== 'cancelled';
    });
  },

  getAvailableAppointmentTimes(date, ignoreId = null) {
    return getTimesForDate(parseLocalDate(date))
      .filter(time => !this.isAppointmentSlotTaken(date, time, ignoreId));
  },

  hasAppointmentConflict(payload, ignoreId = null) {
    return this.isAppointmentSlotTaken(payload.date, payload.time, ignoreId);
  },

  openModal(html) {
    this.closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal';
    overlay.innerHTML = `<div class="modal-box">${html}</div>`;
    if (overlay.querySelector('.rx-prescription')) {
      overlay.querySelector('.modal-box').classList.add('prescription-modal');
    }
    if (overlay.querySelector('.appointment-stats-body')) {
      overlay.querySelector('.modal-box').classList.add('appointment-stats-modal');
    }
    document.body.appendChild(overlay);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) this.closeModal();
    });
    overlay.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', () => this.closeModal()));
    this.bindPasswordToggles(overlay);
    this.bindNewPrescriptionDelete(overlay);
    this.bindPrescriptionTabs(overlay);
    this.bindPrescriptionInputs(overlay);
    this.bindPrescriptionPrint(overlay);
  },

  bindPrescriptionPrint(scope) {
    scope.querySelectorAll('[data-print-prescription]').forEach(button => {
      button.addEventListener('click', () => {
        const prescription = this.readPrescriptionGrid('new');
        if (isPrescriptionEmpty(prescription)) {
          this.toast('Preencha a nova receita antes de imprimir', 'error');
          return;
        }
        this.openPrescriptionPrintWindow(prescription, this.getPrescriptionPrintContext(), button.dataset.printPrescription);
      });
    });
  },

  getPrescriptionPrintContext() {
    const storeSelect = document.getElementById('client-store');
    const storeName = document.getElementById('apt-store-name')?.value
      || storeSelect?.selectedOptions?.[0]?.textContent
      || DB.profile?.stores?.name
      || 'Loja';
    return {
      clientName: document.getElementById('client-name')?.value.trim()
        || document.getElementById('apt-client')?.value.trim()
        || 'Cliente',
      storeName: storeName.trim(),
      printedAt: new Date(),
    };
  },

  openPrescriptionPrintWindow(prescription, context, paper) {
    const win = window.open('', '_blank', 'width=900,height=720');
    if (!win) {
      this.toast('O navegador bloqueou a janela de impressao', 'error');
      return;
    }

    win.document.open();
    win.document.write(this.buildPrescriptionPrintHtml(prescription, context, paper));
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  },

  buildPrescriptionPrintHtml(prescription, context, paper = 'a4') {
    const columns = [
      ['spherical', 'Esférico'],
      ['cylindrical', 'Cilíndrico'],
      ['axis', 'Eixo'],
      ['dnp', 'DNP'],
      ['height', 'Altura'],
    ];
    const value = (distance, eye, key) => esc(prescription?.[distance]?.[eye]?.[key] || '');
    const cell = (distance, eye, key) => `<div class="rx-print-cell">${value(distance, eye, key)}</div>`;
    const printedDate = this.fmtDateDisplay(context.printedAt);
    const isThermal = paper === 'thermal';
    const printGrid = `<section class="rx-print-prescription">
      <div class="rx-print-header-row">
        ${columns.map(([, label]) => `<div class="rx-print-head">${label}</div>`).join('')}
      </div>
      <div class="rx-print-body-grid">
        <div class="rx-print-distance far">Longe</div>
        <div class="rx-print-eye far">OD</div>
        ${columns.map(([key]) => cell('far', 'od', key)).join('')}
        <div class="rx-print-eye far">OE</div>
        ${columns.map(([key]) => cell('far', 'oe', key)).join('')}
        <div class="rx-print-distance near">Perto</div>
        <div class="rx-print-eye near">OD</div>
        ${columns.map(([key]) => cell('near', 'od', key)).join('')}
        <div class="rx-print-eye near">OE</div>
        ${columns.map(([key]) => cell('near', 'oe', key)).join('')}
      </div>
    </section>`;

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Receita nova - ${esc(context.clientName)}</title>
  <style>
    @page { size: ${isThermal ? '80mm 200mm' : 'A4'}; margin: ${isThermal ? '5mm' : '14mm'}; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #000;
      font-family: Arial, Helvetica, sans-serif;
      font-size: ${isThermal ? '8px' : '14px'};
      line-height: 1.35;
    }
    .sheet {
      width: ${isThermal ? '70mm' : '100%'};
      max-width: ${isThermal ? '70mm' : '170mm'};
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 ${isThermal ? '6px' : '14px'};
      font-size: ${isThermal ? '13px' : '24px'};
      text-align: center;
    }
    .meta {
      display: grid;
      gap: ${isThermal ? '2px' : '6px'};
      margin-bottom: ${isThermal ? '6px' : '12px'};
      padding-bottom: ${isThermal ? '5px' : '10px'};
      border-bottom: 2px solid #000;
      font-size: ${isThermal ? '8px' : '14px'};
    }
    .meta strong { display: inline-block; min-width: ${isThermal ? '0' : '72px'}; }
    .rx-print-prescription {
      --rx-line: #000;
      --rx-line-w: ${isThermal ? '1px' : '2px'};
      --rx-label-w: ${isThermal ? '12mm' : '24mm'};
      --rx-eye-w: ${isThermal ? '8mm' : '14mm'};
      --rx-measure-w: minmax(0, 1fr);
      width: 100%;
    }
    .rx-print-header-row {
      display: grid;
      grid-template-columns: repeat(5, var(--rx-measure-w));
      margin-left: calc(var(--rx-label-w) + var(--rx-eye-w));
      border: var(--rx-line-w) solid var(--rx-line);
      border-bottom: 0;
      border-radius: ${isThermal ? '5px 5px 0 0' : '12px 12px 0 0'};
      overflow: hidden;
      background: #fff;
    }
    .rx-print-body-grid {
      display: grid;
      grid-template-columns: var(--rx-label-w) var(--rx-eye-w) repeat(5, var(--rx-measure-w));
      grid-template-rows: repeat(4, ${isThermal ? '7mm' : '9.5mm'});
      border: var(--rx-line-w) solid var(--rx-line);
      border-radius: ${isThermal ? '5px 0 5px 5px' : '12px 0 12px 12px'};
      overflow: hidden;
      background: #fff;
    }
    .rx-print-head,
    .rx-print-distance,
    .rx-print-eye,
    .rx-print-cell {
      display: grid;
      place-items: center;
      min-width: 0;
      min-height: 0;
      padding: ${isThermal ? '.4mm' : '1.5mm'};
      border-right: var(--rx-line-w) solid var(--rx-line);
      border-bottom: var(--rx-line-w) solid var(--rx-line);
      background: #fff;
      color: #000;
      text-align: center;
      overflow-wrap: normal;
      word-break: normal;
      hyphens: none;
    }
    .rx-print-head {
      height: ${isThermal ? '7mm' : '9.5mm'};
      font-size: ${isThermal ? '6px' : '11px'};
      border-bottom: 0;
      font-weight: 900;
      white-space: nowrap;
    }
    .rx-print-head:last-child,
    .rx-print-body-grid > :nth-child(7),
    .rx-print-body-grid > :nth-child(13),
    .rx-print-body-grid > :nth-child(20),
    .rx-print-body-grid > :nth-child(26) {
      border-right: 0;
    }
    .rx-print-distance.near,
    .rx-print-body-grid > :nth-child(n+21) {
      border-bottom: 0;
    }
    .rx-print-distance {
      grid-row: span 2;
    }
    .rx-print-distance,
    .rx-print-eye {
      font-size: ${isThermal ? '7px' : '11px'};
      font-weight: 900;
      line-height: 1;
    }
    .rx-print-cell {
      font-size: ${isThermal ? '7px' : '11px'};
      font-weight: 800;
    }
    .rx-print-distance.far,
    .rx-print-eye.far {
      color: #000;
    }
    .rx-print-distance.near,
    .rx-print-eye.near {
      color: #000;
    }
    .rx-print-addition {
      display: grid;
      grid-template-columns: ${isThermal ? '15mm 1fr' : '32mm 1fr'};
      align-items: center;
      gap: ${isThermal ? '2mm' : '5mm'};
      width: ${isThermal ? '100%' : '90mm'};
      margin-top: ${isThermal ? '3mm' : '6mm'};
      padding: ${isThermal ? '1.4mm' : '2.5mm 4mm'};
      border: ${isThermal ? '1px' : '2px'} solid #000;
      border-radius: ${isThermal ? '5px' : '10px'};
      font-weight: 900;
    }
    .rx-print-addition-value {
      min-height: ${isThermal ? '5.5mm' : '9mm'};
      display: grid;
      place-items: center;
      border: ${isThermal ? '1px' : '2px'} solid #000;
      border-radius: ${isThermal ? '4px' : '7px'};
      font-size: ${isThermal ? '7px' : '11px'};
      font-weight: 800;
    }
    .signature {
      margin-top: ${isThermal ? '12px' : '18px'};
      padding-top: ${isThermal ? '5px' : '10px'};
      border-top: 2px solid #000;
      text-align: center;
      color: #000;
    }
  </style>
</head>
<body>
  <main class="sheet">
    <h1>Nova receita</h1>
    <section class="meta">
      <div><strong>Cliente:</strong> ${esc(context.clientName)}</div>
      <div><strong>Loja:</strong> ${esc(context.storeName)}</div>
      <div><strong>Data:</strong> ${printedDate}</div>
    </section>
    ${printGrid}
    <div class="rx-print-addition">
      <span>Adição</span>
      <span class="rx-print-addition-value">${esc(prescription.addition || '')}</span>
    </div>
    <div class="signature">Assinatura / carimbo</div>
  </main>
</body>
</html>`;
  },

  bindNewPrescriptionDelete(scope) {
    scope.querySelectorAll('[data-delete-new-prescription]').forEach(button => {
      button.addEventListener('click', async () => {
        const clientId = button.closest('[data-rx-client-id]')?.dataset.rxClientId;
        if (!clientId) return;
        if (!confirm('Excluir a nova receita deste cliente?')) return;
        try {
          await DB.removeNewPrescription(clientId);
          this.closeModal();
          this.render();
          this.toast('Nova receita excluida', 'success');
        } catch (err) {
          this.toast(err.message, 'error');
        }
      });
    });
  },

  bindPrescriptionTabs(scope) {
    scope.querySelectorAll('[data-rx-tab]').forEach(button => {
      button.addEventListener('click', async () => {
        const tab = button.dataset.rxTab;
        const toggle = button.closest('.rx-toggle');
        toggle?.setAttribute('data-rx-active-tab', tab);
        scope.querySelectorAll('[data-rx-tab]').forEach(item => item.classList.toggle('active', item === button));
        scope.querySelectorAll('[data-rx-panel]').forEach(panel => {
          panel.classList.toggle('hidden', panel.dataset.rxPanel !== tab);
          panel.classList.toggle('active', panel.dataset.rxPanel === tab);
        });
        if (tab === 'new' && toggle?.dataset.rxClientId) {
          await this.markClientPrescriptionNotificationsRead(toggle.dataset.rxClientId);
        }
      });
    });
  },

  async markClientPrescriptionNotificationsRead(clientId) {
    if (DB.profile?.role !== 'store' || !clientId) return;
    const hasUnread = DB.prescriptionNotifications.some(item => item.client_id === clientId && !item.read_at);
    if (!hasUnread) return;

    try {
      await DB.markPrescriptionNotificationsReadForClient(clientId);
      this.render();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  bindPrescriptionInputs(scope) {
    const toolbar = scope.querySelector('[data-rx-sign-toolbar]');
    const signedFields = new Set(['spherical', 'cylindrical']);
    let activeInput = null;
    const showToolbarFor = input => {
      activeInput = input;
      const shouldShow = Boolean(toolbar && input && !input.disabled && signedFields.has(input.dataset.rxField));
      toolbar?.classList.toggle('hidden', !shouldShow);
    };
    const applySign = (input, sign) => {
      if (!input || input.disabled) return;
      const value = input.value.trim();
      input.value = value ? `${sign}${value.replace(/^[+-]/, '')}` : sign;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    };

    scope.querySelectorAll('.rx-input').forEach(input => {
      input.addEventListener('focus', () => showToolbarFor(input));
      input.addEventListener('click', () => showToolbarFor(input));
      input.addEventListener('beforeinput', event => {
        if (!signedFields.has(input.dataset.rxField) || event.data !== ',') return;
        event.preventDefault();
        applySign(input, '-');
      });
      input.addEventListener('keydown', event => {
        const key = event.key.toLowerCase();
        if (signedFields.has(input.dataset.rxField) && key === ',') {
          event.preventDefault();
          applySign(input, '-');
          return;
        }
        if (!['p', '=', 'n'].includes(key)) return;
        event.preventDefault();
        const sign = key === 'n' ? '-' : '+';
        applySign(input, sign);
      });
      input.addEventListener('input', event => {
        const forcedSign = signedFields.has(input.dataset.rxField) && event.data === ',' ? '-' : '';
        input.value = formatPrescriptionInput(input.value, input.dataset.rxField, forcedSign, event.inputType);
      });
    });

    toolbar?.querySelectorAll('[data-rx-sign]').forEach(button => {
      button.addEventListener('pointerdown', event => event.preventDefault());
      button.addEventListener('click', () => applySign(activeInput, button.dataset.rxSign));
    });
    scope.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!scope.querySelector('.rx-input:focus')) toolbar?.classList.add('hidden');
      }, 0);
    });
  },

  closeModal() {
    document.getElementById('modal')?.remove();
  },

  toggleTheme() {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    if (isLight) {
      html.removeAttribute('data-theme');
      localStorage.setItem('otica_theme', 'dark');
      document.getElementById('btn-theme').innerHTML = '<i class="fas fa-sun"></i>';
    } else {
      html.setAttribute('data-theme', 'light');
      localStorage.removeItem('otica_theme');
      document.getElementById('btn-theme').innerHTML = '<i class="fas fa-moon"></i>';
    }
  },

  emptyState(icon, title, text) {
    return `<div class="empty-state"><i class="fas ${icon}"></i><h3>${title}</h3><p>${text}</p></div>`;
  },

  toast(message, type = 'info') {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    const icon = type === 'success' ? 'check' : type === 'error' ? 'exclamation-triangle' : 'info-circle';
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas fa-${icon}"></i><span>${esc(message)}</span><button class="toast-close" type="button" title="Fechar"><i class="fas fa-xmark"></i></button>`;
    wrap.appendChild(el);
    el.querySelector('.toast-close').addEventListener('click', () => el.remove());
    setTimeout(() => el.remove(), 3500);
  },

  toastAppointmentCancelled(appointment) {
    const rawDate = appointment.date || appointment.appointment_date;
    const rawTime = appointment.time || appointment.appointment_time;
    const date = rawDate ? this.fmtDateDisplay(parseLocalDate(rawDate)) : '';
    const time = rawTime ? normalizeTime(rawTime) : '';
    const name = appointment.client_name || 'Cliente';
    this.toast(`Agendamento cancelado: ${name}${date ? ` - ${date}` : ''}${time ? ` as ${time}` : ''}`, 'warning');
  },

  fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  fmtDateDisplay(d) {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  },

  fmtDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return `${this.fmtDateDisplay(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  },

  fmtPhone(phone) {
    const p = onlyDigits(phone);
    if (p.length === 11) return `(${p.slice(0, 2)}) ${p.slice(2, 7)}-${p.slice(7)}`;
    if (p.length === 10) return `(${p.slice(0, 2)}) ${p.slice(2, 6)}-${p.slice(6)}`;
    return phone || '';
  },
};

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeNick(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function nickToAuthEmail(nick) {
  return `${normalizeNick(nick)}@agenda.local`;
}

function normalizeTime(value) {
  return String(value || '').slice(0, 5);
}

function emptyUuid() {
  return '00000000-0000-0000-0000-000000000000';
}

function parseMinutes(value) {
  const [h, m] = normalizeTime(value).split(':').map(Number);
  return h * 60 + m;
}

function formatMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timesForStore() {
  return getTimesForDate(App.selDate);
}

function getTimesForDate(date) {
  if (isFriday(date)) return FRIDAY_TIMES;
  if (isSaturday(date)) return SATURDAY_TIMES;
  if (isSunday(date)) return [];
  return WEEKDAY_TIMES;
}

function isFriday(date) {
  return date.getDay() === 5;
}

function isSaturday(date) {
  return date.getDay() === 6;
}

function isSunday(date) {
  return date.getDay() === 0;
}

function nextOpenDate(date) {
  const out = new Date(date);
  do {
    out.setDate(out.getDate() + 1);
  } while (isSunday(out));
  return out;
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function parseLocalDate(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function endOfDay(date) {
  const out = new Date(date);
  out.setHours(23, 59, 59, 999);
  return out;
}

function startOfWeekMonday(date) {
  const out = new Date(date);
  const day = out.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + offset);
  out.setHours(0, 0, 0, 0);
  return out;
}

function emptyPrescription() {
  const row = () => ({ spherical: '', cylindrical: '', axis: '', dnp: '', height: '' });
  return {
    addition: '',
    far: { od: row(), oe: row() },
    near: { od: row(), oe: row() },
  };
}

function parsePrescription(value) {
  const base = emptyPrescription();
  if (!value) return base;

  try {
    const parsed = JSON.parse(value);
    base.addition = parsed?.addition || parsed?.near?.od?.addition || parsed?.near?.oe?.addition || '';
    ['far', 'near'].forEach(distance => {
      ['od', 'oe'].forEach(eye => {
        Object.keys(base[distance][eye]).forEach(field => {
          base[distance][eye][field] = parsed?.[distance]?.[eye]?.[field] || '';
        });
      });
    });
  } catch (_err) {
    return base;
  }

  return base;
}

function isPrescriptionEmpty(prescription) {
  return !String(prescription?.addition || '').trim() && ['far', 'near'].every(distance => {
    return ['od', 'oe'].every(eye => {
      return Object.values(prescription[distance][eye]).every(value => !String(value || '').trim());
    });
  });
}

function serializePrescription(prescription) {
  if (isPrescriptionEmpty(prescription)) return '';
  return JSON.stringify(prescription);
}

function formatPrescriptionInput(value, field, forcedSign = '', inputType = '') {
  const raw = String(value || '');

  if (field === 'axis') {
    const digits = raw.replace(/\D/g, '');
    const nextDigits = inputType.startsWith('delete') && !raw.includes('\u00B0') ? digits.slice(0, -1) : digits;
    return nextDigits ? `${nextDigits}\u00B0` : '';
  }

  if (field === 'dnp') {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length <= 2) return digits;
    return `${digits.slice(0, 2)},${digits.slice(2)}`;
  }

  const clean = raw.replace(/[^0-9+\-.,/ ]/g, '');
  if (!['spherical', 'cylindrical', 'addition'].includes(field)) return clean;

  const trimmed = clean.trim();
  if (!trimmed) return '';

  const hasExplicitSign = /^[+\-,]/.test(trimmed);
  const sign = field === 'addition' ? '+' : forcedSign === '-' || trimmed.startsWith('-') || trimmed.startsWith(',') ? '-' : '+';
  const digits = clean.replace(/\D/g, '');
  if (!digits) return hasExplicitSign || forcedSign ? sign : '';
  if (digits.length <= 2) return `${sign}${digits}`;

  const integer = String(Number(digits.slice(0, -2)));
  const cents = digits.slice(-2);
  return `${sign}${integer},${cents}`;
}

function isMissingRpcError(error) {
  const message = String(error?.message || '');
  return error?.code === 'PGRST202'
    || message.includes('Could not find the function public.admin_update_store')
    || message.includes('schema cache');
}

function isMissingTableError(error) {
  const message = String(error?.message || '');
  return error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('Could not find the table')
    || message.includes('relation "public.prescription_notifications" does not exist')
    || message.includes('relation "public.appointment_notifications" does not exist');
}

function labelStatus(value) {
  const labels = { scheduled: 'Agendado', done: 'Atendido', cancelled: 'Cancelado' };
  return labels[value] || value;
}

document.addEventListener('DOMContentLoaded', () => App.boot());
