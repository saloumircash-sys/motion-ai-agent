require('dotenv').config();
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const https = require('https');

const execAsync = util.promisify(exec);
const { kling } = require('./plugins-bridge');

if (!process.env.TELEGRAM_TOKEN || !process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Faltan variables de entorno: TELEGRAM_TOKEN y/o ANTHROPIC_API_KEY');
  process.exit(1);
}

const IS_WINDOWS = process.platform === 'win32';
const SHELL      = IS_WINDOWS ? 'powershell.exe' : 'bash';
const WORK_DIR   = process.env.WORK_DIR || (IS_WINDOWS ? 'C:\\Users\\M11' : '/app');
const VIDEOS_DIR = process.env.VIDEOS_DIR || (IS_WINDOWS ? 'C:\\Users\\M11\\youtube-project' : '/app/videos');

const bot       = new Telegraf(process.env.TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const OWNER_ID  = process.env.TELEGRAM_OWNER_ID?.trim() || null;
const EL_KEY    = process.env.ELEVENLABS_API_KEY || '';
const GH_TOKEN  = process.env.GITHUB_TOKEN || '';
const GH_OWNER  = process.env.GITHUB_OWNER || 'saloumircash-sys';

// ── YouTube channels config ────────────────────────────────────────────────────
const YT_CHANNELS = {
  EN: {
    name:       'Motivation Finance',
    lang:       'English',
    voice_id:   process.env.VOICE_EN || '',
    voice_name: 'Sophie',
    niche:      'personal finance, investing, wealth mindset',
    style:      'motivational, energetic, direct',
  },
  RO: {
    name:       'Motivatie Financiara cu George',
    lang:       'Romanian',
    voice_id:   process.env.VOICE_RO || 'JBFqnCBsd6RMkjVDRZzb',
    voice_name: 'George',
    niche:      'finante personale, investitii, mindset financiar',
    style:      'motivational, cald, direct',
  },
  ES: {
    name:       'Finanzas Sin Filtro',
    lang:       'Spanish',
    voice_id:   process.env.VOICE_ES || '',
    voice_name: 'Clara',
    niche:      'finanzas personales, inversiones, mentalidad de riqueza',
    style:      'directo, energético, sin rodeos',
  },
};

const conversations = new Map();

// ── System prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un asistente AI especializado en producción de contenido YouTube, gestión de proyectos y creación de bots.
Plataforma: ${IS_WINDOWS ? 'Windows (local)' : 'Linux (Railway)'}
Shell: ${IS_WINDOWS ? 'PowerShell' : 'bash'}
Directorio de trabajo: ${WORK_DIR}
Directorio de videos: ${VIDEOS_DIR}

═══ CANALES YOUTUBE ═══
• EN  │ "Motivation Finance"               │ ${YT_CHANNELS.EN.niche}
• RO  │ "Motivatie Financiara cu George"   │ ${YT_CHANNELS.RO.niche}
• ES  │ "Finanzas Sin Filtro"              │ ${YT_CHANNELS.ES.niche}

═══ FLUJO YOUTUBE COMPLETO (100% automático) ═══
1. generate_script  → crea guión estructurado
2. generate_voice   → convierte texto a MP3 con ElevenLabs
3. execute_command  → FFmpeg: combina imagen + audio → MP4
   Ejemplo: ffmpeg -loop 1 -i /app/videos/EN/bg.jpg -i /app/videos/EN/audio/voz.mp3 -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest /app/videos/EN/out.mp4
4. upload_youtube   → sube MP4 directamente a YouTube

═══ CAPACIDADES CLOUD ═══
• upload_youtube     → sube video MP4 a YouTube (requiere YOUTUBE_REFRESH_TOKEN)
• kling_image2video  → anima una imagen a video con Kling AI (requiere KLING_ACCESS_KEY/SECRET_KEY)
• github_create_repo → crea nuevo repo GitHub (requiere GITHUB_TOKEN)
• github_push_file   → sube/actualiza código en GitHub → Railway auto-deploya
• execute_command    → cualquier comando bash: ffmpeg, curl, git, npm, etc.

═══ PROYECTOS ACTIVOS ═══
- motion-ai-agent: https://github.com/${GH_OWNER}/motion-ai-agent
- rentnft-bot:     https://github.com/${GH_OWNER}/rentnft-bot

═══ PARA CREAR UN NUEVO BOT DISCORD ═══
1. github_create_repo → crea el repo vacío
2. github_push_file   → sube package.json, src/index.js, railway.json, .env.example
3. El usuario conecta el repo en Railway dashboard → auto-deploya

Reglas:
- Responde en el idioma del usuario
- Ejecuta directamente sin pedir confirmación innecesaria
- Para scripts YouTube, sigue el formato estructurado
- Muestra paths de archivos generados`;

// ── Herramientas ───────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'generate_script',
    description: 'Genera un guión completo y estructurado para un video de YouTube. Incluye hook, intro, cuerpo y CTA optimizados para el canal.',
    input_schema: {
      type: 'object',
      properties: {
        channel:  { type: 'string', enum: ['EN', 'RO', 'ES'], description: 'Canal de destino' },
        topic:    { type: 'string', description: 'Tema del video' },
        duration: { type: 'string', enum: ['short', 'medium', 'long'], description: 'short=1-3min, medium=5-8min, long=10-15min' },
        style:    { type: 'string', description: 'Estilo adicional o instrucciones especiales (opcional)' },
      },
      required: ['channel', 'topic'],
    },
  },
  {
    name: 'generate_voice',
    description: 'Convierte texto a audio MP3 usando ElevenLabs. Guarda el archivo en el directorio de videos y devuelve el path.',
    input_schema: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Texto a convertir en voz' },
        channel:  { type: 'string', enum: ['EN', 'RO', 'ES'], description: 'Canal (determina la voz)' },
        voice_id: { type: 'string', description: 'Voice ID de ElevenLabs (override del canal, opcional)' },
        filename: { type: 'string', description: 'Nombre del archivo sin extensión (opcional)' },
        model:    { type: 'string', description: 'Modelo ElevenLabs: eleven_multilingual_v2 (default) o eleven_turbo_v2_5' },
      },
      required: ['text', 'channel'],
    },
  },
  {
    name: 'upload_youtube',
    description: 'Sube un video MP4 a YouTube con título, descripción y tags. Requiere YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET y YOUTUBE_REFRESH_TOKEN configurados en Railway.',
    input_schema: {
      type: 'object',
      properties: {
        file_path:   { type: 'string', description: 'Ruta absoluta al archivo MP4' },
        title:       { type: 'string', description: 'Título del video (max 100 chars, optimizado para SEO)' },
        description: { type: 'string', description: 'Descripción del video' },
        tags:        { type: 'string', description: 'Tags separados por coma (max 500 chars total)' },
        category_id: { type: 'string', description: 'ID de categoría YouTube: 22=People&Blogs, 10=Music, 28=Science&Tech (default: 22)' },
        privacy:     { type: 'string', enum: ['public', 'private', 'unlisted'], description: 'Privacidad (default: public)' },
        thumbnail:   { type: 'string', description: 'Ruta a imagen JPG para thumbnail (opcional, max 2MB)' },
      },
      required: ['file_path', 'title'],
    },
  },
  {
    name: 'kling_image2video',
    description: 'Anima una imagen a video corto con Kling AI (image2video). Requiere KLING_ACCESS_KEY y KLING_SECRET_KEY configurados.',
    input_schema: {
      type: 'object',
      properties: {
        image_path:      { type: 'string', description: 'Ruta absoluta a la imagen de origen (jpg/png)' },
        prompt:          { type: 'string', description: 'Descripción del movimiento/escena deseada' },
        negative_prompt: { type: 'string', description: 'Qué evitar en el video (opcional)' },
        output_path:     { type: 'string', description: 'Ruta absoluta donde guardar el .mp4 resultante' },
        duration:        { type: 'string', enum: ['5', '10'], description: 'Duración del clip en segundos (default: 5)' },
        mode:            { type: 'string', enum: ['std', 'pro'], description: 'Calidad (default: std)' },
      },
      required: ['image_path', 'prompt', 'output_path'],
    },
  },
  {
    name: 'list_voices',
    description: 'Lista todas las voces disponibles en la cuenta de ElevenLabs con sus IDs.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filtrar por idioma o nombre (opcional)' },
      },
    },
  },
  {
    name: 'github_create_repo',
    description: 'Crea un nuevo repositorio en GitHub. Requiere GITHUB_TOKEN configurado. Útil para crear nuevos proyectos de bots, apps, etc.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Nombre del repo (sin espacios, usa guiones)' },
        description: { type: 'string', description: 'Descripción corta del repo' },
        private:     { type: 'boolean', description: 'true=privado, false=público (default: false)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'github_push_file',
    description: 'Crea o actualiza un archivo en un repo de GitHub via API. Después de subir archivos a GitHub, Railway auto-deploya si está conectado al repo.',
    input_schema: {
      type: 'object',
      properties: {
        repo:      { type: 'string', description: 'Nombre del repo (ej: mi-nuevo-bot)' },
        file_path: { type: 'string', description: 'Ruta del archivo en el repo (ej: src/index.js, package.json)' },
        content:   { type: 'string', description: 'Contenido completo del archivo' },
        message:   { type: 'string', description: 'Mensaje del commit (ej: "add initial bot code")' },
        owner:     { type: 'string', description: `Propietario del repo (default: ${GH_OWNER})` },
      },
      required: ['repo', 'file_path', 'content'],
    },
  },
  {
    name: 'execute_command',
    description: `Ejecuta un comando ${IS_WINDOWS ? 'PowerShell' : 'bash'}. Úsalo para ffmpeg, yt-dlp, git, npm, curl, etc.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Comando a ejecutar' },
        cwd:     { type: 'string', description: 'Directorio de trabajo (opcional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo.',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Crea o sobreescribe un archivo.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content:   { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edita un archivo reemplazando texto específico.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_text:  { type: 'string' },
        new_text:  { type: 'string' },
      },
      required: ['file_path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'list_directory',
    description: 'Lista archivos y carpetas de un directorio.',
    input_schema: {
      type: 'object',
      properties: { dir_path: { type: 'string' } },
      required: ['dir_path'],
    },
  },
];

// ── ElevenLabs helper ──────────────────────────────────────────────────────────
function elevenLabsRequest(method, endpoint, body = null, binary = false) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      path:     `/v1${endpoint}`,
      method,
      headers: {
        'xi-api-key':   EL_KEY,
        'Content-Type': 'application/json',
        'Accept':       binary ? 'audio/mpeg' : 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (binary) return resolve(buf);
        try { resolve(JSON.parse(buf.toString())); }
        catch { resolve(buf.toString()); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── GitHub API helper ──────────────────────────────────────────────────────────
function githubRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path:     apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'Motion-AI-Agent/1.0',
        'Content-Type':  'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── YouTube OAuth2 helpers ─────────────────────────────────────────────────────
async function getYouTubeAccessToken() {
  const body = JSON.stringify({
    client_id:     process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(json.error_description || `OAuth2 error: ${JSON.stringify(json)}`));
        } catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function initiateYouTubeUpload(accessToken, metadata, fileSize) {
  const body = JSON.stringify(metadata);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path:     '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      method:   'POST',
      headers:  {
        'Authorization':            `Bearer ${accessToken}`,
        'Content-Type':             'application/json; charset=UTF-8',
        'Content-Length':           Buffer.byteLength(body),
        'X-Upload-Content-Type':    'video/mp4',
        'X-Upload-Content-Length':  String(fileSize),
      },
    }, (res) => {
      if (res.statusCode === 200) resolve(res.headers.location);
      else {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => reject(new Error(`Upload init failed ${res.statusCode}: ${d}`)));
      }
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function uploadVideoChunked(uploadUri, filePath, fileSize) {
  const CHUNK = 50 * 1024 * 1024; // 50 MB chunks
  const url   = new URL(uploadUri);
  let offset  = 0;
  let videoId = null;

  while (offset < fileSize) {
    const end    = Math.min(offset + CHUNK, fileSize) - 1;
    const length = end - offset + 1;
    const buf    = Buffer.alloc(length);
    const fd     = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, length, offset);
    fs.closeSync(fd);

    videoId = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'PUT',
        headers:  {
          'Content-Length': String(length),
          'Content-Range':  `bytes ${offset}-${end}/${fileSize}`,
          'Content-Type':   'video/mp4',
        },
      }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 201) {
            try { resolve(JSON.parse(data).id); }
            catch { reject(new Error(`Parse error: ${data}`)); }
          } else if (res.statusCode === 308) {
            resolve(null); // incomplete, continue
          } else {
            reject(new Error(`Upload chunk failed ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(buf);
      req.end();
    });

    if (videoId) break;
    offset += length;
  }
  return videoId;
}

// ── Ejecución de herramientas ──────────────────────────────────────────────────
async function executeTool(name, input) {
  try {
    switch (name) {

      case 'generate_script': {
        const ch       = YT_CHANNELS[input.channel];
        const dur      = input.duration || 'medium';
        const durGuide = { short: '1-3 minutos (400-800 palabras)', medium: '5-8 minutos (1200-2000 palabras)', long: '10-15 minutos (2500-4000 palabras)' }[dur];
        const prompt   = `Eres un guionista experto para YouTube de ${ch.lang}.
Canal: "${ch.name}" | Nicho: ${ch.niche} | Estilo: ${ch.style}
Duración objetivo: ${durGuide}
${input.style ? `Instrucciones adicionales: ${input.style}` : ''}

Crea un guión COMPLETO para: "${input.topic}"

Formato obligatorio:
---
TÍTULO (SEO-optimizado, max 60 chars):
DESCRIPCIÓN (150 chars para YouTube):
TAGS (10 tags separados por coma):
---
[HOOK - 0 a 5 segundos]
(frase de impacto que detenga el scroll)

[INTRO - 5 a 30 segundos]
(presenta el problema o la promesa de valor)

[CUERPO PRINCIPAL]
(contenido estructurado con subtítulos si es necesario)

[CTA - Llamada a la acción]
(suscripción, like, comentario específico del tema)
---
Solo el guión, sin meta-comentarios.`;

        const resp     = await anthropic.messages.create({ model: MODEL, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
        const script   = resp.content[0].text;
        const filename = `script_${input.channel}_${Date.now()}.txt`;
        const filePath = path.join(VIDEOS_DIR, input.channel, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, script, 'utf8');
        return `✅ Guión guardado: ${filePath}\n\n${script}`;
      }

      case 'generate_voice': {
        if (!EL_KEY) return 'Error: ELEVENLABS_API_KEY no configurada';
        const ch      = YT_CHANNELS[input.channel];
        const voiceId = input.voice_id || ch.voice_id;
        if (!voiceId) return `Error: No hay voice_id para canal ${input.channel}. Configura VOICE_${input.channel} en las variables de entorno.`;

        const elModel     = input.model || 'eleven_multilingual_v2';
        const audioBuffer = await elevenLabsRequest(
          'POST', `/text-to-speech/${voiceId}`,
          { text: input.text, model_id: elModel, voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true } },
          true
        );

        if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 1000) {
          try { return `Error ElevenLabs: ${JSON.parse(audioBuffer.toString()).detail?.message}`; }
          catch { return `Error ElevenLabs: respuesta inválida (${audioBuffer.length} bytes)`; }
        }

        const filename = input.filename ? `${input.filename}.mp3` : `voice_${input.channel}_${Date.now()}.mp3`;
        const outDir   = path.join(VIDEOS_DIR, input.channel, 'audio');
        fs.mkdirSync(outDir, { recursive: true });
        const filePath = path.join(outDir, filename);
        fs.writeFileSync(filePath, audioBuffer);
        return `✅ Audio generado: ${filePath}\n📦 ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB | Voz: ${voiceId} | Modelo: ${elModel}`;
      }

      case 'upload_youtube': {
        const YT_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
        const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
        const YT_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

        if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) {
          return [
            '❌ YouTube no configurado. Necesitas estas variables en Railway:',
            '• YOUTUBE_CLIENT_ID',
            '• YOUTUBE_CLIENT_SECRET',
            '• YOUTUBE_REFRESH_TOKEN',
            '',
            'Pasos para obtenerlas:',
            '1. Ve a https://console.cloud.google.com',
            '2. Crea un proyecto → Habilita "YouTube Data API v3"',
            '3. Crea credenciales OAuth2 (tipo: Desktop App)',
            '4. Descarga el JSON y dime los valores de client_id y client_secret',
            '5. Yo te ayudo a obtener el refresh_token vía OAuth2 flow',
          ].join('\n');
        }

        if (!fs.existsSync(input.file_path)) return `❌ Archivo no encontrado: ${input.file_path}`;
        const fileSize = fs.statSync(input.file_path).size;
        const sizeMB   = (fileSize / 1024 / 1024).toFixed(1);

        const accessToken = await getYouTubeAccessToken();
        const metadata    = {
          snippet: {
            title:       input.title.substring(0, 100),
            description: input.description || '',
            tags:        input.tags ? input.tags.split(',').map(t => t.trim()).slice(0, 30) : [],
            categoryId:  input.category_id || '22',
          },
          status: { privacyStatus: input.privacy || 'public' },
        };

        const uploadUri = await initiateYouTubeUpload(accessToken, metadata, fileSize);
        const videoId   = await uploadVideoChunked(uploadUri, input.file_path, fileSize);

        if (!videoId) return '❌ Upload completado pero no se recibió video ID';

        // Thumbnail (opcional)
        if (input.thumbnail && fs.existsSync(input.thumbnail)) {
          try {
            const thumbBuf = fs.readFileSync(input.thumbnail);
            await new Promise((res, rej) => {
              const req = https.request({
                hostname: 'www.googleapis.com',
                path:     `/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
                method:   'POST',
                headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(thumbBuf.length) },
              }, (r) => r.on('data', () => {}).on('end', () => r.statusCode < 400 ? res() : rej(new Error(`Thumb error ${r.statusCode}`))));
              req.on('error', rej);
              req.write(thumbBuf);
              req.end();
            });
          } catch (e) { console.error('[YT] Thumbnail error:', e.message); }
        }

        return [
          `✅ Video subido exitosamente!`,
          `🎬 ID: ${videoId}`,
          `🔗 https://youtube.com/watch?v=${videoId}`,
          `📊 Título: ${input.title}`,
          `📦 Tamaño: ${sizeMB} MB`,
          `🔒 Privacidad: ${input.privacy || 'public'}`,
        ].join('\n');
      }

      case 'kling_image2video': {
        const r = await kling.image2video({
          imagePath: input.image_path,
          prompt: input.prompt,
          negativePrompt: input.negative_prompt,
          outputPath: input.output_path,
          duration: input.duration,
          mode: input.mode,
        });
        if (!r.success) return `❌ Kling error: ${r.error}`;
        return `✅ Video generado: ${r.path}\n🔗 ${r.videoUrl}`;
      }

      case 'list_voices': {
        if (!EL_KEY) return 'Error: ELEVENLABS_API_KEY no configurada';
        const data = await elevenLabsRequest('GET', '/voices');
        if (!data.voices) return `Error: ${JSON.stringify(data)}`;
        let voices = data.voices;
        if (input.filter) {
          const f = input.filter.toLowerCase();
          voices  = voices.filter(v => v.name.toLowerCase().includes(f) || (v.labels?.language || '').toLowerCase().includes(f) || (v.labels?.accent || '').toLowerCase().includes(f));
        }
        return voices.map(v => `🎙️ ${v.name}\n   ID: ${v.voice_id}\n   Labels: ${JSON.stringify(v.labels || {})}`).join('\n\n') || 'No se encontraron voces.';
      }

      case 'github_create_repo': {
        if (!GH_TOKEN) return '❌ GITHUB_TOKEN no configurado en Railway';
        const { status, data } = await githubRequest('POST', '/user/repos', {
          name:        input.name,
          description: input.description || '',
          private:     input.private ?? false,
          auto_init:   true,
        });
        if (status === 201) {
          return [
            `✅ Repo creado: ${data.html_url}`,
            `🔗 Clone: ${data.clone_url}`,
            `📦 SSH: ${data.ssh_url}`,
            '',
            'Próximos pasos para desplegar en Railway:',
            '1. Ve a railway.app → New Project → Deploy from GitHub repo',
            `2. Busca: ${input.name}`,
            '3. Añade las variables de entorno necesarias',
            '4. Railway auto-deploya con cada push',
          ].join('\n');
        }
        return `❌ Error ${status}: ${JSON.stringify(data)}`;
      }

      case 'github_push_file': {
        if (!GH_TOKEN) return '❌ GITHUB_TOKEN no configurado en Railway';
        const owner = input.owner || GH_OWNER;

        // Check if file exists to get SHA (needed for updates)
        let sha;
        const check = await githubRequest('GET', `/repos/${owner}/${input.repo}/contents/${input.file_path}`);
        if (check.status === 200) sha = check.data.sha;

        const { status, data } = await githubRequest('PUT', `/repos/${owner}/${input.repo}/contents/${input.file_path}`, {
          message: input.message || `update ${input.file_path}`,
          content: Buffer.from(input.content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        });

        if (status === 200 || status === 201) {
          return `✅ ${status === 201 ? 'Creado' : 'Actualizado'}: ${input.file_path} en ${owner}/${input.repo}\n🔗 ${data.content?.html_url || ''}`;
        }
        return `❌ Error ${status}: ${JSON.stringify(data)}`;
      }

      case 'execute_command': {
        const opts = {
          shell:     SHELL,
          timeout:   180_000,
          cwd:       input.cwd || WORK_DIR,
          encoding:  'utf8',
          maxBuffer: 10 * 1024 * 1024,
        };
        try {
          const { stdout, stderr } = await execAsync(input.command, opts);
          return ((stdout || '') + (stderr ? `\nSTDERR: ${stderr}` : '')).trim() || '(sin output)';
        } catch (e) {
          return `Exit ${e.code ?? 1}:\n${((e.stdout || '') + (e.stderr ? `\nSTDERR: ${e.stderr}` : '')).trim() || e.message}`;
        }
      }

      case 'read_file':
        return fs.readFileSync(input.file_path, 'utf8');

      case 'write_file':
        fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
        fs.writeFileSync(input.file_path, input.content, 'utf8');
        return `✓ Archivo escrito: ${input.file_path}`;

      case 'edit_file': {
        const content = fs.readFileSync(input.file_path, 'utf8');
        if (!content.includes(input.old_text)) return `Error: texto no encontrado en ${input.file_path}`;
        fs.writeFileSync(input.file_path, content.replace(input.old_text, input.new_text), 'utf8');
        return `✓ Archivo editado: ${input.file_path}`;
      }

      case 'list_directory': {
        const items = fs.readdirSync(input.dir_path, { withFileTypes: true });
        return items.map(i => `${i.isDirectory() ? '[DIR] ' : '[FILE]'} ${i.name}`).join('\n') || '(vacío)';
      }

      default:
        return `Herramienta desconocida: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ── Limpieza de historial ─────────────────────────────────────────────────────
// Evita el error 400 de Anthropic cuando slice(-40) corta en medio de un par
// tool_use / tool_result dejando tool_results huérfanos al inicio del array.
function sanitizeHistory(msgs) {
  // 1. Descartar desde el inicio hasta el primer user-text limpio
  let start = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      // Mensaje de usuario normal (no pure tool_result)
      if (!blocks.length || blocks.some(b => b.type === 'text')) { start = i; break; }
    }
  }
  msgs = msgs.slice(start);

  // 2. Eliminar del final cualquier assistant con solo tool_use sin tool_result siguiente
  while (msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'assistant') {
      const blocks = Array.isArray(last.content) ? last.content : [];
      if (blocks.length && blocks.every(b => b.type === 'tool_use')) {
        msgs = msgs.slice(0, -1);
        continue;
      }
    }
    break;
  }

  return msgs;
}

// ── Bucle agente ───────────────────────────────────────────────────────────────
async function runAgent(chatId, userMessage, ctx) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  history.push({ role: 'user', content: userMessage });

  let messages = sanitizeHistory([...history]);
  let finalText = '';

  while (true) {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      tools:      TOOLS,
      messages,
    });

    const toolBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    if (response.stop_reason === 'end_turn' || toolBlocks.length === 0) {
      finalText = textBlocks.map(b => b.text).join('');
      messages.push({ role: 'assistant', content: response.content });
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    for (const block of toolBlocks) {
      await ctx.reply(toolLabel(block), { parse_mode: 'Markdown' }).catch(() => ctx.reply(`⚙️ ${block.name}…`));
    }

    const toolResults = [];
    for (const block of toolBlocks) {
      const result = await executeTool(block.name, block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: String(result).slice(0, 8000) });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  conversations.set(chatId, sanitizeHistory(messages.slice(-40)));
  return finalText || '(Sin respuesta)';
}

function toolLabel(block) {
  const { name, input } = block;
  const trunc = (s, n = 80) => String(s).length > n ? String(s).slice(0, n) + '…' : String(s);
  switch (name) {
    case 'generate_script':    return `✍️ Generando guión *${input.channel}*: ${trunc(input.topic, 60)}`;
    case 'generate_voice':     return `🎙️ Generando voz *${input.channel}*…`;
    case 'upload_youtube':     return `📤 Subiendo a YouTube: *${trunc(input.title, 60)}*`;
    case 'kling_image2video':  return `🎬 Generando video con Kling AI...`;
    case 'list_voices':        return `🎙️ Listando voces ElevenLabs…`;
    case 'github_create_repo': return `📦 Creando repo GitHub: *${input.name}*`;
    case 'github_push_file':   return `🚀 Subiendo a GitHub: \`${input.file_path}\` → *${input.repo}*`;
    case 'execute_command':    return `🔧 \`${trunc(input.command)}\``;
    case 'write_file':         return `📝 Escribiendo \`${input.file_path}\``;
    case 'read_file':          return `📖 Leyendo \`${input.file_path}\``;
    case 'edit_file':          return `✏️ Editando \`${input.file_path}\``;
    case 'list_directory':     return `📂 Listando \`${input.dir_path}\``;
    default:                   return `🔧 ${name}…`;
  }
}

