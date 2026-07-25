import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const isolationSql = await readFile(
  new URL('../supabase_fix_prescription_client_isolation.sql', import.meta.url),
  'utf8',
);
const appointmentPhoneGuardSql = await readFile(
  new URL('../supabase_block_duplicate_appointment_phone.sql', import.meta.url),
  'utf8',
);

function loadApp() {
  const context = vm.createContext({
    clearInterval,
    clearTimeout,
    console,
    Date,
    document: {
      addEventListener() {},
    },
    localStorage: {
      getItem() { return null; },
      removeItem() {},
      setItem() {},
    },
    setInterval,
    setTimeout,
    supabaseClient: null,
  });

  vm.runInContext(`${appSource}\nglobalThis.__testExports = { DB };`, context);
  return context.__testExports.DB;
}

test('agendamento com client_id contaminado resolve pelo telefone correto', () => {
  const DB = loadApp();
  DB.clients = [
    { id: 'cliente-errado', store_id: 'loja-1', name: 'Pessoa A', phone: '11911111111' },
    { id: 'cliente-certo', store_id: 'loja-1', name: 'Pessoa B', phone: '(11) 92222-2222' },
  ];

  const resolved = DB.getAppointmentClient({
    client_id: 'cliente-errado',
    store_id: 'loja-1',
    client_name: 'Pessoa B',
    client_phone: '11922222222',
  });

  assert.equal(resolved?.id, 'cliente-certo');
});

test('vinculo ambiguo e bloqueado em vez de escolher qualquer pessoa', () => {
  const DB = loadApp();
  DB.clients = [
    { id: 'cliente-1', store_id: 'loja-1', phone: '11933333333' },
    { id: 'cliente-2', store_id: 'loja-1', phone: '11933333333' },
  ];

  const resolved = DB.getAppointmentClient({
    client_id: 'cliente-inexistente',
    store_id: 'loja-1',
    client_phone: '11933333333',
  });

  assert.equal(resolved, null);
});

test('novo agendamento bloqueia telefone que pertence a outra pessoa', async () => {
  const DB = loadApp();
  DB.clients = [{
    id: 'cliente-1',
    store_id: 'loja-1',
    name: 'Pessoa A',
    phone: '(11) 91111-1111',
  }];
  DB.appointments = [];

  const conflict = DB.findAppointmentPhoneConflict({
    store_id: 'loja-1',
    client_name: 'Pessoa B',
    client_phone: '11911111111',
  });

  assert.equal(conflict?.type, 'client');
  assert.equal(conflict?.name, 'Pessoa A');
  await assert.rejects(
    DB.saveAppointment({
      store_id: 'loja-1',
      client_name: 'Pessoa B',
      client_phone: '11911111111',
      date: '2026-07-21',
      time: '08:00',
    }),
    /Este telefone já está vinculado a Pessoa A/,
  );
});

test('mesma pessoa pode usar novamente o proprio telefone', () => {
  const DB = loadApp();
  DB.clients = [{
    id: 'cliente-1',
    store_id: 'loja-1',
    name: 'João da Silva',
    phone: '11922222222',
  }];
  DB.appointments = [{
    id: 'agendamento-antigo',
    client_id: 'cliente-1',
    store_id: 'loja-1',
    client_name: 'João da Silva',
    client_phone: '11922222222',
  }];

  const conflict = DB.findAppointmentPhoneConflict({
    store_id: 'loja-1',
    client_name: '  JOAO   DA SILVA ',
    client_phone: '(11) 92222-2222',
  });

  assert.equal(conflict, null);
});

test('edicao nao permite trocar a pessoa mantendo o mesmo telefone', () => {
  const DB = loadApp();
  DB.clients = [{
    id: 'cliente-1',
    store_id: 'loja-1',
    name: 'Pessoa Original',
    phone: '11933333333',
  }];
  DB.appointments = [{
    id: 'agendamento-1',
    client_id: 'cliente-1',
    store_id: 'loja-1',
    client_name: 'Pessoa Original',
    client_phone: '11933333333',
  }];

  const conflict = DB.findAppointmentPhoneConflict({
    id: 'agendamento-1',
    client_id: 'cliente-1',
    store_id: 'loja-1',
    client_name: 'Outra Pessoa',
    client_phone: '11933333333',
  }, 'agendamento-1');

  assert.equal(conflict?.type, 'client');
  assert.equal(conflict?.name, 'Pessoa Original');
});

