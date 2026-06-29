# UniRP Assessments — Android app

A thin native Android wrapper around the **FIRE Assessment** and **INDRIYA Smart
Campus Audit** web apps. The HTML/JS at the repo root *is* the app — it is bundled
into the APK at build time, so scoring, the ROI calculator, the OTP gate,
IndexedDB draft persistence and free navigation behave exactly like the website,
with no second codebase to maintain.

## How it works

| Concern | Implementation |
| --- | --- |
| App shell | One `MainActivity` hosting a `WebView` ([MainActivity.kt](app/src/main/java/com/bloomfieldinnovations/unirp/MainActivity.kt)). |
| Content | `index.html`, `indriya.html`, `assets/` copied from the repo root by the `syncWebAssets` Gradle task into `app/src/main/assets/` (git-ignored). |
| Origin | Served via `WebViewAssetLoader` over `https://appassets.androidplatform.net/`, a stable secure-context origin so **IndexedDB drafts (ratings, remarks, photos) survive app relaunches**. |
| Photos | `<input type="file" accept="image/*" capture>` opens a camera + gallery chooser; results are handed back to the page, which reads them as data URLs exactly as on the web. |
| Offline | The full audit runs offline; only the final submit (and OTP) need a connection. |
| Report download | The report's `window.print()` is bridged to the Android print framework (Save as PDF / print). The server also keeps its own PDF copy in Drive. |

## Build & run

Toolchain (what this was built and verified with): **JDK 17**, **AGP 9.0.1**,
**Gradle 9.1.0** (wrapper), **Android SDK 36** (compile/target), **build-tools
36.0.0**, `minSdk 26`. Kotlin is compiled by AGP 9.0's built-in Kotlin support
(no separate Kotlin Gradle plugin).

1. Point Gradle at your SDK via `android/local.properties` (git-ignored):
   ```
   sdk.dir=C:\\path\\to\\android-sdk
   ```
2. Build:
   - **Debug** (quick, debug-signed): `./gradlew assembleDebug` →
     `app/build/outputs/apk/debug/app-debug.apk`
   - **Release** (R8 + resource shrinking, smallest, signed): `./gradlew assembleRelease`
     → `app/build/outputs/apk/release/app-release.apk` (~3.9 MB).
3. Or open the `android/` folder in Android Studio and Run on a device/emulator
   (min Android 8.0 / API 26).

The `syncWebAssets` task runs automatically before each build, so the bundled
HTML always matches the repo root.

### Release signing

`assembleRelease` is signed when `android/keystore.properties` exists (git-ignored):

```
storeFile=app/release.keystore
storePassword=*****
keyAlias=*****
keyPassword=*****
```

Generate a keystore once with the JDK's `keytool`:

```
keytool -genkeypair -v -keystore app/release.keystore -alias unirp \
  -keyalg RSA -keysize 2048 -validity 10000
```

Without `keystore.properties`, the release APK builds unsigned (use `assembleDebug`
for a directly installable build instead).

## Configuration

- **`HOSTED_ASSET_BASE`** in [MainActivity.kt](app/src/main/java/com/bloomfieldinnovations/unirp/MainActivity.kt)
  must point to the public https location where `assets/` is served (e.g. the
  GitHub Pages / hosting URL of the web build). The INDRIYA PDF is rendered
  server-side by fetching the sample-reference images, so this has to resolve on
  the open internet — the in-app `appassets` origin is device-local only.
  Currently set to `https://muluxlabs.github.io/fire-assessment-unirp/` — update
  it if the assets live elsewhere.
- **`GS_URL`** (the Apps Script endpoint) lives in the HTML, shared with the web.

## Notes

- `minSdk 26`, `targetSdk 34`, `applicationId com.bloomfieldinnovations.unirp`.
- Permissions: only `INTERNET`. Camera capture uses the system camera app via
  `ACTION_IMAGE_CAPTURE`, so no `CAMERA` permission is required.
- Release signing is not configured yet; add a `signingConfig` before publishing.
