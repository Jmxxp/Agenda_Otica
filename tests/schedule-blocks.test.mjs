import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const day = '2026-10-27';

function loadApp(role = 'admin') {
  const context = vm.createContext({
    clearInterval, clearTimeout, console, Date, setInterval, setTimeout,
    document: { addEventListener() {} },
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    supabaseClient: null,
  });
  vm.runInContext(`${appSource}\nglobalThis.__testExports = { DB, App };`, context);
  const { DB, App } = context.__testExports;
  DB.user = { id: 'user-1' };
  DB.profile = { role, store_id: role === 'store' ? 'loja-1' : null };
  DB.stores = [{ id: 'loja-1', name: 'Centro' }, { id: 'loja-2', name: 'Jardins' }];
  DB.scheduleBlocksAvailable = true;
  DB.scheduleBlocks = [];
  return { DB, App };
}

function block(overrides = {}) {
  return { id: 'block-1', store_id: 'loja-1', start_date: day, end_date: '2026-10-29', reason: 'Férias', ...overrides };
}

function appointmentFixture(DB) {
  const client = { id: 'client-1', store_id: 'loja-1', name: 'Maria Silva', phone: '11911111111' };
  const appointment = {
    id: 'appointment-1', client_id: client.id, store_id: client.store_id,
    client_name: client.name, client_phone: client.phone, date: day, time: '09:00', status: 'scheduled',
  };
  DB.clients = [client];
  DB.appointments = [appointment];
  return { client, appointment };
}

test('bloqueio inclui as datas inicial e final sem atingir outra loja', () => {
  const { DB } = loadApp();
  DB.scheduleBlocks = [block()];
  assert.equal(DB.getScheduleBlocks('2026-10-26', 'loja-1').length, 0);
  assert.equal(DB.getScheduleBlocks(day, 'loja-1').length, 1);
  assert.equal(DB.getScheduleBlocks('2026-10-29', 'loja-1').length, 1);
  assert.equal(DB.getScheduleBlocks('2026-10-30', 'loja-1').length, 0);
  assert.equal(DB.getScheduleBlocks(day, 'loja-2').length, 0);
});

test('bloqueio global e bloqueio específico continuam independentes quando sobrepostos', () => {
  const { DB } = loadApp();
  DB.scheduleBlocks = [block(), block({ id: 'global-1', store_id: null })];
  assert.equal(DB.getScheduleBlocks(day, 'loja-1').length, 2);
  assert.equal(DB.getScheduleBlocks(day, 'loja-2').length, 1);
});

test('loja só pode gerenciar bloqueios da própria agenda', () => {
  const { DB } = loadApp('store');
  assert.equal(DB.canManageScheduleBlock(block({ created_by: 'outro-admin' })), true);
  assert.equal(DB.canManageScheduleBlock(block({ store_id: 'loja-2' })), false);
  assert.equal(DB.canManageScheduleBlock(block({ store_id: null })), false);
  for (const role of ['admin', 'optometrist']) {
    DB.profile = { role };
    assert.equal(DB.canManageScheduleBlock(block()), true);
    assert.equal(DB.canManageScheduleBlock(block({ store_id: null })), true);
  }
});

test('admin e optometrista podem agendar em lojas que permanecem abertas', () => {
  const { DB, App } = loadApp();
  DB.scheduleBlocks = [block()];
  for (const role of ['admin', 'optometrist']) {
    DB.profile = { role };
    assert.deepEqual(Array.from(App.getSchedulableStores(day), store => store.id), ['loja-2']);
  }
  DB.profile = { role: 'store', store_id: 'loja-1' };
  assert.equal(App.getSchedulableStores(day).length, 0);
  DB.profile = { role: 'store', store_id: 'loja-2' };
  assert.deepEqual(Array.from(App.getSchedulableStores(day), store => store.id), ['loja-2']);
});

test('horários livres desaparecem para loja bloqueada e permanecem nas demais', () => {
  const { DB, App } = loadApp();
  DB.scheduleBlocks = [block()];
  assert.equal(App.getAvailableAppointmentTimes(day, null, 'loja-1').length, 0);
  assert.ok(App.getAvailableAppointmentTimes(day, null, 'loja-2').includes('09:00'));
  DB.scheduleBlocks.push(block({ id: 'global-1', store_id: null }));
  assert.equal(App.getAvailableAppointmentTimes(day, null, 'loja-2').length, 0);
});

