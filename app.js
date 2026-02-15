const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const express = require('express');

const app = express();
const port = 3001;

app.get('/', (req, res) => {
    res.send('Sistema de automação Centrax rodando...');
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});

const AUTH_STATE_PATH = path.join(__dirname, 'auth_state.json');
const FETCH_URL = 'https://n8n-n8n-start.7rpoza.easypanel.host/webhook/proxima-linha';
const UPDATE_URL = 'https://n8n-n8n-start.7rpoza.easypanel.host/webhook/atualizar-status';

/**
 * Sleeps for a given number of milliseconds.
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetches the next line of data from the webhook.
 */
async function fetchNextLine() {
    console.log('--- Buscando próxima linha de dados no webhook ---');
    try {
        const response = await fetch(FETCH_URL);
        if (!response.ok) throw new Error(`Erro API Fetch: ${response.statusText}`);
        const data = await response.json();
        return (Array.isArray(data) && data.length > 0) ? data[0] : (data && data.rowIndex ? data : null);
    } catch (error) {
        console.error('Falha ao buscar dados:', error.message);
        return null;
    }
}

/**
 * Updates the status in the Google Sheet via webhook.
 */
async function updateStatus(rowIndex, status) {
    console.log(`--- Atualizando status: Linha ${rowIndex} -> ${status} ---`);
    try {
        const response = await fetch(UPDATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rowIndex, status })
        });
        if (!response.ok) console.error(`Erro ao atualizar status: ${response.statusText}`);
        else console.log('Status atualizado com sucesso no webhook.');
    } catch (error) {
        console.error('Falha ao enviar atualização de status:', error.message);
    }
}

/**
 * Main automation flow.
 */
