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


// === Log e alerta de falhas de emissão ===
const ERROR_LOG_DIR = path.join(__dirname, 'logs');
const ERROR_LOG_FILE = path.join(ERROR_LOG_DIR, 'vendas-falhas.log');
const ADMIN_ALERT_EMAIL =
  process.env.ADMIN_ALERT_EMAIL || 'informaticamaciel2010@gmail.com';

async function logVendaFalha(entry) {
  try {
    await fs.promises.mkdir(ERROR_LOG_DIR, { recursive: true });
    const linha = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n';
    await fs.promises.appendFile(ERROR_LOG_FILE, linha, 'utf8');
    console.error('[Venda][Erro] registrado em log:', ERROR_LOG_FILE);
  } catch (e) {
    console.error('[Venda][Erro] falha ao gravar log:', e?.message || e);
  }
}


const SUCCESS_LOG_FILE = path.join(ERROR_LOG_DIR, 'vendas-sucesso.log');

async function logVendaSucesso(entry) {
  try {
    await fs.promises.mkdir(ERROR_LOG_DIR, { recursive: true });
    const linha = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n';
    await fs.promises.appendFile(SUCCESS_LOG_FILE, linha, 'utf8');
    console.log('[Venda][OK] registrado em log:', SUCCESS_LOG_FILE);
  } catch (e) {
    console.error('[Venda][OK] falha ao gravar log:', e?.message || e);
  }
}


async function notifyAdminVendaFalha(entry) {
  try {
    const appName = process.env.APP_NAME || 'Turin Transportes';
    const fromName = process.env.SUPPORT_FROM_NAME || appName;
    const fromEmail =
      process.env.SUPPORT_FROM_EMAIL || process.env.SMTP_USER;

    const subject =
      `[${appName}] Falha na emissão de bilhete (payment ${entry?.mpPaymentId || entry?.payment?.id || '—'})`;

    const body = [
      'Falha na emissão do bilhete após pagamento aprovado.',
      '',
      `Erro: ${entry.errorMessage || entry.error || '(sem mensagem)'}`,
      '',
      'Dados da venda/pagamento:',
      JSON.stringify(entry, null, 2),
    ].join('\n');

    let sent = false;
    try {
      const got = await ensureTransport();
      if (got.transporter) {
        await got.transporter.sendMail({
          from: `"${fromName}" <${fromEmail}>`,
          to: ADMIN_ALERT_EMAIL,
          subject,
          text: body,
        });
        console.log('[Venda][Erro] alerta enviado via SMTP para', ADMIN_ALERT_EMAIL);
        sent = true;
      }
    } catch (e) {
      console.error('[Venda][Erro] falha ao enviar alerta via SMTP:', e?.message || e);
    }

    // fallback Brevo
    if (!sent) {
      await sendViaBrevoApi({
        to: ADMIN_ALERT_EMAIL,
        subject,
        html: body.replace(/\n/g, '<br>'),
        text: body,
        fromEmail,
        fromName,
      });
      console.log('[Venda][Erro] alerta enviado via Brevo para', ADMIN_ALERT_EMAIL);
    }
  } catch (e) {
    console.error('[Venda][Erro] falha ao enviar e-mail de alerta:', e?.message || e);
  }
}


// === serviços de bilhete (PDF) ===
const { mapVendaToTicket } = require('./services/ticket/mapper');
const { generateTicketPdf } = require('./services/ticket/pdf');

const app = express();
app.use(express.json({ limit: '2mb' }));
const PUBLIC_DIR = path.join(__dirname, 'sitevendas');
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
function computeGroupId(req, payment, schedule) {
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
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(z).reduce((a, p) => (a[p.type] = p.value, a), {});
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

  // fallback (ex.: idaVoltaDefault do bundle)
  return (String(fallback).toLowerCase() === 'volta') ? 'Volta' : 'Ida';
}


// Converte “2025-11-03 10:48” -> “2025-11-03T10:48-03:00”
const toISO3 = (s) => s ? (s.replace(' ', 'T') + '-03:00') : '';


