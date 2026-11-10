# Git: fork dan pembaruan dari repo asli

Repo ini adalah fork dari Bang Story. Dua remote sudah diatur:

| Remote | Alamat | Fungsi |
|---|---|---|
| `origin` | https://github.com/dambeldani/bang-story.git | Fork milik sendiri. Tempat `git push` dan `git pull` sehari-hari. |
| `upstream` | https://github.com/bangtutorial/bang-story.git | Repo asli. Hanya untuk menarik pembaruan; tidak punya izin tulis. |

Cek kapan saja dengan `git remote -v`. Baris `origin` harus menunjuk ke `dambeldani`.

## Kerja sehari-hari

```bash
git add <file>
git commit -m "pesan"
git push origin main
```

Jangan menjalankan `git push upstream`. Pushnya akan ditolak, dan memang bukan tujuannya.

## Menarik pembaruan dari repo asli

```bash
git fetch upstream                        # ambil perubahan, belum mengubah apa pun
git log HEAD..upstream/main --oneline     # lihat apa yang baru (kosong = tidak ada)
git merge upstream/main                   # gabungkan ke branch ini
git push origin main                      # kirim hasilnya ke fork
```

Alternatif: tombol **Sync fork** di halaman fork GitHub, lalu `git pull origin main` di komputer.

Aturan:

1. **Commit dulu** semua pekerjaan sebelum `merge`. Perubahan yang belum di-commit membuat konflik sulit dibaca.
2. **Baca `git log HEAD..upstream/main` dulu** untuk tahu apa yang akan masuk.
3. **Migrasi database bisa bertabrakan.** Migrasi fitur kita ada di `MIGRATIONS` (`src/main/db/index.ts`), nomor 8 (`video_source`). Kalau repo asli juga menambah migrasi nomor yang sama, jangan digabung begitu saja. Pindahkan salah satunya ke nomor berikutnya, tetap di akhir array, dan jangan ubah migrasi lama (lihat AGENTS.md aturan 3).
4. File inti yang kita ubah dan paling mungkin konflik: `ipc.ts`, `repo.ts`, `generation.ts`, `shared/types.ts`, `shared/api.ts`, `preload/index.ts`, `Settings.tsx`, `StoryboardStep.tsx`.
5. Setelah merge selesai, jalankan `npm run typecheck` dan `npm run build`.

## Yang tidak boleh ikut ter-commit

- `googleflow.html` (cuplikan halaman Flow, berisi nama dan email akun Google). Sudah ada di `.gitignore`.
- Kunci API, token, dan isi folder data aplikasi. Kunci disimpan terenkripsi di folder data pengguna, bukan di repo.

## Identitas commit

Commit memakai `user.name` dan `user.email` dari konfigurasi git. Cek dengan `git config user.name` dan `git config user.email`. Kalau ingin commit terhubung ke akun GitHub `dambeldani`, atur:

```bash
git config user.name "nama"
git config user.email "email-github"
```
