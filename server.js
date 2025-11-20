// server.js
require('dotenv').config();


const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { uploadPdfToDrive } = require('./drive');
const fetch = require('node-fetch');                // se não existir ainda
function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal })
    .finally(() => clearTimeout(id));
}


// === serviços de bilhete (PDF) ===
const { mapVendaToTicket } = require('./services/ticket/mapper');
const { generateTicketPdf } = require('./services/ticket/pdf');

const app = express();
app.use(express.json({ limit: '2mb' }));
const PUBLIC_DIR  = path.join(__dirname, 'sitevendas');
const TICKETS_DIR = path.join(__dirname, 'tickets');
const PORT = process.env.PORT || 8080;


// === Helpers p/ e-mail e telefone do login ===
function getMail(v) {
  const s = (v ?? '').toString().trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}
function normalizePhoneBR(v) {
  // tira tudo que não for dígito; se tiver DDI/DDD ausente, add "55" só no Sheets
  const d = (v ?? '').toString().replace(/\D+/g, '');
  return d || ''; // ex.: "31999998888"
}

/**
 * Prioriza e-mail do login (mesma regra do e-mail que você envia o PDF),
 * com fallback para o e-mail do comprador (MP ou vendaResult).
 */
function getLoginEmail(req, payment, vendaResult) {
  const fromLogin =
    getMail(req?.user?.email) ||
    getMail(req?.session?.user?.email) ||
    getMail(req?.headers?.['x-user-email']) ||
    getMail(req?.body?.loginEmail || req?.body?.emailLogin || req?.body?.userEmail) ||
    getMail(req?.body?.user?.email);

  if (fromLogin) return fromLogin;

  // Fallback: tenta pegar do MP / venda
  const fromMP =
    getMail(payment?.payer?.email) ||
    getMail(payment?.additional_info?.payer?.email) ||
    getMail(payment?.card?.cardholder?.email);

  if (fromMP) return fromMP;

  const fromVenda =
    getMail(vendaResult?.EmailCliente) ||
    getMail(vendaResult?.emailCliente);

  return fromVenda || null;
}

function getLoginPhone(req, payment, vendaResult) {
  const fromLogin =
    req?.user?.phone || req?.session?.user?.phone ||
    req?.headers?.['x-user-phone'] ||
    req?.body?.loginPhone || req?.body?.userPhone || req?.body?.user?.phone;

  if (fromLogin) return normalizePhoneBR(fromLogin);

  // Fallbacks (quando existir)
  const fromMP =
    payment?.payer?.phone?.number ||
    payment?.additional_info?.payer?.phone?.number;

  if (fromMP) return normalizePhoneBR(fromMP);

  const fromVenda =
    vendaResult?.TelefoneCli || vendaResult?.CelularCli;

  return normalizePhoneBR(fromVenda);
}


// === ID de grupo (idempotência por compra)
function computeGroupId(req, payment, schedule){
  return (
    req?.body?.grupoId ||
    req?.body?.referencia ||
    payment?.external_reference ||
    req?.headers?.['x-idempotency-key'] ||
    // fallback
    [
      schedule?.idViagem,
      schedule?.date || schedule?.dataViagem,
      schedule?.horaPartida,
      (req?.user?.email || req?.headers?.['x-user-email'] || '')
    ].join('|')
  );
}


