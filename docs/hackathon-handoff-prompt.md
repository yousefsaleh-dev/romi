# برومبت تكملة ROMI على جهاز المسابقة

انسخ النص من «بص يا Codex» لآخر الملف في الشات الجديد. لو الـrepo مفتوح عند Codex، يكفي تقول له: **«اقرأ docs/hackathon-handoff-prompt.md بالكامل واعتبره سياقنا، وبعدها اقرأ الملفات المذكورة وكمل معايا من حالة القطع الفعلية.»**

السياق مكتوب بتاريخ 2 أكتوبر 2026. نتائج الاختبارات تحت دي سجل سابق؛ افحص الحالة الحالية قبل إعلان نجاح جديد.

---

بص يا Codex، إحنا بنكمل مشروع ROMI الحقيقي في الهاكاثون. إنت جوه الـrepo بعد clone/pull. ده تسليم سياق من الجهاز القديم، فاقراه كله وخليك فاهم إحنا وصلنا لفين. متبدأش مشروع جديد، ومتكتفيش بخطة أو كلام: اقرأ، شخّص، عدّل لو محتاج، اعمل build، وصلح الأخطاء، وساعدني أرفع البرنامج وأجربه على القطع اللي معايا.

## أنا فاهم إيه ومحتاج منك إيه؟

أنا full stack web developer، فاهم Next.js وAPI وauth وdatabase وGit وVercel كويس. لكن دي أول مرة أتعامل مع ESP32 وC++ والتوصيلات ورفع firmware. اعتبر إن الكلمات دي محتاجة شرح عملي: COM port، BOOT، flash/upload، Serial Monitor، I2S، الأرضي المشترك. مش محتاج تشرحلي يعني إيه POST أو deployment.

كلمني بالمصري وبخطوات واضحة: افتح VS Code، افتح Terminal، اختار PowerShell، اكتب الأمر ده، النتيجة المفروض تبقى كذا. لو بتقول «القائمة»، قول إنها اللي بتظهر في الـterminal من ملف romi.ps1، مش صفحة أو قائمة على البورد. متغرقنيش بأسماء full/full-safe/audio-bench؛ قول رقم الاختيار ومعناه. أنا مش عايز أكتب C++ من الصفر هنا، عندنا حوالي 3 ساعات للتوصيلات والرفع والتجربة.

اسألني عن الحاجة اللي فعلًا محتاجها للخطوة الحالية، وكمل قراءة وتشخيص الباقي بنفسك. لو محتاج تشوف القطعة أو السلك، اطلب صورة واضحة أو اسم مكتوب عليها؛ متفترضش إن عندك وصول مادي للبورد. متطلبش مني مفاتيح أسرار في الشات أو تطبعها في logs.

## اقرأ دول الأول

1. `README.md`.
2. `docs/hardware-first-time.md` — الشرح العملي بالمصري، قائمة الأداة، USB والواي فاي والحالتين.
3. `firmware/esp32-romi/STANDALONE.md` و`firmware/esp32-romi/HACKATHON.md`.
4. `docs/api.md` و`docs/architecture.md` و`docs/system-design.md` و`docs/esp32-integration.md`.
5. `docs/deployment-device-tests.md` **لحد آخر سطر**، و`firmware/esp32-romi/VERIFICATION.md`. فيهم نجاحات وأعطال تاريخية؛ الفحص المتأخر لمفتاح Google أهم من نجاح اختبار قديم.
6. كل workspace `firmware/esp32-romi`: `platformio.ini`، `romi.ps1`، `include/`، `src/`، README و`.gitignore` لو موجود.
7. implementation الحالي للـAPI في `src/app/api/`، و`src/components/live-simulation.tsx`، وصفحة `src/app/dashboard/kiosk/page.tsx`، وأي تعليمات repo موجودة على الجهاز.

البرزنتيشن النهائي `ROMI.pdf` في الجذر **24 سلايد**، الجزء التكنيكال سلايد 10 و11. `docs/reference/ROMI.pdf` نسخة أقدم 14 سلايد. `Wokwi.zip` أرشيف الدائرة؛ وصورة التوصيل في `docs/reference/Screenshot 2026-10-01 201718.png`. متعدلش البرزنتيشن من نفسك.

## المشروع والسيرفر الموجود