// === Grava / atualiza bilhetes no Sheets (usa Referencia) ===
async function sheetsAppendBilhetes({
  bilhetes,
  schedule,
  payment,
  userEmail,
  userPhone,
  idaVoltaDefault
}) {
  try {
    if (!Array.isArray(bilhetes) || !bilhetes.length) {
      return { ok: true, appended: 0, updated: 0 };
    }

    const sheets = await sheetsAuthRW();
    const spreadsheetId = process.env.SHEETS_BPE_ID;
    const range = process.env.SHEETS_BPE_RANGE || 'BPE!A:AK';

    const extRef = String(payment?.external_reference || '').trim();

    // --- infos de pagamento (comissão, líquido, tipo, forma etc.) ---
    const mpAmount = Number(payment?.transaction_amount || 0);
    const mpFee =
      Number(payment?.fee_details?.[0]?.amount || 0) ||
      Number(payment?.fee_amount || 0);
    const fee = mpFee;
    const net = mpAmount - fee;

    const mpType = String(payment?.payment_type_id || '').toLowerCase(); // credit_card, debit_card, ...
    const mpMethod = String(
      payment?.payment_method_id || payment?.payment_method?.id || ''
    ).toLowerCase(); // ex.: 'pix'

    const isPix = mpMethod === 'pix';

    const tipoPagamento = isPix ? '8' : '3'; // 8=PIX, 3=Cartão (crédito/débito)
    const forma =
      isPix
        ? 'PIX'
        : mpType === 'debit_card'
          ? 'Cartão de Débito'
          : 'Cartão de Crédito';


    const chId = String(payment?.id || '');
    const pagoSP = nowSP(); // data/hora pagamento no fuso -03:00

    const scheduleDate = schedule?.date || '';
    const scheduleHora = (schedule?.horaPartida || '').toString().slice(0, 5);
    const dataViagemDefault = scheduleDate;
    const dataHoraViagemDefault =
      scheduleDate && scheduleHora
        ? `${scheduleDate} ${scheduleHora}`
        : (scheduleDate || scheduleHora || '');

    const userPhoneDigits = String(userPhone || '').replace(/\D/g, '');
    const telefoneSheet = userPhoneDigits ? `55${userPhoneDigits}` : '';

    // ================================================================
    // 1) Lê o Sheets para tentar achar linhas da pré-reserva por Referencia
    // ================================================================
    let rows = [];
    let header = [];
    let headerNorm = [];

    const norm = (s) =>
      String(s || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase();

    const getIdx = (...names) => {
      const want = names.map(norm);
      return headerNorm.findIndex((h) => want.includes(h));
    };

    let hasPreReserva = false;

    if (extRef) {
      const read = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range
      });

      rows = read.data.values || [];
      if (rows.length) {
        header = rows[0].map((h) => (h || '').toString().trim());
        headerNorm = header.map(norm);

        const idxRef = getIdx('referencia');

        if (idxRef >= 0) {
          // verifica se existe pelo menos uma linha com essa Referencia
          hasPreReserva = rows.some((row, i) => {
            if (i === 0) return false;
            return String(row[idxRef] || '').trim() === extRef;
          });
        }
      }
    }

    // ================================================================
    // 2) Se NÃO houver pré-reserva, mantém comportamento antigo (append)
    // ================================================================
    if (!hasPreReserva) {
      const dataViagem = dataViagemDefault;
      const dataHoraViagem = dataHoraViagemDefault;

      const values = bilhetes.map((b) => {
        const sentido = b?.idaVolta
          ? String(b.idaVolta).toLowerCase() === 'volta'
            ? 'Volta'
            : 'Ida'
          : (String(idaVoltaDefault).toLowerCase() === 'volta'
            ? 'Volta'
            : 'Ida');

        return [
          nowSP(),                                // Data/horaSolicitação
          b.nomeCliente || '',                    // Nome
          telefoneSheet,                          // Telefone
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
          tipoPagamento,                          // TipoPagamento
          '',                                     // correlationID
          '',                                     // idURL
          extRef,                                 // Referencia
          forma,                                  // Forma_Pagamento
          '',                                     // idUser (pode preencher depois se quiser)
          dataViagem,                             // Data_Viagem
          dataHoraViagem,                         // Data_Hora
          b.origem || schedule?.originName || schedule?.origem || '',         // Origem
          b.destino || schedule?.destinationName || schedule?.destino || '',  // Destino
          '',                                     // Identificador
          payment?.id || '',                      // idPagamento
          b.driveUrl || '',                       // LinkBPE
          b.poltrona || '',                        // Poltrona
          schedule?.idViagem || '',              // IdViagem  (nova)
          schedule?.idOrigem || '',              // IdOrigem  (nova)
          schedule?.idDestino || '',              // IdDestino (nova)
          scheduleHora                               // Hora_Partida (nova)
        ];
      });

      if (!values.length) return { ok: true, appended: 0, updated: 0 };

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values }
      });

      console.log('[Sheets] append ok (sem pré-reserva):', values.length, 'linhas');
      return { ok: true, appended: values.length, updated: 0 };
    }

    // ================================================================
    // 3) Há pré-reserva → atualiza linhas existentes (upsert por Referencia+Poltrona)
    // ================================================================
    const idxRef = getIdx('referencia');
    const idxNumPassagem = getIdx('numpassagem', 'bilhete');
    const idxStatus = getIdx('status');
    const idxStatusPay = getIdx('statuspagamento');
    const idxValorLiq = getIdx('valorliquido');
    const idxComissao = getIdx('comissaomp');
    const idxDataPgto = getIdx('datahorapagamento', 'datahora_pagamento');
    const idxIdTrans = getIdx('id_transacao', 'idtransacao');
    const idxTipoPay = getIdx('tipopagamento');
    const idxFormaPay = getIdx('forma_pagamento', 'formapagamento');
    const idxIdPag = getIdx('idpagamento');
    const idxLinkBPE = getIdx('linkbpe');
    const idxPoltrona = getIdx('poltrona');
    const idxNome = getIdx('nome');
    const idxCpf = getIdx('cpf');
    const idxEmail = getIdx('email', 'e-mail');
    const idxTelefone = getIdx('telefone', 'celular');
    const idxDataViagem = getIdx('data_viagem', 'dataviagem');
    const idxDataHora = getIdx('data_hora', 'datahora');
    const idxOrigem = getIdx('origem');
    const idxDestino = getIdx('destino');
    const idxSentido = getIdx('sentido');
    const idxIdViagem = getIdx('idviagem');
    const idxIdOrigem = getIdx('idorigem');
    const idxIdDestino = getIdx('iddestino');
    const idxHoraPartida = getIdx('hora_partida', 'horapartida');

    const usedRows = new Set();
    const updates = [];

    const dataViagem = dataViagemDefault;
    const horaPartida = scheduleHora;
    const dataHoraViagem = dataHoraViagemDefault;

    // helper: encontra linha da pré-reserva para um bilhete (por Referencia + Poltrona)
    const findRowForBilhete = (b) => {
      const seat = String(b.poltrona || b.seatNumber || '').trim();
      for (let i = 1; i < rows.length; i++) {
        if (usedRows.has(i)) continue;
        const row = rows[i] || [];
        if (idxRef >= 0 && String(row[idxRef] || '').trim() !== extRef) continue;
        if (idxPoltrona >= 0 && seat) {
          if (String(row[idxPoltrona] || '').trim() !== seat) continue;
        }
        // achou candidato
        usedRows.add(i);
        return i;
      }
      return -1;
    };

    for (const b of bilhetes) {
      const rowIndex = findRowForBilhete(b);
      if (rowIndex < 0) {
        // não achou linha correspondente → deixa para um futuro append se quiser
        continue;
      }

      const oldRow = rows[rowIndex] || [];
      const newRow = [...oldRow];

      const sentido = b?.idaVolta
        ? String(b.idaVolta).toLowerCase() === 'volta'
          ? 'Volta'
          : 'Ida'
        : (String(idaVoltaDefault).toLowerCase() === 'volta'
          ? 'Volta'
          : 'Ida');

      if (idxNumPassagem >= 0) newRow[idxNumPassagem] = b.numPassagem || newRow[idxNumPassagem] || '';
      if (idxStatus >= 0) newRow[idxStatus] = 'Emitido';
      if (idxStatusPay >= 0) newRow[idxStatusPay] = String(payment?.status || '');
      if (idxValorLiq >= 0) newRow[idxValorLiq] = String(net).toString().replace('.', ',');
      if (idxComissao >= 0) newRow[idxComissao] = String(fee).toString().replace('.', ',');
      if (idxDataPgto >= 0) newRow[idxDataPgto] = pagoSP;
      if (idxIdTrans >= 0) newRow[idxIdTrans] = chId;
      if (idxTipoPay >= 0) newRow[idxTipoPay] = tipoPagamento;
      if (idxFormaPay >= 0) newRow[idxFormaPay] = forma;
      if (idxIdPag >= 0) newRow[idxIdPag] = payment?.id || newRow[idxIdPag] || '';
      if (idxLinkBPE >= 0) newRow[idxLinkBPE] = b.driveUrl || newRow[idxLinkBPE] || '';

      if (idxNome >= 0 && b.nomeCliente) newRow[idxNome] = b.nomeCliente;
      if (idxCpf >= 0 && b.docCliente) newRow[idxCpf] = b.docCliente;
      if (idxEmail >= 0 && userEmail) newRow[idxEmail] = userEmail;
      if (idxTelefone >= 0 && telefoneSheet) newRow[idxTelefone] = telefoneSheet;

      if (idxDataViagem >= 0 && dataViagem) newRow[idxDataViagem] = dataViagem;
      if (idxDataHora >= 0 && dataHoraViagem) newRow[idxDataHora] = dataHoraViagem;
      if (idxOrigem >= 0)
        newRow[idxOrigem] = b.origem || schedule?.originName || schedule?.origem || newRow[idxOrigem] || '';
      if (idxDestino >= 0)
        newRow[idxDestino] = b.destino || schedule?.destinationName || schedule?.destino || newRow[idxDestino] || '';
      if (idxSentido >= 0) newRow[idxSentido] = sentido;

      if (idxIdViagem >= 0 && schedule?.idViagem) newRow[idxIdViagem] = schedule.idViagem;
      if (idxIdOrigem >= 0 && schedule?.idOrigem) newRow[idxIdOrigem] = schedule.idOrigem;
      if (idxIdDestino >= 0 && schedule?.idDestino) newRow[idxIdDestino] = schedule.idDestino;
      if (idxHoraPartida >= 0 && horaPartida) newRow[idxHoraPartida] = horaPartida;

      updates.push({ rowNumber: rowIndex + 1, values: newRow });
    }

    if (!updates.length) {
      console.log('[Sheets] não encontrou linhas p/ atualizar, nenhuma alteração feita.');
      return { ok: true, appended: 0, updated: 0 };
    }

    const tab = (range.includes('!') ? range.split('!')[0] : 'BPE');

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates.map((u) => ({
          range: `${tab}!A${u.rowNumber}:AK${u.rowNumber}`,
          values: [u.values]
        }))
      }
    });

    console.log('[Sheets] update ok (pré-reserva → emitido):', updates.length, 'linhas');
    return { ok: true, appended: 0, updated: updates.length };
  } catch (e) {
    console.error('[Sheets] append/upsert erro:', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}


// === Pré-reserva no Sheets (1 linha por bilhete, antes do pagamento) ===
app.post('/api/sheets/pre-reserva', async (req, res) => {
  try {
    const {
      external_reference,
      userEmail = '',
      userPhone = '',
      bilhetes = []
    } = req.body || {};

    if (!external_reference || !Array.isArray(bilhetes) || !bilhetes.length) {
      return res.status(400).json({
        ok: false,
        error: 'external_reference e bilhetes são obrigatórios.'
      });
    }

    const sheets = await sheetsAuthRW();
    const spreadsheetId = process.env.SHEETS_BPE_ID;
    const range = process.env.SHEETS_BPE_RANGE || 'BPE!A:AK';

    const phoneDigits = String(userPhone || '').replace(/\D/g, '');
    const phoneSheet = phoneDigits ? `55${phoneDigits}` : '';

    const now = nowSP();

    const values = bilhetes.map((b) => {
      const dataViagem = b.dataViagem || b.date || '';
      const horaPartida = (b.horaPartida || '').toString().slice(0, 5);
      const dataHoraViagem = dataViagem && horaPartida
        ? `${dataViagem} ${horaPartida}`
        : (dataViagem || horaPartida);

      const sentido = (String(b.idaVolta || '').toLowerCase() === 'volta')
        ? 'Volta'
        : 'Ida';

      const nome = b.nomeCliente || b.nome || '';
      const doc = String(b.docCliente || b.cpf || b.document || '')
        .replace(/\D/g, '');

      const valorNumber =
        Number(String(b.valor || b.price || 0).replace(',', '.')) || 0;
      const valor = valorNumber.toFixed(2);

      return [
        now,                    // Data/horaSolicitação
        nome,                   // Nome
        phoneSheet,             // Telefone
        userEmail,              // E-mail
        doc,                    // CPF
        valor,                  // Valor
        '2',                    // ValorConveniencia
        '',                     // ComissaoMP
        '',                     // ValorLiquido
        '',                     // NumPassagem
        '93',                   // SeriePassagem
        'Aguardando pagamento', // StatusPagamento
        'Pendente',             // Status
        '',                     // ValorDevolucao
        sentido,                // Sentido
        '',                     // Data/hora_Pagamento
        '',                     // NomePagador
        '',                     // CPF_Pagador
        '',                     // ID_Transação
        '',                     // TipoPagamento
        '',                     // correlationID
        '',                     // idURL
        external_reference,     // Referencia
        '',                     // Forma_Pagamento
        '',                     // idUser
        dataViagem,             // Data_Viagem
        dataHoraViagem,         // Data_Hora
        b.origemNome || b.origem || '',   // Origem
        b.destinoNome || b.destino || '',   // Destino
        '',                     // Identificador
        '',                     // idPagamento
        '',                     // LinkBPE
        b.poltrona || b.seatNumber || '',   // Poltrona
        b.idViagem || b.id_viagem || '',  // IdViagem  (NOVA COLUNA)
        b.idOrigem || b.id_origem || '',  // IdOrigem  (NOVA COLUNA)
        b.idDestino || b.id_destino || '',  // IdDestino (NOVA COLUNA) 
        horaPartida             // Hora_Partida (NOVA COLUNA)

      ];
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values }
    });

    console.log('[Sheets][pre-reserva] append ok:', values.length, 'linhas');

    return res.json({ ok: true, appended: values.length });
  } catch (e) {
    console.error('[Sheets][pre-reserva] erro:', e);
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
  }
});


