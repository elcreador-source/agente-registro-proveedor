// Genera y verifica modulo/: el agente empaquetado para otras plataformas de agentes.
// Las tres piezas salen de las mismas fuentes que usa la aplicación, nunca de copias editadas a mano:
//   agent.md                         ← agent/prompt.md
//   skill/registro-proveedor/SKILL.md ← src/knowledge/registro-proveedor.md
//   tools/proveedor.ts               → reexporta src/tools/proveedor.ts
import { promises as fs } from "node:fs"
import path from "node:path"

type Pieza = { ruta: string; contenido: string }

const FM_AGENTE = [
  "---",
  "description: Prepara formularios de registro como proveedor y el paquete para firma desde el repositorio maestro; nunca firma ni envía sin confirmación.",
  "mode: primary",
  "permission:",
  "  edit: deny",
  "  bash: deny",
  "---",
  "",
].join("\n")

const FM_SKILL = [
  "---",
  "name: registro-proveedor",
  "description: Proceso de registro de Periferia como proveedor ante clientes — estados de campo, identificador tributario por país, vigencia de soportes y manejo de datos bancarios.",
  "---",
  "",
].join("\n")

const TOOLS = [
  "// Herramientas del agente, importables sin el servidor HTTP.",
  "// Es el mismo código que usa la aplicación: este archivo solo lo reexporta.",
  'export * from "../../src/tools/proveedor.js"',
  "",
].join("\n")

async function piezas(dir: string): Promise<Pieza[]> {
  const prompt = await fs.readFile(path.join(dir, "agent", "prompt.md"), "utf8")
  const conocimiento = await fs.readFile(path.join(dir, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return [
    { ruta: path.join("modulo", "agent.md"), contenido: FM_AGENTE + prompt },
    { ruta: path.join("modulo", "skill", "registro-proveedor", "SKILL.md"), contenido: FM_SKILL + "# Registro como proveedor\n\n" + conocimiento },
    { ruta: path.join("modulo", "tools", "proveedor.ts"), contenido: TOOLS },
  ]
}

/** Crea o actualiza modulo/ a partir de las fuentes. */
export async function generarModulo(dir: string): Promise<string[]> {
  const lista = await piezas(dir)
  for (const p of lista) {
    await fs.mkdir(path.dirname(path.join(dir, p.ruta)), { recursive: true })
    await fs.writeFile(path.join(dir, p.ruta), p.contenido)
  }
  return lista.map((p) => p.ruta)
}

/** Devuelve las piezas de modulo/ que difieren de sus fuentes (vacío = sincronizado). */
export async function verificarModulo(dir: string): Promise<string[]> {
  const distintas: string[] = []
  for (const p of await piezas(dir)) {
    const actual = await fs.readFile(path.join(dir, p.ruta), "utf8").catch(() => null)
    // Git en Windows puede convertir LF a CRLF: se comparan sin distinguir finales de línea.
    if (actual?.replace(/\r\n/g, "\n") !== p.contenido.replace(/\r\n/g, "\n")) distintas.push(p.ruta)
  }
  return distintas
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const dir = process.cwd()
  const modo = process.argv.includes("--check") ? "check" : "build"
  const accion = modo === "check" ? verificarModulo(dir) : generarModulo(dir)
  accion.then((rutas) => {
    if (modo === "build") console.log(`modulo/ generado:\n${rutas.map((r) => `  - ${r}`).join("\n")}`)
    else if (rutas.length) { console.error(`modulo/ desincronizado: ${rutas.join(", ")}. Ejecuta npm run modulo`); process.exit(1) }
    else console.log("modulo/ sincronizado con agent/prompt.md, src/knowledge y src/tools")
  })
}
