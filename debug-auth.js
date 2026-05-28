// Script de diagnóstico: muestra exactamente qué carga dotenv
require('dotenv').config();

const raw = process.env.TELEGRAM_OWNER_ID;
console.log('=== DIAGNÓSTICO TELEGRAM_OWNER_ID ===');
console.log('Valor raw:    ', JSON.stringify(raw));
console.log('Tipo:         ', typeof raw);
console.log('Trimmed:      ', JSON.stringify(raw?.trim()));
console.log('Char codes:   ', [...(raw || '')].map(c => c.charCodeAt(0)));
console.log('Longitud:     ', raw?.length);
