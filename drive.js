// drive.js
const { google } = require('googleapis');
const { Readable } = require('stream');

function getDrive() {
  // A chave vem em JSON na env GDRIVE_SA_KEY (inteira, multiline mesmo)
  const key = JSON.parse(process.env.GDRIVE_SA_KEY || '{}');
  if (!key.client_email || !key.private_key) {
    throw new Error('GDRIVE_SA_KEY ausente ou inválida');
  }
  const auth = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ['https://www.googleapis.com/auth/drive.file']
  );
  return google.drive({ version: 'v3', auth });
}

async function uploadPdfToDrive({ buffer, filename, folderId }) {
  const drive = getDrive();

  const fileMetadata = { name: filename, parents: [folderId] };
  const media = { mimeType: 'application/pdf', body: Readable.from(buffer) };

  const create = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id,name,webViewLink,webContentLink',
  });

  const fileId = create.data.id;

  // Deixa "qualquer pessoa com o link" como leitor (opcional, mas prático)
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  const get = await drive.files.get({
    fileId,
    fields: 'id,name,webViewLink,webContentLink',
  });

  return {
    id: fileId,
    name: get.data.name,
    webViewLink: get.data.webViewLink,
    webContentLink: get.data.webContentLink,
  };
}

// Recupera o PDF arquivado, sem baixar de URL não confiável.
async function downloadPdfFromDrive(fileId) {
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(String(fileId || '')))
    throw new Error('Identificador de bilhete do Drive inválido');
  const drive = getDrive();
  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  const data = Buffer.from(response.data);
  if (!data.length || data.subarray(0,5).toString('ascii') !== '%PDF-')
    throw new Error('Arquivo recuperado não é um PDF válido');
  return data;
}

module.exports = { uploadPdfToDrive, downloadPdfFromDrive };