// ── Middleware de autorización ─────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith('/myid')) {
    return ctx.reply(`Tu Telegram ID: \`${ctx.from?.id}\`\nNombre: ${ctx.from?.first_name || ''}`, { parse_mode: 'Markdown' });
  }
  const incomingId = String(ctx.from?.id ?? '');
  if (OWNER_ID && incomingId !== OWNER_ID) {
    console.log(`[AUTH] Bloqueado: ${incomingId}`);
    return ctx.reply('⛔ No autorizado.');
  }
  return next();
});

// ── Comandos ───────────────────────────────────────────────────────────────────
bot.start((ctx) =>
  ctx.reply(
    '🤖 *Motion AI Agent*\n\n' +
    `☁️ ${IS_WINDOWS ? 'Windows local' : 'Railway (Linux)'}\n\n` +
    '*Capacidades:*\n' +
    '• Generar guiones YouTube EN / RO / ES\n' +
    '• Síntesis de voz con ElevenLabs\n' +
    '• FFmpeg: combinar audio + imagen → MP4\n' +
    '• Subir videos a YouTube automáticamente\n' +
    '• Crear repos GitHub y deployar en Railway\n\n' +
    '*Comandos:*\n' +
    '/channels — Canales YouTube y voces\n' +
    '/status — Estado del sistema\n' +
    '/help — Ayuda completa\n' +
    '/reset — Limpiar historial\n\n' +
    'Escríbeme lo que necesitas 👇',
    { parse_mode: 'Markdown' }
  )
);

