// Herramientas del agente "Registro como Proveedor".
// Cada export es una herramienta; el modelo la ve como proveedor_<export>.
// Regla: ninguna herramienta lanza; todas devuelven JSON { ok, data } o { ok: false, error }.
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import reglas from "../knowledge/reglas-pais.json" with { type: "json" }
import {
  casoValido, escribir, existe, fallo, hoyIso, leerJson, normalizar, ok,
  relativa, rutaFixtures, rutaOut, valorEnRuta, type Resultado,
} from "../lib/util.js"

export type Contexto = { directory: string; sessionId: string }

// ---------- Tipos de dominio ----------

type Formato = "xlsx" | "pdf" | "portal"
type Solicitud = {
  id: string; de: string; asunto: string; fecha: string; pais: string
  cliente: string; formato: string; cuerpo: string; adjuntos: string[]
}
type CeldaPlantilla = { hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }
type CampoPlantilla = { etiqueta: string; obligatorio: boolean }
type Soporte = { tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string }

type Campo = { etiqueta: string; obligatorio: boolean; hoja?: string; celda_etiqueta?: string; celda_valor?: string }
type Caso = { solicitud: Solicitud; formato: Formato | null; campos: Campo[]; soportes: string[]; advertencias: string[] }

type CampoLleno = { etiqueta: string; clave: string; ruta: string; valor: string; confianza: number }
type CampoFaltante = { etiqueta: string; motivo: string }
type CampoConfirmar = CampoLleno & { nota: string; propuesta: string | null }
type Mapeo = { llenos: CampoLleno[]; faltantes: CampoFaltante[]; requiere_confirmacion: CampoConfirmar[] }

type EstadoSoporte = { tipo: string; nombre: string; estado: "presente" | "ausente" | "vencido"; archivo: string | null; vigencia_hasta: string | null }

const FORMATOS: readonly Formato[] = ["xlsx", "pdf", "portal"]
const UMBRAL_CONFIANZA = 0.8
const identificadores: Record<string, string> = reglas.identificador_tributario
const nombresSoportes: Record<string, string> = reglas.nombres_soportes

// ---------- Carga de datos ----------

async function cargarCaso(dir: string, caso: string): Promise<Resultado<Caso>> {
  if (!casoValido(caso)) return { ok: false, error: `nombre de caso inválido: "${caso}"` }
  const base = rutaFixtures(dir, "casos", caso)
  if (!(await existe(base))) return { ok: false, error: `el caso "${caso}" no existe en fixtures/reto-01/casos/` }

  const sol = await leerJson<Solicitud>(path.join(base, "solicitud.json"))
  if (!sol.ok) return sol

  const advertencias: string[] = []
  const formato = FORMATOS.find((f) => f === sol.data.formato) ?? null
  if (!formato) advertencias.push(`formato no soportado: "${sol.data.formato}"`)

  const campos = await cargarCampos(base, formato, advertencias)
  const soportesRes = await leerJson<string[]>(path.join(base, "soportes-exigidos.json"))
  if (!soportesRes.ok) advertencias.push(`soportes exigidos: ${soportesRes.error}`)
  const soportes = soportesRes.ok && Array.isArray(soportesRes.data) ? soportesRes.data : []

  return { ok: true, data: { solicitud: sol.data, formato, campos, soportes, advertencias } }
}

async function cargarCampos(base: string, formato: Formato | null, advertencias: string[]): Promise<Campo[]> {
  if (formato === "xlsx") {
    const r = await leerJson<CeldaPlantilla[]>(path.join(base, "plantilla-celdas.json"))
    if (r.ok && Array.isArray(r.data) && r.data.every((c) => c.etiqueta && c.hoja && c.celda_valor)) {
      return r.data.map((c) => ({ ...c, obligatorio: true }))
    }
    advertencias.push(`plantilla Excel: ${r.ok ? "estructura inválida" : r.error}`)
    return []
  }
  const r = await leerJson<CampoPlantilla[]>(path.join(base, "plantilla-campos.json"))
  if (r.ok && Array.isArray(r.data) && r.data.every((c) => typeof c.etiqueta === "string")) {
    return r.data.map((c) => ({ etiqueta: c.etiqueta, obligatorio: Boolean(c.obligatorio) }))
  }
  advertencias.push(`plantilla de campos: ${r.ok ? "estructura inválida" : r.error}`)
  return []
}