ROMI استقبال مستشفى: محادثة صوتية بالمصري، حجز، check-in، فتح باب تجريبي بعد تحقق السيرفر. السيرفر معمول ومش عايزين نعيد كتابته أو نضيف routes لو الحالية كفاية.

- Next.js 16 / React 19 / TypeScript / Tailwind 4، Admin Dashboard، Voice Simulator.
- Supabase PostgreSQL + Auth + RLS؛ Vercel للنشر.
- الموقع موجود بالفعل: **https://romi-deci.vercel.app**. متعاملش الموضوع إننا لسه هننشئ deployment جديد.
- Gemini Live من المتصفح أو من ESP32 مباشرة، عبر ephemeral token يصدره السيرفر. آخر config اختبرناه كان `gemini-3.8-live` وصوت `ar-eg-concierge-7`؛ اقرأ الـconfig الحالي لو اتغير.
- الأربع عيادات: general، internal_medicine، pediatrics، orthopedics. المواعيد كل نص ساعة، 24/7، حجز واحد لكل قسم لكل فترة، كود 4 أرقام. التوقيت Cairo. نافذة الدخول تبدأ ساعة قبل الموعد شاملة، وتنتهي بعده بساعتين غير شاملة. الحجز المستقبلي لا يفتح الباب، والحجز الجديد داخل النافذة يحتاج موافقة صريحة `open_door_now`.
- الصوت والنص الكامل للمحادثة مش متخزنين. `ai_actions` يسجل الاستخدام والأحداث والوقت وتقدير التكلفة؛ فاتورة Google هي المرجع الفعلي.

### أدوات المودل الموجودة فعلًا

| Tool | التنفيذ |
| --- | --- |
| `find_available_slots` | `POST /api/ai/availability` |
| `create_booking` | `POST /api/ai/create-booking` |
| `check_in_booking` | `POST /api/ai/check-in` |
| `get_booking_entry_status` | `POST /api/ai/entry-status` |
| `end_conversation` | إنهاء محلي للـclient وتنظيف الجلسة؛ مش أمر servo ولا route جديدة |

كمان موجود `POST /api/ai/session`، `POST /api/ai/usage`، `GET /api/ai/door-status?request_id=...`، وroutes الجهاز المذكورة تحت. راجع shapes الفعلية في الكود وapi.md قبل أي تعديل.

## الباب بيفتح إزاي؟ دي نقطة أنا سألت عنها

**الـESP32 هي اللي بتبدأ كل HTTP request للسيرفر.** السيرفر مبيفتحش اتصال جديد للبورد، ومش محتاج public IP ليها أو port forwarding.

1. المحادثة تطلب tool زي check-in؛ الـclient يبعت الطلب للـROMI API.
2. السيرفر يراجع الكود/الحجز/الموافقة/نافذة الدخول، ويكتب أمر physical في جدول `door_commands` في Supabase.
3. البورد طول ما متصلة بالنت بتعمل `GET /api/device/commands`، تقريبًا كل 1500ms أو حسب `retry_after_ms`.
4. السيرفر **يرجع الأمر في الرد على طلب البورد**. لو `command: null` مفيش حركة.
5. البورد تتحقق من UUID وexpiry وعدم التنفيذ قبل كده، ثم تحرك السيرفو وتبعت `POST /api/device/commands/ack` بجسم `{ "command_id": "<uuid>", "opened": true }` أو `opened: false` مع `error_code`.
6. الـvoice client يقرأ `door-status` ويستنى تأكيد الباب قبل ما يقول اتفتح.

في الـdemo الحالي `opened: true` ممكن بعد وقت حركة السيرفو تحت flag صريح؛ ده **مش دليل حساس فعلي**. Production لازم door sensor. الزرار مش بيفتح الباب مباشرة.

`/dashboard/simulation` محاكاة، أوامرها لا تدخل physical queue. **بديل الموبايل الحقيقي** على:
**https://romi-deci.vercel.app/dashboard/kiosk**.
الصفحة دي اتشالت من السايدبار عشان البرزنتيشن، لكنها موجودة بالرابط المباشر بعد دخول الأدمن. إخفاء اللينك مش إزالة auth. فيها خانة device token، محفوظ في RAM الصفحة بس وبيتمسح مع refresh. تبدأ وتنهي من أزرار الصفحة.

