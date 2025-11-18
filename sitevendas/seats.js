// seats.js — Seleção de poltronas (1-tela) com API Praxio, lista de passageiros e regras de ida/volta
(() => {
  // ====== Dimensões-base do layout (usadas para escalar) ======
  const BASE_IMG_WIDTH = 980;
  const BASE_TOP       = 28;      // px (sobe/desce a grade sobre o bus-blank)
  const BASE_LEFT      = 105;     // px (empurra grade p/ direita/esquerda)
  const BASE_CELL_W    = 41;      // largura da célula (assento)
  const BASE_CELL_H    = 36;      // altura da célula
  const BASE_GAP_X     = 17;      // espaço horizontal entre assentos
  const BASE_GAP_Y     = 12;      // espaço vertical entre assentos

  // ====== Malha do ônibus (5x11) ======
  const GRID = [
    [ 3,  7, 11, 15, 19, 23, 27, 31, 35, 39, null],
    [ 4,  8, 12, 16, 20, 24, 28, 32, 36, 40, null],
    [null,null,null,null,null,null,null,null,null,null,null],
    [ 2,  6, 10, 14, 18, 22, 26, 30, 34, 38, 42],
    [ 1,  5,  9, 13, 17, 21, 25, 29, 33, 37, 41],
  ];

  // ====== estilos ======
  const STYLE_ID = 'seats-onepage-style';
  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
:root{ --brand:#0b5a2b; --brand-700:#094a24; --muted:#2a3b2a; }

/* Mesmo respiro do card da esquerda (botão Pesquisar) */
.seats-onepage-root{ padding:0 16px 16px 16px; }

.seats-onepage .bus-wrap{ position:relative; overflow:hidden; }
.seats-onepage .bus-img{ max-width:100%; height:auto; display:block; }

.seats-onepage .bus-grid{
  position:absolute;
  top:var(--grid-top, ${BASE_TOP}px);
  left:var(--grid-left, ${BASE_LEFT}px);
  display:grid;
  grid-template-columns: repeat(11, var(--cell-w, ${BASE_CELL_W}px));
  grid-auto-rows: var(--cell-h, ${BASE_CELL_H}px);
  column-gap: var(--gap-x, ${BASE_GAP_X}px);
  row-gap: var(--gap-y, ${BASE_GAP_Y}px);
}






/* Ajuste fino do ônibus no mobile: traz as poltronas um pouco pra esquerda */
@media (max-width: 768px){
  .seats-onepage .bus-grid{
    transform: translateX(-90px);  /* teste -16, -18, -20 até encaixar */
  }
}














.seats-onepage .seat{
  background:#eaf5ea; color:#1a301a;
  border:1px solid #d8ead8; border-radius:6px;
  min-width:var(--cell-w, ${BASE_CELL_W}px);
  height:var(--cell-h, ${BASE_CELL_H}px);
  line-height: calc(var(--cell-h, ${BASE_CELL_H}px) - 2px);
  font-size:12px; text-align:center; user-select:none; cursor:pointer;
}
.seats-onepage .seat.selected{
  background:var(--brand)!important; color:#fff!important; border-color:var(--brand-700)!important;
}
.seats-onepage .seat.disabled{
  background:#cfd6cf!important; color:#666!important; border-color:#cfd6cf!important; cursor:not-allowed;
}
.seats-onepage .walkway{ width:var(--cell-w, ${BASE_CELL_W}px); height:var(--cell-h, ${BASE_CELL_H}px); opacity:0; }

/* Mais respiro entre os blocos */
.seats-onepage .legend{
  display:flex; justify-content:center; gap:28px; margin:16px 0 10px;
}
.seats-onepage .legend .i{ display:flex; align-items:center; gap:10px; font-size:1rem; color:var(--muted); }
.seats-onepage .legend .sw{ width:18px; height:18px; border-radius:4px; border:1px solid #d8ead8; }
.seats-onepage .sw.free{ background:#eaf5ea; }
.seats-onepage .sw.sel{  background:var(--brand); border-color:var(--brand-700); }
.seats-onepage .sw.occ{  background:#cfd6cf; border-color:#cfd6cf; }

.seats-onepage .info-line{ margin:10px 0 4px; color:var(--muted); font-weight:700; }
.seats-onepage .counter{ margin-bottom:14px; }







/* Lista de passageiros (inputs com estilo de form-control) */
.seats-onepage .pax { display:none; margin-top:12px; }
.seats-onepage .pax.readonly input{ background:#f7f7f7; color:#666; }
.seats-onepage .pax-list{ display:flex; flex-direction:column; gap:10px; }
.seats-onepage .pax-row{
  display:grid;
  grid-template-columns: 90px 1.3fr 1fr 1fr;
  gap:12px;
  align-items:center;
}
.seats-onepage .pax-row .label{
  color:#2a3b2a;
  font-weight:600;
  text-align:right;
  padding-right:6px;
}

/* MOBILE: empilha os campos para não estourar a largura */
@media (max-width: 768px){
  .seats-onepage .pax-row{
    grid-template-columns: 1fr;
  }
  .seats-onepage .pax-row .label{
    text-align:left;
    padding-right:0;
  }
}

/* fallback de .form-control (parecido com os campos da esquerda) */
.seats-onepage .pax-row .form-control{









  height: 36px;
  padding: 6px 10px;
  border: 1px solid #ced4da;
  border-radius: .375rem;
  font-size: .95rem;
  line-height: 1.4;
  outline: none;
}

/* Ações alinhadas e com respiro inferior como no card da esquerda */
.seats-onepage .actions{ display:flex; gap:10px; margin-top:18px; }
.seats-onepage .btn{ padding:8px 14px; border-radius:6px; border:1px solid transparent; cursor:pointer; }
.seats-onepage .btn-primary{ background:var(--brand); color:#fff; }
.seats-onepage .btn-ghost{ background:#e9ecef; color:#222; }



/* --- OVERRIDES DE ESPAÇAMENTO (com !important) --- */

.seats-onepage-root{
  /* mesmo “respiro” do card da esquerda (ex.: botão Pesquisar) */
  padding-left:16px !important;
  padding-right:16px !important;
  padding-bottom:16px !important;
}

.seats-onepage{ margin:0 !important; }

/* dá ar entre as seções para evitar “textos colados” */
.seats-onepage .legend{ margin:18px 0 12px !important; }
.seats-onepage .info-line{ margin:10px 0 6px !important; }
.seats-onepage .counter{ margin:0 0 14px !important; }
.seats-onepage .pax{ margin-top:12px !important; }

/* respiro antes dos botões */
.seats-onepage .actions{ margin-top:18px !important; gap:10px !important; }

/* só por garantia: nenhum padding extra no wrapper interno */
.seats-onepage .bus-wrap{ padding:0 !important; }











`.trim();
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ===== helpers =====
  const pick = (...v) => v.find(x => x !== undefined && x !== null && x !== '') ?? '';
  const fmtDateBR = (iso) => {
    if (!iso || !iso.includes('-')) return iso || '';
    const [Y,M,D] = iso.split('-'); return `${D}/${M}/${Y}`;
  };
  function isExecutive(schedule){
    const t = (pick(schedule?.category, schedule?.tipo, schedule?.busType, '')+'').toLowerCase();
    if (t.includes('exec')) return true;
    if (t.includes('convenc')) return false;
    const label = (schedule?.classLabel || schedule?.service || '')+'';
    if (label.toLowerCase().includes('exec')) return true;
    return false;
  }

  // Normaliza "DD/MM/YYYY" -> "YYYY-MM-DD" (mantém se já vier ISO)
function toYMD(dateStr) {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const m = String(dateStr).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const t = Date.parse(dateStr);
  if (!Number.isNaN(t)) {
    const z = new Date(t);
    const yyyy = z.getFullYear();
    const mm = String(z.getMonth()+1).padStart(2,'0');
    const dd = String(z.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return '';
}


  // ===== snapshot ida (para volta) =====
  function saveOutboundSnapshot(passengers) {
    localStorage.setItem('outboundPassengers', JSON.stringify(passengers));
    localStorage.setItem('outboundSeatCount', String(passengers.length));
  }
  function loadOutboundSnapshot() {
    const pax = JSON.parse(localStorage.getItem('outboundPassengers') || '[]');
    const cnt = Number(localStorage.getItem('outboundSeatCount') || 0) || pax.length;
    return { pax, cnt };
  }

  // ====== Busca mapa de poltronas (Praxio) quando não vier pronto ======
  async function ensureSeatMap(schedule){
    const seats = schedule?.seats;
    const looksReady = Array.isArray(seats) && seats.length > 0 &&
                       (('situacao' in (seats[0]||{})) || ('Situacao' in (seats[0]||{})) || ('occupied' in (seats[0]||{})));
    if (looksReady) return;

    const payload = {
      idViagem:       pick(schedule?.idViagem, schedule?.idviagem, schedule?.viagemId),
      idTipoVeiculo:  pick(schedule?.idTipoVeiculo, schedule?.tipoVeiculoId),
      idLocOrigem:    pick(schedule?.originId, schedule?.origemId, schedule?.idOrigem, schedule?.idLocOrigem),
      idLocDestino:   pick(schedule?.destinationId, schedule?.destinoId, schedule?.idDestino, schedule?.idLocDestino),
      andar: 0,
      verificarSugestao: 1,
    };

    try {
      const resp = await fetch('/api/poltronas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const raw = await resp.json();
      const data = Array.isArray(raw) ? (raw[0] || {}) : raw;

      let poltronas = [];
      if (data?.LaypoltronaXml?.PoltronaXmlRetorno) {
        poltronas = data.LaypoltronaXml.PoltronaXmlRetorno;
      } else if (data?.PoltronaXmlRetorno) {
        const p = data.PoltronaXmlRetorno;
        poltronas = Array.isArray(p) ? p : [p];
      }

      const mapped = (poltronas || []).map(p => {
        const caption  = p.Caption ?? p.caption;
        const number   = parseInt(caption || p.Numero || p.NumeroPoltrona, 10);
        const situacao = parseInt(p.Situacao ?? p.situacao ?? 0, 10);
        return { number, situacao, occupied: situacao !== 0 };
      }).filter(s => Number.isFinite(s.number) && s.number >= 1 && s.number <= 42);

      if (mapped.length) schedule.seats = mapped;
    } catch (e) {
      console.error('Erro ao carregar mapa de poltronas:', e);
    }
  }

  // ===== API pública =====
  window.renderSeats = async function renderSeats(container, schedule, wayType){
    ensureStyles();
    if (!container) throw new Error('renderSeats: container inválido');

    container.classList.add('seats-onepage-root');
    container.innerHTML = '';

    
    const root = document.createElement('div');
    root.className = 'seats-onepage';
    root.innerHTML = `
      <div class="bus-wrap">
        <img src="bus-blank.png" alt="Layout do ônibus" class="bus-img" />
        <div class="bus-grid" id="busGrid"></div>
      </div>

      <div class="legend">
        <div class="i"><span class="sw free"></span> Disponível</div>
        <div class="i"><span class="sw sel"></span> Selecionado</div>
        <div class="i"><span class="sw occ"></span> Ocupado</div>
      </div>

      <div class="info-line" id="tripInfo"></div>
      <div class="counter">Poltronas selecionadas: <b id="selCount">0</b></div>

      <div class="pax" id="paxBox">
        <div class="pax-list" id="paxList"></div>
      </div>

      <div class="actions">
        <button class="btn btn-primary" id="btnConfirm">Confirmar seleção</button>
        <button class="btn btn-ghost"   id="btnBack">Voltar</button>
      </div>
    `;
    container.appendChild(root);

    // refs
    const img      = root.querySelector('.bus-img');
    const gridEl   = root.querySelector('#busGrid');
    const tripInfo = root.querySelector('#tripInfo');
    const selCount = root.querySelector('#selCount');
    const paxBox   = root.querySelector('#paxBox');
    const paxList  = root.querySelector('#paxList');
    const btnConfirm = root.querySelector('#btnConfirm');
    const btnBack    = root.querySelector('#btnBack');

    // Cabeçalho
    const origin = pick(schedule?.originName, schedule?.origin, schedule?.origem, '');
    const dest   = pick(schedule?.destinationName, schedule?.destination, schedule?.destino, '');
    const dateBR = fmtDateBR(schedule?.date || '');
    const time   = pick(schedule?.departureTime, schedule?.horaPartida, '');
    tripInfo.textContent = `${origin} → ${dest} — ${dateBR} às ${time} (${wayType || 'ida'})`;

    // Estado
    const state = {
      type: (wayType || 'ida'),
      schedule: schedule || {},
      exec: isExecutive(schedule),
      seats: [],      // ordem de seleção
      pax: {}         // { num: { name, cpf, phone } }
    };

    await ensureSeatMap(schedule);
    // garante data ISO usada no pagamento/webhook
    state.schedule.date = toYMD(state.schedule.date || state.schedule.dataViagem || '');

    // cria Map por número
    const seatMap = new Map();
    if (Array.isArray(schedule?.seats)) {
      schedule.seats.forEach(s => {
        if (Number.isFinite(Number(s.number))) seatMap.set(Number(s.number), s);
      });
    }

    const isReturn = state.type === 'volta';
    let maxSelectable = Infinity;
    let obPax = [];
    if (isReturn) {
      const snap = loadOutboundSnapshot();
      maxSelectable = snap.cnt || 0;
      obPax = snap.pax || [];
      paxBox.classList.add('readonly');
    }

    function isSeatBlocked(num){
      if (num === 1 || num === 2) return true;             // bloqueadas fixas
      const sd = seatMap.get(num);
      if (!sd) return true;                                 // não existe/indisp.
      if (Number(sd.situacao) === 3) return true;           // inativa
      if (sd.occupied === true || Number(sd.situacao) !== 0) return true; // ocupada
      return false;
    }

    // Renderiza inputs de passageiros (uma linha por poltrona selecionada)
    function renderPaxList(){
      if (state.seats.length === 0){
        paxBox.style.display = 'none';
        paxList.innerHTML = '';
        return;
      }
      paxBox.style.display = 'block';
      paxList.innerHTML = '';

      state.seats.forEach((seatNum, idx) => {
        const row = document.createElement('div');
        row.className = 'pax-row';

        // Pré-preencher na volta (readonly)
        if (isReturn && obPax[idx]) {
          state.pax[seatNum] = {
            name:  obPax[idx].name  || '',
            cpf:   obPax[idx].cpf   || '',
            phone: obPax[idx].phone || '',
          };
        } else {
          state.pax[seatNum] ||= { name:'', cpf:'', phone:'' };
        }

        const v = state.pax[seatNum];

        row.innerHTML = `
          <div class="label">Pol ${seatNum}:</div>
          <input type="text" class="form-control pax-name"  placeholder="Nome"     ${isReturn?'readonly':''} ${!isReturn?'required':''} value="${v.name||''}">
          <input type="text" class="form-control pax-cpf"   placeholder="CPF"       ${isReturn?'readonly':''} ${!isReturn?'required':''} value="${v.cpf||''}">
          <input type="text" class="form-control pax-phone" placeholder="Telefone"  ${isReturn?'readonly':''} ${!isReturn?'required':''} value="${v.phone||''}">
        `;

        // Bind
        if (!isReturn){
          const [nameI, cpfI, phoneI] = row.querySelectorAll('input');
          nameI.addEventListener('input', () => { state.pax[seatNum].name  = nameI.value; });
          cpfI .addEventListener('input', () => { state.pax[seatNum].cpf   = cpfI.value;  });
          phoneI.addEventListener('input', () => { state.pax[seatNum].phone = phoneI.value; });
        }

        paxList.appendChild(row);
      });
    }

    // Desenha a malha
    GRID.forEach((row, r) => {
      row.forEach((cell, c) => {
        const rr = r+1, cc = c+1;
        if (cell === null){
          const w = document.createElement('div');
          w.className = 'walkway';
          w.style.gridRowStart = rr;
          w.style.gridColumnStart = cc;
          gridEl.appendChild(w);
          return;
        }
        const seat = document.createElement('div');
        seat.className = 'seat';
        seat.textContent = String(cell);
        seat.style.gridRowStart = rr;
        seat.style.gridColumnStart = cc;

        if (isSeatBlocked(cell)){
          seat.classList.add('disabled');
          seat.setAttribute('aria-disabled','true');
          gridEl.appendChild(seat);
          return;
        }

        seat.addEventListener('click', () => {
          const i = state.seats.indexOf(cell);
          if (i>=0){
            state.seats.splice(i,1);
            seat.classList.remove('selected');
            delete state.pax[cell];
          }else{
            if (isReturn && state.seats.length >= maxSelectable){
              alert(`Para a volta selecione exatamente ${maxSelectable} poltronas.`);
              return;
            }
            state.seats.push(cell);
            seat.classList.add('selected');
          }
          selCount.textContent = String(state.seats.length);
          renderPaxList();
        });

        gridEl.appendChild(seat);
      });
    });

    // Botões
    btnConfirm.addEventListener('click', () => {
      if (isReturn && isFinite(maxSelectable) && state.seats.length !== maxSelectable){
        alert(`Selecione exatamente ${maxSelectable} poltronas para a volta.`);
        return;
      }
      if (!isReturn){
        for (const n of state.seats){
          const p = state.pax[n] || {};
          if (!p.name || !p.cpf || !p.phone){
            alert('Preencha nome, CPF e telefone para todas as poltronas selecionadas.');
            return;
          }
        }
      }
      const passengers = state.seats.map(n => ({ seatNumber:n, ...(state.pax[n]||{}) }));
      if (!isReturn) saveOutboundSnapshot(passengers);


      // ===== (3) Persistir telefone (e nome) no perfil local =====
      // Usa o primeiro passageiro como fonte do contato do comprador
      try {
        const u  = JSON.parse(localStorage.getItem('user') || '{}');
        const p0 = passengers[0] || {};
        const phoneDigits = String(p0.phone || '').replace(/\D/g,'');
        if (phoneDigits) u.phone = phoneDigits;   // lido depois pelo payment.js -> webhook
        if (!u.name && p0.name) u.name = p0.name;
        localStorage.setItem('user', JSON.stringify(u));
      } catch (_) {}

      // ===== (4) Marcar ida/volta explicitamente no leg =====
      // Mantém compatibilidade: além do `type` existente, enviamos `isReturn`/`tripType`
      const legType = isReturn ? 'volta' : 'ida';

      

      

      container.dispatchEvent(new CustomEvent('seats:confirm', {
           detail: {
          seats: state.seats.slice(),
          passengers,
          schedule: state.schedule,
          type: state.type,
          // extras para o carrinho/pagamento:
          isReturn: isReturn,
          tripType: legType
        }
      }));
    });

    btnBack.addEventListener('click', () => {
      container.dispatchEvent(new CustomEvent('seats:back'));
    });


    /*
    // ===== Responsividade =====
    function applyScale() {
      const w = img?.getBoundingClientRect().width || BASE_IMG_WIDTH;
   //   const scale = Math.max(0.6, Math.min(1.5, w / BASE_IMG_WIDTH));
      const scale = Math.min(1.5, w / BASE_IMG_WIDTH);
      root.style.setProperty('--grid-top',  (BASE_TOP   * scale) + 'px');
      root.style.setProperty('--grid-left', (BASE_LEFT  * scale) + 'px');
      root.style.setProperty('--cell-w',    (BASE_CELL_W* scale) + 'px');
      root.style.setProperty('--cell-h',    (BASE_CELL_H* scale) + 'px');
      root.style.setProperty('--gap-x',     (BASE_GAP_X * scale) + 'px');
      root.style.setProperty('--gap-y',     (BASE_GAP_Y * scale) + 'px');
    }
*/


function applyScale() {
  if (!img) return;

  const w = img.getBoundingClientRect().width || BASE_IMG_WIDTH;

  // escala real baseada na largura do ônibus (sem mínimo forçado)
  let scale = w / BASE_IMG_WIDTH;

  // limita só pra não ficar gigante em telas enormes
  if (scale > 1.5) scale = 1.5;

  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  // pequeno ajuste só para mobile (puxa um pouco para a esquerda)
  const baseLeft = isMobile ? (BASE_LEFT - 30) : BASE_LEFT;

  root.style.setProperty('--grid-top',  (BASE_TOP   * scale) + 'px');
  root.style.setProperty('--grid-left', (baseLeft   * scale) + 'px');
  root.style.setProperty('--cell-w',    (BASE_CELL_W* scale) + 'px');
  root.style.setProperty('--cell-h',    (BASE_CELL_H* scale) + 'px');
  root.style.setProperty('--gap-x',     (BASE_GAP_X * scale) + 'px');
  root.style.setProperty('--gap-y',     (BASE_GAP_Y * scale) + 'px');
}



    
    
    const ro = new ResizeObserver(applyScale);
    ro.observe(img);
    img.addEventListener('load', applyScale);
    applyScale();
  };

  window.destroySeats = function(container){
    if (container) container.innerHTML = '';
  };
})();
