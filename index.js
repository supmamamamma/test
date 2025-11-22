// OpenAI 兼容反代服务：将 /v1/chat/completions 转发到 Google Vertex Gemini
// 只做「生图」：对外用 model="gemini-3-pro-image-preview" 系列，在 model 名里通过 2k/4k 控制分辨率
// 例如：
//   model: "gemini-3-pro-image-preview"      -> 默认 2K
//   model: "gemini-3-pro-image-preview-2k"  -> 2K
//   model: "gemini-3-pro-image-preview-4k"  -> 4K
// 内部始终调用 Vertex 的 "gemini-3-pro-image-preview"，并在 generationConfig.imageConfig.imageSize 里用 "2K"/"4K"
//
// 环境变量：
//   VERTEX_PROJECT_ID: GCP 项目 ID
//   VERTEX_LOCATION: global
//   VERTEX_PUBLISHER: google
//   VERTEX_API_KEY: Vertex API Key
//   PROXY_PORT: 服务监听端口，默认 3000
//   PROXY_API_KEY: 对外 API Key，必填
//
// 运行：node index.js

const express = require('express');
const bodyParser = require('body-parser');

// 加载环境变量（假设有 .env 文件，或在运行前设置 env）
require('dotenv').config();

const VERTEX_PROJECT_ID = process.env.VERTEX_PROJECT_ID;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'global';
const VERTEX_PUBLISHER = process.env.VERTEX_PUBLISHER || 'google';
const VERTEX_API_KEY = process.env.VERTEX_API_KEY;
const PROXY_PORT = process.env.PROXY_PORT || 3000;
const PROXY_API_KEY = process.env.PROXY_API_KEY;

// 校验关键环境变量
if (!VERTEX_PROJECT_ID || !VERTEX_API_KEY || !PROXY_API_KEY) {
  console.error('Missing required env vars: VERTEX_PROJECT_ID, VERTEX_API_KEY, PROXY_API_KEY');
  process.exit(1);
}

// Vertex URL 前缀
const VERTEX_BASE_URL = `https://aiplatform.googleapis.com/v1beta1/projects/${VERTEX_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/${VERTEX_PUBLISHER}/models`;