## الإعدادات والمفاتيح

- توكن الجهاز **ROMI_DEVICE_TOKEN**. لازم نفس القيمة على Vercel وفي `firmware/esp32-romi/include/romi_secrets.h` وعلى صفحة الموبايل عند استخدامها. البورد تبعته `Authorization: Bearer ...` تلقائيًا. اختلافه = HTTP 401.
- الرابط والتوكن وشهادة **GlobalSign Root CA** موجودين بالفعل في header المرفوع. **الواي فاي لسه placeholders**؛ أنا هحدد شبكة المسابقة هناك. متطلبش مني أعيد إدخال كل الإعدادات لو موجودة.
- أول network flash يسأل SSID وباسورد بس. لازم Wi-Fi 2.4GHz؛ captive portal أو enterprise مش معمول لهم flow. Hotspot 2.4GHz بديل لو الشبكة مش مناسبة.
- تغيير env على Vercel يحتاج redeploy. تغيير header أو WiFi في الكمبيوتر يحتاج reflash للبورد. البرنامج مبيتحدثش تلقائيًا بـgit pull.
- ESP32 فيها device token فقط؛ مفيش `GEMINI_API_KEY` ولا Supabase secret ولا admin credentials. الـephemeral Gemini token في RAM فقط ويتشال آخر كل جلسة. كل visitor session لها request_id UUID جديد.
- أنا اخترت أخلي الـrepo public. سابقًا وافقت نرفع secrets، لكن **بعد ما Google رفض المفتاح طلبت إزالة env**. الحالة الحالية: `.env.local` محلي ومش tracked، `.env*` ignored مع `.env.example` فقط؛ متعملش force-add للـenv أو replacement Google key أو server secrets. الـdevice header مرفوع حسب طلبي. المفاتيح المنشورة قديمًا لسه في Git history؛ مفيش history rewrite اتعمل.
- clone على الكمبيوتر الجديد مش هيجيب `.env.local` ولا `.tools` ولا `.pio` ولا caches. هات إعدادات web المحلية من Vercel لو محتاج اختبار يتطلبها، من غير نشرها. تشغيل/رفع firmware لا يحتاج Supabase/Google secret على الكمبيوتر الجديد.

## القطع والتوصيلات الحالية

البورد المستهدفة **ESP32 DevKit V1 classic ESP-WROOM-32 / esp32dev**، مش ESP32-S3/C3. لو اللي استلمناه مختلف شوف الاسم والـpinout وعدّل config قبل الرفع.

| القطعة | توصيل الإشارة |
| --- | --- |
| SG90 servo | GPIO23 |
| زرار الزائر الواحد | GPIO33 → Button → GND، `INPUT_PULLUP`، LOW مضغوط |
| Red LED | GPIO25 → 330Ω → LED → GND |
| Green LED | GPIO26 → 330Ω → LED → GND |
| INMP441 | SCK/BCLK14، WS/LRCLK27، SD32، L/R إلى GND |
| MAX98357A | BCLK14، LRC27، DIN22 |

GPIO14 و27 clocks مشتركة **عمدًا** للمايك والأمبليفاير، والـdata منفصل: mic32 / amp22. SD وGAIN للأمبليفاير حاليًا unconnected؛ راجع القطعة الفعلية عند أي مشكلة.

الكهربا: ESP32 من USB. السيرفو والأمبليفاير من external 5V. **متوصلش موجب 5V الخارجي للـESP32 وهي شغالة USB.** كل GND مشترك: البورد والمصدر والسيرفو والمايك والأمبليفاير. INMP441 **3.3V فقط**. Speaker حوالي 4Ω/3W بين Amp+ وAmp−؛ **Speaker− مش GND**. مكثف 1000µF يفضل 10V: موجب على 5V وسالب GND. افصل الكهربا قبل تغيير التوصيلات، وابدأ السيرفو بعيد عن ميكانيزم الباب.

Wokwi أثبت شكل التوصيل فقط. INMP441/MAX98357A والسماعة والمصدر والمكثف custom placeholders وملفات chip.c templates؛ **مفيش real audio simulation**.

## الكود الموجود ومستوى جاهزيته

الفيرموير مكتوب فعلًا، مش stub للصوت:

