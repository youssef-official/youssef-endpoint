import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { chatCompletions } from './routes/chat.js';
import { claudeCompletions } from './routes/claude.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'operational',
    service: 'Youssef Endpoint',
    version: '2.0.0',
    author: 'Youssef Elsayed',
    endpoints: {
      openai_compatible: '/v1/chat/completions',
      anthropic_compatible: ['/claude/v1/messages', '/claude/messages', '/claude'],
      health: '/',
    },
    providers: ['Xiaomi Mimo (mimo-v2.5)', 'Kimchi (minimax-m3)', 'NVIDIA (minimaxai/minimax-m3)', 'TokenLB Claude Sonnet'],
  });
});

// ─── OpenAI-compatible endpoint ───────────────────────────────────────────────
app.post('/v1/chat/completions', chatCompletions);

// ─── Anthropic-compatible endpoints ──────────────────────────────────────────
app.post('/claude/v1/messages', claudeCompletions);
app.post('/claude/messages', claudeCompletions);
app.post('/claude', claudeCompletions);

// ─── Start Server ─────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  const line   = '═'.repeat(54);
  const thin   = '─'.repeat(54);

  console.log(`\n  ╔${line}╗`);
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ║${'  ⚡  YOUSSEF ENDPOINT  ⚡'.padEnd(45)}         ║`);
  console.log(`  ║${'  Multi-Provider LLM Gateway  v2.0.0'.padEnd(54)}║`);
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ╠${thin}╣`);
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ║${'  Powered By  Youssef Elsayed'.padEnd(54)}║`);
  console.log(`  ║${'  🌐 facebook.com/youssefcore.eng'.padEnd(54)}║`);
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ╠${thin}╣`);
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ║  🟢 Status     : ONLINE`.padEnd(55) + ' ║');
  console.log(`  ║  🔌 Port       : ${PORT}`.padEnd(55) + ' ║');
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ║  📡 Endpoints:`.padEnd(55) + ' ║');
  console.log(`  ║    → OpenAI   : /v1/chat/completions`.padEnd(55) + ' ║');
  console.log(`  ║    → Anthropic: /claude/v1/messages`.padEnd(55) + ' ║');
  console.log(`  ║    → Health   : /`.padEnd(55) + ' ║');
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ╠${thin}╣`);
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ║  🔄 Providers (Fallback Chain):`.padEnd(55) + ' ║');
  console.log(`  ║    [0] Xiaomi  → mimo-v2.5 (2 keys)`.padEnd(55) + ' ║');
  console.log(`  ║    [1] Kimchi  → minimax-m3`.padEnd(55) + ' ║');
  console.log(`  ║    [2] NVIDIA  → minimax-m3`.padEnd(55) + ' ║');
  console.log(`  ║    [3] TokenLB → claude-sonnet-4-6`.padEnd(55) + ' ║');
  console.log(`  ║${''.padEnd(54)}║`);
  console.log(`  ╚${line}╝\n`);
});

// ─── Server Tuning for long-running Claude Code sessions ─────────────────────
server.timeout = 0;              // Disable server-level timeout
server.keepAliveTimeout = 120_000;   // 2 min keep-alive
server.headersTimeout = 125_000;     // slightly above keepAliveTimeout