// normaliza texto: minúsculo, sem acento e sem sinais
const norm = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/gi, '').toLowerCase();

app.get('/api/sheets/bpe-by-email', async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'email é obrigatório' });

    const sheets = await sheetsAuth();
    const spreadsheetId = process.env.SHEETS_BPE_ID;
    const range = process.env.SHEETS_BPE_RANGE || 'BPE!A:AK';

    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = r.data.values || [];
    if (!rows.length) return res.json({ ok: true, items: [] });

    const headerRaw = rows[0].map(h => (h || '').toString().trim());
    const header = headerRaw.map(norm);

    const idxOf = (...names) => {
      const want = names.map(norm);
      return header.findIndex(h => want.includes(h));
    };
    const get = (row, idx) => (idx >= 0 && row[idx] != null) ? String(row[idx]).trim() : '';

    // índices necessárias
    const idxEmail = idxOf('email', 'e-mail');
    const idxNum = idxOf('numpassagem', 'bilhete');
    const idxSerie = idxOf('seriepassagem');
    const idxStatusPay = idxOf('statuspagamento');
    const idxStatus = idxOf('status');
    const idxValor = idxOf('valor');
    const idxValorConv = idxOf('valorconveniencia');
    const idxValorDev = idxOf('valordevolucao');
    const idxDataPgto = idxOf('datahorapagamento', 'datahora_pagamento');
    const idxDataViagem = idxOf('dataviagem', 'data_viagem');
    const idxDataHora = idxOf('datahora', 'data_hora');
    const idxOrigem = idxOf('origem');
    const idxDestino = idxOf('destino');
    const idxSentido = idxOf('sentido');
    const idxCpf = idxOf('cpf');
    const idxNumTrans = idxOf('idtransacao', 'id_transacao', 'idtransação', 'id_transação');
    const idxTipoPgto = idxOf('tipopagamento');
    const idxRef = idxOf('referencia');
    const idxIdUser = idxOf('iduser');
    const idxLinkBPE = idxOf('linkbpe');
    const idxIdUrl = idxOf('idurl');
    const idxpoltrona = idxOf('poltrona');
    const idxNome = idxOf('nome');

    if (idxEmail < 0) return res.json({ ok: true, items: [] });

    const items = rows.slice(1)
      .filter(r => get(r, idxEmail).toLowerCase() === email)
      .map(r => {
        const dataHora = get(r, idxDataHora);
        const departureTime = dataHora.includes(' ')
          ? dataHora.split(' ')[1]
          : '';
        const price = get(r, idxValor).replace(',', '.');

        return {
          name: get(r, idxNome),
          email,
          ticketNumber: get(r, idxNum),
          serie: get(r, idxSerie),
          statusPagamento: get(r, idxStatusPay),
          status: get(r, idxStatus),
          price: price ? Number(price) : 0,
          valorConveniencia: get(r, idxValorConv),
          valorDevolucao: get(r, idxValorDev),
          paidAt: get(r, idxDataPgto),
          origin: get(r, idxOrigem),
          destination: get(r, idxDestino),
          date: get(r, idxDataViagem),
          dateTime: dataHora,
          departureTime,
          sentido: get(r, idxSentido),
          cpf: get(r, idxCpf),
          transactionId: get(r, idxNumTrans),
          paymentType: get(r, idxTipoPgto),
          referencia: get(r, idxRef),
          idUser: get(r, idxIdUser),
          driveUrl: get(r, idxLinkBPE) || get(r, idxIdUrl),
          poltrona: get(r, idxpoltrona)
        };
      });

    res.json({ ok: true, items });
  } catch (e) {
    console.error('[sheets] read error', e);
    res.status(500).json({ ok: false, error: 'sheets_read_failed' });
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

  // se vier "", extrai "BPE"
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

  const colA = String.fromCharCode(65 + col); // OK, Status está ali perto do M
  const a1 = `${tab}!${colA}${rowIndex + 1}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: a1,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[status]]
    }
  });

  console.log('[Sheets][Cancel] Linha', rowIndex + 1, 'Status <-', status);
}


// Helper to convert 0-based index to column letter (0->A, 25->Z, 26->AA)
function toColumnName(num) {
  let letter = '';
  while (num >= 0) {
    const temp = num % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    num = (num - temp) / 26 - 1;
  }
  return letter;
}

// Atualiza status de pagamento no Sheets usando a Referencia (Cirúrgico)
async function sheetsUpdatePaymentStatusByRef(externalReference, payment) {
  if (!externalReference) {
    console.warn('[Sheets][Pgto] externalReference vazio, nada a atualizar');
    return { ok: false, error: 'externalReference vazio' };
  }
  const sheets = getSheets();
  const { spreadsheetId, range, tab } = resolveSheetEnv(); // range ex: BPE!A:AG

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });

  const rows = read.data.values || [];
  if (!rows.length) {
    console.warn('[Sheets][Pgto] Nenhuma linha na aba BPE');
    return { ok: false, error: 'aba vazia' };
  }

  const header = rows[0].map(v => String(v || '').trim());
  const findCol = (name) =>
    header.findIndex(h => h.toLowerCase() === name.toLowerCase());

  const colRef = findCol('Referencia');
  const colStatus = findCol('Status');
  const colStatusPg = findCol('StatusPagamento');
  const colIdPg = findCol('idPagamento');
  const colDtPag = findCol('Data/hora_Pagamento'); // [NEW] Coluna de data de pagamento
  const colTipoPg = findCol('TipoPagamento');
  const colFormaPg = findCol('Forma_Pagamento');
  const colIdTransacao = findCol('ID_Transação');

  if (colRef < 0) {
    console.warn('[Sheets][Pgto] Coluna "Referencia" não encontrada no header');
    return { ok: false, error: 'coluna Referencia não encontrada' };
  }

  const statusMP = String(payment?.status || '').toLowerCase();
  const statusPagamento =
    (statusMP === 'approved' || statusMP === 'accredited')
      ? 'approved'
      : (statusMP === 'pending'
        ? 'Pendente'
        : (statusMP === 'rejected' ? 'Rejeitado' : payment?.status || ''));

  const mpType = String(payment?.payment_type_id || payment?.payment_method_id || '').toLowerCase();
  const forma =
    mpType === 'pix' ? 'PIX'
      : mpType === 'debit_card' ? 'Cartão de Débito'
        : mpType === 'credit_card' ? 'Cartão de Crédito'
          : (payment?.payment_method_id || '').toString().toUpperCase();

  const tipo =
    mpType === 'pix' ? '8'
      : (mpType === 'debit_card' || mpType === 'credit_card') ? '3'
        : '';

  const idPagamento = payment?.id ? String(payment.id) : '';
  const idTransacao = payment?.transaction_details?.external_resource_url
    || payment?.transaction_amount
    || '';

  // Helper de data
  const formatDateBR = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = n => n < 10 ? '0' + n : n;
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const dtPagamento = formatDateBR(payment?.date_approved || payment?.date_created);


  const dataToUpdate = [];

  rows.forEach((row, idx) => {
    if (idx === 0) return; // header
    const currentRef = String(row[colRef] || '').trim();

    if (currentRef !== String(externalReference).trim()) {
      return;
    }

    const rowNumber = idx + 1; // 1-based index

    // Helper para adicionar ao batch
    const addUpdate = (colIdx, val) => {
      if (colIdx >= 0 && val !== undefined && val !== null) {
        dataToUpdate.push({
          range: `${tab}!${toColumnName(colIdx)}${rowNumber}`,
          values: [[val]]
        });
      }
    };

    // Atualiza colunas de pagamento (Sempre)
    addUpdate(colStatusPg, statusPagamento);
    addUpdate(colIdPg, idPagamento);
    addUpdate(colDtPag, dtPagamento); // [NEW] Grava data
    addUpdate(colTipoPg, tipo);
    addUpdate(colFormaPg, forma);
    addUpdate(colIdTransacao, String(idTransacao));

    // Atualiza coluna Status SOMENTE SE estiver vazia (Protege "Cancelado")
    if (colStatus >= 0) {
      const currentStatus = String(row[colStatus] || '').trim();
      if (!currentStatus) {
        addUpdate(colStatus, 'Pendente');
      }
    }
  });

  if (!dataToUpdate.length) {
    console.log('[Sheets][Pgto] Nenhuma linha encontrada (ou nada a atualizar) para ref =', externalReference);
    return { ok: true, updated: 0 };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: dataToUpdate
    }
  });

  console.log('[Sheets][Pgto] Atualizadas', dataToUpdate.length, 'células para referencia', externalReference);
  return { ok: true, updated: dataToUpdate.length };
}


// === Helpers para trabalhar com a planilha BPE por "Referencia" ===
async function sheetsFindByRef(externalRef) {
  const spreadsheetId = process.env.SHEETS_BPE_ID;
  const range = process.env.SHEETS_BPE_RANGE || 'BPE!A:AK';

  const sheets = await sheetsAuthRW();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = resp.data.values || [];
  if (!values.length) return { header: [], entries: [] };

  const header = values[0];
  const idx = (name) => header.indexOf(name);

  const col = {
    dataSolic: idx('Data/horaSolicitação'),
    nome: idx('Nome'),
    telefone: idx('Telefone'),
    email: idx('E-mail'),
    cpf: idx('CPF'),
    valor: idx('Valor'),
    statusPag: idx('StatusPagamento'),
    status: idx('Status'),
    sentindo: idx('Sentido'),
    dtPag: idx('Data/hora_Pagamento'),
    idTransacao: idx('ID_Transação'),
    tipoPagamento: idx('TipoPagamento'),
    formaPag: idx('Forma_Pagamento'),
    ref: idx('Referencia'),
    numPassagem: idx('NumPassagem'),
    seriePassagem: idx('SeriePassagem'),
    origem: idx('Origem'),
    destino: idx('Destino'),
    dataViagem: idx('Data_Viagem'),
    horaPartida: idx('Hora_Partida'),
    poltrona: idx('poltrona'),
    idViagem: idx('IdViagem'),
    idOrigem: idx('IdOrigem'),
    idDestino: idx('IdDestino'),
  };

  const norm = (v) => (v || '').toString().trim();

  const entries = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const refVal = col.ref >= 0 ? norm(row[col.ref]) : '';
    if (!refVal) continue;
    if (refVal !== norm(externalRef)) continue;

    entries.push({
      rowIndex: i + 1,         // linha real na planilha (1-based)
      raw: row,
      status: col.status >= 0 ? norm(row[col.status]) : '',
      statusPag: col.statusPag >= 0 ? norm(row[col.statusPag]) : '',
      numPassagem: col.numPassagem >= 0 ? norm(row[col.numPassagem]) : '',
      nome: col.nome >= 0 ? norm(row[col.nome]) : '',
      cpf: col.cpf >= 0 ? norm(row[col.cpf]) : '',
      telefone: col.telefone >= 0 ? norm(row[col.telefone]) : '',
      email: col.email >= 0 ? norm(row[col.email]) : '',
      valor: col.valor >= 0 ? norm(row[col.valor]) : '',
      sentido: col.sentindo >= 0 ? norm(row[col.sentindo]) : '',
      origem: col.origem >= 0 ? norm(row[col.origem]) : '',
      destino: col.destino >= 0 ? norm(row[col.destino]) : '',
      dataViagem: col.dataViagem >= 0 ? norm(row[col.dataViagem]) : '',
      horaPartida: col.horaPartida >= 0 ? norm(row[col.horaPartida]) : '',
      poltrona: col.poltrona >= 0 ? norm(row[col.poltrona]) : '',
      idViagem: col.idViagem >= 0 ? norm(row[col.idViagem]) : '',
      idOrigem: col.idOrigem >= 0 ? norm(row[col.idOrigem]) : '',
      idDestino: col.idDestino >= 0 ? norm(row[col.idDestino]) : '',
    });
  }

  return { header, entries };
}



async function sheetsDeleteRowsByRef(externalRef) {
  if (!externalRef) return;

  const spreadsheetId = process.env.SHEETS_BPE_ID;
  const range = process.env.SHEETS_BPE_RANGE || 'BPE!A:AK';

  const sheets = await sheetsAuthRW();

  // lê valores para descobrir quais linhas têm essa referência
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const values = resp.data.values || [];
  if (values.length <= 1) return; // só cabeçalho

  const header = values[0];
  const idxRef = header.indexOf('Referencia');
  if (idxRef < 0) return;

  const norm = (v) => (v || '').toString().trim();
  const rowsToDelete = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const refVal = norm(row[idxRef]);
    if (refVal && refVal === norm(externalRef)) {
      rowsToDelete.push(i); // índice relativo ao sheet (0 = cabeçalho)
    }
  }

  if (!rowsToDelete.length) return;

  // pega sheetId da aba BPE
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === (range.split('!')[0] || 'BPE')
  );
  if (!sheet) return;

  const sheetId = sheet.properties.sheetId;

  // deleta de baixo pra cima pra não deslocar
  const requests = rowsToDelete
    .sort((a, b) => b - a)
    .map((rowIdx) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: rowIdx,
          endIndex: rowIdx + 1,
        },
      },
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}




async function emitirBilhetesViaWebhook(payment) {
  const extRef = (payment?.external_reference || '').trim();
  if (!extRef) {
    console.warn('[Webhook][Emit] pagamento sem external_reference, ignorando');
    return;
  }

  const { entries } = await sheetsFindByRef(extRef);
  if (!entries || !entries.length) {
    console.log('[Webhook][Emit] nenhuma linha encontrada no Sheets para', extRef);
    return;
  }

  // se já tem pelo menos 1 linha emitida / com NumPassagem, não vende de novo
  const jaEmitido = entries.some(e => {
    const st = (e.status || '').toLowerCase();
    const temNum = !!(e.numPassagem || '');
    return st === 'emitido' || temNum;
  });

  if (jaEmitido) {
    console.log('[Webhook][Emit] já existe emissão no Sheets para', extRef);
    return;
  }

  // agrupa por viagem (ida / volta)
  const grupos = new Map(); // key -> { schedule, passageiros, idaVolta }
  for (const e of entries) {
    const key = [
      e.idViagem || '',
      e.idOrigem || '',
      e.idDestino || '',
      e.dataViagem || '',
      e.horaPartida || '',
      (e.sentido || '').toLowerCase()
    ].join('|');

    let g = grupos.get(key);
    if (!g) {
      const idaVolta = (e.sentido || '').toLowerCase().startsWith('volta') ? 'volta' : 'ida';
      g = {
        schedule: {
          idViagem: e.idViagem,
          idOrigem: e.idOrigem,
          idDestino: e.idDestino,
          dataViagem: e.dataViagem,
          date: e.dataViagem,
          horaPartida: e.horaPartida,
          origem: e.origem,
          destino: e.destino,
          originName: e.origem,
          destinationName: e.destino,
        },
        idaVolta,
        passageiros: [],
      };
      grupos.set(key, g);
    }

    g.passageiros.push({
      seatNumber: e.poltrona,
      name: e.nome,
      document: e.cpf,
      price: e.valor ? Number(e.valor.replace(',', '.')) : undefined,
      phone: e.telefone,
    });
  }

  const PORT = process.env.PORT || 8080;
  const serverBase = `http://127.0.0.1:${PORT}`;

  const allEntries = entries;
  /* const firstEntry = allEntries[0] || {};
   const userEmail = firstEntry.email || '';
   const userPhone = firstEntry.telefone || '';*/
  const firstEntry = allEntries[0] || {};

  // ✅ começa pelo Sheets, mas completa com Mercado Pago se vier vazio
  const userEmail =
    firstEntry.email ||
    payment?.payer?.email ||
    payment?.additional_info?.payer?.email ||
    '';

  const userPhone =
    firstEntry.telefone ||
    payment?.payer?.phone?.number ||
    payment?.additional_info?.payer?.phone?.number ||
    '';


  for (const g of grupos.values()) {
    const totalAmount = g.passageiros.reduce((sum, p) => sum + (p.price || 0), 0)
      || Number(payment.transaction_amount || 0);

    const body = {
      mpPaymentId: payment.id,
      schedule: g.schedule,
      passengers: g.passageiros,
      totalAmount,
      idEstabelecimentoVenda: '1',
      idEstabelecimentoTicket: g.schedule.agencia || '93',
      serieBloco: '93',
      userEmail,
      userPhone,
      idaVolta: g.idaVolta,
    };

    try {
      console.log('[Webhook][Emit] chamando /api/praxio/vender via webhook', body.schedule);

      const r = await fetch(`${serverBase}/api/praxio/vender`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Source': 'mp-webhook' },
        body: JSON.stringify(body),
      });

      // lê como texto primeiro
      const raw = await r.text().catch(() => '');
      let responseJson = {};
      try {
        responseJson = raw ? JSON.parse(raw) : {};
      } catch {
        responseJson = {};
      }

      console.log('[Webhook][Emit] /api/praxio/vender response', {
        status: r.status,
        ok: r.ok,
        bodyOk: responseJson?.ok,
        bodySnippet: raw ? raw.slice(0, 250) : ''
      });

      if (!r.ok || !responseJson.ok) {
        console.error('[Webhook][Emit] Falha ao vender via webhook:', r.status, responseJson);
      }


    } catch (err) {
      console.error('[Webhook][Emit] Erro HTTP ao chamar /api/praxio/vender:', err);
    }
  }
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



