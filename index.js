//#region Whatsapp & Integração API

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay, toNumber } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { Groq } = require('groq-sdk');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Inicialização do Servidor Express (Ponte para o Site)
const app = express();
app.use(express.json());
app.use(cors());
const PORT = process.env.PORT || 3000;

// Configuração Groq
const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY || "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"
});

// =====================================================================
// 🧠 CONFIGURAÇÃO DO ARGO'S (PROMPT DE SISTEMA)
// =====================================================================
const INFORMACOES_EMPRESA = `Você é o ARGO'S, o assistente virtual inteligente oficial.
Sua Unidade de atuação é: Angra dos Reis.

Sua missão é entender as dúvidas do cliente e responder com base nas informações do nosso sistema de gestão (gestaopro-five.vercel.app).
Seu tom de voz deve ser: Profissional, eficiente, tecnológico e direto.

Aqui estão as diretrizes:
- Nome: ARGO'S.
- Unidade: Angra dos Reis.
- Contexto: Você faz parte de um ecossistema de gestão para empresas e clientes.
- Regra de Ouro: Sempre que não souber algo específico sobre um pedido, direcione o cliente para o painel do site gestaopro-five.vercel.app.

Regras de Resposta:
1. Comece sempre de forma educada.
2. Mantenha respostas curtas.
3. Se o atendimento automático estiver desativado no sistema, você não deve responder (isso é controlado pelo servidor).`;

// Estado Global do Bot
let botConfig = {
    active: true, // Controlado pelo seu site via API
    sock: null,
    sessions: {}
};

async function startBot() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('auth/bot');

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    botConfig.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log(`==========================================\nESCANEIE O QR CODE NO CONSOLE OU VIA LINK\n==========================================`);
            qrcode.generate(qr, { small: true });
            const linkQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log(`Link do QR Code: ${linkQrCode}`);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(() => startBot(), 5000);
        } else if (connection === 'open') {
            console.log('--- ARGO\'S ONLINE E CONECTADO ---');
        }
    });

    // Ouvinte de Mensagens
    sock.ev.on("messages.upsert", async m => {
        if (m.type !== "notify") return;
        let msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;

        // VERIFICAÇÃO DE ATENDIMENTO AUTOMÁTICO (Botão no Site)
        if (!botConfig.active) {
            console.log("Atendimento automático do ARGO'S está desativado.");
            return;
        }

        const jid = msg.key.remoteJid;
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

        await processAIResponse(jid, text);
    });
}

// Lógica da Inteligência Artificial
async function processAIResponse(jid, text) {
    if (!text) return;

    if (!botConfig.sessions[jid]) {
        botConfig.sessions[jid] = { chat: [] };
    }

    const session = botConfig.sessions[jid];
    session.chat.push({ role: "user", content: text });

    if (session.chat.length > 10) session.chat.shift();

    try {
        await botConfig.sock.sendPresenceUpdate("composing", jid);

        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "system", content: INFORMACOES_EMPRESA }, ...session.chat],
            model: "llama-3.1-8b-instant",
            temperature: 0.5,
        });

        const reply = chatCompletion.choices[0]?.message?.content || "Estou processando sua solicitação.";
        session.chat.push({ role: "assistant", content: reply });

        await sendMessage(jid, { text: reply });

    } catch (error) {
        console.error("Erro Groq:", error);
    }
}

// Função Auxiliar de Envio (Com Delay Humano)
async function sendMessage(jid, content) {
    const delayTime = (content.text?.length || 50) * 10;
    await delay(Math.min(5000, delayTime));
    await botConfig.sock.sendMessage(jid, content);
}

// =====================================================================
// 🌉 PONTE API (ENDPOINT PARA O SEU SITE)
// =====================================================================

// 1. Rota para o site enviar mensagens manualmente (Botões do Site)
app.post('/api/send-message', async (req, res) => {
    const { number, message } = req.body;
    if (!number || !message) return res.status(400).json({ error: "Número e mensagem obrigatórios" });

    const jid = `${number.replace(/\D/g, '')}@s.whatsapp.net`;
    
    try {
        await botConfig.sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: "Mensagem enviada pelo ARGO'S" });
    } catch (err) {
        res.status(500).json({ error: "Erro ao enviar", details: err.message });
    }
});

// 2. Rota para Ativar/Desativar Atendimento Automático (Toggle no Site)
app.post('/api/toggle-bot', (req, res) => {
    const { status } = req.body; // true ou false
    botConfig.active = status;
    console.log(`Status do ARGO'S alterado para: ${status ? 'ATIVO' : 'INATIVO'}`);
    res.json({ success: true, active: botConfig.active });
});

// 3. Status do Bot
app.get('/api/status', (req, res) => {
    res.json({ 
        name: "ARGO'S", 
        unit: "Angra dos Reis", 
        active: botConfig.active, 
        connected: !!botConfig.sock?.user 
    });
});

app.listen(PORT, () => {
    console.log(`Servidor API Ponte rodando na porta ${PORT}`);
});

startBot();