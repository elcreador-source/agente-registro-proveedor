# SOLUCIÓN — Reto 01 · Agente "Registro como Proveedor"

**Link:** https://agente-registro-proveedor.onrender.com
**Repositorio:** https://github.com/elcreador-source/agente-registro-proveedor

---

## 1. El problema en una frase

Cada mes llegan entre 8 y 12 solicitudes de clientes para registrar a Periferia como proveedor, y alguien del área administrativa tiene que copiar a mano, campo por campo, datos que ya existen en un repositorio interno.

**A quién le duele:**
- **A la analista administrativa**, que repite el mismo trabajo y puede equivocarse en datos delicados como el NIT o la cuenta bancaria.
- **A la empresa**, porque el proceso depende de una sola persona y cada registro que se demora retrasa la facturación.

---

## 2. Arquitectura

### Cómo está armado

```
┌───────────────┐ POST /api/chat ┌───────────────────────────────────────────────┐
│ web/index.html│ ─────────────▶ │ src/server.ts   (HTTP, sesiones en memoria,   │
│ chat, tool    │ ◀───────────── │                  topes de tokens)             │
│ calls, aviso  │  reply,        │      │                                        │
│ de confirmar  │  toolCalls,    │      ▼                                        │
└───────────────┘  needsConfirm. │ src/agente.ts   (ciclo del agente y control   │
                                 │                  de la confirmación)          │
                                 │      │                    │                   │
                                 │      ▼                    ▼                   │
                                 │ src/llm/adapter.ts   src/tools/index.ts       │
                                 │ (interfaz propia)    (validación zod + logs)  │
                                 │      │                    │                   │
                                 │ src/llm/anthropic.ts src/tools/proveedor.ts   │
                                 └──────┼────────────────────┼───────────────────┘
                                        ▼                    ▼
                                  API de Anthropic   fixtures/ (solo lectura)
                                                     out/      (escritura)
```

El recorrido de un mensaje:
1. El front (`web/index.html`, HTML plano sin dependencias) envía el mensaje a `POST /api/chat`.
2. El servidor (`src/server.ts`, hecho con `node:http`) recupera la sesión y le pasa el turno al ciclo del agente (`src/agente.ts`).
3. El ciclo conversa con el modelo a través de una interfaz propia (`src/llm/adapter.ts`). Cuando el modelo pide una herramienta, la ejecuta con `src/tools/index.ts`, que valida los argumentos con zod y deja registro.
4. Las herramientas (`src/tools/proveedor.ts`) son las únicas que leen `fixtures/` y escriben en `out/`.

### Dónde vive cada cosa

| Capa | Archivo | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Quién es el agente, en qué orden trabaja, qué no puede hacer nunca y cuándo pide confirmación. |
| **Conocimiento** | `src/knowledge/registro-proveedor.md` | El proceso, los estados de un campo, las reglas de soportes y de datos bancarios. |
| | `src/knowledge/reglas-pais.json` | Identificador tributario de cada país, etiquetas ambiguas y nombres legibles de los soportes. |
| **Ejecución** | `src/tools/proveedor.ts` | Las 5 herramientas. Se importan igual desde el servidor, desde `demo.ts` y desde `modulo/`. |

Si mañana entra un cliente de Chile, basta agregar `"CL": "RUT"` en `reglas-pais.json`: ni el servidor ni el ciclo del agente cambian.

### Cómo trabaja cada herramienta

Todas siguen el contrato del PRD: reciben argumentos validados con zod, **nunca lanzan una excepción** y devuelven un JSON con `{ ok: true, data }` o `{ ok: false, error }`. Además, cada respuesta trae un campo `resumen`, que es lo que se ve en el chat y en el log.

**`proveedor_leer_solicitud { caso }`**
- Valida que el nombre del caso sea seguro (solo letras, números y guiones), para que nadie pueda salirse de la carpeta de casos con algo como `../`.
- Lee `solicitud.json`, según el formato lee `plantilla-celdas.json` (Excel) o `plantilla-campos.json` (PDF y portal), y lee `soportes-exigidos.json`.
- Devuelve país, cliente, formato, lista de campos y soportes exigidos. Marca como `requiere_confirmacion` las etiquetas ambiguas, como "Identificación tributaria", y propone el equivalente del país.
- Si la plantilla está corrupta o el formato no se reconoce, **no falla**: devuelve lo que sí pudo leer y lo avisa en `advertencias`.