// Remove bilhetes duplicados (mesmo nº/mesma chave BPe)
function dedupBilhetes(arr = []) {
  const seen = new Set();
  return arr.filter(b => {
    const k = `${b?.numPassagem || ''}|${b?.chaveBPe || ''}`;
    if (!k.trim() || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Remove anexos/arquivos duplicados (mesmo fileId ou mesmo nº/caminho)
function dedupArquivos(arr = []) {
  const seen = new Set();
  return arr.filter(a => {
    const k = `${a?.driveFileId || ''}|${a?.numPassagem || ''}|${a?.pdfLocal || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

 

/* ============================================================================
   Google Sheets (consulta por email) – leitura (mantido)
============================================================================ */
const { google } = require('googleapis');

async function sheetsAuth() {
  const key = JSON.parse(process.env.GDRIVE_SA_KEY || '{}');
  const auth = new google.auth.JWT(
    key.client_email, null, key.private_key,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}



async function sheetsAuthRW() {
  const key = JSON.parse(process.env.GDRIVE_SA_KEY || '{}');
  const auth = new google.auth.JWT(
    key.client_email, null, key.private_key,
    ['https://www.googleapis.com/auth/spreadsheets'] // escopo de escrita
  );
  return google.sheets({ version: 'v4', auth });
}

// === Tempo SP
const nowSP = () => {
  const z = new Date();
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12:false
  }).formatToParts(z).reduce((a,p)=> (a[p.type]=p.value,a),{});
  return `${fmt.day}/${fmt.month}/${fmt.year} ${fmt.hour}:${fmt.minute}:${fmt.second}`;
};


// --- Helpers ---------------------------------------------------------------

function resolveSentido(p, scheduleIda, scheduleVolta, fallback = 'Ida') {
  // 1) valor explícito vindo da Praxio ou do seu objeto de bilhete
  const s = String(p?.Sentido || p?.sentido || '').toLowerCase();
  if (s === 'ida' || s === 'volta') return s[0].toUpperCase() + s.slice(1);

  // 2) tentar inferir por origem/destino
  const po = Number(p?.Idorigem || p?.idOrigem || p?.OrigemId);
  const pd = Number(p?.Iddestino || p?.idDestino || p?.DestinoId);

  const iO = Number(scheduleIda?.originId || scheduleIda?.idOrigem);
  const iD = Number(scheduleIda?.destinationId || scheduleIda?.idDestino);

  const vO = Number(scheduleVolta?.originId || scheduleVolta?.idOrigem);
  const vD = Number(scheduleVolta?.destinationId || scheduleVolta?.idDestino);

  if (po && pd && iO && iD && po === iO && pd === iD) return 'Ida';
  if (po && pd && vO && vD && po === vO && pd === vD) return 'Volta';

  // 3) fallback (ex.: idaVoltaDefault do bundle)
  return (String(fallback).toLowerCase() === 'volta') ? 'Volta' : 'Ida';
}



// === Tempo SP (mantém como está acima)
// const nowSP = ...

// Converte “2025-11-03 10:48” -> “2025-11-03T10:48-03:00”
const toISO3 = (s) => s ? (s.replace(' ', 'T') + '-03:00') : '';


async function sheetsAppendBilhetes({
  spreadsheetId,
  range = 'BPE!A:AG',
  bilhetes,                    // [{ numPassagem, nomeCliente, docCliente, valor, poltrona, driveUrl, origem, destino, idaVolta }]
  schedule,                    // { date, horaPartida, originName/destinationName ... }
  payment,                     // objeto do MP
  userEmail,
  userPhone,
  idaVoltaDefault = ''
}) {
  try {
    const sheets = await sheetsAuthRW();

    const fee  = payment?.fee_details?.[0]?.amount ?? '';
    const net  = payment?.transaction_details?.net_received_amount ?? '';
    const chId = payment?.charges_details?.[0]?.id ?? '';
    const dtAp = payment?.date_approved || null;

    const pagoSP = dtAp
      ? (new Date(dtAp)).toLocaleString('sv-SE', { timeZone:'America/Sao_Paulo', hour12:false }).replace(' ','T') + '-03:00'
      : '';

    const tipo = String(payment?.payment_type_id || '').toLowerCase();   // 'pix'|'credit_card'|'debit_card'
    const forma = tipo === 'pix' ? 'PIX'
                : tipo === 'debit_card' ? 'Cartão de Débito'
                : tipo === 'credit_card' ? 'Cartão de Crédito'
                : '';


    
// Identificação robusta do método
const mpType = String(payment?.payment_type_id   || '').toLowerCase(); // 'pix' | 'credit_card' | 'debit_card' | 'bank_transfer'...
const pmId   = String(payment?.payment_method_id || '').toLowerCase(); // costuma conter 'pix'

// Código para a planilha (você pediu código, não descrição)
const tipoPagamento =
  (pmId.includes('pix') || mpType === 'pix' || mpType === 'bank_transfer') ? '0' : '3';


// garanta que é array de bilhetes válidos
const list = Array.isArray(bilhetes) ? bilhetes.filter(Boolean) : [];

const values = list.map(b => {
  // fonte de data/hora
  const dataViagem  = (b?.dataViagem || schedule?.date || schedule?.dataViagem || '');
  const horaPartida = String(b?.horaPartida || schedule?.horaPartida || schedule?.departureTime || '').slice(0,5);
  const dataHoraViagem = (dataViagem && horaPartida) ? `${dataViagem} ${horaPartida}` : (dataViagem || horaPartida);

  // sentido por bilhete, com fallback do bundle
  const sentido = b?.idaVolta
    ? String(b.idaVolta)
    : (String(idaVoltaDefault).toLowerCase() === 'volta' ? 'Volta' : 'Ida');

  return [
    nowSP(),                                // Data/horaSolicitação
    b.nomeCliente || '',                    // Nome
    (userPhone ? ('55' + userPhone) : ''),  // Telefone (DDI 55)
    (userEmail || ''),                      // E-mail
    b.docCliente || '',                     // CPF
    Number(b.valor ?? 0).toFixed(2),        // Valor
    '2',                                    // ValorConveniencia
    String(fee).toString().replace('.', ','), // ComissaoMP
    String(net).toString().replace('.', ','), // ValorLiquido
    b.numPassagem || '',                    // NumPassagem
    '93',                                   // SeriePassagem
    String(payment?.status || ''),          // StatusPagamento
    'Emitido',                              // Status
    '',                                     // ValorDevolucao
    sentido,                                // Sentido
    pagoSP,                                 // Data/hora_Pagamento
    '',                                     // NomePagador
    '',                                     // CPF_Pagador
    chId,                                   // ID_Transação
    tipoPagamento,                          // TipoPagamento (0=PIX, 3=Cartão)
    '',                                     // correlationID
    '',                                     // idURL
    payment?.external_reference || '',      // Referencia
    forma,                                  // Forma_Pagamento (rótulo)
    '',                                     // idUser
    dataViagem,                             // Data_Viagem
    dataHoraViagem,                         // Data_Hora
    b.origem || schedule?.originName || schedule?.origem || '',         // Origem
    b.destino || schedule?.destinationName || schedule?.destino || '',  // Destino
    '',                                     // Identificador
    payment?.id || '',                      // idPagamento
    b.driveUrl || '',                       // LinkBPE
    b.poltrona || ''                        // Poltrona
  ];
});

    if (!values.length) return { ok:true, appended:0 };

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });

    console.log('[Sheets] append ok:', values.length, 'linhas');
    return { ok:true, appended: values.length };
  } catch (e) {
    console.error('[Sheets] append erro:', e?.message || e);
    return { ok:false, error: e?.message || String(e) };
  }
}


// normaliza texto: minúsculo, sem acento e sem sinais
const norm = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/gi, '').toLowerCase();

app.get('/api/sheets/bpe-by-email', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'email é obrigatório' });

    const sheets = await sheetsAuth();
    const spreadsheetId = process.env.SHEETS_BPE_ID;
    const range = process.env.SHEETS_BPE_RANGE || 'BPE!A:AF';

    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = r.data.values || [];
    if (!rows.length) return res.json({ ok:true, items:[] });

    const headerRaw = rows[0].map(h => (h || '').toString().trim());
    const header = headerRaw.map(norm);

    const idxOf = (...names) => {
      const want = names.map(norm);
      return header.findIndex(h => want.includes(h));
    };
    const get = (row, idx) => (idx >= 0 && row[idx] != null) ? String(row[idx]).trim() : '';

    // índices necessárias
    const idxEmail      = idxOf('email', 'e-mail');
    const idxNum        = idxOf('numpassagem', 'bilhete');
    const idxSerie      = idxOf('seriepassagem');
    const idxStatusPay  = idxOf('statuspagamento');
    const idxStatus     = idxOf('status');
    const idxValor      = idxOf('valor');
    const idxValorConv  = idxOf('valorconveniencia');
    const idxValorDev   = idxOf('valordevolucao');
    const idxDataPgto   = idxOf('datahorapagamento', 'datahora_pagamento');
    const idxDataViagem = idxOf('dataviagem', 'data_viagem');
    const idxDataHora   = idxOf('datahora', 'data_hora');
    const idxOrigem     = idxOf('origem');
    const idxDestino    = idxOf('destino');
    const idxSentido    = idxOf('sentido');
    const idxCpf        = idxOf('cpf');
    const idxNumTrans   = idxOf('idtransacao', 'id_transacao', 'idtransação', 'id_transação');
    const idxTipoPgto   = idxOf('tipopagamento');
    const idxRef        = idxOf('referencia');
    const idxIdUser     = idxOf('iduser');
    const idxLinkBPE    = idxOf('linkbpe');
    const idxIdUrl      = idxOf('idurl');
    const idxpoltrona   = idxOf('poltrona');
    const idxNome       = idxOf('nome');

    if (idxEmail < 0) return res.json({ ok:true, items:[] });

    const items = rows.slice(1)
      .filter(r => get(r, idxEmail).toLowerCase() === email)
      .map(r => {
        const dataHora = get(r, idxDataHora);
        const departureTime = dataHora.includes(' ')
          ? dataHora.split(' ')[1]
          : '';
        const price = get(r, idxValor).replace(',', '.');

        return {
          name:              get(r, idxNome),
          email,
          ticketNumber:      get(r, idxNum),
          serie:             get(r, idxSerie),
          statusPagamento:   get(r, idxStatusPay),
          status:            get(r, idxStatus),
          price:             price ? Number(price) : 0,
          valorConveniencia: get(r, idxValorConv),
          valorDevolucao:    get(r, idxValorDev),
          paidAt:            get(r, idxDataPgto),
          origin:            get(r, idxOrigem),
          destination:       get(r, idxDestino),
          date:              get(r, idxDataViagem),
          dateTime:          dataHora,
          departureTime,
          sentido:           get(r, idxSentido),
          cpf:               get(r, idxCpf),
          transactionId:     get(r, idxNumTrans),
          paymentType:       get(r, idxTipoPgto),
          referencia:        get(r, idxRef),
          idUser:            get(r, idxIdUser),
          driveUrl:          get(r, idxLinkBPE) || get(r, idxIdUrl),
          poltrona:          get(r, idxpoltrona)
        };
      });

    res.json({ ok:true, items });
  } catch (e) {
    console.error('[sheets] read error', e);
    res.status(500).json({ ok:false, error:'sheets_read_failed' });
  }
});


function getSheets() {
  const key = JSON.parse(process.env.GDRIVE_SA_KEY || '{}');
  if (!key.client_email || !key.private_key) throw new Error('GDRIVE_SA_KEY ausente/ inválida');
  const auth = new google.auth.JWT(
    key.client_email, null, key.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

function resolveSheetEnv() {
  const spreadsheetId = process.env.SHEETS_BPE_ID; // <- usa só o que você já tem
  if (!spreadsheetId) throw new Error('SHEETS_BPE_ID não definido no ambiente');

  // se vier "BPE!A:AG", extrai "BPE"
  const guessedTab = (process.env.SHEETS_BPE_RANGE || '').split('!')[0] || '';
  const tab = guessedTab || 'BPE';
  const range = `${tab}!A:AG`; // sua aba usa A:AG
  return { spreadsheetId, tab, range };
}

async function sheetsFindByBilhete(numPassagem) {
  const sheets = getSheets();
  const { spreadsheetId, range, tab } = resolveSheetEnv();

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = data.values || [];
  if (!rows.length) throw new Error('Aba vazia no Sheets');

  const header = rows[0].map(v => String(v || '').trim());
  const colNum = header.findIndex(h => h.toLowerCase() === 'numpassagem');
  if (colNum < 0) throw new Error('Coluna "NumPassagem" não encontrada');

  const rowIndex = rows.findIndex((r, i) => i > 0 && String(r[colNum] || '').trim() === String(numPassagem));
  if (rowIndex < 0) throw new Error('Bilhete não encontrado');

  return { spreadsheetId, tab, rows, header, rowIndex };
}

async function sheetsUpdateStatus(rowIndex, status) {
  const sheets = getSheets();
  const { spreadsheetId, tab } = resolveSheetEnv();

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!1:1`
  });
  const header = data.values?.[0] || [];
  const col = header.findIndex(h => String(h).trim().toLowerCase() === 'status');
  if (col < 0) throw new Error('Coluna "Status" não encontrada');

  const colA = String.fromCharCode(65 + col);
  const a1 = `${tab}!${colA}${rowIndex + 1}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] }
  });
}


/* ============================================================================
   Descobrir e-mail do cliente (prioriza login, inclui body.userEmail)
============================================================================ */
function pickBuyerEmail({ req, payment, vendaResult, fallback }) {
  const isMail = (v) => !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
  const fromLogin =
    req?.user?.email ||
    req?.session?.user?.email ||
    req?.headers?.['x-user-email'] ||
    req?.body?.loginEmail ||
    req?.body?.emailLogin ||
    req?.body?.userEmail ||      // legado
    req?.body?.user?.email;      // legado

  if (isMail(fromLogin)) return String(fromLogin).trim();

  const fromMP = payment?.payer?.email || payment?.additional_info?.payer?.email;
  if (isMail(fromMP)) return String(fromMP).trim();

  const fromReq = req?.body?.email || req?.body?.buyerEmail || req?.body?.clienteEmail;
  if (isMail(fromReq)) return String(fromReq).trim();

  const fromVenda = vendaResult?.Email || vendaResult?.EmailCliente;
  if (isMail(fromVenda)) return String(fromVenda).trim();

  return fallback || null;
}

/* =================== CSP (Bricks) =================== */
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://sdk.mercadopago.com https://wallet.mercadopago.com https://http2.mlstatic.com",
      "connect-src 'self' https://api.mercadopago.com https://wallet.mercadopago.com https://http2.mlstatic.com https://api-static.mercadopago.com https://api.mercadolibre.com https://*.mercadolibre.com https://*.mercadolivre.com",
      "img-src 'self' data: https://*.mercadopago.com https://*.mpago.li https://http2.mlstatic.com https://*.mercadolibre.com https://*.mercadolivre.com",
      "frame-src https://wallet.mercadopago.com https://api.mercadopago.com https://api-static.mercadopago.com https://*.mercadolibre.com https://*.mercadolivre.com",
      "child-src https://wallet.mercadopago.com https://api.mercadopago.com https://api-static.mercadopago.com https://*.mercadolibre.com https://*.mercadolivre.com",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:"
    ].join('; ')
  );
  next();
});

/* =================== Middlewares =================== */

app.use(express.static(PUBLIC_DIR));
app.use('/img', express.static(path.join(__dirname, 'img')));

// servir PDFs
if (!fs.existsSync(TICKETS_DIR)) fs.mkdirSync(TICKETS_DIR);
app.use('/tickets', express.static(TICKETS_DIR, { maxAge: '7d', index: false }));

/* =================== Rotas Mercado Pago existentes =================== */
const mpRoutes = require('./mpRoutes');
app.use('/api/mp', mpRoutes);


// Espera o flush do agregador (Sheets + e-mail) para um paymentId (groupId)
app.get('/api/mp/wait-flush', async (req, res) => {
  try {
    const paymentId = String(req.query.paymentId || '').trim();
    if (!paymentId) return res.status(400).json({ ok:false, error:'paymentId é obrigatório' });

    // se não houver entrada no agregador, já flushei (ou não havia o que enviar)
    const e = AGGR.get(paymentId);
    if (!e || e.flushed) return res.json({ ok:true, flushed:true });

    // ainda pendente → aguarda com timeout
    const TIMEOUT = Math.max(AGGR_MAX_WAIT_MS, AGGR_DEBOUNCE_MS + 5000); // ~40s
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), TIMEOUT);
      e.waiters.push(() => { clearTimeout(t); resolve(); });
    });

    return res.json({ ok:true, flushed:true });
  } catch (err) {
    return res.status(200).json({ ok:true, flushed:false, note:'fallback' }); // não bloqueia UX
  }
});







// diagnóstico rápido
app.get('/api/_diag', (_req, res) => {
  const at = process.env.MP_ACCESS_TOKEN || '';
  res.json({
    has_access_token: Boolean(at),
    access_token_snippet: at ? `${at.slice(0, 6)}...${at.slice(-4)}` : null,
    public_key: process.env.MP_PUBLIC_KEY || null
  });
});


async function mpRefund({ paymentId, amount, idempotencyKey }) {
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'X-Idempotency-Key': String(idempotencyKey || `cancel-${paymentId}-${amount}-${Date.now()}`)
    },
    body: JSON.stringify({ amount: Number(amount) })
  });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) { const e = new Error(j?.message || 'Falha no estorno do Mercado Pago'); e.details=j; throw e; }
  return j;
}


// util de dinheiro robusto: "91.00", "91,00", "1.234,56", "R$ 6,60" → 2 casas
function parseMoneyBR(val) {
  if (typeof val === 'number') return +val.toFixed(2);
  let s = String(val ?? '').trim();
  if (!s) return 0;
  s = s.replace(/[R$\s]/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // padrão brasileiro: milhar com ponto, decimal com vírgula
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma && !hasDot) {
    // só vírgula → decimal
    s = s.replace(',', '.');
  } else {
    // só ponto → já decimal (não remover)
  }
  const n = Number(s);
  return Number.isFinite(n) ? +n.toFixed(2) : 0;
}

// MP helpers
async function mpGetPayment(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.message || `Pagamento ${paymentId} não encontrado`);
    e.details = j;
    throw e;
  }
  return j;
}

async function mpRefund({ paymentId, amount, idempotencyKey }) {
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`;
  const body = { amount: +Number(amount).toFixed(2) };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'X-Idempotency-Key': String(idempotencyKey || `cancel-${paymentId}-${body.amount}-${Date.now()}`)
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.message || 'Falha no estorno do Mercado Pago'); e.details = j; throw e; }
  return j;
}

// === Cancelamento completo: Praxio → refund MP (95%) → Status "Cancelado" no Sheets ===
// util de dinheiro robusto: "91.00", "91,00", "1.234,56", "R$ 6,60" → 2 casas
function parseMoneyBR(val) {
  if (typeof val === 'number') return +val.toFixed(2);
  let s = String(val ?? '').trim();
  if (!s) return 0;
  s = s.replace(/[R$\s]/g, '');
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // padrão brasileiro: milhar com ponto, decimal com vírgula
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma && !hasDot) {
    // só vírgula → decimal
    s = s.replace(',', '.');
  } else {
    // só ponto → já decimal (não remover)
  }
  const n = Number(s);
  return Number.isFinite(n) ? +n.toFixed(2) : 0;
}

// MP helpers
async function mpGetPayment(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j?.message || `Pagamento ${paymentId} não encontrado`);
    e.details = j;
    throw e;
  }
  return j;
}

