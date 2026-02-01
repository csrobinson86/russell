require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Store debate history in memory for now
const debates = {};

// Start a new debate
app.post('/debate/start', async (req, res) => {
    try {
        const { topic, opponent } = req.body;
        const debateId = Date.now().toString();

        // Load system prompts
        const jwPrompt = require('./prompts/jw-debater');
        const opponentPrompt = require(`./prompts/${opponent}`);

        // Generate opening statements from both sides
        const [jwOpening, opponentOpening] = await Promise.all([
            generateJWResponse(jwPrompt(topic), `You are opening a debate on: ${topic}. Give your opening statement.`),
            generateOpponentResponse(opponentPrompt(topic), `You are opening a debate on: ${topic}. Give your opening statement.`)
        ]);

        // Store debate state
        debates[debateId] = {
            topic,
            opponent,
            rounds: [{ jw: jwOpening.text, opponent: opponentOpening }],
            jwPrompt: jwPrompt(topic),
            opponentPrompt: opponentPrompt(topic)
        };

        res.render('partials/debate-start', {
            debateId,
            topic,
            jwOpening: jwOpening.text,
            jwCitations: jwOpening.citations,
            opponentOpening,
            opponentLabel: opponent.charAt(0).toUpperCase() + opponent.slice(1)
        });
    } catch (error) {
        console.error('Error starting debate:', error);
        res.status(500).send('<p class="text-red-500">Something went wrong starting the debate. Please try again.</p>');
    }
});

// Generate next round
app.post('/debate/next-round', async (req, res) => {
    try {
        const { debateId } = req.body;
        const debate = debates[debateId];

        if (!debate) {
            return res.status(404).send('<p>Debate not found.</p>');
        }

        // Build conversation history for context
        const history = debate.rounds.map(round =>
            `JW: ${round.jw}\nOpponent: ${round.opponent}`
        ).join('\n\n');

        const roundNumber = debate.rounds.length + 1;

        // JW responds using web search on jw.org
        const jwResult = await generateJWResponse(
            debate.jwPrompt,
            `This is round ${roundNumber}. Here is the debate so far:\n\n${history}\n\nRespond to your opponent's last argument.`
        );

        // Opponent responds to JW's new argument
        const opponentResponse = await generateOpponentResponse(
            debate.opponentPrompt,
            `This is round ${roundNumber}. Here is the debate so far:\n\n${history}\n\nJW's latest argument: ${jwResult.text}\n\nRespond to their argument.`
        );

        // Store the new round
        debate.rounds.push({ jw: jwResult.text, opponent: opponentResponse });

        res.render('partials/debate-round', {
            debateId,
            roundNumber,
            jwResponse: jwResult.text,
            jwCitations: jwResult.citations,
            opponentResponse,
            opponentLabel: debate.opponent.charAt(0).toUpperCase() + debate.opponent.slice(1)
        });
    } catch (error) {
        console.error('Error generating round:', error);
        res.status(500).send('<p class="text-red-500">Something went wrong generating the next round. Please try again.</p>');
    }
});

// JW debater - uses Responses API with web search locked to jw.org
async function generateJWResponse(systemPrompt, userMessage) {
    const response = await client.responses.create({
        model: 'gpt-4o',
        instructions: systemPrompt,
        tools: [
            {
                type: 'web_search',
                search_context_size: 'medium',
                filters: {
                    allowed_domains: ['jw.org', 'wol.jw.org']
                }
            }
        ],
        tool_choice: 'auto',
        input: userMessage
    });

    // Extract and deduplicate citations from the response
    const citations = response.output
        .filter(item => item.type === 'message')
        .flatMap(item => item.content)
        .flatMap(content => content.annotations ?? [])
        .filter(annotation => annotation.type === 'url_citation')
        .map(({ url, title }) => ({ url, title }));

    const uniqueCitations = [...new Map(citations.map(c => [c.url, c])).values()];

    return { text: response.output_text, citations: uniqueCitations };
}

// Opponent debater - standard response, no web search needed
async function generateOpponentResponse(systemPrompt, userMessage) {
    const response = await client.responses.create({
        model: 'gpt-4o',
        instructions: systemPrompt,
        input: userMessage
    });

    return response.output_text;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Debate app running at http://localhost:${PORT}`);
});