// payment.js — Resumo + Bricks + PIX (QR + copia-e-cola + polling)
document.addEventListener('DOMContentLoaded', async () => {
  // ——— login obrigatório
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user || !user.email || !user.email.trim()) {
    console.warn('[Payment] User sem email ou não logado. Redirecionando.');
    localStorage.removeItem('user'); // Força limpeza de estado inválido
    localStorage.setItem('postLoginRedirect', 'payment.html');
    location.href = 'login.html';
    return;
  }
  if (typeof updateUserNav === 'function') updateUserNav();

  // ——— DOM
  const summaryBodyEl = document.getElementById('summary-body');
  const summaryTotalEl = document.getElementById('summary-total');
  const legacySummaryEl = document.getElementById('order-summary');
  const cancelBtn = document.getElementById('btn-cancel') || document.getElementById('cancel-order');

  // PIX UI
  const pixBox = document.getElementById('pix-box');
  const pixQR = document.getElementById('pix-qr');
  const pixCode = document.getElementById('pix-code');
  const pixCopy = document.getElementById('pix-copy');
  const pixStatus = document.getElementById('pix-status');

  // ——— utils
  const fmtBRL = (n) => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '') ?? '';
  const formatDateBR = (iso) => {
    if (typeof iso !== 'string' || !iso.includes('-')) return iso || '';
    const [y, m, d] = iso.split('-');
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
  };

  // normaliza "DD/MM/YYYY" -> "YYYY-MM-DD" (ou mantém se já vier ISO)
  function toYMD(dateStr) {
    if (!dateStr) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    const m = String(dateStr).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    const t = Date.parse(dateStr);
    if (!Number.isNaN(t)) {
      const z = new Date(t);
      const yyyy = z.getFullYear();
      const mm = String(z.getMonth() + 1).padStart(2, '0');
      const dd = String(z.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }
    return '';
  }


  // ====== PIX polling
  const POLL_MS = 5000;                   // 5s entre consultas
  const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 min máximo
  let pixPollTimer = null;

  async function fetchPaymentStatus(paymentId) {
    // tenta /payment-status?id=... e /payment/:id (use o que seu backend expõe)
    let r = await fetch(`/api/mp/payment-status?id=${paymentId}`).catch(() => null);
    if (!r || !r.ok) r = await fetch(`/api/mp/payment/${paymentId}`).catch(() => null);
    if (!r || !r.ok) throw new Error('Falha ao consultar status do pagamento');
    return r.json();
  }
  function setPixStatus(msg) {
    if (pixStatus) pixStatus.textContent = msg;
  }

  // ===== Overlay (mostra uma vez durante a emissão)
  let overlayShown = false;
  function showOverlayOnce(
    title = 'Pagamento confirmado!',
    subtitle = 'Emitindo bilhete, por favor aguarde!'
  ) {
    if (overlayShown) return;
    overlayShown = true;

    if (typeof showIssuanceOverlay === 'function') {
      showIssuanceOverlay(title);
      const subEl = document.querySelector('#issuance-overlay .io-sub');
      if (subEl) subEl.textContent = subtitle;
    }
  }
  function hideOverlayIfShown() {
    if (!overlayShown) return;
    overlayShown = false;
    if (typeof hideIssuanceOverlay === 'function') hideIssuanceOverlay();
  }

  // === helper: salva links do bilhete no booking/localStorage ===
  function mergeDriveLinksIntoBookings(arquivos) {
    if (!Array.isArray(arquivos) || !arquivos.length) return;
    const all = JSON.parse(localStorage.getItem('bookings') || '[]');
    if (!all.length) return;
    const last = all[all.length - 1];

    last.paid = true;
    last.paidAt = new Date().toISOString();
    last.tickets = arquivos.map(a => ({
      numPassagem: a.numPassagem || a.NumPassagem || null,
      driveUrl: a.driveUrl || null,
      pdfLocal: a.pdfLocal || null,
      url: a.driveUrl || a.pdfLocal || null
    }));

    const first = last.tickets[0] || {};
    last.ticketUrl = first.url || null;
    last.driveUrl = first.driveUrl || null;
    last.pdfLocal = first.pdfLocal || null;
    last.ticketNumber = first.numPassagem || null;

    localStorage.setItem('bookings', JSON.stringify(all));
    localStorage.setItem('lastTickets', JSON.stringify(
      arquivos.map(a => ({
        numPassagem: a.numPassagem || a.NumPassagem || null,
        driveUrl: a.driveUrl || null,
        pdfLocal: a.pdfLocal || null
      }))
    ));
  }

  // ——— carrinho
  // MODIFICADO: Se existir 'pendingPurchase' (vindo do login/busca recente), 
  // ele deve SOBRESCREVER quaisquer itens "abertos" antigos no bookings.
  function mergePendingPurchase() {
    const pendingJson = localStorage.getItem('pendingPurchase');
    if (!pendingJson) return; // nada novo pendente

    try {
      const p = JSON.parse(pendingJson);
      if (p && Array.isArray(p.legs) && p.legs.length > 0) {
        console.log('[Cart] Encontrada compra pendente recente. Atualizando carrinho...');
        const allBookings = JSON.parse(localStorage.getItem('bookings') || '[]');

        // Mantém apenas o histórico pago
        const paidOnly = allBookings.filter(b => b.paid === true);

        // Adiciona os novos itens pendentes
        const newBookings = [...paidOnly, ...p.legs];

        localStorage.setItem('bookings', JSON.stringify(newBookings));
        localStorage.removeItem('pendingPurchase'); // consome
      }
    } catch (e) {
      console.error('[Cart] Erro ao mesclar compra pendente:', e);
    }
  }

  // Executa a mesclagem ao iniciar
  mergePendingPurchase();

  function readCart() {
    const b = JSON.parse(localStorage.getItem('bookings') || '[]');
    // Agora o 'bookings' já deve conter o que era 'pendingPurchase' se houver
    const open = b.filter(x => x.paid !== true);
    return open;
  }

  // Verifica datas retroativas e remove itens expirados
  function validateCartDates(cartItems) {
    if (!Array.isArray(cartItems) || cartItems.length === 0) return cartItems;

    // Data de hoje (YYYY-MM-DD) local
    const now = new Date();
    // Ajuste simples p/ fuso -3 ou pega data local string
    const todayStr = now.toLocaleDateString('pt-BR').split('/').reverse().join('-');
    // ou: const todayStr = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];

    const validItems = [];
    let removedCount = 0;

    cartItems.forEach(item => {
      // Tenta normalizar a data do item (esperado YYYY-MM-DD)
      const dateRaw = item.schedule?.date || item.dataViagem || '';
      const dateYMD = toYMD(dateRaw);

      // Se não tiver data, deixamos passar (ou bloqueamos? Assumindo passar p/ não quebrar dados legados sem data)
      if (!dateYMD) {
        validItems.push(item);
        return;
      }

      // Comparação lexical YYYY-MM-DD funciona bem
      if (dateYMD < todayStr) {
        console.warn(`[Cart] Removendo item expirado: ${dateYMD} < ${todayStr}`, item);
        removedCount++;
      } else {
        validItems.push(item);
      }
    });

    if (removedCount > 0) {
      alert(`Atenção: ${removedCount} item(s) com data expirada foram removidos do seu carrinho.`);
      // Atualiza o localStorage com a lista limpa
      const allBookings = JSON.parse(localStorage.getItem('bookings') || '[]');
      const paidOnly = allBookings.filter(b => b.paid === true);
      localStorage.setItem('bookings', JSON.stringify([...paidOnly, ...validItems]));
      return validItems;
    }

    return cartItems;
  }

  // Lê carrinho e valida datas
  let rawCart = readCart();
  rawCart = validateCartDates(rawCart);

  // explode um booking em N itens (um por poltrona) e guarda ponteiros do item original
  function expandCartItems(raw) {
    const out = [];
    (raw || []).forEach((it, openIdx) => {
      const seats = Array.isArray(it.seats) ? it.seats : [];
      const pax = Array.isArray(it.passengers) ? it.passengers : [];
      // se já está unitário, só garante ponteiros
      if (seats.length <= 1) {
        out.push({ ...it, _srcOpenIdx: openIdx, _seat: seats[0] ?? null });
        return;
      }
      seats.forEach(seat => {
        const p = pax.find(x => Number(x.seatNumber || x.poltrona) === Number(seat));
        out.push({
          ...it,
          seats: [seat],
          passengers: p ? [{ ...p, seatNumber: seat }] : [],
          _srcOpenIdx: openIdx,
          _seat: seat
        });
      });
    });
    return out;
  }


  // let order = readCart();
  let order = expandCartItems(rawCart);


  // tenta inferir ida/volta a partir dos dois primeiros trechos
  function inferTripTypeForOrder(order) {
    if (!Array.isArray(order) || order.length === 0) return 'ida';

    // respeito a marcação explícita, se já existir
    if (order.some(it => it.isReturn === true || it.tripType === 'volta')) return 'volta';

    if (order.length >= 2) {
      const getIds = (it) => {
        const s = it?.schedule || {};
        return {
          o: s.originId || s.idOrigem || s.CodigoOrigem || s.origemId || s.origem,
          d: s.destinationId || s.idDestino || s.CodigoDestino || s.destinoId || s.destino,
          date: s.date || s.dataViagem,
        };
      };
      const a = getIds(order[0]);
      const b = getIds(order[1]);
      const swapped = a.o && a.d && b.o && b.d && (a.o === b.d && a.d === b.o);
      const sameDate = a.date && b.date ? String(a.date) === String(b.date) : true;
      if (swapped && sameDate) return 'volta';
    }
    return 'ida';
  }

  // ===== valores
  const itemSubtotal = (it) => {
    const s = it.schedule || {};
    const unit = Number(String(s.price || 0).replace(',', '.')) || 0;
    return unit * ((it.seats || []).length || 0);
  };
  const cartTotal = () => order.reduce((acc, it) => acc + itemSubtotal(it), 0);

  // ===== helpers Praxio
  function getScheduleFromItem(it) {
    const s = it.schedule || {};
    return {
      idViagem: s.idViagem || s.IdViagem || s.id || s.Id || s.viagemId,
      horaPartida: s.horaPartida || s.departureTime,
      idOrigem: s.idOrigem || s.IdOrigem || s.originId || s.CodigoOrigem,
      idDestino: s.idDestino || s.IdDestino || s.destinationId || s.CodigoDestino,
      agencia: s.agencia || s.IdEstabelecimento || s.IdEstabelecimentoVenda || '93',
      date: toYMD(s.date || s.dataViagem || s.DataViagem || s.data || '')
    };
  }
  function getPassengersFromItem(it) {
    const pax = [];
    const seats = Array.isArray(it.seats) ? it.seats : [];
    const passengers = Array.isArray(it.passengers) ? it.passengers : [];
    if (passengers.length) {
      for (const p of passengers) {
        pax.push({
          seatNumber: p.seatNumber || p.poltrona || seats[0],
          name: p.name || p.nome || '',
          document: (p.document || p.cpf || '').toString(),
          phone: p.phone || p.telefone || ''
        });
      }
    } else {
      for (const seat of seats) {
        pax.push({ seatNumber: seat, name: (user.name || user.email || ''), document: '' });
      }
    }
    return pax;
  }


  // helper: classifica ida/volta comparando com a 1ª rota do carrinho
  function inferLegType(it, idx, order) {
    // 1) explicit flags vencem
    if (it.isReturn === true || it.tripType === 'volta') return 'volta';
    if (it.tripType === 'ida') return 'ida';

    // 2) extrai origem/destino do item atual
    const s = it?.schedule || {};
    const o = s.originId || s.idOrigem || s.CodigoOrigem;
    const d = s.destinationId || s.idDestino || s.CodigoDestino;

    // 3) extrai origem/destino da 1ª rota do carrinho (referência)
    const f = (order[0] && order[0].schedule) || {};
    const fO = f.originId || f.idOrigem || f.CodigoOrigem;
    const fD = f.destinationId || f.idDestino || f.CodigoDestino;

    // 4) compara com a referência
    if (o && d && fO && fD) {
      if (o === fO && d === fD) return 'ida';
      if (o === fD && d === fO) return 'volta';
    }

    // 5) fallback seguro
    return 'ida';
  }


  // ===== Pré-reserva no Sheets (antes de criar o pagamento) =====
  async function preRegistrarNoSheets(externalReference, explicitEmail) {
    try {
      if (!externalReference || !Array.isArray(order) || !order.length)
        throw new Error('Não foi possível identificar os bilhetes antes do pagamento.');

      const userLS = JSON.parse(localStorage.getItem('user') || 'null') || {};
      // Prioridade: Email passado explicitamente (do Form) > localStorage > vazio
      const userEmail = (explicitEmail || userLS.email || userLS.loginEmail || userLS.userEmail || '').toString().trim();
      // const userEmail = (userLS.email || '').toString();
      let userPhone = (userLS.phone || userLS.telefone || '').toString();

      // Fallback: se userPhone vazio, tenta pegar do 1º passageiro
      if (!userPhone && order[0]) {
        const paxFirst = getPassengersFromItem(order[0]);
        if (paxFirst[0]?.phone) userPhone = paxFirst[0].phone;
      }

      const bilhetes = [];

      order.forEach((it, idx) => {
        const s = getScheduleFromItem(it) || {};
        const paxList = getPassengersFromItem(it) || [];
        const idaVolta = inferLegType(it, idx, order);

        const sch = it.schedule || {};
        const origemNome = sch.originName || sch.origem || '';
        const destinoNome = sch.destinationName || sch.destino || '';
        const dataViagem = sch.date || sch.dataViagem || '';

        const totalItem = itemSubtotal(it);
        const qtdPax = paxList.length || 1;
        const valorPorPassageiro = totalItem / qtdPax;

        paxList.forEach(p => {
          bilhetes.push({
            poltrona: p.seatNumber,
            nomeCliente: p.name,
            docCliente: p.document,
            valor: valorPorPassageiro,
            dataViagem,
            horaPartida: s.horaPartida,
            origemNome,
            destinoNome,
            idaVolta,
            idViagem: s.idViagem,
            idOrigem: s.idOrigem,
            idDestino: s.idDestino
          });
        });
      });

      if (bilhetes.length !== order.reduce((n,it)=>n+getPassengersFromItem(it).length,0) || !bilhetes.length) throw new Error('Dados de passageiros incompletos para registrar a compra.');

      const response = await fetch('/api/sheets/pre-reserva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          external_reference: externalReference,
          userEmail,
          userPhone,
          bilhetes,
          expectedTotal: Number(cartTotal().toFixed(2))
        })
      });
      const result=await response.json().catch(()=>({}));
      if (!response.ok || result.ok!==true || Number(result.appended)!==bilhetes.length) {
        if ([409,422].includes(response.status)) {
          const validationError = new Error(String(result.error || 'Confira os dados da viagem e tente novamente.'));
          validationError.checkoutValidation = true;
          throw validationError;
        }
        throw new Error('Falha ao registrar os bilhetes antes do pagamento.');
      }
    } catch (error) {
      console.error('[pre-reserva] pagamento não será iniciado:',error);
      if (error?.checkoutValidation) throw error;
      throw new Error('Não foi possível preparar a compra. Nenhum pagamento foi iniciado. Tente novamente em instantes.');
    }
  }


  // atualiza UM booking (por índice) com os arquivos gerados
  function mergeFilesIntoBookingAtIndex(openIdx, arquivos) {
    if (!Array.isArray(arquivos) || !arquivos.length) return;
    const all = JSON.parse(localStorage.getItem('bookings') || '[]');
    const paid = all.filter(b => b.paid === true);
    const open = all.filter(b => b.paid !== true);

    if (openIdx < 0 || openIdx >= open.length) return;

    const bk = open[openIdx];
    bk.paid = true;
    bk.paidAt = new Date().toISOString();
    bk.tickets = arquivos.map(a => ({
      numPassagem: a.numPassagem || a.NumPassagem || null,
      driveUrl: a.driveUrl || null,
      pdfLocal: a.pdfLocal || null,
      url: a.driveUrl || a.pdfLocal || null
    }));
    const first = bk.tickets[0] || {};
    bk.ticketUrl = first.url || null;
    bk.driveUrl = first.driveUrl || null;
    bk.pdfLocal = first.pdfLocal || null;
    bk.ticketNumber = first.numPassagem || null;

    // regrava mantendo a ordem original: [paid..., open...]
    localStorage.setItem('bookings', JSON.stringify([...paid, ...open]));
  }

  // Venda de cartão: cada poltrona tem resultado independente.
  // Uma indisponibilidade confirmada não pode impedir a tentativa das outras.
  // Falha de comunicação/resultado incerto, porém, interrompe o fluxo para
  // evitar qualquer possibilidade de segunda emissão.
  async function venderPraxioApósAprovado(paymentId) {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const results = [];
    const failedSeats = [];
    let uncertain = null;
    const totalExpected = order.reduce((count,it)=>count+getPassengersFromItem(it).length,0);

    for (let i = 0; i < order.length; i++) {
      const it=order[i];
      const schedule=getScheduleFromItem(it);
      const passengers=getPassengersFromItem(it);
      const seat=passengers[0]?.seatNumber || it._seat;
      const body={
        mpPaymentId:paymentId,schedule,passengers,totalAmount:itemSubtotal(it),
        idEstabelecimentoVenda:'1',idEstabelecimentoTicket:schedule.agencia || '93',
        serieBloco:'93',
        userEmail:(user.email||'').toString(),
        userPhone:(user.phone||user.telefone||'').toString(),
        idaVolta:inferLegType(it,i,order),totalExpected
      };
      let response, result;
      try {
        response=await fetch('/api/praxio/vender',{
          method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
        });
        result=await response.json();
      } catch(error) {
        uncertain={seat,reason:error?.message || 'Falha de comunicação'};
        console.error('[Card][Issue] Resultado inconclusivo; interrompendo demais vendas:',uncertain);
        break;
      }
      if(!response.ok || result?.ok !== true) {
        if(result?.code === 'SEAT_UNAVAILABLE') {
          failedSeats.push({seat,index:i});
          console.warn('[Card][Issue] Poltrona indisponível, continuando demais passageiros:',seat);
          continue;
        }
        uncertain={seat,reason:result?.error||result?.message||'Resultado não confirmado'};
        console.error('[Card][Issue] Falha desconhecida; não prosseguir automaticamente:',uncertain);
        break;
      }
      results.push({index:i,arquivos:result.arquivos||result.Arquivos||[],venda:result.venda||result.Venda});
    }

    // O pagamento já foi aprovado independentemente do resultado na Praxio:
    // nenhum item desta compra deve voltar ao checkout para cobrar novamente.
    // Marca as reservas como pagas, sem inventar número de bilhete.
    try {
      const all=JSON.parse(localStorage.getItem('bookings')||'[]');
      const byOriginal=new Map();
      for(const it of order){
        const source=Number(it._srcOpenIdx);
        if(!byOriginal.has(source))byOriginal.set(source,[]);
      }
      for(const r of results){
        const source=Number(order[r.index]._srcOpenIdx);
        byOriginal.get(source)?.push(...r.arquivos);
      }
      let openIdx=0;
      for(const booking of all){
        if(booking.paid===true)continue;
        const files=byOriginal.get(openIdx);
        if(files){
          booking.paid=true;
          booking.paidAt=new Date().toISOString();
          booking.pendingRecovery=failedSeats.length>0 || !!uncertain;
          booking.tickets=files.map(a=>({
            numPassagem:a.numPassagem||a.NumPassagem||null,
            driveUrl:a.driveUrl||null,pdfLocal:a.pdfLocal||null,
            url:a.driveUrl||a.pdfLocal||null
          }));
          const first=booking.tickets[0];
          if(first?.numPassagem)booking.ticketNumber=first.numPassagem;
          if(first?.url)booking.ticketUrl=first.url;
        }
        openIdx++;
      }
      localStorage.setItem('bookings',JSON.stringify(all));
    }catch(error){console.error('[Card][Bookings] Não foi possível atualizar histórico local',error);}

    const arquivos=results.flatMap(r=>r.arquivos);
    localStorage.setItem('lastTickets',JSON.stringify(arquivos.map(a=>({
      numPassagem:a.numPassagem||a.NumPassagem||null,
      driveUrl:a.driveUrl||null,pdfLocal:a.pdfLocal||null
    }))));
    return {
      ok:!uncertain,
      issuedCount:results.reduce((n,r)=>n+r.arquivos.length,0),
      attempted:results.length+failedSeats.length+(uncertain?1:0),
      failedSeats,uncertain,arquivos,vendas:results.map(r=>r.venda)
    };
  }


  // ===== storage remove
  // remove uma poltrona específica do booking "aberto" original
  function removeFromStorageBySeatPointer(srcOpenIdx, seatNumber) {
    const all = JSON.parse(localStorage.getItem('bookings') || '[]');
    const paid = all.filter(b => b.paid === true);
    const open = all.filter(b => b.paid !== true);

    // nada a fazer
    if (srcOpenIdx < 0 || srcOpenIdx >= open.length) {
      localStorage.setItem('bookings', JSON.stringify([...paid, ...open]));
      return;
    }

    const it = open[srcOpenIdx];

    // tira do array seats
    if (Array.isArray(it.seats)) {
      it.seats = it.seats.filter(n => Number(n) !== Number(seatNumber));
    }
    // tira do array passengers
    if (Array.isArray(it.passengers)) {
      it.passengers = it.passengers.filter(p =>
        Number(p.seatNumber || p.poltrona) !== Number(seatNumber)
      );
    }

    // se esvaziou, remove o booking aberto por completo
    if (!it.seats?.length) {
      open.splice(srcOpenIdx, 1);
    }

    localStorage.setItem('bookings', JSON.stringify([...paid, ...open]));
  }


  // ===== resumo
  function renderSummary() {
    const lines = [];
    let total = 0;

    order.forEach((it, idx) => {
      const s = it.schedule || {};
      const origem = pick(s.originName, s.origin, s.origem, '—');
      const destino = pick(s.destinationName, s.destination, s.destino, '—');
      const dataV = formatDateBR(s.date);
      const hora = pick(s.departureTime, s.horaPartida, '—');
      const seats = (it.seats || []).join(', ');
      const paxList = Array.isArray(it.passengers) ? it.passengers.map(p => `Pol ${p.seatNumber}: ${p.name}`) : [];
      const sub = itemSubtotal(it);
      total += sub;

      lines.push(`
        <div class="order-item" data-open-index="${idx}">
          <button class="item-remove" title="Remover" aria-label="Remover">×</button>
          <div class="title">
            <span>${origem} → ${destino}</span>
            <span class="price">${fmtBRL(sub)}</span>
          </div>
          <div class="meta">
            ${dataV} • ${hora} • Poltronas: ${seats || '—'}
            ${paxList.length ? `<br/>Passageiros: ${paxList.join(', ')}` : ''}
          </div>
        </div>
      `);
    });


    const baseHtml = lines.join('');

    // Novo layout (payment.html atual)
    if (summaryBodyEl) {
      summaryBodyEl.innerHTML = baseHtml;
      if (summaryTotalEl) summaryTotalEl.textContent = fmtBRL(total);
    }
    // Layout antigo (usa somente #order-summary e precisa do total dentro)
    else if (legacySummaryEl) {
      const html = baseHtml +
        `<div class="summary-total"><span>Total</span><span>${fmtBRL(total)}</span></div>`;
      legacySummaryEl.innerHTML = html;
    }


    const container = summaryBodyEl || legacySummaryEl;
    if (container) {
      container.querySelectorAll('.order-item .item-remove').forEach(btn => {
        btn.addEventListener('click', async () => {
          const wrap = btn.closest('.order-item');
          const openIdx = Number(wrap.getAttribute('data-open-index'));

          // pega os ponteiros do item expandido
          const item = order[openIdx];
          const srcIdx = Number(item?._srcOpenIdx ?? -1);
          const seat = item?._seat;

          // remove no storage (apenas aquela poltrona do booking original)
          removeFromStorageBySeatPointer(srcIdx, seat);

          // remove do array expandido atual e re-renderiza
          order.splice(openIdx, 1);
          const newTotal = cartTotal();
          renderSummary();
          await awaitMountBricks(newTotal);
        });
      });

    }
    return total;
  }

  // ======= Bricks
  let publicKey = '';
  try {
    const r = await fetch('/api/mp/pubkey');
    const j = await r.json();
    publicKey = j.publicKey || '';
  } catch (e) { console.error('Erro /api/mp/pubkey', e); }
  if (!publicKey) { alert('Chave pública do Mercado Pago não configurada.'); return; }

  const mp = new MercadoPago(publicKey, { locale: 'pt-BR' });
  const bricks = mp.bricks();

  const brickContainerId =
    document.getElementById('payment-bricks') ? 'payment-bricks' :
      (document.getElementById('payment-brick-container') ? 'payment-brick-container' : null);

  if (!brickContainerId) { console.error('Container do Bricks não encontrado.'); return; }

  let brickController = null;
  let currentTotal = 0;

  // ——— exibição do PIX
  function showPixBox({ qr_b64, qr_text }) {
    if (!pixBox) return;
    pixBox.style.display = 'block';
    pixQR.innerHTML = qr_b64 ? `<img src="data:image/png;base64,${qr_b64}" alt="QR Pix">` : '<p class="mute">QR não disponível.</p>';
    pixCode.value = qr_text || '';
    setPixStatus('Aguardando pagamento…');

    if (pixCopy && qr_text) {
      pixCopy.onclick = () => {
        pixCode.select();
        document.execCommand('copy');
        alert('Código Pix copiado!');
      };
    }
    pixBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function genIdem() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    // fallback simples
    const a = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    return `${a.slice(0, 8)}-${a.slice(8, 12)}-${a.slice(12, 16)}-${a.slice(16, 20)}-${a.slice(20)}`;
  }

  async function mountBricks(amount) {
    try { await brickController?.unmount?.(); } catch (_) { }
    currentTotal = Number((amount || 0).toFixed(2));
    if (currentTotal <= 0) currentTotal = 1.00; // evita rejeição em sandbox

    brickController = await bricks.create('payment', brickContainerId, {
      initialization: { amount: currentTotal, payer: { email: user.email || '', entityType: 'individual' } },
      customization: {
        paymentMethods: {
          creditCard: 'all',
          debitCard: 'all',
          bankTransfer: ['pix'],
          minInstallments: 1, maxInstallments: 1
        },
        visual: { showInstallmentsSelector: false }
      },
      callbacks: {
        onReady: () => {
          console.log('[MP] Brick pronto');
          // Hack para injetar CSS no Shadow DOM do Brick (esconder pílula verde)
          setInterval(() => {
            const el = document.getElementById(brickContainerId);
            if (el && el.shadowRoot) {
              // Verifica se já injetamos
              if (!el.shadowRoot.querySelector('#my-hide-pill-style')) {
                const s = document.createElement('style');
                s.id = 'my-hide-pill-style';
                s.innerHTML = `
                  [class*="installments"],
                  [data-testid*="installments"],
                  .mp-payment-installments,
                  .mp-form-control--installments {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                  }
                `;
                try { el.shadowRoot.appendChild(s); } catch (e) { console.warn('Falha inject shadow', e); }
              }
            }
          }, 500);
        },
        onError: (e) => { console.error('[MP] Brick error:', e); alert('Erro ao iniciar o pagamento.'); },
        onSubmit: async ({ selectedPaymentMethod, formData }) => {
          try {
            const method = String(selectedPaymentMethod || '').toLowerCase();
            const isPix = method === 'bank_transfer' ||
              String(formData?.payment_method_id || '').toLowerCase() === 'pix';

            const idem = genIdem();

            const body = {
              transaction_amount: Number(currentTotal.toFixed(2)),
              description: 'Compra Turin Transportes',
              external_reference: idem,
              payer: {
                email: user.email || user.Email || formData?.payer?.email || '',
                identification: formData?.payer?.identification ? {
                  type: formData.payer.identification.type || 'CPF',
                  number: String(formData.payer.identification.number || '').replace(/\D/g, '')
                } : undefined,
                entity_type: (formData?.payer?.identification?.type || 'CPF').toUpperCase() === 'CNPJ'
                  ? 'association' : 'individual'
              }
            };

            if (isPix) {
              body.payment_method_id = 'pix';
            } else {
              if (!formData?.token) { alert('Não foi possível tokenizar o cartão.'); return; }
              body.token = formData.token;
              body.payment_method_id = formData.payment_method_id;
              body.installments = 1;
              if (formData.issuer_id) body.issuer_id = formData.issuer_id;
            }

            Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
            if (body.payer && body.payer.identification === undefined) delete body.payer.identification;

            // grava pré-reserva no Sheets antes de criar o pagamento
            const payerEmail = body.payer && body.payer.email ? body.payer.email : '';
            await preRegistrarNoSheets(idem, payerEmail);



            const resp = await fetch('/api/mp/pay', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': idem },
              body: JSON.stringify(body)
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data?.message || 'Falha ao processar pagamento');

            // Referência opaca do pagamento, preservada localmente para recuperar
            // um bilhete pago sem iniciar outra cobrança.
            if (data.id || data?.payment?.id) {
              const item = order[0] || {};
              const schedule = { ...(item.schedule || {}), ...(getScheduleFromItem(item) || {}) };
              localStorage.setItem('seatRecoveryContext', JSON.stringify({
                paymentId:String(data.id || data.payment.id),
                reference:idem,
                email:String(user.email || user.Email || body.payer?.email || ''),
                schedule
              }));
            }

            // === CARTÃO APROVADO ===
            if (data.status === 'approved') {
              showOverlayOnce('Pagamento confirmado!', 'Conferindo as poltronas e emitindo bilhetes…');
              const paymentId=String(data.id||data?.payment?.id||'');
              try {
                const venda=await venderPraxioApósAprovado(paymentId);
                if(venda.uncertain){
                  console.error('[Card] Resultado incerto; não concluir automaticamente:',venda.uncertain);
                } else {
                  // O backend compara TODOS os assentos com o lote emitido e os
                  // erros confirmados antes de liberar o processamento do Sheets.
                  const finishResponse=await fetch('/api/mp/card-issuance-finished',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({paymentId,reference:idem})
                  });
                  const finishData=await finishResponse.json().catch(()=>({}));
                  if(!finishResponse.ok||!finishData.ok)
                    console.error('[Card] Conciliação incompleta; manter acompanhamento:',finishData);
                  // Em emissão parcial, as linhas já estão conciliadas para o recovery.
                  // Não prender o cliente aguardando PDFs/e-mail do lote emitido.
                  if(venda.issuedCount>0 && finishResponse.ok && !venda.failedSeats?.length){
                    const flush=await fetch('/api/mp/wait-flush?paymentId='+encodeURIComponent(paymentId));
                    const status=await flush.json().catch(()=>({}));
                    if(!status.flushed)console.warn('[Card] Aguardando conciliação final:',status);
                  }
                }

                let state=null;
                try{
                  const r=await fetch('/api/recovery/state',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({paymentId,reference:idem,email:body.payer.email})
                  });
                  if(r.ok)state=await r.json();
                }catch(error){console.warn('[Card] Consulta do estado falhou:',error);}

                hideOverlayIfShown();
                if(state?.state==='issued' && !venda.uncertain){
                  location.href='profile.html';
                }else{
                  // Mesmo com alguma emissão concluída, preservar o fluxo de
                  // recuperação até TODAS as poltronas terem situação definida.
                  location.href='recovery.html';
                }
              }catch(error){
                console.error('[Card] Pagamento aprovado, emissão inconclusiva:',error);
                hideOverlayIfShown();
                location.href='recovery.html';
              }
              return;
            }

            // === PIX (gera QR; aprovação é posterior) ===
            const pix = data?.point_of_interaction?.transaction_data;
            if (pix?.qr_code || pix?.qr_code_base64) {
              showPixBox({ qr_b64: pix.qr_code_base64, qr_text: pix.qr_code });
              // alert('Pix gerado! Conclua o pagamento no seu banco.');
              const paymentId = data.id || data?.payment?.id;
              if (paymentId) startPixPolling(paymentId); // <<<<<< POLLING AQUI
              return;
            }

            if (data?.id && data?.status === 'in_process') {
              alert('Pagamento em análise. Acompanhe em Minhas viagens.');
              return;
            }

            alert(`Pagamento: ${data.status} - ${data.status_detail || ''}`);
          } catch (err) {
            console.error('Pagamento falhou:', err);
            alert('Pagamento falhou: ' + (err?.message || 'erro'));
          }
        }
      }
    });
  }




  // === Polling do PIX (aprovado -> aguardar webhook emitir e redirecionar)
  async function startPixPolling(paymentId) {
    clearInterval(pixPollTimer);
    const t0 = Date.now();
    setPixStatus('Aguardando pagamento…');

    pixPollTimer = setInterval(async () => {
      try {
        const data = await fetchPaymentStatus(paymentId);
        const st = String(data?.status || '').toLowerCase();
        const detail = String(data?.status_detail || '').toLowerCase();

        /*  if (st === 'approved') {
            clearInterval(pixPollTimer);
  
            // Exibe o overlay e mantém até o backend concluir tudo
            showOverlayOnce('Pagamento confirmado!', 'Gerando o BPe…');
  
            try {
              // Aguarda o backend terminar: emissão + e-mail + Sheets
              try {
                await fetch(
                  `/api/mp/wait-flush?paymentId=${encodeURIComponent(paymentId)}`
                );
              } catch (err) {
                console.warn(
                  'wait-flush expirou ou falhou, mas seguiremos mesmo assim:',
                  err
                );
              }
  
              // Pequena espera só pra garantir que o overlay "pinte" na tela
              await new Promise(res => setTimeout(res, 100));
  
              // Redireciona somente após o processo REAL ter finalizado
              location.href = 'profile.html';
              return;
            } catch (e) {
              console.error(
                'Erro ao aguardar emissão via webhook (Pix):',
                e
              );
              hideOverlayIfShown();
              alert(
                'Pagamento aprovado, mas houve erro ao finalizar o bilhete. ' +
                'Verifique em "Minhas compras" ou fale com o suporte.'
              );
            }
  
          } 
          
          */




        if (st === 'approved') {
          clearInterval(pixPollTimer);

          // Exibe o overlay e mantém até o backend concluir tudo
          showOverlayOnce('Pagamento confirmado!', 'Gerando o BPe…');

          try {
            // Aguarda o backend terminar: emissão + e-mail + Sheets
            try {
              await fetch(
                `/api/mp/wait-flush?paymentId=${encodeURIComponent(paymentId)}`
              );
            } catch (err) {
              console.warn(
                'wait-flush expirou ou falhou, mas seguiremos mesmo assim:',
                err
              );
            }

            // pequena espera só pra garantir pintura do overlay
            await new Promise(res => setTimeout(res, 100));

            // Redireciona somente após o processo REAL ter finalizado
            // Após PIX aprovado, confirmar estado persistido antes de redirecionar.
            // Se o webhook ainda estiver emitindo, a tela de recuperação aguarda.
            try {
              const ctx=JSON.parse(localStorage.getItem('seatRecoveryContext') || 'null');
              if (ctx?.paymentId === String(paymentId)) {
                const r=await fetch('/api/recovery/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(ctx)});
                const state=await r.json();
                // Só habilitar autoatendimento quando a falha estiver confirmada.
                // Para pending/reissuing/refunding, a tela acompanha o processamento,
                // sem oferecer estorno ou nova venda.
                if (state.state === 'issued') {
                  location.href = 'profile.html';
                } else if (['seat_unavailable', 'pending', 'reissuing', 'refunding', 'manual'].includes(state.state)) {
                  location.href = 'recovery.html';
                } else {
                  location.href = 'profile.html';
                }
              } else location.href='profile.html';
            } catch (_) { location.href='recovery.html'; }
            return;
          } catch (e) {
            console.error('Erro ao aguardar emissão via webhook (Pix):', e);
            hideOverlayIfShown();
            alert(
              'Pagamento aprovado, mas houve erro ao finalizar o bilhete. ' +
              'Verifique em "Minhas compras" ou fale com o suporte.'
            );
          }
        }










        else if (
          st === 'rejected' ||
          st === 'cancelled' ||
          st === 'refunded' ||
          st === 'charged_back'
        ) {
          clearInterval(pixPollTimer);
          setPixStatus('Pagamento não aprovado.');
          alert(`Pagamento não aprovado: ${st} (${detail})`);

        } else {
          // pendente / in_process
          const elapsed = Date.now() - t0;
          if (elapsed > POLL_TIMEOUT_MS) {
            clearInterval(pixPollTimer);
            setPixStatus('Tempo limite excedido. Verifique em Minhas compras.');
            alert(
              'Não foi possível confirmar o pagamento do Pix a tempo. ' +
              'Verifique o status em "Minhas compras".'
            );
          } else {
            setPixStatus('Aguardando pagamento…');
          }
        }
      } catch (e) {
        console.warn('Falha no polling Pix:', e);
        // continua tentando até estourar o timeout
      }
    }, POLL_MS);
  }











  async function awaitMountBricks(total) {
    if (!order.length) {
      try { await brickController?.unmount?.(); } catch (_) { }
      const container = document.getElementById(brickContainerId);
      if (container) container.innerHTML = '<p class="mute">Seu carrinho está vazio.</p>';
      return;
    }
    await mountBricks(total);
  }

  // ===== inicialização
  const firstTotal = renderSummary();
  await awaitMountBricks(firstTotal);

  // ===== Botões

  cancelBtn?.addEventListener('click', () => {
    const ok = confirm('Cancelar este pedido? Os itens do carrinho serão removidos.');
    if (!ok) return;
    const all = JSON.parse(localStorage.getItem('bookings') || '[]');
    const paid = all.filter(b => b.paid === true);
    localStorage.setItem('bookings', JSON.stringify(paid));
    // volta para a tela anterior (ou para a busca, se não houver histórico)
    history.length > 1 ? history.back() : (location.href = 'index.html');
  });

});
