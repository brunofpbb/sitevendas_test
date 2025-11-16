// login.js — fluxo em 2 etapas: solicitar código e validar código
document.addEventListener('DOMContentLoaded', () => {
  if (typeof updateUserNav === 'function') updateUserNav();

  const stepEmail = document.getElementById('step-email');
  const stepCode  = document.getElementById('step-code');
  const emailForm = document.getElementById('email-form');
  const codeForm  = document.getElementById('code-form');

  const emailInput = document.getElementById('email');
  const codeInput  = document.getElementById('code');

  const emailMsg = document.getElementById('email-msg');
  const codeMsg  = document.getElementById('code-msg');

  const emailMask = document.getElementById('email-mask');
  const displayCodeEl = document.getElementById('display-code');

  const btnSend   = document.getElementById('btn-send');
  const btnVerify = document.getElementById('btn-verify');
  const btnResend = document.getElementById('btn-resend');

  const maskEmail = (e) => {
    const [user, domain] = String(e).split('@');
    if (!user || !domain) return e;
    const u = user.length <= 2 ? user[0] + '*' : user[0] + '*'.repeat(user.length - 2) + user.slice(-1);
    return `${u}@${domain}`;
  };

  function setBusy(el, busy) {
    if (!el) return;
    el.disabled = !!busy;
    el.classList.toggle('is-loading', !!busy);
  }

  // Etapa 1 — solicitar código
  emailForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = emailInput.value.trim().toLowerCase();
    if (!email) return;

    setBusy(btnSend, true);
    emailMsg.textContent = 'Enviando código…';

    try {
      const r = await fetch('/api/auth/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const data = await r.json();
      if (!r.ok || !data?.ok) {
        throw new Error(data?.error || 'Falha ao enviar o código.');
      }

      // mostra próxima etapa
      emailMask.textContent = maskEmail(email);
      stepEmail.style.display = 'none';
      stepCode.style.display  = '';

      // em dev o back pode retornar demoCode – exibimos para agilizar testes
      if (data.demoCode) {
        displayCodeEl.style.display = '';
        displayCodeEl.textContent = `Código de teste: ${data.demoCode}`;
      } else {
        displayCodeEl.style.display = 'none';
        displayCodeEl.textContent = '';
      }

      codeMsg.textContent = 'Código enviado. Confira sua caixa de entrada.';
      codeInput.focus();
    } catch (err) {
      emailMsg.textContent = err.message || 'Não foi possível enviar o código.';
    } finally {
      setBusy(btnSend, false);
    }
  });

  // Reenvio
  btnResend.addEventListener('click', () => {
    // simplesmente volta para a etapa de e-mail com o campo preenchido
    stepCode.style.display  = 'none';
    stepEmail.style.display = '';
    emailMsg.textContent = '';
    displayCodeEl.style.display = 'none';
    displayCodeEl.textContent = '';
    emailInput.focus();
  });

  // Etapa 2 — verificar código
  codeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = emailInput.value.trim().toLowerCase();
    const code  = codeInput.value.trim();

    if (!email || !code) return;

    setBusy(btnVerify, true);
    codeMsg.textContent = 'Verificando…';

    try {
      const r = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });

      const data = await r.json();
      if (!r.ok || !data?.ok || !data?.user) {
        throw new Error(data?.error || 'Código inválido.');
      }

      // guarda o usuário e redireciona
     // localStorage.setItem('user', JSON.stringify(data.user));
    //  if (typeof updateUserNav === 'function') updateUserNav();

    // guarda o usuário e redireciona
try {
  const oldUser = JSON.parse(localStorage.getItem('user') || '{}');
  // mescla: mantém telefone/nome que já estavam no localStorage
  const merged  = Object.assign({}, oldUser, data.user);
  localStorage.setItem('user', JSON.stringify(merged));
} catch (_) {
  // se der erro no parse, salva o que veio da API mesmo
  localStorage.setItem('user', JSON.stringify(data.user));
}

if (typeof updateUserNav === 'function') updateUserNav();



      

      const redirect = localStorage.getItem('postLoginRedirect');
      if (redirect) {
        localStorage.removeItem('postLoginRedirect');
        window.location.href = redirect;
      } else {
        window.location.href = 'index.html'; // ou profile.html se preferir
      }
    } catch (err) {
      codeMsg.textContent = err.message || 'Não foi possível validar o código.';
      codeInput.select();
      codeInput.focus();
    } finally {
      setBusy(btnVerify, false);
    }
  });
});
