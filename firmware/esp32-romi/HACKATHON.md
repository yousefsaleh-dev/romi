# ROMI — دليل تشغيل مستقل من غير ما تحتاج تكلم Codex

## الفكرة في دقيقة

كود ESP32 بيتحول لملف بواسطة **build**، وبيتكتب في ذاكرة البورد بكابل USB بواسطة **flash / upload**. بعد كده البورد تشغّله بنفسها كل ما تتوصل بالكهرباء. **Serial Monitor** هو شاشة الـlogs بتاعتها على اللابتوب.

اسم الواي فاي وكلمة السر ورابط الموقع وتوكن الجهاز بنكتبهم في إعدادات محلية، وبعدها flash. تغيير الواي فاي يحتاج configure ثم flash تاني. التوكن هو نفس `ROMI_DEVICE_TOKEN` على Vercel؛ مفيش Gemini أو Supabase secrets على البورد.

**المسار الجاهز للمسابقة:** اللابتوب/الموبايل يشغل الصوت من المتصفح، وESP32 تشغل الباب. الاتنين يتواصلوا مع موقعك المنشور؛ مش لازم يكونوا على نفس الشبكة. قطع صوت ESP32 لو موجودة تفضل اختيارية: كود I2S/Gemini على البورد لسه مش منفّذ.

## 1. جهّز اللابتوب قبل المسابقة

من PowerShell في جذر المشروع:

```powershell
.\firmware\esp32-romi\romi.ps1 prepare
.\firmware\esp32-romi\romi.ps1 doctor
```

`prepare` يجهز PlatformIO ويبني bench وdemo وsafe ويحفظ الأدوات المطلوبة محليًا. لو Python ناقص، ثبّت Python 3.11 أو أحدث مع إضافته لـPATH ثم كرر الأمر. لو Windows منع السكريبت، نفّذ في **نافذة PowerShell الحالية فقط**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

- استخدم نفس اللابتوب ونفس حساب Windows في المسابقة. احتفظ بمجلد المشروع كاملًا، بما فيه `.tools` و`.pio`، وكاش `%USERPROFILE%\.platformio`. `clone` لوحده لا ينقل الإعدادات الخاصة أو الأدوات المحمّلة.
- احتفظ بنسخة خاصة آمنة من `.env.local` و`include/romi_secrets.h` بعد إعدادها. الاتنين مش في Git؛ لا ترفعهم.
- جهز كابلين USB **بيوصلوا بيانات**، hotspot موبايل 2.4 GHz، وتعريف USB المناسب محفوظ قبل المسابقة: [CP210x الرسمي](https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers) أو تعريف CH340/CH341 من WCH حسب الشريحة المكتوبة على البورد.
- افتح الدليل ده أو اطبعه. لو تقدر تستعير ESP32 وservo قبل المسابقة، اختبر التوصيل مرة واحدة؛ نجاح build لا يثبت الكهرباء أو الحركة.

## 2. اختبر Vercel قبل ربط البورد

بعد النشر وإعداد server env وتطبيق migrations على Supabase:

