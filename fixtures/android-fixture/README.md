# Android fixture (build/run NOT_RUN here)

A controllable app for accessibility recording/replay acceptance:

- baseline form/list/detail dialog, dark-mode aware theme, system font scale and DPI;
- `--es variant moved` moves the form; `decoy` shows a duplicate "搜索" button;
  `renamed` changes labels/content descriptions; the "重建 Activity" button forces
  an Activity recreation (stale node test);
- deterministic local data; no network.

Variants that would require different resource ids are intentionally not faked:
resource ids are observed anchors, so a UI whose ids genuinely change should be a
different layout packaged as a distinct fixture variant.

Gradle wrapper is not checked in; generate it with `gradle wrapper --gradle-version 8.9` or open the folder in Android Studio.

```bash
cd fixtures/android-fixture
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.intentbridge.fixture/.MainActivity --es variant moved
```