async function mpRefund({ paymentId, amount, idempotencyKey }) {
  const url = `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`;
  const body = { amount: +Number(amount).toFixed(2) };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'X-Idempotency-Key': String(idempotencyKey || `cancel-${paymentId}-${body.amount}-${Date.now()}`)
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.message || 'Falha no estorno do Mercado Pago'); e.details = j; throw e; }
  return j;
}

// === Cancelamento completo: Praxio → refund MP (95%) → Status "Cancelado" no Sheets ===



// utils já definidos no seu arquivo:
// parseMoneyBR, mpGetPayment, mpRefund, praxioLogin, praxioVerificaDevolucao, praxioGravaDevolucao

app.post('/api/cancel-ticket', async (req, res) => {
  try {
    console.log('[cancel-ticket] body=', req.body);

    const numeroPassagem = String(req.body?.numeroPassagem || '').trim();
    const motivo = req.body?.motivo || 'Solicitação do cliente via portal';
    if (!numeroPassagem) {
      return res.status(400).json({ ok: false, error: 'numeroPassagem é obrigatório.' });
    }

    // 1) Sheets
    const found = await sheetsFindByBilhete(numeroPassagem);
    const { rows, header, rowIndex } = found;
    const row = rows[rowIndex];

    const norm = (s) => String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/gi, '').toLowerCase();
    const hnorm = header.map(norm);
    const findCol = (cands) => {
      for (const c of cands) {
        const i = hnorm.findIndex((h) => h === norm(c));
        if (i !== -1) return i;
      }
      return -1;
    };

    const idxValor = findCol(['Valor','ValorPago','ValorTotal','ValorTotalPago','Valor Total Pago']);
    const idxIdPg  = findCol(['idPagamento','paymentId','idpagamento','idpagamentomp','id pagamento']);
    const idxCorr  = findCol(['correlationID','x-idempotency-key','idempotency','idempotencykey']);

    if (idxValor === -1 || idxIdPg === -1) {
      console.error('[cancel-ticket] Header lido:', header);
      throw new Error('Colunas Valor/idPagamento não encontradas na planilha');
    }

    const valorOriginal = parseMoneyBR(row[idxValor]);
    const valorRefundDesejado = +Number(valorOriginal * 0.95).toFixed(2);

    let paymentId = row[idxIdPg];
    paymentId = (typeof paymentId === 'number') ? String(Math.trunc(paymentId)) : String(paymentId || '').trim();
    const correlationID = idxCorr !== -1 ? String(row[idxCorr] ?? '').trim() : null;

    // 2) Praxio — Verifica & Grava (com LOG de request/response)
    const IdSessaoOp = await praxioLogin();

    const bodyVer = {
      IdSessaoOp: IdSessaoOp,
      FusoHorario: '-03:00',
      IdEstabelecimento: String(process.env.PRAXIO_ID_ESTAB || '93'),
      SerieBloco: String(process.env.PRAXIO_SERIE_BLOCO || '93'),
      NumPassagem: String(numeroPassagem),
      MotivoCancelamento: String(motivo)
    };
    console.log('[PRAXIO] POST VerificaDevolucao',
      'url= https://oci-parceiros2.praxioluna.com.br/Autumn/VendaPassagem/VerificaDevolucao',
      'body=', bodyVer);
    const ver = await praxioVerificaDevolucao({ idSessao: IdSessaoOp, numPassagem: numeroPassagem, motivo });
    console.log('[PRAXIO] RES VerificaDevolucao =>', JSON.stringify(ver).slice(0, 800));

    const xmlPassagem = ver?.Xml?.Passagem || ver?.Xml?.['Passagem'];
    if (!xmlPassagem) throw new Error('Retorno Praxio inválido (sem Xml.Passagem)');
    if (ver?.IdErro) {
      return res.status(409).json({ ok: false, error: ver?.Mensagem || 'Cancelamento não permitido pela Praxio' });
    }

    const bodyGrava = {
      IdSessaoOp: IdSessaoOp,
      IdEstabelecimentoDevolucao: String(xmlPassagem.IDEstabelecimento),
      ValorVenda: String(xmlPassagem.ValorPago),
      Passagem: {
        IDEstabelecimento: String(xmlPassagem.IDEstabelecimento),
        SerieBloco: String(xmlPassagem.SerieBloco),
        NumeroPassagem: String(xmlPassagem.NumeroPassagem),
        Poltrona: String(xmlPassagem.NumeroPoltrona),
        ValorDevolucao: String(xmlPassagem.ValorPago),
        IdCaixa: 0
      }
    };
    console.log('[PRAXIO] POST GravaDevolucao',
      'url= https://oci-parceiros2.praxioluna.com.br/Autumn/VendaPassagem/GravaDevolucao',
      'body=', bodyGrava);
    const grava = await praxioGravaDevolucao({ idSessao: IdSessaoOp, xmlPassagem });
    console.log('[PRAXIO] RES GravaDevolucao =>', JSON.stringify(grava).slice(0, 800));

    // 3) MP — calcula disponível e estorna (LOGs)
    const pay = await mpGetPayment(paymentId);
    const total = +Number(pay.transaction_amount || 0).toFixed(2);
    const refundedSoFar = Array.isArray(pay.refunds)
      ? +pay.refunds.reduce((a, r) => a + (+Number(r.amount || 0).toFixed(2)), 0).toFixed(2)
      : 0;
    const disponivel = Math.max(0, +Number(total - refundedSoFar).toFixed(2));
    console.log('[MP] paymentId=', paymentId, 'total=', total, 'refundedSoFar=', refundedSoFar, 'disponivel=', disponivel);

    let valorRefund = Math.min(valorRefundDesejado, disponivel);
    if (valorRefund < 0) valorRefund = 0;

    let refund = null;
    if (valorRefund > 0) {
      console.log('[MP] POST refund url= https://api.mercadopago.com/v1/payments/'+paymentId+'/refunds',
                  'body=', { amount: +Number(valorRefund).toFixed(2) },
                  'headers:', { 'X-Idempotency-Key': correlationID || '(auto)' });
      try {
        refund = await mpRefund({ paymentId, amount: valorRefund, idempotencyKey: correlationID });
        console.log('[MP] RES refund =>', JSON.stringify(refund).slice(0, 800));
      } catch (err) {
        const det = err?.details?.cause?.[0]?.description || err?.details?.message || err?.message;
        throw new Error(det || 'Falha ao estornar no Mercado Pago');
      }
    } else {
      console.log('[MP] Sem valor disponível para estorno. valorRefund=', valorRefund, 'disponivel=', disponivel);
    }

    // 4) Sheets — marcar "Cancelado" (não falha a operação se o update quebrar)
    let planilha = { ok: true };
    try {
      await sheetsUpdateStatus(rowIndex, 'Cancelado');
    } catch (err) {
      console.error('[Sheets] Falha ao atualizar Status:', err?.message || err);
      planilha = { ok: false, error: err?.message || String(err) };
    }

    return res.json({
      ok: true,
      numeroPassagem,
      valorOriginal,
      valorRefund,
      praxio: { verifica: ver, grava },
      mp: refund ? refund : { note: 'Sem estorno (indisponível).' },
      planilha
    });
  } catch (e) {
    const http = e?.code === 'PRAXIO_BLOQUEADO' ? 409 : 500;
    console.error('[cancel-ticket] erro:', e);
    return res.status(http).json({ ok: false, error: e.message || 'Falha no cancelamento', details: e.details || null });
  }
});


