// services/ticket/pdf.js — rev6 (fix valores vazios, caminho do logo, bloco QR)
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

// Helpers
function formatEmissaoBR(iso, tzOffsetMin = -180) {
  const src = new Date(iso || Date.now());
  const local = new Date(src.getTime() + (tzOffsetMin + src.getTimezoneOffset()) * 60000);
  const p = n => String(n).padStart(2,'0');
  const y = local.getFullYear(), m = p(local.getMonth()+1), d = p(local.getDate());
  const hh = p(local.getHours()), mm = p(local.getMinutes());
  const sgn = tzOffsetMin <= 0 ? '-' : '+';
  const oh = p(Math.floor(Math.abs(tzOffsetMin)/60)), om = p(Math.abs(tzOffsetMin)%60);
  return `${d}/${m}/${y} ${hh}:${mm} ${sgn}${oh}:${om}`;
}
function fit(doc, text, w) {
  const ell = '…';
  let s = String((text || '')); // <-- aceita '' mas cai no fallback lá no value()
  if (!s) return '';
  if (doc.widthOfString(s) <= w) return s;
  while (s.length && doc.widthOfString(s + ell) > w) s = s.slice(0,-1);
  return s + ell;
}
function safeName(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Za-z0-9_-]+/g,'_').replace(/_+/g,'_').replace(/^_+|_+$/g,'');
}

