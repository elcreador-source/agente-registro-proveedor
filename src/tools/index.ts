// Registro de herramientas: nombre visible = <archivo>_<export>.
// Valida argumentos con zod antes de ejecutar y deja traza en out/log.jsonl y out/<caso>/log.jsonl.
import { z } from "zod"
import * as proveedor from "./proveedor.js"
import { anexarLinea, registrarEnCaso, rutaOut } from "../lib/util.js"

export type Contexto = proveedor.Contexto

export type Herramienta = {
  description: string
  args: z.ZodRawShape
  execute(args: never, ctx: Contexto): Promise<string>
}

export type EspecHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

const modulos: Record<string, Record<string, unknown>> = { proveedor }

const esHerramienta = (v: unknown): v is Herramienta =>
  typeof v === "object" && v !== null && "description" in v && "args" in v && "execute" in v

export const herramientas: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(modulos).flatMap(([archivo, mod]) =>
    Object.entries(mod).filter(([, v]) => esHerramienta(v)).map(([nombre, v]) => [`${archivo}_${nombre}`, v as Herramienta]),
  ),
)

/** Especificaciones neutrales (JSON Schema) para cualquier adaptador LLM. */
export const especificaciones = (): EspecHerramienta[] =>
  Object.entries(herramientas).map(([nombre, h]) => ({
    nombre,
    descripcion: h.description,
    esquema: z.toJSONSchema(z.object(h.args)) as Record<string, unknown>,
  }))

type Salida = { ok: boolean; data?: { resumen?: string }; error?: string }

/** Ejecuta una herramienta por nombre. Nunca lanza: todo error vuelve como { ok: false, error }. */
export async function ejecutar(nombre: string, argsBrutos: unknown, ctx: Contexto): Promise<string> {
  const h = herramientas[nombre]
  let resultado: string
  if (!h) {
    resultado = JSON.stringify({ ok: false, error: `herramienta desconocida: ${nombre}` })
  } else {
    const validado = z.object(h.args).safeParse(argsBrutos ?? {})
    if (!validado.success) {
      const detalle = validado.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
      resultado = JSON.stringify({ ok: false, error: `argumentos inválidos: ${detalle}` })
    } else {
      try {
        resultado = await h.execute(validado.data as never, ctx)
      } catch (e) {
        resultado = JSON.stringify({ ok: false, error: `error interno en ${nombre}: ${e instanceof Error ? e.message : "desconocido"}` })
      }
    }
  }
  await registrar(nombre, argsBrutos, resultado, ctx)
  return resultado
}

async function registrar(nombre: string, args: unknown, resultado: string, ctx: Contexto): Promise<void> {
  try {
    const salida = JSON.parse(resultado) as Salida
    const resumen = salida.ok ? (salida.data?.resumen ?? "ok") : (salida.error ?? "error")
    const entrada = { ts: new Date().toISOString(), herramienta: nombre, ok: salida.ok, resumen }
    // El mapeo completo trae datos bancarios: no se copia al log, solo se indica que venía.
    const argsLog = typeof args === "object" && args !== null && "mapeo" in args ? { ...args, mapeo: "[omitido]" } : args
    await anexarLinea(rutaOut(ctx.directory, "log.jsonl"), { ...entrada, sessionId: ctx.sessionId, args: argsLog })
    const caso = typeof args === "object" && args !== null && "caso" in args ? String((args as { caso: unknown }).caso) : ""
    if (caso) await registrarEnCaso(ctx.directory, caso, entrada)
  } catch {
    // El log nunca debe tumbar la herramienta.
  }
}