/* =================== SMTP / Brevo =================== */
function createSSL() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(SMTP_SECURE || 'true') === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false },
    family: 4,
    connectionTimeout: 3500,
    greetingTimeout: 3500,
    socketTimeout: 3500,
  });
}
function createSTARTTLS() {
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: { rejectUnauthorized: false },
    family: 4,
    connectionTimeout: 3500,
    greetingTimeout: 3500,
    socketTimeout: 3500,
  });
}
function verifyWithTimeout(transporter, ms = 3500) {
  return Promise.race([
    transporter.verify().then(() => ({ ok: true })),
    new Promise(r => setTimeout(() => r({ ok: false, error: 'verify-timeout' }), ms + 200)),
  ]).catch(e => ({ ok: false, error: e?.message || String(e) }));
}
async function ensureTransport() {
  let t = createSSL();
  if (t) {
    const r = await verifyWithTimeout(t);
    if (r.ok) return { transporter: t, mode: 'SSL(465)' };
  }
  t = createSTARTTLS();
  if (t) {
    const r = await verifyWithTimeout(t);
    if (r.ok) return { transporter: t, mode: 'STARTTLS(587)' };
    return { transporter: null, mode: null, error: r.error || 'falha STARTTLS' };
  }
  return { transporter: null, mode: null, error: 'vars SMTP ausentes' };
}

// === Brevo API (primário) ===
async function sendViaBrevoApi({ to, subject, html, text, fromEmail, fromName, attachments = [] }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY ausente');

const slug = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'')
  .toLowerCase();

/*
  
const brevoAttachments = (attachments || []).map(a => ({
  name: a.filename && String(a.filename).trim() ? a.filename : 'anexo.pdf',
  content: a.contentBase64 || a.content || ''
}));*/



  const brevoAttachments = (attachments || []).map(a => ({
  // aceita filename OU name (por segurança)
  name: (a.filename || a.name || 'anexo.pdf'),
  // aceita contentBase64 OU content (por segurança)
  content: (a.contentBase64 || a.content || '')
}));



  const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
      attachment: brevoAttachments.length ? brevoAttachments : undefined,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Brevo API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

/* =================== Auth: códigos por e-mail =================== */
const codes = new Map();
const CODE_TTL_MIN = 10;
const MAX_ATTEMPTS = 6;
const genCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const normalizeEmail = e => String(e || '').trim().toLowerCase();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of codes.entries()) if (v.expiresAt <= now) codes.delete(k);
}, 60 * 1000);

