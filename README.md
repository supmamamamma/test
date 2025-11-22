# OpenAI 风格生图代理：转发到 Google Vertex Gemini

这个 Node.js 服务提供一个 **OpenAI 风格的 `/v1/chat/completions` 生图接口**，底层统一调用 Google Vertex 的 `gemini-3-pro-image-preview` 模型。

- 对外：只暴露一个生图模型名系列，通过 **model 名后缀 2k/4k 控制分辨率**
- 内部：始终请求 Vertex 的 `gemini-3-pro-image-preview`，并在 `generationConfig.imageConfig.imageSize` 里用 `"2K"` / `"4K"` 控制分辨率
- 支持在 messages 里垫多图（data URL base64）

---

## 模型约定（对外）

`model` 字段只能是以下几种写法：

- `gemini-3-pro-image-preview` → 默认按 **2K** 处理
- `gemini-3-pro-image-preview-2k` → 2K
- `gemini-3-pro-image-preview-4k` → 4K

其它任何 `model` 值都会返回 400 错误：

```json
{
  "error": {
    "message": "unsupported model, only gemini-3-pro-image-preview[-2k|-4k] is allowed",
    "type": "vertex_api_error"
  }
}
```

---

## 环境变量

在项目根目录下创建 `.env`（或通过系统环境变量注入）：

```env
VERTEX_PROJECT_ID=your-gcp-project-id
VERTEX_LOCATION=global
VERTEX_PUBLISHER=google
VERTEX_API_KEY=your-vertex-api-key

PROXY_PORT=3000
PROXY_API_KEY=your-proxy-api-key
```

- `VERTEX_PROJECT_ID`：GCP 项目 ID（必填）
- `VERTEX_LOCATION`：Vertex 地区，一般为 `global`
- `VERTEX_PUBLISHER`：一般为 `google`
- `VERTEX_API_KEY`：Vertex API Key（必填）
- `PROXY_PORT`：本代理服务监听端口（默认 `3000`）
- `PROXY_API_KEY`：本代理对外暴露的 API Key（必填，所有请求必须带上）

---

## 启动

```bash
npm install
node index.js   # 或 npm start（如果你自己在 package.json 里配好了）
```

服务启动后会在日志里打印：

```text
Proxy server running on port 3000
External models: gemini-3-pro-image-preview[-2k|-4k] (all mapped to Vertex gemini-3-pro-image-preview)
```

---

## 接口：POST /v1/chat/completions

### 功能

- 对外路径：`POST /v1/chat/completions`
- 实际用途：**生图**（同时可以垫多图、多轮上下文）
- 对外模型名：
  - `gemini-3-pro-image-preview`
  - `gemini-3-pro-image-preview-2k`
  - `gemini-3-pro-image-preview-4k`
- 对外请求结构：兼容 OpenAI chat.completions 风格：
  - `model`: 上述三种之一
  - `messages`: OpenAI Chat Messages 格式
    - `role`: `"user" | "assistant" | "system"`
    - `content`:
      - 字符串（纯文本）
      - 或数组：`[{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:image/...;base64,..." } }, ...]`
- 对外响应结构：**images/generations 风格**：

  ```json
  {
    "created": 1234567890,
    "data": [
      {
        "b64_json": "BASE64..."
      }
    ]
  }
  ```

### 基础生图示例（2K）

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-pro-image-preview-2k",
    "messages": [
      { "role": "user", "content": "生成一只可爱的猫猫" }
    ]
  }'
```

- 这里：
  - 对外 model 为 `gemini-3-pro-image-preview-2k`
  - 代理内部调用：
    - Vertex URL: `.../models/gemini-3-pro-image-preview:streamGenerateContent?key=...`
    - body 里 `generationConfig.imageConfig.imageSize` 为 `"2K"`

### 4K 生图示例

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-pro-image-preview-4k",
    "messages": [
      { "role": "user", "content": "生成一只4K高清可爱的猫猫" }
    ]
  }'
```

- 对外 model：`gemini-3-pro-image-preview-4k`
- 内部仍然只打 `gemini-3-pro-image-preview`，但 `imageSize` 为 `"4K"`

### 多图垫图生图示例

你可以在 `messages` 里传入多张 base64 图作为垫图，使用 OpenAI 官方多模态格式：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-pro-image-preview-2k",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "参考这几张图生成一只风格类似的猫猫" },
          {
            "type": "image_url",
            "image_url": { "url": "data:image/png;base64,AAA..." }
          },
          {
            "type": "image_url",
            "image_url": { "url": "data:image/jpeg;base64,BBB..." }
          }
        ]
      }
    ]
  }'
```

- 服务会：
  - 解析 `data:image/...;base64,...`，提取出 mimeType 和 base64 部分；
  - 将每张图映射成 Vertex 的 `inlineData`：
    ```json
    {
      "inlineData": {
        "mimeType": "image/png",
        "data": "AAA..."
      }
    }
    ```
  - 作为 `contents[].parts` 中的多图上下文传给 `gemini-3-pro-image-preview`。

---

## 安全校验

所有请求必须携带正确的代理 API Key：

- Header: `Authorization: Bearer ${PROXY_API_KEY}`

否则会返回：

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error"
  }
}
```

---

## 错误示例

### 不带 model

```json
{
  "error": {
    "message": "model is required, e.g. \"gemini-3-pro-image-preview-2k\"",
    "type": "vertex_api_error"
  }
}
```

### 非法 model

```json
{
  "error": {
    "message": "unsupported model, only gemini-3-pro-image-preview[-2k|-4k] is allowed",
    "type": "vertex_api_error"
  }
}
```

### Vertex 调用失败

如果 Vertex 返回 4xx/5xx 或 body 无法解析，会返回 500：

```json
{
  "error": {
    "message": "Vertex API error: 500 ...",
    "type": "vertex_api_error"
  }
}
```

---

## 实现位置

核心逻辑都在 `index.js` 中，包括：

- 环境变量加载与校验
- model 名后缀 2k/4k → `imageSize: "2K"/"4K"` 映射
- OpenAI Chat 格式 messages → Vertex `contents` / `inlineData` 转换
- Vertex `streamGenerateContent` 的调用与聚合
- 返回 OpenAI images/generations 风格响应

你可以直接改 `index.js` 继续加别的端点（例如真正的 chat 文本接口、`/v1/models` 等），当前这版已经按你要求完成「只暴露一个生图模型 `gemini-3-pro-image-preview`，通过 model 名里的 2k/4k 控制分辨率，内部统一打 Vertex 一个模型」的逻辑。