# Daftar Periksa Privasi Faceless & Pengaturan Channel Telegram

Acuan: PRD §9 (Privasi faceless, Merek, Keamanan). Semua butir wajib diverifikasi **sebelum channel dipublikasikan** dan dicek ulang setiap ada perubahan admin atau bot.

## 1. Pengaturan Channel Publik (Faceless)

- [ ] **Matikan "Sign messages" (Tanda tangan pesan):** Channel Settings → Administrators / Channel Info → pastikan opsi *Sign Messages* dalam keadaan **OFF** agar nama akun admin tidak muncul di bagian bawah postingan.
- [ ] **Nama & username channel memakai brand:** Gunakan nama brand (`Radar Tomica Jepang`), bukan nama pribadi, inisial, atau lokasi kuliah/kota operator.
- [ ] **Bio, deskripsi, dan foto profil bebas data pribadi:** Tidak ada nama pribadi, nomor telepon, akun Telegram pribadi, atau foto wajah/lingkungan pribadi di bio, deskripsi, maupun foto profil channel.
- [ ] **Foto profil & visual tanpa logo resmi Takara Tomy:** Jangan memakai logo resmi Takara Tomy / Tomica agar tidak melanggar merek dagang.

## 2. Disclaimer Merek (Pesan Sematan & Deskripsi)

- [ ] **Deskripsi channel mencantumkan keterangan tidak resmi:**
  > Channel ini tidak resmi dan tidak berafiliasi dengan Takara Tomy. Tomica adalah merek dagang milik Takara Tomy.
- [ ] **Pesan sematan (pinned message) memuat disclaimer yang sama**, aturan PO ringkas, serta kontak pemesanan berbasis brand (bukan nomor/akun pribadi).

## 3. Metadata Foto (EXIF Stripping)

- [ ] **Bersihkan metadata EXIF sebelum mengunggah foto QC/produk:** Foto kamera/HP menyimpan koordinat GPS, model perangkat, dan waktu lokal yang dapat membuka identitas/lokasi operator.
  - Contoh pembersihan lokal sebelum unggah:
    ```bash
    exiftool -all= -overwrite_original foto_qc.jpg
    ```
  - Kirim foto di Telegram sebagai **Photo** (terkompresi), bukan sebagai File/Document mentah, setelah EXIF dibersihkan.

## 4. Hak Akses Bot & Keamanan

- [ ] **Hak bot di channel = Post messages saja:** Tambahkan bot sebagai administrator channel dengan **hanya izin `Post Messages`** aktif. Matikan izin *Edit messages of others*, *Delete messages*, *Add new admins*, *Manage users*, dan *Change channel info*.
- [ ] **ID operator terkunci:** Pastikan `TELEGRAM_OPERATOR_CHAT_ID` di `.env` adalah user ID Telegram operator; bot menolak semua perintah dan tombol persetujuan dari user ID lain.
- [ ] **Autentikasi dua langkah (2FA):** Aktifkan Two-Step Verification pada akun Telegram operator, akun server/VPS, dan basis data.
- [ ] **Rahasia tidak bocor:** Token bot (`TELEGRAM_BOT_TOKEN`) dan API key hanya disimpan di `.env` / secret store — tidak pernah ditulis di kode, log, sheet, atau prompt.

## 5. Verifikasi Akhir

- [ ] **Tinjau channel dari akun Telegram lain (atau mode publik/web):** Pastikan tidak ada nama, foto, nomor telepon, atau tanda tangan operator yang terlihat pada postingan maupun info channel.
