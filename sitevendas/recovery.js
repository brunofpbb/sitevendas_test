document.addEventListener('DOMContentLoaded', async () => {
  const context = JSON.parse(localStorage.getItem('seatRecoveryContext') || 'null');
  const $ = id => document.getElementById(id);
  const msg=$('recovery-message'),route=$('recovery-route'),choices=$('recovery-choices'),title=$('recovery-title');
  const newSeat=$('recovery-new-seat'),refund=$('recovery-refund'),groupRefund=$('recovery-group-refund'),ticketsEl=$('recovery-tickets'),stage=$('recovery-seats'),alertEl=$('recovery-alert');
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
  const identity={paymentId:context.paymentId,reference:context.reference,email:context.email,idTipoVeiculo:(context.schedule||{}).idTipoVeiculo||''};
  const money=v=>(Number(v)||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const dateBR=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||'')) ? v.slice(8,10)+'/'+v.slice(5,7)+'/'+v.slice(0,4) : (v||'');
  const stopPoll=()=>{if(poll){clearInterval(poll);poll=null;}};

  async function showGroup(info) {
    stopPoll();
    title.textContent='Vamos concluir a viagem do seu grupo';
    // Uma compra pode conter ida e volta, até com a mesma poltrona.
    // Recuperar somente os passageiros do trecho indicado pelo servidor.
    const failed=info.activeFailures||[];
    const issued=(info.tickets||[]).filter(t=>t.issued);
    const capacity=info.freeSeats;
    msg.textContent=info.failedCount+' poltrona(s) da compra ficaram indisponíveis. '+issued.length+
      ' bilhete(s) já foram emitidos. Você não precisa realizar outro pagamento.'+
      (info.failedCount>failed.length?' Vamos resolver um trecho de cada vez.':'');
    route.hidden=false;
    const s=info.schedule||{};
    route.textContent=[s.originName+' → '+s.destinationName,dateBR(s.date),s.horaPartida].filter(Boolean).join(' • ');
    ticketsEl.hidden=false;
    ticketsEl.replaceChildren();
    for(const t of info.tickets||[]){
      const card=document.createElement('div');
      card.className='recovery-ticket '+(t.issued?'ok':'failed');
      const strong=document.createElement('strong');
      strong.textContent=t.passenger || 'Passageiro';
      const status=document.createElement('span');
      status.textContent=(t.wayType==='volta'?'Volta':'Ida')+' • '+(t.originName||'')+' → '+(t.destinationName||'')+
        ' • Poltrona '+t.seat+' • '+(t.issued?'Bilhete emitido':'Escolha outra poltrona');
      card.append(strong,status);ticketsEl.appendChild(card);
    }
    choices.hidden=false;stage.hidden=true;
    newSeat.hidden=!info.canReplace;
    newSeat.textContent=failed.length===1?'Escolher outra poltrona':'Escolher novas poltronas';
    refund.hidden=false;
    refund.textContent=issued.length?'Reembolsar apenas os bilhetes sem emissão':'Solicitar reembolso integral';
    groupRefund.hidden=!(info.canGroupRefund && issued.length>0);
    notify('');
    if(capacity===null){
      notify('Não foi possível conferir a disponibilidade agora. A opção de trocar poltronas será habilitada após nova consulta.');
    }else if(info.canGroupRefund){
      notify('Uma das viagens não tem vagas suficientes para os passageiros sem emissão. Você também pode cancelar os bilhetes já emitidos e solicitar reembolso integral de toda a compra.');
    }
    newSeat.onclick=async()=>{
      if(submitted)return;
      mode='choosing';choices.hidden=true;stage.hidden=false;stage.replaceChildren();
      try{
        const trip={...(context.schedule||{}),...info.schedule};
        const r=await fetch('/api/poltronas',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({idViagem:s.idViagem,idLocOrigem:s.idOrigem,idLocDestino:s.idDestino,
            idTipoVeiculo:trip.idTipoVeiculo||''})});
        if(!r.ok)throw Error('A disponibilidade não pôde ser consultada.');
        const raw=await r.json(),data=Array.isArray(raw)?raw[0]:raw;
        const items=data?.LaypoltronaXml?.PoltronaXmlRetorno || data?.PoltronaXmlRetorno || [];
        const rows=Array.isArray(items)?items:[items];
        const busy=new Set((info.tickets||[]).filter(t=>t.issued).map(t=>Number(t.seat)));
        trip.seats=rows.map(p=>({number:Number(p.Caption??p.caption??p.Numero??p.NumeroPoltrona),
          situacao:Number(p.Situacao??p.situacao??-1)}))
          .filter(p=>Number.isInteger(p.number)&&p.number>=1&&p.number<=42)
          .map(p=>({...p,occupied:p.situacao!==0||busy.has(p.number)}));
        await window.renderSeats(stage,trip,info.wayType||'ida',{recovery:true,recoveryCount:failed.length,
          passengers:failed.map(t=>({name:t.passenger,cpf:t.cpf,phone:t.phone}))});
        stage.addEventListener('seats:back',()=>{mode='checking';stage.hidden=true;choices.hidden=false;},{once:true});
        stage.addEventListener('seats:confirm',async e=>{
          if(submitted)return;
          const selections=e.detail?.seats||[];
          if(selections.length!==failed.length)return;
          submitted=true;mode='issuing';stage.hidden=true;
          title.textContent='Estamos emitindo os bilhetes';
          msg.textContent='Estamos confirmando as novas poltronas sem cobrar novamente. Aguarde.';
          try{
            await request('issue-batch',{...identity,idTipoVeiculo:trip.idTipoVeiculo||'',
              trip:{idViagem:s.idViagem,idOrigem:s.idOrigem,idDestino:s.idDestino,
                dataViagem:s.dataViagem||s.date,horaPartida:s.horaPartida},
              replacements:failed.map((t,i)=>({oldSeat:t.seat,newSeat:selections[i]}))});
            title.textContent='Estamos finalizando a emissão';
            msg.textContent='A emissão foi encaminhada. Aguarde a confirmação dos bilhetes em Minhas compras.';
            submitted=false;mode='checking';stopPoll();poll=setInterval(refresh,5000);
          }catch(err){
            submitted=false;mode='checking';msg.textContent=err.message;
            if(err.code==='SEAT_UNAVAILABLE')setTimeout(refresh,500);
            else notify('Não realize outro pagamento. O suporte poderá conferir a emissão.');
          }
        },{once:true});
      }catch(err){
        mode='checking';stage.hidden=true;choices.hidden=false;
        notify(err.message||'Falha ao abrir o mapa de poltronas.');
      }
    };
    refund.onclick=()=>performGroupRefund('refund-failed',
      'Deseja receber o valor dos bilhetes não emitidos? Os bilhetes já emitidos continuarão válidos.');
    groupRefund.onclick=()=>performGroupRefund('refund-group',
      'Confirmar cancelamento de TODOS os bilhetes emitidos e reembolso de 100% da compra? Esta ação não pode ser desfeita.');
    async function performGroupRefund(endpoint,confirmation){
      if(submitted||!confirm(confirmation))return;
      submitted=true;choices.hidden=true;title.textContent='Estamos processando sua solicitação';
      msg.textContent='Estamos verificando os bilhetes e encaminhando o reembolso. Aguarde.';
      try{
        const result=await request(endpoint,{...identity,idTipoVeiculo:(context.schedule||{}).idTipoVeiculo||''});
        title.textContent='Reembolso solicitado com sucesso';
        msg.textContent=endpoint==='refund-group'?
          'Os bilhetes do grupo foram cancelados e o reembolso integral foi solicitado ao Mercado Pago.':
          (issued.length ? 'O reembolso das poltronas não emitidas foi solicitado. Os demais bilhetes continuam válidos.' : 'O reembolso integral da compra foi solicitado ao Mercado Pago.');
        if(result.state==='refunded')localStorage.removeItem('seatRecoveryContext');
        stopPoll();
      }catch(err){
        title.textContent='Solicitação precisa de conferência';
        msg.textContent=err.message;notify('Não realize outro pagamento nem tente repetir a operação. O suporte poderá verificar o estado.');
      }finally{submitted=false;}
    }
  }

  async function refresh() {
    let info;
    try{info=await request('state',identity);}
    catch(e){msg.textContent=e.message;return;}
    current=info;
    if(mode==='choosing')return;
    choices.hidden=true;stage.hidden=true;notify('');
    if(info.state==='partially_refunded') {
      ticketsEl.hidden=true;
      title.textContent='Reembolso parcial solicitado';
      msg.textContent='Os bilhetes emitidos continuam válidos. O valor das poltronas que não foram emitidas foi solicitado ao Mercado Pago.';
      stopPoll();return;
    }
    if(info.state==='issued') {
      ticketsEl.hidden=true;
      title.textContent=info.multiple?'Bilhetes emitidos com sucesso!':'Bilhete emitido com sucesso!';
      msg.textContent=info.multiple?'As poltronas do grupo foram confirmadas. Os bilhetes estão disponíveis em Minhas compras.':'Sua nova poltrona foi confirmada. O bilhete está disponível na área Minhas compras.';
      stopPoll();localStorage.removeItem('seatRecoveryContext');return;
    }
    if(info.state==='refunded') {
      ticketsEl.hidden=true;
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
      if(Date.now()-openedAt>120000){
        title.textContent='Sua solicitação precisa de conferência';
        msg.textContent='A operação ainda não foi confirmada. Não faça uma nova compra nem repita a solicitação. Consulte Minhas compras ou entre em contato com o suporte.';
        stopPoll();return;
      }
      title.textContent=info.state==='reissuing'?'Estamos emitindo seu bilhete':'Estamos processando seu reembolso';
      msg.textContent=info.state==='reissuing'?'Seu pagamento já foi confirmado. Aguarde enquanto finalizamos a emissão, sem nova cobrança.':'Sua solicitação foi recebida. Aguarde a confirmação do Mercado Pago.';
      return;
    }
    if(info.state!=='seat_unavailable'){
      const method=String(info.paymentMethod||'').toLowerCase()==='pix' ? 'PIX' :
        (String(info.paymentType||'').includes('card') ? 'cartão' : 'pagamento');
      title.textContent='Estamos verificando sua emissão';
      msg.textContent='Seu pagamento por '+method+' foi aprovado. Estamos conferindo os resultados da emissão de todas as poltronas. Você não precisa pagar novamente.';
      route.hidden=false;
      route.textContent='Situação: conferindo emissão na Praxio e registro dos bilhetes.';
      if(Date.now()-openedAt>120000){
        title.textContent='Precisamos conferir sua compra';
        msg.textContent='Seu pagamento está confirmado, mas a emissão ainda não foi conciliada. Não realize outro pagamento nem solicite reemissão. Consulte Minhas compras e, se necessário, contate o suporte com a referência da compra.';
        stopPoll();
      }
      return;
    }
    if(info.multiple){await showGroup(info);return;}
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