bot.command('channels', (ctx) => {
  const lines = Object.entries(YT_CHANNELS).map(([code, ch]) => {
    const voiceStatus = ch.voice_id ? `✅ ${ch.voice_name} \`${ch.voice_id.slice(0, 8)}…\`` : `⚠️ ${ch.voice_name} — pendiente`;
    return `*${code}* │ ${ch.name}\n   Idioma: ${ch.lang}\n   Voz: ${voiceStatus}`;
  }).join('\n\n');
  ctx.reply(`*Canales YouTube configurados:*\n\n${lines}`, { parse_mode: 'Markdown' });
});

bot.command('voices', async (ctx) => {
  await ctx.reply('🎙️ Consultando voces ElevenLabs…');
  const result = await executeTool('list_voices', {});
  const MAX = 4000;
  if (result.length <= MAX) ctx.reply(result);
  else for (let i = 0; i < result.length; i += MAX) ctx.reply(result.slice(i, i + MAX));
});

bot.command('status', (ctx) => {
  const uptime  = Math.floor(process.uptime());
  const mem     = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const voices  = Object.entries(YT_CHANNELS).map(([c, ch]) => `${c}: ${ch.voice_id ? '✅' : '⚠️'}`).join(' │ ');
  const ytOk    = !!(process.env.YOUTUBE_REFRESH_TOKEN);
  const ghOk    = !!GH_TOKEN;
  ctx.reply(
    `*Estado del sistema*\n\n` +
    `🖥️ ${IS_WINDOWS ? 'Windows local' : 'Railway (Linux)'}\n` +
    `⏱️ Uptime: ${uptime}s\n` +
    `🧠 Memoria: ${mem} MB\n` +
    `🤖 Modelo: ${MODEL}\n` +
    `🎙️ Voces: ${voices}\n` +
    `📺 YouTube API: ${ytOk ? '✅ configurado' : '⚠️ sin configurar'}\n` +
    `🐙 GitHub API: ${ghOk ? '✅ configurado' : '⚠️ sin configurar'}\n` +
    `📁 Videos dir: ${VIDEOS_DIR}`,
    { parse_mode: 'Markdown' }
  );
});