- Core: Servo/Button/LED، millis debounce/timing، WiFi reconnect، NTP، HTTPS validation، bounded worker، polling/backoff/timeouts، expiry وduplicate protection محفوظ في NVS لآخر 16 UUID، ACK/retry، serial logs.
- Full: one I2S driver للـshared clocks، mic PCM16 mono 16kHz، speaker PCM16 mono 24kHz؛ I2S clock 48kHz، raw Gemini TLS WebSocket بالـephemeral token، tool calls للـAPI، انتظار door status، cancel/silence timeout/usage وتنظيف التوكن.
- زرار GPIO33 في IDLE يبدأ، أثناء الجلسة يلغي؛ مش محتاج تدخل dashboard لبدء Plan A.
- نصف مزدوج: المايك يقف أثناء playback؛ مفيش echo cancellation أو barge-in. الـdefault silence timeout 20 ثانية وحد الجلسة 8 دقايق.
- `romi_config.h` مكان تغيير pins/angles/timings/gain/volume/flags. closed0/open90، move650ms، hold1500ms، قابلة للتغيير حسب الحركة الفعلية.
- افتراضي header `ROMI_ENABLE_AUDIO=0` و`ROMI_DEMO_ASSUME_SERVO_MOVED=0`. الأداة تختار profile وتكتب local flags حسب menu. لا تفترض إن defaults دي هي full demo اللي بتفلشه اختيار5.
- demo verification بتطبع `[DEMO]`. Production `doorOpenFeedback()` لسه hook بيرجع false لحد إضافة limit/reed/Hall sensor؛ sensor-required profile مش هينفع يعلن opened بدون حساس.
- الصوت disabled بيبني من غير WebSockets/audio dependency. زراره local session stub **مش remote start للموبايل**.
- HTTP بدون TLS validation مش default؛ flag demo فقط لو اضطرينا. Gemini TLS validated.
- أهم ملفات: `main.cpp`، `romi_http.cpp`، `romi_audio_io.cpp`، `romi_live.cpp`، `romi_live_protocol.h`، `romi_gemini_ca.h`، و`websocket_limits.py` اللي يضبط dependency frame cap على64KiB. API response bound32KiB.

## أنا أعمل إيه عمليًا من الكمبيوتر الجديد؟

بعد clone/pull افتح مجلد المشروع في VS Code → Terminal → New Terminal → PowerShell. من الجذر:

```powershell
.\firmware\esp32-romi\romi.ps1
```

دي menu نصية في الـterminal، تكتب الرقم وEnter. بعد انتهاء الخطوة تفتحها بنفس الأمر تاني.

| الرقم | معناه |
| --- | --- |
| 1 | تجهيز الأدوات وتنزيل dependencies وبناء الأوضاع؛ محتاج نت، اعمله بدري |
| 2 | تغيير اسم الواي فاي والباسورد فقط، وبعدها لازم reflash |
| 3 | doctor: فحص الأدوات والإعدادات وUSB ports |
| 4 | رفع اختبار السيرفو/زرار/LED offline وفتح الرسائل |
| 5 | رفع الاستقبال المستقل بالصوت + الباب؛ يحتاج قطع الصوت |
| 6 | فتح رسائل البورد Serial Monitor |
| 7 | رفع اختبار المايك والسماعة offline وفتح الرسائل |
| 8 | رفع متحكم الباب فقط، والصوت من الموبايل |

لو scripts ممنوعة: `Set-ExecutionPolicy -Scope Process Bypass` في نفس الـterminal وأعد الأمر. لو Python غايب ثبت 3.11+ مع Add to PATH وافتح terminal جديد. الأدوات تتنزل على الجهاز ده؛ caches الجهاز القديم مش في Git. لا تحتاج Arduino IDE لو الأداة شغالة.

وصل البورد بكابل USB **بيانات**. اختار USB serial COM الصحيح. COM3 Intel SOL اللي كان في الجهاز القديم مش ESP32؛ متفترضش رقم port ثابت. لو توقف الرفع عند Connecting امسك BOOT الصغير الموجود على البورد وسيبه لما الكتابة تبدأ. BOOT غير زرار GPIO33 بتاع الزائر. Ctrl+C يقفل monitor قبل أي flash تاني؛ استنى SUCCESS ومتقطعش USB أثناء الكتابة.

