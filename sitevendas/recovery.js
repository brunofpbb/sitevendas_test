document.addEventListener('DOMContentLoaded', async () => {
  const context = JSON.parse(localStorage.getItem('seatRecoveryContext') || 'null');
  const $ = id => document.getElementById(id);
  const msg=$('recovery-message'),route=$('recovery-route'),choices=$('recovery-choices'),title=$('recovery-title');
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
  const openedAt=Date.now();
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
      title.textContent='Bilhete emitido com sucesso!';
      msg.textContent='Sua nova poltrona foi confirmada. O bilhete está disponível na área Minhas compras.';
      stopPoll();localStorage.removeItem('seatRecoveryContext');return;
    }
    if(info.state==='refunded') {
      title.textContent='Reembolso solicitado com sucesso';
      msg.textContent='O reembolso integral foi registrado no Mercado Pago. O prazo de recebimento depende do meio de pagamento utilizado.';
      stopPoll();localStorage.removeItem('seatRecoveryContext');return;
    }
    if(info.state==='manual') {
      title.textContent='Estamos conferindo sua compra';
      msg.textContent='A situação desta compra precisa ser verificada pela equipe responsável. Você não precisa pagar novamente.';
      stopPoll();return;
    }
    if(info.state==='refunding'||info.state==='reissuing'){
      title.textContent=info.state==='reissuing'?'Estamos emitindo seu bilhete':'Estamos processando seu reembolso';
      msg.textContent=info.state==='reissuing'?'Seu pagamento já foi confirmado. Aguarde enquanto finalizamos a emissão, sem nova cobrança.':'Sua solicitação foi recebida. Aguarde a confirmação do Mercado Pago.';
      return;
    }
    if(info.state!=='seat_unavailable'){
      msg.textContent='O PIX foi aprovado, mas ainda não há confirmação da emissão nem registro de poltrona indisponível. Estamos consultando o andamento da compra; nenhuma ação financeira será feita automaticamente.';
      route.hidden=false;
      route.textContent='Status da emissão: aguardando confirmação da Praxio / processamento do webhook.';
      if(Date.now()-openedAt>120000){
        msg.textContent='Ainda não foi possível confirmar o resultado da emissão. Não faça um novo pagamento. Acesse Minhas compras e, se continuar Pendente, informe o comprovante do PIX ao suporte para localizar a operação.';
        stopPoll();
      }
      return;
    }
    stopPoll();
    title.textContent='Sua poltrona ficou indisponível';
    msg.textContent='A poltrona '+info.seat+' ficou indisponível antes da emissão. Seu pagamento de '+money(info.amount)+' está confirmado. Você pode escolher outra poltrona na mesma viagem, sem pagar novamente, ou solicitar o reembolso integral.';
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
          submitted=true;mode='issuing';stage.hidden=true;title.textContent='Estamos emitindo seu bilhete';msg.textContent='Seu pagamento já está confirmado. Aguarde enquanto finalizamos a emissão, sem nova cobrança.';
          try {
            await request('issue',{...identity,seatNumber,idTipoVeiculo:schedule.idTipoVeiculo||''});
            msg.textContent='Estamos finalizando o registro do seu bilhete. Em instantes, ele estará disponível em Minhas compras.';
            stopPoll();
            mode='checking';
            poll=setInterval(refresh,5000);
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
    submitted=true;choices.hidden=true;title.textContent='Estamos processando seu reembolso';msg.textContent='Sua solicitação está sendo encaminhada ao Mercado Pago. Aguarde a confirmação.';
    try{
      await request('refund',identity);
      title.textContent='Reembolso solicitado com sucesso';msg.textContent='O valor integral foi solicitado ao Mercado Pago. O crédito seguirá os prazos do meio de pagamento.';
      localStorage.removeItem('seatRecoveryContext');
    }catch(e){msg.textContent=e.message;notify('Não efetue outro pagamento. Caso o reembolso não seja confirmado, o suporte será notificado.');}
    finally{submitted=false;}
  };
  await refresh();
  if(!['seat_unavailable','issued','refunded','manual'].includes(current?.state))poll=setInterval(refresh,5000);
});