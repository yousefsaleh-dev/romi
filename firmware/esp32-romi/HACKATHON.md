# ROMI — دليل تشغيل مستقل من غير ما تحتاج تكلم Codex

## الفكرة في دقيقة

كود ESP32 بيتحول لملف بواسطة **build**، وبيتكتب في ذاكرة البورد بكابل USB بواسطة **flash / upload**. بعد كده البورد تشغّله بنفسها كل ما تتوصل بالكهرباء. **Serial Monitor** هو شاشة الـlogs بتاعتها على الكمبيوتر.

رابط الموقع وتوكن الجهاز وشهادة HTTPS جاهزين في `include/romi_secrets.h` المرفوع على GitHub. أول flash يسأل عن اسم Wi-Fi 2.4 GHz وكلمة السر فقط. تغيير الواي فاي بعد ذلك: اختيار 2 أو `romi.ps1 wifi` ثم flash تاني. التوكن هو نفس `ROMI_DEVICE_TOKEN` على Vercel؛ مفيش Gemini أو Supabase secrets على البورد.

**Plan A هو ESP32 مستقلة بالصوت والزرار**. اتبع [STANDALONE.md](STANDALONE.md): wiring → audio-bench → flash full (يطلب الواي فاي أول مرة) → ضغطة زرار. الكمبيوتر للرفع والاختبار؛ بعد الرفع شاحن USB يكفي. هذا الملف فيه التحضير والأعطال وبديل الموبايل لو قطع الصوت ناقصة.

## 1. جهّز الكمبيوتر قبل المسابقة

من PowerShell في جذر المشروع:

```powershell
.\firmware\esp32-romi\romi.ps1 prepare
.\firmware\esp32-romi\romi.ps1 doctor
```

`prepare` يجهز PlatformIO ويبني اختبارات القطع ووضع الصوت المستقل ووضع الباب فقط ويحفظ الأدوات المطلوبة محليًا. لو Python ناقص، ثبّت Python 3.11 أو أحدث مع إضافته لـPATH ثم كرر الأمر. لو Windows منع السكريبت، نفّذ في **نافذة PowerShell الحالية فقط**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

- استخدم نفس الكمبيوتر ونفس حساب Windows في المسابقة. احتفظ بمجلد المشروع كاملًا، بما فيه `.tools` و`.pio`، وكاش `%USERPROFILE%\.platformio`. `clone` ينقل إعدادات السيرفر الجاهزة، لكنه لا ينقل الأدوات المحمّلة أو إعدادات شبكة مسابقة لم تدخلها بعد.
- إعدادات الجهاز جاهزة: الرابط والتوكن والشهادة لا تحتاج إعادة كتابتها يوم المسابقة. ملفات env السيرفر محفوظة محليًا وعلى Vercel، وتحتاج نسخة محلية للاختبارات. بعد دخول شبكة المسابقة أول مرة تُحفظ محليًا داخل header وتحتاج flash لتدخل البورد.
- جهز كابلين USB **بيوصلوا بيانات**، hotspot موبايل 2.4 GHz، وتعريف USB المناسب محفوظ قبل المسابقة: [CP210x الرسمي](https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers) أو تعريف CH340/CH341 من WCH حسب الشريحة المكتوبة على البورد.
- افتح الدليل ده أو اطبعه. لو تقدر تستعير ESP32 وservo قبل المسابقة، اختبر التوصيل مرة واحدة؛ نجاح build لا يثبت الكهرباء أو الحركة.

## 2. اختبر Vercel قبل ربط البورد

بعد النشر وإعداد server env وتطبيق migrations على Supabase:

```powershell
$env:ROMI_TEST_BASE_URL = 'https://romi-deci.vercel.app'
pnpm smoke:device:external
```

السكريبت يقرأ التوكن من `.env.local`: لازم يطابق Vercel. الاختبار الافتراضي يفحص رفض الطلبات غير الصالحة من خارج Vercel؛ لا يحرك بابًا ولا ينشئ حجزًا. لازم يظهر `PASS`؛ ده وحده لا يثبت دورة الباب كاملة.

