require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Configuration - loaded from .env file ---
const AI_PROVIDER = process.env.AI_PROVIDER || 'anthropic'; // 'anthropic' or 'openai'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

// --- Startup checks for essential environment variables ---
if (AI_PROVIDER === 'anthropic' && !ANTHROPIC_API_KEY) {
  console.error('FATAL ERROR: AI_PROVIDER is set to "anthropic" but ANTHROPIC_API_KEY is not set.');
  process.exit(1);
}
if (AI_PROVIDER === 'openai' && !OPENAI_API_KEY) {
    console.error('FATAL ERROR: AI_PROVIDER is set to "openai" but OPENAI_API_KEY is not set.');
    process.exit(1);
}
if (!DASHBOARD_TOKEN) {
  console.error('FATAL ERROR: DASHBOARD_TOKEN is not set.');
  process.exit(1);
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('FATAL ERROR: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set.');
    process.exit(1);
}

// --- Initialize AI and Twilio Clients ---
let aiClient;
if (AI_PROVIDER === 'openai') {
    aiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
    console.log('Using OpenAI as AI provider.');
} else {
    aiClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    console.log('Using Anthropic (Claude) as AI provider.');
}
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- In-memory storage ---
let appointments = [];
let conversationHistory = {};
const CONVERSATION_TIMEOUT = 60 * 60 * 1000; // 1 hour in milliseconds

// --- Data for the AI ---
const availableSlots = {
  '2025-11-18': ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
  '2025-11-19': ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
  '2025-11-20': ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
  '2025-11-21': ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'],
  '2025-11-22': ['09:00', '10:00', '11:00', '14:00', '15:00']
};

const SYSTEM_PROMPT = `You are a friendly and professional dental receptionist AI assistant for a dental surgery. Your tasks are:

1. Answer calls warmly and professionally
2. Help patients book, reschedule, or cancel appointments
3. Answer common questions about the practice
4. For emergencies, let them know to visit A&E or call 999 if severe

Practice Information:
- Name: Bright Smile Dental Surgery
- Address: 123 High Street, London
- Hours: Monday-Friday 9am-6pm, Saturday 9am-1pm
- Emergency: Direct to NHS 111 or A&E for severe pain

Available appointment slots are provided to you. Always confirm:
- Patient name
- Phone number
- Preferred date and time
- Reason for visit (checkup, cleaning, pain, etc.)

Be concise, friendly, and efficient. If you need to book an appointment, ask for details and confirm everything clearly.

When responding, provide your answer in this JSON format:
{
  "response": "What you want to say to the patient",
  "action": "none|book_appointment|check_availability|transfer_to_staff",
  "appointment_details": {
    "name": "patient name",
    "phone": "phone number",
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "reason": "reason for visit"
  }
}`;

// --- Middleware ---
function authMiddleware(req, res, next) {
  const token = req.query.token;
  if (!token || token !== DASHBOARD_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

// --- AI Interaction Logic ---
async function getAiResponse(currentConversation) {
    const slotsInfo = JSON.stringify(availableSlots, null, 2);
    const bookedInfo = JSON.stringify(appointments, null, 2);
    const fullSystemPrompt = `${SYSTEM_PROMPT}\n\nCurrent available slots:\n${slotsInfo}\n\nCurrently booked appointments:\n${bookedInfo}`;

    if (AI_PROVIDER === 'openai') {
        const messagesForOpenAI = [
            { role: 'system', content: fullSystemPrompt },
            ...currentConversation
        ];

        const completion = await aiClient.chat.completions.create({
            model: 'gpt-4-turbo-preview',
            messages: messagesForOpenAI,
            response_format: { type: "json_object" },
        });
        return completion.choices[0].message.content;
    } else {
        const message = await aiClient.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            system: fullSystemPrompt,
            messages: currentConversation
        });
        return message.content[0].text;
    }
}

// --- Twilio Webhook Endpoints ---
app.post('/voice/welcome', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-GB' }, 'Hello, you have reached Bright Smile Dental Surgery. How may I help you today?');
  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process',
    speechTimeout: 'auto',
    language: 'en-GB'
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/process', async (req, res) => {
  const userSpeech = req.body.SpeechResult || '';
  const callSid = req.body.CallSid;
  console.log(`User said: ${userSpeech}`);

  try {
    // Manage conversation history
    if (!conversationHistory[callSid]) {
      conversationHistory[callSid] = { messages: [], lastActivity: Date.now() };
    } else {
      conversationHistory[callSid].lastActivity = Date.now();
    }
    conversationHistory[callSid].messages.push({ role: 'user', content: userSpeech });
    
    // Get AI response
    const aiResponse = await getAiResponse(conversationHistory[callSid].messages);
    console.log(`${AI_PROVIDER} response:`, aiResponse);
    
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(aiResponse);
    } catch (e) {
      parsedResponse = { response: aiResponse, action: 'none' };
    }

    // Handle actions
    if (parsedResponse.action === 'book_appointment' && parsedResponse.appointment_details) {
      appointments.push({ ...parsedResponse.appointment_details, callSid: callSid, bookedAt: new Date().toISOString() });
      console.log('Appointment booked:', parsedResponse.appointment_details);
    }
    
    // Update history and respond
    conversationHistory[callSid].messages.push({ role: 'assistant', content: aiResponse });
    
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-GB' }, parsedResponse.response);
    twiml.gather({
      input: 'speech',
      action: '/voice/process',
      speechTimeout: 'auto',
      language: 'en-GB'
    });
    
    res.type('text/xml');
    res.send(twiml.toString());
    
  } catch (error) {
    console.error(`Error processing with ${AI_PROVIDER}:`, error);
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Amy-Neural', language: 'en-GB' }, 'I apologize, I am having technical difficulties. Please call back later.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// --- Dashboard & API Endpoints ---
app.get('/appointments', authMiddleware, (req, res) => {
  res.json({ total: appointments.length, appointments: appointments });
});

app.get('/available-slots', (req, res) => {
  res.json(availableSlots);
});

app.get('/dashboard', authMiddleware, (req, res) => {
  res.sendFile(__dirname + '/dashboard.html');
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Dental AI Receptionist is active',
    ai_provider: AI_PROVIDER
  });
});

// --- Cleanup old conversations ---
setInterval(() => {
  const now = Date.now();
  for (const callSid in conversationHistory) {
    if (now - conversationHistory[callSid].lastActivity > CONVERSATION_TIMEOUT) {
      console.log(`Cleaning up stale conversation for CallSid: ${callSid}`);
      delete conversationHistory[callSid];
    }
  }
}, 5 * 60 * 1000);

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🦷 Dental AI Receptionist server running on port ${PORT}`);
});
