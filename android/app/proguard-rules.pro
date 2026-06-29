# Keep the JS <-> Android print bridge reachable from WebView JavaScript.
-keepclassmembers class com.bloomfieldinnovations.unirp.MainActivity$PrintBridge {
    @android.webkit.JavascriptInterface <methods>;
}