test('edição preserva apenas o horário do atendimento existente no dia bloqueado', () => {
  const { DB, App } = loadApp();
  appointmentFixture(DB);
  DB.scheduleBlocks = [block()];
  assert.deepEqual(Array.from(App.getAvailableAppointmentTimes(day, 'appointment-1', 'loja-1')), ['09:00']);
  assert.equal(App.getAvailableAppointmentTimes('2026-10-28', 'appointment-1', 'loja-1').length, 0);
});

test('novo atendimento bloqueado é recusado antes de salvar o cadastro do cliente', async () => {
  const { DB } = loadApp();
  DB.scheduleBlocks = [block()];
  let writes = 0;
  DB.saveClient = async () => { writes++; throw new Error('Não deve salvar cliente'); };
  await assert.rejects(DB.saveAppointment({
    store_id: 'loja-1', client_name: 'Maria', client_phone: '11911111111', date: day, time: '09:00',
  }), /bloquead/i);
  assert.equal(writes, 0);
});

test('remarcação em período bloqueado é recusada antes de qualquer escrita', async () => {
  const { DB } = loadApp();
  const { appointment } = appointmentFixture(DB);
  DB.scheduleBlocks = [block()];
  let writes = 0;
  DB.saveClient = async () => { writes++; throw new Error('Não deve salvar cliente'); };
  await assert.rejects(DB.saveAppointment({ ...appointment, time: '09:30' }), /bloquead/i);
  await assert.rejects(DB.saveAppointment({ ...appointment, date: '2026-10-28' }), /bloquead/i);
  assert.equal(writes, 0);
});

test('receita e status de atendimento existente continuam editáveis em período bloqueado', async () => {
  const { DB } = loadApp('optometrist');
  const { client, appointment } = appointmentFixture(DB);
  DB.scheduleBlocks = [block()];
  let writtenStatus;
  const prescriptions = [];
  DB.saveClient = async () => client;
  DB.saveAppointmentPrescriptions = async (id, payload) => { prescriptions.push({ id, payload }); };
  DB.refresh = async () => {};
  DB.client = { from(table) {
    assert.equal(table, 'appointments');
    return {
      update(payload) { writtenStatus = payload.status; return this; },
      eq() { return this; }, select() { return this; },
      async single() { return { data: appointment, error: null }; },
    };
  } };
  await DB.saveAppointment({ ...appointment, status: 'done', client_new_prescription: '{"addition":"+2,00"}' });
  assert.equal(writtenStatus, 'done');
  assert.equal(prescriptions[0].id, appointment.id);
  assert.equal(prescriptions[0].payload.new_prescription, '{"addition":"+2,00"}');
});

test('loja não consegue criar bloqueio global nem de outra loja', async () => {
  const { DB } = loadApp('store');
  let writes = 0;
  DB.client = { from() { writes++; throw new Error('Não deve acessar o banco'); } };
  await assert.rejects(DB.saveScheduleBlock({ ...block(), store_id: null }));
  await assert.rejects(DB.saveScheduleBlock({ ...block(), store_id: 'loja-2' }));
  assert.equal(writes, 0);
});

test('intervalo invertido ou datas inválidas não chegam ao banco', async () => {
  const { DB } = loadApp();
  let writes = 0;
  DB.client = { from() { writes++; throw new Error('Não deve acessar o banco'); } };
  await assert.rejects(DB.saveScheduleBlock({ ...block(), end_date: '2026-10-26' }));
  await assert.rejects(DB.saveScheduleBlock({ ...block(), start_date: '2026-02-30' }));
  await assert.rejects(DB.saveScheduleBlock({ ...block(), start_date: '' }));
  assert.equal(writes, 0);
});

