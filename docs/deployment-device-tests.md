# نشر ROMI واختبار طلبات ESP32

## ما الذي يحاكيه الاختبار؟

السكريبت يرسل طلبات HTTPS فعلية إلى Next.js المنشور، بنفس device bearer token، المسارات وحقول JSON التي يستخدمها firmware. يطلب جلسة حقيقية من السيرفر، ويتصل بـGemini بصيغة WebSocket الخام الخاصة بالبورد، ويرسل PCM16 mono 16kHz، ويستقبل PCM16 mono 24kHz.

**هذا اختبار الشبكة والبروتوكول، لا محاكاة ESP32 CPU أو I2S أو أسلاك أو سيرفو.** ACK النجاح في السكريبت مصطنع ومعلن كتجربة، وليس إثباتًا على فتح باب. لا تشغّل الاختبار مع جهاز باب فعلي متصل.

## قبل التشغيل

1. انشر المشروع على Vercel وضع متغيرات `.env.example` بقيمها الصحيحة. device token يجب أن يطابق `.env.local` والـfirmware.
2. استخدم نفس Supabase التجريبي المربوط بالـdeployment. السكريبت ينشئ زوارًا وحجوزات تجريبية، ويحتاج service key **على كمبيوتر الاختبار فقط** للتحقق والتنظيف.
3. لا تشغّل جهازًا يسحب أوامر الباب بالتزامن، ولا تستخدم طابور باب حقيقي. السكريبت يرفض سحب أوامر معلقة تخص أشخاصًا آخرين عند فحص الطابور.
4. تأكد من أن عنوان الإنتاج متاح للطلبات الخارجية؛ تسجيل admin داخل التطبيق يظل مطلوبًا للـdashboard، لكن ESP32 لا تسجل دخول Vercel Deployment Protection.

## الأوامر

من PowerShell داخل ROMI، بعد `pnpm install`:

```powershell
$env:ROMI_TEST_BASE_URL = "https://romi-deci.vercel.app"
pnpm smoke:device:external
```

هذا اختبار أولي للتوكن والرفض. الاختبار الكامل:

```powershell
$env:ROMI_TEST_BASE_URL = "https://romi-deci.vercel.app"
$env:ROMI_TEST_ALLOW_SYNTHETIC_DEVICE = "YES"
pnpm smoke:esp32:deployed
```

استبدل الرابط بالـdeployment الصحيح. `YES` تصريح واضح بإنشاء البيانات وACKs التجريبية. لا تطبع التوكن ولا تضع Gemini/Supabase server keys في firmware.

لو Gemini متعطل، تقدر تختبر مسار الحجز والباب وحده:

```powershell
$env:ROMI_TEST_BASE_URL = "https://romi-deci.vercel.app"
$env:ROMI_TEST_ALLOW_SYNTHETIC_DEVICE = "YES"
node --env-file=.env.local scripts/esp32-deployment-smoke.mjs --door-only
```

ده **اختبار جزئي**: ينشئ ai_actions تجريبية مباشرةً في قاعدة البيانات كتجهيز للاختبار، ثم يرسل طلبات HTTPS الحجز/check-in/poll/ACK إلى السيرفر الحقيقي. لا يختبر إصدار ephemeral token، اتصال Gemini، PCM أو usage، ولا يثبت تشغيل الاستقبال الصوتي. الاختبار الكامل يظل يفشل عند فشل Gemini؛ لا يتجاوز المشكلة تلقائيًا.

## الحالات التي يراجعها الاختبار الكامل

- Bearer مفقود وخاطئ: HTTP 401؛ session/ACK malformed: HTTP 400؛ ACK مجهول: HTTP 409.
- Poll بدون أمر: `command:null` و`retry_after_ms` موجب.
- Fresh UUID → `/api/ai/session` → token مؤقت/config حقيقية؛ تكرار UUID مرفوض.
- `setupComplete` قبل إرسال الصوت، PCM input/output، حد 64KiB لإطار Gemini، usage مرة واحدة ثم duplicate idempotent.
- حجز مستقبلي مع `open_door_now:true`: لا يصدر أمر باب؛ early check-in مرفوض؛ entry-status قراءة فقط.
- حجز يسمح بالدخول الآن: pending → claim مرة واحدة، ولا إعادة تسليم في poll التالية.
- ACK قبل claim مرفوض. ACK `opened:false` مع `DOOR_FEEDBACK_UNAVAILABLE` يحفظ failure ويعيد الحجز scheduled.
- Check-in جديد ثم انتظار TTL الحقيقي حوالي 20 ثانية: ACK متأخر مرفوض والأمر expired، والحجز يستعيد حالته.
- Check-in جديد ثم ACK مصطنع `opened:true`: opened/checked_in، duplicate ACK مرفوض، ومحاولة إعادة استخدام الكود مرفوضة.
- حدود أجسام الردود مثل firmware: 2047 bytes للمسارات device و32KiB لمسارات AI، مع طباعة أحجام/زمن الردود دون credentials أو بيانات المرضى.

الـcleanup يحذف فقط appointments المرتبطة بـcreation_action_id الخاص بجلسات هذا التشغيل، ثم جلسات UUIDs الخاصة به (والأوامر/attempts التابعة عبر cascade). لا يحذف الحجوزات السابقة. لا تغير متغيرات `.env.local` أثناء التشغيل؛ يجب أن تطابق deployment.

## لو فشل

اقرأ آخر endpoint/status ظاهر في المخرجات وراجع Vercel runtime logs. 401 عادة عدم تطابق device token؛ HTML/redirect بدل JSON قد يكون رابطًا خاطئًا أو Deployment Protection؛ 5xx يحتاج مراجعة إعدادات السيرفر/SQL/provider. لا تحرّك السيرفو لتعويض request فاشلة. نجاح الاختبار لا يحسم تشغيل القطع الحقيقية.

