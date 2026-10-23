// main.js — sidebar fixa + card central dinâmico + integração seats.js (eventos)
// - Valida origem ≠ destino
// - Usa eventos seats:confirm / seats:back do novo seats.js
// - Mantém autocomplete discreto e datas (ida obrig., volta opcional)

document.addEventListener('DOMContentLoaded', () => {
  updateUserNav();


  const localities = [
    { id: 23, descricao: 'Antonio Pereira' },
    { id: 26, descricao: 'Barão de Cocais' },
    { id: 20, descricao: 'Catas Altas' },
    { id: 22, descricao: 'Cocais' },
    { id: 14, descricao: 'Coronel Fabriciano' },
    { id: 12, descricao: 'Ipatinga' },
    { id: 93, descricao: 'Itatiaia' },
    { id: 16, descricao: 'Joao Monlevade' },
    { id: 24, descricao: 'Mariana' },
    { id: 21, descricao: 'Mina Alegria' },
    { id: 28, descricao: 'Nova Era' },
    { id: 2, descricao: 'Ouro Branco' },
    { id: 6, descricao: 'Ouro Preto' },
    { id: 19, descricao: 'Santa Bárbara' },
    { id: 17, descricao: 'São Goncalo do Rio Abaixo' }
  ];



  // ===== Elementos
  const $ = (q) => document.querySelector(q);
  const originInput = $('#origin');
  const destInput = $('#destination');
  const dateInput = $('#date');
  const retInput = $('#return-date');
  const content = $('#content-root');

  // ======== Botão Limpar
  const btnClear = document.getElementById('btnClear');
  if (btnClear) {
    btnClear.setAttribute('type', 'button'); // garante que não submete

    btnClear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      originInput.value = '';
      destInput.value = '';
      dateInput.value = '';
      retInput.value = '';

      const acOrigin = document.querySelector('#ac-origin');
      const acDest = document.querySelector('#ac-destination');
      if (acOrigin) acOrigin.hidden = true;
      if (acDest) acDest.hidden = true;

      // originInput.focus();
    });
  }



  // ======== Enter para escolher

  if (originInput) {
    originInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#ac-origin .ac-item');
        if (first) { first.dispatchEvent(new MouseEvent('mousedown')); e.preventDefault(); }
      }
    });
  }

  if (destInput) {
    destInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = document.querySelector('#ac-destination .ac-item');
        if (first) { first.dispatchEvent(new MouseEvent('mousedown')); e.preventDefault(); }
      }
    });
  }





  // ===== Central começa vazio
  content.innerHTML = '';

  // ===== Autocomplete discreto (sem <datalist>)
  const acOrigin = document.querySelector('#ac-origin');
  const acDest = document.querySelector('#ac-destination');

  function buildList(items, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'ac-list';
    items.forEach(it => {
      const li = document.createElement('div');
      li.className = 'ac-item';
      li.textContent = it.descricao;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        onPick(it);
      });
      wrap.appendChild(li);
    });
    return wrap;
  }

  function attachAutocomplete(input, panel, source) {
    const norm = s => (s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    function close() { panel.innerHTML = ''; panel.hidden = true; }

    function openWith(list) {
      panel.innerHTML = '';
      panel.appendChild(buildList(list, (it) => {
        input.value = it.descricao;
        close();
      }));
      panel.hidden = false;
    }

    function filterNow() {
      const s = input.value; // mantém o que o usuário digita
      const q = norm(s);
      const list = q
        ? source.filter(l => norm(l.descricao).includes(q)) // substring, sem acento/caixa
        : source.slice();                                    // <<< mostra TODAS quando vazio
      list.length ? openWith(list) : close();
    }

    // abrir/filtrar
    input.addEventListener('input', filterNow);
    input.addEventListener('focus', filterNow);
    // garante abrir também no clique (sem digitar)
    input.addEventListener('mousedown', filterNow);

    // fecha depois do blur (mantém seu comportamento)
    input.addEventListener('blur', () => setTimeout(close, 100));
  }


  attachAutocomplete(originInput, acOrigin, localities);
  attachAutocomplete(destInput, acDest, localities);


  // ===== Datas mínimas
  [dateInput, retInput].forEach(inp => {
    const d = new Date(), yyyy = d.getFullYear(), mm = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    inp.min = `${yyyy}-${mm}-${dd}`;
  });

  // ===== Estado
  const state = { leg: 'IDA', search: null, searchReturn: null, selected: [] };

  // ===== Submit (BUSCA)
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();

    const originName = originInput.value.trim();
    const destName = destInput.value.trim();
    const date = dateInput.value;

    if (!originName || !destName || !date) {
      alert('Preencha origem, destino e data da ida.');
      return;
    }

    const o = localities.find(l => l.descricao.toLowerCase() === originName.toLowerCase());
    const d = localities.find(l => l.descricao.toLowerCase() === destName.toLowerCase());
    if (!o || !d) {
      alert('Origem/Destino inválidos. Selecione uma opção sugerida.');
      return;
    }

    // NOVO: impede origem e destino iguais
    if (o.id === d.id) {
      alert('Origem e destino não podem ser iguais.');
      return;
    }

    state.leg = 'IDA';
    state.selected = [];
    state.search = { originId: o.id, originName: o.descricao, destinationId: d.id, destinationName: d.descricao, date };
    state.searchReturn = retInput.value
      ? { originId: d.id, originName: d.descricao, destinationId: o.id, destinationName: o.descricao, date: retInput.value }
      : null;

    // lista de IDA
    renderList(state.search, 'Viagens disponíveis (ida)', onSelectIda);

    function onSelectIda(schedule) {
      state.selected = state.selected.filter(s => s.leg !== 'IDA');
      state.selected.push({ leg: 'IDA', schedule });
      renderSeatsStage(schedule, 'IDA', () => renderList(state.search, 'Viagens disponíveis (ida)', onSelectIda));
    }
  });

  // ===== Render lista de horários
  function renderList(params, legend, onSelect) {
    content.innerHTML = `
      <h2 class="step-title">${legend}</h2>
      <div id="schedule-list"></div>
      <div id="no-results" class="mute"></div>
    `;
    const list = $('#schedule-list');
    const status = $('#no-results');
    status.textContent = 'Buscando viagens disponíveis...';

    fetch('/api/partidas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origemId: params.originId,
        destinoId: params.destinationId,
        data: params.date
      })
    })
      .then(r => r.json())
      .then(data => {
        status.textContent = '';
        list.innerHTML = '';

        if (window.innerWidth <= 1024) {
          content.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }


        let linhas = [];
        if (data && Array.isArray(data.ListaPartidas)) {
          linhas = data.ListaPartidas;
        } else if (data && data.PartidasXmlRetorno && data.PartidasXmlRetorno.Linhas) {
          const raw = data.PartidasXmlRetorno.Linhas;
          if (Array.isArray(raw)) linhas = raw;
          else if (Array.isArray(raw.Linha)) linhas = raw.Linha;
        }

        if (!linhas || !linhas.length) {
          status.textContent = 'Nenhuma viagem encontrada para os critérios informados.';
          return;
        }

        const fmtHora = (h) => {
          if (!h) return '';
          if (typeof h !== 'string') return h;
          if (h.includes(':')) return h;
          if (h.length === 4) return h.slice(0, 2) + ':' + h.slice(2);
          return h;
        };

        const seatCheckTasks = [];
        linhas.forEach(linha => {
          let saida = linha.HorarioPartida || linha.HoraPartida || '';
          if (!saida && linha.ViagemTFO) {
            saida = linha.ViagemTFO.HorarioPartida || linha.ViagemTFO.HoraPartida ||
              (linha.ViagemTFO.DataHoraInicio || linha.ViagemTFO.DataHoraEmbarque || '').split('T')[1]?.substring(0, 5) || '';
          }
          if (!saida && typeof linha.DadosViagem === 'string') {
            const p = linha.DadosViagem.split(' - ');
            if (p.length > 0) saida = p[0].trim();
          }
          saida = fmtHora(saida);

          let chegadaRaw = linha.HorarioChegada || linha.HoraChegada || linha.DtaHoraChegada || '';
          if (!chegadaRaw && linha.ViagemTFO) {
            chegadaRaw = linha.ViagemTFO.DtaHoraChegada || linha.ViagemTFO.DataHoraChegada || '';
          }
          let chegada = '';
          if (chegadaRaw) {
            if (typeof chegadaRaw === 'string' && chegadaRaw.includes('T')) chegada = chegadaRaw.split('T')[1].substring(0, 5);
            else chegada = fmtHora(chegadaRaw);
          }

          let tempo = linha.TempoViagem || linha.Duracao || linha.DuracaoViagem || '';
          if (!tempo && linha.ViagemTFO) tempo = linha.ViagemTFO.DuracaoViagem || linha.ViagemTFO.TempoViagem || '';

          const tarifaRaw =
            linha.Tarifa ?? linha.ValorTarifa ?? linha.VlTarifa ?? linha.VlTarifaAnterior ?? linha.ValorMaiorDesconto ?? 0;

          const idViagem = linha.IdViagem || linha.CodViagem || 0;
          const idTipoVeiculo = linha.IdTipoVeiculo || linha.TipoVeiculo || linha.IdTipoOnibus || 0;
          const tipoHorario = linha.TipoHorario || linha.ViagemTFO?.TipoHorario || '';
          const dadosComodidades = { ...(linha.ViagemTFO || {}), ...linha };
          const recurso = campos => campos.some(c => {
            const v = dadosComodidades[c];
            return v === true || v === 1 || (typeof v === 'string' && ['sim','s','true','1'].includes(v.trim().toLowerCase()));
          });
          // Regra operacional confirmada: categoria Executivo possui os três recursos.
          const executivo = /executivo/i.test(String(tipoHorario).normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
          const ar = executivo || recurso(['ArCondicionado','PossuiArCondicionado','TemArCondicionado']);
          const banheiro = executivo || recurso(['Banheiro','PossuiBanheiro','TemBanheiro']);
          const wifi = executivo || recurso(['Wifi','WiFi','PossuiWifi','PossuiWiFi','TemWifi']);

          // Visual novo, conservando integralmente os dados e a seleção da viagem.
          const card = document.createElement('article');
          card.className = 'schedule-card trip-card';

          const details = document.createElement('div');
          details.className = 'trip-details';
          const times = document.createElement('div');
          times.className = 'trip-times';
          [
            ['Saída', saida || '--:--', '🚌'],
            ['Chegada', chegada || '--:--', '⚑'],
            ['Duração', tempo || '--', '◷']
          ].forEach(([label, value, symbol]) => {
            const item = document.createElement('div');
            item.className = 'trip-time-block';
            const caption = document.createElement('span');
            caption.className = 'trip-label';
            caption.textContent = label;
            const number = document.createElement('strong');
            number.textContent = String(value);
            const icon = document.createElement('span');
            icon.className = 'trip-time-icon';
            icon.textContent = symbol;
            const valueRow = document.createElement('div');
            valueRow.className = 'trip-time-value';
            valueRow.append(icon, number);
            item.append(caption, valueRow);
            times.appendChild(item);
          });
          const extras = document.createElement('div');
          extras.className = 'trip-extras';
          const seats = document.createElement('div');
          seats.className = 'trip-seats-highlight';
          const seatInfo = document.createElement('div');
          const seatIcon = document.createElement('span');
          seatIcon.className = 'trip-seat-icon';
          seatIcon.textContent = '💺';
          const seatText = document.createElement('div');
          const seatLabel = document.createElement('span');
          seatLabel.className = 'trip-seats-label';
          seatLabel.textContent = 'POLTRONAS DISPONÍVEIS';
          const seatCount = document.createElement('strong');
          seatCount.className = 'trip-seats-count';
          // Não mostrar o número agregado da lista, que pode diferir do mapa.
          // O valor será preenchido após consultar /api/poltronas.
          seatCount.textContent = '…';
          seatCount.setAttribute('aria-live', 'polite');
          let verifiedAvailability = null;
          seatText.append(seatLabel, seatCount);
          seatInfo.className = 'trip-seats-info';
          seatInfo.append(seatIcon, seatText);
          seats.appendChild(seatInfo);
          if (tipoHorario) {
            const category = document.createElement('span');
            category.className = 'trip-category';
            category.textContent = String(tipoHorario);
            seats.appendChild(category);
          }
          extras.appendChild(seats);
          const amenities = document.createElement('div');
          amenities.className = 'trip-amenities';
          [['❄️', 'Ar-condicionado', ar], ['🚻', 'Banheiro', banheiro], ['📶', 'Wi-Fi', wifi]]
            .forEach(([symbol, label, enabled]) => {
              const item = document.createElement('span');
              item.className = 'trip-amenity' + (enabled ? '' : ' trip-amenity-unconfirmed');
              if (!enabled) item.title = 'Comodidade não confirmada nos dados desta viagem';
              const icon = document.createElement('span');
              icon.className = 'trip-amenity-icon';
              icon.textContent = symbol;
              const name = document.createElement('span');
              name.textContent = label;
              item.append(icon, name);
              if (!enabled) {
                const note = document.createElement('small');
                note.textContent = 'Não informado';
                item.appendChild(note);
              }
              amenities.appendChild(item);
            });
          if (amenities.childElementCount) extras.appendChild(amenities);
          details.append(times, extras);

          const actions = document.createElement('div');
          actions.className = 'schedule-actions trip-price-box';
          const valueLabel = document.createElement('span');
          valueLabel.className = 'trip-price-label';
          valueLabel.textContent = 'Passagem a partir de';
          const price = document.createElement('strong');
          price.className = 'trip-price';
          const numericPrice = typeof window.normalizePrice === 'function'
            ? window.normalizePrice(tarifaRaw)
            : Number(String(tarifaRaw ?? 0).replace(',', '.'));
          price.textContent = Number.isFinite(numericPrice)
            ? numericPrice.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
            : 'Consulte o valor';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-primary select-btn';
          btn.textContent = 'Selecionar viagem';
          btn.addEventListener('click', () => {
            const schedule = {
              idViagem,
              idTipoVeiculo,
              originId: params.originId,
              destinationId: params.destinationId,
              originName: params.originName,
              destinationName: params.destinationName,
              date: params.date,
              departureTime: saida,
              arrivalTime: chegada,
              travelTime: tempo,
              price: tarifaRaw,
              seatsAvailable: verifiedAvailability,
              serviceType: tipoHorario || null
            };
            onSelect && onSelect(schedule);
          });
          actions.append(valueLabel, price, btn);
          card.append(details, actions);
          list.appendChild(card);

          // A mesma chamada usada pela tela de seleção é a fonte da contagem.
          seatCheckTasks.push(async () => {
            if (!list.isConnected || !card.isConnected) return;
            try {
              const result = await window.getSeatAvailabilityForSchedule({
                idViagem, idTipoVeiculo,
                originId: params.originId, destinationId: params.destinationId
              });
              if (!list.isConnected || !card.isConnected) return;
              verifiedAvailability = result.available;
              seatCount.textContent = String(result.available);
              const total = document.createElement('small');
              total.textContent = ' / ' + result.total;
              seatCount.appendChild(total);
              seatCount.title = 'Disponibilidade conferida no mapa de poltronas desta viagem';
            } catch (error) {
              if (!list.isConnected || !card.isConnected) return;
              seatCount.textContent = '—';
              seatCount.title = 'Não foi possível consultar a disponibilidade no momento';
              console.warn('[Poltronas] falha ao conferir disponibilidade da viagem', idViagem, error);
            }
          });
        });

        // Duas consultas por vez, para evitar sobrecarga na API da Praxio.
        let nextSeatCheck = 0;
        async function checkWorker() {
          while (nextSeatCheck < seatCheckTasks.length && list.isConnected) {
            const task = seatCheckTasks[nextSeatCheck++];
            await task();
          }
        }
        void Promise.all(
          Array.from({length: Math.min(2, seatCheckTasks.length)}, () => checkWorker())
        );
      })
      .catch(err => {
        console.error(err);
        status.textContent = 'Falha ao buscar viagens. Tente novamente mais tarde.';
      });
  }

  // === Ciência de cancelamento (uma vez por compra, antes do checkout) ===
  // Usa o horário de partida no fuso de Minas Gerais (UTC-03:00), como
  // a regra já aplicada em profile.js para cancelamentos.
  function departureTimeForNotice(schedule) {
    const rawDate=String(schedule?.date || schedule?.dataViagem || '').trim();
    const rawTime=String(schedule?.departureTime || schedule?.horaPartida || '').trim();
    const date=rawDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      || rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const time=rawTime.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
      || rawTime.match(/^(\d{2})(\d{2})$/);
    if(!date || !time) return null;
    const iso=/^\d{4}-/.test(rawDate);
    const yy=+(iso?date[1]:date[3]), mm=+date[2], dd=+(iso?date[3]:date[1]);
    const hh=+time[1], min=+time[2];
    const validDate=new Date(Date.UTC(yy,mm-1,dd));
    if(validDate.getUTCFullYear()!==yy || validDate.getUTCMonth()!==mm-1 ||
       validDate.getUTCDate()!==dd || hh>23 || min>59) return null;
    return {
      timestamp:Date.UTC(yy,mm-1,dd,hh+3,min),
      label:String(dd).padStart(2,'0')+'/'+String(mm).padStart(2,'0')+'/'+yy+
        ' às '+String(hh).padStart(2,'0')+':'+String(min).padStart(2,'0')
    };
  }

  function confirmCancellationNotice(legs) {
    const overlay=document.getElementById('purchase-policy-modal');
    const check=document.getElementById('purchase-policy-checkbox');
    const proceed=document.getElementById('purchase-policy-continue');
    const back=document.getElementById('purchase-policy-back');
    const list=document.getElementById('purchase-policy-itineraries');
    const alertBox=document.getElementById('purchase-policy-alert');
    const dialog=overlay?.querySelector('.purchase-policy-dialog');
    if(!overlay || !check || !proceed || !back || !list || !dialog || !alertBox)
      return Promise.reject(new Error('Aviso obrigatório de cancelamento não disponível'));
    list.replaceChildren();
    const now=Date.now();
    let hasUrgent=false;
    let missingTime=false;
    (legs||[]).forEach(leg=>{
      const sch=leg.schedule||{};
      const dep=departureTimeForNotice(sch);
      const urgent=dep && dep.timestamp-now < 12*60*60*1000;
      if(urgent)hasUrgent=true;
      if(!dep)missingTime=true;
      const item=document.createElement('div');
      item.className='purchase-policy-trip'+(urgent?' is-urgent':'');
      const information=document.createElement('div');
      const route=document.createElement('strong');
      route.textContent=(leg.leg==='VOLTA'?'Volta':'Ida')+' · '+
        String(sch.originName||sch.origin||'Origem')+' → '+
        String(sch.destinationName||sch.destination||'Destino');
      const when=document.createElement('small');
      when.textContent=dep?.label || 'Data/horário de partida não identificado';
      information.append(route,when);
      const status=document.createElement('span');
      status.className='purchase-policy-trip-status';
      status.textContent=!dep?'Verificar horário':urgent?'Menos de 12h':'Prazo regular';
      item.append(information,status);
      list.append(item);
    });
    alertBox.hidden=!hasUrgent && !missingTime;
    alertBox.querySelector('strong').textContent=missingTime
      ? 'Não foi possível verificar o horário de embarque'
      : 'Atenção: embarque em menos de 12 horas';
    alertBox.querySelector('p').textContent=missingTime
      ? 'Volte e confira o horário desta viagem antes de continuar. Sem esse dado, não é possível confirmar o prazo de cancelamento.'
      : 'A(s) viagem(ns) destacada(s) já está(ão) dentro do limite de 12 horas. O cancelamento por desistência com reembolso pelo site não estará disponível para esses trechos.';
    check.checked=false;
    proceed.disabled=true;
    overlay.hidden=false;
    const previousOverflow=document.body.style.overflow;
    const previouslyFocused=document.activeElement;
    document.body.style.overflow='hidden';
    back.focus();

    return new Promise(resolve=>{
      function close(accepted) {
        overlay.hidden=true;
        document.body.style.overflow=previousOverflow;
        check.removeEventListener('change',onCheck);
        proceed.removeEventListener('click',onProceed);
        back.removeEventListener('click',onBack);
        overlay.removeEventListener('click',onBackdrop);
        document.removeEventListener('keydown',onKeydown);
        if(previouslyFocused && typeof previouslyFocused.focus==='function') previouslyFocused.focus();
        resolve(accepted);
      }
      function onCheck(){ proceed.disabled=!check.checked || missingTime; }
      function onProceed(){ if(check.checked && !missingTime)close(true); }
      function onBack(){close(false);}
      function onBackdrop(ev){if(ev.target===overlay)close(false);}
      function onKeydown(ev){
        if(ev.key==='Escape'){ev.preventDefault();close(false);return;}
        if(ev.key!=='Tab')return;
        const available=[back,check,...(proceed.disabled?[]:[proceed])];
        const current=available.indexOf(document.activeElement);
        if(ev.shiftKey && current<=0){ev.preventDefault();available[available.length-1].focus();}
        else if(!ev.shiftKey && current===available.length-1){ev.preventDefault();available[0].focus();}
      }
      check.addEventListener('change',onCheck);
      proceed.addEventListener('click',onProceed);
      back.addEventListener('click',onBack);
      overlay.addEventListener('click',onBackdrop);
      document.addEventListener('keydown',onKeydown);
    });
  }

  // ===== Painel de poltronas (novo seats.js via eventos)
  function renderSeatsStage(schedule, leg, onBackToList) {
    const titulo = leg === 'IDA' ? 'Escolha suas poltronas (ida)' : 'Escolha suas poltronas (volta)';
    content.innerHTML = `
      <h2 class="step-title">${titulo}</h2>
      <div id="seats-stage"></div>
    `;
    const stage = document.getElementById('seats-stage');

    if (typeof window.renderSeats !== 'function') {
      stage.innerHTML = '<p class="mute">Componente de poltronas não carregado. Atualize o <code>seats.js</code> para expor <b>window.renderSeats</b>.</p>';
      return;
    }

    // desenha o mapa (o próprio seats.js monta UI inteira)
    window.renderSeats(stage, schedule, (leg === 'IDA' ? 'ida' : 'volta'));

    // voltar
    stage.addEventListener('seats:back', onBackToList);

    // confirmar
    stage.addEventListener('seats:confirm', (ev) => {
      const { seats, passengers, schedule: sch, type } = ev.detail;

      // guarda no state
      const legLabel = leg;
      const idx = state.selected.findIndex(s => s.leg === legLabel);
      const payload = { leg: legLabel, schedule: sch, seats, passengers };
      if (idx >= 0) state.selected[idx] = payload;
      else state.selected.push(payload);

      // Se tem volta e estamos na ida: ir para lista da volta
      if (legLabel === 'IDA' && state.searchReturn) {
        state.leg = 'VOLTA';
        renderList(state.searchReturn, 'Viagens disponíveis (volta)', onSelectVolta);
        return;
      }

      // A ciência aparece somente na última confirmação (ida e volta juntas,
      // caso existam), não interfere em recovery e nunca inicia cobrança.
      if(stage.dataset.awaitingPolicy==='true') return;
      stage.dataset.awaitingPolicy='true';
      confirmCancellationNotice(state.selected)
        .then(accepted=>{if(accepted) finalizeToPayment();})
        .catch(error=>{
          console.error('[CancelPolicy] aviso não disponível:',error);
          alert('Não foi possível apresentar as condições de cancelamento. Atualize a página e tente novamente.');
        })
        .finally(()=>{stage.dataset.awaitingPolicy='false';});
    });

    function onSelectVolta(schedule2) {
      state.selected = state.selected.filter(s => s.leg !== 'VOLTA');
      state.selected.push({ leg: 'VOLTA', schedule: schedule2 });
      renderSeatsStage(schedule2, 'VOLTA', () => renderList(state.searchReturn, 'Viagens disponíveis (volta)', onSelectVolta));
    }
  }

  function finalizeToPayment() {
    // pega o usuário do localStorage, mas só considera logado se tiver e-mail
    let rawUser = null;
    try {
      rawUser = JSON.parse(localStorage.getItem('user') || 'null');
    } catch (_) {
      rawUser = null;
    }
    const user = (rawUser && rawUser.email) ? rawUser : null;

    // compõe legs para salvar (ida e possivelmente volta)
    const toSave = state.selected.map(s => ({
      id: Date.now() + Math.floor(Math.random() * 1000),
      schedule: s.schedule,
      seats: s.seats,
      passengers: s.passengers,
      price: (Number(String(s.schedule.price).replace(',', '.')) || 0) * (s.seats?.length || 0),
      date: s.schedule.date,
      paid: false
    }));

    // se NÃO estiver logado → salva compra pendente, define redirect e manda pro login
    if (!user) {
      localStorage.setItem('pendingPurchase', JSON.stringify({ legs: toSave }));
      localStorage.setItem('postLoginRedirect', 'payment.html');
      location.href = 'login.html';
      return;
    }

    // se já estiver logado → grava direto em bookings e segue pro pagamento
    const old = JSON.parse(localStorage.getItem('bookings') || '[]');
    const onlyPaid = old.filter(b => b.paid === true);
    localStorage.setItem('bookings', JSON.stringify([...onlyPaid, ...toSave]));
    localStorage.removeItem('pendingPurchase');
    location.href = 'payment.html';
  }

});

