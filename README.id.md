# mjloop

> Siklus pengembangan terverifikasi untuk Claude Code.

[![Plugin Claude Code](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · **Bahasa Indonesia** · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**Buat agen pemrograman membuktikan bahwa pekerjaannya selesai.**

`mjloop` adalah plugin Claude Code yang mengubah pekerjaan agen menjadi siklus terbatas
dan berbasis bukti. Seorang pemimpin memilih agen yang tepat, menjalankannya dalam konteks
terisolasi, dan hanya menerima keberhasilan setelah mesin mencatat hasil perintah
verifikasi milik proyek Anda.

`permintaan → jalur → agen terisolasi → verifikasi mesin → hasil berbukti`

> [!IMPORTANT]
> Saat ini `mjloop` mendukung Claude Code. Adaptor untuk agen pemrograman lain belum
> menjadi bagian dari plugin yang dirilis.

## Mengapa mjloop?

- **Bukti, bukan keyakinan** — klaim berhasil tidak dapat menggantikan bukti mesin yang gagal atau hilang.
- **Status yang tidak dapat ditulis ulang agen** — server MCP memiliki status proses dan manifes turunan.
- **Otonomi terbatas** — batas siklus serta pelindung stagnasi dan kesalahan berulang menghentikan pekerjaan tanpa kemajuan.
- **Alur untuk setiap tugas** — edit singkat, build multisiklus, perbaikan yang diawali reproduksi, atau perencanaan yang ditinjau.

## Mulai cepat

Anda memerlukan Claude Code, Node.js 20 atau lebih baru, dan Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Kemudian buka Claude Code di sebuah proyek dan jalankan:

```text
/mjloop:init
/mjloop:edit tambahkan validasi input ke formulir pendaftaran
```

> [!NOTE]
> Klon baru harus dibangun sekali karena server MCP dan CLI hook berjalan dari
> `engine/dist/`. Lihat [panduan instalasi lengkap](docs/install.md).

## Pilih jalur yang tepat

| Perintah | Cocok untuk | Aturan bawaan |
|---|---|---|
| `/mjloop:edit <permintaan>` | Perubahan kecil dan terarah | Satu siklus; eskalasi jika cakupan membesar |
| `/mjloop:build <tujuan>` | Fitur dan implementasi besar | Ulangi siklus terverifikasi hingga selesai atau berhenti |
| `/mjloop:fix <masalah>` | Cacat dan regresi | Reproduksi kegagalan sebelum menerima perbaikan |
| `/mjloop:plan <ide>` | Mengubah ide menjadi cerita yang dapat dibangun | Periksa kecocokan dan minta persetujuan sebelum membuat cerita |

Gunakan `/mjloop:status` untuk memeriksa proses, `/mjloop:resume` untuk melanjutkan,
`/mjloop:stop` untuk menghentikan, dan `/mjloop:web` untuk membuka kokpit di browser.

## Apa yang terjadi dalam satu siklus?

1. Pemimpin menyusun tim dari jalur yang dipilih dan mencatat alasan setiap spesialis disertakan atau diabaikan.
2. Agen yang terikat kontrak bekerja dalam konteks terisolasi dengan tanggung jawab yang fokus.
3. Mesin menjalankan perintah yang dipatok saat proses dimulai dan menyimpan log lengkap di luar narasi agen.
4. Verifikasi gagal menjadi masukan siklus berikutnya; bukti lulus dapat menutup proses.
5. Pelindung menghentikan siklus yang mencapai batas, stagnan, atau mengulang kegagalan yang sama.

## Lebih dari eksekusi

- **Penemuan fitur** — skill `mjloop-feature-discovery` menanyakan satu keputusan setiap
  kali dan berhenti pada ringkasan yang dapat disetujui manusia.
- **Perutean sadar proyek** — peta komponen dan skill yang diterima memandu peran tetap
  tanpa mengubah proses yang sedang berjalan.
- **Kokpit browser** — periksa proses, rencana, cerita, bukti, konfigurasi, dan memori melalui `/mjloop:web`.
- **Jalur yang dapat diperluas** — tambahkan agen, skill, atau jalur dengan `/mjloop:add`.

> [!TIP]
> Mulailah dengan `/mjloop:edit` pada perubahan nyata yang terbatas. Ini cara tercepat
> melihat kontrak verifikasi tanpa biaya proses multisiklus.

## Baca selanjutnya

- [Mengapa mjloop dibuat](docs/about.md)
- [Instalasi dan pemecahan masalah](docs/install.md)
- [Perintah, konfigurasi, dan alur kerja](docs/usage.md)
- [Dokumentasi bahasa Arab](docs/about.ar.md)

Jika `mjloop` menyelesaikan masalah yang Anda kenal, pertimbangkan memberi bintang pada
repositori agar pengembang lain dapat menemukannya.
