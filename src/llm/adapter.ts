// Interfaz propia del proveedor LLM. El ciclo del agente solo conoce estos tipos;
// cambiar de proveedor = escribir otra implementación de AdaptadorLlm.
import type { EspecHerramienta } from "../tools/index.js"

export type BloqueTexto = { tipo: "texto"; texto: string }
export type BloqueLlamada = { tipo: "llamada"; id: string; nombre: string; args: unknown }
export type BloqueResultado = { tipo: "resultado"; id: string; contenido: string; esError: boolean }
export type Bloque = BloqueTexto | BloqueLlamada | BloqueResultado

export type Mensaje = {
  rol: "usuario" | "asistente"
  bloques: Bloque[]
  /** Contenido original del proveedor (p. ej. bloques de razonamiento) que debe reenviarse intacto. */
  nativo?: unknown
}

export type MotivoFin = "fin" | "herramientas" | "limite_tokens" | "rechazo" | "pausa"

export type RespuestaLlm = {
  bloques: Bloque[]
  nativo: unknown
  fin: MotivoFin
  uso: { entrada: number; salida: number }
}

export interface AdaptadorLlm {
  readonly proveedor: string
  readonly modelo: string
  enviar(system: string, mensajes: Mensaje[], herramientas: EspecHerramienta[]): Promise<RespuestaLlm>
}

/** Error del proveedor ya traducido a un mensaje legible para el chat. */
export class ErrorLlm extends Error {}
