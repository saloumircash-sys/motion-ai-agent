require('dotenv').config();
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const https = require('https');

const execAsync = util.promisify(exec);

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
    voice_name: 'Mayra',
    niche:      'finanzas personales, inversiones, mentalidad de riqueza',
    style:      'directo, energético, sin rodeos',
  },
};

const conversations = new Map();

// ── System prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un asistente AI especializado en producción de contenido YouTube y gestión de proyectos de código.
Plataforma: ${IS_WINDOWS ? 'Windows (local)' : 'Linux (Railway)'}
Shell: ${IS_WINDOWS ? 'PowerShell' : 'bash'}
Directorio de trabajo: ${WORK_DIR}
Directorio de videos: ${VIDEOS_DIR}

═══ CANALES YOUTUBE ═══
• EN  │ "Motivation Finance"               │ ${YT_CHANNELS.EN.niche}
• RO  │ "Motivatie Financiara cu George"   │ ${YT_CHANNELS.RO.niche}
• ES  │ "Finanzas Sin Filtro"              │ ${YT_CHANNELS.ES.niche}

═══ FLUJO DE PRODUCCIÓN ═══
1. generate_script  → crea el guión estructurado para el canal
2. generate_voice   → convierte el guión a MP3 con ElevenLabs
3. execute_command  → procesa video (ffmpeg, yt-dlp, etc.)
4. write_file       → guarda guiones, metadatos, descripciones

═══ FORMATO DE SCRIPTS ═══
- HOOK (0-5s): frase de impacto que engancha
- INTRO (5-30s): presentación del problema/valor
- BODY (30s-7min): contenido principal con puntos numerados
- CTA (final): call to action específico del canal

═══ PROYECTOS DE CÓDIGO (GitHub) ═══
- motion-ai-agent: https://github.com/saloumircash-sys/motion-ai-agent
- rentnft-bot:     https://github.com/saloumircash-sys/rentnft-bot

