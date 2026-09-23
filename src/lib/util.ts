import { promises as fs } from "node:fs"
import path from "node:path"

export type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }

export const ok = <T>(data: T): string => JSON.stringify({ ok: true, data })
export const fallo = (error: string): string => JSON.stringify({ ok: false, error })

export const rutaFixtures = (dir: string, ...partes: string[]): string =>
  path.join(dir, "fixtures", "reto-01", ...partes)

export const rutaOut = (dir: string, ...partes: string[]): string => path.join(dir, "out", ...partes)

/** Evita que un nombre de caso escape de la carpeta de casos (../, rutas absolutas). */
export const casoValido = (caso: string): boolean => /^[a-z0-9][a-z0-9-]*$/i.test(caso)

export async function existe(ruta: string): Promise<boolean> {
  try {
    await fs.access(ruta)
    return true
  } catch {
    return false
  }
}

export async function leerJson<T>(ruta: string): Promise<Resultado<T>> {
  let texto: string
  try {
    texto = await fs.readFile(ruta, "utf8")
  } catch {
    return { ok: false, error: `no se encontró el archivo ${path.basename(ruta)}` }
  }
  try {
    return { ok: true, data: JSON.parse(texto) as T }
  } catch {
    return { ok: false, error: `el archivo ${path.basename(ruta)} está corrupto (JSON inválido)` }
  }
}

export async function escribir(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(ruta), { recursive: true })
  await fs.writeFile(ruta, contenido)
}

export async function anexarLinea(ruta: string, objeto: object): Promise<void> {
  await fs.mkdir(path.dirname(ruta), { recursive: true })
  await fs.appendFile(ruta, JSON.stringify(objeto) + "\n")
}

/** Minúsculas, sin tildes ni espacios extra: para comparar etiquetas. */
export const normalizar = (texto: string): string =>
  texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()

/** Lee una clave con puntos ("banco.nombre") de un objeto anidado. */
export function valorEnRuta(objeto: unknown, clave: string): unknown {
  return clave.split(".").reduce<unknown>((actual, parte) => {
    if (actual !== null && typeof actual === "object" && parte in actual) {
      return (actual as Record<string, unknown>)[parte]
    }
    return undefined
  }, objeto)
}

export const hoyIso = (): string => new Date().toISOString().slice(0, 10)

/** RN5: registro por caso en out/<caso>/log.jsonl (solo si el caso existe). */
export async function registrarEnCaso(dir: string, caso: string, entrada: object): Promise<void> {
  if (casoValido(caso) && (await existe(rutaFixtures(dir, "casos", caso)))) {
    await anexarLinea(rutaOut(dir, caso, "log.jsonl"), entrada)
  }
}

/** Ruta relativa a la raíz del proyecto, siempre con "/" (igual en Windows y Linux). */
export const relativa = (dir: string, ruta: string): string => path.relative(dir, ruta).split(path.sep).join("/")
