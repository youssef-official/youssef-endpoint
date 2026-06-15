/**
 * POST /claude/v1/messages
 * POST /claude/messages
 * POST /claude
 *
 * Anthropic Claude compatible endpoint.
 * Accepts Anthropic format, translates to OpenAI-compatible for providers,
 * and streams back in Anthropic SSE format.
 *
 * Fully optimized for Claude Code and other tool-heavy agents:
 * - Proper stream buffering to avoid JSON corruption on packet fragmentation.
 * - Heartbeat (ping) messages to keep connection active during thinking phases.
 * - Connection persistence and timeout disabling.
 * - No Supabase dependencies or rate limiting.
 */

import { callWithFallback } from '../providers.js';

export async function claudeCompletions(req, res) {
  const requestId = `claude_${Date.now()}`;
  
  // Disable timeouts and keep connection alive
  req.socket.setKeepAlive(true, 10_000);
  req.socket.setTimeout(0);
  res.setTimeout(0);

  try {
    const { messages, system, max_tokens, temperature, model, stream, tools } = req.body;

    const originalModel = model || 'claude-3-5-sonnet-20241022';
    console.log(`[${requestId}] Claude Request | model=${originalModel} | stream=${!!stream} | msgs=${messages?.length || 0} | tools=${tools?.length || 0}`);

    // ── 1. Format Translation (Anthropic to OpenAI compatible) ─────────────────
    const openaiMessages = [];
    if (system) {
      openaiMessages.push({ role: 'system', content: system });
    }

    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (!msg || !msg.role) continue;

        if (typeof msg.content === 'string') {
          openaiMessages.push({ role: msg.role, content: msg.content });
        } else if (Array.isArray(msg.content)) {
          const textParts = [];
          const toolUses = [];
          const toolResults = [];

          for (const block of msg.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              toolUses.push(block);
            } else if (block.type === 'tool_result') {
              toolResults.push(block);
            }
          }

          if (msg.role === 'assistant' && toolUses.length > 0) {
            openaiMessages.push({
              role: 'assistant',
              content: textParts.join('\n') || null,
              tool_calls: toolUses.map(tu => ({
                id: tu.id,
                type: 'function',
                function: {
                  name: tu.name,
                  arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {})
                }
              }))
            });
          } else if (msg.role === 'user' && toolResults.length > 0) {
            if (textParts.length > 0) {
              openaiMessages.push({ role: 'user', content: textParts.join('\n') });
            }
            for (const tr of toolResults) {
              openaiMessages.push({
                role: 'tool',
                tool_call_id: tr.tool_use_id,
                content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '')
              });
            }
          } else {
            openaiMessages.push({ role: msg.role, content: textParts.join('\n') || '' });
          }
        }
      }
    }

    // Convert Anthropic Tools to OpenAI format
    const openaiTools = Array.isArray(tools) && tools.length > 0 ? tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    })) : undefined;

    // ── 2. Streaming Mode ──────────────────────────────────────────────────────
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      // Start a heartbeat interval to keep the socket alive during long calls (e.g. while compiling/thinking)
      // SSE comments (lines starting with colon) are ignored by the client but keep the TCP connection warm.
      const heartbeatInterval = setInterval(() => {
        res.write(': ping\n\n');
      }, 15_000);

      let result;
      try {
        result = await callWithFallback(openaiMessages, {
          temperature,
          max_tokens: max_tokens || 8192,
          model: originalModel,
          stream: true,
          tools: openaiTools
        });
      } catch (err) {
        clearInterval(heartbeatInterval);
        throw err;
      }

      if (!result.stream) {
        clearInterval(heartbeatInterval);
        throw new Error('Streaming provider did not return a readable stream.');
      }

      const reader = result.stream.getReader();
      const decoder = new TextDecoder();
      
      let streamTokens = 0;
      let openBlocks = new Set();
      let lastStopReason = 'end_turn';
      const responseMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Send initial Claude message start event
      const startMsg = {
        type: 'message_start',
        message: {
          id: responseMessageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: originalModel
        }
      };
      res.write(`event: message_start\ndata: ${JSON.stringify(startMsg)}\n\n`);

      let streamBuffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          streamBuffer += decoder.decode(value, { stream: true });
          
          let newlineIndex = streamBuffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = streamBuffer.slice(0, newlineIndex).trim();
            streamBuffer = streamBuffer.slice(newlineIndex + 1);

            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') {
                newlineIndex = streamBuffer.indexOf('\n');
                continue;
              }

              try {
                const data = JSON.parse(dataStr);
                const choice = data.choices?.[0];
                const delta = choice?.delta;
                
                if (choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') {
                  lastStopReason = 'tool_use';
                }

                // Text Content delta
                if (delta?.content) {
                  // Ensure text block is initialized (index 0)
                  if (!openBlocks.has(0)) {
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: 0,
                      content_block: { type: 'text', text: '' }
                    })}\n\n`);
                    openBlocks.add(0);
                  }

                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: delta.content }
                  })}\n\n`);
                  streamTokens++;
                }

                // Tool Calls delta
                if (Array.isArray(delta?.tool_calls)) {
                  lastStopReason = 'tool_use';
                  for (const tc of delta.tool_calls) {
                    const tcIndex = (tc.index !== undefined ? tc.index : 0) + 1; // Tool indices start at 1

                    // Start the block if we haven't seen it yet
                    if (tc.function?.name && !openBlocks.has(tcIndex)) {
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: tcIndex,
                        content_block: {
                          type: 'tool_use',
                          id: tc.id || `tool_${Date.now()}`,
                          name: tc.function.name.replace(/^[^:]+:/, ''), // clean prefixes
                          input: {}
                        }
                      })}\n\n`);
                      openBlocks.add(tcIndex);
                    }

                    // Send the arguments delta
                    if (tc.function?.arguments) {
                      // Fallback: make sure the block is initialized
                      if (!openBlocks.has(tcIndex)) {
                        res.write(`event: content_block_start\ndata: ${JSON.stringify({
                          type: 'content_block_start',
                          index: tcIndex,
                          content_block: {
                            type: 'tool_use',
                            id: tc.id || `tool_${Date.now()}`,
                            name: 'tool',
                            input: {}
                          }
                        })}\n\n`);
                        openBlocks.add(tcIndex);
                      }

                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: tcIndex,
                        delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                      })}\n\n`);
                    }
                  }
                  streamTokens++;
                }
              } catch (parseErr) {
                // Ignore parse errors from malformed JSON in chunk parsing
              }
            }
            newlineIndex = streamBuffer.indexOf('\n');
          }
        }

        // Close any remaining open content blocks
        for (const idx of openBlocks) {
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`);
        }

        // Send message delta & final stop events
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: lastStopReason, stop_sequence: null },
          usage: { output_tokens: streamTokens }
        })}\n\n`);

        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);

      } catch (streamLoopErr) {
        console.error(`[${requestId}] Error during stream processing:`, streamLoopErr.message);
      } finally {
        clearInterval(heartbeatInterval);
        res.end();
        console.log(`[${requestId}] ✓ Stream finished via ${result.providerName}`);
      }
      return;
    }

    // ── 3. Non-streaming Mode ──────────────────────────────────────────────────
    const nonStreamResult = await callWithFallback(openaiMessages, {
      temperature,
      max_tokens: max_tokens || 8192,
      model: originalModel,
      stream: false,
      tools: openaiTools
    });

    const nsChoice = nonStreamResult.choices?.[0];
    const nsContentText = nsChoice?.message?.content || '';
    const nsToolCalls = nsChoice?.message?.tool_calls || [];

    const nsAnthropicContent = [];
    if (nsContentText) {
      nsAnthropicContent.push({ type: 'text', text: nsContentText });
    }

    for (const tc of nsToolCalls) {
      if (tc.function) {
        try {
          nsAnthropicContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name.replace(/^[^:]+:/, ''), // clean prefixes
            input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {})
          });
        } catch (e) {
          // If JSON parse fails, provide raw arguments as string/fallback
          nsAnthropicContent.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name.replace(/^[^:]+:/, ''),
            input: { raw: tc.function.arguments }
          });
        }
      }
    }

    console.log(`[${requestId}] ✓ Non-stream complete via ${nonStreamResult.providerName}`);
    
    res.json({
      id: nonStreamResult.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: nsAnthropicContent,
      model: originalModel,
      stop_reason: nsToolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: nonStreamResult.usage?.prompt_tokens || 0,
        output_tokens: nonStreamResult.usage?.completion_tokens || 0
      }
    });

  } catch (err) {
    const errMsg = err?.message || JSON.stringify(err);
    console.error(`[${requestId}] Claude endpoint error:`, errMsg);
    res.status(502).json({
      error: { message: 'Service unavailable.', type: 'service_unavailable', details: errMsg }
    });
  }
}
