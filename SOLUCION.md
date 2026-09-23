# SOLUCIÓN — Reto 01 · Agente "Registro como Proveedor"

## 1. Problema en una frase

El área administrativa transcribe a mano, en cada uno de los 8–12 registros de proveedor al mes, datos que ya existen en un repositorio interno. **Le duele a la analista administrativa** (retrabajo y riesgo de error en NIT y cuenta bancaria) **y a la empresa** (el proceso depende de una persona y la facturación se retrasa).

## 2. Arquitectura

```
┌───────────────┐ POST /api/chat ┌───────────────────────────────────────────────┐
│ web/index.html│ ─────────────▶ │ src/server.ts   (HTTP, sesiones en memoria,   │
│ chat, tool    │ ◀───────────── │                  topes de tokens)             │
│ calls, banner │  reply,        │      │                                        │
│ de confirmar  │  toolCalls,    │      ▼                                        │
└───────────────┘  needsConfirm. │ src/agente.ts   (ciclo del agente, control    │
                                 │                  de confirmación)             │
                                 │      │                    │                   │
                                 │      ▼                    ▼                   │
                                 │ src/llm/adapter.ts   src/tools/index.ts       │
                                 │ (interfaz propia)    (zod + logs)             │
                                 │      │                    │                   │
                                 │ src/llm/anthropic.ts src/tools/proveedor.ts   │
                                 └──────┼────────────────────┼───────────────────┘
                                        ▼                    ▼
                                  API Anthropic     fixtures/ (solo lectura)
                                                    out/      (escritura)
```

