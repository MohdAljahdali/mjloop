# mjloop

> Ciclos de desenvolvimento verificados para Claude Code.

[![Plugin do Claude Code](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · **Português (Brasil)** · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**Faça os agentes de programação provarem que terminaram.**

`mjloop` é um plugin do Claude Code que transforma o trabalho de agentes em ciclos
limitados e sustentados por evidências. Um líder escolhe os agentes certos, executa cada
um em um contexto isolado e só aceita o sucesso depois que o motor registra o resultado
dos comandos de verificação do próprio projeto.

`pedido → trilha → agentes isolados → verificação do motor → resultado com evidências`

> [!IMPORTANT]
> Atualmente, o `mjloop` oferece suporte ao Claude Code. Adaptadores para outros agentes
> de programação ainda não fazem parte do plugin publicado.

## Por que mjloop?

- **Evidência, não confiança** — uma alegação de sucesso não substitui um comprovante
  ausente ou com falha.
- **Estado que agentes não reescrevem** — o servidor MCP controla o estado da execução e
  os manifestos derivados.
- **Autonomia limitada** — limites de ciclos e proteções contra estagnação e erros
  repetidos interrompem trabalhos sem progresso.
- **Um fluxo para cada tarefa** — edição curta, construção em vários ciclos, correção
  começando pela reprodução ou planejamento revisado.

## Início rápido

Você precisa do Claude Code, Node.js 20 ou mais recente e Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Depois, abra o Claude Code em um projeto e execute:

```text
/mjloop:init
/mjloop:edit adicione validação de entrada ao formulário de cadastro
```

> [!NOTE]
> Um clone novo precisa ser compilado uma vez, pois o servidor MCP e a CLI de hooks rodam
> de `engine/dist/`. Veja o [guia completo de instalação](docs/install.md).

## Escolha a trilha certa

| Comando | Melhor para | Regra integrada |
|---|---|---|
| `/mjloop:edit <pedido>` | Mudanças pequenas e focadas | Um ciclo; escala se o escopo crescer |
| `/mjloop:build <objetivo>` | Funcionalidades e implementações maiores | Repete ciclos verificados até concluir ou parar |
| `/mjloop:fix <problema>` | Defeitos e regressões | Reproduz a falha antes de aceitar a correção |
| `/mjloop:plan <ideia>` | Transformar uma ideia em histórias implementáveis | Verifica aderência e exige aprovação antes das histórias |

Use `/mjloop:status` para inspecionar a execução, `/mjloop:resume` para continuar,
`/mjloop:stop` para interromper e `/mjloop:web` para abrir o painel no navegador.

## O que acontece em um ciclo?

1. O líder compõe uma equipe a partir da trilha e registra por que incluiu ou omitiu cada especialista.
2. Agentes vinculados por contrato trabalham em contextos isolados e com responsabilidades focadas.
3. O motor executa os comandos fixados no início e guarda o log completo fora da narrativa do agente.
4. Uma verificação com falha alimenta o próximo ciclo; um comprovante aprovado pode encerrar a execução.
5. Proteções interrompem ciclos que atingem o limite, estagnam ou repetem a mesma falha.

## Mais que execução

- **Descoberta de funcionalidades** — `mjloop-feature-discovery` pergunta uma decisão por
  vez e para em um briefing que uma pessoa pode aprovar.
- **Roteamento consciente do projeto** — mapas e habilidades aceitos orientam papéis fixos
  sem alterar uma execução em andamento.
- **Painel no navegador** — consulte execuções, planos, histórias, evidências, configuração
  e memória com `/mjloop:web`.
- **Trilhas extensíveis** — adicione agente, habilidade ou trilha com `/mjloop:add`.

> [!TIP]
> Comece com `/mjloop:edit` em uma mudança real e limitada. É a maneira mais rápida de
> conhecer o contrato de verificação sem o custo de vários ciclos.

## Continue lendo

- [Por que o mjloop existe](docs/about.md)
- [Instalação e solução de problemas](docs/install.md)
- [Comandos, configuração e fluxos](docs/usage.md)
- [Documentação em árabe](docs/about.ar.md)

Se o `mjloop` resolve um problema que você reconhece, considere dar uma estrela ao
repositório para que outros desenvolvedores possam encontrá-lo.