test('desbloquear remove só o intervalo escolhido e mantém bloqueios sobrepostos', async () => {
  const { DB } = loadApp();
  DB.scheduleBlocks = [block(), block({ id: 'global-1', store_id: null })];
  DB.refresh = async () => {};
  DB.client = { from(table) {
    assert.equal(table, 'schedule_blocks');
    return {
      delete() { return this; },
      eq(column, id) {
        assert.equal(column, 'id');
        assert.equal(id, 'block-1');
        DB.scheduleBlocks = DB.scheduleBlocks.filter(item => item.id !== id);
        return this;
      },
      async select() { return { data: [{ id: 'block-1' }], error: null }; },
    };
  } };
  await DB.removeScheduleBlock('block-1');
  assert.equal(DB.getScheduleBlocks(day, 'loja-1').length, 1);
  assert.equal(DB.getScheduleBlocks(day, 'loja-2').length, 1);
  assert.equal(DB.scheduleBlocks[0].id, 'global-1');
});

test('bloqueio de um único dia é salvo com o usuário autenticado e motivo limpo', async () => {
  const { DB } = loadApp('store');
  let inserted;
  DB.client = { from(table) {
    assert.equal(table, 'schedule_blocks');
    return {
      insert(payload) { inserted = payload; return this; },
      select() { return this; },
      async single() { return { data: { id: 'novo-bloco', ...inserted }, error: null }; },
    };
  } };
  const result = await DB.saveScheduleBlock({
    store_id: 'loja-1', start_date: day, end_date: day, reason: '  Manutenção  ', created_by: 'intruso',
  });
  assert.equal(result.id, 'novo-bloco');
  assert.equal(inserted.start_date, inserted.end_date);
  assert.equal(inserted.reason, 'Manutenção');
  assert.equal(inserted.created_by, DB.user.id);
  assert.equal(DB.getScheduleBlocks(day, 'loja-1').length, 1);
});

test('recurso indisponível informa erro em vez de simular bloqueio local', async () => {
  const { DB } = loadApp();
  DB.scheduleBlocksAvailable = false;
  let writes = 0;
  DB.client = { from() { writes++; throw new Error('Não deve acessar o banco'); } };
  await assert.rejects(DB.saveScheduleBlock(block()), /ativad|dispon|configur/i);
  assert.equal(DB.scheduleBlocks.length, 0);
  assert.equal(writes, 0);
});

test('ausência da tabela de bloqueios não impede carregar a agenda existente', async () => {
  const { DB } = loadApp();
  DB.client = { from(table) {
    assert.equal(table, 'schedule_blocks');
    return { select() { return this; }, order() { return this; }, async range() { return { data: null, error: { code: 'PGRST205', message: 'Could not find the table schedule_blocks' } }; } };
  } };
  assert.deepEqual(Array.from(await DB.loadScheduleBlocks()), []);
  assert.equal(DB.scheduleBlocksAvailable, false);
});

test('carregamento completo preserva bloqueios além da primeira página', async () => {
  const { DB } = loadApp();
  const blocks = Array.from({ length: 501 }, (_, index) => block({ id: `bloco-${String(index).padStart(4, '0')}` }));
  const pages = [];
  DB.client = { from(table) {
    assert.equal(table, 'schedule_blocks');
    return {
      select() { return this; }, order() { return this; },
      async range(start, end) {
        pages.push([start, end]);
        return { data: blocks.slice(start, end + 1), error: null };
      },
    };
  } };
  const result = await DB.loadScheduleBlocks();
  assert.equal(result.length, 501);
  assert.equal(result[0].id, 'bloco-0000');
  assert.equal(result[500].id, 'bloco-0500');
  assert.equal(new Set(result.map(item => item.id)).size, 501);
  assert.equal(pages.length, 2);
  assert.equal(DB.scheduleBlocksAvailable, true);
});

test('reativar atendimento cancelado em dia bloqueado é tratado como nova ocupação', async () => {
  const { DB } = loadApp();
  const { appointment } = appointmentFixture(DB);
  appointment.status = 'cancelled';
  DB.scheduleBlocks = [block()];
  let writes = 0;
  DB.saveClient = async () => { writes++; throw new Error('Não deve salvar cliente'); };
  await assert.rejects(DB.saveAppointment({ ...appointment, status: 'scheduled' }), /bloquead/i);
  assert.equal(writes, 0);
});
