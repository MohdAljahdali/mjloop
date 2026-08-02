# mjloop

> Verifizierte Entwicklungszyklen für Claude Code.

[![Claude-Code-Plugin](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · **Deutsch** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**Lass Coding-Agenten beweisen, dass sie fertig sind.**

`mjloop` ist ein Claude-Code-Plugin, das Agentenarbeit in begrenzte, evidenzbasierte
Zyklen verwandelt. Eine Leitung wählt die passenden Agenten, führt sie in isolierten
Kontexten aus und akzeptiert Erfolg erst, nachdem die Engine das Ergebnis der
projektspezifischen Prüfkommandos aufgezeichnet hat.

`Auftrag → Ablauf → isolierte Agenten → Engine-Prüfung → belegtes Ergebnis`

> [!IMPORTANT]
> `mjloop` unterstützt derzeit Claude Code. Adapter für andere Coding-Agenten sind noch
> nicht Bestandteil des veröffentlichten Plugins.

## Warum mjloop?

- **Belege statt Vertrauen** — eine Erfolgsmeldung kann einen fehlgeschlagenen oder
  fehlenden Engine-Beleg nicht überstimmen.
- **Zustand, den Agenten nicht umschreiben können** — der MCP-Server besitzt Laufzustand
  und abgeleitete Manifeste.
- **Begrenzte Autonomie** — Zyklus-, Stillstands- und Wiederholungswächter stoppen Arbeit
  ohne weiteren Fortschritt.
- **Ein Ablauf für jede Aufgabe** — kurze Änderung, mehrzyklischer Build,
  reproduktionsbasierte Fehlerbehebung oder geprüfte Planung.

## Schnellstart

Du benötigst Claude Code, Node.js 20 oder neuer und Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Öffne danach Claude Code in einem Projekt und führe Folgendes aus:

```text
/mjloop:init
/mjloop:edit füge dem Registrierungsformular eine Eingabeprüfung hinzu
```

> [!NOTE]
> Ein frischer Klon muss einmal gebaut werden, da MCP-Server und Hook-CLI aus
> `engine/dist/` laufen. Siehe die [vollständige Installationsanleitung](docs/install.md).

## Wähle den passenden Ablauf

| Befehl | Geeignet für | Eingebaute Regel |
|---|---|---|
| `/mjloop:edit <Auftrag>` | Kleine, fokussierte Änderungen | Ein Zyklus; bei wachsendem Umfang eskalieren |
| `/mjloop:build <Ziel>` | Features und größere Implementierungen | Verifizierte Zyklen bis Abschluss oder Stopp |
| `/mjloop:fix <Problem>` | Defekte und Regressionen | Fehler vor Annahme der Korrektur reproduzieren |
| `/mjloop:plan <Idee>` | Ideen in baubare Stories umwandeln | Eignungsprüfung und Freigabe vor Story-Erstellung |

Mit `/mjloop:status` prüfst du den Lauf, `/mjloop:resume` setzt ihn fort,
`/mjloop:stop` hält ihn an und `/mjloop:web` öffnet das Browser-Cockpit.

## Was geschieht in einem Zyklus?

1. Die Leitung stellt ein Team aus dem Ablauf zusammen und begründet jeden optionalen Spezialisten.
2. Vertragsgebundene Agenten arbeiten mit klaren Aufgaben in isolierten Kontexten.
3. Die Engine führt die beim Start fixierten Prüfkommandos aus und speichert das vollständige Protokoll außerhalb der Agentenerzählung.
4. Eine fehlgeschlagene Prüfung wird Eingabe des nächsten Zyklus; ein gültiger Beleg kann den Lauf schließen.
5. Wächter stoppen Zyklen, die ihr Limit erreichen, stillstehen oder denselben Fehler wiederholen.

## Mehr als Ausführung

- **Feature-Erkundung** — `mjloop-feature-discovery` fragt jeweils eine Entscheidung ab
  und endet bei einem Briefing, das ein Mensch freigeben kann.
- **Projektbewusstes Routing** — akzeptierte Komponentenkarten und Skills führen feste
  Rollen, ohne einen laufenden Vorgang zu verändern.
- **Browser-Cockpit** — Läufe, Pläne, Stories, Belege, Konfiguration und Gedächtnis mit
  `/mjloop:web` prüfen.
- **Erweiterbare Abläufe** — Agent, Skill oder Ablauf mit `/mjloop:add` ergänzen.

> [!TIP]
> Beginne mit `/mjloop:edit` für eine echte, klar begrenzte Änderung. So siehst du den
> Prüfvertrag am schnellsten, ohne die Kosten mehrerer Zyklen.

## Weiterlesen

- [Warum mjloop existiert](docs/about.md)
- [Installation und Fehlerbehebung](docs/install.md)
- [Befehle, Konfiguration und Abläufe](docs/usage.md)
- [Arabische Dokumentation](docs/about.ar.md)

Wenn `mjloop` ein bekanntes Problem für dich löst, gib dem Repository einen Stern, damit
weitere Entwickler es finden können.