// ---------- Mapeo contra el maestro ----------

async function calcularMapeo(dir: string, pais: string, etiquetas: string[]): Promise<Resultado<Mapeo>> {
  const maestro = await leerJson<Record<string, unknown>>(rutaFixtures(dir, "repositorio", "maestro.json"))
  if (!maestro.ok) return maestro
  const glosario = await leerJson<Record<string, string>>(rutaFixtures(dir, "glosario-campos.json"))
  if (!glosario.ok) return glosario

  const mapeo: Mapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] }
  for (const etiqueta of etiquetas) {
    const { clave, confianza } = resolverClave(etiqueta, glosario.data)
    if (!clave) {
      mapeo.faltantes.push({ etiqueta, motivo: "sin equivalente en el glosario ni en el maestro" })
      continue
    }
    const bruto = valorEnRuta(maestro.data, clave)
    if (bruto === undefined || bruto === null || bruto === "") {
      mapeo.faltantes.push({ etiqueta, motivo: `la clave "${clave}" no tiene valor en el maestro` })
      continue
    }
    const lleno: CampoLleno = { etiqueta, clave, ruta: `maestro.json#${clave}`, valor: String(bruto), confianza }
    const regla = reglaConfirmacion(etiqueta, clave, pais, confianza)
    if (regla) mapeo.requiere_confirmacion.push({ ...lleno, ...regla })
    else mapeo.llenos.push(lleno)
  }
  return { ok: true, data: mapeo }
}

function resolverClave(etiqueta: string, glosario: Record<string, string>): { clave: string | null; confianza: number } {
  if (glosario[etiqueta]) return { clave: glosario[etiqueta], confianza: 1 }
  const normal = normalizar(etiqueta)
  const similar = Object.keys(glosario).find((k) => normalizar(k) === normal)
  if (similar) return { clave: glosario[similar], confianza: 0.9 }
  return { clave: null, confianza: 0 }
}

function reglaConfirmacion(etiqueta: string, clave: string, pais: string, confianza: number): { nota: string; propuesta: string | null } | null {
  const equivalente = identificadores[pais] ?? null
  if (clave === "nit" && pais !== reglas.pais_maestro) {
    return { nota: `identificador extranjero: el cliente (${pais}) pide ${equivalente ?? "su identificador"}; Periferia solo tiene NIT colombiano`, propuesta: equivalente }
  }
  if (reglas.etiquetas_ambiguas.includes(etiqueta)) {
    return { nota: "etiqueta ambigua", propuesta: equivalente }
  }
  if (confianza < UMBRAL_CONFIANZA) return { nota: `mapeo con confianza ${confianza}`, propuesta: null }
  return null
}

const estadoDe = (mapeo: Mapeo, etiqueta: string): { valor: string; estado: "lleno" | "faltante" | "requiere_confirmacion" } => {
  const lleno = mapeo.llenos.find((c) => c.etiqueta === etiqueta)
  if (lleno) return { valor: lleno.valor, estado: "lleno" }
  const conf = mapeo.requiere_confirmacion.find((c) => c.etiqueta === etiqueta)
  if (conf) return { valor: conf.valor, estado: "requiere_confirmacion" }
  return { valor: "", estado: "faltante" }
}

// ---------- Generadores de formulario ----------

async function generarXlsx(ruta: string, campos: Campo[], mapeo: Mapeo): Promise<void> {
  const libro = new ExcelJS.Workbook()
  for (const campo of campos) {
    if (!campo.hoja || !campo.celda_etiqueta || !campo.celda_valor) continue
    const hoja = libro.getWorksheet(campo.hoja) ?? libro.addWorksheet(campo.hoja)
    const etiqueta = hoja.getCell(campo.celda_etiqueta)
    etiqueta.value = campo.etiqueta
    etiqueta.font = { bold: true }
    const { valor, estado } = estadoDe(mapeo, campo.etiqueta)
    const celda = hoja.getCell(campo.celda_valor)
    celda.value = valor
    if (estado !== "lleno") celda.note = estado === "faltante" ? "FALTANTE: no existe en el maestro" : "REQUIERE CONFIRMACIÓN"
    hoja.getColumn(etiqueta.col).width = 34
    hoja.getColumn(celda.col).width = 48
  }
  await escribir(ruta, new Uint8Array(await libro.xlsx.writeBuffer()))
}

