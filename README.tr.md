# cinematic-3d-video (Türkçe)

Claude'a **3D animasyon tarzı videolar** (logo/başlık açılışları, ürün tanıtımları, soyut hareket grafikleri, kamera
turları) yapmayı öğreten bir skill. Claude kodla bir Three.js sahnesi yazar, sahne headless Chrome'da kare kare
render edilir ve ffmpeg ile MP4'e çevrilir. Fotogerçekçi işler için Blender yolu da eklidir.

```
sahne.html (Three.js)  --window.seek(t)-->  scripts/render.mjs  -->  headless Chrome  -->  ffmpeg  -->  video.mp4
```

Render aracı gerçek zamanlı kayıt yapmaz, zamanı kare kare kendisi ilerletir. Bu yüzden çıktı her bilgisayarda aynıdır
ve ağır sahneler bile takılmadan çıkar. npm bağımlılığı yoktur; Node 22+, ffmpeg ve Chrome/Edge yeterlidir.

## Kurulum

**Claude Code:**

```powershell
# Windows (PowerShell)
git clone https://github.com/cumalibilgic/cinematic-3d-video "$env:USERPROFILE\.claude\skills\cinematic-3d-video"
```

**Claude.ai / masaüstü uygulaması:** `cinematic-3d-video` klasörünü zipleyip *Ayarlar, Yetenekler (Skills)* bölümünden
yükle. Skill'in Node, ffmpeg ve Chrome çalıştırabilen bir oturumda olması gerekir (en rahatı Claude Code).

**Gereksinimler (Windows):**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Kurulumdan sonra yeni bir terminal aç. Chrome veya Edge kuruluysa otomatik bulunur.

## Hızlı başlangıç

```powershell
# 1. Gerekli yerel araçların bulunup bulunmadığını kontrol et
node scripts\render.mjs --doctor

# 2. WebGL ve video kodlamayı dene (2 saniyelik video)
node scripts\render.mjs templates\smoke-test.html --out smoke.mp4 --duration 2 --width 640 --height 360

# 3. Başlangıç sahnesini kopyala ve birkaç kareye bak
Copy-Item -Recurse templates\starter my-video
node scripts\render.mjs my-video\index.html --stills 0,3,5.6,7.5 --out my-video\stills

# 4. Tam videoyu render et (--scale 2: daha pürüzsüz kenarlar)
node scripts\render.mjs my-video\index.html --out my-video\video.mp4 --scale 2

# Tarayıcıda canlı önizleme
node scripts\render.mjs my-video\index.html --serve
```

Ek seçenekler (hepsi `node scripts\render.mjs --help` çıktısında):

```powershell
# Tüm kareleri tek resimde gör (kontak sayfası)
node scripts\render.mjs my-video\index.html --stills 0,2,4,6 --sheet --out my-video\stills

# Sinematik hareket bulanıklığı: kare başına 8 alt kare
node scripts\render.mjs my-video\index.html --out video.mp4 --blur 8 --shutter 0.5

# Tüm çekirdekleri kullan: 4 Chrome aynı anda farklı bölümleri render eder
node scripts\render.mjs my-video\index.html --out video.mp4 --workers 4

# Saydam arka plan (WebM VP9 ya da ProRes 4444 için .mov)
node scripts\render.mjs my-video\index.html --out logo.webm --alpha

# Müzik: videoya eklenir, ses şiddeti (rms/low/mid/high) sahnede audio(t) ile okunur
node scripts\render.mjs my-video\index.html --out video.mp4 --audio muzik.mp3
```

Sayfanın başka sitelerden indirdiği her şey (CDN'deki Three.js, yazı tipleri, modeller) ilk render'da
`~/.cache/cinematic-3d-video` klasörüne kaydedilir; sonraki render'lar internetsiz de çalışır (`--no-cache` ile kapanır).

## Test

```powershell
node scripts\selftest.mjs     # yaklaşık 2 dakika; Node, ffmpeg ve Chrome yeterli, internet gerekmez
```

GitHub Actions bunu her push'ta çalıştırır ve başlangıç sahnesini de render edip karelerini (stills) çıktı olarak ekler.

Ya da doğrudan Claude'a söyle: *"'AURORA' için 10 saniyelik, parlayan halkalı, yavaş kamera dönüşlü sinematik 3D intro
yap, dikey 1080x1920."*

## Repo içeriği

- `SKILL.md`: Claude'un izlediği talimatlar
- `scripts/render.mjs`: bağımlılıksız render aracı
- `scripts/selftest.mjs`: uçtan uca testler
- `templates/smoke-test.html`: araç zincirini doğrulayan test sahnesi
- `templates/starter/`: Three.js başlangıç sahnesi (parlak nesne, halkalar, parçacıklar, bloom, kamera yolu, başlık)
- `templates/blender/`: Blender şablonu (Cycles, varsa GPU)
- `references/`: sahne sözleşmesi, sinematografi rehberi, sorun giderme, Blender notları

## Durum

Render hattı ve animasyon yardımcıları `scripts/selftest.mjs` ile test ediliyor (CI'da da çalışır). Yükseklik en az 160 px
olmalı (daha kısa görünüm Chrome'u kilitliyor, araç bunu reddeder). `--alpha` sayfa arka planını saydam yapar; Three.js
sahnesinde de saydam clear color gerekir, başlangıç sahnesinin bloom'u alpha ile henüz denenmedi. Başlangıç sahnesinin görünümü (ışık şiddetleri, bloom) göz ile
değil mantıkla ayarlandı; ilk gerçek render'da ayar yapman gerekebilir. Blender şablonu yazıldığı ortamda
çalıştırılamadı, ilk çalıştırmayı test olarak gör.

Lisans: MIT.
