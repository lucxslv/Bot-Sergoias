require("dotenv").config();
const puppeteer = require("puppeteer-core");
const Groq = require("groq-sdk");

(async () => {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;

  const browser = await puppeteer.launch({
    executablePath: "/data/data/com.termux/files/usr/bin/chromium-browser",
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--single-process"
    ]
  });

  const page = await browser.newPage();

  await page.goto("https://portalnetescola.educacao.go.gov.br/login");
  console.log("Portal aberto");

  await page.waitForSelector('input[placeholder="Usuário"]');

  await page.type('input[placeholder="Usuário"]', "22120920127");
  await page.type('input[placeholder="Senha"]', "Dh4BTBA71TBH");

  await page.keyboard.press("Enter");
  console.log("Login enviado");

  await new Promise(r => setTimeout(r, 6000));

  console.log("Portal logado:", await page.url());

  // Abrir Ser Goiás
  const [newPage] = await Promise.all([
    new Promise(resolve => browser.once("targetcreated", target => resolve(target.page()))),
    page.evaluate(() => {
      const link = [...document.querySelectorAll("a")].find(a => a.href.toLowerCase().includes("sergoias"));
      if (link) link.click();
    })
  ]);

  const sagres = newPage;
  console.log("Sergoias aberto");

  await sagres.waitForFunction(() => !window.location.href.includes("/api/netescola/auth"), { timeout: 15000 }).catch(() => {});

  await new Promise(r => setTimeout(r, 6000));
  console.log("Dashboard:", await sagres.url());

  // Pegar desafios
  const plataformaLinks = await sagres.$$eval("a", els => els.map(el => ({
    text: el.innerText.trim(),
    href: el.href
  })));

  const desafios = plataformaLinks.filter(link => 
    link.href.includes("/challenges/") && link.href.includes("/execution")
  );

  console.log("DESAFIOS:", desafios);

  if (desafios.length === 0) {
    console.log("Nenhum desafio encontrado");
    await browser.close();
    return;
  }

  // Abre o primeiro (pode loopar depois pra todos)
  console.log("Abrindo desafio:", desafios[0].href);
  await sagres.goto(desafios[0].href);

  await new Promise(r => setTimeout(r, 6000));

  // Clicar "Avançar" inicial se tiver
  await sagres.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(b => (b.innerText || "").toLowerCase().includes("avançar"));
    if (btn) btn.click();
  });
  console.log("Cliquei em Avançar");

  await new Promise(r => setTimeout(r, 5000));

  // Clicar aba "Questões"
  await sagres.evaluate(() => {
    const aba = [...document.querySelectorAll("*")].find(el => 
      el.innerText && el.innerText.toLowerCase().includes("questões")
    );
    if (aba) aba.click();
  });
  console.log("Cliquei em Questões");

  await new Promise(r => setTimeout(r, 5000));

  // Pegar iframe
  await sagres.waitForSelector("iframe", { timeout: 20000 });
  const frameHandle = await sagres.$("iframe");
  const frame = await frameHandle.contentFrame();
  console.log("Iframe encontrado");

  await frame.waitForSelector("div, p, button", { timeout: 20000 });
  console.log("Atividade carregada");

  // LOOP DAS QUESTÕES COM IA
  for (let i = 0; i < 15; i++) {  // Aumentei pra cobrir mais
    console.log(`===== QUESTÃO ${i + 1} =====`);

    // Extrai pergunta (melhorado)
    const pergunta = await frame.evaluate(() => {
      const els = Array.from(document.querySelectorAll('p, div.h5p-question, .question-text, h3, strong'));
      for (const el of els) {
        const txt = el.innerText.trim();
        if (txt.length > 35 && !txt.match(/^[A-E]\)/i) && !txt.toLowerCase().includes('alternativa') && !txt.includes('Conteúdos')) {
          return txt;
        }
      }
      return "Pergunta não detectada";
    });

    console.log("PERGUNTA:", pergunta);

    // Extrai alternativas
    const alternativas = await frame.evaluate(() => {
      const ops = [];
      document.querySelectorAll('.h5p-alternative, label, div.option, li, span.radio').forEach(el => {
        const txt = el.innerText.trim();
        if (txt.match(/^[A-Ea-e][\).\s]/)) ops.push(txt);
      });
      return ops;
    });

    console.log("ALTERNATIVAS:", alternativas);

    let letraEscolhida = 'A';