app.post('/api/auth/request-code', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'E-mail inválido.' });
    }
    const code = genCode();
    const expiresAt = Date.now() + CODE_TTL_MIN * 60 * 1000;
    codes.set(email, { code, expiresAt, attempts: 0 });

    const appName   = process.env.APP_NAME || 'Turin Transportes';
    const fromName  = process.env.SUPPORT_FROM_NAME || 'Turin Transportes';
    const fromEmail = process.env.SUPPORT_FROM_EMAIL || process.env.SMTP_USER;
    const from      = `"${fromName}" <${fromEmail}>`;

    const html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#222">
        <p>Olá,</p>
        <p>Seu código de acesso ao <b>${appName}</b> é:</p>
        <p style="font-size:28px;letter-spacing:3px;margin:16px 0"><b>${code}</b></p>
        <p>Ele expira em ${CODE_TTL_MIN} minutos.</p>
        <p style="color:#666;font-size:13px">Se não foi você, ignore este e-mail.</p>
      </div>
    `;
    const text = `Seu código é: ${code} (expira em ${CODE_TTL_MIN} minutos).`;

    try {
      const got = await ensureTransport();
      if (!got.transporter) throw new Error('smtp-indisponivel');
      await got.transporter.sendMail({
        from, to: email, replyTo: fromEmail,
        subject: `Seu código de acesso (${appName})`,
        html, text,
      });
    } catch {
      await sendViaBrevoApi({ to: email, subject: `Seu código de acesso (${appName})`, html, text, fromEmail, fromName });
    }

    const devPayload = process.env.NODE_ENV !== 'production' ? { demoCode: code } : {};
    return res.json({ ok: true, message: 'Código enviado.', ...devPayload });

  } catch (err) {
    console.error('Erro ao enviar e-mail:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Falha ao enviar e-mail.' });
  }
});

app.post('/api/auth/verify-code', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '');
  if (!email || !code) return res.status(400).json({ ok: false, error: 'E-mail e código são obrigatórios.' });

  const entry = codes.get(email);
  if (!entry) return res.status(400).json({ ok: false, error: 'Solicite um novo código.' });
  if (entry.expiresAt < Date.now()) { codes.delete(email); return res.status(400).json({ ok: false, error: 'Código expirado.' }); }
  if (entry.attempts >= MAX_ATTEMPTS) { codes.delete(email); return res.status(400).json({ ok: false, error: 'Muitas tentativas.' }); }

  entry.attempts += 1;
  if (entry.code !== code) return res.status(400).json({ ok: false, error: 'Código incorreto.' });

  codes.delete(email);
  const user = { email, name: email.split('@')[0], createdAt: new Date().toISOString() };
  res.json({ ok: true, user });
});

/* =================== Praxio helpers =================== */
function normalizeHoraPartida(h) {
  if (!h) return '';
  let s = String(h).replace(/\D/g, '');
  if (s.length === 3) s = '0' + s;
  if (s.length >= 4) s = s.slice(0, 4);
  return s;
}







// ==== Agregador por compra (webhook/e-mail/Sheets) ====
// groupId -> { timer, startedAt, base, bilhetes:[], arquivos:[], emailAttachments:[], expected, flushed }
const AGGR = new Map();
const AGGR_DEBOUNCE_MS = 11000;   // ⬅️ 8s para juntar múltiplas chamadas
const AGGR_MAX_WAIT_MS = 60000;  // ⬅️ segurança 30s

/*function queueUnifiedSend(groupId, fragment, doFlushCb) {
  let e = AGGR.get(groupId);
  if (!e) {
    e = { timer:null, startedAt:Date.now(), base:{}, bilhetes:[], arquivos:[], emailAttachments:[], expected:0, flushed:false, waiters:[] };
    AGGR.set(groupId, e);
  }*/
function queueUnifiedSend(groupId, fragment, doFlushCb) {
  let e = AGGR.get(groupId);
  if (!e) {
    e = { timer:null, startedAt:Date.now(), base:{}, bilhetes:[], arquivos:[], emailAttachments:[],
          expected:0, flushed:false, waiters:[] };
    AGGR.set(groupId, e);
  }

  // merge base (último vence)
  e.base = { ...e.base, ...(fragment.base||{}) };

  // ❌ antes: if (fragment.expected > e.expected) e.expected = fragment.expected;
  // ✅ agora: somar o total esperado deste fragmento (ida + volta, etc.)
  // soma o esperado desta resposta (qtd de bilhetes)
  const addExpected = Number(fragment?.expected || 0);
  if (addExpected > 0) e.expected += addExpected;

  // acumula
  if (Array.isArray(fragment?.bilhetes))        e.bilhetes.push(...fragment.bilhetes);
  if (Array.isArray(fragment?.arquivos))        e.arquivos.push(...fragment.arquivos);
  if (Array.isArray(fragment?.emailAttachments)) e.emailAttachments.push(...fragment.emailAttachments);

  // de-dups
  const seenB = new Set();
  e.bilhetes = e.bilhetes.filter(b => {
    const k = `${b?.numPassagem||''}|${b?.chaveBPe||''}`;
    if (!k.trim() || seenB.has(k)) return false;
    seenB.add(k);
    return true;
  });
  const seenA = new Set();
  e.arquivos = e.arquivos.filter(a => {
    const k = `${a?.driveFileId||''}|${a?.numPassagem||''}|${a?.pdfLocal||''}`;
    if (seenA.has(k)) return false;
    seenA.add(k);
    return true;
  });

const tryFlush = async () => {
    if (e.flushed) return;

    const waited = (Date.now() - e.startedAt) >= AGGR_MAX_WAIT_MS;

    // ✅ agora só flusha quando TEMOS TODOS os anexos também
    const haveAllBilhetes = e.expected > 0 && e.bilhetes.length >= e.expected;
    const haveAllAnexos   = e.expected > 0 && e.emailAttachments.length >= e.expected;

    if (!waited && !(haveAllBilhetes && haveAllAnexos)) return;

    e.flushed = true;
    clearTimeout(e.timer); e.timer = null;

    console.log(`[AGGR] flushing: expected=${e.expected} bilhetes=${e.bilhetes.length} anexos=${e.emailAttachments.length} waited=${waited}`);
    try { await doFlushCb({ ...e }); }
    finally {
      (e.waiters || []).forEach(fn => { try { fn(); } catch{} });
      AGGR.delete(groupId);
    }
  };

  clearTimeout(e.timer);
  e.timer = setTimeout(tryFlush, AGGR_DEBOUNCE_MS);
}












// === Idempotência curta para evitar duplo envio por compra ===
const SEND_GUARD = new Map(); // key: paymentId -> expiresAt (ms)

function guardOnce(key, ttlMs = 120000) { // 2 min
  const now = Date.now();
  const exp = SEND_GUARD.get(key);
  if (exp && exp > now) return false;  // já executado recentemente
  SEND_GUARD.set(key, now + ttlMs);
  return true;
}

// limpeza eventual
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of SEND_GUARD.entries()) if (v <= now) SEND_GUARD.delete(k);
}, 60000);




async function praxioLogin() {
  const resp = await fetch('https://oci-parceiros2.praxioluna.com.br/Autumn/Login/efetualogin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Nome: process.env.PRAXIO_USER,
      Senha: process.env.PRAXIO_PASS,
      Sistema: 'WINVR.EXE',
      TipoBD: 0,
      Empresa: process.env.PRAXIO_EMP,
      Cliente: process.env.PRAXIO_CLIENT,
      TipoAplicacao: 0,
    }),
  });
  if (!resp.ok) throw new Error(`Praxio login ${resp.status}`);
  const j = await resp.json();
  if (!j?.IdSessaoOp) throw new Error('Praxio sem IdSessaoOp');
  return j.IdSessaoOp;
}

async function praxioVendaPassagem(bodyVenda) {
  const resp = await fetch('https://oci-parceiros2.praxioluna.com.br/Autumn/VendaPassagem/VendaPassagem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyVenda),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data?.Sucesso === false) {
    const msg = data?.Mensagem || data?.MensagemDetalhada || `HTTP ${resp.status}`;
    throw new Error(`Falha VendaPassagem: ${msg}`);
  }
  return data;
}


async function praxioVerificaDevolucao({ idSessao, numPassagem, motivo }) {
  const url = 'https://oci-parceiros2.praxioluna.com.br/Autumn/VendaPassagem/VerificaDevolucao';
  const body = {
    IdSessaoOp: idSessao,
    FusoHorario: '-03:00',
    IdEstabelecimento: String(process.env.PRAXIO_ID_ESTAB || '93'),
    SerieBloco: String(process.env.PRAXIO_SERIE_BLOCO || '93'),
    NumPassagem: String(numPassagem),
    MotivoCancelamento: String(motivo || 'Cancelamento solicitado pelo cliente')
  };
  const r = await fetchWithTimeout(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, 10000);
  const j = await r.json();
  if (!r.ok) throw new Error('VerificaDevolucao falhou');
  if (j?.IdErro) { const err = new Error(j?.Mensagem || 'Não é possível cancelar'); err.code='PRAXIO_BLOQUEADO'; throw err; }
  return j;
}

async function praxioGravaDevolucao({ idSessao, xmlPassagem }) {
  const url = 'https://oci-parceiros2.praxioluna.com.br/Autumn/VendaPassagem/GravaDevolucao';
  const body = {
    IdSessaoOp: idSessao,
    IdEstabelecimentoDevolucao: String(xmlPassagem.IDEstabelecimento),
    ValorVenda: String(xmlPassagem.ValorPago),
    Passagem: {
      IDEstabelecimento: String(xmlPassagem.IDEstabelecimento),
      SerieBloco: String(xmlPassagem.SerieBloco),
      NumeroPassagem: String(xmlPassagem.NumeroPassagem),
      Poltrona: String(xmlPassagem.NumeroPoltrona),
      ValorDevolucao: String(xmlPassagem.ValorPago),
      IdCaixa: 0
    }
  };
  const r = await fetchWithTimeout(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, 10000);
  const j = await r.json();
  if (!r.ok) throw new Error('GravaDevolucao falhou');
  return j;
}


// Data com offset -03:00 (ex.: 2025-10-17T22:12:24-03:00)
function nowWithTZOffsetISO(offsetMinutes = -(3 * 60)) {
  const now = new Date();
  const tzNow = new Date(now.getTime() + (offsetMinutes + now.getTimezoneOffset()) * 60000);
  const pad = (n) => String(n).padStart(2, '0');
  const y = tzNow.getFullYear();
  const m = pad(tzNow.getMonth() + 1);
  const d = pad(tzNow.getDate());
  const hh = pad(tzNow.getHours());
  const mm = pad(tzNow.getMinutes());
  const ss = pad(tzNow.getSeconds());
  const sign = offsetMinutes <= 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

/* =================== Partidas/Poltronas =================== */
app.post('/api/partidas', async (req, res) => {
  try {
    const { origemId, destinoId, data } = req.body;
    const IdSessaoOp = await praxioLogin();

    const partResp = await fetch('https://oci-parceiros2.praxioluna.com.br/Autumn/Partidas/Partidas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        IdSessaoOp,
        LocalidadeOrigem: origemId,
        LocalidadeDestino: destinoId,
        DataPartida: data,
        SugestaoPassagem: '1',
        ListarTodas: '1',
        SomenteExtra: '0',
        TempoPartida: 1,
        IdEstabelecimento: '1',
        DescontoAutomatico: 0,
      }),
    });
    const partData = await partResp.json();
    res.json(partData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar partidas' });
  }
});

app.post('/api/poltronas', async (req, res) => {
  try {
    const { idViagem, idTipoVeiculo, idLocOrigem, idLocDestino } = req.body;
    const IdSessaoOp = await praxioLogin();

    const seatResp = await fetch('https://oci-parceiros2.praxioluna.com.br/Autumn/Poltrona/RetornaPoltronas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        IdSessaoOp,
        IdViagem: idViagem,
        IdTipoVeiculo: idTipoVeiculo,
        IdLocOrigem: idLocOrigem,
        IdLocdestino: idLocDestino,
        VerificarSugestao: 1,
      }),
    });
    const seatData = await seatResp.json();
    res.json(seatData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao consultar poltronas' });
  }
});

/* =================== Render manual de ticket (debug) =================== */
app.post('/api/ticket/render', async (req, res) => {
  try {
    const vendaRoot = req.body;
    const ticket = mapVendaToTicket(vendaRoot);
    const subDir = new Date().toISOString().slice(0,10);
    const outDir = path.join(TICKETS_DIR, subDir);
    const pdf = await generateTicketPdf(ticket, outDir);
    const pdfUrl = `/tickets/${subDir}/${pdf.filename}`;
    res.json({ ok: true, files: { pdf: pdfUrl }, ticket: {
      nome: ticket.nomeCliente, numPassagem: ticket.numPassagem, poltrona: ticket.poltrona,
      data: ticket.dataViagem, hora: ticket.horaPartida, origem: ticket.origem, destino: ticket.destino
    }});
  } catch (e) {
    console.error('ticket/render error:', e);
    res.status(400).json({ ok:false, error: e.message || 'Falha ao gerar bilhete' });
  }
});


/* =================== Venda Praxio + PDF + e-mail + Webhook agrupado =================== */
app.post('/api/praxio/vender', async (req, res) => {
  try {
    const {
      mpPaymentId,                 // MP payment id
      schedule,                    // { idViagem, horaPartida, idOrigem, idDestino, ... }
      passengers,                  // [{ seatNumber, name, document }]
      totalAmount,                 // valor total
      idEstabelecimentoVenda = '1',
      idEstabelecimentoTicket = '93',
      serieBloco = '93',
      userEmail = '',
      userPhone = '',
      idaVolta = 'ida'
    } = req.body || {};


        // mpPaymentId é o id único da compra no MP (vem do body)

    
    /*

if (!guardOnce(String(mpPaymentId))) {
  console.warn('[Idem] pular envio (já processado) para payment=', mpPaymentId);
  return res.json({ ok: true, venda: vendaResult, arquivos, note: 'idempotent-skip' });
}


if (!guardOnce(String(mpPaymentId))) {
  console.warn('[Idem] pular processamento (já processado) payment=', mpPaymentId);
  return res.json({ ok: true, note: 'idempotent-skip' });
}

*/




    

    // 1) Revalida o pagamento
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
    });
    const payment = await r.json();
    if (!r.ok || !['approved','accredited'].includes(payment?.status)) {
      return res.status(400).json({ ok:false, error:'Pagamento não está aprovado.' });
    }

    const mpAmount = Number(payment.transaction_amount || 0);
    if (totalAmount && Number(totalAmount) > mpAmount + 0.01) {
      return res.status(400).json({ ok:false, error:'Valor do item maior que o total pago.' });
    }

    // tipo/forma de pagamento
    const mpType = String(payment?.payment_type_id || '').toLowerCase(); // 'credit_card'|'debit_card'|'pix'|...
    const tipoPagamento = (mpType === 'pix') ? '8' : '3';                // 8=PIX | 3=Cartão
    const tipoCartao    = (mpType === 'credit_card') ? '1'
                        : (mpType === 'debit_card')  ? '2'
                        : '0';                                           // 0=PIX
    const formaPagamento = (mpType === 'pix') ? 'PIX'
                        : (mpType === 'debit_card') ? 'Cartão de Débito'
                        : 'Cartão de Crédito';
    const parcelas = Number(payment?.installments || 1);

    // helpers datas
    function toYMD(dateStr) {
      if (!dateStr) return '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
        const [d,m,y] = dateStr.split('/');
        return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
      }
      const t = Date.parse(dateStr);
      if (Number.isFinite(t)) {
        const z = new Date(t);
        const yyyy = z.getFullYear();
        const mm = String(z.getMonth()+1).padStart(2,'0');
        const dd = String(z.getDate()).padStart(2,'0');
        return `${yyyy}-${mm}-${dd}`;
      }
      return '';
    }
    function joinDateTime(ymd, hhmm) {
      const hh = (hhmm || '').split(':')[0] || '00';
      const mi = (hhmm || '').split(':')[1] || '00';
      return `${ymd} ${String(hh).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
    }

    // 2) Login Praxio
    const IdSessaoOp = await praxioLogin();

    // 3) Monta body venda
    const passagemXml = (passengers || []).map(p => ({
      IdEstabelecimento: String(idEstabelecimentoTicket),
      SerieBloco: String(serieBloco),
      IdViagem: String(schedule?.idViagem || ''),
      Poltrona: String(p.seatNumber || ''),
      NomeCli: String(p.name || ''),
      IdentidadeCli: String((p.document || '').replace(/\D/g,'')),
      TelefoneCli: String((p.phone || userPhone || '')).replace(/\D/g,''),
    }));

    const horaPad = normalizeHoraPartida(schedule?.horaPartida);
    if (!schedule?.idViagem || !horaPad || !schedule?.idOrigem || !schedule?.idDestino || !passagemXml.length) {
      return res.status(400).json({ ok:false, error:'Dados mínimos ausentes para venda.' });
    }

    const bodyVenda = {
      listVendasXmlEnvio: [{
        IdSessaoOp,
        IdEstabelecimentoVenda: String(idEstabelecimentoVenda),
        IdViagem: String(schedule.idViagem),
        HoraPartida: horaPad, // ex.: "1048"
        IdOrigem: String(schedule.idOrigem),
        IdDestino: String(schedule.idDestino),
        Embarque: "S", Seguro: "N", Excesso: "N",
        BPe: 1,
        passagemXml,
        pagamentoXml: [{
          DataPagamento: nowWithTZOffsetISO(-180), // ISO -03:00
          TipoPagamento: tipoPagamento,           // 8=PIX | 3=Cartão
          TipoCartao: tipoCartao,                 // 1=crédito | 2=débito | 0=PIX
          QtdParcelas: parcelas,
          ValorPagamento: Number(totalAmount || mpAmount)
        }]
      }]
    };

    console.log('[Praxio][Venda] body:', JSON.stringify(bodyVenda).slice(0, 4000));

    /*/ 4) Chama Praxio
    const vendaResult = await praxioVendaPassagem(bodyVenda);
    console.log('[Praxio][Venda][Resp]:', JSON.stringify(vendaResult).slice(0, 4000));*/


        // 4) Chama Praxio
    const vendaResult = await praxioVendaPassagem(bodyVenda);
    console.log('[Praxio][Venda][Resp]:', JSON.stringify(vendaResult).slice(0, 4000));

    // 🔎 Validação extra: garantir que existem bilhetes válidos
    const lista = Array.isArray(vendaResult.ListaPassagem)
      ? vendaResult.ListaPassagem
      : [];

    if (!lista.length) {
      const msg = vendaResult.Mensagem || vendaResult.MensagemDetalhada || 'Praxio não retornou nenhum bilhete.';
      throw new Error(`Venda Praxio sem bilhetes: ${msg}`);
    }

    /*
    // 🔎 Verificar erro por poltrona (Sucesso=false / Mensagem preenchida)
    const errosPoltronas = lista.filter(p =>
      p.Sucesso === false ||
      (p.Mensagem && String(p.Mensagem).trim() !== '') ||
      (p.MensagemDetalhada && String(p.MensagemDetalhada).trim() !== '')
    );

    if (errosPoltronas.length) {
      const msgs = errosPoltronas
        .map(p => p.Mensagem || p.MensagemDetalhada)
        .filter(Boolean)
        .join(' | ');

      throw new Error(`Erro na venda de uma ou mais poltronas: ${msgs || 'motivo não informado'}`);
    }*/



    // 🔎 Verificar erro por poltrona