test('telefone igual em outra loja nao mistura os cadastros', () => {
  const DB = loadApp();
  DB.clients = [{
    id: 'cliente-loja-1',
    store_id: 'loja-1',
    name: 'Pessoa A',
    phone: '11944444444',
  }];
  DB.appointments = [];

  const conflict = DB.findAppointmentPhoneConflict({
    store_id: 'loja-2',
    client_name: 'Pessoa B',
    client_phone: '11944444444',
  });

  assert.equal(conflict, null);
});

test('update de cliente exige id e loja do paciente alvo', async () => {
  const DB = loadApp();
  const filters = [];
  let directUpdatePayload;
  const rpcCalls = [];
  const target = {
    id: 'cliente-alvo',
    store_id: 'loja-1',
    name: 'Pessoa Alvo',
    phone: '11944444444',
    new_prescription: null,
  };

  const query = {
    update(payload) {
      directUpdatePayload = payload;
      return this;
    },
    eq(column, value) {
      filters.push([column, value]);
      return this;
    },
    select() { return this; },
    async single() {
      return { data: target, error: null };
    },
  };

  DB.client = {
    from(table) {
      assert.equal(table, 'clients');
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, 'save_client_prescriptions');
      rpcCalls.push(args);
      return {
        data: { ...target, new_prescription: args.p_new_prescription },
        error: null,
      };
    },
  };
  DB.clients = [
    target,
    { id: 'outro-cliente', store_id: 'loja-1', name: 'Outra Pessoa', phone: '11955555555' },
  ];
  DB.profile = { role: 'optometrist' };
  DB.user = { id: 'optometrista-1' };
  DB.notifyPrescriptionChange = async () => {};
  DB.refresh = async () => {};

  await DB.saveClient({
    id: target.id,
    store_id: target.store_id,
    name: target.name,
    phone: target.phone,
    new_prescription: '{"addition":"+2,00"}',
  });

  assert.deepEqual(filters, [
    ['id', 'cliente-alvo'],
    ['store_id', 'loja-1'],
  ]);
  assert.equal(directUpdatePayload.new_prescription, undefined);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].p_client_id, 'cliente-alvo');
  assert.equal(rpcCalls[0].p_new_prescription, '{"addition":"+2,00"}');
});

test('salvamento e interrompido quando agendamento nao identifica um unico cliente', async () => {
  const DB = loadApp();
  DB.appointments = [{
    id: 'agendamento-1',
    client_id: 'cliente-errado',
    store_id: 'loja-1',
    client_name: 'Pessoa B',
    client_phone: '11966666666',
  }];
  DB.clients = [{
    id: 'cliente-errado',
    store_id: 'loja-1',
    name: 'Pessoa A',
    phone: '11977777777',
  }];

  await assert.rejects(
    DB.saveAppointment({
      id: 'agendamento-1',
      client_id: null,
      store_id: 'loja-1',
      client_name: 'Pessoa B',
      client_phone: '11966666666',
      date: '2026-07-20',
      time: '09:00',
      status: 'scheduled',
    }),
    /Vinculo do cliente inconsistente/,
  );
});