exports.generateTicketPdf = async (t, outDir) => {
  await fs.promises.mkdir(outDir, { recursive: true });

  const baseName = `bpe_${safeName(t.nomeCliente)}_${safeName((t.dataViagem||'').replace(/\D/g,''))}_${safeName((t.horaPartida||'').replace(/\D/g,''))}_${safeName(t.numPassagem) || 'boleto'}.pdf`;
  const outPath = path.join(outDir, baseName);

  const qrDataURL = await QRCode.toDataURL(t.qrUrl || t.urlQrBPe || '', { margin: 1, scale: 6 });

  const doc = new PDFDocument({ size: 'A4', margins: { top: 36, left: 36, right: 36, bottom: 42 } });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  const pageW = () => (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  const left = () => doc.page.margins.left;
  const centerX = () => left() + pageW()/2;
  const HR = (y) => {
    doc.save()
      .moveTo(left(), y)
      .lineTo(left()+pageW(), y)
      .lineWidth(0.7)
      .strokeColor('#bbb')
      .stroke()
      .restore();
  };

  // Título
  doc.font('Helvetica-Bold').fontSize(14)
     .text('DABP-e - Documento Auxiliar do Bilhete de Passagem Eletrônico', left(), doc.y, { width: pageW(), align:'center' });
  let y = doc.y + 8; HR(y); doc.y = y + 10;

  // ===== Empresa (logo + textos)
    
  (function renderEmpresa() {
  // tenta /img e /sitevendas/img
  const logoCandidates = [
    path.join(__dirname, '..', '..', 'img', 'Logo Nova ISO2.jpg'),
    path.join(__dirname, '..', '..', 'sitevendas', 'img', 'Logo Nova ISO2.jpg'),
  ];
  const logoPath = logoCandidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });

  // preferências
  const wantGroupedCentered = t.headerCentered === true; // centralizar "logo + textos" como um grupo
  const startY = doc.y;
  const imgW = logoPath ? 90 : 0;
  const gap  = logoPath ? 170 : 0; // era 10

  // 1) medimos a largura necessária do bloco de textos
  const title = String(t.empresa || 'TURIN TRANSPORTES LTDA');
  const l1 = [
    t.cnpjEmpresa ? `CNPJ: ${t.cnpjEmpresa}` : null,
    t.ie          ? `IE.: ${t.ie}`           : null,
    t.im          ? `IM.: ${t.im}`           : null,
  ].filter(Boolean).join('    ');
  const l2 = [t.enderecoEmpresa, t.bairroEmpresa ? `- ${t.bairroEmpresa}` : null].filter(Boolean).join(' ');
  const l3 = [
    t.cidadeEmpresa || null,
    t.telefoneEmpresa ? `Telefone: ${t.telefoneEmpresa}` : null,
  ].filter(Boolean).join(' - ');

  // medir com as fontes corretas
  doc.font('Helvetica-Bold').fontSize(11);
  const wTitle = doc.widthOfString(title || '');

  doc.font('Helvetica').fontSize(9);
  const wL1 = doc.widthOfString(l1 || '');
  const wL2 = doc.widthOfString(l2 || '');
  const wL3 = doc.widthOfString(l3 || '');

  const textW = Math.max(wTitle, wL1, wL2, wL3, 180); // mínimo razoável p/ evitar quebra
  const groupW = imgW + gap + textW;

  // 2) decide posicionamento
  let xLogo, xText, textWidth;
  if (logoPath && wantGroupedCentered) {
    const xStart = left() + (pageW() - groupW) / 2;
    xLogo = xStart;
    xText = xStart + imgW + gap;
    textWidth = textW;
  } else if (logoPath) {
    // tabulado à esquerda (logo esq., texto à direita)
    xLogo = left();
    xText = left() + imgW + gap;
    textWidth = pageW() - imgW - gap;
  } else {
    // sem logo — tudo centralizado padrão
    xLogo = null;
    xText = left();
    textWidth = pageW();
  }

  // 3) desenhar
  if (xLogo != null) doc.image(logoPath, xLogo, startY, { width: imgW });

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000')
     .text(title || '', xText, startY, { width: textWidth, align: (logoPath ? 'left' : 'center') });

  doc.font('Helvetica').fontSize(9).fillColor('#000');
  if (l1) doc.text(l1, xText, doc.y, { width: textWidth, align: (logoPath ? 'left' : 'center') });
  if (l2) doc.text(l2, xText, doc.y, { width: textWidth, align: (logoPath ? 'left' : 'center') });
  if (l3) doc.text(l3, xText, doc.y, { width: textWidth, align: (logoPath ? 'left' : 'center') });

  const afterY = Math.max(startY + 52, doc.y);
  HR(afterY);
  doc.y = afterY + 8;
})();

  
  // ===== Bloco “Detalhes da viagem”
  const w = pageW();
  const colW = Math.floor(w/3) - 12;
  const x0 = left(), x1 = x0 + colW + 18, x2 = x1 + colW + 18;
  const gridStartY = doc.y;
  const rowH = 26;              //era 26

  const label = (txt, x, yy) => doc.font('Helvetica').fontSize(9).fillColor('#555').text(txt, x, yy, { width: colW, lineBreak:false });
  const value = (txt, x, yy, bold=true) => {
    const val = (txt || '—');                  // <-- aqui corrige string vazia
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#111');
    doc.text(fit(doc, val, colW), x, yy, { width: colW, lineBreak:false });
  };
  const cell = (x, lbl, val, row) => {
    const yy = gridStartY + row*rowH;
    label(lbl, x, yy);
    value(val, x, yy + 11);
  };

  cell(x0, 'Empresa', t.empresa, 0);
  cell(x1, 'Horário', t.horaPartida, 0);
  cell(x2, 'Classe',  t.classe, 0);

  cell(x0, 'Origem',   t.origem, 1);
  cell(x1, 'Poltrona', t.poltrona, 1);
  cell(x2, 'Bilhete',  t.numPassagem, 1);

  cell(x0, 'Destino', t.destino, 2);
  cell(x1, 'Linha',   t.nomeLinha, 2);
  cell(x2, 'Série',   t.serie, 2);

  cell(x0, 'Data',    t.dataViagem, 3);
  cell(x1, 'Prefixo', t.codigoLinha, 3);

  const afterGrid = gridStartY + 4*rowH + 10;
  HR(afterGrid);

  // ===== Linha Passageiro / Documento
  const yPD = afterGrid + 10;
  const half = Math.floor(w/2) - 10;
  doc.font('Helvetica').fontSize(9).fillColor('#555').text('Passageiro:', x0, yPD, { width: 70, lineBreak:false });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
     .text(fit(doc, (t.nomeCliente || '—'), half - 80), x0 + 70, yPD, { width: half-80, lineBreak:false });

  doc.font('Helvetica').fontSize(9).fillColor('#555').text('Documento:', x0 + half + 20, yPD, { width: 80, lineBreak:false });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
     .text(fit(doc, (t.documento || '—'), half - 100), x0 + half + 20 + 80, yPD, { width: half-100, lineBreak:false });

  const yPDLine = yPD + 18;
  HR(yPDLine);

  // ===== Totais (2 colunas)
 /* const yVals = yPDLine + 10;
  const halfW = Math.floor(w/2) - 12;
  const colRightX = x0 + halfW + 24;

  let yL = yVals;
  const moneyL = (lbl, val) => {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(lbl, x0, yL, { width: halfW, lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(String(val || 'R$ 0,00'), x0, yL + 11, { width: halfW, lineBreak:false });
    yL += 28;
  };
  moneyL('Tarifa', t.tarifa);
  moneyL('Taxa de Embarque', t.taxaEmbarque);
  moneyL('Outros', t.outros);

  let yR = yVals;
  const moneyR = (lbl, val, big=false) => {
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(lbl, colRightX, yR, { width: halfW, lineBreak:false });
    doc.font('Helvetica-Bold').fontSize(big?12:11).fillColor('#111').text(String(val || '—'), colRightX, yR + 11, { width: halfW, lineBreak:false });
    yR += 28;
  };
  moneyR('Forma de Pagamento', t.formaPagamento || '—');
  moneyR('Valor Pago', t.valorTotalFmt, true);*/


// ===== Totais (2 colunas)
const yVals   = yPDLine + 10;
const halfW   = Math.floor(w/2) - 12;
const colRX   = x0 + halfW + 24;

let yL = yVals;
const moneyL = (lbl, val) => {
  doc.font('Helvetica').fontSize(9).fillColor('#555')
     .text(lbl, x0, yL, { width: halfW, lineBreak:false });

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111')
     .text(String(val || 'R$ 0,00'), x0, yL + 11, { width: halfW, lineBreak:false });

  yL += 28;
};
moneyL('Tarifa', t.tarifa);
moneyL('Taxa de Embarque', t.taxaEmbarque);
moneyL('Outros', t.outros);