const errosPoltronas = lista.filter(p => {
  const msg = (p.Mensagem || p.MensagemDetalhada || '').toLowerCase();

  // Considera erro se:
  // - a própria Praxio marcou Sucesso === false
  // - OU a mensagem tiver palavras típicas de erro
  const temTextoErro = /erro|indispon[ií]vel|falha/.test(msg);

  return p.Sucesso === false || temTextoErro;
});

if (errosPoltronas.length) {
  const msgs = errosPoltronas
    .map(p => p.Mensagem || p.MensagemDetalhada)
    .filter(Boolean)
    .join(' | ');

  throw new Error(
    `Erro na venda de uma ou mais poltronas: ${msgs || 'motivo não informado'}`
  );
}

  
    

    // 5) Gerar PDFs (local) e subir no Drive
    const subDir = new Date().toISOString().slice(0,10);
    const outDir = path.join(TICKETS_DIR, subDir);
    await fs.promises.mkdir(outDir, { recursive: true });

    const arquivos = [];
    const emailAttachments = []; // base64 + Buffer
    const bilhetesPayload = [];

    for (const p of (vendaResult.ListaPassagem || [])) {
      const sentido = (String(idaVolta).toLowerCase() === 'volta') ? 'Volta' : 'Ida';
      const ticket = mapVendaToTicket({
        ListaPassagem: [p],
        mp: {
          payment_type_id: payment.payment_type_id,
          payment_method_id: (payment.payment_method?.id || payment.payment_method_id || ''),
          status: payment.status,
          installments: payment.installments
        },
        emissaoISO: new Date().toISOString()
      });

      // 5.1 gerar PDF local
      const pdf = await generateTicketPdf(ticket, outDir);
      const localPath = path.join(outDir, pdf.filename);
      const localUrl  = `/tickets/${subDir}/${pdf.filename}`;

      // 5.2 subir no Drive (opcional)
      let drive = null;
      try {
       /* const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'').toLowerCase();
        //const sentido = resolveSentido(p, schedule, scheduleVolta, idaVoltaDefault);
        //const sentido = (String(idaVolta).toLowerCase()==='volta') ? 'volta' : 'ida';
        const buf = await fs.promises.readFile(localPath);
        const nome = `${slug(ticket.nomeCliente || 'passageiro')}_${ticket.numPassagem}_${sentido}.pdf`;
        drive = await uploadPdfToDrive({
          buffer: buf,
          filename: nome,
          folderId: process.env.GDRIVE_FOLDER_ID,
        });


       
        // preparar anexos para e-mail
        emailAttachments.push({
          filename: nome,
          contentBase64: buf.toString('base64'),
          buffer: buf,
        });*/

      const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'').toLowerCase();
      const buf = await fs.promises.readFile(localPath);
const nome = `${slug(ticket.nomeCliente || 'passageiro')}_${ticket.numPassagem}_${sentido}.pdf`;
drive = await uploadPdfToDrive({
  buffer: buf,
  filename: nome,
  folderId: process.env.GDRIVE_FOLDER_ID,
});
emailAttachments.push({ filename: nome, contentBase64: buf.toString('base64'), buffer: buf });




        
      } catch (e) {
        console.error('[Drive] upload falhou:', e?.message || e);
        try {
          const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'').toLowerCase();
          const sentido = resolveSentido(p, schedule, scheduleVolta, idaVoltaDefault);
          //const sentido = (String(idaVolta).toLowerCase()==='volta') ? 'volta' : 'ida';
          const buf = await fs.promises.readFile(localPath);
          const nome = `${slug(ticket.nomeCliente || 'passageiro')}_${ticket.numPassagem}_${sentido}.pdf`;
          emailAttachments.push({
            filename: nome,
            contentBase64: buf.toString('base64'),
            buffer: buf,
          });
        } catch(_) {}
      }

      arquivos.push({
        numPassagem: ticket.numPassagem,
        pdfLocal: localUrl,
        driveUrl: drive?.webViewLink || null,
        driveFileId: drive?.id || null
      });