**`proveedor_mapear_campos { caso, campos[] }`**
Busca cada etiqueta en tres pasos:
1. Coincidencia exacta en `glosario-campos.json`, con confianza 1.0.
2. Si no hay, coincidencia ignorando tildes, mayúsculas y espacios, con confianza 0.9. Así "Razon Social" encuentra "Razón social".
3. Si tampoco hay, el campo queda **`faltante`**. No se adivina.

Con la clave encontrada lee el valor del maestro, incluidas claves anidadas como `banco.numero_cuenta`. Cada campo termina en uno de tres estados:

| Estado | Cuándo | Qué se informa |
|---|---|---|
| `lleno` | Hay valor en el maestro | Valor y ruta exacta del dato (`maestro.json#banco.nombre`) |
| `faltante` | No existe en el glosario o no tiene valor | El motivo |
| `requiere_confirmacion` | Es el NIT pedido por un cliente de otro país (RN1), es una etiqueta ambigua o la confianza es menor a 0.8 | Valor, nota y propuesta (RUC o RTN) |

**`proveedor_generar_formulario { caso, mapeo? }`**
- **Excel:** usa `exceljs` y escribe cada etiqueta y su valor en la hoja y celda exactas que indica la plantilla. Los campos faltantes o por confirmar llevan una nota en la celda para que la analista los vea.
- **PDF:** usa `pdf-lib` y genera el formulario con los campos en el orden de la plantilla, los obligatorios con `*`, los pendientes marcados en rojo y una línea de firma al final.
- **Portal:** responde **"formato no soportado"** y genera `valores-portal.md`, una tabla lista para copiar en el portal.
- En todos los casos genera `faltantes.md`.
- Detalle importante: **los valores del formulario los vuelve a leer la herramienta desde el maestro**, aunque el modelo le pase un mapeo. Si el mapeo del modelo no coincide, no se usa y se informa en `discrepancias_con_mapeo_recibido`. Por eso el modelo no tiene cómo meter un valor inventado en el formulario.

**`proveedor_armar_paquete { caso, fecha_referencia? }`**
- Genera el formulario si aún no existe.
- Revisa cada soporte exigido contra `repositorio/soportes/index.json`:
  - **ausente**: no está en el índice o falta el archivo;
  - **vencido**: `vigencia_hasta` es anterior a la fecha de revisión;
  - **presente**: todo lo demás.
- Arma `out/<caso>/paquete/` con el formulario, los soportes vigentes, `checklist.md` y `borrador-correo.md`. El borrador **nunca incluye datos bancarios**, solo nombra los adjuntos (RN2).
- `listo_para_firma` es verdadero solo si no hay soportes vencidos ni ausentes (RN3). Los campos faltantes no bloquean, pero aparecen en el checklist.
- Guarda el estado en `estado.json`.

**`proveedor_simular_envio { caso, confirmado }`**
- Si `confirmado` no es `true`, responde `"requiere confirmación explícita"`.
- Si el paquete no se ha armado, pide armarlo primero.
- Si todo está bien, escribe `ENVIO-SIMULADO.md` con destinatario, asunto, estado del paquete y los bloqueos que hubiera en ese momento.

### Resultado con los fixtures (fecha 2026-09-23)

| Caso | Formato | Campos | Paquete |
|---|---|---|---|
| `co-industrias-delta` | Excel | 17 llenos | ✅ Listo para firma |
| `ec-corp-andina` | PDF | 13 llenos · 1 faltante (contribuyente especial) · RUC por confirmar | ❌ Falta el certificado de cumplimiento tributario |
| `hn-agroexport-sula` | Excel | 9 llenos · 1 faltante (referencias comerciales) · RTN por confirmar | ❌ Parafiscales vencidos (2026-08-31) |
| `pa-logistica-istmo` | Portal | 8 llenos · RUC por confirmar | ✅ Listo · "formato no soportado" + `valores-portal.md` |

---

## 3. El ciclo del agente

Todo ocurre en `turno()` dentro de `src/agente.ts`:

1. Guardo el mensaje del usuario en la sesión.
2. Entro en un bucle de máximo **25 iteraciones** (`MAX_ITERACIONES`). En cada vuelta llamo al modelo con el historial y las herramientas:
   - si pide herramientas, las ejecuto todas, le devuelvo los resultados en un solo mensaje y vuelvo a llamarlo;
   - si ya no pide herramientas, su texto es la respuesta del turno.
