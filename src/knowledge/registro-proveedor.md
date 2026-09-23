## Proceso de registro como proveedor

1. **Recepción** deja la solicitud del cliente (correo + plantilla) en `fixtures/reto-01/casos/<caso>/`.
2. La **analista** pide al agente procesar el caso.
3. El agente identifica campos y soportes, llena desde el **repositorio maestro**, genera el formulario en el formato del cliente y arma el **paquete para firma**.
4. El **representante legal** firma (fuera del sistema). El envío al cliente es una decisión humana; en este sistema "enviar" solo escribe `ENVIO-SIMULADO.md`.

## Estados de un campo

- `lleno`: el valor existe en `maestro.json`; se informa la ruta del dato.
- `faltante`: no existe en el maestro. Nunca se inventa. No bloquea la firma pero va en el checklist.
- `requiere_confirmacion`: identificador extranjero, etiqueta ambigua o mapeo con confianza < 0.8.

## Identificador tributario por país (RN1)

| País | Nombre | Qué hace el agente |
|---|---|---|
| CO | NIT | Se llena directo. |
| EC, PE, PA | RUC | Se llena con el NIT colombiano y se marca `requiere_confirmacion` ("identificador extranjero"). |
| HN | RTN | Igual que RUC. |

## Soportes (RN3)

- Viven en `fixtures/reto-01/repositorio/soportes/` con su `vigencia_hasta` en `index.json`.
- **Vencido** (vigencia anterior a hoy) o **ausente** → bloquea `listo_para_firma`.
- La Cámara de Comercio suele exigirse con máximo 30 días de expedición; los parafiscales se renuevan cada mes.
- Qué hacer ante un bloqueo: solicitar el soporte actualizado al área responsable (Contabilidad para parafiscales y estados financieros; Jurídica/Gerencia para Cámara de Comercio; Tesorería para certificación bancaria).

## Datos sensibles (RN2)

- Los datos bancarios se llenan solo si la plantilla los pide y **nunca** se incluyen en el borrador de correo ni en el chat.

## Formatos de salida

- `xlsx`: `out/<caso>/formulario.xlsx`, cada valor en la hoja y celda de `plantilla-celdas.json`.
- `pdf`: `out/<caso>/formulario.pdf`, campos en el orden de `plantilla-campos.json`.
- `portal`: no soportado; `out/<caso>/valores-portal.md` con los valores para copiar. Credenciales y clic en "Enviar" son humanos.