/*bilhetesPayload.push({
  numPassagem: p.NumPassagem || ticket.numPassagem,
  chaveBPe:    p.ChaveBPe || ticket.chaveBPe || null,
  origem:      p.Origem || ticket.origem || schedule?.originName || schedule?.origem || null,
  destino:     p.Destino || ticket.destino || schedule?.destinationName || schedule?.destino || null,
  origemNome:  ticket.origem || schedule?.originName || schedule?.origem || null,      // p/ cabeçalho da rota
  destinoNome: ticket.destino || schedule?.destinationName || schedule?.destino || null,
  poltrona:    p.Poltrona || ticket.poltrona || null,
  nomeCliente: p.NomeCliente || ticket.nomeCliente || null,
  docCliente:  p.DocCliente || ticket.docCliente || null,
  valor:       p.ValorPgto ?? ticket.valor ?? null,

  // ✅ adiciona Data/Hora por bilhete
  dataViagem:  p.DataViagem || ticket.dataViagem || schedule?.date || schedule?.dataViagem || '',
  horaPartida: p.HoraPartida || ticket.horaPartida || schedule?.horaPartida || schedule?.departureTime || '',

  // ✅ garante sentido por bilhete
  const sentido = resolveSentido(p, schedule, scheduleVolta, idaVoltaDefault);
  idaVolta:   sentido || (String(idaVolta).toLowerCase() === 'volta' ? 'Volta' : 'Ida')
});*/


bilhetesPayload.push({
  numPassagem: p.NumPassagem || ticket.numPassagem,
  chaveBPe:    p.ChaveBPe || ticket.chaveBPe || null,
  origem:      p.Origem || ticket.origem || schedule?.originName || schedule?.origem || null,
  destino:     p.Destino || ticket.destino || schedule?.destinationName || schedule?.destino || null,
  origemNome:  ticket.origem || schedule?.originName || schedule?.origem || null,
  destinoNome: ticket.destino || schedule?.destinationName || schedule?.destino || null,
  poltrona:    p.Poltrona || ticket.poltrona || null,
  nomeCliente: p.NomeCliente || ticket.nomeCliente || null,
  docCliente:  p.DocCliente || ticket.docCliente || null,
  valor:       p.ValorPgto ?? ticket.valor ?? null,

  dataViagem:  p.DataViagem || ticket.dataViagem || schedule?.date || schedule?.dataViagem || '',
  horaPartida: p.HoraPartida || ticket.horaPartida || schedule?.horaPartida || schedule?.departureTime || '',

  idaVolta:    sentido
});


      

          }






  // --- FRAGMENTO a enfileirar no agregador ---