test('duas receitas sequenciais sao enviadas pelo respectivo agendamento', async () => {
  const DB = loadApp();
  const rpcCalls = [];
  DB.clients = [
    { id: 'cliente-1', store_id: 'loja-1', name: 'Pessoa 1', phone: '11911111111', new_prescription: null },
    { id: 'cliente-2', store_id: 'loja-1', name: 'Pessoa 2', phone: '11922222222', new_prescription: null },
  ];
  DB.appointments = [
    { id: 'agendamento-1', client_id: 'cliente-1', store_id: 'loja-1', client_phone: '11911111111' },
    { id: 'agendamento-2', client_id: 'cliente-2', store_id: 'loja-1', client_phone: '11922222222' },
  ];
  DB.profile = { role: 'optometrist' };
  DB.user = { id: 'optometrista-1' };
  DB.client = {
    async rpc(name, args) {
      assert.equal(name, 'save_appointment_prescriptions');
      rpcCalls.push(args);
      const clientId = args.p_appointment_id === 'agendamento-1' ? 'cliente-1' : 'cliente-2';
      return {
        data: {
          ...DB.clients.find(client => client.id === clientId),
          new_prescription: args.p_new_prescription,
        },
        error: null,
      };
    },
  };
  DB.notifyPrescriptionChange = async () => {};
  DB.refresh = async () => {};

  await DB.saveAppointmentPrescriptions('agendamento-1', {
    new_prescription: '{"addition":"+1,00"}',
  });
  await DB.saveAppointmentPrescriptions('agendamento-2', {
    new_prescription: '{"addition":"+2,00"}',
  });

  assert.deepEqual(
    rpcCalls.map(call => [call.p_appointment_id, call.p_new_prescription]),
    [
      ['agendamento-1', '{"addition":"+1,00"}'],
      ['agendamento-2', '{"addition":"+2,00"}'],
    ],
  );
});

test('edicao de agendamento nao grava receita pelo update generico de cliente', async () => {
  const DB = loadApp();
  const clientPayloads = [];
  const prescriptionPayloads = [];
  const client = {
    id: 'cliente-1',
    store_id: 'loja-1',
    name: 'Pessoa 1',
    phone: '11911111111',
  };
  DB.clients = [client];
  DB.appointments = [{
    id: 'agendamento-1',
    client_id: client.id,
    store_id: client.store_id,
    client_name: client.name,
    client_phone: client.phone,
    date: '2026-07-20',
    time: '09:00',
  }];
  DB.user = { id: 'optometrista-1' };
  DB.saveClient = async payload => {
    clientPayloads.push(payload);
    return client;
  };
  DB.saveAppointmentPrescriptions = async (appointmentId, payload) => {
    prescriptionPayloads.push([appointmentId, payload]);
  };
  DB.refresh = async () => {};
  DB.client = {
    from(table) {
      assert.equal(table, 'appointments');
      return {
        update() { return this; },
        eq() { return this; },
        select() { return this; },
        async single() {
          return { data: { id: 'agendamento-1' }, error: null };
        },
      };
    },
  };

  await DB.saveAppointment({
    id: 'agendamento-1',
    client_id: client.id,
    store_id: client.store_id,
    client_name: client.name,
    client_phone: client.phone,
    client_new_prescription: '{"addition":"+3,00"}',
    date: '2026-07-20',
    time: '09:00',
    status: 'scheduled',
  });

  assert.equal(clientPayloads[0].new_prescription, undefined);
  assert.equal(prescriptionPayloads.length, 1);
  assert.equal(prescriptionPayloads[0][0], 'agendamento-1');
  assert.equal(prescriptionPayloads[0][1].current_prescription, undefined);
  assert.equal(prescriptionPayloads[0][1].new_prescription, '{"addition":"+3,00"}');
});

test('SQL bloqueia escrita direta, telefone duplicado e registra auditoria', () => {
  assert.match(isolationSql, /Alteracao direta de receita bloqueada por seguranca/);
  assert.match(isolationSql, /create trigger enforce_unique_client_phone/);
  assert.match(isolationSql, /create table if not exists public\.prescription_change_audit/);
  assert.match(isolationSql, /create trigger audit_client_prescription_change/);
  assert.match(isolationSql, /set_config\('app\.prescription_write_guard', 'allowed', true\)/);
});

test('SQL reforca no banco o dono do telefone do agendamento', () => {
  assert.match(appointmentPhoneGuardSql, /create trigger enforce_appointment_phone_owner/);
  assert.match(appointmentPhoneGuardSql, /create trigger enforce_unique_client_phone/);
  assert.match(appointmentPhoneGuardSql, /clients_store_phone_digits_unique/);
  assert.match(appointmentPhoneGuardSql, /normalize_person_name/);
  assert.match(appointmentPhoneGuardSql, /Este telefone ja esta vinculado a/);
});
