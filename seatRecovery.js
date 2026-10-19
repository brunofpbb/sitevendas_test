'use strict';

// Recuperação de emissão após pagamento aprovado e falha CONFIRMADA por assento ocupado.
// Mantém os estados no Sheets existente. Operações financeiras só para 1 bilhete,
// sem emissão parcial, e com chave idempotente no Mercado Pago.
module.exports = function createRecovery({ app, sheetsFindByRef, sheetsAuthRW, mpGetPayment, mpRefund, fetch, logVendaFalha, notifyAdminVendaFalha }) {
  const locks = new Set();
  const FAIL = 'Poltrona indisponível';
  const REFUNDING = 'Reembolso em processamento';
  const REFUNDED = 'Reembolsado integralmente';
  const REISSUING = 'Reemissão em andamento';
  const MANUAL = 'Análise manual';
  const norm = value => String(value || '').trim().toLowerCase();
  const isSeatError = message => /poltrona.{0,70}indispon[ií]vel/i.test(String(message || ''));
  const tab = (process.env.SHEETS_BPE_RANGE || 'BPE!A:AK').split('!')[0];
  const colName = n => { let s = ''; for (let v = n + 1; v; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + (v - 1) % 26) + s; return s; };

  async function setStatus(rowIndex, status, newSeat) {
    const sheets = await sheetsAuthRW();
    const h = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEETS_BPE_ID, range: tab + '!1:1' })).data.values?.[0] || [];
    const idx = n => h.findIndex(x => norm(x) === norm(n));
    const sc = idx('Status'), seatCol = idx('poltrona');
    if (sc < 0 || (newSeat !== undefined && seatCol < 0)) throw new Error('Planilha sem colunas de recuperação');
    const data = [{ range: tab + '!' + colName(sc) + rowIndex, values: [[status]] }];
    if (newSeat !== undefined) data.push({ range: tab + '!' + colName(seatCol) + rowIndex, values: [[String(newSeat)]] });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.SHEETS_BPE_ID,
      requestBody: { valueInputOption: 'RAW', data }
    });
  }

  async function validated(paymentId, reference, email) {
    if (!/^\d{6,25}$/.test(String(paymentId || '')) || !reference || !email) {
      const err = new Error('Identificação da compra incompleta'); err.code = 400; throw err;
    }
    const payment = await mpGetPayment(String(paymentId));
    if (String(payment.external_reference || '') !== String(reference)) {
      const err = new Error('Compra não encontrada'); err.code = 403; throw err;
    }
    const { entries } = await sheetsFindByRef(reference);
    if (!entries.length || !entries.every(e => norm(e.email) === norm(email))) {
      const err = new Error('Compra não encontrada para este e-mail'); err.code = 403; throw err;
    }
    return { payment, entries };
  }

  const issued = e => !!e.numPassagem || norm(e.status) === 'emitido';
  const oneTicket = entries => entries.length === 1 && !entries.some(issued);
  const isPaid = p => ['approved', 'accredited'].includes(norm(p.status));

  async function markUnavailable(payment, passengers, message) {
    if (!isSeatError(message) || !payment?.external_reference) return false;
    const { entries } = await sheetsFindByRef(payment.external_reference);
    if (!oneTicket(entries) || (passengers || []).length !== 1) return false;
    const seat = String(passengers[0]?.seatNumber || passengers[0]?.poltrona || '');
    if (String(entries[0].poltrona) !== seat) return false;
    if ([REFUNDING, REFUNDED, REISSUING, MANUAL].includes(entries[0].status)) return false;
    await setStatus(entries[0].rowIndex, FAIL);
    return true;
  }

  app.post('/api/recovery/state', async (req, res) => {
    try {
      const { paymentId, reference, email } = req.body || {};
      const { payment, entries } = await validated(paymentId, reference, email);
      const e = entries[0], status = norm(e.status);
      const available = oneTicket(entries);
      let state = 'pending';
      if (payment.status === 'refunded' || status === norm(REFUNDED)) state = 'refunded';
      else if (entries.every(issued)) state = 'issued';
      else if (!available || status === norm(MANUAL)) state = 'manual';
      else if (status === norm(REFUNDING)) state = 'refunding';
      else if (status === norm(REISSUING)) state = 'reissuing';
      else if (status === norm(FAIL) && isPaid(payment)) state = 'seat_unavailable';
      res.json({
        ok: true, state, paymentId: String(payment.id),
        paymentStatus: payment.status,
        seat: e.poltrona,
        amount: Number(payment.transaction_amount || 0),
        schedule: {
          idViagem: e.idViagem, idOrigem: e.idOrigem, idDestino: e.idDestino,
          originId: e.idOrigem, destinationId: e.idDestino,
          date: e.dataViagem, dataViagem: e.dataViagem,
          horaPartida: e.horaPartida, originName: e.origem,
          destinationName: e.destino
        },
        passenger: { name: e.nome, cpf: e.cpf, document: e.cpf, phone: e.telefone },
        wayType: norm(e.sentido).includes('volta') ? 'volta' : 'ida'
      });
    } catch (err) {
      res.status(err.code || 500).json({ ok: false, error: err.code ? err.message : 'Falha ao consultar a recuperação' });
    }
  });

  async function runAction(req, res, action) {
    const { paymentId, reference, email } = req.body || {};
    const key = String(paymentId);
    if (locks.has(key)) return res.status(409).json({ ok: false, error: 'Esta compra já está sendo processada.' });
    locks.add(key);
    try {
      const { payment, entries } = await validated(paymentId, reference, email);
      if (!isPaid(payment) || !oneTicket(entries)) return res.status(409).json({ ok: false, error: 'Compra não elegível para autoatendimento.' });
      const row = entries[0];
      if (row.status !== FAIL) return res.status(409).json({ ok: false, error: 'Esta compra não está aguardando recuperação.' });
      const refunded = (payment.refunds || []).reduce((s,r)=>s + Number(r.amount || 0),0);
      if (refunded > 0.001) return res.status(409).json({ ok: false, error: 'Pagamento com estorno anterior: atendimento necessário.' });
      if (action === 'refund') {
        await setStatus(row.rowIndex, REFUNDING);
        try {
          // Sem bilhete emitido, sem desconto de 5%; chave fixa mesmo após retry/restart.
          const result = await mpRefund({ paymentId, amount: Number(payment.transaction_amount), idempotencyKey: 'seat-unavailable-full-' + paymentId });
          await setStatus(row.rowIndex, REFUNDED);
          return res.json({ ok: true, state: 'refunded', refundId: result.id });
        } catch (error) {
          await setStatus(row.rowIndex, MANUAL).catch(()=>{});
          await notifyAdminVendaFalha({ stage:'recovery-refund',mpPaymentId:paymentId,errorMessage:error.message });
          return res.status(502).json({ ok:false,error:'Estorno ainda não confirmado. Nosso suporte foi acionado.' });
        }
      }
      const seat = Number(req.body?.seatNumber);
      if (!Number.isInteger(seat) || seat < 3 || seat > 42 || String(seat) === String(row.poltrona)) {
        return res.status(400).json({ok:false,error:'Escolha outra poltrona válida.'});
      }
      // Conferência da disponibilidade atual feita no servidor, não pelo navegador.
      const raw = await fetch('http://127.0.0.1:'+(process.env.PORT || 8080)+'/api/poltronas', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({idViagem:row.idViagem,idLocOrigem:row.idOrigem,idLocDestino:row.idDestino,idTipoVeiculo:req.body?.idTipoVeiculo || ''})
      });
      if (!raw.ok) return res.status(503).json({ok:false,error:'Não foi possível verificar os assentos agora.'});
      const data = await raw.json(); const value=Array.isArray(data)?data[0]:data;
      const seatRows=value?.LaypoltronaXml?.PoltronaXmlRetorno || value?.PoltronaXmlRetorno || [];
      const seats=Array.isArray(seatRows)?seatRows:[seatRows];
      const chosen=seats.find(x=>Number(x.Caption ?? x.caption ?? x.Numero ?? x.NumeroPoltrona) === seat);
      if (!chosen || Number(chosen.Situacao ?? chosen.situacao ?? -1) !== 0) {
        return res.status(409).json({ok:false,code:'SEAT_UNAVAILABLE',error:'A poltrona escolhida já está ocupada.'});
      }
      await setStatus(row.rowIndex, REISSUING);
      const subtotal = Number(String(row.valor || '').replace(',','.')) || Number(payment.transaction_amount);
      const body = {
        mpPaymentId: paymentId, schedule:{
          idViagem:row.idViagem,idOrigem:row.idOrigem,idDestino:row.idDestino,
          horaPartida:row.horaPartida,date:row.dataViagem,
          originName:row.origem,destinationName:row.destino
        },
        passengers:[{seatNumber:seat,name:row.nome,document:row.cpf,phone:row.telefone}],
        totalAmount:subtotal, idaVolta:norm(row.sentido).includes('volta')?'volta':'ida',
        userEmail:row.email,userPhone:row.telefone,
        idEstabelecimentoTicket:'93',serieBloco:'93',totalExpected:1
      };
      try {
        const response=await fetch('http://127.0.0.1:'+(process.env.PORT || 8080)+'/api/praxio/vender',{
          method:'POST',headers:{'Content-Type':'application/json','X-Source':'recovery'},
          body:JSON.stringify(body)
        });
        const result=await response.json();
        if (!response.ok || !result.ok) {
          if (result.code === 'SEAT_UNAVAILABLE') {
            await setStatus(row.rowIndex, FAIL);
            return res.status(409).json({ok:false,code:'SEAT_UNAVAILABLE',error:'Essa poltrona também ficou indisponível. Escolha outra.'});
          }
          await setStatus(row.rowIndex, MANUAL);
          await notifyAdminVendaFalha({stage:'recovery-issue',mpPaymentId:paymentId,errorMessage:result.error});
          return res.status(502).json({ok:false,error:'Não foi possível confirmar a emissão. Suporte acionado.'});
        }
        return res.json({ok:true,state:'issued'});
      } catch (err) {
        await setStatus(row.rowIndex, MANUAL).catch(()=>{});
        await notifyAdminVendaFalha({stage:'recovery-issue',mpPaymentId:paymentId,errorMessage:err.message});
        return res.status(502).json({ok:false,error:'Resultado de emissão inconclusivo. Suporte acionado.'});
      }
    } catch (err) {
      return res.status(err.code || 500).json({ok:false,error:err.code?err.message:'Operação indisponível. Tente mais tarde.'});
    } finally { locks.delete(key); }
  }

  app.post('/api/recovery/refund', (req,res)=>runAction(req,res,'refund'));
  app.post('/api/recovery/issue', (req,res)=>runAction(req,res,'issue'));
  return { markUnavailable, isSeatError };
};
