import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { GoogleGenerativeAI } from '@google/genai';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Fixed Owner Phone Number
const FIXED_PHONE_NUMBER = "923268850925";

// Gemini & Groq Clients Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

// High-Ticket High-Converting Outreach AI Prompt
async function getAIResponse(clientMessage, businessCategory, location) {
  const promptText = `
You are an expert AI Sales Specialist for ZK-Tech Digital representing Zain Abbas.
Target Lead: ${businessCategory || 'Real Estate / E-commerce / Business without website'} located in ${location || 'USA/UK/UAE'}.
Client Said: "${clientMessage}".

Your Goal:
1. Pitch high-value Web Development, SaaS, or AI Agent Automation services.
2. Target high-budget clients (Budget Range: $500 - $5000+).
3. If they don't have a website or modern automation, persuade them politely and professionally.
4. Keep the response persuasive, high-converting, concise (under 3 sentences), and friendly.
`;

  try {
    const result = await geminiModel.generateContent(promptText);
    const text = result.response.text();
    if (text) return text;
  } catch (geminiError) {
    console.warn('⚠️ Gemini API failed, switching to Groq fallback...', geminiError.message);
  }

  try {
    if (!GROQ_API_KEY) throw new Error('Groq API Key not configured');
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: promptText }],
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Hello from ZK-Tech Digital! We help high-growth businesses build custom websites and AI agents ($500-$5000+ budget). How can we scale your business today?";
  } catch (err) {
    return "Hi! Thanks for reaching out to ZK-Tech Digital. We build high-converting websites & AI systems ($500-$5000+). Let's connect!";
  }
}

let sock;
let currentQrBase64 = null;
let currentPairingCode = null;
let connectionStatus = 'Disconnected';

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  // Stable socket configuration to prevent "Could Not Link Device" errors
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '121.0.0'],
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    retryRequestOptions: {
      maxRetries: 5
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionStatus = 'Waiting for Scan/Pairing';
      currentQrBase64 = await QRCode.toDataURL(qr);
    }
    if (connection === 'connecting') {
      connectionStatus = 'Authenticating...';
    }
    if (connection === 'open') {
      connectionStatus = 'Connected ✅';
      currentQrBase64 = null;
      currentPairingCode = null;
      console.log('✅ WhatsApp successfully connected!');
    }
    if (connection === 'close') {
      connectionStatus = 'Disconnected';
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️ Connection closed (${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    }
  });
}

startWhatsApp();

// Pairing Code Endpoint with fixed fallback
app.post('/api/whatsapp/pairing-code', async (req, res) => {
  try {
    let phoneNumber = req.body.phoneNumber || FIXED_PHONE_NUMBER;
    let cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.startsWith('0')) {
      cleanNum = '92' + cleanNum.slice(1);
    }

    if (sock && !sock.authState.creds.registered) {
      await new Promise(r => setTimeout(r, 1500));
      const code = await sock.requestPairingCode(cleanNum);
      const formattedCode = code ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
      currentPairingCode = formattedCode;
      return res.json({ success: true, pairingCode: formattedCode, phoneUsed: cleanNum });
    }
    res.status(400).json({ error: 'Device already registered or socket reconnecting. Clear session if re-linking.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qrCode: currentQrBase64,
    pairingCode: currentPairingCode,
    fixedPhone: FIXED_PHONE_NUMBER,
    isConnected: connectionStatus === 'Connected ✅'
  });
});

app.post('/api/whatsapp/send-ai-message', async (req, res) => {
  try {
    const { clientPhoneNumber, clientMessage, businessCategory, location } = req.body;
    const aiReply = await getAIResponse(clientMessage, businessCategory, location);

    let cleanNum = clientPhoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.startsWith('0')) cleanNum = '92' + cleanNum.slice(1);

    await sock.sendMessage(`${cleanNum}@s.whatsapp.net`, { text: aiReply });
    res.json({ success: true, aiReply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ZK-Tech Digital Server running on port ${PORT}`));
                                              