const loginEmail = getLoginEmail(req, payment, vendaResult);
const loginPhone = getLoginPhone(req, payment, vendaResult);

// contagem esperada (qtd de bilhetes desta venda)
const expectedCount =
  (vendaResult?.ListaPassagem?.length || 0) ||
  (passengers?.length || 0);

// monta fragmento
const fragment = {
  base: { payment, schedule, userEmail: loginEmail||'', userPhone: loginPhone||'', idaVolta },
  bilhetes: bilhetesPayload,
  arquivos,
  emailAttachments,
  expected: expectedCount
};

// chave por compra
const groupId = String(mpPaymentId || payment?.id || payment?.external_reference || computeGroupId(req, payment, schedule));

// enfileira; quando o AGGR perceber que chegou tudo (ou estourar timeout), ele dispara 1x
queueUnifiedSend(groupId, fragment, async (bundle) => {
  const { base, bilhetes, arquivos, emailAttachments } = bundle;
  const { payment, schedule, userEmail, userPhone, idaVolta } = base;

  // trava para evitar e-mail/Sheets duplicados por pagamento
  if (!guardOnce(String(payment?.id || groupId))) {
    console.warn('[Idem] envio já realizado para', payment?.id || groupId);
    return;
  }

  // 1) E-MAIL único com todos os anexos
  const to = userEmail || pickBuyerEmail({ req, payment, vendaResult, fallback: null });
  if (to) {
    const appName   = process.env.APP_NAME || 'Turin Transportes';
    const fromName  = process.env.SUPPORT_FROM_NAME || 'Turin Transportes';
    const fromEmail = process.env.SUPPORT_FROM_EMAIL || process.env.SMTP_USER;

    // Descobre se há múltiplas rotas
const pairs = new Set(bilhetes.map(b => `${b.origemNome || b.origem || ''}→${b.destinoNome || b.destino || ''}`));
const headerRoute = (pairs.size === 1 && bilhetes.length)
  ? [...pairs][0]
  : 'Múltiplas rotas (veja por bilhete)';

const valorTotalBRL = (Number(payment?.transaction_amount || 0)).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});

// lista <li> com rota/data/hora por bilhete e link
const listaHtml = bilhetes.map((b, i) => {
  const sentido = b?.idaVolta || (String(idaVolta).toLowerCase() === 'volta' ? 'Volta' : 'Ida');
  const rotaStr = `${b.origemNome || b.origem || '—'} → ${b.destinoNome || b.destino || '—'}`;
  const nome     = (b?.nomeCliente || '').toString().trim() || '(passageiro não informado)';
  const link = (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.driveUrl)
            || (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.pdfLocal)
            || '';
  const linkHtml = link ? `<div style="margin:2px 0"><a href="${link}" target="_blank" rel="noopener">Abrir bilhete ${i+1}</a></div>` : '';
  return `<li style="margin:10px 0">
            <div><b>Bilhete nº ${b.numPassagem}</b> (${sentido})</div>
            <div><b>Passageiro:</b> ${nome}</div>
            <div><b>Rota:</b> ${rotaStr}</div>
            <div><b>Data/Hora:</b> ${b.dataViagem || ''} ${b.horaPartida || ''}</div>
            ${linkHtml}
          </li>`;
}).join('');


// cabeçalho (Data/Hora do schedule pode não representar todos; ok deixar só valor total)
// const appName   = process.env.APP_NAME || 'Turin Transportes';
// const fromName  = process.env.SUPPORT_FROM_NAME || 'Turin Transportes';
// const fromEmail = process.env.SUPPORT_FROM_EMAIL || process.env.SMTP_USER;

const html =
  `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222">
     <p>Olá,</p>
     <p>Recebemos o seu pagamento em <b>${appName}</b>. Seguem os bilhetes em anexo.</p>
     <p><b>Rota:</b> ${headerRoute}<br/>
        <b>Valor total:</b> ${valorTotalBRL}
     </p>
     <p><b>Bilhetes:</b></p>
     <ul style="margin-top:8px">${listaHtml}</ul>
     <p style="color:#666;font-size:12px;margin-top:16px">Este é um e-mail automático. Em caso de dúvidas, responda a esta mensagem.</p>
   </div>`;

const text = [
  'Olá,', `Recebemos seu pagamento em ${appName}. Bilhetes anexos.`,
  `Rota(s): ${headerRoute}`, `Valor total: ${valorTotalBRL}`,
  '', 'Bilhetes:',
  ...bilhetes.map((b,i) => ` - ${b.numPassagem} (${(b.idaVolta||'ida')}) ${b.origemNome||b.origem||''} -> ${b.destinoNome||b.destino||''} ${b.dataViagem||''} ${b.horaPartida||''}`)
].join('\n');

// usa os nomes já definidos (displayName)
//const attachmentsSMTP  = emailAttachments.map(a => ({ filename: a.filename, content: a.buffer }));
//const attachmentsBrevo = emailAttachments.map(a => ({ name: a.filename, content: a.contentBase64 }));

const attachmentsSMTP  = emailAttachments.map(a => ({
  filename: a.filename,
  content:  a.buffer
}));

const attachmentsBrevo = emailAttachments.map(a => ({
  filename: a.filename,       // <— usa filename (não “name”)
  contentBase64: a.contentBase64
}));





    
    let sent = false;
    try {
      const got = await ensureTransport();
      if (got.transporter) {
        await got.transporter.sendMail({
          from: `"${fromName}" <${fromEmail}>`,
          to, subject: `Seus bilhetes – ${appName}`, html, text,
          attachments: attachmentsSMTP,
        });
        sent = true;
        console.log(`[Email] enviados ${attachmentsSMTP.length} anexos para ${to} via ${got.mode}`);
      }
    } catch (e) { console.warn('[Email SMTP] falhou, tentando Brevo...', e?.message || e); }

    if (!sent) {
      await sendViaBrevoApi({ to, subject:`Seus bilhetes – ${appName}`, html, text, fromEmail, fromName, attachments: attachmentsBrevo });
      console.log(`[Email] enviados ${attachmentsBrevo.length} anexos para ${to} via Brevo API`);
    }
  } else {
    console.warn('[Email] comprador sem e-mail. Pulando envio.');
  }

  // 2) SHEETS – 1 linha por bilhete
  await sheetsAppendBilhetes({
    spreadsheetId: process.env.SHEETS_BPE_ID,
    range: process.env.SHEETS_BPE_RANGE || 'BPE!A:AG',
    bilhetes: bilhetes.map(b => ({
      ...b,
      driveUrl: (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.driveUrl)
             || (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.pdfLocal)
             || ''
    })),
    schedule,
    payment,
    userEmail,                          // mesmo e-mail usado no envio
    userPhone,                           // normalizado
    idaVoltaDefault: idaVolta
  });
});



    

// 7) Retorno para o front
    return res.json({ ok: true, venda: vendaResult, arquivos });

/*  } catch (e) {
    console.error('praxio/vender error:', e);
    return res.status(500).json({ ok:false, error: e.message || 'Falha ao vender/gerar bilhete.' });
  }
});*/


  } catch (e) {
    console.error('[Praxio][Venda] erro:', e);

    const msg = e && e.message
      ? e.message
      : 'Falha ao vender/gerar bilhete.';

    // se for erro conhecido de venda (poltrona indisponível etc.) devolve 400,
    // senão 500 (erro interno)
    const isPraxioError = /Erro na venda de uma ou mais poltronas|Venda Praxio sem bilhetes|Falha VendaPassagem/i
      .test(msg);

    const status = isPraxioError ? 400 : 500;

    return res
      .status(status)
      .json({ ok: false, error: msg });   // mantém "error" porque o payment.js usa j.error
  }
});






    

/* =================== Fallback para .html =================== */
app.get('*', (req, res, next) => {
  if (req.path.endsWith('.html')) {
    return res.sendFile(path.join(PUBLIC_DIR, req.path));
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] rodando em http://localhost:${PORT} | publicDir: ${PUBLIC_DIR}`);
});