لدورة كاملة على السيرفر **بدون هاردوير** استخدم Vercel staging وSupabase staging منفصلين، واضبط `.env.local` على نفس قاعدة staging. اقفل أي ESP32 متصلة بهذا السيرفر، وخلي طابور الباب خاليًا:

```powershell
$env:ROMI_TEST_ISOLATED_DB = 'YES'
$env:ROMI_TEST_ALLOW_DOOR_COMMAND = 'YES'
pnpm smoke:device:external
Remove-Item Env:ROMI_TEST_ISOLATED_DB, Env:ROMI_TEST_ALLOW_DOOR_COMMAND
```

ده ينشئ جلسة وحجزًا تجريبيًا، يستقبل أمر الباب مثل ESP32، يرسل ACK صناعيًا، ويتأكد من تحديث الحجز وينظف بيانات التجربة. لا تشغله على طابور باب حقيقي؛ هو نفسه يستهلك الأمر. نتائج الاختبار الحالي موثقة في [deployment-device-tests.md](../../docs/deployment-device-tests.md)، بما فيها الاختبار الكامل بعد إصلاح SQL والمفتاح.

لو رجعت صفحة login من Vercel بدل JSON، استخدم deployment متاح للطلبات الخارجية؛ ESP32 لا تعرف تسجيل الدخول في Deployment Protection.

## 3. يوم التركيب: اختبر قطعة قطعة

### أ. البورد فقط

1. اقرأ الاسم على الوحدة المعدنية: هذا build لـ**ESP32 / ESP-WROOM-32**، مش S3/C3. لو مختلفة، استخدم browser simulator حتى تعمل board config وpins مناسبين؛ لا ترفع build الكلاسيك عشوائيًا عليها.
2. وصل USB وشغّل `doctor`. رقم مثل COM7 طبيعي؛ **Intel SOL مش ESP32**. الأداة تختار USB serial فقط وتطلب الاختيار لو فيه أكتر من واحدة.
3. ارفع اختبار بدون واي فاي أو توكن:

```powershell
.\firmware\esp32-romi\romi.ps1 test
```

يرفع bench ويفتح logs. المفروض تشوف `[BOOT]` ثم `[BENCH]`. `Ctrl+C` يقفل الـmonitor؛ اقفله قبل أي flash جديد.

### ب. الزرار والـLEDs

| القطعة | التوصيل |
| --- | --- |
| الزرار | GPIO33 ← زرار → GND؛ بدون مقاومة خارجية |
| LED أحمر | GPIO25 → مقاومة 330Ω → رجل LED الطويلة؛ القصيرة → GND |
| LED أخضر | GPIO26 → مقاومة 330Ω → رجل LED الطويلة؛ القصيرة → GND |

في bench الأخضر منور. ضغطة الزرار تحول الحالة المحلية إلى active والأحمر ينور؛ التالية ترجع idle. **في core bench الزرار محلي فقط. في full يبدأ/يلغي جلسة البورد؛ لا يفتح الباب مباشرة.** الزرار ذو 4 أرجل فيه أرجل متصلة داخليًا: اختبر بالأفوميتر أن الرجلين المختارتين يتصلوا فقط أثناء الضغط.

### ج. Servo SG90

| سلك servo | التوصيل |
| --- | --- |
| Signal، غالبًا برتقالي/أصفر | GPIO23 |
| +، غالبًا أحمر | مصدر 5V خارجي |
| GND، غالبًا بني/أسود | GND المشترك |

راجع ألوان القطعة نفسها. ESP32 تغذيتها USB. **الأرضي مشترك** بين ESP32 ومصدر 5V والservo. لا توصل +5V الخارجي للـESP32 وهي USB، ولا تغذي servo من GPIO. مكثف 1000µF rated 10V: `+` إلى 5V الخارجي و`-` إلى GND.

