# Agente · Registro como Proveedor (Reto 01 · Perxia 2.0)

Agente conversacional que lee una solicitud de registro como proveedor, llena el formulario desde el repositorio maestro (Excel, PDF o valores para portal), arma el paquete para firma y **pide confirmación humana** antes de cualquier envío (simulado).

**Link de prueba:** https://agente-registro-proveedor.onrender.com (acceso público, sin clave).
Plan gratuito de Render: si estuvo inactivo, la primera carga tarda ~40 s en despertar.

## Requisitos

- Node.js 20 o superior (probado con Node 24).
- Una API key de Anthropic (solo para el chat; `demo.ts` no la necesita).

## Levantar en local (un comando)

```bash
cp .env.example .env      # y pega tu ANTHROPIC_API_KEY en .env
npm install && npm run dev
```

Abre http://localhost:3000.

## Verificación sin modelo

```bash
npm install && npm run demo
```

Limpia `out/`, recorre los 4 casos de `fixtures/reto-01/casos/` llamando directamente a las herramientas e imprime un resumen por caso (campos llenos/faltantes/por confirmar, formulario, `listo_para_firma`, bloqueos), además de los casos de error y un envío con confirmación.

> El PRD menciona `bun run demo.ts`; este proyecto usa Node + `tsx` (permitido por el reto: "Bun o Node 20+"). Probado solo con Node.

## Variables de entorno

| Variable | Obligatoria | Por defecto | Uso |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sí (chat) | — | Clave del modelo. Solo en el backend. |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-5` | Modelo de Anthropic. |
| `PORT` | No | `3000` | Puerto HTTP. |
| `MAX_ITERACIONES` | No | `25` | Tope herramienta→modelo por turno. |
| `MAX_TOKENS_SESION` | No | `300000` | Tope de tokens por sesión. |
| `MAX_TOKENS_TOTAL` | No | `3000000` | Tope de tokens del proceso (todas las sesiones). |
| `LLM_TIMEOUT_MS` | No | `60000` | Timeout de la llamada al modelo. |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, error }` |
| `GET` | `/api/sessions/:id` | `{ sessionId, tokens, historial[] }` |
| `GET` | `/api/health` | `{ ok: true, provider, model }` (sin claves) |

`toolCalls[]` = `{ nombre, args, ok, resumen }`. Si `sessionId` no se envía, el servidor crea uno y lo devuelve.

## Estructura

```
agent/prompt.md                     comportamiento (system prompt)
src/knowledge/                      conocimiento del proceso y reglas por país
src/tools/proveedor.ts              herramientas (proveedor_<export>)
src/tools/index.ts                  registro, validación zod y logs
src/llm/adapter.ts · anthropic.ts   interfaz del proveedor LLM + implementación
src/agente.ts                       ciclo del agente
src/server.ts                       API HTTP
web/index.html                      front de chat
demo.ts                             herramientas sin modelo
render.yaml                         despliegue en Render
src/modulo.ts                       genera y verifica modulo/
modulo/                             bonus: agente empaquetado (agent.md, tools/, skill/)
```

## Módulo reutilizable (bonus)

`modulo/` empaqueta el agente para otras plataformas sin depender del servidor:

- `modulo/agent.md`: frontmatter (`description`, `mode: primary`, `permission { edit: deny, bash: deny }`) + el system prompt de `agent/prompt.md`.
- `modulo/tools/proveedor.ts`: reexporta `src/tools/proveedor.ts` (mismas herramientas, importables sin el servidor).
- `modulo/skill/registro-proveedor/SKILL.md`: frontmatter (`name`, `description`) + `src/knowledge/registro-proveedor.md`.

```bash
npm run modulo          # regenera modulo/ tras cambiar el prompt o el conocimiento
npm run modulo:check    # falla si modulo/ diverge de las fuentes (también lo verifica demo.ts)
```

## Salidas (`out/`)

- `out/<caso>/formulario.xlsx | formulario.pdf | valores-portal.md`, `faltantes.md`, `estado.json`, `log.jsonl`
- `out/<caso>/paquete/` con formulario, `soportes/`, `checklist.md`, `borrador-correo.md`
- `out/<caso>/ENVIO-SIMULADO.md` (solo tras confirmación explícita)
- `out/log.jsonl` con todas las llamadas a herramientas

## Prompt de demo

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

Luego escribe `envía` y confirma con el botón **Sí, confirmo**.
