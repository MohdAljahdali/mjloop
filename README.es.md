# mjloop

> Ciclos de desarrollo verificados para Claude Code.

[![Plugin de Claude Code](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · **Español** · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**Haz que los agentes de programación demuestren que terminaron.**

`mjloop` es un plugin de Claude Code que convierte el trabajo de agentes en ciclos
acotados y respaldados por evidencia. Un líder elige los agentes adecuados, los ejecuta
en contextos aislados y solo acepta el éxito cuando el motor registra el resultado de los
comandos de verificación del proyecto.

`solicitud → flujo → agentes aislados → verificación del motor → resultado con evidencia`

> [!IMPORTANT]
> `mjloop` admite actualmente Claude Code. Los adaptadores para otros agentes de
> programación aún no forman parte del plugin publicado.

## ¿Por qué mjloop?

- **Evidencia, no confianza** — una afirmación de éxito no puede reemplazar un recibo
  fallido o ausente del motor.
- **Estado que los agentes no pueden reescribir** — el servidor MCP controla el estado y
  los manifiestos derivados.
- **Autonomía acotada** — los límites de ciclos y las protecciones contra estancamiento y
  errores repetidos detienen el trabajo sin progreso.
- **Un flujo para cada tarea** — edición breve, construcción por ciclos, corrección tras
  reproducir el fallo o planificación revisada.

## Inicio rápido

Necesitas Claude Code, Node.js 20 o posterior y Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Después abre Claude Code en un proyecto y ejecuta:

```text
/mjloop:init
/mjloop:edit añade validación de entrada al formulario de registro
```

> [!NOTE]
> Un clon nuevo debe compilarse una vez porque el servidor MCP y la CLI de hooks se
> ejecutan desde `engine/dist/`. Consulta la [guía completa de instalación](docs/install.md).

## Elige el flujo adecuado

| Comando | Ideal para | Regla integrada |
|---|---|---|
| `/mjloop:edit <solicitud>` | Cambios pequeños y concretos | Un ciclo; escala si crece el alcance |
| `/mjloop:build <objetivo>` | Funciones e implementaciones grandes | Repite ciclos verificados hasta terminar o detenerse |
| `/mjloop:fix <problema>` | Defectos y regresiones | Reproduce el fallo antes de aceptar la corrección |
| `/mjloop:plan <idea>` | Convertir una idea en historias construibles | Comprueba el encaje y exige aprobación antes de crear historias |

Usa `/mjloop:status` para inspeccionar la ejecución, `/mjloop:resume` para continuarla,
`/mjloop:stop` para detenerla y `/mjloop:web` para abrir el panel del navegador.

## ¿Qué ocurre en un ciclo?

1. El líder compone un equipo desde el flujo elegido y registra por qué incluye u omite
   cada especialista opcional.
2. Los agentes sujetos a contrato trabajan en contextos aislados y con funciones claras.
3. El motor ejecuta los comandos fijados al inicio y guarda el registro completo fuera de
   la narración del agente.
4. Una verificación fallida alimenta el siguiente ciclo; un recibo válido puede cerrar la ejecución.
5. Las protecciones detienen los ciclos que llegan al límite, se estancan o repiten el mismo fallo.

## Más que ejecución

- **Descubrimiento de funciones** — `mjloop-feature-discovery` pregunta una decisión cada
  vez y se detiene en un resumen que una persona puede aprobar.
- **Enrutamiento consciente del proyecto** — mapas y habilidades aceptados guían roles
  fijos sin cambiar una ejecución en curso.
- **Panel en el navegador** — consulta ejecuciones, planes, historias, evidencia,
  configuración y memoria con `/mjloop:web`.
- **Flujos extensibles** — añade un agente, una habilidad o un flujo con `/mjloop:add`.

> [!TIP]
> Empieza con `/mjloop:edit` para un cambio real y acotado. Es la forma más rápida de ver
> el contrato de verificación sin pagar el coste de varios ciclos.

## Sigue leyendo

- [Por qué existe mjloop](docs/about.md)
- [Instalación y solución de problemas](docs/install.md)
- [Comandos, configuración y flujos](docs/usage.md)
- [Documentación en árabe](docs/about.ar.md)

Si `mjloop` resuelve un problema que reconoces, considera dar una estrella al repositorio
para que otros desarrolladores puedan encontrarlo.