```powershell
$env:ROMI_TEST_BASE_URL = 'https://YOUR-DEPLOYMENT.vercel.app'
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

ده ينشئ جلسة وحجزًا تجريبيًا، يستقبل أمر الباب مثل ESP32، يرسل ACK صناعيًا، ويتأكد من تحديث الحجز وينظف بيانات التجربة. لا تشغله على طابور باب حقيقي؛ هو نفسه يستهلك الأمر. اختبار Vercel ينتظر deployment؛ لم يُنفّذ قبل النشر.

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

في bench الأخضر منور. ضغطة الزرار تحول الحالة المحلية إلى active والأحمر ينور؛ التالية ترجع idle. **الزرار لا يفتح الباب ولا يبدأ صوت المتصفح تلقائيًا.** الزرار ذو 4 أرجل فيه أرجل متصلة داخليًا: اختبر بالأفوميتر أن الرجلين المختارتين يتصلوا فقط أثناء الضغط.

### ج. Servo SG90

| سلك servo | التوصيل |
| --- | --- |
| Signal، غالبًا برتقالي/أصفر | GPIO23 |
| +، غالبًا أحمر | مصدر 5V خارجي |
| GND، غالبًا بني/أسود | GND المشترك |

راجع ألوان القطعة نفسها. ESP32 تغذيتها USB. **الأرضي مشترك** بين ESP32 ومصدر 5V والservo. لا توصل +5V الخارجي للـESP32 وهي USB، ولا تغذي servo من GPIO. مكثف 1000µF rated 10V: `+` إلى 5V الخارجي و`-` إلى GND.

شغّل `test` واكتب `T`: يفتح، ينتظر، يقفل. `O` يفتح، `C` يقفل، `S` يطبع الحالة. لا ترسل ACK. ابدأ والservo منفصل عن ميكانيزم الباب. لو اتجاهه أو مداه غلط، غيّر فقط `DOOR_CLOSED_ANGLE` و`DOOR_OPEN_ANGLE` في `include/romi_config.h` ثم كرر `test`.

## 4. وصّل البورد بموقعك

```powershell
.\firmware\esp32-romi\romi.ps1 configure
```

هيطلب بالترتيب: اسم Wi-Fi 2.4 GHz، كلمة السر، رابط Vercel بدون `/api`، توكن الجهاز، ومسار root CA PEM موثوق. **اضغط Enter عند سؤال CA ليكتشفها تلقائيًا عبر اتصال يتحقق منه Windows**. كلمة السر والتوكن لا يظهران أثناء الكتابة. الإعدادات في `include/romi_secrets.h` المتجاهل من Git.

نفّذ configure بعد النشر وقبل المسابقة حتى تتجهز CA الصحيحة. لو الاكتشاف فشل، راجع الإنترنت/تاريخ Windows أو أدخل PEM من جهة الشهادة الرسمية. شهادة السيرفر المؤقتة ليست بديلًا عن root CA. يمكن وضع أكثر من root PEM في ملف واحد. إذا مضطر لعرض demo بدونها، اكتب `SKIP` عند سؤال CA؛ flash شبكة عادي يتوقف برسالة واضحة، والبديل الصريح تحت. لو غيّرت deployment أو شهادة الموقع لاحقًا، أعد configure وflash عند الحاجة.

بدون حساس باب استخدم **demo**:

```powershell
.\firmware\esp32-romi\romi.ps1 flash -Mode demo
.\firmware\esp32-romi\romi.ps1 monitor
```

لو CA هي العائق في عرض الهاكاثون فقط، هذا الخيار مسموح صراحة في demo:

```powershell
.\firmware\esp32-romi\romi.ps1 flash -Mode demo -InsecureTls
```

يعطل التحقق من شهادة HTTPS ويعلن تحذيرًا؛ ليس production. ما زال يحتاج إنترنت وساعة NTP. demo يعلن أيضًا أن حركة servo الزمنية تُعتبر نجاحًا **بدون إثبات من حساس**.

انتظر: `[WIFI] Connected` → `[TIME] Synchronized` → `[API] No pending command`. ده يثبت اتصال البورد بالـAPI، وليس أنها فتحت بابًا بعد.

## 5. شغّل الصوت والباب معًا

1. على اللابتوب/الموبايل افتح موقعك HTTPS وسجل دخول admin.
2. افتح **استقبال مع ESP32**: `/dashboard/kiosk` وأدخل نفس device token. محفوظ في ذاكرة الصفحة فقط؛ بعد refresh ستدخله مجددًا.
3. اسمح بالميكروفون واضغط «ابدأ الاستقبال». `/dashboard/simulation` للمحاكاة فقط؛ لن تحرك ESP32.
4. استخدم حجزًا تجريبيًا داخل entry window، أو اطلب أقرب موعد يسمح بالدخول الآن ووافق صراحة على فتح الباب. الحجز البعيد/المرفوض لا يصدر أمرًا.
5. راقب Serial: command received → Opening → Closing → `[ACK] Saved`. المتصفح ينتظر تأكيد ESP32 ولا يرسل ACK بدلها. في demo النجاح مبني على الزمن وليس حساسًا.
6. جرّب قطع hotspot وإعادته: البورد تعيد الاتصال. الأمر القديم قد ينتهي؛ أنشئ تجربة جديدة حسب حالة الحجز بدل توقع إعادة تنفيذ القديم.

كل محادثة تبدأ بزر المتصفح وتنتهي منه أو بإنهاء ROMI أو timeout. الزرار المادي حاليًا حالة محلية فقط؛ دمجه بالصوت مؤجل. اجعل المتصفح ظاهرًا للمستخدم ليكون بدء المحادثة واضحًا.

## 6. لو حاجة ناقصة: اختار البديل فورًا

| الموجود/المشكلة | المسار |
| --- | --- |
| ESP32 + servo + إنترنت، بدون قطع صوت | الأساسي: `/dashboard/kiosk` + `flash -Mode demo` |
| mic وamp وspeaker موجودين أيضًا | نفس الأساسي؛ audio على ESP32 غير جاهز، لا تجعل `ROMI_ENABLE_AUDIO=1` |
| Wi-Fi المكان فاشل/صفحة موافقة | hotspot 2.4 GHz ثم configure وflash |
| إنترنت ESP32 فاشل لكن اللابتوب online | browser simulator للصوت + bench و`T` لحركة يدوية؛ ليست دورة API متصلة |
| Gemini متعطل/الحصة انتهت | dashboard والحجوزات + bench servo؛ لا تدّعي صوتًا يعمل |
| مفيش servo أو مصدر 5V مناسب | browser simulator؛ لا تستبدل التغذية بGPIO |
| بورد مختلفة أو مفيش بورد | browser simulator؛ تغيير النوع يحتاج build وpin map مناسبين |
| مفيش إنترنت لكل الأجهزة | bench للservo/LED/button؛ Gemini والـAPI لا يعملان offline |

**خطة 3 ساعات:** أول 30 دقيقة البورد والLED/button، التالية 30 servo bench، التالية 30 hotspot/API، التالية 30 browser/door، وآخر ساعة تجربة العرض وإصلاح الأعطال. لو خطوة تعطلت 15 دقيقة انتقل لبديلها ثم ارجع إن بقي وقت.

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
| No pending command رغم المحادثة | kiosk وليست simulation، حجز مقبول داخل entry window وجلسة فعالة |
| Door feedback unavailable | safe لا يقبل نجاحًا بدون حساس؛ ارفع demo صراحة للهاكاثون |
| Expired / ACK 409 | TTL الأمر 20 ثانية أو سبق ACK؛ راجع الحجز واعمل تجربة جديدة، لا تعيد حركة نفس الأمر |
| Command صار sent ثم restart | السيرفر الحالي لا يعيد تسليم sent؛ راجع dashboard ثم أمر جديد حسب حالة الحجز |
| صوت المتصفح لا يبدأ | HTTPS وإذن mic وGEMINI_API_KEY على Vercel واتصال/حصة Gemini؛ جرّب اللابتوب |

## 8. ورقة الأوامر

من جذر المشروع؛ بدون arguments يعرض menu:

```powershell
.\firmware\esp32-romi\romi.ps1
.\firmware\esp32-romi\romi.ps1 prepare
.\firmware\esp32-romi\romi.ps1 configure
.\firmware\esp32-romi\romi.ps1 doctor
.\firmware\esp32-romi\romi.ps1 ports
.\firmware\esp32-romi\romi.ps1 test
.\firmware\esp32-romi\romi.ps1 flash -Mode demo
.\firmware\esp32-romi\romi.ps1 monitor
```

لو عدة منافذ، أضف `-Port COM7` بعد التأكد من رقم البورد. `build -Mode safe` يفحص الترجمة فقط. `flash -Mode safe` بدون demo assumptions لكنه يحتاج تنفيذ حساس حقيقي لكي يقر نجاح فتح الباب. pins والزوايا والتوقيتات في `include/romi_config.h`؛ flags تكتبها الأداة في `romi_local.h` المتجاهل من Git، فاختيار mode من الأداة يغلب defaults.

## 9. قطع الصوت إذا ركّبتها لاحقًا

INMP441: 3.3V فقط، L/R إلى GND، SCK14 وWS27 وSD32. MAX98357A: 5V الخارجي، BCLK14 وLRC27 وDIN22. clocks مشتركة عمدًا وdata منفصلة. السماعة 4Ω تقريبًا/3W بين Amp+ وAmp-؛ **Speaker- لا يتوصل GND**. كل GND مشتركة. SD وGAIN حسب القطعة الفعلية قبل التجربة. Wokwi custom placeholders لا تثبت الصوت. وجود القطع لا يضيف audio للfirmware الحالي.

تعليمات BOOT والتعريفات: [Espressif Arduino troubleshooting](https://docs.espressif.com/projects/arduino-esp32/en/latest/troubleshooting.html)، [Espressif flashing troubleshooting](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/flashing-troubleshooting.html).
