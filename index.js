require('dotenv').config();
const { Telegraf } = require('telegraf');
const Anthropic = require('@anthropic-ai/sdk');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execAsync = util.promisify(exec);

if (!process.env.TELEGRAM_TOKEN || !process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Faltan variables de entorno: TELEGRAM_TOKEN y/o ANTHROPIC_API_KEY');
  process.exit(1);
}

const IS_WINDOWS = process.platform === 'win32';
const SHELL      = IS_WINDOWS ? 'powershell.exe' : 'bash';
const WORK_DIR   = process.env.WORK_DIR || (IS_WINDOWS ? 'C:\\Users\\M11' : '/app');

const bot       = new Telegraf(process.env.TELEGRAM_TOKEN);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const OWNER_ID  = process.env.TELEGRAM_OWNER_ID?.trim() || null;

const conversations = new Map();

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un asistente AI con acceso completo al servidor donde estás desplegado.
Plataforma actual: ${IS_WINDOWS ? 'Windows (local)' : 'Linux (Railway)'}
Directorio base: ${WORK_DIR}
Shell disponible: ${IS_WINDOWS ? 'PowerShell' : 'bash'}

Proyectos en GitHub (https://github.com/saloumircash-sys):
- motion-ai-agent: este mismo bot, desplegado en Railway
- rentnft-bot:     bot de Discord con IA, NFT y tickets

Capacidades:
- Ejecutar comandos ${IS_WINDOWS ? 'PowerShell' : 'bash'} (npm, node, git, curl, etc.)
- Crear, leer, editar y listar archivos
- Clonar repos de GitHub y hacer push/pull
- Instalar dependencias: npm install
- Commit y push: git add . && git commit -m "..." && git push
- Consultar APIs externas con curl

Reglas:
- Responde siempre en el idioma del usuario
- Para tareas simples ejecuta directamente, sin pedir confirmación innecesaria
- Muestra el output relevante de los comandos
- Si algo falla, diagnostica el error y aplica o propón la solución
- Usa las herramientas proactivamente para completar la tarea`;

// ── Herramientas ───────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'execute_command',
    description:
      `Ejecuta un comando de ${IS_WINDOWS ? 'PowerShell' : 'bash'} en el servidor. ` +
      'Úsalo para correr scripts, instalar paquetes, git, curl, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: `Comando ${IS_WINDOWS ? 'PowerShell' : 'bash'} a ejecutar` },
        cwd: { type: 'string', description: 'Directorio de trabajo (opcional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Lee el contenido de un archivo.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Ruta absoluta al archivo' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Crea o sobreescribe un archivo con el contenido indicado.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Ruta absoluta al archivo' },
        content:   { type: 'string', description: 'Contenido a escribir' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Edita un archivo reemplazando un fragmento de texto específico.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Ruta absoluta al archivo' },
        old_text:  { type: 'string', description: 'Texto exacto a buscar' },
        new_text:  { type: 'string', description: 'Texto de reemplazo' },
      },
      required: ['file_path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'list_directory',
    description: 'Lista archivos y carpetas de un directorio.',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Ruta absoluta al directorio' },
      },
      required: ['dir_path'],
    },
  },
];

// ── Ejecución de herramientas ──────────────────────────────────────────────────
async function executeTool(name, input) {
  try {
    switch (name) {
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
          const out = (stdout || '') + (stderr ? `\nSTDERR: ${stderr}` : '');
          return out.trim() || '(sin output)';
        } catch (e) {
          const out = (e.stdout || '') + (e.stderr ? `\nSTDERR: ${e.stderr}` : '');
          return `Exit ${e.code ?? 1}:\n${out.trim() || e.message}`;
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
  const truncate = (s, n = 80) => String(s).length > n ? String(s).slice(0, n) + '…' : String(s);
  switch (name) {
    case 'execute_command': return `🔧 \`${truncate(input.command)}\``;
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
    '🤖 *Asistente AI activo*\n\n' +
    `Ejecutándose en: ${IS_WINDOWS ? '🖥️ Windows local' : '☁️ Railway (Linux)'}\n\n` +
    'Puedo:\n' +
    '• Crear y editar archivos de código\n' +
    `• Ejecutar comandos ${IS_WINDOWS ? 'PowerShell' : 'bash'}\n` +
    '• Gestionar repos de GitHub\n' +
    '• Instalar dependencias y deployar\n\n' +
    'Escríbeme lo que necesitas 👇',
    { parse_mode: 'Markdown' }
  )
);

bot.help((ctx) =>
  ctx.reply(
    '*Comandos disponibles:*\n' +
    '/start — Bienvenida\n' +
    '/help — Esta ayuda\n' +
    '/reset — Borrar historial\n' +
    '/status — Estado del servidor\n' +
    '/projects — Proyectos en GitHub\n\n' +
    'O simplemente escríbeme lo que necesitas.',
    { parse_mode: 'Markdown' }
  )
);

bot.command('reset', (ctx) => {
  conversations.delete(ctx.chat.id);
  ctx.reply('🗑️ Historial limpiado.');
});

bot.command('status', async (ctx) => {
  const uptime  = Math.floor(process.uptime());
  const mem     = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const platform = IS_WINDOWS ? 'Windows local' : 'Railway (Linux)';
  ctx.reply(
    `*Estado del servidor*\n\n` +
    `🖥️ Plataforma: ${platform}\n` +
    `⏱️ Uptime: ${uptime}s\n` +
    `🧠 Memoria: ${mem} MB\n` +
    `🤖 Modelo: ${MODEL}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('projects', (ctx) =>
  ctx.reply(
    '*Proyectos en GitHub:*\n\n' +
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
      for (let i = 0; i < response.length; i += MAX) {
        await ctx.reply(response.slice(i, i + MAX));
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Agent error]', err);
    await ctx.reply(`❌ Error: ${err.message}`);
  }
});

// ── Iniciar bot ────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log(`🚀 Bot iniciado | Plataforma: ${IS_WINDOWS ? 'Windows' : 'Railway/Linux'} | Modelo: ${MODEL}`);
  console.log(OWNER_ID
    ? `🔒 Acceso restringido → Telegram ID: ${OWNER_ID}`
    : '⚠️  Sin restricción de acceso'
  );
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