شغّل `test` واكتب `T`: يفتح، ينتظر، يقفل. `O` يفتح، `C` يقفل، `S` يطبع الحالة. لا ترسل ACK. ابدأ والservo منفصل عن ميكانيزم الباب. لو اتجاهه أو مداه غلط، غيّر فقط `DOOR_CLOSED_ANGLE` و`DOOR_OPEN_ANGLE` في `include/romi_config.h` ثم كرر `test`.

## 4. الموقع جاهز؛ اختار شبكة المسابقة

```powershell
.\firmware\esp32-romi\romi.ps1 wifi
```

هذا يطلب اسم Wi-Fi 2.4 GHz وكلمة السر فقط، ويحافظ على رابط الموقع والتوكن والشهادة. ليس ضروريًا قبل أول flash: اختيار 5/8 سيطلب الواي فاي تلقائيًا.

لو غيرت السيرفر أو التوكن، استخدم `romi.ps1 configure` بدلًا منه. الأمر الكامل يطلب بالترتيب: اسم Wi-Fi 2.4 GHz، كلمة السر، رابط Vercel بدون `/api`، توكن الجهاز، ومسار root CA PEM موثوق. **اضغط Enter عند سؤال CA ليكتشفها تلقائيًا عبر اتصال يتحقق منه Windows**. كلمة السر والتوكن لا يظهران أثناء الكتابة. الإعدادات في `include/romi_secrets.h` المتتبع في GitHub بطلب المالك.

شهادة HTTPS للـdeployment الحالي جاهزة بالفعل. أعد configure فقط لو غيرت السيرفر أو الشهادة. لو الاكتشاف فشل، راجع الإنترنت/تاريخ Windows أو أدخل PEM من جهة الشهادة الرسمية. شهادة السيرفر المؤقتة ليست بديلًا عن root CA. يمكن وضع أكثر من root PEM في ملف واحد. إذا مضطر لعرض demo بدونها، اكتب `SKIP` عند سؤال CA؛ flash شبكة عادي يتوقف برسالة واضحة، والبديل الصريح تحت. لو غيّرت deployment أو شهادة الموقع لاحقًا، أعد configure وflash عند الحاجة.

بدون حساس باب، ومع قطع الصوت استخدم **full** حسب STANDALONE.md. الأوامر التالية لوضع **الباب فقط مع صوت الموبايل**:

```powershell
.\firmware\esp32-romi\romi.ps1 test -Mode audio-bench
.\firmware\esp32-romi\romi.ps1 flash -Mode full
.\firmware\esp32-romi\romi.ps1 monitor
```

لو CA هي العائق في عرض الهاكاثون فقط، هذا الخيار مسموح صراحة في demo:

```powershell
.\firmware\esp32-romi\romi.ps1 flash -Mode demo -InsecureTls
```

يعطل التحقق من شهادة HTTPS ويعلن تحذيرًا؛ ليس production. ما زال يحتاج إنترنت وساعة NTP. demo يعلن أيضًا أن حركة servo الزمنية تُعتبر نجاحًا **بدون إثبات من حساس**.

انتظر: `[WIFI] Connected` → `[TIME] Synchronized` → `[API] No pending command`. ده يثبت اتصال البورد بالـAPI، وليس أنها فتحت بابًا بعد.

## 5. شغّل الصوت والباب معًا

**مع INMP441 وMAX98357A وسماعة:** نفذ دليل [التشغيل المستقل](STANDALONE.md). ارفع `flash -Mode full`، انتظر Wi-Fi/NTP، ثم اضغط GPIO33. البورد تطلب `/api/ai/session` وتبدأ التحية بنفسها. الضغطة التالية تلغي الجلسة. الباب يتحرك فقط بأمر صحيح من API بعد المحادثة، لا بسبب الضغطة مباشرة. وضع full يعلن افتراض نجاح السيرفو بدون حساس.