3. Si llego al tope de 25, no corto en seco: respondo con la lista de lo que alcancé a hacer y le pido al usuario que me deje continuar (CA1).
4. Llevo la cuenta de tokens **por sesión** (`MAX_TOKENS_SESION`) y **para todo el servidor** (`MAX_TOKENS_TOTAL`). El segundo tope existe porque el link es público: sin él, cualquiera podría abrir sesiones nuevas sin parar y agotar la clave.
5. Si el modelo falla (clave inválida, timeout, límite de peticiones), el adaptador lo traduce a un mensaje en español que se ve en el chat, y la sesión sigue viva (CA5).

### Confirmación humana: por qué la controlo en dos lugares

Pedirle al modelo que pregunte antes de enviar no basta: un modelo puede equivocarse, o el usuario puede escribir algo que lo confunda. Por eso la controlo en dos capas.

**Capa 1, el prompt.** Antes de usar `proveedor_simular_envio`, el agente tiene que preguntar y terminar el turno con la marca `[CONFIRMACION]`. El servidor quita la marca del texto, responde `needsConfirmation: true`, y el front muestra un aviso amarillo con los botones **Sí, confirmo** y **No**.

**Capa 2, el servidor, que es la que de verdad protege.** La sesión recuerda que se pidió confirmación. En el siguiente mensaje reviso si el usuario realmente dijo que sí:
- cuenta como sí: "sí", "confirmo", "envía", "adelante", "ok";
- no cuenta si aparece "no", "todavía", "espera" o "cancela".

Si el modelo intenta llamar `simular_envio` con `confirmado: true` sin ese sí, **el servidor bloquea la llamada** y le devuelve un error. El control no depende de que el modelo obedezca (CA3 / RN4).

### Trazabilidad

Cada llamada a herramienta queda:
- **visible en el chat**, con nombre, argumentos y resumen;
- en **`out/log.jsonl`**, con la sesión;
- en **`out/<caso>/log.jsonl`**, con `{ ts, herramienta, ok, resumen }` (CA4 / RN5).

---

## 4. Elección del modelo

- **Proveedor y modelo:** Anthropic, `claude-sonnet-5`, con esfuerzo `medium`. Se cambia con la variable `ANTHROPIC_MODEL`.
- **Por qué este:** el trabajo delicado (mapear, revisar vigencias, aplicar reglas por país) lo hacen herramientas deterministas. El modelo solo necesita llamar 4 o 5 herramientas en orden y explicar el resultado en buen español. Sonnet 5 lo hace bien y cuesta menos de la mitad que Opus 5: $2 por millón de tokens de entrada y $10 por millón de salida.
- **Costo por caso:** unas 5 llamadas al modelo, con unos 40.000 tokens de entrada acumulados (prompt, herramientas e historial) y unos 2.000 de salida. Son 40k × $2/M + 2k × $10/M ≈ **US$0,10 por caso**, más unos US$0,03 si se hace el turno de envío.
- **Cambiar de proveedor:** el ciclo solo conoce los tipos neutrales de `src/llm/adapter.ts` (`Mensaje`, `Bloque`, `RespuestaLlm`). Pasar a OpenAI o Gemini es escribir otra clase que implemente `AdaptadorLlm`.

---

## 5. Cómo abordaría el portal web (sección 7.4)

**Qué hace hoy:** responde "formato no soportado" y deja en `valores-portal.md` una tabla con cada campo, su valor y su estado, lista para copiar.

**Cómo lo automatizaría:** con un navegador controlado por el agente (Playwright), pero como **copiloto**, no como robot desatendido.
- Por cada portal guardaría un **perfil**: la URL, cómo encontrar cada campo por su etiqueta visible (no por su posición en la página) y a qué clave del glosario corresponde.
- El agente llena solo los campos que encuentra con certeza. Los demás los deja resaltados.

**Dónde tiene límites:**
- **CAPTCHA y MFA:** siempre los resuelve una persona. El agente no intenta saltárselos.
- **Cambios en el diseño del portal:** si un campo no aparece donde se esperaba, el agente se detiene y lo reporta. No adivina.
- **Carga de archivos:** el agente deja los soportes listos para que la persona los seleccione.

**Alternativas descartadas:**
- **RPA tradicional:** se rompe con cualquier cambio de diseño y es cara de mantener para uno o dos portales al mes.
- **Extensión de navegador:** sería cómoda, pero hay que instalarla y distribuirla en cada equipo.

