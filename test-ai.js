require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const AI_PROVIDER = process.env.AI_PROVIDER || 'anthropic';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let aiClient;
if (AI_PROVIDER === 'openai') {
    if (!OPENAI_API_KEY) {
        console.error('FATAL ERROR: AI_PROVIDER is set to "openai" but OPENAI_API_KEY is not set.');
        process.exit(1);
    }
    aiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
    if (!ANTHROPIC_API_KEY) {
        console.error('FATAL ERROR: AI_PROVIDER is set to "anthropic" but ANTHROPIC_API_KEY is not set.');
        process.exit(1);
    }
    aiClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

const SYSTEM_PROMPT = `You are a friendly dental receptionist. Help patients book appointments.

Available slots:
- Monday 18th Nov: 9am, 10am, 11am, 2pm, 3pm
- Tuesday 19th Nov: 9am, 10am, 11am, 2pm, 3pm

When booking, confirm:
1. Patient name
2. Phone number
3. Date and time
4. Reason for visit

Be friendly and professional. When responding, provide your answer in a JSON object.`;

async function testAi() {
    console.log(`🦷 Testing AI Receptionist with ${AI_PROVIDER}...\n`);

    try {
        const testMessage = "Hi, I'd like to book an appointment for next Monday at 10am please";

        console.log('Patient says:', testMessage);
        console.log(`\nCalling ${AI_PROVIDER} API...\n`);

        let response;
        if (AI_PROVIDER === 'openai') {
            const completion = await aiClient.chat.completions.create({
                model: 'gpt-4-turbo-preview',
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: testMessage }
                ],
                response_format: { type: "json_object" },
            });
            response = completion.choices[0].message.content;
        } else {
            const message = await aiClient.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1000,
                system: SYSTEM_PROMPT,
                messages: [{
                    role: 'user',
                    content: testMessage
                }]
            });
            response = message.content[0].text;
        }

        console.log(`✅ ${AI_PROVIDER} Response:`);
        console.log('─'.repeat(60));
        console.log(response);
        console.log('─'.repeat(60));

        console.log(`\n✅ Test successful! ${AI_PROVIDER} is responding correctly.`);
        console.log('\nNext: Set up Twilio to handle phone calls.');

    } catch (error) {
        console.error('❌ Error:', error.message);

        if (error.message.includes('401')) {
            console.log(`\n💡 Tip: Check your ${AI_PROVIDER.toUpperCase()}_API_KEY is correct`);
        }
    }
}

// Run the test
testAi();