**بدون قطع الصوت:** ارفع `flash -Mode demo`، افتح `/dashboard/kiosk` على **موبايل** بعد admin login، أدخل device token واسمح بالمايك ثم ابدأ من الشاشة. في هذا البديل الزرار المادي لا يتحكم بمتصفح الموبايل. `/dashboard/simulation` لا يصدر أوامر باب حقيقية. مفيش افتراض إن الـPC فيه مايك.

اختبر حجزًا داخل entry window أو إنشاء موعد يسمح بالدخول الآن مع موافقة صريحة. راقب command → Opening → Closing → ACK. قطع hotspot وإعادته يختبر reconnect؛ قد ينتهي الأمر السابق، ولا يجوز إعادة حركة نفس ID.

## 6. لو حاجة ناقصة: اختار البديل

| الموجود/المشكلة | المسار |
| --- | --- |
| ESP32 + mic + amp + speaker + servo + إنترنت | Plan A: audio-bench ثم full؛ الزرار يبدأ الجلسة على البورد |
| ESP32 + servo بدون قطع صوت | Plan B: موبايل `/dashboard/kiosk` + demo؛ البدء من شاشة الموبايل |
| Wi-Fi المكان صفحة موافقة/فاشل | hotspot 2.4 GHz ثم configure وflash |
| إنترنت البورد فاشل والموبايل online | simulator على الموبايل + bench وT لحركة يدوية؛ ليست دورة API متصلة |
| Gemini متعطل/الحصة انتهت | الحجوزات + bench servo؛ لا تدّعي صوتًا يعمل |
| مفيش servo أو مصدر 5V | simulator على الموبايل؛ لا تغذي servo من GPIO |
| البورد S3/C3 أو قطع صوت مختلفة | board config وpin/driver review قبل flash؛ build الكلاسيك غير مناسب تلقائيًا |
| مفيش إنترنت | audio-bench/bench فقط؛ Gemini والـAPI لا يعملان offline |

جهز البرامج والـdeployment واختبار API **قبل** المنافسة. عند استلام القطع: البورد/button/LED → servo → tone/levels → Wi-Fi/API → زرار ومحادثة → الباب → تجربة فصل الكمبيوتر. لا توصل ميكانيزم باب حقيقي قبل اختبار الكهرباء والحركة.

## 7. دليل الأعطال السريع