if (Array.isArray(alternativas) && alternativas.length >= 2) {
  try {
    const prompt =
`Você é um aluno excelente respondendo prova escolar de Goiás.

Pergunta:
${pergunta}

Opções:
${alternativas.map((alt, i) => `${String.fromCharCode(65+i)}) ${alt}`).join("\n")}

Responda APENAS com uma única letra: A, B, C, D ou E.`;

    const completion = await groq.chat.completions.create({
  messages: [{ role: "user", content: prompt }],
  model: "llama-3.3-70b-versatile",
  temperature: 0,
  max_tokens: 5
});

    const respostaIA = completion.choices?.[0]?.message?.content?.trim() || '';
    const match = respostaIA.match(/\b[A-E]\b/i);

    if (match) {
      letraEscolhida = match[0].toUpperCase();
    }

    console.log(`IA escolheu: ${letraEscolhida}`);

  } catch (err) {
    console.error("Erro na Groq API:", err.message);
    console.log("Fallback: A");
  }
}

// Função que marca alternativa
async function marcarAlternativa(letra) {
  await frame.evaluate((letra) => {
    const opcoes = [...document.querySelectorAll('.h5p-alternative, label, div.option, input[type="radio"] ~ *, button')];

    const alvo = opcoes.find(el => {
      const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
      return txt.startsWith(letra.toLowerCase() + ')') ||
             txt.startsWith(letra.toLowerCase() + '.') ||
             txt.startsWith(letra.toLowerCase());
    });

    if (alvo) {
      alvo.click();
    } else {
      const primeiro = document.querySelector('input[type="radio"], .h5p-alternative');
      if (primeiro) primeiro.click();
    }
  }, letra);
}

await marcarAlternativa(letraEscolhida);
console.log(`Marcada alternativa ${letraEscolhida}`);

// Verificar resposta
await frame.evaluate(() => {
  const btns = ["verificar", "confirmar", "enviar", "check", "submit", "responder"];

  const btn = [...document.querySelectorAll("button")].find(b =>
  btns.some(t => (b.innerText || '').toLowerCase().includes(t))
);

if (btn) btn.click();
});

console.log("Resposta enviada");

await new Promise(r => setTimeout(r, 6000));


// Verifica segunda tentativa
const temTentarNovamente = await frame.evaluate(() => {
  const txts = ["tentar novamente", "refazer", "tente novamente", "retry", "outra vez"];

  return [...document.querySelectorAll("button")].some(b =>
    txts.some(t => (b.innerText || '').toLowerCase().includes(t))
  );
});


if (temTentarNovamente) {

  console.log("Errou - tentando uma segunda vez");

  await frame.evaluate(() => {
    const txts = ["tentar novamente", "refazer", "tente novamente"];

    const btn = [...document.querySelectorAll("button")].find(b =>
      txts.some(t => (b.innerText || '').toLowerCase().includes(t))
    );

    if (btn) btn.click();
  });

  await new Promise(r => setTimeout(r, 4000));

  // escolher outra alternativa diferente
  const letras = ['A','B','C','D','E'].filter(l => l !== letraEscolhida);
  const outraLetra = letras[Math.floor(Math.random() * letras.length)];

  await marcarAlternativa(outraLetra);

  console.log(`Segunda tentativa: ${outraLetra}`);

  await frame.evaluate(() => {
    const btns = ["verificar", "confirmar", "enviar", "check", "submit", "responder"];

    const btn = [...document.querySelectorAll("button")].find(b =>
      btns.some(t => (b.innerText || '').toLowerCase().includes(t))
    );

    if (btn) btn.click();
  });

  await new Promise(r => setTimeout(r, 5000));

}


// Avançar questão
const avancou = await sagres.evaluate(() => {

  const botoes = [...document.querySelectorAll("button.nui-button-primary")];

  if (botoes.length > 0) {
    const btn = botoes[botoes.length - 1];
    btn.click();
    return true;
  }

  return false;
});

if (!avancou) {
  console.log("Não encontrou botão de avançar — provavelmente fim da atividade");
  break;
}

console.log("Indo para próxima questão");

await new Promise(r => setTimeout(r, 7000));

} // fecha o for das questões

console.log("Script finalizado");

await browser.close();

})();
