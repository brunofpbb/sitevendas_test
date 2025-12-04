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

  originInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#ac-origin .ac-item');
      if (first) { first.dispatchEvent(new MouseEvent('mousedown')); e.preventDefault(); }
    }
  });
  destInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('#ac-destination .ac-item');
      if (first) { first.dispatchEvent(new MouseEvent('mousedown')); e.preventDefault(); }
    }
  });





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
          const disponiveis = linha.PoltronasDisponiveis || (linha.ViagemTFO && linha.ViagemTFO.PoltronasDisponiveis) || '';
          const tipoHorario = linha.TipoHorario || (linha.ViagemTFO && linha.ViagemTFO.TipoHorario) || '';
          const icons = tipoHorario && tipoHorario.toLowerCase().includes('execut') ? '❄️🛜🚻' : '';

          const card = document.createElement('div'); card.className = 'schedule-card';
          const header = document.createElement('div'); header.className = 'schedule-header';
          header.innerHTML = `
          <div><b>Saída:</b> ${saida || '00:00'}</div>
          <div><b>Chegada:</b> ${chegada || '--'}</div>
          <div><b>Tempo:</b> ${tempo || '--'}</div>
          <div><b>R$ ${isNaN(parseFloat(tarifaRaw)) ? '0,00' : parseFloat(tarifaRaw).toFixed(2)}</b></div>
        `;
          const body = document.createElement('div'); body.className = 'schedule-body';
          const parts = [];
          if (disponiveis) parts.push(`<div><b>Poltronas Disponíveis:</b> ${disponiveis} 💺</div>`);
          if (tipoHorario || icons) parts.push(`<div>${(tipoHorario || '') + ' ' + icons}</div>`);
          body.innerHTML = parts.join('');

          const actions = document.createElement('div'); actions.className = 'schedule-actions'; actions.style.gridRow = '1 / -1';
          const btn = document.createElement('button'); btn.className = 'btn btn-primary'; btn.textContent = 'Selecionar';
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
              seatsAvailable: disponiveis || null,
              serviceType: tipoHorario || null
            };
            onSelect && onSelect(schedule);
          });
          actions.appendChild(btn);

          header.style.gridColumn = '1 / 2'; actions.style.gridColumn = '2 / 3'; body.style.gridColumn = '1 / 2';
          card.appendChild(header); card.appendChild(actions); card.appendChild(body);
          list.appendChild(card);
        });
      })
      .catch(err => {
        console.error(err);
        status.textContent = 'Falha ao buscar viagens. Tente novamente mais tarde.';
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

      // fim do fluxo → pagamento
      finalizeToPayment();
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

    // DESLOGADO
    if (!user || !user.email) {
      nav.innerHTML = `
      <a class="pill cta-enter" href="login.html" id="nav-login">Entrar</a>
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
});
