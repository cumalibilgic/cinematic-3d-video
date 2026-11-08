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

Ya da doğrudan Claude'a söyle: *"'AURORA' için 10 saniyelik, parlayan halkalı, yavaş kamera dönüşlü sinematik 3D intro
yap, dikey 1080x1920."*

## Repo içeriği

- `SKILL.md`: Claude'un izlediği talimatlar
- `scripts/render.mjs`: bağımlılıksız render aracı
- `templates/smoke-test.html`: araç zincirini doğrulayan test sahnesi
- `templates/starter/`: Three.js başlangıç sahnesi (parlak nesne, halkalar, parçacıklar, bloom, kamera yolu, başlık)
- `templates/blender/`: Blender şablonu (Cycles, varsa GPU)
- `references/`: sahne sözleşmesi, sinematografi rehberi, sorun giderme, Blender notları

## Durum

Render hattı ve animasyon yardımcıları test edildi. Başlangıç sahnesinin görünümü (ışık şiddetleri, bloom) göz ile
değil mantıkla ayarlandı; ilk gerçek render'da ayar yapman gerekebilir. Blender şablonu yazıldığı ortamda
çalıştırılamadı, ilk çalıştırmayı test olarak gör.

Lisans: MIT.
