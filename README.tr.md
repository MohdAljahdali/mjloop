# mjloop

> Claude Code için doğrulanmış geliştirme döngüleri.

[![Claude Code eklentisi](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · **Türkçe** · [Tiếng Việt](README.vi.md)

**Kodlama ajanlarının işi bitirdiğini kanıtlamasını sağlayın.**

`mjloop`, ajan çalışmasını sınırlı ve kanıta dayalı döngülere dönüştüren bir Claude Code
eklentisidir. Lider görev için doğru ajanları seçer, onları yalıtılmış bağlamlarda çalıştırır
ve başarıyı ancak motor projenizin kendi doğrulama komutlarının sonucunu kaydettikten sonra
kabul eder.

`istek → hat → yalıtılmış ajanlar → motor doğrulaması → kanıtlı sonuç`

> [!IMPORTANT]
> `mjloop` şu anda Claude Code'u destekler. Diğer kodlama ajanlarına yönelik adaptörler
> henüz yayımlanan eklentinin parçası değildir.

## Neden mjloop?

- **Güven değil kanıt** — başarı iddiası başarısız veya eksik bir motor makbuzunu geçersiz kılamaz.
- **Ajanların yeniden yazamayacağı durum** — çalışma durumu ve türetilmiş manifestolar MCP sunucusuna aittir.
- **Sınırlı özerklik** — döngü sınırı, durgunluk ve tekrarlanan hata korumaları ilerlemeyen işi durdurur.
- **Her işe uygun akış** — kısa düzenleme, çok döngülü geliştirme, önce yeniden üretmeye dayalı düzeltme veya incelenen planlama.

## Hızlı başlangıç

Claude Code, Node.js 20 veya üzeri ve Git gerekir.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Ardından bir projede Claude Code'u açın ve çalıştırın:

```text
/mjloop:init
/mjloop:edit kayıt formuna giriş doğrulaması ekle
```

> [!NOTE]
> MCP sunucusu ve hook CLI `engine/dist/` üzerinden çalıştığı için yeni bir klon bir kez
> derlenmelidir. [Tam kurulum kılavuzuna](docs/install.md) bakın.

## Doğru hattı seçin

| Komut | En uygun kullanım | Yerleşik kural |
|---|---|---|
| `/mjloop:edit <istek>` | Küçük, odaklı değişiklikler | Tek döngü; kapsam büyürse yükselt |
| `/mjloop:build <hedef>` | Özellikler ve büyük uygulamalar | Tamamlanana veya durana kadar doğrulanmış döngüler |
| `/mjloop:fix <sorun>` | Hatalar ve gerilemeler | Düzeltmeyi kabul etmeden önce hatayı yeniden üret |
| `/mjloop:plan <fikir>` | Fikri geliştirilebilir hikâyelere dönüştürme | Hikâyelerden önce uyum kontrolü ve onay |

Çalışmayı incelemek için `/mjloop:status`, sürdürmek için `/mjloop:resume`, durdurmak için
`/mjloop:stop` ve tarayıcı kokpitini açmak için `/mjloop:web` kullanın.

## Bir döngüde ne olur?

1. Lider seçilen hattan bir ekip oluşturur ve her isteğe bağlı uzmanın neden eklendiğini veya çıkarıldığını kaydeder.
2. Sözleşmeye bağlı ajanlar yalıtılmış bağlamlarda odaklanmış sorumluluklarla çalışır.
3. Motor başlangıçta sabitlenen doğrulama komutlarını çalıştırır ve tam günlüğü ajan anlatısının dışında saklar.
4. Başarısız doğrulama sonraki döngünün girdisi olur; geçerli bir makbuz çalışmayı kapatabilir.
5. Korumalar sınıra ulaşan, duran veya aynı hatayı tekrarlayan döngüleri durdurur.

## Yürütmeden daha fazlası

- **Özellik keşfi** — `mjloop-feature-discovery` becerisi her seferinde tek karar sorar ve
  bir insanın onaylayabileceği özette durur.
- **Proje bilinçli yönlendirme** — kabul edilen bileşen haritaları ve beceriler, devam eden
  çalışmayı değiştirmeden sabit rolleri yönlendirir.
- **Tarayıcı kokpiti** — `/mjloop:web` ile çalışmalar, planlar, hikâyeler, kanıtlar, yapılandırma ve belleği inceleyin.
- **Genişletilebilir hatlar** — `/mjloop:add` ile ajan, beceri veya hat ekleyin.

> [!TIP]
> Gerçek ve sınırlı bir değişiklikte `/mjloop:edit` ile başlayın. Çok döngülü çalışmanın
> maliyeti olmadan doğrulama sözleşmesini görmenin en hızlı yoludur.

## Devamını okuyun

- [mjloop neden var](docs/about.md)
- [Kurulum ve sorun giderme](docs/install.md)
- [Komutlar, yapılandırma ve iş akışları](docs/usage.md)
- [Arapça belgeler](docs/about.ar.md)

`mjloop` tanıdığınız bir sorunu çözüyorsa, başka geliştiricilerin de bulabilmesi için
depoya yıldız vermeyi düşünün.