let yR = yVals;
// >>> aceitando tamanho customizado para o valor <<<
const moneyR = (lbl, val, valueSize = 11) => {
  doc.font('Helvetica').fontSize(9).fillColor('#555')
     .text(lbl, colRX, yR, { width: halfW, lineBreak:false });

  doc.font('Helvetica-Bold').fontSize(valueSize).fillColor('#111')
     .text(String(val || '—'), colRX, yR + 11, { width: halfW, lineBreak:false });

  // um pouco mais de espaçamento quando a fonte é maior
  yR += (valueSize > 11 ? 32 : 28);
};

moneyR('Forma de Pagamento', t.formaPagamento || '—', 11);
// aqui você escolhe o tamanho só do conteúdo (ex.: 14 ou 16)
moneyR('Valor Pago', t.valorTotalFmt, 14);




  

  // ===== BLOCO DO QR (ordem solicitada)
  const yBeforeQR = Math.max(yL, yR) + 6;
  HR(yBeforeQR);
  doc.y = yBeforeQR;
  doc.moveDown(2.4); // respiro

  // 1) Consulta via chave de acesso
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
     .text('Consulta via chave de acesso', left(), doc.y, { width: pageW(), align:'center' });

// 2) URL oficial
doc.moveDown(0.3);
doc.font('Helvetica').fontSize(10).fillColor('#000')
   .text(t.urlConsultaAcesso || 'https://bpe.fazenda.mg.gov.br/bpe/services/BPeConsultaDFe',
     left(), doc.y, { width: pageW(), align:'center' });

// 3) Chave logo abaixo da URL (sempre reserva a linha)
doc.moveDown(0.2);
doc.font('Helvetica').fontSize(9).fillColor('#000')
   .text(t.chaveBPe ? t.chaveBPe : ' ', left(), doc.y, { width: pageW(), align:'center' });


  // 4) Título do QR
  doc.moveDown(0.9);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
     .text('Consulta via leitor de QR Code', left(), doc.y, { width: pageW(), align:'center' });

  // 5) QR centralizado
  const qrSize = 110;
  const qrX = centerX() - qrSize/2;
  const qrY = doc.y + 6;
  doc.image(qrDataURL, qrX, qrY, { width: qrSize, height: qrSize });
  doc.y = qrY + qrSize + 10;

  // 6) Emissão
  doc.font('Helvetica').fontSize(9).fillColor('#000')
     .text(`Emissão: ${formatEmissaoBR(t.emissaoISO, -180)}`, left(), doc.y, { width: pageW(), align:'center' });

  // 7) Protocolo
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#000')
     .text('Protocolo de autorização: EMITIDO EM CONTINGÊNCIA', left(), doc.y, { width: pageW(), align:'center' });


  

// ── separador abaixo do protocolo
const yInfoSep = doc.y + 8;
HR(yInfoSep);
doc.y = yInfoSep + 10;

// ── Informações importantes
doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
   .text('Informações importantes:', left(), doc.y, { width: pageW(), align:'center' });

// linha exclusiva p/ “Política de Cancelamento:”
doc.moveDown(0.4);
doc.font('Helvetica-Bold').fontSize(9)
   .text('Política de Cancelamento:', left(), doc.y, { width: pageW(), align:'center' });

// pula 1 linha e escreve o restante do parágrafo
doc.moveDown(0.6);
doc.font('Helvetica').fontSize(9);
doc.text(
  'Em Minas Gerais, para os usuários do transporte intermunicipal vale o que determinam a Lei estadual 13.655, de 2000, e o Decreto 44.603, de 2007, que estipulam o prazo de até',
  left(), doc.y, { width: pageW(), align:'center' }
);

// trecho em negrito
doc.font('Helvetica-Bold').fontSize(9)
   .text('12 horas antes do embarque', left(), doc.y, { width: pageW(), align:'center' });

// conclusão do parágrafo
doc.font('Helvetica').fontSize(9)
   .text('para que o passageiro cancele e tenha direito ao reembolso ou remarque sua passagem.', left(), doc.y, { width: pageW(), align:'center' });

// Orientações para cancelamento pelo portal de vendas.
// O link é uma anotação clicável no PDF, não apenas texto.
doc.moveDown(0.9);
doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
   .text('Para solicitar o cancelamento do seu bilhete, observada a política acima, acesse:', left(), doc.y, { width: pageW(), align:'center' });

doc.moveDown(0.3);
doc.font('Helvetica-Bold').fontSize(10).fillColor('#005b28')
   .text('https://vendas.turintransportes.com/', left(), doc.y, {
     width: pageW(),
     align: 'center',
     link: 'https://vendas.turintransportes.com/',
     underline: true
   });

doc.moveDown(0.3);
doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
   .text('Entre com seu e-mail e, em Minhas compras, selecione o bilhete que deseja cancelar.', left(), doc.y, { width: pageW(), align:'center' });





  
  doc.end();
  await new Promise(r => stream.on('finish', r));
  return { path: outPath, filename: baseName };
};
