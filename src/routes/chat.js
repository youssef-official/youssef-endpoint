/**
 * POST /v1/chat/completions
 * OpenAI-compatible endpoint with multi-provider fallback.
 * No authentication required — open proxy mode.
 */

import { callWithFallback } from '../providers.js';

export async function chatCompletions(req, res) {
  const requestId = `req_${Date.now()}`;

  try {
    const {
      messages: originalMessages,
      temperature,
      max_tokens,
      stream,
      model,
      tools,
    } = req.body;

    const messages = originalMessages || [];

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: { message: 'messages field is required and must be a non-empty array.', type: 'invalid_request_error' },
      });
    }

    console.log(`[${requestId}] POST /v1/chat/completions | model=${model || 'auto'} | stream=${!!stream} | msgs=${messages.length}`);

    // ── Streaming ────────────────────────────────────────────────────────────
    if (stream) {
      // Disable timeouts on this socket for long streaming sessions
      req.socket.setKeepAlive(true, 10_000);
      req.socket.setTimeout(0);
      res.setTimeout(0);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const result = await callWithFallback(messages, {
        temperature,
        max_tokens,
        stream: true,
        model,
        tools,
      });

      const reader = result.stream.getReader();
      const decoder = new TextDecoder();
      const targetModel = model || 'youssef-model';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          let chunk = decoder.decode(value, { stream: true });

          // Mask provider model name
          chunk = chunk.split(result.model).join(targetModel);
          res.write(chunk);
        }
      } catch (streamErr) {
        console.error(`[${requestId}] Stream read error:`, streamErr.message);
      } finally {
        res.end();
        console.log(`[${requestId}] ✓ Stream complete via ${result.providerName}`);
      }
      return;
    }

    // ── Non-streaming ─────────────────────────────────────────────────────────
    const result = await callWithFallback(messages, {
      temperature,
      max_tokens,
      stream: false,
      model,
      tools,
    });

    const { data, model: usedModel } = result;
    const targetModel = model || 'youssef-model';

    // Mask provider model name in response
    let finalResponse = JSON.parse(JSON.stringify(data));
    finalResponse.model = targetModel;

    // Clean provider-prefixed tool call names (e.g. "minimax:bash" → "bash")
    if (finalResponse.choices?.[0]?.message?.tool_calls) {
      finalResponse.choices[0].message.tool_calls = finalResponse.choices[0].message.tool_calls.map((tc) => {
        if (tc.function?.name) tc.function.name = tc.function.name.replace(/^[^:]+:/, '');
        return tc;
      });
    }

    console.log(`[${requestId}] ✓ Non-stream complete via ${result.providerName}`);
    res.json(finalResponse);

  } catch (err) {
    const errMsg = err?.message || JSON.stringify(err);
    console.error(`[${requestId}] Chat error:`, errMsg);
    res.status(502).json({
      error: { message: 'Service unavailable. All providers failed.', type: 'service_unavailable', details: errMsg },
    });
  }
}