| العرض | افعل بالترتيب |
| --- | --- |
| لا يظهر USB serial | كابل بيانات آخر → USB آخر → Device Manager وتعريف CP210x/CH340 حسب البورد؛ تجاهل Intel SOL |
| Access denied / port busy | اقفل كل Serial Monitor وArduino IDE terminal؛ أعد المحاولة |
| Upload عالق على Connecting | امسك BOOT أثناء Connecting واتركه عند بدء الكتابة. للدخول اليدوي: امسك BOOT، اضغط EN واتركه، اترك BOOT؛ ثم upload |
| Invalid packet / انقطاع upload | افصل تغذية servo مؤقتًا، بدّل الكابل؛ خفّض `upload_speed` في `platformio.ini` إلى 115200 |
| لا توجد logs | monitor على المنفذ الصحيح و115200؛ اضغط EN مرة لإعادة التشغيل |
| Brownout / resets عند الحركة | راجع مصدر 5V منفصل وكفاية التيار وGND والمكثف والقطبية؛ افصل حمل servo لتحديد السبب |
| Servo ساكت والlogs تقول حركة | افحص 5V وGND وsignal23 والألوان؛ `servo.write` لا يثبت حركة فعلية |
| Servo بيزن/يصطدم بالنهاية | افصل الميكانيزم وقلّل مدى الزوايا وأعد flash؛ لا تجبره على نهاية مشواره |
| الزرار لا يستجيب/دائمًا active | راجع أرجل الزرار وGPIO33 وGND؛ continuity عند الضغط فقط |
| Wi-Fi Connecting باستمرار | الاسم/كلمة السر و2.4 GHz؛ hotspot بدون captive portal؛ configure ثم flash |
| Waiting for NTP | الشبكة تمنع ضبط الساعة؛ غيّر الشبكة. لا تتخطى expiry يدويًا |
| HTTP 401 | نفس device token في Vercel والبورد وkiosk؛ deploy بعد تغيير env ثم configure/flash |
| HTTP سالب، مثل -1 | راجع الإنترنت والرابط والساعة وroot CA؛ demo insecure للتشخيص الصريح فقط |
| HTTP -1000 / Invalid JSON / 3xx | response كبير/مقطوع/غير متوقع؛ راجع origin وDeployment Protection وVercel logs؛ لا تعوّض بتحريك servo |
| HTTP 5xx | Vercel logs وإعدادات Supabase/migrations؛ البورد تعمل backoff تلقائيًا |
| No pending command رغم المحادثة | full على البورد أو kiosk على الموبايل؛ ليست simulation. حجز داخل entry window وجلسة فعالة |
| Door feedback unavailable | safe/full-safe يحتاج حساسًا؛ استخدم demo/full صراحة للهاكاثون |
| Expired / ACK 409 | TTL الأمر 20 ثانية أو سبق ACK؛ راجع الحجز واعمل تجربة جديدة، لا تعيد حركة نفس الأمر |
| Command صار sent ثم restart | السيرفر الحالي لا يعيد تسليم sent؛ راجع dashboard ثم أمر جديد حسب حالة الحجز |
| صوت المتصفح لا يبدأ | على الموبايل: HTTPS وإذن mic. على البورد: audio-bench وM/A ثم session HTTP/Live logs. راجع GEMINI_API_KEY على Vercel وحصة Gemini |

## 8. ورقة الأوامر

من جذر المشروع؛ بدون arguments يعرض menu:

```powershell
.\firmware\esp32-romi\romi.ps1
.\firmware\esp32-romi\romi.ps1 prepare
.\firmware\esp32-romi\romi.ps1 configure
.\firmware\esp32-romi\romi.ps1 doctor
.\firmware\esp32-romi\romi.ps1 ports
.\firmware\esp32-romi\romi.ps1 test
.\firmware\esp32-romi\romi.ps1 test -Mode audio-bench
.\firmware\esp32-romi\romi.ps1 flash -Mode full
.\firmware\esp32-romi\romi.ps1 monitor
```

لو عدة منافذ، أضف `-Port COM7` بعد التأكد من رقم البورد. `build -Mode safe` يفحص الترجمة فقط. `flash -Mode safe` بدون demo assumptions لكنه يحتاج تنفيذ حساس حقيقي لكي يقر نجاح فتح الباب. pins والزوايا والتوقيتات في `include/romi_config.h`؛ flags تكتبها الأداة في `romi_local.h` المتتبع في GitHub بطلب المالك، فاختيار mode من الأداة يغلب defaults.

## 9. قطع الصوت في Plan A

INMP441: 3.3V فقط، L/R إلى GND، SCK14 وWS27 وSD32. MAX98357A: 5V الخارجي، BCLK14 وLRC27 وDIN22. clocks مشتركة عمدًا وdata منفصلة. السماعة 4Ω تقريبًا/3W بين Amp+ وAmp-؛ **Speaker- لا يتوصل GND**. كل GND مشتركة. SD وGAIN حسب القطعة الفعلية قبل التجربة. Wokwi custom placeholders لا تثبت الصوت. وضع full يشغل قطع الصوت مباشرة؛ audio-bench يختبرها بدون Gemini. لا يوجد إثبات hardware قبل تجربة القطع نفسها.

تعليمات BOOT والتعريفات: [Espressif Arduino troubleshooting](https://docs.espressif.com/projects/arduino-esp32/en/latest/troubleshooting.html)، [Espressif flashing troubleshooting](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/flashing-troubleshooting.html).