Reglas:
- Responde en el idioma del usuario
- Ejecuta directamente sin pedir confirmación innecesaria
- Para scripts YouTube, sigue el formato estructurado
- Muestra el path del archivo de audio generado`;

// ── Herramientas ───────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'generate_script',
    description:
      'Genera un guión completo y estructurado para un video de YouTube. ' +
      'Incluye hook, intro, cuerpo y CTA optimizados para el canal.',
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
    description:
      'Convierte texto a audio MP3 usando ElevenLabs. ' +
      'Guarda el archivo en el directorio de videos y devuelve el path.',
    input_schema: {
      type: 'object',
      properties: {
        text:       { type: 'string', description: 'Texto a convertir en voz' },
        channel:    { type: 'string', enum: ['EN', 'RO', 'ES'], description: 'Canal (determina la voz y el idioma)' },
        voice_id:   { type: 'string', description: 'Voice ID de ElevenLabs (override del canal, opcional)' },
        filename:   { type: 'string', description: 'Nombre del archivo de salida sin extensión (opcional)' },
        model:      { type: 'string', description: 'Modelo ElevenLabs: eleven_multilingual_v2 (default) o eleven_turbo_v2_5' },
      },
      required: ['text', 'channel'],
    },
  },
  {
    name: 'list_voices',
    description: 'Lista todas las voces disponibles en la cuenta de ElevenLabs con sus IDs.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filtrar por idioma o nombre (opcional). Ej: "Spanish", "Romanian"' },
      },
    },
  },
  {
    name: 'execute_command',
    description:
      `Ejecuta un comando ${IS_WINDOWS ? 'PowerShell' : 'bash'}. ` +
      'Úsalo para ffmpeg, yt-dlp, git, npm, curl, etc.',
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

// ── ElevenLabs helpers ─────────────────────────────────────────────────────────
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

        const resp = await anthropic.messages.create({
          model:      MODEL,
          max_tokens: 4096,
          messages:   [{ role: 'user', content: prompt }],
        });
        const script   = resp.content[0].text;
        const filename = `script_${input.channel}_${Date.now()}.txt`;
        const filePath = path.join(VIDEOS_DIR, input.channel, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, script, 'utf8');
        return `✅ Guión generado y guardado en:\n${filePath}\n\n${script}`;
      }

      case 'generate_voice': {
        if (!EL_KEY) return 'Error: ELEVENLABS_API_KEY no configurada';
        const ch      = YT_CHANNELS[input.channel];
        const voiceId = input.voice_id || ch.voice_id;
        if (!voiceId) return `Error: No hay voice_id configurado para canal ${input.channel}. Usa /voices para obtener IDs y configura VOICE_${input.channel} en las variables de entorno.`;

        const elModel  = input.model || 'eleven_multilingual_v2';
        const audioBuffer = await elevenLabsRequest(
          'POST',
          `/text-to-speech/${voiceId}`,
          {
            text:            input.text,
            model_id:        elModel,
            voice_settings:  { stability: 0.5, similarity_boost: 0.75, style: 0.4, use_speaker_boost: true },
          },
          true
        );

        if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 1000) {
          try {
            const errMsg = JSON.parse(audioBuffer.toString());
            return `Error ElevenLabs: ${errMsg.detail?.message || JSON.stringify(errMsg)}`;
          } catch {
            return `Error ElevenLabs: respuesta inválida (${audioBuffer.length} bytes)`;
          }
        }

        const filename = input.filename
          ? `${input.filename}.mp3`
          : `voice_${input.channel}_${Date.now()}.mp3`;
        const outDir   = path.join(VIDEOS_DIR, input.channel, 'audio');
        fs.mkdirSync(outDir, { recursive: true });
        const filePath = path.join(outDir, filename);
        fs.writeFileSync(filePath, audioBuffer);
        const sizeMB = (audioBuffer.length / 1024 / 1024).toFixed(2);
        return `✅ Audio generado: ${filePath}\n📦 Tamaño: ${sizeMB} MB\n🎙️ Voz: ${voiceId} | Modelo: ${elModel}`;
      }

      case 'list_voices': {
        if (!EL_KEY) return 'Error: ELEVENLABS_API_KEY no configurada';
        const data = await elevenLabsRequest('GET', '/voices');
        if (!data.voices) return `Error: ${JSON.stringify(data)}`;
        let voices = data.voices;
        if (input.filter) {
          const f = input.filter.toLowerCase();
          voices  = voices.filter(v =>
            v.name.toLowerCase().includes(f) ||
            (v.labels?.language || '').toLowerCase().includes(f) ||
            (v.labels?.accent || '').toLowerCase().includes(f)
          );
        }
        return voices.map(v =>
          `🎙️ ${v.name}\n   ID: ${v.voice_id}\n   Labels: ${JSON.stringify(v.labels || {})}`
        ).join('\n\n') || 'No se encontraron voces con ese filtro.';
      }

      case 'execute_command': {
        const opts = {
          shell:     SHELL,
          timeout:   120_000,
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

// ── Bucle agente ───────────────────────────────────────────────────────────────
async function runAgent(chatId, userMessage, ctx) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  history.push({ role: 'user', content: userMessage });

  let messages  = [...history];
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
      await ctx.reply(toolLabel(block), { parse_mode: 'Markdown' }).catch(() =>
        ctx.reply(`⚙️ ${block.name}…`)
      );
    }

    const toolResults = [];
    for (const block of toolBlocks) {
      const result = await executeTool(block.name, block.input);
      toolResults.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     String(result).slice(0, 8000),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  conversations.set(chatId, messages.slice(-40));
  return finalText || '(Sin respuesta)';
}

function toolLabel(block) {
  const { name, input } = block;
  const trunc = (s, n = 80) => String(s).length > n ? String(s).slice(0, n) + '…' : String(s);
  switch (name) {
    case 'generate_script': return `✍️ Generando guión para *${input.channel}*: ${trunc(input.topic, 60)}`;
    case 'generate_voice':  return `🎙️ Generando voz *${input.channel}* (${input.model || 'multilingual_v2'})…`;
    case 'list_voices':     return `🎙️ Listando voces ElevenLabs…`;
    case 'execute_command': return `🔧 \`${trunc(input.command)}\``;
    case 'write_file':      return `📝 Escribiendo \`${input.file_path}\``;
    case 'read_file':       return `📖 Leyendo \`${input.file_path}\``;
    case 'edit_file':       return `✏️ Editando \`${input.file_path}\``;
    case 'list_directory':  return `📂 Listando \`${input.dir_path}\``;
    default:                return `🔧 ${name}…`;
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
    '*Capacidades YouTube:*\n' +
    '• Generar guiones EN / RO / ES\n' +
    '• Síntesis de voz con ElevenLabs\n' +
    '• Gestión de archivos de audio/video\n\n' +
    '*Comandos útiles:*\n' +
    '/channels — Ver canales configurados\n' +
    '/voices — Ver voces ElevenLabs\n' +
    '/status — Estado del servidor\n' +
    '/help — Ayuda completa\n\n' +
    'Escríbeme lo que necesitas 👇',
    { parse_mode: 'Markdown' }
  )
);

