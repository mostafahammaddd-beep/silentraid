مشروع Silent Raid (أعيد بناؤه من الـAPK الأصلي)

- الإعلان: Rewarded حقيقي من AdMob بمعرّفات الاختبار الرسمية من Google.
  المعرّفان في: app/src/main/res/values/strings.xml  (admob_app_id و admob_rewarded_unit_id)
  استبدلهما بمعرّفاتك قبل النشر على Google Play.
- التوقيع: keystore.p12 (كلمة السر: silentraid). احتفظ به، ولا ترفع المشروع إلا في مستودع Private.
- البناء السحابي: .github/workflows/build.yml يبني ملف APK تلقائيًا على GitHub.
