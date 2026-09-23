// Ciclo del agente: prompt → modelo → herramientas → modelo … → respuesta.
// No conoce al proveedor LLM (usa AdaptadorLlm) ni al servidor HTTP.
import { promises as fs } from "node:fs"
import path from "node:path"
import type { AdaptadorLlm, BloqueLlamada, BloqueResultado, Mensaje } from "./llm/adapter.js"
import { ErrorLlm } from "./llm/adapter.js"
import { ejecutar, especificaciones } from "./tools/index.js"
import { hoyIso, normalizar } from "./lib/util.js"

export type LlamadaVisible = { nombre: string; args: unknown; ok: boolean; resumen: string }
export type EntradaChat = { rol: "usuario" | "agente"; texto: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error: boolean; ts: string }
export type Sesion = { id: string; mensajes: Mensaje[]; historial: EntradaChat[]; tokens: number; esperandoConfirmacion: boolean }
export type Limites = { maxIteraciones: number; maxTokensSesion: number }
export type RespuestaTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; error: boolean }

const MARCA_CONFIRMACION = "[CONFIRMACION]"
const HERRAMIENTAS_CON_CONFIRMACION = new Set(["proveedor_simular_envio"])

/** Comportamiento (prompt.md) + conocimiento (knowledge/) se cargan de archivos, no del código. */
export async function cargarSystemPrompt(dir: string): Promise<string> {
  const prompt = await fs.readFile(path.join(dir, "agent", "prompt.md"), "utf8")
  const conocimiento = await fs.readFile(path.join(dir, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return `${prompt}\n\n# Conocimiento del proceso\n\n${conocimiento}\n\nFecha de hoy: ${hoyIso()}`
}

/** CA3: solo cuenta como confirmación un mensaje afirmativo justo después de que el agente la pidió. */
export function esConfirmacion(texto: string): boolean {
  const t = normalizar(texto)
  if (/\b(no|todavia|aun no|espera|cancela)\b/.test(t)) return false
  return /\b(si|confirmo|confirmado|adelante|envia|envialo|enviar|procede|ok|dale|de acuerdo|autorizo)\b/.test(t)
}

export async function turno(
  sesion: Sesion, texto: string, llm: AdaptadorLlm, system: string, dir: string, limites: Limites,
): Promise<RespuestaTurno> {
  const confirmado = sesion.esperandoConfirmacion && esConfirmacion(texto)
  sesion.esperandoConfirmacion = false
  sesion.historial.push({ rol: "usuario", texto, toolCalls: [], needsConfirmation: false, error: false, ts: new Date().toISOString() })
  sesion.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto }] })

  const llamadas: LlamadaVisible[] = []
  let reply = ""
  let error = false
  try {
    reply = await bucle(sesion, llm, system, dir, limites, confirmado, llamadas)
  } catch (e) {
    error = true
    reply = e instanceof ErrorLlm ? e.message : "Ocurrió un error inesperado. La sesión sigue activa; intenta de nuevo."
  }

  const needsConfirmation = reply.includes(MARCA_CONFIRMACION)
  reply = reply.replaceAll(MARCA_CONFIRMACION, "").trim()
  sesion.esperandoConfirmacion = needsConfirmation
  sesion.historial.push({ rol: "agente", texto: reply, toolCalls: llamadas, needsConfirmation, error, ts: new Date().toISOString() })
  return { reply, toolCalls: llamadas, needsConfirmation, error }
}

async function bucle(
  sesion: Sesion, llm: AdaptadorLlm, system: string, dir: string, limites: Limites,
  confirmado: boolean, llamadas: LlamadaVisible[],
): Promise<string> {
  const specs = especificaciones()
  for (let i = 0; i < limites.maxIteraciones; i++) {
    if (sesion.tokens >= limites.maxTokensSesion) {
      return "Se alcanzó el tope de tokens de esta sesión. Abre una sesión nueva para continuar."
    }
    const r = await llm.enviar(system, sesion.mensajes, specs)
    sesion.tokens += r.uso.entrada + r.uso.salida
    sesion.mensajes.push({ rol: "asistente", bloques: r.bloques, nativo: r.nativo })

    const pedidas = r.bloques.filter((b): b is BloqueLlamada => b.tipo === "llamada")
    if (r.fin === "pausa") continue
    if (pedidas.length === 0) {
      const texto = textoDe(r.bloques)
      if (r.fin === "rechazo") return "El modelo no pudo atender esta solicitud. Reformúlala, por favor."
      if (r.fin === "limite_tokens") return `${texto}\n\n(La respuesta se cortó por longitud.)`
      return texto
    }

    const resultados: BloqueResultado[] = []
    for (const p of pedidas) {
      const salida = await ejecutarControlado(p, confirmado, dir, sesion.id)
      const parsed = JSON.parse(salida) as { ok: boolean; data?: { resumen?: string }; error?: string }
      llamadas.push({ nombre: p.nombre, args: p.args, ok: parsed.ok, resumen: parsed.ok ? (parsed.data?.resumen ?? "ok") : (parsed.error ?? "error") })
      resultados.push({ tipo: "resultado", id: p.id, contenido: salida, esError: !parsed.ok })
    }
    sesion.mensajes.push({ rol: "usuario", bloques: resultados })
  }
  const hechas = llamadas.map((l) => `- ${l.nombre}: ${l.resumen}`).join("\n")
  return `Alcancé el tope de ${limites.maxIteraciones} pasos en este turno. Esto es lo que alcancé a hacer:\n${hechas}\n\nPídeme que continúe para completar lo que falta.`
}

/** La confirmación la decide el servidor, no el modelo: aunque el modelo envíe confirmado=true, sin confirmación real se rechaza. */
async function ejecutarControlado(p: BloqueLlamada, confirmado: boolean, dir: string, sessionId: string): Promise<string> {
  const pideConfirmacion = typeof p.args === "object" && p.args !== null && (p.args as { confirmado?: unknown }).confirmado === true
  if (HERRAMIENTAS_CON_CONFIRMACION.has(p.nombre) && pideConfirmacion && !confirmado) {
    return JSON.stringify({ ok: false, error: "requiere confirmación explícita: pregunta al usuario y espera su respuesta" })
  }
  return ejecutar(p.nombre, p.args, { directory: dir, sessionId })
}

const textoDe = (bloques: Mensaje["bloques"]): string =>
  bloques.filter((b) => b.tipo === "texto").map((b) => (b.tipo === "texto" ? b.texto : "")).join("\n").trim()
