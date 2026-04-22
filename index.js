//#region Whatsapp

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay, toNumber } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
require('dotenv').config(); // Adicionado para ler o arquivo .env
const { Groq } = require('groq-sdk'); // Adicionado o SDK do Groq

// Inicializa a conexão com o Groq usando a chave do .env
const groq = new Groq({
    apiKey: "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"
});

// =====================================================================
// 🧠 CAMPO DE TREINAMENTO DA IA (PROMPT DE SISTEMA)
// Edite este texto com todas as informações sobre a sua empresa!
// =====================================================================
const INFORMACOES_EMPRESA = `Você é o Argo's, o assistente virtual inteligente da Estácio Jacuecanga - Angra dos reis.
Sua missão é atender os clientes de forma educada, prestativa e natural, como um humano faria.

Aqui estão as informações da nossa empresa para você usar nas respostas:
- O que fazemos: [Ex: Vendemos roupas masculinas e femininas].
- Horário de Atendimento: [Ex: Segunda a Sexta, das 08h às 18h].
- Endereço: [Ex: Rua das Flores, 123, Centro].
- Preços/Catálogo: [Adicione aqui links ou faixas de preço].

Regras que você DEVE seguir:
1. Seja sempre amigável e use emojis de forma moderada.
2. Mantenha as respostas curtas e objetivas, ideais para o WhatsApp.
3. Nunca invente informações. Se o cliente perguntar algo que não está nas suas informações, diga que vai verificar ou transferir para um atendente humano.`;
// =====================================================================

async function Bot() {

    // 1. BUSCAR A VERSÃO ATUALIZADA (EVITA O ERRO 405)
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth/bot');

    //Criando socket
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        //gerando Qrcode
        if (qr) {
            console.clear(); 
            console.log(`==========================================\nAPONTE O WHATSAPP PARA O QR CODE\n==========================================`);
            qrcode.generate(qr, { small: true });
        }

        //Não houve conexão
        if (connection === 'close') {
            //Debug
            const erroCode = lastDisconnect?.error?.output?.statusCode;
            if (erroCode === 405) console.log("Erro 405 persistente. Tentando forçar nova versão...");
        
            //Reconexão
            const deveReconectar = erroCode !== DisconnectReason.loggedOut;
            if (deveReconectar) setTimeout(() => Bot(), 5000); 
        
        // Conectado
        } else if (connection === 'open') console.log('--- CONEXÃO ESTABELECIDA COM SUCESSO ---');
    });
    
    flow.sock = sock;
    sock.ev.on("messages.upsert", async m => {

        //filting
        if(m.type !== "notify") return;

        let _new = m.messages[0];
        if(!_new.message || _new.key.fromMe || _new.key.remoteJid?.endsWith("@g.us")) return;

        //user message
        await flow.core({
            Jid: _new.key.remoteJid,
            msg: _new.message?.conversation ||
                 _new.message?.extendedTextMessage?.text ||
                 _new.message?.imageMessage?.caption ||
                 _new.message?.videoMessage?.caption ||
                 _new.message?.documentMessage?.caption ||
                 _new.message?.buttonsResponseMessage?.selectedButtonId ||
                 _new.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
                 _new.message?.templateButtonReplyMessage?.selectedId ||
                "",
        });
    });
}; 

//#endregion

const flow = {

    //information
    sock: null,
    sess: {},
    version: "Argos Atendimento - Llama3 API: 0.1.0",

    //methods
    async core(_user) {

        if (!_user.msg) return; // Ignora mensagens sem texto

        //verificando se o usuario tem sessão salva
        if(!this.sess[_user.Jid]) {

            //adicionando usuario a base com histórico de chat vazio
            this.sess[_user.Jid] = { model: "argos", chat: [] };
        };

        const sessao = this.sess[_user.Jid];

        // 1. Adiciona a mensagem recebida ao histórico do cliente
        sessao.chat.push({ role: "user", content: _user.msg });

        // 2. Limita o histórico às últimas 15 mensagens para não sobrecarregar a memória da IA
        if (sessao.chat.length > 15) {
            sessao.chat.shift();
        }

        try {
            // Avisa o WhatsApp que o bot está "digitando..."
            await this.sock.sendPresenceUpdate("composing", _user.Jid);

            // 3. Monta o pacote de mensagens (Instruções da Empresa + Histórico de Conversa)
            const mensagensParaIA = [
                { role: "system", content: INFORMACOES_EMPRESA },
                ...sessao.chat
            ];

            // 4. Chama a API do Groq (Utilizando o Llama 3 - 8B, rápido e muito inteligente)
            const chatCompletion = await groq.chat.completions.create({
                messages: mensagensParaIA,
                model: "llama3-8b-8192", 
                temperature: 0.6, // Define a criatividade (0.0 a 1.0)
                max_tokens: 500,  // Tamanho máximo da resposta
            });

            // 5. Pega a resposta gerada
            const respostaIA = chatCompletion.choices[0]?.message?.content || "Desculpe, não consegui processar sua solicitação agora.";

            // 6. Adiciona a resposta da IA no histórico para ela lembrar do que falou
            sessao.chat.push({ role: "assistant", content: respostaIA });

            // 7. Envia a resposta final para o usuário no WhatsApp
            await this.send(_user.Jid, { text: respostaIA });

        } catch (error) {
            console.error("Erro ao chamar o Llama/Groq:", error);
            await this.send(_user.Jid, { text: "Opa, meu sistema de inteligência está passando por uma pequena instabilidade. Tente me mandar um 'Oi' novamente em instantes!" });
        }
    },

    async send(_jid, _msg = {}) {

        await this.sock.sendPresenceUpdate("composing", _jid);
        
        // Correção de segurança: garante que length exista para evitar erros (NaN)
        const textLength = _msg?.text?.length || _msg?.caption?.length || 50; 
        await new Promise(resolve => setTimeout(resolve, Math.min(10000, textLength * 10)));

        await this.sock.sendMessage(_jid, _msg);
        await this.sock.sendPresenceUpdate('paused', _jid);
    },
}

Bot();