bot.help((ctx) =>
  ctx.reply(
    '*Motion AI Agent — Ayuda*\n\n' +
    '*Comandos:*\n' +
    '/start — Bienvenida\n' +
    '/channels — Canales YouTube y voces\n' +
    '/voices — Listar voces ElevenLabs\n' +
    '/status — Estado del servidor\n' +
    '/reset — Borrar historial\n' +
    '/projects — Repos GitHub\n\n' +
    '*Flujo YouTube completo:*\n' +
    '"Genera guión y voz para EN sobre cómo ahorrar $1000"\n' +
    '"Combina el audio con imagen de fondo y sube a YouTube"\n\n' +
    '*Crear nuevo bot Discord:*\n' +
    '"Crea un nuevo bot Discord llamado mi-bot, despliégalo en Railway"\n\n' +
    '*Variables necesarias para YouTube:*\n' +
    'YOUTUBE\\_CLIENT\\_ID, YOUTUBE\\_CLIENT\\_SECRET, YOUTUBE\\_REFRESH\\_TOKEN\n\n' +
    '*Variables para GitHub:*\n' +
    'GITHUB\\_TOKEN (PAT con scope `repo`)',
    { parse_mode: 'Markdown' }
  )
);

bot.command('reset', (ctx) => {
  conversations.delete(ctx.chat.id);
  ctx.reply('🗑️ Historial limpiado.');
});