/** Helvetica estándar solo admite WinAnsi: se reemplazan caracteres fuera de ese rango. */
const textoPdf = (t: string): string => t.replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")

async function generarPdf(ruta: string, caso: Caso, mapeo: Mapeo): Promise<void> {
  const pdf = await PDFDocument.create()
  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  let pagina = pdf.addPage([595, 842])
  let y = 800
  const linea = (texto: string, fuente: PDFFont, tam: number, color = rgb(0, 0, 0)): void => {
    if (y < 60) { pagina = pdf.addPage([595, 842]); y = 800 }
    dibujar(pagina, textoPdf(texto), fuente, tam, y, color)
    y -= tam + 6
  }
  linea("Formulario de registro de proveedor", negrita, 16)
  linea(`Cliente: ${caso.solicitud.cliente} (${caso.solicitud.pais})`, normal, 11)
  linea(`Proveedor: Periferia IT Group S.A.S.  -  Generado: ${hoyIso()}`, normal, 11)
  y -= 10
  for (const campo of caso.campos) {
    const { valor, estado } = estadoDe(mapeo, campo.etiqueta)
    linea(`${campo.etiqueta}${campo.obligatorio ? " *" : ""}`, negrita, 10)
    const marca = estado === "faltante" ? "[FALTANTE]" : estado === "requiere_confirmacion" ? `${valor}  [REQUIERE CONFIRMACION]` : valor
    linea(marca, normal, 10, estado === "lleno" ? rgb(0, 0, 0) : rgb(0.75, 0.1, 0.1))
    y -= 4
  }
  y -= 20
  linea("Firma del representante legal: ______________________________", normal, 11)
  await escribir(ruta, await pdf.save())
}

function dibujar(pagina: PDFPage, texto: string, fuente: PDFFont, tam: number, y: number, color: ReturnType<typeof rgb>): void {
  pagina.drawText(texto, { x: 50, y, size: tam, font: fuente, color, maxWidth: 495 })
}

async function generarPortal(ruta: string, caso: Caso, mapeo: Mapeo): Promise<void> {
  const filas = caso.campos.map((c) => {
    const { valor, estado } = estadoDe(mapeo, c.etiqueta)
    return `| ${c.etiqueta} | ${valor || "—"} | ${estado} |`
  })
  const md = [
    `# Valores para el portal — ${caso.solicitud.cliente}`,
    "",
    "> Formato **portal web**: no soportado para llenado automático. Copie estos valores en el portal.",
    "> El ingreso de credenciales y el clic en \"Enviar\" los hace una persona.",
    "",
    "| Campo | Valor | Estado |",
    "|---|---|---|",
    ...filas,
    "",
  ].join("\n")
  await escribir(ruta, md)
}

const nombreFormulario = (formato: Formato): string =>
  formato === "xlsx" ? "formulario.xlsx" : formato === "pdf" ? "formulario.pdf" : "valores-portal.md"

async function generarInterno(dir: string, caso: Caso): Promise<Resultado<{ ruta: string; formato: Formato; mapeo: Mapeo }>> {
  if (!caso.formato) return { ok: false, error: `formato no soportado: "${caso.solicitud.formato}"` }
  const mapeo = await calcularMapeo(dir, caso.solicitud.pais, caso.campos.map((c) => c.etiqueta))
  if (!mapeo.ok) return mapeo
  const ruta = rutaOut(dir, caso.solicitud.id, nombreFormulario(caso.formato))
  try {
    if (caso.formato === "xlsx") await generarXlsx(ruta, caso.campos, mapeo.data)
    else if (caso.formato === "pdf") await generarPdf(ruta, caso, mapeo.data)
    else await generarPortal(ruta, caso, mapeo.data)
    await escribir(rutaOut(dir, caso.solicitud.id, "faltantes.md"), reporteFaltantes(caso, mapeo.data))
  } catch (e) {
    return { ok: false, error: `no se pudo escribir el formulario: ${e instanceof Error ? e.message : "error desconocido"}` }
  }
  return { ok: true, data: { ruta: relativa(dir, ruta), formato: caso.formato, mapeo: mapeo.data } }
}