app.get('/api/mp/wait-flush', async (req, res) => {
  try {
    const paymentId = String(req.query.paymentId || '').trim();
    if (!paymentId) return res.status(400).json({ ok: false, error: 'paymentId é obrigatório' });

    // 1) se já flushou recentemente (AGGR deletado), responde ok imediatamente
    if (AGGR_FLUSHED_RECENT.has(paymentId)) {
      return res.json({ ok: true, flushed: true, note: 'recently_flushed' });
    }

    // 2) tenta achar a entrada; se não existir, espera um pouco para caso o webhook esteja começando agora
    let e = AGGR.get(paymentId);
    if (!e) {
      const GIVE_TIME_MS = 3000;
      const step = 150;
      const t0 = Date.now();
      while (!e && (Date.now() - t0) < GIVE_TIME_MS) {
        await new Promise(r => setTimeout(r, step));
        e = AGGR.get(paymentId);
      }
    }

    // 3) se ainda não existe, não cria entrada vazia (isso gera timeout no PIX).
    //    Aqui significa: ou já terminou e foi deletado, ou não temos nada pra esperar.
    if (!e) {
      return res.json({ ok: true, flushed: true, note: 'no_aggr_entry' });
    }

    // 4) se já flushei, devolve
    if (e.flushed) return res.json({ ok: true, flushed: true });

    // 5) aguarda flush real
    const TIMEOUT = Math.max(AGGR_MAX_WAIT_MS, AGGR_DEBOUNCE_MS + 5000);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), TIMEOUT);
      (e.waiters || (e.waiters = [])).push(() => {
        try { clearTimeout(t); } catch { }
        resolve();
      });
    });

    return res.json({ ok: true, flushed: true });
  } catch (err) {
    console.warn('[AGGR] wait-flush erro:', err);
    return res.status(200).json({ ok: true, flushed: false, note: 'fallback' });
  }
});






