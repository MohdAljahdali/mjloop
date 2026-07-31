/**
 * The project trees the detector is exercised against, as file maps rather than
 * as files committed under this directory.
 *
 * Three of the six trees have to contain a literal `package.json`, and two more
 * have to contain a `node_modules/`, a `.venv/` or a `.dart_tool/` — that is the
 * whole point of the ignore list, and a test that asserts an ignore rule against
 * a directory that is not there asserts nothing. Committed as real files those
 * two facts collide with the repository itself:
 *
 *   - `node_modules/` is in the root `.gitignore`, so a committed fixture tree
 *     containing one arrives incomplete on a fresh clone and the ignore-list
 *     assertion silently stops testing anything;
 *   - a `package.json` declaring `next` sitting inside `engine/tests` is a
 *     second, undeclared manifest inside the engine's own package — picked up by
 *     dependency tooling, and by anything that resolves the nearest
 *     `package.json` upward from a file in that subtree.
 *
 * So the trees are declared here and materialised by each test into its own
 * temp directory through `makeTmpProject`, which is exactly the "literal
 * on-disk files created by the test" the story allows. Every tree is still one
 * named, reviewable thing in one place.
 *
 * `makeTmpProject` writes files, not empty directories, so a directory that
 * exists only to prove it is *not* a component (`mobile/`, `admin/`) or *not*
 * descended into (`node_modules/`) carries one plausible file.
 */
export type ProjectTree = Record<string, string>

const FLUTTER_PUBSPEC = `name: tiny_app
environment:
  sdk: ">=3.4.0 <4.0.0"
  flutter: ">=3.22.0"
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
`

/**
 * A Flutter plugin that pins the SDK and declares nothing else: one marker of
 * the three, and no `dev_dependencies.flutter_test`.
 *
 * FLUTTER_PUBSPEC declares all three markers at once, so every input to the
 * flutter conclusion is true there and every input is false in DART_PUBSPEC.
 * Between those two a detector that required all three markers together, and
 * one that required any one of them, are the same implementation. This pubspec
 * is what tells them apart.
 */
const FLUTTER_PLUGIN_PUBSPEC = `name: tiny_plugin
environment:
  sdk: ">=3.4.0 <4.0.0"
  flutter: ">=3.22.0"
`

/** A Flutter app that declares its test harness and no analysis options. */
const FLUTTER_UNLINTED_PUBSPEC = `name: tiny_unlinted
environment:
  sdk: ">=3.4.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
`

/** A pure-Dart package: a real pubspec, no flutter marker anywhere in it. */
const DART_PUBSPEC = `name: tiny_dart_lib
environment:
  sdk: ">=3.4.0 <4.0.0"
dependencies:
  meta: ^1.12.0
dev_dependencies:
  test: ^1.25.0
`

function packageJson(body: Record<string, unknown>): string {
  return `${JSON.stringify(body, null, 2)}\n`
}

/** Standalone Flutter app at the project root. */
export const FLUTTER_TREE: ProjectTree = {
  'pubspec.yaml': FLUTTER_PUBSPEC,
  'analysis_options.yaml': 'include: package:flutter_lints/flutter.yaml\n',
  'lib/main.dart': 'void main() {}\n',
  // A dotted directory holding a manifest: ignored for being dotted, not for
  // being named `.dart_tool`.
  '.dart_tool/pubspec.yaml': FLUTTER_PUBSPEC,
  // Named in the ignore list outright. Flutter really does write one here.
  'build/app/pubspec.yaml': FLUTTER_PUBSPEC,
}

/**
 * A Flutter plugin: flutter by one marker, and nothing verifiable declared.
 *
 * Every slot has to stay null. `flutter test` without a `flutter_test`
 * dev-dependency and `flutter analyze` without an `analysis_options.yaml` are
 * both commands the project never asked for, and FLUTTER_TREE cannot catch
 * either because it declares both of the things that earn them.
 */
export const FLUTTER_PLUGIN_TREE: ProjectTree = {
  'pubspec.yaml': FLUTTER_PLUGIN_PUBSPEC,
  'lib/tiny_plugin.dart': 'void main() {}\n',
}

/**
 * A Flutter app with a test harness and no analysis options: `flutter test` is
 * earned and `flutter analyze` is not, so the two gates are separated here.
 */