bot.command('channels', (ctx) => {
  const lines = Object.entries(YT_CHANNELS).map(([code, ch]) => {
    const voiceStatus = ch.voice_id ? `✅ ${ch.voice_name} \`${ch.voice_id.slice(0, 8)}…\`` : `⚠️ ${ch.voice_name} — pendiente de clonar`;
    return `*${code}* │ ${ch.name}\n   Idioma: ${ch.lang}\n   Voz: ${voiceStatus}`;
  }).join('\n\n');
  ctx.reply(`*Canales YouTube configurados:*\n\n${lines}\n\nUsa /voices para obtener IDs de voces.`, { parse_mode: 'Markdown' });
});

bot.command('voices', async (ctx) => {
  await ctx.reply('🎙️ Consultando voces ElevenLabs…');
  const result = await executeTool('list_voices', {});
  const MAX = 4000;
  if (result.length <= MAX) {
    ctx.reply(result);
  } else {
    for (let i = 0; i < result.length; i += MAX) ctx.reply(result.slice(i, i + MAX));
  }
});

bot.command('status', (ctx) => {
  const uptime = Math.floor(process.uptime());
  const mem    = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const voicesOk = Object.entries(YT_CHANNELS)
    .map(([c, ch]) => `${c}: ${ch.voice_id ? '✅' : '⚠️'}`)
    .join(' │ ');
  ctx.reply(
    `*Estado del servidor*\n\n` +
    `🖥️ ${IS_WINDOWS ? 'Windows local' : 'Railway (Linux)'}\n` +
    `⏱️ Uptime: ${uptime}s\n` +
    `🧠 Memoria: ${mem} MB\n` +
    `🤖 Modelo: ${MODEL}\n` +
    `🎙️ Voces: ${voicesOk}\n` +
    `📁 Videos: ${VIDEOS_DIR}`,
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
    '*Ejemplos de uso:*\n' +
    '• "Genera un guión EN sobre cómo ahorrar $1000"\n' +
    '• "Crea la voz para el canal RO con este texto: …"\n' +
    '• "Lista los archivos de audio del canal ES"\n' +
    '• "Genera guión y voz para ES sobre invertir en ETFs"',
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
    '📦 [motion-ai-agent](https://github.com/saloumircash-sys/motion-ai-agent)\n' +
    '📦 [rentnft-bot](https://github.com/saloumircash-sys/rentnft-bot)',
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  )
);

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
    if (response.length <= MAX) {
      await ctx.reply(response);
    } else {
      for (let i = 0; i < response.length; i += MAX) await ctx.reply(response.slice(i, i + MAX));
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Agent error]', err);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
});

// ── Iniciar ────────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log(`🚀 Motion AI Agent | ${IS_WINDOWS ? 'Windows' : 'Railway/Linux'} | Modelo: ${MODEL}`);
  console.log(`📺 Canales: EN="${YT_CHANNELS.EN.name}" | RO="${YT_CHANNELS.RO.name}" | ES="${YT_CHANNELS.ES.name}"`);
  console.log(OWNER_ID ? `🔒 Owner: ${OWNER_ID}` : '⚠️  Sin restricción de acceso');
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