/*
app.get('/api/mp/wait-flush', async (req, res) => {
  try {
    const paymentId = String(req.query.paymentId || '').trim();
    if (!paymentId) {
      return res.status(400).json({ ok: false, error: 'paymentId é obrigatório' });
    }

    // garante que exista uma entrada no AGGR para poder pendurar "waiters"
    let e = AGGR.get(paymentId);
    if (!e) {
      e = {
        timer: null,
        startedAt: Date.now(),
        base: {},
        bilhetes: [],
        arquivos: [],
        emailAttachments: [],
        expected: 0,
        flushed: false,
        waiters: []
      };
      AGGR.set(paymentId, e);
    }

    // se já flushei, não preciso esperar
    if (e.flushed) {
      return res.json({ ok: true, flushed: true });
    }

    // ainda pendente → aguarda o flush do agregador com timeout de segurança
    const TIMEOUT = Math.max(AGGR_MAX_WAIT_MS, AGGR_DEBOUNCE_MS + 5000); // ~40s
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), TIMEOUT);
      (e.waiters || (e.waiters = [])).push(() => {
        try { clearTimeout(t); } catch {}
        resolve();
      });
    });

    return res.json({ ok: true, flushed: true });
  } catch (err) {
    console.warn('[AGGR] wait-flush erro:', err);
    // fallback: não travar a UX, mas indicar que não temos certeza se flushei
    return res.status(200).json({ ok: true, flushed: false, note: 'fallback' });
  }
});

*/






app.post('/api/mp/webhook', async (req, res) => {
  try {
    console.log('[MP][Webhook] body:', JSON.stringify(req.body));


    console.log('[MP][Webhook] HIT', {
      host: req.headers.host,
      xf_host: req.headers['x-forwarded-host'],
      xf_proto: req.headers['x-forwarded-proto'],
      url: req.originalUrl,
      at: new Date().toISOString(),
    });



    const topic = req.body?.type || req.query?.type;
    const action = req.body?.action || req.query?.action;
    const dataId =
      req.body?.data?.id ||
      req.query?.['data.id'] ||
      req.query?.id ||
      null;

    // Só tratamos notificações de pagamento com id válido
    if (topic !== 'payment' || !dataId) {
      console.log('[MP][Webhook] ignorado. topic=', topic, 'id=', dataId);
      return res.status(200).json({ ok: true, ignored: true });
    }

    const paymentId = String(dataId);
    console.log('[MP][Webhook] consultando pagamento', paymentId);

    const payment = await mpGetPayment(paymentId);
    console.log(
      '[MP][Webhook] status:',
      payment?.status,
      'external_reference:',
      payment?.external_reference
    );

    // Descobre método de pagamento
    const mpType = String(payment?.payment_type_id || '').toLowerCase();
    const mpMethod = String(
      payment?.payment_method_id || payment?.payment_method?.id || ''
    ).toLowerCase();

    const isPix = mpMethod === 'pix';


    const extRef = payment?.external_reference || null;
    if (extRef) {
      // 1) Atualiza status de pagamento na pré-reserva
      await sheetsUpdatePaymentStatusByRef(extRef, payment);
    } else {
      console.warn('[MP][Webhook] pagamento sem external_reference, não atualiza Sheets');
    }

    // 2) Se estiver efetivamente pago (approved/accredited), dispara emissão
    /*   const status = String(payment?.status || '').toLowerCase();
       const pago =
         status === 'approved' ||
         status === 'accredited';
   
       if (pago) {
         try {
           console.log('[MP][Webhook] pagamento pago, emitindo bilhetes via webhook...');
           await emitirBilhetesViaWebhook(payment);
         } catch (err) {
           console.error('[MP][Webhook] erro ao emitir bilhetes via webhook:', err?.message || err);
         }
       } else {
         console.log('[MP][Webhook] status ainda não pago, não emite. status=', status);
       }
   
       */


    const status = String(payment?.status || '').toLowerCase();
    const pago =
      status === 'approved' ||
      status === 'accredited';

    // A PARTIR DE AGORA:
    // - PIX: emissão automática via webhook
    // - Cartão (credit/debit): emissão feita no front (payment.js), webhook só atualiza Sheets
    if (pago && isPix) {
      try {
        console.log('[MP][Webhook] pagamento PIX pago, emitindo bilhetes via webhook...');
        await emitirBilhetesViaWebhook(payment);
      } catch (err) {
        console.error('[MP][Webhook] erro ao emitir bilhetes via webhook:', err?.message || err);
      }
    } else if (pago) {
      console.log(
        '[MP][Webhook] pagamento não-PIX pago (cartão). Emissão feita no front; webhook não chama Praxio.',
        'payment_type_id=', mpType,
        'method=', mpMethod
      );
    } else {
      console.log('[MP][Webhook] status ainda não pago, não emite. status=', status);
    }


    return res.status(200).json({ ok: true, processed: true });
  } catch (e) {
    console.error('[MP][Webhook] erro geral:', e?.response?.data || e);
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });
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
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.message || 'Falha no estorno do Mercado Pago'); e.details = j; throw e; }
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

    const idxValor = findCol(['Valor', 'ValorPago', 'ValorTotal', 'ValorTotalPago', 'Valor Total Pago']);
    const idxIdPg = findCol(['idPagamento', 'paymentId', 'idpagamento', 'idpagamentomp', 'id pagamento']);
    const idxCorr = findCol(['correlationID', 'x-idempotency-key', 'idempotency', 'idempotencykey']);

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
    let refundErroInterno = false;

    if (valorRefund > 0) {
      console.log(
        '[MP] POST refund url= https://api.mercadopago.com/v1/payments/' + paymentId + '/refunds',
        'body=', { amount: +Number(valorRefund).toFixed(2) },
        'headers:', { 'X-Idempotency-Key': correlationID || '(auto)' }
      );
      try {
        refund = await mpRefund({ paymentId, amount: valorRefund, idempotencyKey: correlationID });
        console.log('[MP] RES refund =>', JSON.stringify(refund).slice(0, 800));
      } catch (err) {
        const det =
          err?.details?.cause?.[0]?.description ||
          err?.details?.message ||
          err?.message ||
          '';

        console.error('[MP] refund erro:', det, err?.details || err);

        // Se for INTERNAL_ERROR do MP, não vamos quebrar o cancelamento,
        // só logar e avisar o suporte para fazer o estorno manual.
        if (String(det).toLowerCase().includes('internal_error')) {
          refundErroInterno = true;

          const entry = {
            stage: 'cancel-ticket-refund',
            numeroPassagem,
            paymentId,
            valorOriginal,
            valorRefundDesejado,
            valorRefundCalculado: valorRefund,
            total,
            refundedSoFar,
            disponivel,
            errorMessage: det,
            mpError: err?.details || err,
          };

          try {
            await logVendaFalha(entry);
            await notifyAdminVendaFalha(entry);
          } catch (inner) {
            console.error('[cancel-ticket] falha ao registrar erro de refund:', inner);
          }

          // mantém "refund" null; vamos devolver uma nota explicativa na resposta
        } else {
          // Outros erros continuam derrubando o cancelamento
          throw new Error(det || 'Falha ao estornar no Mercado Pago');
        }
      }
    } else {
      console.log('[MP] Sem valor disponível para estorno. valorRefund=', valorRefund, 'disponivel=', disponivel);
    }

    // 4) Sheets — marcar "Cancelado" (não falha a operação se o update quebrar)
    let planilha = { ok: true };
    try {
      // Re-busca a linha para garantir que não mudou (race condition com delete de pré-reservas)
      const fresh = await sheetsFindByBilhete(numeroPassagem);
      await sheetsUpdateStatus(fresh.rowIndex, 'Cancelado');
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
      mp: refund
        ? refund
        : (refundErroInterno
          ? { note: 'Cancelado na Praxio. Estorno não concluído no Mercado Pago (internal_error). Suporte será notificado.' }
          : { note: 'Sem estorno (indisponível).' }),
      planilha,

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
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .toLowerCase();

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

    const appName = process.env.APP_NAME || 'Turin Transportes';
    const fromName = process.env.SUPPORT_FROM_NAME || 'Turin Transportes';
    const fromEmail = process.env.SUPPORT_FROM_EMAIL || process.env.SMTP_USER;
    const from = `"${fromName}" <${fromEmail}>`;

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

// guarda "flush recente" para o wait-flush não dar timeout quando o AGGR já foi deletado
const AGGR_FLUSHED_RECENT = new Map(); // paymentId -> timestamp(ms)

setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of AGGR_FLUSHED_RECENT.entries()) {
    if (now - ts > 10 * 60 * 1000) AGGR_FLUSHED_RECENT.delete(k); // 10 min
  }
}, 60 * 1000);