function reporteFaltantes(caso: Caso, mapeo: Mapeo): string {
  const faltan = mapeo.faltantes.map((f) => `- **${f.etiqueta}**: ${f.motivo}`)
  const conf = mapeo.requiere_confirmacion.map((c) => `- **${c.etiqueta}** = \`${c.valor}\` — ${c.nota}`)
  return [
    `# Reporte de campos — ${caso.solicitud.cliente}`, "",
    `## Faltantes (${faltan.length})`, ...(faltan.length ? faltan : ["- Ninguno"]), "",
    `## Requieren confirmación (${conf.length})`, ...(conf.length ? conf : ["- Ninguno"]), "",
  ].join("\n")
}

// ---------- Paquete para firma ----------

async function evaluarSoportes(dir: string, exigidos: string[], fecha: string): Promise<Resultado<EstadoSoporte[]>> {
  const indice = await leerJson<Soporte[]>(rutaFixtures(dir, "repositorio", "soportes", "index.json"))
  if (!indice.ok) return indice
  const estados: EstadoSoporte[] = []
  for (const tipo of exigidos) {
    const s = indice.data.find((x) => x.tipo === tipo)
    const nombre = nombresSoportes[tipo] ?? tipo
    const archivoExiste = s ? await existe(rutaFixtures(dir, "repositorio", "soportes", s.archivo)) : false
    if (!s || !archivoExiste) {
      estados.push({ tipo, nombre, estado: "ausente", archivo: null, vigencia_hasta: null })
      continue
    }
    const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < fecha
    estados.push({ tipo, nombre, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta })
  }
  return { ok: true, data: estados }
}

function checklistMd(caso: Caso, soportes: EstadoSoporte[], mapeo: Mapeo, listo: boolean, fecha: string): string {
  const icono = { presente: "[x]", ausente: "[ ] AUSENTE", vencido: "[ ] VENCIDO" }
  const filas = soportes.map((s) => `- ${icono[s.estado]} ${s.nombre}${s.vigencia_hasta ? ` (vigente hasta ${s.vigencia_hasta})` : ""}`)
  return [
    `# Checklist — ${caso.solicitud.cliente}`, "",
    `Fecha de revisión: ${fecha}`,
    `Estado: **${listo ? "LISTO PARA FIRMA" : "BLOQUEADO"}**`, "",
    "## Soportes", ...filas, "",
    `## Campos del formulario`,
    `- Llenos: ${mapeo.llenos.length}`,
    `- Requieren confirmación: ${mapeo.requiere_confirmacion.length}${mapeo.requiere_confirmacion.map((c) => `\n  - ${c.etiqueta}: ${c.nota}`).join("")}`,
    `- Faltantes (no bloquean): ${mapeo.faltantes.length}${mapeo.faltantes.map((f) => `\n  - ${f.etiqueta}`).join("")}`, "",
  ].join("\n")
}

/** RN2: el borrador nunca incluye datos bancarios; solo nombra los adjuntos. */
function borradorCorreo(caso: Caso, formulario: string, soportes: EstadoSoporte[], faltantes: CampoFaltante[]): string {
  const adjuntos = [formulario, ...soportes.filter((s) => s.estado === "presente").map((s) => s.nombre)]
  return [
    `**Para:** ${caso.solicitud.de}`,
    `**Asunto:** RE: ${caso.solicitud.asunto}`, "",
    "Buen día,", "",
    `Adjuntamos la documentación solicitada para el registro de Periferia IT Group S.A.S. como proveedor de ${caso.solicitud.cliente}:`, "",
    ...adjuntos.map((a) => `- ${a}`), "",
    ...(faltantes.length ? [`Quedamos atentos para completar los siguientes campos: ${faltantes.map((f) => f.etiqueta).join(", ")}.`, ""] : []),
    "Cordialmente,", "Área Administrativa — Periferia IT Group S.A.S.", "",
    "_Borrador pendiente de firma del representante legal. No enviado._", "",
  ].join("\n")
}

// ---------- Herramientas ----------

