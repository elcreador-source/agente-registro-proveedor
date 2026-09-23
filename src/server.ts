// API HTTP del agente. Sin framework: node:http basta para 3 rutas y el front estático.
import "dotenv/config"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { promises as fs } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { AdaptadorAnthropic } from "./llm/anthropic.js"
import { cargarSystemPrompt, turno, type Sesion } from "./agente.js"

const dir = process.cwd()
const entero = (v: string | undefined, porDefecto: number): number => (v && Number.isFinite(Number(v)) ? Number(v) : porDefecto)
const config = {
  puerto: entero(process.env.PORT, 3000),
  limites: { maxIteraciones: entero(process.env.MAX_ITERACIONES, 25), maxTokensSesion: entero(process.env.MAX_TOKENS_SESION, 300000) },
  // Tope global del proceso: evita que abrir sesiones nuevas sin fin gaste la clave sin límite.
  maxTokensTotal: entero(process.env.MAX_TOKENS_TOTAL, 3000000),
}
const llm = new AdaptadorAnthropic({
  modelo: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  timeoutMs: entero(process.env.LLM_TIMEOUT_MS, 60000),
  esfuerzo: "medium",
})
const sesiones = new Map<string, Sesion>()
const cuerpoChat = z.object({ sessionId: z.string().min(1).max(100).nullish(), message: z.string().min(1).max(4000) })

function json(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(cuerpo))
}

async function leerCuerpo(req: IncomingMessage): Promise<unknown> {
  let datos = ""
  for await (const trozo of req) {
    datos += trozo
    if (datos.length > 20000) throw new Error("cuerpo demasiado grande")
  }
  return JSON.parse(datos || "{}")
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let bruto: unknown
  try {
    bruto = await leerCuerpo(req)
  } catch {
    return json(res, 400, { error: "cuerpo inválido" })
  }
  const cuerpo = cuerpoChat.safeParse(bruto)
  if (!cuerpo.success) return json(res, 400, { error: "se espera { sessionId?, message } con message de 1 a 4000 caracteres" })
  const id = cuerpo.data.sessionId ?? randomUUID()
  const consumidos = [...sesiones.values()].reduce((t, s) => t + s.tokens, 0)
  if (consumidos >= config.maxTokensTotal) {
    return json(res, 200, { sessionId: id, reply: "El servicio alcanzó su tope de uso por hoy. Intenta más tarde.", toolCalls: [], needsConfirmation: false, error: true })
  }
  const sesion = sesiones.get(id) ?? { id, mensajes: [], historial: [], tokens: 0, esperandoConfirmacion: false }
  sesiones.set(id, sesion)
  const system = await cargarSystemPrompt(dir)
  const r = await turno(sesion, cuerpo.data.message, llm, system, dir, config.limites)
  json(res, 200, { sessionId: id, ...r })
}

async function estatico(res: ServerResponse): Promise<void> {
  const html = await fs.readFile(path.join(dir, "web", "index.html"))
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(html)
}

const servidor = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const manejar = async (): Promise<void> => {
    if (req.method === "GET" && url.pathname === "/") return estatico(res)
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, provider: llm.proveedor, model: llm.modelo })
    }
    if (req.method === "POST" && url.pathname === "/api/chat") return chat(req, res)
    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (req.method === "GET" && m) {
      const s = sesiones.get(decodeURIComponent(m[1]))
      return s ? json(res, 200, { sessionId: s.id, tokens: s.tokens, historial: s.historial }) : json(res, 404, { error: "sesión no encontrada" })
    }
    json(res, 404, { error: "ruta no encontrada" })
  }
  manejar().catch(() => json(res, 500, { error: "error interno del servidor" }))
})

servidor.listen(config.puerto, () => {
  console.log(`Agente de registro de proveedores en http://localhost:${config.puerto} (modelo ${llm.modelo})`)
  if (!process.env.ANTHROPIC_API_KEY) console.warn("Aviso: ANTHROPIC_API_KEY no está definida; el chat responderá con error de clave.")
})