const AGGR_DEBOUNCE_MS = 1500;   // ⬅️ 8s para juntar múltiplas chamadas
const AGGR_MAX_WAIT_MS = 120000;  // ⬅️ segurança 30s




function queueUnifiedSend(groupId, fragment, doFlushCb) {
  let e = AGGR.get(groupId);
  if (!e) {
    e = {
      timer: null, startedAt: Date.now(), base: {}, bilhetes: [], arquivos: [], emailAttachments: [],
      expected: 0, flushed: false, waiters: []
    };
    AGGR.set(groupId, e);
  }

  // merge base (último vence)
  e.base = { ...e.base, ...(fragment.base || {}) };

  // ❌ antes: if (fragment.expected > e.expected) e.expected = fragment.expected;
  // ✅ agora: somar o total esperado deste fragmento (ida + volta, etc.)
  // soma o esperado desta resposta (qtd de bilhetes)
  const addExpected = Number(fragment?.expected || 0);
  if (addExpected > 0) e.expected += addExpected;

  // acumula
  if (Array.isArray(fragment?.bilhetes)) e.bilhetes.push(...fragment.bilhetes);
  if (Array.isArray(fragment?.arquivos)) e.arquivos.push(...fragment.arquivos);
  if (Array.isArray(fragment?.emailAttachments)) e.emailAttachments.push(...fragment.emailAttachments);

  // de-dups
  const seenB = new Set();
  e.bilhetes = e.bilhetes.filter(b => {
    const k = `${b?.numPassagem || ''}|${b?.chaveBPe || ''}`;
    if (!k.trim() || seenB.has(k)) return false;
    seenB.add(k);
    return true;
  });
  const seenA = new Set();
  e.arquivos = e.arquivos.filter(a => {
    const k = `${a?.driveFileId || ''}|${a?.numPassagem || ''}|${a?.pdfLocal || ''}`;
    if (seenA.has(k)) return false;
    seenA.add(k);
    return true;
  });

  const tryFlush = async () => {
    if (e.flushed) return;

    const waited = (Date.now() - e.startedAt) >= AGGR_MAX_WAIT_MS;

    // ✅ agora só flusha quando TEMOS TODOS os anexos também
    const haveAllBilhetes = e.expected > 0 && e.bilhetes.length >= e.expected;
    const haveAllAnexos = e.expected > 0 && e.emailAttachments.length >= e.expected;

    if (!waited && !(haveAllBilhetes && haveAllAnexos)) return;

    e.flushed = true;
    clearTimeout(e.timer); e.timer = null;

    console.log(`[AGGR] flushing: expected=${e.expected} bilhetes=${e.bilhetes.length} anexos=${e.emailAttachments.length} waited=${waited}`);
    try { await doFlushCb({ ...e }); }
    finally {
      AGGR_FLUSHED_RECENT.set(String(groupId), Date.now());
      (e.waiters || []).forEach(fn => { try { fn(); } catch { } });
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
  const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 10000);
  const j = await r.json();
  if (!r.ok) throw new Error('VerificaDevolucao falhou');
  if (j?.IdErro) { const err = new Error(j?.Mensagem || 'Não é possível cancelar'); err.code = 'PRAXIO_BLOQUEADO'; throw err; }
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
  const r = await fetchWithTimeout(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 10000);
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
    const subDir = new Date().toISOString().slice(0, 10);
    const outDir = path.join(TICKETS_DIR, subDir);
    const pdf = await generateTicketPdf(ticket, outDir);
    const pdfUrl = `/tickets/${subDir}/${pdf.filename}`;
    res.json({
      ok: true, files: { pdf: pdfUrl }, ticket: {
        nome: ticket.nomeCliente, numPassagem: ticket.numPassagem, poltrona: ticket.poltrona,
        data: ticket.dataViagem, hora: ticket.horaPartida, origem: ticket.origem, destino: ticket.destino
      }
    });
  } catch (e) {
    console.error('ticket/render error:', e);
    res.status(400).json({ ok: false, error: e.message || 'Falha ao gerar bilhete' });
  }
});


/* =================== Venda Praxio + PDF + e-mail + Webhook agrupado =================== */
// === Idempotência de Processamento (Lock em memória) ===
const ISSUANCE_LOCK = new Map(); // mpPaymentId -> Promise
const COMPLETED_CACHE = new Map(); // mpPaymentId -> { status, body, timestamp }
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// Limpeza do cache
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of COMPLETED_CACHE.entries()) {
    if (now - v.timestamp > CACHE_TTL) COMPLETED_CACHE.delete(k);
  }
}, 60000);

