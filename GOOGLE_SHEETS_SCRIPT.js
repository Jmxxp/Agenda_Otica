/**
 * =============================================
 *  SISTEMA ÓTICA - GOOGLE APPS SCRIPT v2
 * =============================================
 * 
 *  COMO USAR:
 *  1. Crie uma planilha no Google Sheets
 *  2. Extensões > Apps Script
 *  3. Apague tudo e cole ESTE código
 *  4. Salve (Ctrl+S)
 *  5. Implantar > Nova implantação
 *     - Tipo: App da Web
 *     - Executar como: Eu
 *     - Acesso: Qualquer pessoa
 *  6. Copie a URL e cole no sistema
 */

const SHEET = 'Agendamentos';
const COLS  = ['ID','Data','Hora','Cliente','Telefone','Loja','LojaID','Obs','Criado'];

function boot() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.getRange(1,1,1,COLS.length).setValues([COLS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ── HTTP handlers ── */

function doGet(e) {
  return reply(route(e.parameter.action || 'ping', null));
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  return reply(route(body.action || e.parameter.action, body));
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function route(action, body) {
  try {
    switch (action) {
      case 'ping':   boot(); return {ok:true, msg:'Conectado!'};
      case 'list':   return list();
      case 'create': return create(body);
      case 'update': return update(body);
      case 'delete': return remove(body.id);
      case 'clear':  return clear();
      default:       return {ok:false, err:'Ação desconhecida: '+action};
    }
  } catch(e) {
    return {ok:false, err:e.toString()};
  }
}

/* ── CRUD ── */

function list() {
  var sh = boot();
  var last = sh.getLastRow();
  if (last <= 1) return {ok:true, data:[]};

  var rows = sh.getRange(2,1,last-1,COLS.length).getValues();
  var out = [];
  for (var i=0; i<rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    out.push({
      id:       r[0],
      date:     fmtDate(r[1]),
      time:     fmtTime(r[2]),
      client:   String(r[3]||''),
      phone:    String(r[4]||''),
      store:    String(r[5]||''),
      storeId:  parseInt(r[6])||1,
      notes:    String(r[7]||''),
      created:  String(r[8]||'')
    });
  }
  return {ok:true, data:out};
}

function create(d) {
  if (!d) return {ok:false, err:'Sem dados'};
  var sh = boot();
  var id = d.id || Date.now();
  sh.appendRow([
    id,
    d.date||'',
    d.time||'',
    d.client||'',
    d.phone||'',
    d.store||'',
    d.storeId||1,
    d.notes||'',
    d.created || new Date().toISOString()
  ]);
  return {ok:true, id:id};
}

function update(d) {
  if (!d||!d.id) return {ok:false, err:'ID obrigatório'};
  var sh = boot();
  var last = sh.getLastRow();
  if (last<=1) return {ok:false, err:'Vazio'};
  var ids = sh.getRange(2,1,last-1,1).getValues();
  for (var i=0;i<ids.length;i++) {
    if (String(ids[i][0])===String(d.id)) {
      var row = i+2;
      sh.getRange(row,1,1,COLS.length).setValues([[
        d.id, d.date||'', d.time||'', d.client||'',
        d.phone||'', d.store||'', d.storeId||1,
        d.notes||'', d.created||''
      ]]);
      return {ok:true};
    }
  }
  return {ok:false, err:'Não encontrado'};
}

function remove(id) {
  if (!id) return {ok:false, err:'ID obrigatório'};
  var sh = boot();
  var last = sh.getLastRow();
  if (last<=1) return {ok:false, err:'Vazio'};
  var ids = sh.getRange(2,1,last-1,1).getValues();
  for (var i=0;i<ids.length;i++) {
    if (String(ids[i][0])===String(id)) {
      sh.deleteRow(i+2);
      return {ok:true};
    }
  }
  return {ok:false, err:'Não encontrado'};
}

function clear() {
  var sh = boot();
  var last = sh.getLastRow();
  if (last>1) sh.deleteRows(2, last-1);
  return {ok:true};
}

/* ── Helpers ── */

function fmtDate(v) {
  if (!v) return '';
  if (typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (v instanceof Date) {
    return v.getFullYear()+'-'+pad(v.getMonth()+1)+'-'+pad(v.getDate());
  }
  try { var d=new Date(v); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  catch(e) { return String(v); }
}

function fmtTime(v) {
  if (!v) return '';
  if (typeof v==='string' && /^\d{2}:\d{2}$/.test(v)) return v;
  if (v instanceof Date) return pad(v.getHours())+':'+pad(v.getMinutes());
  var m = String(v).match(/(\d{1,2}):(\d{2})/);
  if (m) return pad(parseInt(m[1]))+':'+m[2];
  return String(v);
}

function pad(n) { return n<10?'0'+n:''+n; }