// NAV do usuário (Entrar quando deslogado; Nome -> Profile + Sair quando logado)
function updateUserNav() {
  try {
    const nav = document.getElementById('user-nav');
    if (!nav) return;

    const user = JSON.parse(localStorage.getItem('user') || 'null');
    const quickAccount = document.getElementById('mobile-account-link');
    if (quickAccount) {
      quickAccount.href = user?.email ? 'profile.html' : 'login.html';
      quickAccount.textContent = user?.email ? 'Minhas compras' : 'Acessar conta';
      quickAccount.onclick = user?.email ? null : () => {
        localStorage.setItem('postLoginRedirect', 'index.html');
      };
    }

    // DESLOGADO
    if (!user || !user.email) {
      nav.innerHTML = `
      <a class="pill cta-enter" href="login.html" id="nav-login">Acessar conta</a>
    `;

      // guarda de onde o usuário veio, para voltar depois do login
      const link = nav.querySelector('#nav-login');
      if (link) {
        link.addEventListener('click', () => {
          const href = location.href;
          // pega só o arquivo (index.html, profile.html, etc.)
          const file = href.substring(href.lastIndexOf('/') + 1) || 'index.html';
          localStorage.setItem('postLoginRedirect', file);
        });
      }
      return;
    }


    // LOGADO
    const name = user.name || user.email;

    // tente profile.html; se sua rota for /profile (sem extensão), troque abaixo
    const profileHref = 'profile.html';

    nav.innerHTML = `
      <a class="pill user-name" id="go-profile" href="${profileHref}">Minhas Compras</a>
      <button class="pill cta-exit" id="btn-logout" type="button">Desconectar</button>
    `;

    // Força navegação ao profile mesmo se algum script fizer preventDefault
    const link = nav.querySelector('#go-profile');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        // se sua página for "profile" (sem .html), troque aqui:
        window.location.href = profileHref;
      });
    }

    // Logout
    const btn = nav.querySelector('#btn-logout');
    if (btn) {
      btn.addEventListener('click', () => {
        localStorage.removeItem('user');
        window.location.href = 'index.html';
      });
    }

  } catch (e) {
    console.warn('updateUserNav falhou:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateUserNav();
  checkSessionTimeout();
});

// ——— Session Timeout (30 min) ———
function checkSessionTimeout() {
  const MAX_IDLE_MS = 30 * 60 * 1000; // 30 minutos
  const tick = () => {
    const lastActive = parseInt(localStorage.getItem('lastActive') || Date.now());
    const now = Date.now();

    if (now - lastActive > MAX_IDLE_MS) {
      if (localStorage.getItem('user')) {
        console.warn('Sessão expirada por inatividade.');
        localStorage.removeItem('user');
        alert('Sua sessão expirou por inatividade. Por favor, faça login novamente.');
        window.location.href = 'login.html';
      }
    }
  };

  // Checa imediatamente e depois a cada 60s
  tick();
  setInterval(tick, 60000);

  // Atualiza 'lastActive' agora e em eventos
  localStorage.setItem('lastActive', Date.now());
  const updateActivity = () => localStorage.setItem('lastActive', Date.now());
  ['mousemove', 'keydown', 'click'].forEach(evt => window.addEventListener(evt, updateActivity));
}