**Credenciales:**
- Nunca van en el repositorio, en el prompt, en los argumentos de las herramientas ni en los logs.
- El cliente las envía al correo del representante legal, y **la persona las escribe directamente en el navegador**. El agente nunca las ve.
- Si más adelante conviene reutilizar sesiones, guardaría la cookie de sesión en un gestor de secretos (Azure Key Vault o similar) con vencimiento corto. Nunca el usuario y la contraseña.

**Quién hace qué:**

| El agente | La persona |
|---|---|
| Abre el portal y espera el inicio de sesión | Escribe usuario, contraseña, MFA y CAPTCHA |
| Llena los campos que conoce y resalta los faltantes y los que hay que confirmar | Revisa, completa y corrige |
| Prepara los soportes vigentes | Verifica los adjuntos |
| Toma una captura del formulario lleno como evidencia | **Hace clic en "Enviar"** |

---

## 6. Decisiones y trade-offs

| # | Lo que decidí | Lo que descarté | Por qué |
|---|---|---|---|
| 1 | La herramienta **vuelve a leer los valores del maestro** al generar el formulario | Escribir los valores que manda el modelo en `mapeo` | Así el modelo no tiene cómo colar un dato inventado (CA2). Si su mapeo no coincide, lo reporto como discrepancia. |
| 2 | **La confirmación la valida el servidor**, además del prompt | Confiar en que el modelo pregunte y marque `confirmado: true` solo cuando toca | Enviar es una acción externa, y quiero un control que no dependa de que el modelo acierte. |
| 3 | **Ciclo manual con un adaptador propio** | El Tool Runner del SDK o un framework como LangChain | El PRD pide una interfaz propia intercambiable, y el ciclo manual me deja controlar los topes y la confirmación sin depender de funciones beta. |
| 4 | **`node:http` sin framework** | Express o Fastify | Son 3 rutas y una página estática. Una dependencia menos que justificar. |
| 5 | **PDF generado con `pdf-lib`**, con etiqueta y valor en orden | Rellenar un PDF con campos (AcroForm) | Los fixtures no traen el PDF original del cliente y el PRD acepta un PDF generado. |
| 6 | **El mapeo completo no se guarda en `out/log.jsonl`** | Guardar todos los argumentos tal cual | El mapeo trae datos bancarios (RN2). En el log queda `"[omitido]"`. |
| 7 | **`modulo/` se genera y verifica desde las fuentes**, y las herramientas se reexportan | Copiar los archivos a mano | Una copia manual se desactualiza en el primer cambio. Así hay una sola fuente, y la demo avisa si algo se desincroniza. |

**Dependencias:**

| Paquete | Para qué |
|---|---|
| `zod` | Validar los argumentos de las herramientas (obligatorio en el PRD) |
| `@anthropic-ai/sdk` | Cliente oficial del modelo |
| `exceljs` | Escribir el Excel en la hoja y celda exactas |
| `pdf-lib` | Generar el PDF sin binarios nativos |
| `dotenv` | Cargar el `.env` en local |
| `tsx` | Ejecutar TypeScript sin paso de compilación |

---

## 7. Supuestos

- **Fecha de revisión:** la de hoy. `proveedor_armar_paquete` acepta `fecha_referencia` por si hay que reproducir un resultado de otro día.
- **Vencido:** un soporte está vencido si `vigencia_hasta` es anterior a esa fecha. Si es `null`, no vence (como el RUT).
- **Soportes vencidos:** no los copio al paquete, porque no sirven para enviar; aparecen como vencidos en el checklist.
- **País:** lleno el campo "País" con el valor del maestro (`CO`) tal cual, sin traducirlo a "Colombia", para no transformar datos.
- **Portal:** tomo los campos de su `plantilla-campos.json`. `valores-portal.md` sí incluye datos bancarios porque el portal los pide; la regla RN2 aplica al borrador del correo y al chat.
- **Glosario:** coincidencia exacta es confianza 1.0 y coincidencia que solo cambia tildes o mayúsculas es 0.9. Sin coincidencia, el campo es `faltante`.
- **Envío con paquete bloqueado:** si el usuario confirma, lo permito. Antes, el agente advierte los bloqueos, y `ENVIO-SIMULADO.md` los deja registrados.
- **Sesiones:** viven en memoria, así que si el servidor se reinicia se pierden. El PRD lo acepta.

