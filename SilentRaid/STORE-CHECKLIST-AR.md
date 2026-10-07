# قائمة النشر على Google Play — SILENT RAID

## 🔴 لازم قبل أي نشر
1. **أرقام AdMob تجريبية**: في `app/src/main/res/values/strings.xml` القيمتين `admob_app_id` و`admob_rewarded_unit_id` هما أرقام Google التجريبية. استبدلهم بأرقامك من AdMob، وإلا مش هتكسب من الإعلانات وممكن الحساب يتعلّق لو نشرت بأرقام تجريبية.
2. **Target API 36**: اتنفّذ في الكود (1.0.16): `compileSdk/targetSdk 36`، أداة البناء AGP 8.11.1 وGradle 8.13، وزر الرجوع اتنقل لـ `OnBackInvokedCallback`، وحدود الشاشة (edge-to-edge) اتظبطت. **مفيش بناء اتجرّب من عندي**، فاعمل الاختبارات دي على جهازك:
   - زر/إيماءة الرجوع تفتح رسالة الخروج (على Android 13+ وعلى جهاز أقدم لو متاح).
   - شكل الواجهة والـ HUD على جهاز فيه notch/كاميرا أمامية، وعلى تابلت أو فولد (اللعبة محجوزة landscape بخاصية opt-out).
   - بناء `gradle assembleRelease` ينجح (لو ظهر خطأ في إصدار `play-services-ads` حدّثه لأحدث نسخة).
3. **المفتاح**: ضيف الأسرار في GitHub (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`) وفكّر في تغيير كلمة السر الضعيفة قبل أول نشر. فعّل **Play App Signing**.
4. **سياسة الخصوصية**: الرابط الحالي (Flycricket):
   https://doc-hosting.flycricket.io/silent-raid-privacy-policy/90c99652-3f86-4169-87a5-bfca88e5a77d/privacy
   - **لازم** تستبدل `[Your_Email_Here]` ببريدك الحقيقي من لوحة Flycricket، لأن Google Play بترفض سياسة فيها نص مؤقت.
   - ضيف رابطي سياسة Google Play Services وAdMob (https://policies.google.com/privacy) وذكر معرّف الإعلانات (Advertising ID).
   - الصق نفس الرابط في Play Console ← Policy ← App content ← Privacy policy.

## 🟡 نموذج Data safety في Play Console
- AdMob بيجمع **Advertising ID** وبيانات استخدام/تشخيص ← صرّح بيها.
- التقدّم والإعدادات بتتخزّن محلياً على الجهاز فقط (لا خادم).

## 🟢 ملفات المتجر
- أيقونة 512×512، صورة Feature Graphic 1024×500، 4–8 لقطات شاشة بالعرض (landscape).
- وصف قصير (80 حرف) ووصف كامل، وتصنيف المحتوى (IARC).
- اختبر على جهاز ضعيف (ذاكرة 2GB) وجهاز Android 14+ وAndroid 16.

## ما اتغيّر في 1.0.15 (للمرجع)
- المفتاح خارج المشروع، `allowBackup=false`، `usesCleartextTraffic=false`.
- WebP بدل JPG/PNG، وضغط الصوت.
- نجوم وإحصائيات محلية، اهتزاز عند الفوز/الخسارة (صلاحية VIBRATE عادية، بدون طلب إذن).

## 📊 Firebase Analytics (اختياري، اتضاف في 1.0.16)
اللعبة بتبعت أحداث تلقائياً لما يتوفر ملف `google-services.json`: `level_start` و`level_end` (فيها level_name وstage وsuccess وstars وduration_s) و`reward_ad_requested` و`reward_ad_earned`.
1. اعمل مشروع في https://console.firebase.google.com وأضف تطبيق Android بالاسم `com.silentraid.game`.
2. نزّل `google-services.json` وحطه في `SilentRaid/app/` (جنب `build.gradle`). بدونه التطبيق بيشتغل عادي ومن غير تتبّع.
3. في GitHub: الملف مش سري زي المفتاح، لكن لو المستودع Private ارفعه عادي، وإلا أضفه كـ Secret وفكّه في الـ workflow.
4. شاهد النتائج في Firebase ← Analytics ← Events (بتظهر بعد ساعات)، و DebugView للاختبار الفوري.
5. **الخصوصية**: Firebase بيجمع معرّف التطبيق (App Instance ID) وبيانات استخدام. حدّث سياسة الخصوصية وصرّح بيها في Data safety (Analytics: App activity + Device or other IDs). لو عندك مستخدمين في الاتحاد الأوروبي/بريطانيا لازم رسالة موافقة (Consent / UMP) من AdMob.
