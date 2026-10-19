document.addEventListener('DOMContentLoaded', async () => {
  const context = JSON.parse(localStorage.getItem('seatRecoveryContext') || 'null');
  const $ = id => document.getElementById(id);
  const msg=$('recovery-message'),route=$('recovery-route'),choices=$('recovery-choices');
  const newSeat=$('recovery-new-seat'),refund=$('recovery-refund'),stage=$('recovery-seats'),alertEl=$('recovery-alert');
  const notify = text => {alertEl.textContent=text;alertEl.hidden=!text;};
  const request=async(path,body)=>{
    const r=await fetch('/api/recovery/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.ok){const e=new Error(data.error||'Não foi possível completar a solicitação.');e.code=data.code;throw e;}
    return data;
  };
  if(!context?.paymentId||!context?.reference||!context?.email){
    msg.textContent='Não encontramos os dados desta compra neste navegador. Acesse Minhas compras ou contate o suporte.';
    return;
  }
  let current=null,poll=null,submitted=false,mode='checking';
  const identity={paymentId:context.paymentId,reference:context.reference,email:context.email};
  const money=v=>(Number(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const stopPoll=()=>{if(poll){clearInterval(poll);poll=null;}};
  async function refresh() {
    let info;
    try{info=await request('state',identity);}
    catch(e){msg.textContent=e.message;return;}
    current=info;
    if(mode==='choosing')return;
    choices.hidden=true;stage.hidden=true;notify('');
    if(info.state==='issued') {
      msg.textContent='Seu bilhete foi emitido. Você pode consultá-lo em Minhas compras.';
      stopPoll();localStorage.removeItem('seatRecoveryContext');return;
    }
    if(info.state==='refunded') {
      msg.textContent='Reembolso integral solicitado e registrado no Mercado Pago. O prazo de crédito depende do meio de pagamento.';
      stopPoll();localStorage.removeItem('seatRecoveryContext');return;
    }
    if(info.state==='manual') {
      msg.textContent='Esta compra exige conferência do suporte. Não tente pagar novamente.';
      stopPoll();return;
    }
    if(info.state==='refunding'||info.state==='reissuing'){
      msg.textContent='Estamos concluindo sua solicitação. Aguarde, sem realizar outro pagamento.';
      return;
    }
    if(info.state!=='seat_unavailable'){
      msg.textContent='Pagamento confirmado. Estamos aguardando a conclusão da emissão. Você não precisa pagar novamente.';
      return;
    }
    stopPoll();
    msg.textContent='A poltrona '+info.seat+' ficou indisponível antes da emissão. Seu pagamento de '+money(info.amount)+' está confirmado. Escolha outra poltrona na mesma viagem, sem pagar novamente, ou solicite 100% de reembolso.';
    const s=info.schedule||{};
    route.hidden=false;
    route.textContent=[s.originName+' → '+s.destinationName,s.date,s.horaPartida].filter(Boolean).join(' • ');
    choices.hidden=false;
    newSeat.hidden=true;
    refund.hidden=false;
    // Não oferecer nova poltrona até existir disponibilidade realmente confirmada.
    try {
      const schedule={...s,...(context.schedule||{}),seats:undefined};
      const resp=await fetch('/api/poltronas',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({idViagem:s.idViagem,idLocOrigem:s.idOrigem,idLocDestino:s.idDestino,idTipoVeiculo:schedule.idTipoVeiculo||''})});
      if(!resp.ok)throw Error('consulta indisponível');
      const raw=await resp.json(),data=Array.isArray(raw)?raw[0]:raw;
      let rows=data?.LaypoltronaXml?.PoltronaXmlRetorno||data?.PoltronaXmlRetorno||[];
      rows=Array.isArray(rows)?rows:[rows];
      schedule.seats=rows.map(p=>({number:Number(p.Caption??p.caption??p.Numero??p.NumeroPoltrona),situacao:Number(p.Situacao??p.situacao??-1)}))
        .filter(p=>Number.isInteger(p.number)&&p.number>=1&&p.number<=42)
        .map(p=>({...p,occupied:p.situacao!==0||p.number===Number(info.seat)}));
      const free=schedule.seats.filter(p=>!p.occupied&&p.number>2);
      if(!free.length){notify('Não encontramos outra poltrona disponível nesta viagem. Você pode solicitar o reembolso integral.');return;}
      newSeat.hidden=false;
      newSeat.onclick=async()=>{
        if(submitted)return;
        mode='choosing';choices.hidden=true;stage.hidden=false;stage.innerHTML='';
        await window.renderSeats(stage,schedule,'ida',{recovery:true,passenger:info.passenger});
        stage.querySelectorAll('.pax-row input').forEach(el=>{el.readOnly=true;});
        stage.addEventListener('seats:back',()=>{mode='checking';stage.hidden=true;choices.hidden=false;},{once:true});
        stage.addEventListener('seats:confirm',async e=>{
          if(submitted)return;
          const seatNumber=e.detail?.seats?.[0];
          if(!seatNumber)return;
          submitted=true;mode='issuing';stage.hidden=true;msg.textContent='Emitindo seu bilhete, sem nova cobrança. Aguarde…';
          try {
            await request('issue',{...identity,seatNumber,idTipoVeiculo:schedule.idTipoVeiculo||''});
            msg.textContent='Bilhete emitido! Consulte-o em Minhas compras.';
            localStorage.removeItem('seatRecoveryContext');
            stopPoll();
          } catch(err) {
            msg.textContent=err.message;
            submitted=false;mode='checking';
            if(err.code==='SEAT_UNAVAILABLE'){setTimeout(refresh,500);}
            else {choices.hidden=true;notify('Não tente efetuar novo pagamento.');}
          }
        },{once:true});
      };
    }catch(err){notify('Não foi possível consultar outros assentos agora. O reembolso integral está disponível.');}
  }
  refund.onclick=async()=>{
    if(submitted||!current||current.state!=='seat_unavailable')return;
    if(!confirm('Solicitar devolução de 100% do valor pago? Depois da confirmação, não será possível emitir o bilhete.'))return;
    submitted=true;choices.hidden=true;msg.textContent='Solicitando reembolso integral ao Mercado Pago…';
    try{
      await request('refund',identity);
      msg.textContent='Reembolso integral solicitado com sucesso. O crédito seguirá os prazos do Mercado Pago.';
      localStorage.removeItem('seatRecoveryContext');
    }catch(e){msg.textContent=e.message;notify('Não efetue outro pagamento. Caso o reembolso não seja confirmado, o suporte será notificado.');}
    finally{submitted=false;}
  };
  await refresh();
  if(!['seat_unavailable','issued','refunded','manual'].includes(current?.state))poll=setInterval(refresh,5000);
});