// 工具函数：从 data URL 解析 mimeType 和 base64
function parseDataUrl(dataUrl) {
  // 例如：data:image/png;base64,AAA...
  const match = dataUrl.match(/^data:([a-zA-Z0-9\/+]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// 工具函数：根据 OpenAI 消息构建 Vertex parts
function buildVertexParts(content) {
  const parts = [];
  if (typeof content === 'string') {
    parts.push({ text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text' && item.text) {
        parts.push({ text: item.text });
      } else if (item.type === 'image_url' && item.image_url && item.image_url.url) {
        const parsed = parseDataUrl(item.image_url.url);
        if (parsed) {
          parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
        }
      }
    }
  }
  return parts;
}

// 工具函数：从 OpenAI messages 构建 Vertex contents（支持多轮、多图）
function buildVertexContentsFromMessages(messages) {
  const contents = [];
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    if (msg.role === 'system') {
      // 简化起见，当前忽略 system 消息；需要的话可以映射到 systemInstruction
      continue;
    }
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = buildVertexParts(msg.content);
    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }
  return contents;
}

// 工具函数：解析对外 model，确定分辨率
// 约定：对外 model 只能是：
//   - "gemini-3-pro-image-preview"       -> 默认 2K
//   - "gemini-3-pro-image-preview-2k"   -> 2K
//   - "gemini-3-pro-image-preview-4k"   -> 4K
// 内部始终调用 Vertex 的 "gemini-3-pro-image-preview"，仅通过 imageSize 控制 2K/4K
function parseImageModel(model) {
  if (!model) {
    throw new Error('model is required, e.g. "gemini-3-pro-image-preview-2k"');
  }
  const lower = String(model).toLowerCase();
  if (!lower.startsWith('gemini-3-pro-image-preview')) {
    throw new Error('unsupported model, only gemini-3-pro-image-preview[-2k|-4k] is allowed');
  }
  let size = '2K';
  if (lower.includes('4k')) {
    size = '4K';
  } else if (lower.includes('2k')) {
    size = '2K';
  }
  return { size };
}

// 工具函数：构建 Vertex 请求体（统一走生图模型 + 多图垫图）
// 对外：
//   - model 用 "gemini-3-pro-image-preview" 系列（可带 -2k / -4k 后缀控制分辨率）
//   - messages 用 OpenAI chat 格式，支持多轮、多图（image_url 为 data:image/...;base64,...）
// 内部：
//   - 始终调用 Vertex 的 gemini-3-pro-image-preview
//   - generationConfig.responseModalities=["TEXT","IMAGE"]，同时设置 imageSize
function buildVertexRequest(openaiBody, size) {
  const contents = buildVertexContentsFromMessages(openaiBody.messages || []);
  return {
    contents,
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { imageSize: size }
    }
  };
}

// 工具函数：调用 Vertex API（聚合 stream 为一次性响应）
async function callVertexApi(modelName, requestBody) {
  const url = `${VERTEX_BASE_URL}/${modelName}:streamGenerateContent?key=${VERTEX_API_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Vertex API error: ${response.status} ${errorText}`);
  }

  // 聚合所有 chunk
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullResponse = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullResponse += decoder.decode(value, { stream: true });
  }

  // Vertex streamGenerateContent 一般是一行一个 JSON，这里简单按行拆分，取最后一个有 candidates 的
  const chunks = fullResponse.split('\n').filter(line => line.trim());
  if (chunks.length === 0) {
    throw new Error('No response from Vertex');
  }

  let lastChunk = null;
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(chunks[i]);
      if (data.candidates && data.candidates[0]) {
        lastChunk = data;
        break;
      }
    } catch (e) {
      // 忽略无法解析的行
    }
  }

  if (!lastChunk) {
    throw new Error('Invalid Vertex response');
  }
  return lastChunk;
}

// 工具函数：将 Vertex 响应转换为 OpenAI 生图风格
// 这里统一返回 images/generations 风格：
// {
//   "created": 1234567890,
//   "data": [{ "b64_json": "BASE64..." }]
// }
function convertVertexToOpenai(vertexResponse) {
  const parts = vertexResponse.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(part => part.inlineData);
  const b64 = imagePart?.inlineData?.data || '';
  return {
    created: Math.floor(Date.now() / 1000),
    data: [{ b64_json: b64 }]
  };
}

// Express app
const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// 中间件：校验 API Key
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== PROXY_API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
  }
  next();
});

// 路由：POST /v1/chat/completions
// 对外：
//   - 只做生图：model="gemini-3-pro-image-preview" 或带 -2k / -4k 后缀
//   - messages 用 chat 格式传文案 + 垫图（多图用多个 image_url）
// 内部：
//   - 始终调用 Vertex 的 "gemini-3-pro-image-preview"
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const openaiBody = req.body || {};
    const { size } = parseImageModel(openaiBody.model);
    const vertexRequest = buildVertexRequest(openaiBody, size);
    const vertexResponse = await callVertexApi('gemini-3-pro-image-preview', vertexRequest);
    const openaiResponse = convertVertexToOpenai(vertexResponse);
    res.json(openaiResponse);
  } catch (error) {
    console.error('Error in /v1/chat/completions:', error);
    const message = error && error.message ? error.message : 'Unknown error';
    const status =
      message.startsWith('model is required') || message.startsWith('unsupported model')
        ? 400
        : 500;
    res.status(status).json({ error: { message, type: 'vertex_api_error' } });
  }
});

// 启动服务
app.listen(PROXY_PORT, () => {
  console.log(`Proxy server running on port ${PROXY_PORT}`);
  console.log('External models: gemini-3-pro-image-preview[-2k|-4k] (all mapped to Vertex gemini-3-pro-image-preview)');
});