# تشغيل ROMI على ESP32 — خطوات يوم المسابقة

الهدف الأول: البورد تتصل بالـWi-Fi، تستقبل أمر باب من السيرفر، تحرك SG90، وترجع ACK. الصوت على الموبايل/اللابتوب في الـbrowser لحد ما نثبت قطع الصوت الفعلية.

## قبل توصيل الكهرباء

1. اتأكد إن البورد ESP32 DevKit V1 / ESP-WROOM-32. لو مختلفة، راجع `platformio.ini` والـpins.
2. وصل الـESP32 باللابتوب بكابل USB **بيوصل بيانات**. شغل الـservo والـamp من مصدر 5V منفصل. خلي كل الـGND مشتركة، لكن لا توصل +5V الخارجي للبورد وهي شغالة USB.
3. GPIO23 للـservo signal، GPIO33 للزرار ناحية GND، GPIO25 للأحمر، GPIO26 للأخضر. كل LED معاها مقاومة 330 Ω.
4. لو فيه INMP441: تغذيتها 3.3V فقط. لو فيه MAX98357A: السماعة بين `+` و`-` بتوع الـamp، مش إلى GND. الصوت اختياري حاليًا.

## إعداد أول مرة على اللابتوب (PowerShell من جذر المشروع)

```powershell
Copy-Item firmware/esp32-romi/include/romi_secrets.example.h firmware/esp32-romi/include/romi_secrets.h
notepad firmware/esp32-romi/include/romi_secrets.h
```

اكتب داخل الملف اسم Wi-Fi وكلمة السر ورابط Vercel الذي يبدأ `https://`، و`ROMI_DEVICE_TOKEN` الموجود على السيرفر. **الملف محلي ومتجاهله Git.** استخدم hotspot موبايل 2.4 GHz إن شبكة المكان عندها captive portal أو تمنع الأجهزة. الموبايل والـESP32 لازم يقدروا يوصلوا للإنترنت. لا تحط Gemini أو Supabase keys على البورد.

للـTLS الطبيعي، ضع root CA الصحيح للموقع في `ROMI_ROOT_CA_BUNDLE`. لو الوقت ضيق في الـdemo فقط، غيّر `ROMI_ALLOW_INSECURE_TLS_FOR_DEMO` إلى `1` في `include/romi_config.h`؛ هيظهر تحذير `[DEMO]` في Serial. ارجعها `0` بعد ما تجهز الشهادة.

```powershell
python -m platformio run -d firmware/esp32-romi -e romi-devkit-v1
python -m platformio device list
python -m platformio run -d firmware/esp32-romi -e romi-devkit-v1 -t upload --upload-port COM3
python -m platformio device monitor -p COM3 -b 115200
```

بدّل `COM3` برقم المنفذ الذي ظهر لك. اقفل Serial Monitor قبل إعادة Upload. لو البورد رفضت الفلاش، جرّب الضغط على زر `BOOT` وقت بداية الرفع. لو مش شايف منفذ COM، جرّب كابل بيانات أو USB port تاني، وبعدها راجع تعريف USB-UART الموجود على البورد.

## ماذا أرى في Serial؟

- `[WIFI] Connected IP=...` ثم `[TIME] Synchronized`: الاتصال والساعة جاهزين.
- `[API] No pending command`: الـAPI شغال ومفيش أمر جديد. الـLED الأخضر منور في الـidle.
- `Poll HTTP 401`: توكن البورد لا يطابق `ROMI_DEVICE_TOKEN` على Vercel.
- `Invalid poll JSON` أو HTTP 5xx: راجع deployment والـAPI.
- `[DOOR] Opening...` ثم `Closing...` ثم `[ACK] Saved`: دورة الأمر اكتملت.

لو عاوز اختبار servo بدون API، اجعل `ROMI_HACKATHON_DEBUG_MODE=1` ثم أعد الـbuild والـUpload. اكتب `O` أو `C` أو `T` أو `S` أو `P` في Serial Monitor. `T` يعمل دورة servo من غير ACK. بعد الاختبار رجّع debug إلى `0` وأعد الـflash.

في الـdemo بدون حساس باب، اجعل `ROMI_DEMO_ASSUME_SERVO_MOVED=1` وأعد الـflash. ده يسمح ACK نجاح بعد اكتمال حركة الـservo الزمنية فقط، وسجلات `[DEMO]` هتوضح إنه افتراض. الافتراضي `0` يرسل `opened:false` لأن مفيش feedback حقيقي.

## اختبار السيرفر بعد Vercel

اختبار آمن لرفض الطلبات غير الصالحة من خارج Vercel:

```powershell
$env:ROMI_TEST_BASE_URL = 'https://YOUR-DEPLOYMENT.vercel.app'
pnpm smoke:device:external
```

اختبار دورة أمر كاملة ينشئ حجزًا تجريبيًا وACK نجاح **من غير فتح باب فعلي**. شغله فقط على deployment وSupabase staging منفصلين، بعد التأكد إن طابور أوامر الباب خالي:

```powershell
$env:ROMI_TEST_ISOLATED_DB = 'YES'
$env:ROMI_TEST_ALLOW_DOOR_COMMAND = 'YES'
pnpm smoke:device:external
```

لو Vercel لسه مش منشور، الاختبار الخارجي ينتظر رابط الـdeployment وإعداداته. اختبار الـbuild وحده لا يثبت التوصيلات أو الكهرباء أو صوت Wokwi.
