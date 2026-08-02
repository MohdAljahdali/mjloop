# mjloop

> Claude Code를 위한 검증된 개발 사이클.

[![Claude Code 플러그인](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · **한국어** · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**코딩 에이전트가 작업 완료를 증명하게 하세요.**

`mjloop`는 에이전트 작업을 범위가 제한되고 증거로 뒷받침되는 사이클로 바꾸는
Claude Code 플러그인입니다. 리더가 작업에 맞는 에이전트를 선택해 격리된
컨텍스트에서 실행하며, 엔진이 프로젝트 자체 검증 명령의 결과를 기록한 뒤에만
성공을 인정합니다.

`요청 → 트랙 → 격리된 에이전트 → 엔진 검증 → 증거가 있는 결과`

> [!IMPORTANT]
> 현재 `mjloop`는 Claude Code를 지원합니다. 다른 코딩 에이전트용 어댑터는 아직
> 배포된 플러그인에 포함되지 않았습니다.

## 왜 mjloop인가요?

- **확신이 아닌 증거** — 성공 주장은 실패했거나 누락된 엔진 기록을 덮을 수 없습니다.
- **에이전트가 다시 쓸 수 없는 상태** — MCP 서버가 실행 상태와 파생 매니페스트를 소유합니다.
- **제한된 자율성** — 사이클 한도, 정체, 반복 오류 보호가 진전 없는 작업을 중단합니다.
- **작업별 워크플로** — 짧은 편집, 다중 사이클 빌드, 재현 우선 수정, 검토되는 계획을 선택합니다.

## 빠른 시작

Claude Code, Node.js 20 이상, Git이 필요합니다.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

그런 다음 프로젝트에서 Claude Code를 열고 실행하세요.

```text
/mjloop:init
/mjloop:edit 가입 양식에 입력 검증 추가
```

> [!NOTE]
> MCP 서버와 훅 CLI가 `engine/dist/`에서 실행되므로 새 클론은 한 번 빌드해야
> 합니다. 검증, 업데이트, 문제 해결은 [전체 설치 안내](docs/install.md)를 참고하세요.

## 올바른 트랙 선택

| 명령 | 적합한 작업 | 내장 규칙 |
|---|---|---|
| `/mjloop:edit <요청>` | 작고 명확한 변경 | 한 사이클; 범위가 커지면 에스컬레이션 |
| `/mjloop:build <목표>` | 기능과 큰 구현 | 완료되거나 중단될 때까지 검증 사이클 반복 |
| `/mjloop:fix <문제>` | 결함과 회귀 | 수정 승인 전에 실패 재현 |
| `/mjloop:plan <아이디어>` | 아이디어를 구현 가능한 스토리로 변환 | 스토리 생성 전 적합성 검사와 승인 |

`/mjloop:status`로 현재 실행을 확인하고, `/mjloop:resume`으로 재개하며,
`/mjloop:stop`으로 중단하고, `/mjloop:web`으로 브라우저 콕핏을 엽니다.

## 한 사이클에서 일어나는 일

1. 리더가 선택한 트랙에서 팀을 구성하고 각 선택 전문가의 포함 또는 제외 이유를 기록합니다.
2. 계약으로 제한된 에이전트가 격리된 컨텍스트에서 명확한 책임을 수행합니다.
3. 엔진이 실행 시작 시 고정한 검증 명령을 실행하고 전체 로그를 에이전트 설명 밖에 저장합니다.
4. 실패한 검증은 다음 사이클의 입력이 되고, 유효한 통과 기록은 실행을 종료할 수 있습니다.
5. 한도 도달, 정체, 동일 실패 반복 시 안전 보호가 사이클을 멈춥니다.

## 실행 그 이상

- **기능 발견** — `mjloop-feature-discovery` 스킬은 한 번에 하나의 결정을 묻고,
  사람이 승인할 수 있는 브리프에서 멈춥니다.
- **프로젝트 인식 라우팅** — 승인된 컴포넌트 맵과 스킬이 진행 중 실행을 바꾸지
  않고 고정 역할을 안내합니다.
- **브라우저 콕핏** — `/mjloop:web`에서 실행, 계획, 스토리, 증거, 설정, 메모리를 확인합니다.
- **확장 가능한 트랙** — `/mjloop:add`로 에이전트, 스킬 또는 트랙을 추가합니다.

> [!TIP]
> 실제로 범위가 작은 변경에 `/mjloop:edit`부터 사용해 보세요. 다중 사이클 비용
> 없이 검증 계약을 확인하는 가장 빠른 방법입니다.

## 다음 문서

- [mjloop가 존재하는 이유](docs/about.md)
- [설치와 문제 해결](docs/install.md)
- [명령, 설정, 워크플로](docs/usage.md)
- [아랍어 문서](docs/about.ar.md)

`mjloop`가 익숙한 문제를 해결한다면 다른 개발자도 찾을 수 있도록 저장소에
스타를 남겨 주세요.