---

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | ✅ Hecho | Leer el correo real y el Excel o PDF adjunto, no un JSON normalizado. |
| HU-2 Mapear campos | ✅ Hecho | Que el glosario tenga un dueño y que los sinónimos nuevos se agreguen con aprobación humana. |
| HU-3 Generar formulario | ✅ Hecho: Excel (P0), PDF (P1), portal diseñado (P2) | Escribir sobre la plantilla original del cliente conservando su formato, y rellenar AcroForm cuando exista. |
| HU-4 Paquete para firma | ✅ Hecho | Integración con firma electrónica y con el correo real. |
| HU-5 Manejo de errores | ✅ Hecho | Caso inexistente, argumentos inválidos, plantilla corrupta y formato no soportado ya dan mensajes claros. En producción, sumaría alertas al equipo. |
| Bonus `modulo/` | ✅ Hecho | Publicarlo como paquete versionado. |

**Cómo está hecho el bonus:**
- `modulo/agent.md` y `modulo/skill/registro-proveedor/SKILL.md` se generan con `npm run modulo` a partir de `agent/prompt.md` y `src/knowledge/registro-proveedor.md`.
- `modulo/tools/proveedor.ts` reexporta `src/tools/proveedor.ts`, así que es el mismo código.
- `demo.ts` y `npm run modulo:check` fallan si el módulo se desincroniza de sus fuentes.
- Límite: el reexport depende de `src/`, así que el módulo funciona dentro de este repositorio y no copiado solo a otro proyecto.

---

## 9. Uso de IA

**Qué usé:** Claude Code, con el modelo Claude Opus 5.5.

**Para qué lo usé:**
- Leer los tres PRD y elegir el reto más acotado para el tiempo disponible.
- Definir la estructura del proyecto.
- Escribir las herramientas, el adaptador, el ciclo del agente, el front y `demo.ts`.
- Probar: typecheck, ejecución de la demo y conversaciones reales en el navegador.
- Preparar el despliegue en Render y redactar la documentación.

**Qué descarté o corregí en el camino:**
- **El Tool Runner del SDK.** Lo descarté porque el reto pide un adaptador propio y porque quería controlar la confirmación desde el servidor.
- **El respaldo automático ante rechazos (`fallbacks`)** en todas las llamadas. Lo dejé solo para los modelos que lo soportan (Opus 5 y Fable), porque el elegido es Sonnet 5.
- **Guardar todos los argumentos en el log.** Lo cambié para omitir el mapeo, que trae datos bancarios.
- **Dos errores que aparecieron al probar el front.** El backend rechazaba el primer mensaje porque llegaba `sessionId: null`, y los mensajes largos se comprimían con una barra de scroll interna. Corregí los dos.
- **Un problema al subir a GitHub.** Git estaba usando una sesión guardada de otra cuenta. Lo resolví fijando el usuario solo para este repositorio, sin borrar las credenciales del equipo.

Revisé y ejecuté todo el código entregado, y cada decisión está explicada en este documento.

---

## 10. Riesgos de llevarlo a producción

| Riesgo | Cómo lo mitigo |
|---|---|
| El modelo "completa" un campo con un valor que parece correcto | Los valores solo salen de las herramientas y el formulario se genera releyendo el maestro. Además, el prompt prohíbe afirmar datos que no vengan de una herramienta. |
| El maestro se desactualiza (dirección, representante legal) | Nombrar un dueño del dato, guardar la fecha de última actualización de cada campo y alertar cuando pase de cierto tiempo. |
| Se vence un soporte sin que nadie lo note | La vigencia ya se revisa en cada ejecución. Sumaría una alerta semanal de los soportes que vencen en menos de 15 días. |
| Se filtran datos bancarios | Hoy no aparecen en el chat, el borrador ni el log. En producción: maestro cifrado y acceso por roles. |
| Alguien gasta la clave del modelo desde el link público | Hay topes por turno, por sesión y globales. En producción: inicio de sesión corporativo y límite por usuario. |
| Llegan plantillas nuevas o más desordenadas que los fixtures | Lo que no se reconoce queda `faltante`, nunca inventado, y el sinónimo se agrega al glosario después de revisarlo. |
| Render borra `out/` y las sesiones al reiniciar | Guardar sesiones y archivos en un almacenamiento persistente (SharePoint o Blob Storage). |
| El proveedor del modelo cambia o se cae | El adaptador es intercambiable, y ya hay timeout, reintentos y un mensaje claro en el chat. |