async function run() {
    console.log('Iniciando sistema de automação contínua Centrax...');

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const storageStateExists = fs.existsSync(AUTH_STATE_PATH);
    const context = await browser.newContext({
        storageState: storageStateExists ? AUTH_STATE_PATH : undefined,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    while (true) {
        try {
            const rowData = await fetchNextLine();

            if (!rowData || (!rowData.rowIndex && !rowData.row_number)) {
                console.log('Nenhuma linha para processar. Aguardando 30 segundos...');
                await sleep(30000);
                continue;
            }

            // Prefer row_number as requested by user, fallback to rowIndex
            const rowIndex = rowData.row_number || rowData.rowIndex;

            // Extract and clean data
            const CPF = rowData['CPF'] ? String(rowData['CPF']).trim() : '';
            // USER REQUEST: Always use 'TELEFONE COM DDD + 9' instead of 'PHONE'
            const PHONE_RAW = rowData['TELEFONE COM DDD + 9'] || rowData['Telefone com Ddd + 9'];
            const PHONE = PHONE_RAW ? String(PHONE_RAW).trim() : '';
            const EMAIL = (rowData['E-mail'] || rowData.EMAIL) ? String(rowData['E-mail'] || rowData.EMAIL).trim() : '';
            const CEP = (rowData['Cep'] || rowData.CEP) ? String(rowData['Cep'] || rowData.CEP).trim() : '';

            console.log(`Processando Linha ${rowIndex}: CPF=${CPF}, Celular=${PHONE}`);

            // VALIDATION: Check for missing required fields
            if (!CPF || !PHONE || !EMAIL || !CEP) {
                console.warn(`Dados incompletos na linha ${rowIndex}. Faltando: ${!CPF ? 'CPF ' : ''}${!PHONE ? 'Telefone ' : ''}${!EMAIL ? 'Email ' : ''}${!CEP ? 'CEP' : ''}`);
                await updateStatus(rowIndex, "Dados Faltando");
                continue;
            }


            /**
             * Helper to log all visible text on the page for debugging.
             */
            async function logPageText(page, stepName) {
                console.log(`\n--- [DEBUG] Conteúdo da Tela: ${stepName} ---`);
                try {
                    await page.screenshot({ path: `debug_${stepName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.png` }); // NEW: Screenshot
                    const text = await page.evaluate(() => document.body.innerText);
                    // Clean up excessive whitespace for readability
                    const cleanText = text.split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0)
                        .join('\n');
                    console.log(cleanText);
                    console.log('---------------------------------------------------\n');
                } catch (e) {
                    console.error(`Erro ao capturar texto da tela em ${stepName}:`, e.message);
                }
            }

            // 1. Ensure Logged In
            console.log('Navegando para o sistema...');
            await page.goto('https://centrax.parcelex.com.br/pedidos', { waitUntil: 'networkidle', timeout: 60000 });
            await logPageText(page, 'Após Login/Navegação');

            if (page.url().includes('/auth/login')) {
                console.log('Sessão expirada. Relogando...');
                await page.fill('input[type="email"]', 'lucena.daniel646@gmail.com');
                await page.fill('input[type="password"]', '123456');
                await page.click('button[type="submit"]');
                await page.waitForNavigation({ waitUntil: 'networkidle' });
                await context.storageState({ path: AUTH_STATE_PATH });
                await logPageText(page, 'Após Relogin');
            }

            // 2. Dismiss Modal
            const modalButton = page.locator('text="Estou ciente"');
            if (await modalButton.count() > 0) {
                await modalButton.first().click();
                await page.waitForTimeout(1000);
            }

            // 3. Navigate to Analysis
            console.log('Acessando criação de link...');
            await page.click('a:has-text("Link de pagamento")');
            await page.waitForTimeout(2000);

            const criarBtn = page.locator('button:has-text("Criar link de pagamento")');
            if (await criarBtn.count() > 0) {
                await criarBtn.click();
                await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => { });
            } else {
                await page.goto('https://centrax.parcelex.com.br/link-de-pagamento/criar', { waitUntil: 'networkidle' });
            }
            await logPageText(page, 'Tela de Criação de Link');

            await page.waitForTimeout(3000);

            // 4. Reset Form (Click X if modal is open)
            console.log('Verificando se existe modal aberto para resetar...');
            try {
                // Selector for the "X" button, filtering for visible ones only
                const closeButton = page.locator('button:has(svg path[d="M5 5L15 15"])')
                    .or(page.locator('button:has(svg path[d="M15 5L5 15"])'))
                    .or(page.locator('button.md\\:absolute.md\\:right-5.md\\:top-5'))
                    .filter({ visible: true });

                if (await closeButton.count() > 0) {
                    console.log('Fechando modal anterior (v2)...');
                    await closeButton.first().click({ timeout: 3000 });
                    await page.waitForTimeout(1000);

                    // Check if "Descartar link" confirmation appeared
                    const descartarBtn = page.locator('button:has-text("Descartar link")');
                    if (await descartarBtn.isVisible()) {
                        console.log('Confirmando descarte de link...');
                        await descartarBtn.click();
                        await page.waitForTimeout(1000);
                    }


                    // NEW SEQUENCE: Wait 3s -> Go to URL -> Wait 3s
                    console.log('Aguardando 3 segundos antes de navegar...');
                    try {
                        await page.waitForTimeout(3000);
                        console.log('Navegando para criação limpa...');
                        await page.goto('https://centrax.parcelex.com.br/link-de-pagamento/criar', { waitUntil: 'load', timeout: 30000 });
                    } catch (navErr) {
                        console.error('Erro na navegação de reset:', navErr.message);
                    }

                    console.log('Aguardando 10 segundos para garantir carregamento...');
                    await page.waitForTimeout(10000);

                    // Fallback to "Criar link de pagamento" button if reset landed on dashboard
                    const resetCriarBtn = page.locator('button:has-text("Criar link de pagamento")');
                    if (await resetCriarBtn.isVisible()) {
                        console.log('Botão "Criar link de pagamento" visível após reset. Clicando...');
                        await resetCriarBtn.click();
                        await page.waitForTimeout(3000);
                    }

                    await logPageText(page, 'Após Reset e Retorno');

                } else {
                    // Also check for "Nova busca" button which sometimes appears
                    const novaBuscaBtn = page.locator('button:has-text("Nova busca")').filter({ visible: true });
                    if (await novaBuscaBtn.count() > 0) {
                        console.log('Clicando em Nova busca para resetar...');
                        await novaBuscaBtn.first().click({ timeout: 3000 });
                        await page.waitForTimeout(3000); // 3s wait
                    } else {
                        console.log('Nenhum modal ou botão de reset visível (Formulário deve estar limpo).');
                    }
                }
            } catch (err) {
                console.log('Aviso: Falha ao tentar resetar modal (provavelmente já fechado).');
            }

            // Wait 3s before searching CPF (as requested)
            await page.waitForTimeout(3000);

            // STRICT URL CHECK & RECOVERY: Ensure we are on the creation page before attempting to interact with the form
            // If we are on "/pedidos" (compras) or any other page, navigate via UI.
            const currentUrl = page.url();
            console.log(`URL Atual: ${currentUrl}`);

            if (!currentUrl.includes('/link-de-pagamento/criar')) {
                console.log(`Detectado URL incorreta. Navegando via Menu para Criação de Link...`);

                // 1. Click "Link de pagamento" (Sidebar/Menu) - This takes to the list
                const linkPagamentoMenu = page.locator('a:has-text("Link de pagamento")').first();
                if (await linkPagamentoMenu.isVisible()) {
                    console.log('Clicando no menu "Link de pagamento"...');
                    await linkPagamentoMenu.click();
                    await page.waitForTimeout(3000);
                }

                // 2. Click "Criar link de pagamento" (Button on the list page)
                const criarLinkBtn = page.locator('button:has-text("Criar link de pagamento")');
                if (await criarLinkBtn.isVisible()) {
                    console.log('Clicando em "Criar link de pagamento"...');
                    await criarLinkBtn.click();
                    await page.waitForTimeout(5000); // Wait for form load
                    await logPageText(page, 'Após Navegação via UI para Criação');
                } else {
                    console.warn('Botão "Criar link de pagamento" não encontrado após navegar pelo menu. Tentando URL direta como último recurso...');
                    await page.goto('https://centrax.parcelex.com.br/link-de-pagamento/criar', { waitUntil: 'load', timeout: 30000 });
                    await page.waitForTimeout(5000);
                }
            } else {
                console.log('Já estamos na URL correta de criação.');
            }

            // 5. Input CPF
            // Logic: Check if "Buscar CPF" is needed or if form is already filled/active.
            // Also explicitly check if we are STUCK ON DASHBOARD ("Criar link de pagamento" visible but not clicked yet)
            const buscarCpfBtn = page.locator('button:has-text("Buscar CPF")');
            const criarLinkBtnCheck = page.locator('button:has-text("Criar link de pagamento")');

            if (await buscarCpfBtn.isVisible()) {
                console.log('Botão "Buscar CPF" visível. Iniciando busca...');
                const cpfInput = page.locator('input[type="text"]').or(page.locator('input[placeholder=""]')).first();
                await cpfInput.fill(CPF);
                // Use force: true to bypass backdrop interception if it's still fading out
                await buscarCpfBtn.click({ force: true });
                await page.waitForTimeout(3000);
                await logPageText(page, 'Após Buscar CPF');
            } else if (await criarLinkBtnCheck.isVisible()) {
                console.log('Ainda estamos no Dashboard (Criar link visível). Clicando para ir ao formulário...');
                await criarLinkBtnCheck.click();
                await page.waitForTimeout(5000); // Wait for form to load

                // Now check again for "Buscar CPF" inside the form
                if (await buscarCpfBtn.isVisible()) {
                    console.log('Agora no formulário. Buscando CPF...');
                    const cpfInput = page.locator('input[type="text"]').or(page.locator('input[placeholder=""]')).first();
                    await cpfInput.fill(CPF);
                    await buscarCpfBtn.click({ force: true });
                } else {
                    console.log('Botão Buscar CPF ainda não apareceu. Assumindo formulário ativo.');
                }
                await logPageText(page, 'Após Recuperação do Dashboard');
            } else {
                console.log('Botão "Buscar CPF" e "Criar Link" não encontrados. Assumindo formulário já preenchido/ativo.');
                await logPageText(page, 'Formulário Inicial (Sem Busca)');
            }

            // 6. Check if search failed immediately (e.g. invalid CPF or already failed)
            const instantError = await page.evaluate(() => {
                const err = document.querySelector('.text-red-500, [role="alert"]');
                return err ? err.innerText : null;
            });

            if (instantError && instantError.toLowerCase().includes('não foi aprovado')) {
                await updateStatus(rowIndex, "Não");
                continue;
            }

            // 6. Fill Data
            console.log('Preenchendo formulário...');

            // Helper to safe fill
            const safeFill = async (locator, value, name) => {
                try {
                    if (await locator.count() > 0) {
                        if (await locator.first().isDisabled()) {
                            console.log(`Campo ${name} está desabilitado (já preenchido). Pulando...`);
                            return;
                        }
                        await locator.first().fill(value || '');
                    }
                } catch (e) {
                    console.log(`Aviso: Não foi possível preencher ${name} (pode estar preenchido). Erro: ${e.message.split('\n')[0]}`);
                }
            };

            const phoneInput = page.locator('input[type="tel"]').or(page.locator('label:has-text("Celular") + input')).or(page.locator('input[aria-describedby*="form-item"]')).nth(1);
            await safeFill(phoneInput, PHONE, 'Celular');

            const emailInput = page.locator('input[type="email"]').or(page.locator('label:has-text("Email") + input')).or(page.locator('input[aria-describedby*="form-item"]')).nth(2);
            await safeFill(emailInput, EMAIL, 'Email');

            const cepInput = page.locator('label:has-text("CEP") + input').or(page.locator('input[placeholder*="CEP"]')).or(page.locator('input[aria-describedby*="form-item"]')).last();
            await safeFill(cepInput, CEP, 'CEP');

            const termsCheckbox = page.locator('button[role="checkbox"]').or(page.locator('input[type="checkbox"]'));
            if (await termsCheckbox.count() > 0) {
                try {
                    const checkbox = termsCheckbox.first();
                    await checkbox.scrollIntoViewIfNeeded(); // Ensure visible
                    if (!(await checkbox.isChecked())) {
                        console.log('Marcando checkbox de termos...');
                        await checkbox.click({ force: true });
                        await page.waitForTimeout(500); // Wait for potential state update
                    } else {
                        console.log('Termos já aceitos.');
                    }
                } catch (e) {
                    console.log('Erro ao clicar checkbox:', e.message);
                }
            }

            // 7. Submit with Retry Logic
            console.log('Submetendo formulário...');
            const continuarBtn = page.locator('button:has-text("Continuar")').filter({ visible: true });

            for (let attempt = 1; attempt <= 3; attempt++) {
                if (await continuarBtn.count() > 0 && await continuarBtn.isEnabled()) {
                    console.log(`Tentativa ${attempt}: Clicando em "Continuar"...`);
                    await continuarBtn.first().click({ force: true });

                    try {
                        // Wait for navigation or change in UI - e.g. "Continuar" disappears or "Proposta" appears
                        // We use a short timeout race to detect success quickly
                        await Promise.race([
                            page.waitForSelector('text=Proposta', { timeout: 5000 }),
                            page.waitForSelector('text=Valor da proposta', { timeout: 5000 }),
                            page.waitForSelector('.text-red-500', { timeout: 5000 }),
                            page.waitForSelector('text=Editar link ativo', { timeout: 5000 }), // NEW: Check for this modal
                            page.waitForSelector('button:has-text("Editar link ativo")', { timeout: 5000 }),
                            page.waitForTimeout(3000) // Fallback wait
                        ]);
                    } catch (e) {
                        // Timeout expected if page just loads
                    }

                    // Check for "Editar link ativo" which might have appeared instantly
                    // Broad selector to catch button, link or span
                    const editarLinkSelector = page.locator('button:has-text("Editar link ativo")')
                        .or(page.locator('a:has-text("Editar link ativo")'))
                        .or(page.locator('span:has-text("Editar link ativo")'))
                        .or(page.locator('text=Editar link ativo'));

                    if (await editarLinkSelector.first().isVisible()) {
                        console.log('Detectado link ativo existente. Clicando em "Editar link ativo"...');
                        await page.screenshot({ path: `debug_antes_editar_link_${attempt}.png` });
                        await editarLinkSelector.first().click({ force: true });
                        await page.waitForTimeout(3000);
                        await logPageText(page, 'Após clicar em Editar Link Ativo');
                        break; // Break the retry loop as we have handled the "blocking" modal
                    } else if (await continuarBtn.isVisible()) {
                        // If "Continuar" is still there and no "Editar link ativo", retry
                        console.log('Botão "Continuar" ainda visível. Tentando novamente...');
                        await page.waitForTimeout(1000);
                    } else {
                        // "Continuar" disappeared and no "Editar link ativo" -> success (moved forward)
                        console.log('Botão "Continuar" desapareceu. Avançando...');
                        break;
                    }
                } else {
                    console.log('Botão "Continuar" não encontrado ou desabilitado.');
                    break;
                }
            }

            await logPageText(page, 'Após Submeter Formulário');

            // Double check for "Editar link ativo" interception just in case it appeared late
            try {
                const editarLinkSelector = 'text=Editar link ativo';
                const editarBtn = page.locator(editarLinkSelector);
                if (await editarBtn.isVisible()) {
                    console.log('Detectado link ativo existente (pós-loop). Clicando em "Editar link ativo"...');
                    await editarBtn.click();
                    await page.waitForTimeout(3000);
                    await logPageText(page, 'Após clicar em Editar Link Ativo (pós-loop)');
                }
            } catch (e) {
                // Ignore
            }

            // 8. Determine Outcome - New Logic
            console.log('Verificando resultado da análise...');

            // Wait a bit to ensure the page has loaded the proposal or error
            await page.waitForTimeout(2000);
            await logPageText(page, 'Resultado Final da Análise');

            const pageContent = await page.content();
            const hasProposta = pageContent.includes('Proposta') && pageContent.includes('Valor da proposta');
            const finalError = await page.evaluate(() => {
                const err = document.querySelector('.text-red-500, [role="alert"]');
                return err ? err.innerText : null;
            });

            let statusToUpdate = "";

            if (hasProposta) {
                console.log('Status: Pré aprovado (Proposta encontrada)');
                statusToUpdate = "Pré aprovado";

                // Handle the "X" -> "Salvar e sair" flow
                console.log('Fechando proposta para salvar...');

                // Reuse the close button selector logic
                const closeButton = page.locator('button:has(svg path[d="M5 5L15 15"])')
                    .or(page.locator('button:has(svg path[d="M15 5L5 15"])'))
                    .or(page.locator('button.md\\:absolute.md\\:right-5.md\\:top-5'))
                    .filter({ visible: true });

                if (await closeButton.count() > 0) {
                    await closeButton.first().click();

                    // Wait for the "Salvar e sair" modal
                    console.log('Aguardando modal de salvar...');
                    try {
                        const salvarSairBtn = page.locator('button:has-text("Salvar e sair")');
                        await salvarSairBtn.waitFor({ state: 'visible', timeout: 5000 });
                        await salvarSairBtn.click();
                        console.log('Clicou em "Salvar e sair".');
                        // Wait for navigation or modal close
                        await page.waitForTimeout(2000);
                    } catch (e) {
                        console.error('Erro ao tentar clicar em Salvar e sair:', e.message);
                    }
                } else {
                    console.warn('Botão de fechar não encontrado, mas status é pré-aprovado.');
                }

            } else if (finalError) {
                console.error(`Status: Erro - ${finalError}`);
                statusToUpdate = finalError.toLowerCase().includes('inválido') ? "Dados invalidos" : "Não";
            } else {
                // Fallback to URL check if text check failed but maybe URL changed? 
                // Although user said currently simple URL check fails. 
                // We will trust the loop to continue.
                console.log('Status: Não aprovado (sem proposta visível)');
                statusToUpdate = "Não";
            }

            await updateStatus(rowIndex, statusToUpdate);
            await page.screenshot({ path: `log_linha_${rowIndex}.png` });

        } catch (error) {
            console.error('Erro no ciclo do loop:', error.message);
            await page.screenshot({ path: 'loop_error.png' });
            await sleep(10000); // Retry after a delay on fatal cycle error
        }
    }
}

run().catch(err => console.error('Erro fatal no sistema:', err));
