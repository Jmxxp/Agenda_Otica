import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

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

test('update de cliente exige id e loja do paciente alvo', async () => {
  const DB = loadApp();
  const filters = [];
  const target = {
    id: 'cliente-alvo',
    store_id: 'loja-1',
    name: 'Pessoa Alvo',
    phone: '11944444444',
    new_prescription: null,
  };

  const query = {
    update() { return this; },
    eq(column, value) {
      filters.push([column, value]);
      return this;
    },
    select() { return this; },
    async single() {
      return { data: { ...target, new_prescription: '{"addition":"+2,00"}' }, error: null };
    },
  };

  DB.client = {
    from(table) {
      assert.equal(table, 'clients');
      return query;
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