### حالة A: كل قطع الصوت موجودة

وصل حسب الجدول، اعمل 1 لو الأدوات مش جاهزة، و3 للتأكد من USB. اختار 7: `A` نغمة سماعة، اتكلم ثم `M` قياس المايك/heap، `T` دورة سيرفو. لو القياس صفر أو في slot مختلف، راجع wiring/LR ثم MIC_LEFT_SLOT/gain بعد فحص؛ متخمنش إن Gemini السبب قبل اختبار القطع.

Ctrl+C، افتح القائمة واختار 5. أول مرة يطلب WiFi بس. انتظر SUCCESS ثم 6؛ انتظر WiFi/IP وNTP/HTTPS. اضغط الزرار: المفروض يطلب جلسة ويرحب ويسمع ويرد. اعمل حجز/check-in حقيقي تجريبي داخل نافذة الدخول، وافحص poll/servo/ACK/status. ضغطة تانية توقف الجلسة.

بعد نجاح التجربة اقفل monitor، افصل USB من الكمبيوتر ووصله بشاحن أو power bank، وخلي external5V شغال للسيرفو والأمبليفاير. كده ROMI تعمل **بدون كمبيوتر أو موبايل**، لكن محتاجة كهربا وWiFi/Internet وسيرفر وGemini. البرنامج محفوظ في ذاكرة البورد.

### حالة B: أي جزء صوت ناقص أو الصوت مش شغال

الـPC عندي **مفيهوش مايك**. البديل **موبايل**، مش Bluetooth ولا افتراض laptop.

اختار 4 لاختبار السيرفو بـT ثم Ctrl+C؛ اختار 8، أدخل WiFi لو لسه، واستنى SUCCESS. افتح من الموبايل `https://romi-deci.vercel.app/dashboard/kiosk`، سجل دخول الأدمن، أدخل نفس device token، وافق على إذن المايك، واضغط **ابدأ الاستقبال**. الموبايل يتكلم مع Gemini ويطلب tools من API، والبورد تستقبل أمر الباب في رد الـpoll وتعمل ACK. مش محتاجين USB بينهم أو نفس LAN؛ كل واحد محتاج Internet.

هنا تبدأ/تنهي من صفحة الموبايل؛ زرار GPIO33 مش بيشغّل الموبايل عن بعد. تقدر تشغل البورد من شاحن، لكن **الموبايل يفضل جزءًا من النظام في البديل ده**. متوعدنيش باستقلال صوتي من غير قطع صوت أو جهاز بديل.

### أسوأ حالة

مفيش audio ومفيش موبايل/مايك؟ مفيش محادثة؛ فقط bench/servo demo. مفيش نت؟ offline test4 أو7؛ المحادثة والـAPI محتاجين نت. صفحة simulation توري الفلو لكن لا تفتح الباب الحقيقي. أوامر debug: O فتح، C غلق، T دورة، S state، P forcepoll؛ في debug فقط، الحركة اليدوية لا تعمل fake ACK لأمر سيرفر.

## اختبارات حصلت فعلًا والـblockers المتبقية