export const FLUTTER_UNLINTED_TREE: ProjectTree = {
  'pubspec.yaml': FLUTTER_UNLINTED_PUBSPEC,
  'lib/main.dart': 'void main() {}\n',
}

/** Standalone Next.js app at the project root. */
export const NEXTJS_TREE: ProjectTree = {
  'package.json': packageJson({
    name: 'tiny-site',
    scripts: { dev: 'next dev', test: 'vitest run', lint: 'next lint', build: 'next build' },
    dependencies: { next: '15.0.0', react: '19.0.0' },
  }),
  'next.config.mjs': 'export default {}\n',
  'app/page.tsx': 'export default function Page() { return null }\n',
  'node_modules/left-pad/package.json': packageJson({ name: 'left-pad', version: '1.3.0' }),
}

/** Standalone Python package at the project root. */
export const PYTHON_TREE: ProjectTree = {
  'pyproject.toml': `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "tiny"
version = "0.1.0"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 100
`,
  'src/tiny/__init__.py': '',
  '.venv/lib/pyproject.toml': '[project]\nname = "venv-junk"\n',
}

/**
 * One repository, three components under three roots, none of them the root
 * itself. The root has no manifest, so it is not a component.
 */
export const MIXED_TREE: ProjectTree = {
  'mobile/pubspec.yaml': FLUTTER_PUBSPEC,
  'mobile/analysis_options.yaml': 'linter:\n  rules:\n    - prefer_const_constructors\n',
  'mobile/lib/main.dart': 'void main() {}\n',
  'admin/package.json': packageJson({
    name: 'admin',
    scripts: { test: 'vitest run', lint: 'eslint .', build: 'next build' },
    devDependencies: { next: '15.0.0' },
  }),
  'admin/next.config.js': 'module.exports = {}\n',
  'service/pyproject.toml': `[build-system]
requires = ["setuptools"]

[tool.pytest.ini_options]
addopts = "-q"
`,
  'service/app/__init__.py': '',
  // Prose, not a component. Nothing here declares anything.
  'docs/architecture.md': '# Architecture\n',
}

/**
 * Manifests nested inside a directory that already holds one, plus the two
 * "declared content decides" cases that must resolve to `unknown`.
 */
export const NESTED_TREE: ProjectTree = {
  // The workspace root: a real manifest, no `next`, so `unknown` — and still a
  // component in its own right.
  'package.json': packageJson({ name: 'workspace', private: true, scripts: { test: 'npm run test -ws' } }),
  // A `next.config.js` beside a `package.json` that does not depend on next.
  // Corroboration recorded in `basis`, never sufficient on its own.
  'packages/ui/package.json': packageJson({ name: 'ui', scripts: { test: 'vitest run', build: 'tsup' } }),
  'packages/ui/next.config.js': 'module.exports = {}\n',
  'packages/site/package.json': packageJson({
    name: 'site',
    scripts: { build: 'next build' },
    dependencies: { next: '15.0.0' },
  }),
  // A pubspec with no flutter marker, and an analysis_options.yaml beside it:
  // `flutter analyze` on a pure-Dart package would be the wrong command.
  'packages/dart-lib/pubspec.yaml': DART_PUBSPEC,
  'packages/dart-lib/analysis_options.yaml': 'include: package:lints/recommended.yaml\n',
  'services/api/pyproject.toml': '[project]\nname = "api"\n',
  'services/api/setup.cfg': '[metadata]\nname = api\n',
}

/**
 * A repository with no recognized manifest at all. The directory names are
 * `mobile` and `admin` on purpose: a detector that guessed from folder names
 * would report a Flutter app and an admin console here, and there is neither.
 */
export const UNKNOWN_TREE: ProjectTree = {
  'mobile/lib/main.dart': 'void main() {}\n',
  'admin/src/index.js': 'console.log("hi")\n',
  'Makefile': 'all:\n\techo hi\n',
  'README.md': '# Nothing declared\n',
}

/**
 * Depth only. The project root is depth 0 and the cap is 5, so the manifest at
 * depth 5 is a component and the one at depth 6 is out of reach.
 */
export const DEEP_TREE: ProjectTree = {
  'a/b/c/d/e/pyproject.toml': '[project]\nname = "reachable"\n',
  'a/b/c/d/e/f/pyproject.toml': '[project]\nname = "too-deep"\n',
}