export const leer_solicitud = {
  description: "Lee el correo y la plantilla de un caso y devuelve país, cliente, formato de salida, campos pedidos y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, ej. ec-corp-andina"),
  },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    const r = await cargarCaso(ctx.directory, args.caso)
    if (!r.ok) return fallo(r.error)
    const { solicitud, formato, campos, soportes, advertencias } = r.data
    const pais = solicitud.pais
    const ambiguos = campos
      .filter((c) => reglas.etiquetas_ambiguas.includes(c.etiqueta))
      .map((c) => ({ etiqueta: c.etiqueta, estado: "requiere_confirmacion", propuesta: identificadores[pais] ?? null }))
    return ok({
      pais, cliente: solicitud.cliente, formato: formato ?? solicitud.formato, asunto: solicitud.asunto,
      campos: campos.map((c) => c.etiqueta), soportes, campos_ambiguos: ambiguos, advertencias,
      resumen: `${campos.length} campos, ${soportes.length} soportes, formato ${solicitud.formato}`,
    })
  },
}

const esquemaMapeo = z.object({
  llenos: z.array(z.object({ etiqueta: z.string(), valor: z.string() }).passthrough()).describe("Campos llenos"),
  faltantes: z.array(z.object({ etiqueta: z.string() }).passthrough()).describe("Campos faltantes"),
  requiere_confirmacion: z.array(z.object({ etiqueta: z.string() }).passthrough()).describe("Campos por confirmar"),
})

export const mapear_campos = {
  description: "Cruza cada campo solicitado con el repositorio maestro y lo clasifica como lleno, faltante o requiere_confirmacion.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    campos: z.array(z.string()).describe("Etiquetas de los campos tal como las devolvió proveedor_leer_solicitud"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: Contexto): Promise<string> {
    const r = await cargarCaso(ctx.directory, args.caso)
    if (!r.ok) return fallo(r.error)
    const m = await calcularMapeo(ctx.directory, r.data.solicitud.pais, args.campos)
    if (!m.ok) return fallo(m.error)
    return ok({
      ...m.data,
      resumen: `${m.data.llenos.length} llenos, ${m.data.faltantes.length} faltantes, ${m.data.requiere_confirmacion.length} por confirmar`,
    })
  },
}

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato del cliente (xlsx o pdf); para portal web produce valores-portal.md.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: esquemaMapeo.optional().describe("Resultado de proveedor_mapear_campos; los valores se vuelven a leer del maestro"),
  },
  async execute(args: { caso: string; mapeo?: z.infer<typeof esquemaMapeo> }, ctx: Contexto): Promise<string> {
    const r = await cargarCaso(ctx.directory, args.caso)
    if (!r.ok) return fallo(r.error)
    const g = await generarInterno(ctx.directory, r.data)
    if (!g.ok) return fallo(g.error)
    // CA2: los valores escritos salen del maestro, no del modelo. Si el mapeo recibido difiere, se informa.
    const discrepancias = (args.mapeo?.llenos ?? [])
      .filter((c) => estadoDe(g.data.mapeo, c.etiqueta).valor !== c.valor)
      .map((c) => c.etiqueta)
    const soportado = g.data.formato !== "portal"
    return ok({
      ruta: g.data.ruta, formato: g.data.formato, soportado,
      mensaje: soportado ? "formulario generado" : "formato no soportado: portal web. Se generaron los valores listos para copiar.",
      reporte_faltantes: relativa(ctx.directory, rutaOut(ctx.directory, args.caso, "faltantes.md")),
      discrepancias_con_mapeo_recibido: discrepancias,
      resumen: soportado ? `${g.data.formato} en ${g.data.ruta}` : `formato no soportado (portal); ${g.data.ruta}`,
    })
  },
}

