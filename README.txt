VEDGPT LOCAL AI — SETUP

This version does NOT use Gemini or Firebase AI Logic.

Files:
- index.html       VedGPT website
- ai-server.js     Your AI integration/server
- Modelfile        Creates your custom local "vedgpt" model
- README.txt       Setup instructions

Firebase is still used only for:
- Username/password accounts
- Saving conversations
- Cross-conversation memory

The AI itself runs locally through Ollama.

--------------------------------------------------
1. INSTALL OLLAMA
--------------------------------------------------

Install Ollama for Windows, macOS, or Linux.

After installation, make sure Ollama is running.

--------------------------------------------------
2. CREATE YOUR VEDGPT MODEL
--------------------------------------------------

Open Terminal, Command Prompt, or PowerShell in this folder.

Run:

ollama pull qwen3-coder:30b
ollama create vedgpt -f Modelfile

The default model is strong at coding and also handles normal questions and essays.

LOWER-MEMORY OPTION

If qwen3-coder:30b is too large for your computer, open Modelfile and change:

FROM qwen3-coder:30b

to:

FROM qwen2.5-coder:7b

Then run:

ollama pull qwen2.5-coder:7b
ollama create vedgpt -f Modelfile

The smaller model runs more easily but will not be as smart.

--------------------------------------------------
3. OPTIONAL IMAGE UNDERSTANDING
--------------------------------------------------

To let VedGPT understand uploaded images, install the vision model:

ollama pull qwen3-vl:8b

Without it, normal chat, coding, essays, memory, and file generation still work.

--------------------------------------------------
4. START VEDGPT
--------------------------------------------------

Run:

node ai-server.js

Then open:

http://localhost:3000

Do not open index.html by double-clicking it. The page must be opened through ai-server.js so it can reach the local AI endpoints.

--------------------------------------------------
5. FIREBASE LOCALHOST SETTING
--------------------------------------------------

In Firebase Console:

Authentication
→ Settings
→ Authorized domains

Make sure this is listed:

localhost

Google sign-in is not used. Email/Password sign-in must remain enabled.

--------------------------------------------------
CUSTOM MODEL OPTIONS
--------------------------------------------------

Default:
VEDGPT_MODEL=vedgpt

You can use a different installed Ollama model without changing the code.

Windows Command Prompt example:

set VEDGPT_MODEL=qwen3-coder:30b
node ai-server.js

PowerShell example:

$env:VEDGPT_MODEL="qwen3-coder:30b"
node ai-server.js

macOS/Linux example:

VEDGPT_MODEL=qwen3-coder:30b node ai-server.js

Image model setting:

VEDGPT_VISION_MODEL=qwen3-vl:8b

--------------------------------------------------
IMPORTANT
--------------------------------------------------

This creates your own customized, self-hosted VedGPT model and server, but it does not train a foundation model from zero. Training a model comparable to major commercial AI systems requires enormous datasets, specialized hardware, and extensive engineering.

The local model may still refuse some requests because of how its original weights were trained. The VedGPT prompt tells it to complete harmless requests directly, but this project does not intentionally remove safeguards for clearly harmful or illegal requests.

All AI requests have a maximum processing time of two minutes.
