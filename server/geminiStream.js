// Gemini Interactions SSE: https://ai.google.dev/gemini-api/docs/streaming
// Return the same payload shape as the non-streaming API, so callers keep one
// generation request and the existing image/MIME decoding path.
export async function readGeminiResponse(response) {
  if (!response.ok) return response.json().catch(() => ({}));
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    try { return await response.json(); }
    catch (cause) { if (cause instanceof SyntaxError) throw streamError('Google Gemini 返回了无法解析的生成响应。', 'GEMINI_STREAM_INVALID'); throw cause; }
  }
  if (!response.body) throw streamError('Google Gemini 未返回生成响应流。', 'GEMINI_STREAM_INCOMPLETE');
  const reader = response.body.getReader(), decoder = new TextDecoder(), images = new Map(), kinds = new Map();
  let lineParts = [], frameLines = [], completed = false, completePayload, bytes = 0;
  const consume = (frame) => {
    const lines = frame.split(/\r?\n/), data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { completed = true; return; }
    let event;
    try { event = JSON.parse(data); } catch { throw streamError('Google Gemini 返回了无法解析的生成响应。', 'GEMINI_STREAM_INVALID'); }
    const type = event.event_type || lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    if (type === 'error' || type === 'interaction.failed' || ['failed', 'cancelled'].includes(event.interaction?.status)) {
      throw Object.assign(new Error(event.error?.message || event.interaction?.error?.message || 'Google Gemini 生成任务失败。'), { status: 502, providerResponse: true });
    }
    if (type === 'step.start') {
      kinds.set(event.index, event.step?.type);
      if (event.step?.type === 'model_output') {
        for (const block of event.step.content || []) if (block.type === 'image' && block.data) images.set(event.index, { chunks: [block.data], mime_type: block.mime_type });
      }
    }
    if (type === 'step.delta' && event.delta?.type === 'image' && (!kinds.has(event.index) || kinds.get(event.index) === 'model_output')) {
      const image = images.get(event.index) || { chunks: [], mime_type: undefined };
      if (typeof event.delta.data === 'string') image.chunks.push(event.delta.data);
      if (event.delta.mime_type) image.mime_type = event.delta.mime_type;
      images.set(event.index, image);
    }
    if (type === 'interaction.completed') { completed = true; completePayload = event.interaction; }
  };
  const pushText = (text) => {
    // A 4K image can occupy one very long SSE line. Accumulate fragments and
    // join once, rather than repeatedly flattening/searching the full Base64.
    let offset = 0;
    while (!completed) {
      const end = text.indexOf('\n', offset);
      if (end < 0) { if (offset < text.length) lineParts.push(text.slice(offset)); return; }
      lineParts.push(text.slice(offset, end));
      const line = lineParts.join('').replace(/\r$/, ''); lineParts = []; offset = end + 1;
      if (line) frameLines.push(line);
      else { consume(frameLines.join('\n')); frameLines = []; }
    }
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) {
        pushText(decoder.decode());
        if (!completed) { if (lineParts.length) frameLines.push(lineParts.join('')); if (frameLines.length) consume(frameLines.join('\n')); }
        break;
      }
      bytes += value.byteLength;
      if (bytes > 96 * 1024 * 1024) throw streamError('Google Gemini 响应超过本机安全限制。', 'GEMINI_STREAM_LIMIT');
      pushText(decoder.decode(value, { stream: true }));
    }
    if (!completed) throw streamError('Google Gemini 图像响应在完成前中断。', 'GEMINI_STREAM_INCOMPLETE');
    if (completePayload?.output_image?.data || completePayload?.steps?.some((s) => s.type === 'model_output' && s.content?.some((c) => c.type === 'image' && c.data))) return completePayload;
    return { steps: [...images.values()].map((image) => ({ type: 'model_output', content: [{ type: 'image', data: image.chunks.join(''), mime_type: image.mime_type }] })) };
  } finally {
    try { await reader.cancel(); } catch { /* no request is retried after a disconnect */ }
    reader.releaseLock();
  }
}
function streamError(message, code) { return Object.assign(new Error(message), { code, status: 502 }); }