app.post('/api/praxio/vender', async (req, res) => {
  const { mpPaymentId, passengers } = req.body || {};


  console.log('[Praxio][Venda] START', {
    source: req.get('X-Source') || 'front',
    mpPaymentId: req.body?.mpPaymentId,
    extRef: req.body?.external_reference || req.body?.reference || null,
    passageiros: Array.isArray(req.body?.passengers) ? req.body.passengers.length : 0,
    poltronas: (req.body?.passengers || []).map(p => p.seatNumber || p.seat || p.poltrona).filter(Boolean),
    userEmail: req.body?.userEmail || '',
    userPhone: req.body?.userPhone || ''
  });



  // 1) Gera chave GRANULAR: PaymentId + Poltronas
  // Evita que Item A devolva cache para Item B do mesmo pagamento
  const seatList = (passengers || []).map(p => String(p.seatNumber || p.poltrona || '')).filter(Boolean).sort();
  const lockKey = seatList.length
    ? `${mpPaymentId}::${seatList.join(',')}`
    : String(mpPaymentId || '');

  // 0.1) Verifica Cache de Concluídos
  if (lockKey && COMPLETED_CACHE.has(lockKey)) {
    console.log(`[Idem] Retornando resultado em cache para ${lockKey}`);
    const cached = COMPLETED_CACHE.get(lockKey);
    return res.status(cached.status).json(cached.body);
  }

  // 0.2) Se já existe um processamento para essa chave, aguarda
  if (lockKey && ISSUANCE_LOCK.has(lockKey)) {
    console.log(`[Idem] Aguardando processo existente para ${lockKey}...`);
    try {
      const result = await ISSUANCE_LOCK.get(lockKey);
      return res.status(result.status || 200).json(result.body);
    } catch (err) {
      console.error(`[Idem] Erro no processo aguardado (${lockKey}):`, err);
      return res.status(500).json({ ok: false, error: 'Falha no processamento anterior.' });
    }
  }

  // Função que encapsula toda a lógica de venda
  const processSale = async () => {
    try {
      const {
        // mpPaymentId,                 // MP payment id - já está no escopo superior
        schedule,                    // { idViagem, horaPartida, idOrigem, idDestino, ... }
        // passengers,                  // [{ seatNumber, name, document }] - já está no escopo superior
        totalAmount,                 // valor total
        idEstabelecimentoVenda = '1',
        idEstabelecimentoTicket = '93',
        serieBloco = '93',
        userEmail = '',
        userPhone = '',
        idaVolta = 'ida'
      } = req.body || {};

      const currentSeats = (passengers || []).map(p => String(p.seatNumber)).sort();

      // 1) Revalida o pagamento
      const r = await fetch(`https://api.mercadopago.com/v1/payments/${mpPaymentId}`, {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const payment = await r.json();
      if (!r.ok || !['approved', 'accredited'].includes(payment?.status)) {
        return { status: 400, body: { ok: false, error: 'Pagamento não está aprovado.' } };
      }

      const mpAmount = Number(payment.transaction_amount || 0);
      if (totalAmount && Number(totalAmount) > mpAmount + 0.01) {
        return { status: 400, body: { ok: false, error: 'Valor do item maior que o total pago.' } };
      }

      // 1.5) Verifica se JÁ EXISTE emissão na planilha (Persistência)
      // Agora verifica se AS POLTRONAS ESPECÍFICAS já estão lá
      const extRef = (payment.external_reference || '').trim();

      const checkSheetsForSeats = async () => {
        if (!extRef) return null;
        const { entries } = await sheetsFindByRef(extRef);
        // Filtra linhas que sejam das poltronas pedidas E tenham numPassagem
        const found = entries.filter(e =>
          e.numPassagem &&
          e.numPassagem.length > 2 &&
          currentSeats.includes(String(e.poltrona))
        );
        // Se achou TODAS as poltronas solicitadas, retorna sucesso
        if (found.length > 0 && found.length === currentSeats.length) {
          return found;
        }
        return null;
      };

      const existingEntries = await checkSheetsForSeats();
      if (existingEntries) {
        console.log(`[Idem] Bilhetes ${currentSeats.join(',')} recuperados do Sheets.`);
        const vendaResult = {
          Sucesso: true,
          Mensagem: 'Bilhetes recuperados (já emitidos).',
          ListaPassagem: existingEntries.map(e => ({
            NumPassagem: e.numPassagem,
            Poltrona: e.poltrona,
            NomeCliente: e.nome,
            ValorPgto: e.valor,
            DataViagem: e.dataViagem,
            HoraPartida: e.horaPartida,
            Origem: e.origem,
            Destino: e.destino
          })) // ... campos simplificados para o mock
        };
        const arquivos = existingEntries.map(e => ({
          numPassagem: e.numPassagem,
          pdfLocal: '',
          driveUrl: '',
          driveFileId: null
        }));
        return { status: 200, body: { ok: true, vendaResult, arquivos, recovered: true } };
      }

      const mpType = String(payment?.payment_type_id || '').toLowerCase();
      const mpMethod = String(
        payment?.payment_method_id || payment?.payment_method?.id || ''
      ).toLowerCase();

      const isPix = mpMethod === 'pix';

      const tipoPagamento = isPix ? '8' : '3'; // 8=PIX | 3=Cartão

      const tipoCartao = isPix
        ? '0'                                  // 0 = PIX na Praxio
        : mpType === 'credit_card'
          ? '1'                                // crédito
          : mpType === 'debit_card'
            ? '2'                              // débito
            : '1';

      const parcelas = Number(payment?.installments || 1);

      // helpers datas
      function toYMD(dateStr) {
        if (!dateStr) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
          const [d, m, y] = dateStr.split('/');
          return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
        const t = Date.parse(dateStr);
        if (Number.isFinite(t)) {
          const z = new Date(t);
          const yyyy = z.getFullYear();
          const mm = String(z.getMonth() + 1).padStart(2, '0');
          const dd = String(z.getDate()).padStart(2, '0');
          return `${yyyy}-${mm}-${dd}`;
        }
        return '';
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
        IdentidadeCli: String((p.document || '').replace(/\D/g, '')),
        TelefoneCli: String((p.phone || userPhone || '')).replace(/\D/g, ''),
      }));

      const horaPad = normalizeHoraPartida(schedule?.horaPartida);
      if (!schedule?.idViagem || !horaPad || !schedule?.idOrigem || !schedule?.idDestino || !passagemXml.length) {
        return { status: 400, body: { ok: false, error: 'Dados mínimos ausentes para venda.' } };
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

      // 4) Chama Praxio
      let vendaResult;
      try {
        vendaResult = await praxioVendaPassagem(bodyVenda);
        console.log('[Praxio][Venda][Resp]:', JSON.stringify(vendaResult).slice(0, 4000));
      } catch (praxioErr) {
        console.error('[Praxio][Venda] Exception:', praxioErr.message);

        // === RECUPERAÇÃO DE ERRO (Race Condition) ===
        // Se deu erro (ex: poltrona ocupada), pode ser que o webhook tenha acabado de ganhar a corrida.
        // Vamos esperar 2s e olhar o Sheets novamente.
        console.log('[Praxio][Retry] Aguardando 2s para verificar se Webhook já processou...');
        await new Promise(r => setTimeout(r, 2000));

        const retryEntries = await checkSheetsForSeats();
        if (retryEntries) {
          console.log(`[Praxio][Retry] SUCESSO! Bilhetes ${currentSeats} encontrados no Sheets pós-erro.`);
          const vRes = {
            Sucesso: true,
            Mensagem: 'Bilhetes recuperados pós-erro (webhook processou).',
            ListaPassagem: retryEntries.map(e => ({
              NumPassagem: e.numPassagem,
              Poltrona: e.poltrona,
              NomeCliente: e.nome,
              DataViagem: e.dataViagem
            }))
          };
          const arqs = retryEntries.map(e => ({ numPassagem: e.numPassagem, pdfLocal: '', driveUrl: '' }));
          return { status: 200, body: { ok: true, vendaResult: vRes, arquivos: arqs, recovered: true } };
        }

        // Se continuou sem bilhete, relança o erro original
        throw praxioErr;
      }

      // --- Se a Praxio não devolver bilhete, registra erro e avisa suporte
      const semBilhetes =
        !vendaResult ||
        vendaResult.Sucesso === false ||
        !Array.isArray(vendaResult.ListaPassagem) ||
        vendaResult.ListaPassagem.length === 0;

      if (semBilhetes) {
        // Tenta recovery aqui também (caso Sucesso=false mas sem exceção HTTP)
        console.log('[Praxio][Retry] Checando Sheets pois veio Sucesso=false...');
        await new Promise(r => setTimeout(r, 2000));
        const retryEntries = await checkSheetsForSeats();
        if (retryEntries) {
          const vRes = { Sucesso: true, ListaPassagem: retryEntries.map(e => ({ NumPassagem: e.numPassagem, Poltrona: e.poltrona })) };
          const arqs = retryEntries.map(e => ({ numPassagem: e.numPassagem, pdfLocal: '', driveUrl: '' }));
          return { status: 200, body: { ok: true, vendaResult: vRes, arquivos: arqs, recovered: true } };
        }

        // Lógica de erro original...
        const msgPraxi =
          vendaResult?.Mensagem ||
          vendaResult?.Mensagem2 ||
          vendaResult?.MensagemDetalhada ||
          'Retorno da Praxio sem bilhetes (ListaPassagem vazia).';

        const erroEntry = {
          stage: 'praxio-venda',
          mpPaymentId,
          userEmail,
          userPhone,
          schedule,
          passengers,
          totalAmount,
          bodyVenda,
          vendaResult,
          errorMessage: msgPraxi,
        };

        await logVendaFalha(erroEntry);
        await notifyAdminVendaFalha(erroEntry);

        return {
          status: 502, body: {
            ok: false,
            error: 'Falha na emissão do bilhete na Praxio.',
            message: msgPraxi,
          }
        };
      }

      // 🔎 Validação extra: garantir que existem bilhetes válidos
      const lista = Array.isArray(vendaResult.ListaPassagem)
        ? vendaResult.ListaPassagem
        : [];

      if (!lista.length) {
        throw new Error('Praxio ListaPassagem vazia'); // vai pro catch lá embaixo
      }

      // 🔎 Verificar erro por poltrona
      const errosPoltronas = lista.filter(p => {
        const msg = (p.Mensagem || p.MensagemDetalhada || '').toLowerCase();
        const temTextoErro = /erro|indispon[ií]vel|falha/.test(msg);
        return p.Sucesso === false || temTextoErro;
      });


      if (errosPoltronas.length) {
        // ✅ NOVO: permitir venda parcial (não derrubar tudo se pelo menos 1 bilhete saiu)
        const okPoltronas = lista.filter(p => p?.Sucesso === true && Number(p?.NumPassagem || 0) > 0);
        const badPoltronas = errosPoltronas;

        if (okPoltronas.length > 0) {
          console.warn('[Praxio][Venda] Venda parcial: algumas poltronas falharam:', badPoltronas.map(x => ({
            poltrona: x?.Poltrona,
            idErro: x?.IdErro,
            msg: x?.Mensagem || x?.MensagemDetalhada
          })));

          // ⚠️ importantíssimo: continuar o fluxo (PDF/email/Sheets) APENAS com as poltronas OK
          lista.length = 0;
          lista.push(...okPoltronas);
        } else {
          // Se não saiu nenhum bilhete, mantém o comportamento atual (retry + falha)
          console.log('[Praxio][Retry] Erro em poltronas. Checando Sheets...');
          await new Promise(r => setTimeout(r, 2000));
          const retryEntries = await checkSheetsForSeats();
          if (retryEntries) {
            const vRes = { Sucesso: true, ListaPassagem: retryEntries.map(e => ({ NumPassagem: e.numPassagem, Poltrona: e.poltrona })) };
            const arqs = retryEntries.map(e => ({ numPassagem: e.numPassagem, pdfLocal: '', driveUrl: '' }));
            return { status: 200, body: { ok: true, vendaResult: vRes, arquivos: arqs, recovered: true } };
          }

          const msgs = badPoltronas
            .map(p => p.Mensagem || p.MensagemDetalhada)
            .filter(Boolean)
            .join(' | ');

          throw new Error(
            `Erro na venda de uma ou mais poltronas: ${msgs || 'motivo não informado'}`
          );
        }
      }








      /*
            if (errosPoltronas.length) {
              // Retry logic para erro parcial (alguma poltrona falhou)?
              // Se falhou por indisponível, checa Sheets
              console.log('[Praxio][Retry] Erro em poltronas. Checando Sheets...');
              await new Promise(r => setTimeout(r, 2000));
              const retryEntries = await checkSheetsForSeats();
              if (retryEntries) {
                const vRes = { Sucesso: true, ListaPassagem: retryEntries.map(e => ({ NumPassagem: e.numPassagem, Poltrona: e.poltrona })) };
                const arqs = retryEntries.map(e => ({ numPassagem: e.numPassagem, pdfLocal: '', driveUrl: '' }));
                return { status: 200, body: { ok: true, vendaResult: vRes, arquivos: arqs, recovered: true } };
              }
      
              const msgs = errosPoltronas
                .map(p => p.Mensagem || p.MensagemDetalhada)
                .filter(Boolean)
                .join(' | ');
      
              throw new Error(
                `Erro na venda de uma ou mais poltronas: ${msgs || 'motivo não informado'}`
              );
            }
      */
      // 5) Gerar PDFs (local) e subir no Drive
      const subDir = new Date().toISOString().slice(0, 10);
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
        const localUrl = `/tickets/${subDir}/${pdf.filename}`;

        // 5.2 subir no Drive (opcional)
        let drive = null;
        try {
          const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
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
            const slug = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
            const buf = await fs.promises.readFile(localPath);
            const nome = `${slug(ticket.nomeCliente || 'passageiro')}_${ticket.numPassagem}_${sentido}.pdf`;
            emailAttachments.push({
              filename: nome,
              contentBase64: buf.toString('base64'),
              buffer: buf,
            });
          } catch (_) { }
        }

        arquivos.push({
          numPassagem: ticket.numPassagem,
          pdfLocal: localUrl,
          driveUrl: drive?.webViewLink || null,
          driveFileId: drive?.id || null
        });

        bilhetesPayload.push({
          numPassagem: p.NumPassagem || ticket.numPassagem,
          chaveBPe: p.ChaveBPe || ticket.chaveBPe || null,
          origem: p.Origem || ticket.origem || schedule?.originName || schedule?.origem || null,
          destino: p.Destino || ticket.destino || schedule?.destinationName || schedule?.destino || null,
          origemNome: ticket.origem || schedule?.originName || schedule?.origem || null,
          destinoNome: ticket.destino || schedule?.destinationName || schedule?.destino || null,
          poltrona: p.Poltrona || ticket.poltrona || null,
          nomeCliente: p.NomeCliente || ticket.nomeCliente || null,
          docCliente: p.DocCliente || ticket.docCliente || null,
          valor: p.ValorPgto ?? ticket.valor ?? null,

          dataViagem: p.DataViagem || ticket.dataViagem || schedule?.date || schedule?.dataViagem || '',
          horaPartida: p.HoraPartida || ticket.horaPartida || schedule?.horaPartida || schedule?.departureTime || '',

          idaVolta: sentido
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
        base: { payment, schedule, userEmail: loginEmail || '', userPhone: loginPhone || '', idaVolta },
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
        const emailForSheets = to || userEmail || '';

        if (to) {
          const appName = process.env.APP_NAME || 'Turin Transportes';
          const fromName = process.env.SUPPORT_FROM_NAME || 'Turin Transportes';
          const fromEmail = process.env.SUPPORT_FROM_EMAIL || process.env.SMTP_USER;

          // Descobre se há múltiplas rotas
          const pairs = new Set(bilhetes.map(b => `${b.origemNome || b.origem || ''}→${b.destinoNome || b.destino || ''}`));
          const headerRoute = (pairs.size === 1 && bilhetes.length)
            ? [...pairs][0]
            : 'Múltiplas rotas (veja por bilhete)';

          const valorTotalBRL = (Number(payment?.transaction_amount || 0)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

          // lista <li> com rota/data/hora por bilhete e link
          const listaHtml = bilhetes.map((b, i) => {
            const sentido = b?.idaVolta || (String(idaVolta).toLowerCase() === 'volta' ? 'Volta' : 'Ida');
            const rotaStr = `${b.origemNome || b.origem || '—'} → ${b.destinoNome || b.destino || '—'}`;
            const nome = (b?.nomeCliente || '').toString().trim() || '(passageiro não informado)';
            const link = (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.driveUrl)
              || (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.pdfLocal)
              || '';
            const linkHtml = link ? `<div style="margin:2px 0"><a href="${link}" target="_blank" rel="noopener">Abrir bilhete ${i + 1}</a></div>` : '';
            return `<li style="margin:10px 0">
              <div><b>Bilhete nº ${b.numPassagem}</b> (${sentido})</div>
              <div><b>Passageiro:</b> ${nome}</div>
              <div><b>Rota:</b> ${rotaStr}</div>
              <div><b>Data/Hora:</b> ${b.dataViagem || ''} ${b.horaPartida || ''}</div>
              ${linkHtml}
            </li>`;
          }).join('');

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
            ...bilhetes.map((b, i) => ` - ${b.numPassagem} (${(b.idaVolta || 'ida')}) ${b.origemNome || b.origem || ''} -> ${b.destinoNome || b.destino || ''} ${b.dataViagem || ''} ${b.horaPartida || ''}`)
          ].join('\n');

          // usa os nomes já definidos (displayName)
          const attachmentsSMTP = emailAttachments.map(a => ({
            filename: a.filename,
            content: a.buffer
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
            await sendViaBrevoApi({ to, subject: `Seus bilhetes – ${appName}`, html, text, fromEmail, fromName, attachments: attachmentsBrevo });
            console.log(`[Email] enviados ${attachmentsBrevo.length} anexos para ${to} via Brevo API`);
          }
        } else {
          console.warn('[Email] comprador sem e-mail. Pulando envio.');
        }


        // 2) SHEETS – agora limpa a pré-reserva da mesma Referencia
        try {
          const ref = payment?.external_reference || null;
          if (ref) {
            console.log('[Sheets] limpando pré-reservas da referência', ref);
            await sheetsDeleteRowsByRef(ref);
          }
        } catch (err) {
          console.error('[Sheets] erro ao limpar pré-reserva:', err?.message || err);
        }

        // 3) SHEETS – 1 linha por bilhete (como já fazia, reaproveitando a função existente)
        await sheetsAppendBilhetes({
          spreadsheetId: process.env.SHEETS_BPE_ID,
          range: process.env.SHEETS_BPE_RANGE || 'BPE!A:AK',
          bilhetes: bilhetes.map(b => ({
            ...b,
            driveUrl: (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.driveUrl)
              || (arquivos.find(a => String(a.numPassagem) === String(b.numPassagem))?.pdfLocal)
              || ''
          })),
          schedule,
          payment,
          userEmail: emailForSheets,
          userPhone,
          idaVoltaDefault: idaVolta
        });

        await logVendaSucesso({
          mpPaymentId: String(payment?.id || ''),
          external_reference: String(payment?.external_reference || ''),
          status: String(payment?.status || ''),
          payment_type_id: String(payment?.payment_type_id || ''),
          payment_method_id: String(payment?.payment_method_id || payment?.payment_method?.id || ''),
          userEmail: String(emailForSheets || userEmail || ''),
          userPhone: String(userPhone || ''),
          bilhetes: (bilhetes || []).map(b => ({
            numPassagem: b.numPassagem,
            poltrona: b.poltrona,
            idViagem: b.idViagem,
            dataViagem: b.dataViagem,
            origem: b.origem,
            destino: b.destino
          })),
          anexos: (arquivos || []).map(a => ({
            numPassagem: a.numPassagem,
            driveUrl: a.driveUrl || '',
            pdfLocal: a.pdfLocal || ''
          })),
        });


      });


      return { status: 200, body: { ok: true, vendaResult, arquivos } };

    } catch (err) {
      console.error('[Praxio][Venda] erro inesperado:', err);

      try {
        const erroEntry = {
          stage: 'exception',
          mpPaymentId: req.body?.mpPaymentId || null,
          userEmail: req.body?.userEmail || '',
          userPhone: req.body?.userPhone || '',
          schedule: req.body?.schedule || null,
          passengers: req.body?.passengers || null,
          totalAmount: req.body?.totalAmount || null,
          errorMessage: err?.message || String(err),
          stack: err?.stack || null,
        };

        await logVendaFalha(erroEntry);
        await notifyAdminVendaFalha(erroEntry);
      } catch (inner) {
        console.error('[Praxio][Venda] falha ao registrar erro:', inner);
      }

      return {
        status: 500, body: {
          ok: false,
          error: 'Erro interno ao emitir o bilhete. Nosso suporte já foi notificado.',
        }
      };
    }
  };

  // Cria a Promise e coloca no Map
  const promise = processSale();
  if (lockKey) ISSUANCE_LOCK.set(lockKey, promise);

  try {
    const result = await promise;
    // result = { status: number, body: object }

    // Salva no cache de concluídos se foi sucesso (200)
    if (lockKey && result.status === 200) {
      COMPLETED_CACHE.set(lockKey, {
        status: result.status,
        body: result.body,
        timestamp: Date.now()
      });
    }

    return res.status(result.status || 200).json(result.body);
  } finally {
    // Remove do Map ao terminar
    if (lockKey) ISSUANCE_LOCK.delete(lockKey);
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



//teste