## نتيجة فعلية — 2 أكتوبر 2026

الموقع: [romi-deci.vercel.app](https://romi-deci.vercel.app). الـcommit الظاهر عند بدء النشر `9183c0e` كان آخر `main` مرفوع وقت فحصه. عمر الـcommit مختلف عن وقت النشر.

- `pnpm smoke:device:external`: **PASS، exit 0**؛ التوكن الصحيح وصل للـAPI، وطلبات بلا توكن/ACK غير صالح/ACK مجهول/session UUID غير صالح رجعت حالات الرفض المتوقعة.
- الاختبار الكامل: **FAIL، exit 1 عند POST /api/ai/session → HTTP 502**. طلب مباشر من الكمبيوتر إلى Google بنفس المفتاح رجع **401 / ACCESS_TOKEN_TYPE_UNSUPPORTED**؛ فالمشكلة في قبول Google للمفتاح الحالي، وليست دليل عطل ESP32. إصدار token/PCM/usage على deployment لم ينجح في هذا التشغيل.
- الاختبار الجزئي `--door-only`: نجح idle poll، future-booking/early-check-in، claim مرة واحدة، عدم إعادة التسليم، ACK الفشل، رفض ACK قبل claim، ورفض ACK متأخر بعد TTL الحقيقي. أكبر رد availability في التشغيل **15,851 bytes**، ضمن حد firmware البالغ 32KiB.
- اكتشف الاختبار الجزئي **bug حقيقي**: بعد انتهاء أمر، check-in جديد لنفس الحجز ثم poll يؤدي إلى إعادة الحجز `scheduled` بسبب الأمر القديم `expired`. ACK النجاح يرجع `opened` لكن الحجز لا يصبح `checked_in`. الاختبار خرج **exit 1**؛ لا تعتبر دورة الباب الكاملة ناجحة.
- أضيف إصلاح [migration 0007](../supabase/migrations/0007_preserve_active_door_retry.sql): لا يحرر الحجز الذي لديه أمر جديد pending/sent غير منتهي. **لم يطبق على Supabase بعد**؛ CLI رجع 403. Vercel redeploy وحده لا يطبق SQL.
- الإصلاح اختبر بمحرك PostgreSQL محلي مؤقت (PGlite 0.5.8)، باستخدام الدوال SQL الحقيقية من ملفات migrations. أعاد إنتاج العطل بالدالة القديمة، ثم **PASS، exit 0** مع الإصلاح: pending/sent retries، positive ACK → checked_in، تحرير الأوامر المنتهية، expiry، وترك checked_in/cancelled كما هي. هذا ليس تأكيدًا لتطبيق الإصلاح على قاعدة البيانات المنشورة.
- جميع الحجوزات/الجلسات/الأوامر الخاصة بهذه التشغيلات نُظفت؛ لم تُحذف الحجوزات السابقة.

لإعادة اختبار SQL المحلي بدون حساب Supabase:

```powershell
npm install --prefix .tools/sql-test --no-save @electric-sql/pglite@0.5.8
node scripts/door-expiry-regression.mjs
```

قبل المسابقة: طبق migration 0007، أصلح GEMINI_API_KEY محليًا وعلى Vercel ثم Redeploy، وأعد الاختبار الكامل. الاستقبال المستقل بالصوت وبديل الموبايل كلاهما يحتاجان إصدار جلسة Gemini ناجحة. الهاردوير نفسه لم يُوصل أو يُرفع إليه برنامج هنا.

### إعادة الاختبار بعد تطبيق migration 0007

أكد صاحب المشروع تطبيق SQL، ثم أعيد الاختبار الخارجي `--door-only` على نفس رابط Vercel: **PASS، exit 0، ست مجموعات**. إعادة المحاولة احتفظت بالحجز `entry_pending`، وACK النجاح حوله إلى `checked_in`، ورفض السيرفر duplicate ACK وإعادة استخدام الكود. نجح أيضًا expiry الحقيقي وfailure ACK. نُظفت بيانات التشغيل التجريبية. هذا يزيل blocker إعادة محاولة الباب المذكور أعلاه؛ إصدار جلسة Gemini والصوت لم يُختبرا في هذا التشغيل لأن الجلسات كانت seeded fixtures.

### النتيجة الأحدث: الاختبار الكامل بعد تحديث مفتاح Gemini

أعيد `pnpm smoke:esp32:deployed` باستخدام المفتاح المحدث، على `https://romi-deci.vercel.app`: **PASS، exit 0، سبع مجموعات كاملة**. هذه المرة الجلسات صدرت من `/api/ai/session` الحقيقي، وليست seeded fixtures. نجح one-use ephemeral token، raw v1beta WebSocket/setupComplete، PCM16k input، و**16 PCM24k audio chunks، أكبر frame 46,392 bytes**، وusage/duplicate usage، وكل حراس الحجز والباب وexpiry/ACK/retry/consumed code. نُظفت بيانات التشغيل التجريبية. نتائج الفشل أعلاه سجل تاريخي للمشاكل التي أصلحت، وليست الحالة الحالية.

إعدادات ESP32 مرفوعة في `include/romi_secrets.h`: رابط الموقع، device token المطابق للاختبار، وشهادة الجذر **GlobalSign Root CA** المكتشفة باتصال HTTPS تحقق منه Windows. الواي فاي لم يحدد بعد؛ أول flash يسأل اسمه وباسورده فقط. لا يوجد Gemini أو Supabase secret داخل firmware. نجاح البروتوكول من الكمبيوتر لا يثبت I2S أو الذاكرة أو الحركة على ESP32؛ هذه هي الاختبارات المتبقية بالقطع الفعلية.
