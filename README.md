# Sistem Absensi Siswa - LPK Tokyo

Sistem Absensi Siswa Otomatis per Sensei (Mobile First v3.0 PROD) berbasis Google Apps Script dan Google Sheets.

## Fitur Utama
- **Multi-Role & Autentikasi**: Login untuk Admin dan Sensei (Esti Sensei, Khaerul Sensei, Robbi Sensei, Rowi Sensei, Singgih Sensei, Evelyn Staff).
- **Manajemen Kelas & Siswa**:
  - Admin dapat memindahkan siswa antar kelas beserta riwayat absensinya.
  - Sensei dapat mengelola kehadiran dan mengeluarkan (kick) siswa dari kelasnya.
  - Tracking siswa keluar / siswa bebas yang siap dialihkan ke kelas lain.
- **Rekapitulasi Fleksibel**:
  - Rekap bulanan & tahunan interaktif.
  - Export data ke CSV/Excel dan Print PDF.
- **Tampilan Responsif**: Desain ramah perangkat seluler (Mobile-First) dan desktop.

## Struktur File
- `Index.html`: Antarmuka web (UI) interaktif, formulir absensi, dan dashboard.
- `Kode.gs`: Backend Google Apps Script yang mengontrol logika spreadsheet, autentikasi, dan manipulasi data.

## Panduan Pemasangan
1. Buat Google Spreadsheet baru di Google Drive.
2. Buka menu **Extensions** > **Apps Script**.
3. Buat file `Kode.gs` dan salin kode dari repositori ini.
4. Buat file HTML bernama `Index.html` dan salin kodenya dari repositori ini.
5. Klik **Deploy** > **New deployment** > Pilih jenis **Web app**.
6. Setel akses sesuai kebutuhan organisasi dan deploy.
