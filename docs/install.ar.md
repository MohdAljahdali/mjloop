# تنصيب mjloop

> English version: [install.md](./install.md)

## المتطلّبات

- **Claude Code** — سطر الأوامر، أو التطبيق المكتبي، أو إضافة المحرّر.
- **Node.js 20 أو أحدث.** المحرّك حزمة TypeScript بصيغة ESM؛ يجب أن يُظهر `node --version`
  الإصدار `v20` على الأقلّ.
- **git**، لمساري `build` و`fix`، فكلاهما يُودِع بعد كل دورة ناجحة.

## التنصيب

### 1. ابنِ المحرّك

خادم MCP وواجهة الخطّافات يعملان من مُخرَجات مُصرَّفة، و`engine/dist/` غير مُودَع في git —
فالمستودع المستنسَخ حديثًا (clone) يجب أن يُبنى مرّة واحدة قبل أن يعمل أي شيء.

```bash
cd /path/to/mjloop/engine
npm install
npm run build
```

تأكّد من إنتاج نقطتَي الدخول:

```bash
ls dist/mcp/server.js dist/cli/index.js
```

### 2. سجّل المستودع بوصفه متجرًا

```bash
claude plugin marketplace add /path/to/mjloop
```

يُسجَّل المسار كما هو: موضع تثبيت المتجر **هو** مستودعك لا نسخةً منه. فإعادة بناء المحرّك
تسري فورًا بلا إعادة تثبيت.

### 3. ثبّت الإضافة

```bash
claude plugin install mjloop@mjloop
```

والخطوتان نفسهما تعملان داخل الجلسة عبر `/plugin marketplace add <path>` ثم
`/plugin install mjloop@mjloop`.

## التحقّق

```bash
claude plugin list          # المتوقّع: mjloop@mjloop — enabled
claude mcp list             # المتوقّع: plugin:mjloop:mjloop — ✔ Connected
claude plugin details mjloop@mjloop
```

الأمر الأخير يطبع جرد المكوّنات. التنصيب السليم يُظهر **Agents (19)** و**Skills (15)** —
إذ تجمع الأداة الأوامرَ العشرة والمهاراتِ الخمس في خانة واحدة — و**Hooks (3)**. وظهور
`MCP servers (0)` في ذلك الجرد متوقّع؛ انظر «معالجة المشكلات»، واجعل `claude mcp list` هو
الفحص المعوَّل عليه للخادم.

والكلفة الدائمة على السياق صغيرة: خطّافا `PreToolUse` و`Stop` لا يُضيفان شيئًا إلى سياق
النموذج، وخطّاف `SessionStart` يُضيف سطرًا واحدًا — ملخّص الحالة `Loop: …` — ولا يفعل ذلك
إلا في مشروع فيه مجلّد `.mjloop/`.

وإن لم يُظهر `claude mcp list` الخادم متّصلًا، فالسبب المعتاد بناءٌ ناقص: تأكّد من وجود
`engine/dist/mcp/server.js` وأعد `npm run build`.

## أين يُنصَّب ماذا

| الموضع | المحتوى |
|---|---|
| مستودعك | كل شيء. المتجر يشير إليه مباشرةً. |
| `~/.claude/plugins/` | مُدخَل تسجيل يحمل مسارك — يُسجّل `known_marketplaces.json` مستودعك في `installLocation` — ونسخة كاملة من الشجرة تحت `~/.claude/plugins/cache/`. والنسخة ليست ما يعمل. |
| مشروعك، بعد `/mjloop:init` | مجلّد `.mjloop/` وقسم يُلحَق بـ `CLAUDE.md` |

لا يُكتب شيء في مشروع قبل أن تُشغّل `/mjloop:init` فيه.

## التحديث

اسحب، وأعد البناء، وحدّث المتجر:

```bash
git -C /path/to/mjloop pull
cd /path/to/mjloop/engine && npm install && npm run build
claude plugin marketplace update mjloop
```

ولأن موضع التثبيت هو المستودع نفسه، تكفي إعادة البناء غالبًا — وتحديث المتجر يلزم حين
يتغيّر بيان الإضافة أو أوامرها أو وكلاؤها أو مهاراتها.

## إلغاء التنصيب

```bash
claude plugin uninstall mjloop@mjloop
claude plugin marketplace remove mjloop
```

ولا يمسّ أيٌّ منهما مشاريعك: يبقى مجلّد `.mjloop/` وقسم `CLAUDE.md` في مكانهما، فاحذفهما
بيدك إن أردت إزالتهما.

## إضافته إلى مشروع

في المشروع الذي تريد العمل فيه:

```
/mjloop:init
```

يُجهّز `.mjloop/`، ويكتشف أوامر التحقّق من `package.json`، ويُلحق قسمًا قصيرًا بـ
`CLAUDE.md` كي تعرف أي جلسة في ذلك المشروع أن الإضافة موجودة.

وإن تعذّر اكتشاف أمر تحقّق، سألك `/mjloop:init` مرّة واحدة. ولن يخترعه: **أمر تحقّق ملفَّق
يُنتج نجاحًا كاذبًا**، وهو أسوأ من غياب الأمر أصلًا.

## معالجة المشكلات

**الأوامر لا تظهر.** يلتقط Claude Code الإضافة المُنصَّبة حديثًا خلال ثوانٍ، لكن مجلّدًا لم
يكن موجودًا عند بدء الجلسة يحتاج إعادة تشغيل.

**`MCP servers (0)` في `claude plugin details`.** قصورٌ في العرض في بعض إصدارات سطر
الأوامر لا عيبٌ في الإضافة — و`claude mcp list` هو الفحص الموثوق.

**خطّاف يُبلّغ بخطأ.** سكربتات الخطّافات تستدعي `engine/dist/cli/index.js` بالمسار، فإن كان
`dist/` مفقودًا أو قديمًا فأعد البناء.

## التالي

- [نبذة](./about.ar.md)
- [طريقة الاستخدام](./usage.ar.md)