| Capa | Dónde vive |
|---|---|
| **Comportamiento** | `agent/prompt.md`: rol, orden de trabajo, reglas no negociables, marca de confirmación. |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` (proceso, estados, RN1–RN3) y `src/knowledge/reglas-pais.json` (identificador por país, etiquetas ambiguas, nombres de soportes). |
| **Ejecución** | `src/tools/proveedor.ts`: cada export es una herramienta `proveedor_<export>`, importable desde `demo.ts` sin servidor. |

Cambiar una regla de negocio, como agregar un país o una etiqueta ambigua, toca solo `reglas-pais.json` o el glosario. No toca el servidor.

## 3. Ciclo del agente

`src/agente.ts` → `turno()`:

1. Se agrega el mensaje del usuario a la sesión.
2. Bucle `for` con tope de `MAX_ITERACIONES` (25):
   - se llama a `llm.enviar(system, mensajes, herramientas)`;
   - si el modelo pidió herramientas, se ejecutan **todas**, se devuelven sus resultados en un solo mensaje y se repite;
   - si no pidió herramientas, su texto es la respuesta.
3. **Tope de iteraciones (CA1)**: si se alcanza, el agente responde con la lista de lo que hizo y pide continuar.
4. **Tope de tokens**: se aplica por sesión (`MAX_TOKENS_SESION`) y global del proceso (`MAX_TOKENS_TOTAL`), para que el link público no gaste la clave sin límite.
5. **Errores (CA5)**: un error del proveedor se traduce a español (clave inválida, timeout, límite de tasa) y se muestra en el chat. La sesión sigue viva.

**Confirmación humana (CA3 / RN4)**, en dos capas:
- **Prompt**: antes de `proveedor_simular_envio` el modelo pregunta y termina el turno con la marca `[CONFIRMACION]`. El servidor la retira del texto y devuelve `needsConfirmation: true`, y el front muestra un aviso amarillo con los botones *Sí, confirmo* / *No*.
- **Servidor**: la sesión recuerda que se pidió confirmación. Aunque el modelo llame `simular_envio` con `confirmado: true`, el servidor lo rechaza si el mensaje inmediatamente anterior del usuario no es afirmativo ("sí", "confirmo", "envía"…, sin "no"/"todavía"). El diseño no depende de que el modelo obedezca.

**Trazabilidad (CA4 / RN5)**: cada llamada queda visible en el chat (nombre, argumentos, resumen) y se registra en `out/log.jsonl` y `out/<caso>/log.jsonl` con `{ ts, herramienta, ok, resumen }`.

## 4. Elección del modelo

- **Proveedor:** Anthropic. **Modelo:** `claude-sonnet-5`, con esfuerzo `medium`; se puede cambiar con `ANTHROPIC_MODEL`.
- **Por qué:** el trabajo difícil (mapeo, vigencias, reglas) lo hacen herramientas deterministas. El modelo solo orquesta 4 o 5 llamadas en un orden fijo y redacta el resumen. Sonnet 5 maneja bien el uso de herramientas en español, a menos de la mitad del precio de Opus 5 ($2 / $10 por millón de tokens de entrada / salida).
- **Costo estimado por caso**: unas 5 llamadas al modelo, con unos 40 mil tokens de entrada acumulados (system prompt, herramientas e historial) y unos 2 mil de salida. Son ≈ 40k × $2/M + 2k × $10/M ≈ **US$0,10 por caso** procesado, más ≈ US$0,03 por el turno de envío.
- **Cambiar de proveedor**: basta escribir otra clase que implemente `AdaptadorLlm` (`src/llm/adapter.ts`). El ciclo solo usa tipos neutrales (`Mensaje`, `Bloque`, `RespuestaLlm`).

## 5. Diseño del portal web (sección 7.4)

**Qué hace hoy el sistema**: responde "formato no soportado" y produce `out/<caso>/valores-portal.md`, una tabla campo / valor / estado lista para copiar.

**Estrategia para automatizarlo**: un **navegador controlado por el agente** (Playwright), con un paso de "copiloto" y no un llenado desatendido.
- Por cada portal se mantiene un **perfil**: URL, selectores por etiqueta visible (no por posición) y mapa etiqueta → clave del glosario. El agente llena solo los campos cuyo selector resuelve con confianza.
- **Límites**:
  - **CAPTCHA y MFA**: los resuelve siempre el humano; el agente no intenta evadirlos.
  - **Cambios de layout**: si un selector no aparece, el agente se detiene y reporta el campo en lugar de adivinar.
  - **Carga de archivos**: el agente deja los soportes listos para seleccionar.
- Alternativas descartadas:
  - **RPA tradicional**: es frágil ante cambios de layout y costosa de mantener para 1 o 2 portales al mes.
  - **Extensión de navegador**: sería buena para uso humano, pero requiere instalación y distribución.

**Credenciales**:
- Nunca van en el repositorio, en el prompt, en los argumentos de herramientas ni en los logs.
- El cliente las envía al correo del representante legal. **El humano las ingresa directamente en el navegador**, así que el agente nunca las ve.
- Si se quisiera reutilizar sesiones, se guardaría la cookie de sesión en un gestor de secretos (Azure Key Vault o similar) con expiración corta, nunca el usuario y la contraseña.

**Qué hace cada uno**:

| Agente | Humano |
|---|---|
| Abre el portal y espera el login | Ingresa usuario, contraseña, MFA y CAPTCHA |
| Llena los campos mapeados y resalta faltantes y confirmaciones | Revisa, completa y corrige |
| Adjunta o prepara los soportes vigentes | Verifica los adjuntos |
| Toma una captura del formulario lleno como evidencia | **Hace clic en "Enviar"** |

## 6. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Los valores del formulario los re-lee la herramienta desde el maestro**, aunque el modelo envíe un `mapeo` | Escribir los valores que el modelo pasa en `mapeo` | El modelo no puede introducir un valor inventado (CA2). Si el mapeo recibido difiere, se reporta en `discrepancias_con_mapeo_recibido`. |
| 2 | **La confirmación se valida en el servidor**, además del prompt | Confiar en que el modelo pregunte y pase `confirmado: true` solo cuando corresponde | Un modelo puede equivocarse o ser inducido por el texto del usuario; la acción externa necesita un control determinista. |
| 3 | **Ciclo manual con un adaptador propio** | Tool Runner del SDK o un framework de agentes (LangChain, etc.) | El PRD exige una interfaz propia intercambiable. El ciclo manual deja controlar el tope de iteraciones, el de tokens y la confirmación sin dependencias beta. |
| 4 | **`node:http` sin framework** | Express o Fastify | Son 3 rutas y un HTML estático. Una dependencia menos que justificar y auditar. |
| 5 | **PDF generado con `pdf-lib`** (etiqueta y valor en orden) | Rellenar un AcroForm | No hay PDF original del cliente en los fixtures y el PRD acepta un PDF generado. |
| 6 | **El mapeo completo no se guarda en `out/log.jsonl`** | Loguear todos los argumentos | El mapeo incluye datos bancarios (RN2); el log registra `"[omitido]"`. |
| 7 | **`modulo/` generado y verificado desde las fuentes**, con reexport de las herramientas | Copiar los archivos a mano | Una copia a mano diverge en el primer cambio; así hay una sola fuente y la demo detecta cualquier desincronización. |

**Dependencias:**
- `zod`: validación de argumentos, obligatoria.
- `@anthropic-ai/sdk`: cliente oficial.
- `exceljs`: escribe xlsx en hoja y celda exactas.
- `pdf-lib`: PDF sin binarios nativos.
- `dotenv`: carga el `.env` en local.
- `tsx`: ejecuta TypeScript sin paso de compilación.

## 7. Supuestos

- **Fecha de ejecución**: la de hoy. `proveedor_armar_paquete` acepta `fecha_referencia` para reproducir un resultado.
- **Vencimiento**: un soporte está vencido si `vigencia_hasta` es estrictamente anterior a la fecha de ejecución; `null` significa que no vence.
- **Soportes vencidos**: no se copian al paquete; se listan como vencidos en el checklist.
- **País**: el campo "País" se llena con el valor del maestro (`CO`) tal cual, sin traducirlo a "Colombia", para no transformar datos.
- **Portal**: los campos salen de su `plantilla-campos.json`. `valores-portal.md` sí incluye datos bancarios porque el portal los pide; RN2 aplica al borrador de correo y al chat.
- **Etiquetas del glosario**: una coincidencia exacta tiene confianza 1.0 y una que solo difiere en tildes o mayúsculas 0.9. Sin coincidencia, el campo es `faltante`, no se adivina.
- **Envío con paquete bloqueado**: si el usuario lo confirma, se permite, pero `ENVIO-SIMULADO.md` registra los bloqueos vigentes y el agente los advierte antes de pedir la confirmación.
- **Sesiones**: viven en memoria. Reiniciar el servidor las borra, cosa aceptada por el PRD.

## 8. Cobertura

| Historia | Estado | Notas / qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | **Hecho** | Detecta ambiguos y propone el identificador del país. Producción: leer el correo y el Excel o PDF adjunto reales. |
| HU-2 Mapear campos | **Hecho** | Tres estados, ruta del dato y glosario con normalización. Producción: glosario administrado por el dueño del dato y aprendizaje de sinónimos nuevos con aprobación humana. |
| HU-3 Generar formulario | **Hecho** (xlsx P0, pdf P1, portal P2 diseñado) | Producción: escribir sobre la plantilla original del cliente conservando formato, y AcroForm cuando exista. |
| HU-4 Paquete para firma | **Hecho** | Checklist, borrador sin datos bancarios, bloqueo por vencido o ausente, envío simulado solo con confirmación. Producción: integración con firma electrónica y correo. |
| HU-5 Manejo de errores | **Hecho** | Caso inexistente, argumentos inválidos, plantilla corrupta y formato no soportado devuelven `{ ok: false, error }` o advertencias; errores del modelo se muestran en el chat. |
| Bonus `modulo/` | **Hecho** | `agent.md` y `SKILL.md` se generan desde `agent/prompt.md` y `src/knowledge/registro-proveedor.md` (`npm run modulo`); `tools/proveedor.ts` reexporta `src/tools/proveedor.ts`. `demo.ts` y `npm run modulo:check` fallan si el módulo diverge. Producción: publicarlo como paquete versionado. |

## 9. Uso de IA

- **Asistente usado**: Claude Code (modelo Claude Opus 5.5).
- **Para qué**:
  - leer el PRD y comparar los tres retos para elegir el más acotado;
  - diseñar la estructura del proyecto;
  - escribir las herramientas, el adaptador, el ciclo del agente, el front y `demo.ts`;
  - verificar con el typecheck, la demo y pruebas del chat en el navegador;
  - preparar el despliegue y redactar la documentación.
- **Qué se descartó o corrigió de lo propuesto**:
  - Usar el **Tool Runner** del SDK: se descartó por el requisito de un adaptador propio y por controlar la confirmación en el servidor.
  - Enviar el **respaldo automático ante rechazos** (`fallbacks`) en todas las llamadas: quedó solo para modelos que lo soportan (Opus 5 / Fable), porque el modelo elegido es Sonnet 5.
  - **Loguear los argumentos completos**: se cambió para omitir el mapeo, que trae datos bancarios.
  - En la prueba del front se detectaron y corrigieron dos errores: el backend rechazaba `sessionId: null` en el primer mensaje, y los mensajes largos se comprimían con scroll interno.
  - En el despliegue se detectó que la sesión de Git guardada era de otra cuenta. Se resolvió fijando el usuario **solo en este repositorio**, sin borrar credenciales del equipo.
- Todo el código fue revisado y ejecutado; cada decisión está explicada en este documento.

## 10. Riesgos de producción y mitigación

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" un campo con un valor plausible | Los valores salen solo de las herramientas y el formulario se genera re-leyendo el maestro. El prompt prohíbe afirmar valores fuera de las herramientas. |
| Maestro desactualizado (dirección, representante legal) | Nombrar un dueño del dato, registrar fecha de última actualización por campo y alertar si pasa de N meses. |
| Soportes vencidos no detectados | La vigencia se evalúa en cada ejecución. Además, alerta semanal de soportes que vencen en menos de 15 días. |
| Filtración de datos bancarios | No van en el chat, en el borrador ni en el log. En producción: cifrado en reposo del maestro y acceso por roles. |
| Link público gastando la clave del modelo | Topes por turno, por sesión y global. En producción: autenticación de usuarios corporativos y límite por usuario. |
| Plantillas nuevas o peores que los fixtures | Etiquetas sin mapeo quedan `faltante`, nunca inventadas. Se agrega el sinónimo al glosario tras aprobación. |
| Sesiones en memoria y disco efímero en Render | Persistir sesiones y `out/` en almacenamiento (SharePoint o Blob) en producción. |
| Cambio de proveedor LLM o caída del servicio | El adaptador es intercambiable; hay timeout, reintentos del SDK y mensaje claro en el chat. |