- Builds على classic ESP32 نجحت للأوضاع كلها، ومنها الصوت disabled. آخر full بإعدادات الموقع: SUCCESS في 22.39s، static RAM 47,792 (14.6%)، flash 1,048,313 (80%). Core safe: SUCCESS في 12s، RAM 47,316 (14.4%)، flash 973,405 (74.3%). دي compile results، مش قياس heap تحت الصوت.
- lint/typecheck/web build و7 اختبارات device-door نجحوا سابقًا. أعد المناسب عند تغيير كود؛ متستبدلش النتائج الفعلية بجملة «المفروض شغال».
- اكتشفنا SQL bug إن أمر expired قديم يلغي reservation لأمر retry جديد. أصلحناه في `supabase/migrations/0007_preserve_active_door_retry.sql`. **أنا طبقت migration فعلًا**. بعده ست مجموعات door-only نجحت، ثم سبع مجموعات deployed كاملة نجحت بجلسات Gemini حقيقية، raw WebSocket/PCM، و16 audio chunks أكبر frame فيها 46,392 bytes، وحجز/claim/expiry/ACK/idempotency/usage. نُظفت بيانات الاختبار. ACK كان synthetic من الكمبيوتر، مفيش فتح باب فعلي.
- **لكن بعد النجاح Google رفض المفتاح المنشور**: آخر فحص موثق HTTP 401 `ACCESS_TOKEN_TYPE_UNSUPPORTED`. متقولش الصوت شغال حاليًا اعتمادًا على النجاح القديم. افحص قبول المفتاح الحالي وإصدار الجلسة، ولو لسه مرفوض ساعدني أحط بديل على Vercel ومحليًا عند الحاجة، redeploy واختبر؛ متترفعش القيمة الجديدة على GitHub. متخلطش Google 401 مع ROMI device-token 401؛ راجع مصدر الرد والـlogs.
- **مفيش ESP32 كانت متوصلة في بيئة التطوير؛ مفيش flash ولا hardware verification حصلوا**. وجودك هنا أول فرصة قياس GPIO/I2S/gain/volume/power/brownout/TLS heap وإعادة الاتصال والدورة المتكاملة. Wokwi مش إثبات audio.
- Production door feedback لسه stub، والهاكاثون demo يعتمد وقت حركة السيرفو بوضوح. السيرفر الحالي مش بيعيد تسليم `sent` بعد restart؛ لو أمر اتعمله claim وبعدين البورد فصلت، شخّص الحالة وابدأ محاولة جديدة حسب قواعد الحجز بدل إعادة حركة قديمة.
- أدوات Vercel/browser auth على الجهاز القديم فشلت أحيانًا لصلاحيات أو انتهاء login؛ متفترضش إن tokens/login موجودين على الجهاز الجديد. أنا عارف Vercel وأقدر أعمل خطواته، ومش عايز تعيد deploy من الصفر لو الموقع موجود.

### أدوات الاختبار الموجودة

`pnpm smoke:device:external` فحص auth/rejection أولي؛ مش دورة الباب الكاملة. `pnpm smoke:esp32:live` فحص بروتوكول Gemini. `pnpm test:device-door` اختبارات status handling. `pnpm smoke:esp32:deployed` اختبار خارجي كامل ببيانات تجريبية على HTTPS؛ يحتاج `.env.local` مطابق للموقع و`ROMI_TEST_BASE_URL` و`ROMI_TEST_ALLOW_SYNTHETIC_DEVICE=YES`. راجع السكريبت والدليل قبل تشغيله: ينشئ جلسات وحجوزات وأوامر وACK تجريبي وينظف بياناته؛ **افصل متحكم الباب الفعلي أثناءه**، ولا تتخطى فحص وجود أوامر نشطة تخص غير الاختبار. `--door-only` جزئي مش إثبات Gemini. متعلنش `ROMI_TEST_ISOLATED_DB=YES` لقاعدة مش معزولة عشان تعدي guard.

## أسلوب الشغل المطلوب منك دلوقتي

ابدأ بـgit status وقراءة الملفات. بعدها عرّفني بجملتين بالحالة وقولي أول خطوة أعملها. اطلب نوع البورد وقطع الصوت المتاحة لو أنا لسه ما قلتلكش، وخليك مكمل لحد ما نوصل لتجربة مادية ناجحة. ساعدني بأوامر terminal حقيقية وbuild وتشخيص logs، ولو خطأ من السيرفر ثبته بطلب خارجي بدل لفنا في C++.

ممنوع delays طويلة توقف النظام، أو audio dependency إجبارية للـcore، أو تغذية servo من GPIO، أو تحريك مع null/expired/HTTP error أو duplicate command، أو تسريب secrets في logs، أو fake production ACK، أو تغيير backend بدون سبب مثبت. حافظ على button/poll/door مستقلين قدر الإمكان. عالج العطل المحدد ومتعملش rewrite كبير وقت التشغيل.

أنا طلبت push لتعديلات الكود والـdocs على GitHub. افحص changes الفعلية وحافظ على ملفاتي، commit/push عادي لو المهمة تحتاج تعديل، ومتعملش force push أو تنشر env/keys الجديدة. في النهاية قول غيرت إيه، build result بالظبط، إيه اتجرب على hardware وإيه لسه غير مؤكد، وخطوة التشغيل اللي بعدها. خلينا نشغل ROMI فعلًا خطوة خطوة.