export const armar_paquete = {
  description: "Arma out/<caso>/paquete/ con formulario, soportes vigentes, checklist.md y borrador-correo.md, e indica si está listo para firma.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    fecha_referencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Fecha YYYY-MM-DD para evaluar vigencias; por defecto hoy"),
  },
  async execute(args: { caso: string; fecha_referencia?: string }, ctx: Contexto): Promise<string> {
    const dir = ctx.directory
    const fecha = args.fecha_referencia ?? hoyIso()
    const r = await cargarCaso(dir, args.caso)
    if (!r.ok) return fallo(r.error)
    const caso = r.data
    const g = await generarInterno(dir, caso)
    const soportes = await evaluarSoportes(dir, caso.soportes, fecha)
    if (!soportes.ok) return fallo(soportes.error)

    const paquete = rutaOut(dir, args.caso, "paquete")
    try {
      await fs.rm(paquete, { recursive: true, force: true })
      await fs.mkdir(path.join(paquete, "soportes"), { recursive: true })
      if (g.ok) await fs.copyFile(path.join(dir, g.data.ruta), path.join(paquete, path.basename(g.data.ruta)))
      for (const s of soportes.data.filter((x) => x.estado === "presente" && x.archivo)) {
        await fs.copyFile(rutaFixtures(dir, "repositorio", "soportes", s.archivo ?? ""), path.join(paquete, "soportes", s.archivo ?? ""))
      }
      const mapeo: Mapeo = g.ok ? g.data.mapeo : { llenos: [], faltantes: [], requiere_confirmacion: [] }
      const listo = g.ok && soportes.data.every((s) => s.estado === "presente")
      const formulario = g.ok ? path.basename(g.data.ruta) : "(formulario no generado)"
      await escribir(path.join(paquete, "checklist.md"), checklistMd(caso, soportes.data, mapeo, listo, fecha))
      await escribir(path.join(paquete, "borrador-correo.md"), borradorCorreo(caso, formulario, soportes.data, mapeo.faltantes))
      const bloqueos = [
        ...(g.ok ? [] : [g.error]),
        ...soportes.data.filter((s) => s.estado !== "presente").map((s) => `${s.nombre}: ${s.estado}`),
      ]
      await escribir(rutaOut(dir, args.caso, "estado.json"), JSON.stringify({ listo_para_firma: listo, bloqueos, fecha }, null, 2))
      return ok({
        ruta: relativa(dir, paquete), listo_para_firma: listo, bloqueos,
        checklist: soportes.data.map((s) => ({ tipo: s.tipo, estado: s.estado, vigencia_hasta: s.vigencia_hasta })),
        campos_faltantes: mapeo.faltantes.map((f) => f.etiqueta),
        campos_por_confirmar: mapeo.requiere_confirmacion.map((c) => ({ etiqueta: c.etiqueta, nota: c.nota })),
        resumen: `${listo ? "listo_para_firma" : "bloqueado"}; ${bloqueos.length} bloqueos`,
      })
    } catch (e) {
      return fallo(`no se pudo armar el paquete: ${e instanceof Error ? e.message : "error desconocido"}`)
    }
  },
}

export const simular_envio = {
  description: "Simula el envío del paquete escribiendo ENVIO-SIMULADO.md; solo procede con confirmación explícita del usuario.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("true solo si el usuario confirmó el envío en su último mensaje"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Contexto): Promise<string> {
    if (!args.confirmado) return fallo("requiere confirmación explícita")
    if (!casoValido(args.caso)) return fallo(`nombre de caso inválido: "${args.caso}"`)
    const estado = await leerJson<{ listo_para_firma: boolean; bloqueos: string[] }>(rutaOut(ctx.directory, args.caso, "estado.json"))
    if (!estado.ok) return fallo("primero hay que armar el paquete con proveedor_armar_paquete")
    const sol = await leerJson<Solicitud>(rutaFixtures(ctx.directory, "casos", args.caso, "solicitud.json"))
    if (!sol.ok) return fallo(sol.error)
    const ruta = rutaOut(ctx.directory, args.caso, "ENVIO-SIMULADO.md")
    const md = [
      "# Envío simulado", "",
      `- Fecha: ${new Date().toISOString()}`,
      `- Destinatario: ${sol.data.de}`,
      `- Asunto: RE: ${sol.data.asunto}`,
      `- Paquete: out/${args.caso}/paquete/`,
      `- Estado del paquete: ${estado.data.listo_para_firma ? "listo para firma" : "BLOQUEADO"}`,
      ...(estado.data.bloqueos.length ? ["", "## Advertencias al momento del envío", ...estado.data.bloqueos.map((b) => `- ${b}`)] : []),
      "", "_Simulación: no se envió ningún correo real._", "",
    ].join("\n")
    await escribir(ruta, md)
    return ok({ ruta: relativa(ctx.directory, ruta), resumen: "envío simulado registrado" })
  },
}