bot.command('projects', (ctx) =>
  ctx.reply(
    '*Repos GitHub:*\n\n' +
    `📦 [motion-ai-agent](https://github.com/${GH_OWNER}/motion-ai-agent)\n` +
    `📦 [rentnft-bot](https://github.com/${GH_OWNER}/rentnft-bot)`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  )
);

// ── Fotos: guardar automáticamente en Images ──────────────────────────────────
const PHOTOS_SAVE_DIR = process.env.PHOTOS_DIR ||
  'C:/Users/M11/Desktop/YouTube_Pipeline/EN_Motivation_Finance/Images';

function nextPhotoPrefix(dir) {
  try {
    const nums = fs.readdirSync(dir).map(f => parseInt(f.slice(0, 2))).filter(n => !isNaN(n));
    return nums.length ? Math.max(...nums) + 1 : 1;
  } catch { return 1; }
}

bot.on('photo', async (ctx) => {
  if (OWNER_ID && String(ctx.from?.id) !== OWNER_ID) return;
  const best   = ctx.message.photo[ctx.message.photo.length - 1];
  const prefix = String(nextPhotoPrefix(PHOTOS_SAVE_DIR)).padStart(2, '0');
  const label  = (ctx.message.caption || `telegram_photo`)
    .replace(/[^a-z0-9_]/gi, '_').slice(0, 30).replace(/_+/g, '_').replace(/^_|_$/g, '');
  const dest = path.join(PHOTOS_SAVE_DIR, `${prefix}_${label}.jpg`);

  try {
    fs.mkdirSync(PHOTOS_SAVE_DIR, { recursive: true });
    const fileInfo = await ctx.telegram.getFile(best.file_id);
    const fileUrl  = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
    const data = await new Promise((resolve, reject) => {
      https.get(fileUrl, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    fs.writeFileSync(dest, data);
    await ctx.reply(`✅ Foto guardada: ${path.basename(dest)} (${Math.round(data.length / 1024)}KB)`);
  } catch (e) {
    await ctx.reply(`❌ Error al guardar foto: ${e.message}`);
  }
});

// ── Mensajes de texto ──────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  const chatId      = ctx.chat.id;
  const userMessage = ctx.message.text;

  await ctx.sendChatAction('typing').catch(() => {});
  const typingInterval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);

  try {
    const response = await runAgent(chatId, userMessage, ctx);
    clearInterval(typingInterval);
    const MAX = 4000;
    if (response.length <= MAX) await ctx.reply(response);
    else for (let i = 0; i < response.length; i += MAX) await ctx.reply(response.slice(i, i + MAX));
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Agent error]', err);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
});

// ── Iniciar ────────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log(`🚀 Motion AI Agent | ${IS_WINDOWS ? 'Windows' : 'Railway/Linux'} | Modelo: ${MODEL}`);
  console.log(`📺 YouTube: ${process.env.YOUTUBE_REFRESH_TOKEN ? '✅' : '⚠️ no configurado'} | GitHub: ${GH_TOKEN ? '✅' : '⚠️ no configurado'}`);
  console.log(OWNER_ID ? `🔒 Owner: ${OWNER_ID}` : '⚠️  Sin restricción de acceso');
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
