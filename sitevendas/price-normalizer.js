// Normaliza as tarifas retornadas pela Praxio antes de o main.js montar as viagens.
// Evita criar carrinhos com valor zero quando a API usa outro nome/formato de campo.
(() => {
  const originalFetch = window.fetch.bind(window);

  function parseMoney(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (value === null || value === undefined || value === '') return 0;

    let text = String(value).trim();
    if (text.includes(',') && text.includes('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(',', '.');
    }

    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function resolveFare(item) {
    const tfo = item?.ViagemTFO || item?.viagemTFO || {};
    const candidates = [
      item?.Tarifa,
      item?.tarifa,
      item?.ValorTarifa,
      item?.valorTarifa,
      item?.VlTarifa,
      item?.vlTarifa,
      item?.VlTarifaAnterior,
      item?.vlTarifaAnterior,
      tfo?.ValorTarifa,
      tfo?.valorTarifa,
      tfo?.VlTarifa,
      tfo?.vlTarifa
    ];

    for (const candidate of candidates) {
      const value = parseMoney(candidate);
      if (value > 0) return value;
    }
    return 0;
  }

  function normalizeList(list) {
    if (!Array.isArray(list)) return list;

    return list
      .map(item => {
        const fare = resolveFare(item);
        return { ...item, Tarifa: fare, __tarifaValida: fare > 0 };
      })
      .filter(item => {
        if (item.__tarifaValida) return true;
        console.error('[Tarifa] Viagem removida porque a Praxio não retornou valor válido:', item);
        return false;
      });
  }

  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);
    const url = typeof input === 'string' ? input : input?.url || '';

    if (!url.includes('/api/partidas')) return response;

    const clone = response.clone();
    try {
      const data = await clone.json();

      if (Array.isArray(data?.ListaPartidas)) {
        data.ListaPartidas = normalizeList(data.ListaPartidas);
      }

      const linhas = data?.PartidasXmlRetorno?.Linhas;
      if (Array.isArray(linhas)) {
        data.PartidasXmlRetorno.Linhas = normalizeList(linhas);
      } else if (Array.isArray(linhas?.Linha)) {
        data.PartidasXmlRetorno.Linhas.Linha = normalizeList(linhas.Linha);
      }

      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      console.error('[Tarifa] Falha ao normalizar resposta de partidas:', error);
      return response;
    }
  };
})();
