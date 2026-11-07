'use strict';

/**
 * Conciliação PIX por referência do pedido (com ou sem idPagamento).
 * Modo seguro por padrão: diagnóstico e atualização financeira quando inequívoca;
 * emissão automática requer RECON_PIX_AUTO_ISSUE=true e validação operacional.
 */
module.exports = function createPixReconciler({
  sheets, spreadsheetId, sheetTab, fetch, accessToken, processPayment, beforeIssue, onApproved,
  intervalMs = 120000, lookbackHours = 72, maxRefs = 40,
  autoIssue = false
}) {
  let running = false;
  const inFlight = new Set();
  const recentlyReported = new Map(); // evita alertas/e-mails repetidos no mesmo processo
  const normalize = x => String(x ?? '').trim();
  const headerKey = x => normalize(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const cents = x => {
    let v = normalize(x).replace(/R\$\s?/g, '').replace(/\s/g, '');
    if (v.includes(',') && v.includes('.')) v = v.replace(/\./g,'').replace(',','.');
    else if (v.includes(',')) v=v.replace(',','.');
    const n=Number(v);
    return Number.isFinite(n) ? Math.round(n*100) : NaN;
  };
  const todayMs = () => Date.now();
  const dateBR = x => {
    const m=normalize(x).match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d\d):(\d\d))?/);
    if (!m) return NaN;
    return Date.parse(m[3]+'-'+m[2]+'-'+m[1]+'T'+(m[4]||'00')+':'+(m[5]||'00')+':00-03:00');
  };
  const departureMs = e => {
    const d=normalize(e.dataViagem), t=normalize(e.horaPartida);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{1,2}:\d{2}$/.test(t)) return NaN;
    return Date.parse(d+'T'+t.padStart(5,'0')+':00-03:00');
  };
  const get = (row,cols,key) => cols[key]===undefined?'':normalize(row[cols[key]]);
  const active = status => /^(pendente|aguardando pagamento)$/i.test(normalize(status));
  const pending = pg => /^(pendente|aguardando pagamento|approved|accredited|)$/i.test(normalize(pg));
  const moneyOk = (payment, rows) => rows.length &&
    rows.every(e=>cents(e.valor)>0) &&
    rows.reduce((a,e)=>a+cents(e.valor),0)===cents(payment.transaction_amount);
  const notify = (event, detail) => console.log('[PIX][Recon]',event,JSON.stringify(detail));
  async function requestPayment(url) {
    const response=await fetch(url,{headers:{Authorization:'Bearer '+accessToken}});
    const raw=await response.text();
    let body={}; try{body=JSON.parse(raw)}catch{}
    if (!response.ok) throw new Error('MP search HTTP '+response.status+' '+normalize(body.message||raw).slice(0,200));
    return body;
  }
  async function paymentCandidates(reference, paymentId) {
    if (paymentId && /^\d+$/.test(paymentId)) {
      const payment=await requestPayment('https://api.mercadopago.com/v1/payments/'+encodeURIComponent(paymentId));
      return [payment];
    }
    const url='https://api.mercadopago.com/v1/payments/search?external_reference='+
      encodeURIComponent(reference)+'&limit=50';
    const found=await requestPayment(url);
    if (!Array.isArray(found.results)) throw Error('Resposta inesperada de search payments');
    if (Number(found.paging?.total||found.results.length)>found.results.length)
      throw Error('Resultados paginados; conciliação manual obrigatória');
    return found.results;
  }
  async function scan({onlyReference=null}={}) {
    if (running) return {skipped:'already_running'};
    running=true;
    const result={checked:0,approved:0,pending:0,manual:0,autoIssued:0,errors:0};
    try {
      const sheet=await sheets();
      const data=await sheet.spreadsheets.values.get({
        spreadsheetId,range:sheetTab+'!A:BZ'
      });
      const values=data.data.values||[];
      if (!values.length) return result;
      const hdr=(values[0]||[]).map(headerKey);
      const idx = names => {
        for(const name of names){const i=hdr.indexOf(headerKey(name));if(i>=0)return i;}
        throw Error('Coluna obrigatória ausente: '+names[0]);
      };
      const cols={
        reference:idx(['Referencia']), paymentId:idx(['idPagamento','ID_Pagamento']),
        status:idx(['Status']), paymentStatus:idx(['StatusPagamento']),
        value:idx(['Valor']), number:idx(['NumPassagem']), date:idx(['Data/horaSolicitação']),
        dataViagem:idx(['Data_Viagem']), horaPartida:idx(['Hora_Partida']),
        idViagem:idx(['IdViagem']),idOrigem:idx(['IdOrigem']),idDestino:idx(['IdDestino']),
        poltrona:idx(['poltrona'])
      };
      const groups=new Map();
      for(let i=1;i<values.length;i++){
        const raw=values[i], ref=get(raw,cols,'reference');
        if (!ref || (onlyReference && ref!==onlyReference)) continue;
        const row={
          sheetRow:i+1,reference:ref,paymentId:get(raw,cols,'paymentId'),
          status:get(raw,cols,'status'), paymentStatus:get(raw,cols,'paymentStatus'),
          valor:get(raw,cols,'value'),numPassagem:get(raw,cols,'number'),
          created:get(raw,cols,'date'),dataViagem:get(raw,cols,'dataViagem'),
          horaPartida:get(raw,cols,'horaPartida'),idViagem:get(raw,cols,'idViagem'),
          idOrigem:get(raw,cols,'idOrigem'),idDestino:get(raw,cols,'idDestino'),
          poltrona:get(raw,cols,'poltrona')
        };
        if(!groups.has(ref))groups.set(ref,[]);
        groups.get(ref).push(row);
      }
      const candidates=[...groups.entries()].filter(([ref,rows])=>
        rows.some(r=>pending(r.paymentStatus)) &&
        rows.every(r=>active(r.status)&&!r.numPassagem) &&
        (onlyReference || rows.some(r=>{
          const ts=dateBR(r.created);
          return Number.isFinite(ts) && ts <= todayMs()-60000 &&
            ts>=todayMs()-lookbackHours*3600000;
        }))
      ).slice(0,onlyReference?1:maxRefs);
      for(const [ref,rows] of candidates){
        result.checked++;
        try {
          if(inFlight.has(ref))continue;
          inFlight.add(ref);
          try {
            if (!onlyReference && recentlyReported.has(ref) && recentlyReported.get(ref) > Date.now()) continue;
            const ids=[...new Set(rows.map(x=>x.paymentId).filter(Boolean))];
            if(ids.length>1)throw Error('IDs de pagamento divergentes no mesmo pedido');
            const found=await paymentCandidates(ref,ids[0]);
            const exact=found.filter(p=>normalize(p.external_reference)===ref &&
              String(p.payment_method_id||'').toLowerCase()==='pix');
            const approved=exact.filter(p=>['approved','accredited'].includes(String(p.status||'').toLowerCase()));
            if(approved.length!==1){
              if(approved.length>1)throw Error('Mais de um PIX aprovado para a referência');
              result.pending++; continue;
            }
            const payment=approved[0];
            if(ids.length && String(payment.id)!==ids[0]) throw Error('ID da planilha difere do MP');
            if(!moneyOk(payment,rows))throw Error('Valor pago diverge do valor das passagens');
            const seats=new Set(rows.map(e=>[e.idViagem,e.idOrigem,e.idDestino,e.dataViagem,e.horaPartida,e.poltrona].join('|')));
            if(seats.size!==rows.length)throw Error('Poltronas duplicadas na mesma viagem');
            if(rows.some(e=>!e.idViagem||!e.idOrigem||!e.idDestino))throw Error('Viagem sem identificadores');
            result.approved++;
            notify('approved_orphan',{ref,paymentId:payment.id,legs:rows.length,amount:payment.transaction_amount});
            // Escrita financeira fica com o mesmo webhook já existente; jamais
            // registrar emissão sem confirmação definitiva na Praxio.
            if(!autoIssue) {
              // O pagamento é real, mas o fato de NumPassagem estar vazio
              // não prova que a Praxio nunca tenha emitido.
              if (typeof onApproved === 'function') await onApproved({reference:ref,payment,rows});
              recentlyReported.set(ref,Date.now()+12*60*60*1000);
              result.manual++;
              continue;
            }
            // Na conciliação de PIX já pago, permitir emissão no próprio dia
            // da viagem mesmo após a hora prevista. Uma viagem de data anterior
            // continua bloqueada. Ida e volta são verificadas separadamente.
            const todayBR = new Intl.DateTimeFormat('en-CA', {
              timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'
            }).format(new Date());
            const expiredLegs=rows.filter(e=>
              !/^\d{4}-\d{2}-\d{2}$/.test(e.dataViagem) || e.dataViagem<todayBR
            );
            if(expiredLegs.length) {
              result.manual++;
              notify('manual_departure',{ref,paymentId:payment.id,expiredLegs:expiredLegs.length});
              continue;
            }
            if(typeof beforeIssue==='function'){
              const allowed=await beforeIssue({reference:ref,payment,rows});
              if(!allowed){result.manual++;continue;}
            }
            await processPayment(payment);
            result.autoIssued++;
          } finally {inFlight.delete(ref);}
        }catch(e){
          result.errors++;
          console.error('[PIX][Recon] Falha referência',ref,e?.message||e);
        }
      }
      return result;
    }finally{running=false;}
  }
  let timer=null;
  function start(){
    if(timer)return;
    timer=setInterval(()=>{scan().then(summary=>notify('cycle',summary)).catch(e=>console.error('[PIX][Recon] ciclo',e))},intervalMs);
    timer.unref?.();
    notify('started',{intervalMs,lookbackHours,maxRefs,autoIssue});
  }
  function stop(){if(timer)clearInterval(timer);timer=null;}
  return {start,stop,scan};
};
