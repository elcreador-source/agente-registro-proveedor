// Implementación de AdaptadorLlm para la API de Anthropic (Messages API, ciclo manual).
import Anthropic from "@anthropic-ai/sdk"
import type { AdaptadorLlm, Bloque, Mensaje, MotivoFin, RespuestaLlm } from "./adapter.js"
import { ErrorLlm } from "./adapter.js"
import type { EspecHerramienta } from "../tools/index.js"

type Contenido = Anthropic.Beta.Messages.BetaContentBlockParam
type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"

export class AdaptadorAnthropic implements AdaptadorLlm {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic
  private readonly esfuerzo: Esfuerzo

  constructor(opciones: { modelo: string; timeoutMs: number; esfuerzo: Esfuerzo }) {
    // La clave se lee de ANTHROPIC_API_KEY dentro del SDK; nunca pasa por este código ni por logs.
    this.cliente = new Anthropic({ timeout: opciones.timeoutMs, maxRetries: 2 })
    this.modelo = opciones.modelo
    this.esfuerzo = opciones.esfuerzo
  }

  async enviar(system: string, mensajes: Mensaje[], herramientas: EspecHerramienta[]): Promise<RespuestaLlm> {
    if (!process.env.ANTHROPIC_API_KEY) throw new ErrorLlm("La clave del modelo no está configurada en el servidor (ANTHROPIC_API_KEY).")
    try {
      const r = await this.cliente.beta.messages.create({
        model: this.modelo,
        max_tokens: 16000,
        system,
        output_config: { effort: this.esfuerzo },
        // Opus 5 / Fable: si el modelo rechaza por política, la API reintenta con un modelo de respaldo en la misma llamada.
        ...(conRespaldo(this.modelo) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        tools: herramientas.map((h) => ({
          name: h.nombre,
          description: h.descripcion,
          input_schema: h.esquema as Anthropic.Beta.Messages.BetaTool.InputSchema,
        })),
        messages: mensajes.map((m) => ({ role: m.rol === "usuario" ? "user" : "assistant", content: aContenido(m) })),
      })
      return {
        bloques: r.content.flatMap(aBloque),
        nativo: r.content,
        fin: motivo(r.stop_reason),
        uso: { entrada: r.usage.input_tokens, salida: r.usage.output_tokens },
      }
    } catch (e) {
      throw new ErrorLlm(traducirError(e))
    }
  }
}

const conRespaldo = (modelo: string): boolean => /^claude-(opus-5|fable-5)/.test(modelo)

function aContenido(m: Mensaje): Contenido[] {
  if (m.rol === "asistente" && Array.isArray(m.nativo)) return m.nativo as Contenido[]
  return m.bloques.map((b): Contenido => {
    if (b.tipo === "texto") return { type: "text", text: b.texto }
    if (b.tipo === "llamada") return { type: "tool_use", id: b.id, name: b.nombre, input: b.args }
    return { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.esError }
  })
}

function aBloque(b: Anthropic.Beta.Messages.BetaContentBlock): Bloque[] {
  if (b.type === "text") return [{ tipo: "texto", texto: b.text }]
  if (b.type === "tool_use") return [{ tipo: "llamada", id: b.id, nombre: b.name, args: b.input }]
  return []
}

function motivo(stop: string | null): MotivoFin {
  if (stop === "tool_use") return "herramientas"
  if (stop === "max_tokens") return "limite_tokens"
  if (stop === "refusal") return "rechazo"
  if (stop === "pause_turn") return "pausa"
  return "fin"
}

function traducirError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "La clave del modelo no es válida o no está configurada (ANTHROPIC_API_KEY)."
  if (e instanceof Anthropic.RateLimitError) return "El proveedor del modelo está limitando las solicitudes. Intenta de nuevo en unos segundos."
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "El modelo tardó demasiado en responder (timeout). Intenta de nuevo."
  if (e instanceof Anthropic.APIConnectionError) return "No hay conexión con el proveedor del modelo."
  if (e instanceof Anthropic.APIError) return `El proveedor del modelo respondió con error ${e.status ?? ""}.`.trim()
  return "Error inesperado al llamar al modelo."
}
