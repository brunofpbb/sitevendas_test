
require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');

async function run() {
    try {
        // 1. Login
        console.log('Logging in...');
        const loginResp = await fetch('https://oci-parceiros2.praxioluna.com.br/Autumn/Login/efetualogin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                Nome: process.env.PRAXIO_USER,
                Senha: process.env.PRAXIO_PASS,
                Sistema: 'WINVR.EXE',
                TipoBD: 0,
                Empresa: process.env.PRAXIO_EMP,
                Cliente: process.env.PRAXIO_CLIENT,
                TipoAplicacao: 0,
            }),
        });

        if (!loginResp.ok) throw new Error(`Login failed: ${loginResp.status}`);
        const loginData = await loginResp.json();
        const idSessao = loginData.IdSessaoOp;
        console.log('Logged in. Session:', idSessao);

        // 2. Search Partidas
        console.log('Searching Partidas...');
        const partResp = await fetch('https://oci-parceiros2.praxioluna.com.br/Autumn/Partidas/Partidas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                IdSessaoOp: idSessao,
                LocalidadeOrigem: 2, // Ouro Branco
                LocalidadeDestino: 24, // Mariana
                DataPartida: '04/01/2026',
                SugestaoPassagem: '1',
                ListarTodas: '1',
                SomenteExtra: '0',
                TempoPartida: 1,
                IdEstabelecimento: '1',
                DescontoAutomatico: 0,
            }),
        });

        const partData = await partResp.json();
        console.log('Got response. Saving to debug_response.json');
        fs.writeFileSync('debug_response.json', JSON.stringify(partData, null, 2));

    } catch (err) {
        console.error('Error:', err);
    }
}

run();
