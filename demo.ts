// Verificación sin modelo: recorre todos los casos llamando directamente a las herramientas.
// Uso: npm run demo
import { promises as fs } from "node:fs"
import path from "node:path"
import { ejecutar } from "./src/tools/index.js"

const directory = process.cwd()
const ctx = { directory, sessionId: "demo" }

type R<T> = { ok: true; data: T } | { ok: false; error: string }
const llamar = async <T>(nombre: string, args: object): Promise<R<T>> => JSON.parse(await ejecutar(nombre, args, ctx)) as R<T>

type Lectura = { pais: string; cliente: string; formato: string; campos: string[] }
type Mapeo = { llenos: unknown[]; faltantes: { etiqueta: string }[]; requiere_confirmacion: { etiqueta: string; nota: string }[] }
type Formulario = { ruta: string; mensaje: string }
type Paquete = { ruta: string; listo_para_firma: boolean; bloqueos: string[] }

async function procesar(caso: string): Promise<void> {
  console.log(`\n=== ${caso} ===`)
  const lectura = await llamar<Lectura>("proveedor_leer_solicitud", { caso })
  if (!lectura.ok) return console.log(`  ERROR: ${lectura.error}`)
  const { pais, cliente, formato, campos } = lectura.data
  console.log(`  Cliente: ${cliente} (${pais}) · formato: ${formato} · ${campos.length} campos`)

  const mapeo = await llamar<Mapeo>("proveedor_mapear_campos", { caso, campos })
  if (mapeo.ok) {
    const m = mapeo.data
    console.log(`  Llenos: ${m.llenos.length} · Faltantes: ${m.faltantes.length} · Por confirmar: ${m.requiere_confirmacion.length}`)
    m.faltantes.forEach((f) => console.log(`    - faltante: ${f.etiqueta}`))
    m.requiere_confirmacion.forEach((c) => console.log(`    - confirmar: ${c.etiqueta} (${c.nota})`))
  } else console.log(`  ERROR mapeo: ${mapeo.error}`)

  const form = await llamar<Formulario>("proveedor_generar_formulario", { caso, ...(mapeo.ok ? { mapeo: mapeo.data } : {}) })
  console.log(form.ok ? `  Formulario: ${form.data.ruta} (${form.data.mensaje})` : `  ERROR formulario: ${form.error}`)

  const paq = await llamar<Paquete>("proveedor_armar_paquete", { caso })
  if (paq.ok) {
    console.log(`  Paquete: ${paq.data.ruta} · listo_para_firma: ${paq.data.listo_para_firma}`)
    paq.data.bloqueos.forEach((b) => console.log(`    - bloqueo: ${b}`))
  } else console.log(`  ERROR paquete: ${paq.error}`)

  const sinConfirmar = await llamar<{ ruta: string }>("proveedor_simular_envio", { caso, confirmado: false })
  console.log(`  Envío sin confirmación: ${sinConfirmar.ok ? "ENVIADO (¡no debería!)" : sinConfirmar.error}`)
}

async function main(): Promise<void> {
  await fs.rm(path.join(directory, "out"), { recursive: true, force: true })
  const casos = (await fs.readdir(path.join(directory, "fixtures", "reto-01", "casos"))).sort()
  for (const caso of casos) await procesar(caso)

  console.log("\n=== Manejo de errores ===")
  const inexistente = await llamar("proveedor_leer_solicitud", { caso: "no-existe" })
  console.log(`  Caso inexistente: ${inexistente.ok ? "?" : inexistente.error}`)
  const invalido = await llamar("proveedor_mapear_campos", { caso: 123 })
  console.log(`  Argumentos inválidos: ${invalido.ok ? "?" : invalido.error}`)

  console.log("\n=== Envío con confirmación explícita (co-industrias-delta) ===")
  const envio = await llamar<{ ruta: string }>("proveedor_simular_envio", { caso: "co-industrias-delta", confirmado: true })
  console.log(`  ${envio.ok ? envio.data.ruta : envio.error}`)
}

main().catch((e: unknown) => {
  console.error("Fallo inesperado en demo:", e)
  process.exit(1)
})
