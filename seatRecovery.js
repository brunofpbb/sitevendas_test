'use strict';

// Recuperação de emissão após pagamento aprovado e falha CONFIRMADA por assento ocupado.
// Mantém os estados no Sheets existente. Operações financeiras só para 1 bilhete,
// sem emissão parcial, e com chave idempotente no Mercado Pago.
module.exports = function createRecovery({ app, sheetsFindByRef, sheetsAuthRW, mpGetPayment, mpRefund, fetch, logVendaFalha, notifyAdminVendaFalha, praxioLogin, praxioVerificaDevolucao, praxioGravaDevolucao }) {
  const locks = new Set();
  const FAIL = 'Poltrona indisponível';
  const REFUNDING = 'Reembolso em processamento';
  const REFUNDED = 'Reembolsado integralmente';
  const REISSUING = 'Reemissão em andamento';
  const MANUAL = 'Análise manual';
  const GROUP_CANCEL = 'Cancelamento de grupo em andamento';
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
  // Não operar automaticamente se o total pago não corresponde ao único bilhete
  // registrado. Evita estorno da compra inteira quando a pré-reserva está incompleta.
  const amountMatches = (payment, entries) => {
    if (!entries.length) return false;
    const ticket = entries.reduce((total,e) => total + Number(String(e.valor || '0').replace(',', '.')),0);
    const paid = Number(payment.transaction_amount || 0);
    return ticket > 0 && paid > 0 && Math.abs(ticket - paid) <= 0.02;
  };

  async function markUnavailable(payment, passengers, message, options={}) {
    if (!isSeatError(message) || !payment?.external_reference) return false;
    const { entries } = await sheetsFindByRef(payment.external_reference);
    const requestedSeats = (passengers || []).map(p=>String(p.seatNumber || p.poltrona || ''));
    const reported = [...String(message||'').matchAll(/poltrona\s+(\d+)/gi)].map(m=>m[1]);
    const seats = reported.length ? reported : (requestedSeats.length===1?requestedSeats:[]);
    if(!seats.length || !entries.length) return false;
    if(entries.some(e=>[REFUNDING,REFUNDED,MANUAL,GROUP_CANCEL].includes(e.status) || (e.status===REISSUING && !options.recovery)))return false;
    // Só registrar falha confirmada da(s) poltrona(s) identificada(s).
    const targets = entries.filter(e=>!issued(e)&&seats.includes(String(e.poltrona))&&requestedSeats.includes(String(e.poltrona)));
    if(!targets.length) return false;
    for(const row of targets) await setStatus(row.rowIndex, FAIL);
    return true;
  }


  const ticketFailed = e => norm(e.status) === norm(FAIL);
  const sameTrip = entries => entries.every(e=>[
    'idViagem','idOrigem','idDestino','dataViagem','horaPartida','sentido'
  ].every(k=>String(e[k]||'') === String(entries[0][k]||'')));
  const coherent = (payment,entries) => sameTrip(entries) && amountMatches(payment,entries) &&
    entries.every(e=>issued(e) || ticketFailed(e));
  const seatLayout = async(row,idTipoVeiculo='')=>{
    const response=await fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/poltronas',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({idViagem:row.idViagem,idLocOrigem:row.idOrigem,idLocDestino:row.idDestino,idTipoVeiculo})
    });
    if(!response.ok)throw new Error('Falha na consulta de disponibilidade');
    const json=await response.json();
    const val=Array.isArray(json)?json[0]:json;
    const raw=val?.LaypoltronaXml?.PoltronaXmlRetorno || val?.PoltronaXmlRetorno || [];
    const rows=Array.isArray(raw)?raw:[raw];
    if(!rows.length)throw new Error('Mapa de poltronas indisponível');
    return rows.map(x=>({number:Number(x.Caption??x.caption??x.Numero??x.NumeroPoltrona),
      free:Number(x.Situacao??x.situacao??-1)===0})).filter(x=>Number.isInteger(x.number)&&x.number>=3&&x.number<=99);
  };
  const availCount=async(entries,idTipoVeiculo='')=>{
    const seats=await seatLayout(entries[0],idTipoVeiculo);
    const reserved=new Set(entries.filter(issued).map(e=>Number(e.poltrona)));
    return seats.filter(x=>x.free&&!reserved.has(x.number)).length;
  };

  app.post('/api/recovery/state', async (req, res) => {
    try {
      const { paymentId, reference, email } = req.body || {};
      const { payment, entries } = await validated(paymentId, reference, email);
      const e = entries.find(ticketFailed) || entries[0], status = norm(e.status);
      const complete=entries.every(issued);
      const settled=entries.every(x=>issued(x)||norm(x.status)===norm(REFUNDED));
      const failures=entries.filter(ticketFailed);
      const eligible=coherent(payment,entries) && isPaid(payment);
      let freeSeats=null;
      if(eligible && failures.length){
        try{freeSeats=await availCount(entries,String(req.body?.idTipoVeiculo||''));}
        catch(_){freeSeats=null;}
      }
      let state='pending';
      if(payment.status==='refunded'||entries.every(x=>norm(x.status)===norm(REFUNDED))) state='refunded';
      else if(complete)state='issued';
      else if(settled && entries.some(x=>norm(x.status)===norm(REFUNDED)))state='partially_refunded';
      else if(entries.some(x=>[MANUAL,GROUP_CANCEL].includes(x.status)))state='manual';
      else if(entries.some(x=>norm(x.status)===norm(REFUNDING)))state='refunding';
      else if(entries.some(x=>norm(x.status)===norm(REISSUING)))state='reissuing';
      else if(eligible && failures.length)state='seat_unavailable';
      else if(entries.length>1 && failures.length)state='manual';
      res.json({
        ok: true, state, paymentId: String(payment.id),
        paymentStatus: payment.status,
        seat: e.poltrona,
        multiple:entries.length>1,
        totalTickets:entries.length,
        tickets:entries.map(t=>({seat:t.poltrona,passenger:t.nome,cpf:t.cpf,phone:t.telefone,status:t.status,issued:issued(t),number:t.numPassagem||null})),
        failedCount:failures.length,
        issuedCount:entries.filter(issued).length,
        freeSeats,
        canReplace:state==='seat_unavailable' && freeSeats!==null && freeSeats>=failures.length,
        canGroupRefund:state==='seat_unavailable' && failures.length>0 && freeSeats!==null && freeSeats<failures.length,
        canRefundFailed:state==='seat_unavailable' && failures.length>0,
        requiresGroupCancellation:entries.some(issued),
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
      if (!isPaid(payment) || !oneTicket(entries) || !amountMatches(payment, entries)) return res.status(409).json({ ok: false, error: 'Compra não elegível para autoatendimento. Contate o suporte.' });
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


  // Operações por grupo usam o mesmo pagamento, com conferência integral do lote.
  // Cada tentativa transita para estado persistente ANTES da chamada Praxio/MP.
  app.post('/api/recovery/issue-batch', async(req,res)=>{
    const {paymentId,reference,email,idTipoVeiculo} = req.body||{};
    const key=String(paymentId);
    if(locks.has(key))return res.status(409).json({ok:false,error:'Compra em processamento'});
    locks.add(key);
    try{
      const {payment,entries}=await validated(paymentId,reference,email);
      const failed=entries.filter(ticketFailed);
      const replacements=req.body.replacements;
      if(entries.length<=1 || !isPaid(payment) || !coherent(payment,entries) || !failed.length ||
        !Array.isArray(replacements) || replacements.length!==failed.length)
        return res.status(409).json({ok:false,error:'Compra ou seleção não elegível para recuperação em grupo'});
      const originals=new Set(failed.map(x=>String(x.poltrona)));
      const chosen=new Set(replacements.map(x=>String(x.newSeat)));
      if(chosen.size!==failed.length || replacements.some(x=>!originals.has(String(x.oldSeat)) ||
        !Number.isInteger(Number(x.newSeat)) || Number(x.newSeat)<3 || Number(x.newSeat)>99))
        return res.status(400).json({ok:false,error:'Seleção de poltronas inválida'});
      const layout=await seatLayout(entries[0],idTipoVeiculo||'');
      const free=new Set(layout.filter(x=>x.free).map(x=>String(x.number)));
      if([...chosen].some(seat=>!free.has(seat)))
        return res.status(409).json({ok:false,code:'SEAT_UNAVAILABLE',error:'Uma das poltronas já ficou indisponível. Selecione novamente.'});
      const byOld=new Map(replacements.map(x=>[String(x.oldSeat),Number(x.newSeat)]));
      const pax=failed.map(x=>({seatNumber:byOld.get(String(x.poltrona)),name:x.nome,document:x.cpf,phone:x.telefone,price:Number(String(x.valor).replace(',','.'))}));
      for(const x of failed)await setStatus(x.rowIndex,REISSUING,byOld.get(String(x.poltrona)));
      const x=entries[0];
      const body={
        mpPaymentId:paymentId,
        schedule:{idViagem:x.idViagem,idOrigem:x.idOrigem,idDestino:x.idDestino,date:x.dataViagem,horaPartida:x.horaPartida,originName:x.origem,destinationName:x.destino},
        passengers:pax,totalAmount:pax.reduce((v,t)=>v+t.price,0),
        userEmail:x.email,userPhone:x.telefone,idaVolta:norm(x.sentido).includes('volta')?'volta':'ida',
        idEstabelecimentoTicket:'93',serieBloco:'93',totalExpected:failed.length
      };
      const response=await fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/praxio/vender',{
        method:'POST',headers:{'Content-Type':'application/json','X-Source':'recovery'},body:JSON.stringify(body)
      });
      const result=await response.json();
      if(!response.ok||!result.ok){
        if(result.code==='SEAT_UNAVAILABLE'){
          for(const x of failed)await setStatus(x.rowIndex,FAIL);
          return res.status(409).json({ok:false,code:'SEAT_UNAVAILABLE',error:'Uma poltrona ficou indisponível; escolha novamente.'});
        }
        for(const x of failed)await setStatus(x.rowIndex,MANUAL);
        await notifyAdminVendaFalha({stage:'group-recovery-issue',mpPaymentId:paymentId,errorMessage:result.error||'Falha no lote'});
        return res.status(502).json({ok:false,error:'Não foi possível confirmar todos os bilhetes. Suporte acionado.'});
      }
      // A confirmação final permanece no Sheets; não presumimos emissão a partir de HTTP 200.
      return res.json({ok:true,state:'reissuing'});
    }catch(e){
      try{
        const {entries}=await sheetsFindByRef(reference);
        for(const x of entries.filter(t=>norm(t.status)===norm(REISSUING)))await setStatus(x.rowIndex,MANUAL);
      }catch(_){}
      await notifyAdminVendaFalha({stage:'group-recovery-exception',mpPaymentId:paymentId,errorMessage:e.message}).catch(()=>{});
      return res.status(e.code||502).json({ok:false,error:'Não foi possível confirmar a emissão do grupo. Consulte o suporte.'});
    }finally{locks.delete(key);}
  });


  // Devolve apenas as passagens não emitidas; bilhetes já emitidos permanecem válidos.
  app.post('/api/recovery/refund-failed',async(req,res)=>{
    const {paymentId,reference,email}=req.body||{};
    const key=String(paymentId);
    if(locks.has(key))return res.status(409).json({ok:false,error:'Compra em processamento'});
    locks.add(key);
    try{
      const {payment,entries}=await validated(paymentId,reference,email);
      const failed=entries.filter(ticketFailed);
      if(entries.length<2 || !isPaid(payment) || !coherent(payment,entries) || !failed.length)
        return res.status(409).json({ok:false,error:'Compra não elegível para reembolso parcial'});
      if((payment.refunds||[]).some(x=>Number(x.amount)>0))
        return res.status(409).json({ok:false,error:'Reembolso prévio encontrado. Suporte necessário.'});
      const total=+failed.reduce((v,x)=>v+Number(String(x.valor||0).replace(',','.')),0).toFixed(2);
      if(total<=0 || total>Number(payment.transaction_amount))
        return res.status(409).json({ok:false,error:'Valor das passagens divergente'});
      for(const row of failed)await setStatus(row.rowIndex,REFUNDING);
      try{
        const refund=await mpRefund({paymentId,amount:total,idempotencyKey:'seat-failed-only-'+paymentId});
        for(const row of failed)await setStatus(row.rowIndex,REFUNDED);
        return res.json({ok:true,state:'partially_refunded',amount:total,refundId:refund.id});
      }catch(error){
        for(const row of failed)await setStatus(row.rowIndex,MANUAL).catch(()=>{});
        await notifyAdminVendaFalha({stage:'group-partial-refund',mpPaymentId:paymentId,errorMessage:error.message});
        return res.status(502).json({ok:false,error:'Reembolso não confirmado. Suporte acionado.'});
      }
    }catch(error){
      return res.status(error.code||502).json({ok:false,error:'Não foi possível validar o reembolso. Consulte o suporte.'});
    }finally{locks.delete(key);}
  });

  app.post('/api/recovery/refund-group',async(req,res)=>{
    const {paymentId,reference,email,idTipoVeiculo}=req.body||{};
    const key=String(paymentId);
    if(locks.has(key))return res.status(409).json({ok:false,error:'Compra em processamento'});
    locks.add(key);
    try{
      const {payment,entries}=await validated(paymentId,reference,email);
      const failed=entries.filter(ticketFailed),sold=entries.filter(issued);
      if(entries.length<2 || !isPaid(payment) || !coherent(payment,entries) || !failed.length)
        return res.status(409).json({ok:false,error:'Compra não elegível para reembolso em grupo'});
      const refunded=(payment.refunds||[]).reduce((v,t)=>v+Number(t.amount||0),0);
      if(refunded>0.001)return res.status(409).json({ok:false,error:'Existe reembolso anterior. Atendimento necessário.'});
      // Se há emitidos, todo o grupo só pode ser cancelado se faltam assentos
      // para pelo menos um passageiro ainda sem bilhete.
      if(sold.length){
        const free=await availCount(entries,idTipoVeiculo||'');
        if(free>=failed.length)
          return res.status(409).json({ok:false,error:'Há vagas para continuar a viagem. O cancelamento integral do grupo não está disponível.'});
        // Primeiro verifica TODOS os bilhetes emitidos, antes de cancelar qualquer um.
        const session=await praxioLogin();
        const verified=[];
        for(const row of sold){
          const ver=await praxioVerificaDevolucao({idSessao:session,numPassagem:row.numPassagem,motivo:'Sem vagas para grupo em recuperação de emissão'});
          const ticket=ver?.Xml?.Passagem;
          if(!ticket || ver?.IdErro)throw new Error('Cancelamento de um bilhete não autorizado pela Praxio');
          verified.push({row,ticket});
        }
        for(const row of entries)await setStatus(row.rowIndex,GROUP_CANCEL);
        try{
          for(const {row,ticket} of verified){
            const result=await praxioGravaDevolucao({idSessao:session,xmlPassagem:ticket});
            if(result?.IdErro || result?.Sucesso===false)throw new Error('Praxio não confirmou o cancelamento do bilhete '+row.numPassagem);
            await setStatus(row.rowIndex,'Cancelado para reembolso integral');
          }
        }catch(err){
          for(const row of entries)await setStatus(row.rowIndex,MANUAL).catch(()=>{});
          await notifyAdminVendaFalha({stage:'group-cancel-partial',mpPaymentId:paymentId,errorMessage:err.message});
          return res.status(502).json({ok:false,error:'Cancelamento do grupo inconclusivo. Suporte acionado; reembolso ainda não solicitado.'});
        }
      }else{
        // Nenhum bilhete emitido: não há o que cancelar na Praxio.
        for(const row of entries)await setStatus(row.rowIndex,REFUNDING);
      }
      // Identificador fixo para repetir com idempotência no Mercado Pago.
      try{
        const result=await mpRefund({paymentId,amount:Number(payment.transaction_amount),idempotencyKey:'group-seat-shortage-full-'+paymentId});
        for(const row of entries)await setStatus(row.rowIndex,REFUNDED);
        return res.json({ok:true,state:'refunded',refundId:result.id});
      }catch(err){
        for(const row of entries)await setStatus(row.rowIndex,MANUAL).catch(()=>{});
        await notifyAdminVendaFalha({stage:'group-full-refund',mpPaymentId:paymentId,errorMessage:err.message});
        return res.status(502).json({ok:false,error:'Estorno não confirmado. Suporte acionado.'});
      }
    }catch(err){
      await notifyAdminVendaFalha({stage:'group-refund-validation',mpPaymentId:paymentId,errorMessage:err.message}).catch(()=>{});
      return res.status(err.code||409).json({ok:false,error:'Não foi possível validar o cancelamento integral com segurança. Suporte acionado.'});
    }finally{locks.delete(key);}
  });

  app.post('/api/recovery/refund', (req,res)=>runAction(req,res,'refund'));
  app.post('/api/recovery/issue', (req,res)=>runAction(req,res,'issue'));
  return { markUnavailable, isSeatError };
};
